import { test } from "node:test";
import assert from "node:assert/strict";
import { makeUniformField } from "../server/routing/weather.js";
import { routeIsochrone, waveFactor, pointInPolygon, legAllowed } from "../server/routing/isochrone.js";
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

test("isWaterAt: water nabij landhoek mag start zijn", () => {
  const bbox = { minLat: 52.5, maxLat: 53.5, minLon: 4.5, maxLon: 5.5 };
  const field = makeUniformField({ bbox, gridN: 10, windSpeed: 12 });
  field.elevation[5][5] = -5;
  field.elevation[5][6] = 50;
  field.elevation[6][5] = -5;
  field.elevation[6][6] = -5;
  const lat = field.lats[5] + (field.lats[6] - field.lats[5]) * 0.25;
  const lon = field.lons[5] + (field.lons[6] - field.lons[5]) * 0.25;
  assert.equal(field.isWaterAt(lat, lon), true);
  assert.equal(field.isNavigable(lat, lon), true); // 1 landhoek: cel nog bevaarbaar voor routing
});

test("legAllowed: grootcirkel over land wordt geweigerd", () => {
  const landFn = (lat, lon) => lat > 52.45 && lat < 52.55 && lon > 3.65 && lon < 3.75;
  const field = makeUniformField({ bbox, gridN: 40, windSpeed: 12, landFn });
  const a = { lat: 52.2, lon: 3.7 };
  const b = { lat: 52.8, lon: 3.7 };
  assert.equal(legAllowed(a, b, field, []), false);
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

test("exportWindGrid: watercellen met wind voor kaartlaag", () => {
  const field = makeUniformField({ bbox, gridN: 6, windFrom: 270, windSpeed: 14, departureMs: 0 });
  const grid = field.exportWindGrid(0);
  assert.ok(grid.points.length > 0);
  assert.equal(grid.points[0].from, 270);
  assert.equal(grid.points[0].speed, 14);
});

test("exportCurrentGrid: stroming voor kaartlaag", () => {
  const field = makeUniformField({
    bbox, gridN: 6, curSpeed: 1.2, curToward: 45, departureMs: 0,
  });
  const grid = field.exportCurrentGrid(0);
  assert.ok(grid.points.length > 0);
  assert.equal(grid.points[0].toward, 45);
  assert.equal(grid.points[0].speed, 1.2);
});

test("exportCurrentGrid: geen punten bij stil water", () => {
  const field = makeUniformField({ bbox, gridN: 6, curSpeed: 0, departureMs: 0 });
  assert.equal(field.exportCurrentGrid(0).points.length, 0);
});

test("pointInPolygon", () => {
  const sq = [[52, 3], [52, 4], [53, 4], [53, 3]];
  assert.ok(pointInPolygon(52.5, 3.5, sq));
  assert.ok(!pointInPolygon(51, 3.5, sq));
});
