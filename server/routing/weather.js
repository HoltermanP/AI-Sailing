// Weather/environment-provider op basis van Open-Meteo (gratis, geen API-key).
//
// We bouwen een grid over de bounding box van de reis en halen daarvoor op:
//   - wind   : forecast-API  (wind_speed_10m, wind_direction_10m) — "from"-richting
//   - stroom : marine-API    (ocean_current_velocity/direction)    — "toward"-richting
//   - hoogte : elevation-API (statisch land/zee-masker; zee = hoogte <= drempel)
//
// Daarna interpoleren we ruimtelijk (bilineair) en in de tijd (lineair) zodat de
// routing-engine voor elk punt/tijdstip een schatting van de omstandigheden krijgt.

import { toRad, toDeg, normalizeBearing } from "./geo.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
const ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";

const KMH_TO_KN = 0.539957;
const SEA_LEVEL_THRESHOLD_M = 0.5; // hoogte hieronder => bevaarbaar water

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch met timeout en retries-met-backoff. Herhaalt bij 429/5xx en netwerk-
// fouten; respecteert Retry-After. Gooit een nette fout na het laatste pogen.
async function fetchJson(url, { timeoutMs = 15000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return await res.json();

      const retryable = res.status === 429 || res.status >= 500;
      const body = await res.text().catch(() => "");
      lastErr = new Error(`Open-Meteo ${res.status}: ${body.slice(0, 160)}`);
      if (!retryable || attempt === retries) throw lastErr;
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(8000, 500 * 2 ** attempt);
      await sleep(backoff);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === "AbortError"
        ? new Error(`Open-Meteo timeout na ${timeoutMs}ms`)
        : err;
      if (attempt === retries) throw lastErr;
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// Open-Meteo geeft bij meerdere coördinaten een array terug, bij één een object.
function asArray(x) {
  return Array.isArray(x) ? x : [x];
}

// Interpoleer een hoek (graden) via vectorcomponenten zodat 350°/10° netjes middelen.
function lerpAngle(a, b, t) {
  const ar = toRad(a), br = toRad(b);
  const e = (1 - t) * Math.sin(ar) + t * Math.sin(br);
  const n = (1 - t) * Math.cos(ar) + t * Math.cos(br);
  return normalizeBearing(toDeg(Math.atan2(e, n)));
}

export class WeatherField {
  constructor({ bbox, gridN, lats, lons, times, departureMs }) {
    this.bbox = bbox;
    this.gridN = gridN;
    this.lats = lats; // oplopend
    this.lons = lons; // oplopend
    this.times = times; // ms-epoch per uur-index
    this.departureMs = departureMs;
    // velden geïndexeerd als [latIdx][lonIdx], waarden per tijd-index
    this.elevation = []; // [latIdx][lonIdx] -> meter
    this.windSpeed = []; // [latIdx][lonIdx][timeIdx] -> kn
    this.windFrom = [];  // [latIdx][lonIdx][timeIdx] -> graden (waar wind vandaan komt)
    this.curSpeed = [];  // kn
    this.curToward = []; // graden (waar stroom heen gaat)
    this.waveHeight = []; // significante golfhoogte (m)
  }

  // Geef grid-indices + fracties voor een lat/lon (bilineair)
  _spatialIndex(lat, lon) {
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    lat = clamp(lat, this.lats[0], this.lats[this.lats.length - 1]);
    lon = clamp(lon, this.lons[0], this.lons[this.lons.length - 1]);
    const fi = ((lat - this.lats[0]) / (this.lats[this.lats.length - 1] - this.lats[0])) * (this.lats.length - 1);
    const fj = ((lon - this.lons[0]) / (this.lons[this.lons.length - 1] - this.lons[0])) * (this.lons.length - 1);
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    const i1 = Math.min(i0 + 1, this.lats.length - 1);
    const j1 = Math.min(j0 + 1, this.lons.length - 1);
    return { i0, i1, j0, j1, di: fi - i0, dj: fj - j0 };
  }

  _timeIndex(tMs) {
    if (tMs <= this.times[0]) return { k0: 0, k1: 0, dt: 0 };
    const last = this.times.length - 1;
    if (tMs >= this.times[last]) return { k0: last, k1: last, dt: 0 };
    for (let k = 0; k < last; k++) {
      if (tMs >= this.times[k] && tMs <= this.times[k + 1]) {
        const dt = (tMs - this.times[k]) / (this.times[k + 1] - this.times[k]);
        return { k0: k, k1: k + 1, dt };
      }
    }
    return { k0: last, k1: last, dt: 0 };
  }

  isNavigable(lat, lon) {
    const { i0, i1, j0, j1 } = this._spatialIndex(lat, lon);
    // bevaarbaar als de meeste omringende cellen water zijn: streng genoeg om
    // land te vermijden, maar tolerant bij een kust met grof grid.
    const cells = [
      this.elevation[i0][j0], this.elevation[i0][j1],
      this.elevation[i1][j0], this.elevation[i1][j1],
    ];
    const water = cells.filter((e) => e != null && e <= SEA_LEVEL_THRESHOLD_M).length;
    return water >= 3;
  }

  // Omstandigheden op (lat,lon) op tijd tMs (epoch ms)
  conditionsAt(lat, lon, tMs) {
    const { i0, i1, j0, j1, di, dj } = this._spatialIndex(lat, lon);
    const { k0, k1, dt } = this._timeIndex(tMs);

    const sample = (field, i, j) => {
      const series = field[i][j];
      if (!series) return null;
      const a = series[k0], b = series[k1];
      if (a == null && b == null) return null;
      if (a == null) return b;
      if (b == null) return a;
      return a + (b - a) * dt;
    };
    const sampleAngle = (field, i, j) => {
      const series = field[i][j];
      if (!series) return null;
      const a = series[k0], b = series[k1];
      if (a == null && b == null) return null;
      if (a == null) return b;
      if (b == null) return a;
      return lerpAngle(a, b, dt);
    };

    // Bilineaire interpolatie van een scalair veld (ontbrekende cellen -> 0).
    const bilinScalar = (field) => {
      const v00 = sample(field, i0, j0), v01 = sample(field, i0, j1);
      const v10 = sample(field, i1, j0), v11 = sample(field, i1, j1);
      const vals = [v00, v01, v10, v11].map((v) => (v == null ? 0 : v));
      const a = vals[0] * (1 - dj) + vals[1] * dj;
      const b = vals[2] * (1 - dj) + vals[3] * dj;
      return a * (1 - di) + b * di;
    };
    // Voor richtingen interpoleren we via u/v-componenten samen met de snelheid.
    const bilinVector = (speedField, dirField) => {
      let e = 0, n = 0;
      const corners = [[i0, j0, (1 - di) * (1 - dj)], [i0, j1, (1 - di) * dj], [i1, j0, di * (1 - dj)], [i1, j1, di * dj]];
      for (const [i, j, w] of corners) {
        const sp = sample(speedField, i, j);
        const dir = sampleAngle(dirField, i, j);
        if (sp == null || dir == null) continue;
        const r = toRad(dir);
        e += w * sp * Math.sin(r);
        n += w * sp * Math.cos(r);
      }
      return { speed: Math.hypot(e, n), dir: normalizeBearing(toDeg(Math.atan2(e, n))) };
    };

    const wind = bilinVector(this.windSpeed, this.windFrom);
    const cur = bilinVector(this.curSpeed, this.curToward);
    const wave = bilinScalar(this.waveHeight);
    return {
      wind: { speed: wind.speed, fromDir: wind.dir },
      current: { speed: cur.speed, towardDir: cur.dir },
      waveHeight: wave, // m (0 als geen data)
    };
  }
}

// Synthetisch veld met constante (of zelf opgegeven) omstandigheden. Bruikbaar
// voor tests en als "handmatige invoer"-modus zonder externe API.
export function makeUniformField({
  bbox, departureMs = 0, hours = 48, gridN = 6,
  windSpeed = 12, windFrom = 225, curSpeed = 0, curToward = 0, waveHeight = 0,
  landFn = null, // (lat,lon) => true als land
}) {
  const lats = [], lons = [], times = [];
  for (let i = 0; i < gridN; i++) {
    lats.push(bbox.minLat + ((bbox.maxLat - bbox.minLat) * i) / (gridN - 1));
    lons.push(bbox.minLon + ((bbox.maxLon - bbox.minLon) * i) / (gridN - 1));
  }
  for (let h = 0; h <= hours; h++) times.push(departureMs + h * 3600 * 1000);
  const f = new WeatherField({ bbox, gridN, lats, lons, times, departureMs });
  for (let i = 0; i < gridN; i++) {
    f.elevation[i] = []; f.windSpeed[i] = []; f.windFrom[i] = [];
    f.curSpeed[i] = []; f.curToward[i] = []; f.waveHeight[i] = [];
    for (let j = 0; j < gridN; j++) {
      const land = landFn ? landFn(lats[i], lons[j]) : false;
      f.elevation[i][j] = land ? 50 : -10;
      f.windSpeed[i][j] = times.map(() => windSpeed);
      f.windFrom[i][j] = times.map(() => windFrom);
      f.curSpeed[i][j] = times.map(() => curSpeed);
      f.curToward[i][j] = times.map(() => curToward);
      f.waveHeight[i][j] = times.map(() => waveHeight);
    }
  }
  return f;
}

// Bouw en vul een WeatherField voor de gegeven bounding box en tijdsvenster.
export async function buildWeatherField({ bbox, departureMs, hoursNeeded, gridN = 12 }) {
  const lats = [];
  const lons = [];
  for (let i = 0; i < gridN; i++) {
    lats.push(bbox.minLat + ((bbox.maxLat - bbox.minLat) * i) / (gridN - 1));
    lons.push(bbox.minLon + ((bbox.maxLon - bbox.minLon) * i) / (gridN - 1));
  }

  // Lijst van alle grid-coördinaten in vaste volgorde
  const coords = [];
  for (let i = 0; i < gridN; i++)
    for (let j = 0; j < gridN; j++) coords.push({ i, j, lat: lats[i], lon: lons[j] });

  const field = new WeatherField({ bbox, gridN, lats, lons, departureMs });

  // init lege structuren
  for (let i = 0; i < gridN; i++) {
    field.elevation[i] = new Array(gridN).fill(null);
    field.windSpeed[i] = new Array(gridN).fill(null);
    field.windFrom[i] = new Array(gridN).fill(null);
    field.curSpeed[i] = new Array(gridN).fill(null);
    field.curToward[i] = new Array(gridN).fill(null);
    field.waveHeight[i] = new Array(gridN).fill(null);
  }

  const startDate = new Date(departureMs).toISOString().slice(0, 10);
  const endMs = departureMs + hoursNeeded * 3600 * 1000;
  const endDate = new Date(endMs).toISOString().slice(0, 10);

  // ---- Elevation (statisch land/zee-masker) ----
  for (const batch of chunk(coords, 90)) {
    const latStr = batch.map((c) => c.lat.toFixed(4)).join(",");
    const lonStr = batch.map((c) => c.lon.toFixed(4)).join(",");
    try {
      const data = await fetchJson(`${ELEVATION_URL}?latitude=${latStr}&longitude=${lonStr}`);
      const elev = data.elevation || [];
      batch.forEach((c, idx) => {
        field.elevation[c.i][c.j] = elev[idx] != null ? elev[idx] : 9999;
      });
    } catch {
      // bij fout: behoudend als water markeren zodat routing niet vastloopt
      batch.forEach((c) => { field.elevation[c.i][c.j] = 0; });
    }
  }

  // ---- Wind ----
  let timesSet = false;
  for (const batch of chunk(coords, 100)) {
    const latStr = batch.map((c) => c.lat.toFixed(4)).join(",");
    const lonStr = batch.map((c) => c.lon.toFixed(4)).join(",");
    const url = `${FORECAST_URL}?latitude=${latStr}&longitude=${lonStr}` +
      `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn` +
      `&start_date=${startDate}&end_date=${endDate}&timezone=UTC`;
    const data = asArray(await fetchJson(url));
    data.forEach((loc, idx) => {
      const c = batch[idx];
      const h = loc.hourly;
      if (!h) return;
      if (!timesSet) {
        // Open-Meteo geeft tijden als "2026-06-17T00:00" (UTC). Parse als UTC-epoch.
        field.times = h.time.map((t) => Date.parse(t.endsWith("Z") ? t : t + "Z"));
        timesSet = true;
      }
      field.windSpeed[c.i][c.j] = h.wind_speed_10m;
      field.windFrom[c.i][c.j] = h.wind_direction_10m;
    });
  }

  // ---- Stroming (marine) — kan ontbreken voor binnenwateren; dan 0 ----
  for (const batch of chunk(coords, 100)) {
    const latStr = batch.map((c) => c.lat.toFixed(4)).join(",");
    const lonStr = batch.map((c) => c.lon.toFixed(4)).join(",");
    const url = `${MARINE_URL}?latitude=${latStr}&longitude=${lonStr}` +
      `&hourly=ocean_current_velocity,ocean_current_direction,wave_height` +
      `&start_date=${startDate}&end_date=${endDate}&timezone=UTC`;
    try {
      const data = asArray(await fetchJson(url));
      data.forEach((loc, idx) => {
        const c = batch[idx];
        const h = loc.hourly;
        if (!h) return;
        // km/h -> kn; null laten staan (geen stroomdata => 0 in interpolatie)
        field.curSpeed[c.i][c.j] = (h.ocean_current_velocity || []).map((v) => (v == null ? null : v * KMH_TO_KN));
        field.curToward[c.i][c.j] = h.ocean_current_direction || null;
        field.waveHeight[c.i][c.j] = h.wave_height || null;
      });
    } catch {
      // geen stroomdata beschikbaar voor dit gebied — laat null (=> 0)
    }
  }

  if (!field.times) {
    throw new Error("Geen winddata ontvangen van Open-Meteo voor dit gebied/tijdvak.");
  }
  return field;
}
