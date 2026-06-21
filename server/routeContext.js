// Compacte samenvatting van een berekende route voor LLM-uitleg.

function angleDelta(a, b) {
  return ((a - b + 540) % 360) - 180;
}

function avg(nums) {
  const v = nums.filter((n) => Number.isFinite(n));
  return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null;
}

function fmtCoord(c) {
  return `${c.lat.toFixed(3)}°N, ${c.lon.toFixed(3)}°E`;
}

function fmtUtc(ms) {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Bouw gestructureerde context uit route-resultaat + invoer. */
export function buildRouteContext({ start, end, boat, useEngine, zones = [], route }) {
  const { waypoints = [], summary = {}, meta = {} } = route;
  const legs = waypoints.filter((w) => w.cog != null);

  let tackCount = 0;
  const tackMoments = [];
  let prevCog = null;
  for (const w of legs) {
    if (prevCog != null && Math.abs(angleDelta(w.cog, prevCog)) > 30) {
      tackCount++;
      if (tackMoments.length < 8) {
        tackMoments.push({
          timeUtc: fmtUtc(w.timeMs),
          lat: +w.lat.toFixed(3),
          lon: +w.lon.toFixed(3),
          cogFrom: prevCog,
          cogTo: w.cog,
          twa: w.twa,
          tws: w.tws,
          motoring: !!w.motoring,
        });
      }
    }
    prevCog = w.cog;
  }

  const detourPct = summary.directDistanceNM
    ? +(((summary.distanceNM / summary.directDistanceNM) - 1) * 100).toFixed(1)
    : 0;

  const sampleEvery = Math.max(1, Math.floor(legs.length / 12));
  const phases = legs
    .filter((_, i) => i % sampleEvery === 0 || i === legs.length - 1)
    .map((w) => ({
      timeUtc: fmtUtc(w.timeMs),
      lat: +w.lat.toFixed(3),
      lon: +w.lon.toFixed(3),
      cog: w.cog,
      sog: w.sog,
      twa: w.twa,
      tws: w.tws,
      windFrom: w.windFrom,
      curSpeed: w.curSpeed,
      curToward: w.curToward,
      waveHeight: w.waveHeight ?? 0,
      motoring: !!w.motoring,
    }));

  return {
    start: fmtCoord(start),
    end: fmtCoord(end),
    boat: meta.boat?.name || boat?.name || "onbekend",
    useEngine: !!useEngine,
    forbiddenZones: zones.map((z, i) => ({
      name: z.name || `Zone ${i + 1}`,
      vertices: z.polygon?.length ?? 0,
    })),
    summary: {
      distanceNM: summary.distanceNM,
      directDistanceNM: summary.directDistanceNM,
      detourPct,
      durationHours: summary.durationHours,
      departureUtc: fmtUtc(summary.departureMs),
      etaUtc: fmtUtc(summary.etaMs),
      avgSpeedKn: summary.avgSpeedKn,
      motorFractionPct: Math.round((summary.motorFraction || 0) * 100),
      solverSteps: summary.steps,
    },
    sailing: {
      tackCount,
      tackMoments,
      avgTws: avg(legs.map((w) => w.tws)) != null ? +avg(legs.map((w) => w.tws)).toFixed(1) : null,
      avgTwa: avg(legs.map((w) => w.twa)) != null ? +avg(legs.map((w) => w.twa)).toFixed(0) : null,
      avgCurrentKn: avg(legs.map((w) => w.curSpeed)) != null ? +avg(legs.map((w) => w.curSpeed)).toFixed(2) : null,
      maxWaveM: legs.length ? +Math.max(...legs.map((w) => w.waveHeight || 0)).toFixed(2) : 0,
      motoringLegs: legs.filter((w) => w.motoring).length,
      totalLegs: legs.length,
    },
    routePhases: phases,
    notes: {
      truncatedForecast: !!meta.truncatedForecast,
      method: "isochronen (tijd-optimaal, niet comfort of veiligheid)",
      polarSource: "synthetic_baseline",
    },
  };
}
