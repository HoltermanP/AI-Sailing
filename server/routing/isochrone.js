// Isochronen weather-routing.
//
// Methode: vanuit het startpunt breiden we per tijdstap Δt een "front" van
// bereikbare punten uit. Voor elke koers berekenen we de bootsnelheid uit de
// polaire (op basis van de ware windhoek), tellen de getijstroming erbij op, en
// bepalen zo de nieuwe positie. Daarna snoeien we het front tot de buitenste
// envelop (de isochroon). Zo ontstaat vanzelf optimaal opkruisen tegen de wind in
// en het "meeliften" met gunstige stroming. Land en verboden zones worden vermeden.

import {
  distanceNM, bearing, destinationPoint, angleDiff,
  vecFromSpeedDir, speedDirFromVec, normalizeBearing, toRad,
} from "./geo.js";
import { polarSpeed } from "./polar.js";

// Golf-snelheidscorrectie (heuristiek, GEEN VPP-fysica): hoge significante
// golfhoogte remt af, het sterkst aan-de-wind. windward=1 bij TWA 0 (pal in de
// wind), 0 bij TWA 180. Penalty per meter golf loopt van ~4%/m (voor de wind)
// tot ~14%/m (aan de wind), afgetopt op 50%.
export function waveFactor(twaDeg, hs) {
  if (!hs || hs <= 0.25) return 1;
  const windward = (1 + Math.cos(toRad(Math.min(180, Math.abs(twaDeg))))) / 2;
  const penaltyPerMeter = 0.04 + 0.1 * windward;
  const drag = Math.min(0.5, penaltyPerMeter * hs);
  return 1 - drag;
}

// Punt-in-polygoon (ray casting). polygon: [[lat,lon], ...]
export function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function inExclusionZone(lat, lon, zones) {
  for (const z of zones) {
    if (z.polygon && z.polygon.length >= 3 && pointInPolygon(lat, lon, z.polygon)) return z;
  }
  return null;
}

// Mag de boot van a naar b varen? Bemonster het segment langs de grootcirkel.
export function legAllowed(a, b, field, zones) {
  const dist = distanceNM(a, b);
  if (dist <= 0.01) return field.isNavigable(b.lat, b.lon) && !inExclusionZone(b.lat, b.lon, zones);
  const brg = bearing(a, b);
  const steps = Math.max(10, Math.ceil(dist * 5));
  for (let s = 1; s <= steps; s++) {
    const pt = destinationPoint(a, brg, dist * (s / steps));
    if (!field.isNavigable(pt.lat, pt.lon)) return false;
    if (inExclusionZone(pt.lat, pt.lon, zones)) return false;
  }
  return true;
}

function validatePath(path, field, zones) {
  for (const n of path) {
    if (!field.isNavigable(n.lat, n.lon)) return false;
    if (inExclusionZone(n.lat, n.lon, zones)) return false;
  }
  for (let i = 1; i < path.length; i++) {
    if (!legAllowed(path[i - 1], path[i], field, zones)) return false;
  }
  return true;
}

// Eén stap: bereken nieuwe positie vanuit `node` met koers `heading` (door water).
function advance(node, heading, dtHours, field) {
  const cond = field.conditionsAt(node.lat, node.lon, node.timeMs);
  const wind = cond.wind;       // { speed (kn), fromDir }
  const cur = cond.current;     // { speed (kn), towardDir }

  // Ware wind t.o.v. het bewegende water (trek stroomvector af van de windvector).
  const windToward = vecFromSpeedDir(wind.speed, wind.fromDir + 180);
  const curVec = vecFromSpeedDir(cur.speed, cur.towardDir);
  const wwToward = { e: windToward.e - curVec.e, n: windToward.n - curVec.n };
  const ww = speedDirFromVec(wwToward.e, wwToward.n);
  const waterWindSpeed = ww.speed;
  const waterWindFrom = normalizeBearing(ww.dir + 180);

  const twa = Math.abs(angleDiff(waterWindFrom, heading));
  const sailStw = polarSpeed(field.boat, twa, waterWindSpeed) * waveFactor(twa, cond.waveHeight);

  // Motor-fallback: bij weinig wind kan op de motor sneller worden gevaren dan
  // onder zeil. Effectieve vaart door water = max(zeil, motor) als motor aan staat.
  const motorKn = field.useEngine ? (field.boat.motorKn || 0) : 0;
  const motoring = motorKn > sailStw;
  const stw = Math.max(sailStw, motorKn);
  if (stw <= 0.05) return null; // no-go én geen motor: vaart te laag

  // Snelheid over de grond = bootvector (door water) + stroomvector
  const boatVec = vecFromSpeedDir(stw, heading);
  const sog = speedDirFromVec(boatVec.e + curVec.e, boatVec.n + curVec.n);
  const distOverGround = sog.speed * dtHours;
  if (distOverGround <= 0.01) return null;

  const newPos = destinationPoint(node, sog.dir, distOverGround);
  return {
    lat: newPos.lat,
    lon: newPos.lon,
    timeMs: node.timeMs + dtHours * 3600 * 1000,
    parent: node,
    leg: {
      heading,
      cog: sog.dir,
      sog: sog.speed,
      stw,
      twa,
      tws: waterWindSpeed,
      windFrom: wind.fromDir,
      windSpeed: wind.speed,
      curSpeed: cur.speed,
      curToward: cur.towardDir,
      waveHeight: cond.waveHeight || 0,
      motoring,
    },
  };
}

// Snoei het front tot de buitenste envelop: per peilingsector vanaf start het
// punt dat het verst (en het dichtst bij de bestemming) ligt.
function pruneFront(candidates, start, end, sectorDeg) {
  const buckets = new Map();
  for (const c of candidates) {
    const brgFromStart = bearing(start, c);
    const key = Math.floor(brgFromStart / sectorDeg);
    // "vooruitgang" = afstand vanaf start minus restafstand-component; we kiezen
    // het punt dat het verst van start ligt in deze sector (klassieke envelop).
    const score = distanceNM(start, c);
    const existing = buckets.get(key);
    if (!existing || score > existing.score) {
      buckets.set(key, { node: c, score });
    }
  }
  return [...buckets.values()].map((b) => b.node);
}

function reconstruct(node) {
  const path = [];
  let n = node;
  while (n) {
    path.push(n);
    n = n.parent;
  }
  path.reverse();
  return path;
}

export function routeIsochrone({ start, end, field, boat, departureMs, zones = [], options = {} }) {
  field.boat = boat;
  field.useEngine = options.useEngine ?? true; // motoren bij windstilte standaard aan
  const directDist = distanceNM(start, end);

  // Δt zo kiezen dat het aantal stappen redelijk blijft (~80-160).
  const dtHours = options.dtHours ?? Math.min(3, Math.max(0.25, directDist / (6 * 150)));
  const headingStep = options.headingStep ?? 5;   // koersresolutie (graden)
  const sectorDeg = options.sectorDeg ?? 1.5;      // snoei-resolutie
  const maxSteps = options.maxSteps ?? 400;
  const maxFront = options.maxFront ?? 400;
  // aankomststraal: binnen deze afstand proberen we direct af te ronden
  const arrivalRadius = Math.max(1.5, dtHours * 12 * 0.6);

  const startNode = { lat: start.lat, lon: start.lon, timeMs: departureMs, parent: null, leg: null };

  const startWater = field.isWaterAt(start.lat, start.lon);
  if (startWater === null) {
    throw new Error("Kon hoogtedata voor het startpunt niet ophalen — wacht ~1 minuut (weer-API) en probeer opnieuw.");
  }
  if (!startWater) {
    throw new Error("Startpunt ligt niet op bevaarbaar water (of buiten datagebied).");
  }

  const endWater = field.isWaterAt(end.lat, end.lon);
  if (endWater === null) {
    throw new Error("Kon hoogtedata voor de bestemming niet ophalen — wacht ~1 minuut (weer-API) en probeer opnieuw.");
  }
  if (!endWater) {
    throw new Error("Bestemming ligt niet op bevaarbaar water (of buiten datagebied).");
  }

  let front = [startNode];
  const isochrones = []; // voor visualisatie: lijst van fronten
  let best = null; // beste node die de bestemming (bijna) bereikt

  const headings = [];
  for (let h = 0; h < 360; h += headingStep) headings.push(h);

  for (let step = 0; step < maxSteps; step++) {
    const candidates = [];
    for (const node of front) {
      // korte-afstand finish: als we de bestemming deze stap kunnen halen
      const dEnd = distanceNM(node, end);
      if (dEnd <= arrivalRadius) {
        const brgEnd = bearing(node, end);
        const fin = advance(node, brgEnd, dtHours, field);
        if (fin && legAllowed(node, end, field, zones)) {
          // koppel direct aan de bestemming
          const arrival = {
            lat: end.lat, lon: end.lon,
            timeMs: node.timeMs + (dEnd / Math.max(0.1, fin.leg.sog)) * 3600 * 1000,
            parent: node, leg: { ...fin.leg, cog: brgEnd },
          };
          if (!best || arrival.timeMs < best.timeMs) best = arrival;
        }
      }
      for (const h of headings) {
        const next = advance(node, h, dtHours, field);
        if (!next) continue;
        if (!legAllowed(node, next, field, zones)) continue;
        candidates.push(next);
      }
    }

    if (best) break; // bestemming bereikt
    if (candidates.length === 0) {
      throw new Error("Geen voortgang mogelijk — mogelijk ingesloten door land/zones of geen wind.");
    }

    front = pruneFront(candidates, start, end, sectorDeg);
    if (front.length > maxFront) {
      // behoud de punten die het dichtst bij de bestemming liggen
      front.sort((a, b) => distanceNM(a, end) - distanceNM(b, end));
      front = front.slice(0, maxFront);
    }

    // bewaar een (uitgedunde) isochroon voor de kaart
    isochrones.push(front.map((n) => ({ lat: n.lat, lon: n.lon })));
  }

  if (!best) {
    // geen exacte finish — neem het front-punt dat het dichtst bij de bestemming kwam
    let closest = null, cd = Infinity;
    for (const n of front) {
      const d = distanceNM(n, end);
      if (d < cd) { cd = d; closest = n; }
    }
    if (!closest) throw new Error("Route niet gevonden.");
    best = closest;
  }

  const path = reconstruct(best);
  if (!validatePath(path, field, zones)) {
    throw new Error("Route kruist land — verfijn start/eind of probeer een andere vertrektijd.");
  }
  const totalDist = path.reduce((sum, n, i) => i === 0 ? 0 : sum + distanceNM(path[i - 1], n), 0);
  const durationH = (best.timeMs - departureMs) / 3600000;
  const legs = path.filter((n) => n.leg);
  const motorLegs = legs.filter((n) => n.leg.motoring).length;

  return {
    waypoints: path.map((n) => ({
      lat: +n.lat.toFixed(5),
      lon: +n.lon.toFixed(5),
      timeMs: Math.round(n.timeMs),
      ...(n.leg ? {
        cog: +n.leg.cog.toFixed(0),
        sog: +n.leg.sog.toFixed(2),
        twa: +n.leg.twa.toFixed(0),
        tws: +n.leg.tws.toFixed(1),
        windFrom: +n.leg.windFrom.toFixed(0),
        windSpeed: +n.leg.windSpeed.toFixed(1),
        curSpeed: +n.leg.curSpeed.toFixed(2),
        curToward: +n.leg.curToward.toFixed(0),
        waveHeight: +(n.leg.waveHeight || 0).toFixed(2),
        motoring: !!n.leg.motoring,
      } : {}),
    })),
    isochrones: isochrones.filter((_, i) => i % Math.max(1, Math.floor(isochrones.length / 25)) === 0),
    summary: {
      distanceNM: +totalDist.toFixed(1),
      directDistanceNM: +directDist.toFixed(1),
      durationHours: +durationH.toFixed(2),
      departureMs,
      etaMs: Math.round(best.timeMs),
      avgSpeedKn: +(totalDist / Math.max(0.01, durationH)).toFixed(2),
      steps: isochrones.length,
      dtHours,
      motorLegs,
      motorFraction: legs.length ? +(motorLegs / legs.length).toFixed(2) : 0,
    },
  };
}
