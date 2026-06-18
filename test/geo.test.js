import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distanceNM, bearing, destinationPoint, angleDiff, normalizeBearing,
  vecFromSpeedDir, speedDirFromVec,
} from "../server/routing/geo.js";

test("distanceNM ~ 60 NM per breedtegraad", () => {
  const d = distanceNM({ lat: 52, lon: 4 }, { lat: 53, lon: 4 });
  assert.ok(Math.abs(d - 60) < 0.5, `verwacht ~60, kreeg ${d}`);
});

test("bearing pal noord = 0, pal oost = 90", () => {
  assert.ok(Math.abs(bearing({ lat: 52, lon: 4 }, { lat: 53, lon: 4 })) < 0.5);
  const e = bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
  assert.ok(Math.abs(e - 90) < 0.5, `oost verwacht 90, kreeg ${e}`);
});

test("destinationPoint is inverse van bearing+distance", () => {
  const a = { lat: 52, lon: 4 };
  const d = destinationPoint(a, 45, 10);
  assert.ok(Math.abs(distanceNM(a, d) - 10) < 0.05);
  assert.ok(Math.abs(angleDiff(bearing(a, d), 45)) < 0.5);
});

test("angleDiff en normalizeBearing", () => {
  assert.equal(normalizeBearing(370), 10);
  assert.equal(normalizeBearing(-10), 350);
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(350, 10), -20);
});

test("snelheidsvector heen en terug", () => {
  const v = vecFromSpeedDir(10, 90); // pal oost
  assert.ok(Math.abs(v.e - 10) < 1e-9 && Math.abs(v.n) < 1e-9);
  const sd = speedDirFromVec(v.e, v.n);
  assert.ok(Math.abs(sd.speed - 10) < 1e-9 && Math.abs(sd.dir - 90) < 1e-9);
});
