import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRouteContext } from "../server/routeContext.js";
import { getBoat } from "../server/routing/polar.js";

test("buildRouteContext: samenvatting met tacks en omweg", () => {
  const boat = getBoat("cruiser");
  const ctx = buildRouteContext({
    start: { lat: 53.0, lon: 3.7 },
    end: { lat: 52.0, lon: 3.7 },
    boat,
    useEngine: false,
    zones: [{ name: "Testzone", polygon: [[53, 3], [53, 4], [52, 4]] }],
    route: {
      waypoints: [
        { lat: 53, lon: 3.7, timeMs: 0, cog: 180, sog: 5, twa: 45, tws: 12, curSpeed: 0.5, curToward: 90, waveHeight: 0.3, motoring: false },
        { lat: 52.5, lon: 3.5, timeMs: 3600000, cog: 220, sog: 5.2, twa: 50, tws: 13, curSpeed: 0.4, curToward: 80, waveHeight: 0.4, motoring: false },
        { lat: 52, lon: 3.7, timeMs: 7200000, cog: 180, sog: 5.1, twa: 48, tws: 12, curSpeed: 0.3, curToward: 70, waveHeight: 0.2, motoring: false },
      ],
      summary: {
        distanceNM: 65,
        directDistanceNM: 60,
        durationHours: 12.5,
        departureMs: 0,
        etaMs: 45000000,
        avgSpeedKn: 5.2,
        motorFraction: 0,
        steps: 80,
      },
      meta: { boat: { id: "cruiser", name: boat.name }, truncatedForecast: false },
    },
  });

  assert.equal(ctx.forbiddenZones.length, 1);
  assert.equal(ctx.forbiddenZones[0].name, "Testzone");
  assert.ok(ctx.summary.detourPct > 0);
  assert.ok(ctx.sailing.tackCount >= 1);
  assert.equal(ctx.sailing.avgTws, 12.3);
  assert.ok(ctx.routePhases.length >= 2);
});
