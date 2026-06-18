import { test } from "node:test";
import assert from "node:assert/strict";
import { polarSpeed, getBoat, listBoats } from "../server/routing/polar.js";

const cruiser = getBoat("cruiser");

test("no-go: pal in de wind = geen vaart", () => {
  assert.equal(polarSpeed(cruiser, 0, 12), 0);
  assert.equal(polarSpeed(cruiser, 10, 12), 0);
});

test("ruwe-windhoek sneller dan aan-de-wind bij gelijke TWS", () => {
  const upwind = polarSpeed(cruiser, 45, 12);
  const reach = polarSpeed(cruiser, 90, 12);
  assert.ok(reach > upwind && upwind > 0, `reach ${reach} > upwind ${upwind}`);
});

test("meer wind = niet langzamer (monotoon bij vaste TWA)", () => {
  const s8 = polarSpeed(cruiser, 90, 8);
  const s16 = polarSpeed(cruiser, 90, 16);
  assert.ok(s16 >= s8, `${s16} >= ${s8}`);
});

test("bilineaire interpolatie tussen tabelpunten ligt ertussen", () => {
  const s10 = polarSpeed(cruiser, 90, 10);
  const lo = polarSpeed(cruiser, 90, 8);
  const hi = polarSpeed(cruiser, 90, 12);
  assert.ok(s10 >= Math.min(lo, hi) && s10 <= Math.max(lo, hi));
});

test("veilige extrapolatie: buiten de tabel geen NaN en niet-negatief", () => {
  for (const tws of [0, 2, 30, 60]) {
    for (const twa of [0, 35, 90, 180, 200]) {
      const v = polarSpeed(cruiser, twa, tws);
      assert.ok(Number.isFinite(v) && v >= 0, `twa=${twa} tws=${tws} => ${v}`);
    }
  }
});

test("min. 4 schepen, elk met motorKn en synthetic-label", () => {
  const boats = listBoats();
  assert.ok(boats.length >= 4, `verwacht >=4 boten, kreeg ${boats.length}`);
  for (const b of boats) {
    assert.ok(b.motorKn > 0, `${b.id} mist motorKn`);
    assert.equal(b.source, "synthetic_baseline");
  }
});
