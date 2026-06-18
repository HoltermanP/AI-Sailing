import { test } from "node:test";
import assert from "node:assert/strict";
import { makeUniformField } from "../server/routing/weather.js";
import { routeIsochrone, waveFactor, pointInPolygon } from "../server/routing/isochrone.js";
import { getBoat } from "../server/routing/polar.js";
import { boundingBox } from "../server/routing/geo.js";

const boat = getBoat("cruiser");
const bbox = boundingBox([{ lat: 51.5, lon: 2.5 }, { lat: 53.5, lon: 5.0 }], 0.5);

function tacks(wps) {
  let prev = null, n = 0;
  for (const w of wps) {
    if (w.cog == null) continue;
    if (prev != null) { const d = ((w.cog - prev + 540) % 360) - 180; if (Math.abs(d) > 40) n++; }
    prev = w.cog;
  }
  return n;
}

test("upwind: route kruist (omweg > 1.15) bij zeilen zonder motor", () => {
  // wind uit het zuiden; bestemming pal zuid => pal in de wind
  const field = makeUniformField({ bbox, windFrom: 180, windSpeed: 14 });
  const r = routeIsochrone({
    start: { lat: 53.0, lon: 3.7 }, end: { lat: 52.0, lon: 3.7 },
    field, boat, departureMs: 0, options: { useEngine: false },
  });
  const omweg = r.summary.distanceNM / r.summary.directDistanceNM;
  assert.ok(omweg > 1.15, `verwacht omweg > 1.15, kreeg ${omweg.toFixed(2)}`);
  assert.ok(tacks(r.waypoints) >= 2, `verwacht >=2 tacks, kreeg ${tacks(r.waypoints)}`);
});

test("downwind veel rechter dan upwind (diepe hoeken/gijpen, niet pal in de wind)", () => {
  const down = routeIsochrone({
    start: { lat: 53.0, lon: 3.7 }, end: { lat: 52.0, lon: 3.7 },
    field: makeUniformField({ bbox, windFrom: 0, windSpeed: 14 }), // voor de wind
    boat, departureMs: 0, options: { useEngine: false },
  });
  const up = routeIsochrone({
    start: { lat: 53.0, lon: 3.7 }, end: { lat: 52.0, lon: 3.7 },
    field: makeUniformField({ bbox, windFrom: 180, windSpeed: 14 }), // in de wind
    boat, departureMs: 0, options: { useEngine: false },
  });
  const omwegDown = down.summary.distanceNM / down.summary.directDistanceNM;
  const omwegUp = up.summary.distanceNM / up.summary.directDistanceNM;
  assert.ok(omwegDown < 1.2, `downwind omweg < 1.2 verwacht, kreeg ${omwegDown.toFixed(2)}`);
  assert.ok(omwegDown < omwegUp, `downwind (${omwegDown.toFixed(2)}) moet rechter zijn dan upwind (${omwegUp.toFixed(2)})`);
});

test("gunstige stroom verkort de reistijd t.o.v. geen stroom", () => {
  const common = { start: { lat: 52.0, lon: 3.7 }, end: { lat: 53.0, lon: 3.7 }, boat, departureMs: 0, options: { useEngine: false } };
  const still = routeIsochrone({ ...common, field: makeUniformField({ bbox, windFrom: 270, windSpeed: 12, curSpeed: 0 }) });
  const fair = routeIsochrone({ ...common, field: makeUniformField({ bbox, windFrom: 270, windSpeed: 12, curSpeed: 2, curToward: 0 }) }); // stroom naar noord = mee
  assert.ok(fair.summary.durationHours < still.summary.durationHours,
    `mee-stroom (${fair.summary.durationHours}) moet sneller zijn dan stil (${still.summary.durationHours})`);
});

test("windstilte: met motor komt er toch een route", () => {
  const field = makeUniformField({ bbox, windSpeed: 0 });
  const r = routeIsochrone({
    start: { lat: 52.0, lon: 3.7 }, end: { lat: 52.5, lon: 3.7 },
    field, boat, departureMs: 0, options: { useEngine: true },
  });
  assert.ok(r.summary.motorFraction > 0.9, `verwacht vrijwel volledig motoren, kreeg ${r.summary.motorFraction}`);
});

test("landvermijding: route om een landblok heen is langer dan direct", () => {
  // landblok in het midden (rond lon 3.7, lat 52.3-52.7)
  const landFn = (lat, lon) => lat > 52.25 && lat < 52.75 && lon > 3.5 && lon < 3.9;
  const field = makeUniformField({ bbox, gridN: 30, windFrom: 270, windSpeed: 14, landFn });
  const r = routeIsochrone({
    start: { lat: 52.0, lon: 3.7 }, end: { lat: 53.0, lon: 3.7 },
    field, boat, departureMs: 0, options: { useEngine: true },
  });
  assert.ok(r.summary.distanceNM > r.summary.directDistanceNM * 1.05,
    `route moet om land heen: ${r.summary.distanceNM} vs direct ${r.summary.directDistanceNM}`);
});

test("bestemming op land => duidelijke fout", () => {
  const landFn = (lat) => lat > 52.9; // noordrand is land
  const field = makeUniformField({ bbox, windSpeed: 12, landFn });
  assert.throws(() => routeIsochrone({
    start: { lat: 52.0, lon: 3.7 }, end: { lat: 53.2, lon: 3.7 },
    field, boat, departureMs: 0,
  }), /bevaarbaar/i);
});

test("waveFactor: aan-de-wind remt sterker dan voor-de-wind, en daalt met golfhoogte", () => {
  assert.equal(waveFactor(90, 0), 1);
  assert.ok(waveFactor(20, 2) < waveFactor(160, 2), "upwind moet meer afremmen");
  assert.ok(waveFactor(20, 3) < waveFactor(20, 1), "hogere golven remmen meer");
  assert.ok(waveFactor(0, 100) >= 0.5, "afgetopt op 50% penalty");
});

test("pointInPolygon", () => {
  const sq = [[52, 3], [52, 4], [53, 4], [53, 3]];
  assert.ok(pointInPolygon(52.5, 3.5, sq));
  assert.ok(!pointInPolygon(51, 3.5, sq));
});
