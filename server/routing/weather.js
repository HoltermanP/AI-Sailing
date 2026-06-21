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
import { config } from "../config.js";
import { log } from "../logger.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
const ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";

const KMH_TO_KN = 0.539957;
const SEA_LEVEL_THRESHOLD_M = 0.5; // hoogte hieronder => bevaarbaar water
const LAND_CORNER_THRESHOLD_M = 25; // hoekcel boven deze hoogte telt als land
const ELEVATION_MISSING = 9000; // sentinel voor ontbrekende/ongeldige hoogtedata

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Globale throttling: Open-Meteo free tier heeft een strikt minutenlimiet.
let lastOpenMeteoFetchAt = 0;
let openMeteoBlockedUntil = 0;
const elevationCache = new Map(); // "lat,lon" -> { elev, expires }

export class OpenMeteoRateLimitError extends Error {
  constructor(message, retryAfterMs = 0) {
    super(message);
    this.name = "OpenMeteoRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isOpenMeteoBlocked() {
  return Date.now() < openMeteoBlockedUntil;
}

function elevCacheKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

function getCachedElevation(lat, lon) {
  const e = elevationCache.get(elevCacheKey(lat, lon));
  if (!e || Date.now() > e.expires) return null;
  if (e.elev >= ELEVATION_MISSING) return null; // mislukte eerdere fetch niet hergebruiken
  return e.elev;
}

function setCachedElevation(lat, lon, elev) {
  elevationCache.set(elevCacheKey(lat, lon), {
    elev,
    expires: Date.now() + config.elevationCacheTtlMs,
  });
}

function parse429(body) {
  try {
    const reason = JSON.parse(body).reason || "";
    if (/next hour|hourly api/i.test(reason)) {
      return { kind: "hourly", waitMs: 3600_000 };
    }
    if (/one minute|60 second|minutely api/i.test(reason)) {
      return { kind: "minute", waitMs: config.openMeteo429WaitMs };
    }
  } catch { /* ignore */ }
  return { kind: "minute", waitMs: config.openMeteo429WaitMs };
}

function retryWaitMs(status, body, attempt) {
  if (status === 429) return parse429(body).waitMs;
  return Math.min(8000, 500 * 2 ** attempt);
}

async function throttleOpenMeteo() {
  const wait = lastOpenMeteoFetchAt + config.openMeteoMinIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastOpenMeteoFetchAt = Date.now();
}

// Fetch met timeout, throttling en beperkte retries. Bij uur-limiet: direct falen.
async function fetchJson(url, { timeoutMs = 15000, retries = config.openMeteoMaxRetries } = {}) {
  if (isOpenMeteoBlocked()) {
    const waitMs = openMeteoBlockedUntil - Date.now();
    throw new OpenMeteoRateLimitError(
      "Weer-API (Open-Meteo) is tijdelijk overbelast. Probeer over enkele minuten opnieuw.",
      waitMs,
    );
  }

  let lastErr;
  let waited429 = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttleOpenMeteo();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return await res.json();

      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new Error(`Open-Meteo ${res.status}: ${body.slice(0, 160)}`);

      if (res.status === 429) {
        const parsed = parse429(body);
        if (parsed.kind === "hourly") {
          openMeteoBlockedUntil = Date.now() + parsed.waitMs;
          throw new OpenMeteoRateLimitError(
            "Weer-API daglimiet bereikt (Open-Meteo). Probeer over ~1 uur opnieuw.",
            parsed.waitMs,
          );
        }
        if (waited429 || attempt === retries) throw lastErr;
        log.warn("open_meteo_429", { waitMs: parsed.waitMs, attempt: attempt + 1 });
        await sleep(parsed.waitMs);
        waited429 = true;
        continue;
      }

      if (!retryable || attempt === retries) throw lastErr;
      await sleep(retryWaitMs(res.status, body, attempt));
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof OpenMeteoRateLimitError) throw err;
      if (err.message?.startsWith("Open-Meteo")) throw err;
      lastErr = err.name === "AbortError"
        ? new Error(`Open-Meteo timeout na ${timeoutMs}ms`)
        : err;
      if (attempt === retries) throw lastErr;
      await sleep(retryWaitMs(0, "", attempt));
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

  elevationAt(lat, lon) {
    const { i0, i1, j0, j1, di, dj } = this._spatialIndex(lat, lon);
    const v00 = this.elevation[i0][j0];
    const v01 = this.elevation[i0][j1];
    const v10 = this.elevation[i1][j0];
    const v11 = this.elevation[i1][j1];
    const corners = [v00, v01, v10, v11];
    if (corners.some((v) => v == null || v >= ELEVATION_MISSING)) return null;
    const a = v00 * (1 - dj) + v01 * dj;
    const b = v10 * (1 - dj) + v11 * dj;
    return a * (1 - di) + b * di;
  }

  // Is dit punt op water? null = hoogte onbekend (geen data).
  // Nearest-grid-node i.p.v. bilineair: voorkomt vals-land bij klik op water nabij kust.
  isWaterAt(lat, lon) {
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    lat = clamp(lat, this.lats[0], this.lats[this.lats.length - 1]);
    lon = clamp(lon, this.lons[0], this.lons[this.lons.length - 1]);
    const fi = ((lat - this.lats[0]) / (this.lats[this.lats.length - 1] - this.lats[0])) * (this.lats.length - 1);
    const fj = ((lon - this.lons[0]) / (this.lons[this.lons.length - 1] - this.lons[0])) * (this.lons.length - 1);
    const i = Math.round(fi);
    const j = Math.round(fj);
    const e = this.elevation[i]?.[j];
    if (e == null || e >= ELEVATION_MISSING) return null;
    return e <= SEA_LEVEL_THRESHOLD_M;
  }

  isNavigable(lat, lon) {
    const water = this.isWaterAt(lat, lon);
    if (water !== true) return false;

    const { i0, i1, j0, j1 } = this._spatialIndex(lat, lon);
    const corners = [
      this.elevation[i0][j0], this.elevation[i0][j1],
      this.elevation[i1][j0], this.elevation[i1][j1],
    ];
    if (corners.some((e) => e == null || e >= ELEVATION_MISSING)) return false;
    // Cel die overwegend land is: niet doorheen varen (voorkomt diagonale land-snippets).
    const landCorners = corners.filter((e) => e > LAND_CORNER_THRESHOLD_M).length;
    if (landCorners >= 3) return false;
    return true;
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

  /** Compact wind-grid voor kaartvisualisatie op tijdstip tMs. */
  exportWindGrid(tMs) {
    const points = [];
    for (let i = 0; i < this.gridN; i++) {
      for (let j = 0; j < this.gridN; j++) {
        const lat = this.lats[i];
        const lon = this.lons[j];
        if (!this.isNavigable(lat, lon)) continue;
        const { wind } = this.conditionsAt(lat, lon, tMs);
        if (wind.speed < 0.3) continue;
        points.push({
          lat: +lat.toFixed(4),
          lon: +lon.toFixed(4),
          from: +wind.fromDir.toFixed(0),
          speed: +wind.speed.toFixed(1),
        });
      }
    }
    return {
      timeMs: Math.round(tMs),
      timeUtc: new Date(tMs).toISOString().replace(".000Z", "Z"),
      points,
    };
  }

  /** Compact stromings-grid voor kaartvisualisatie op tijdstip tMs. */
  exportCurrentGrid(tMs) {
    const points = [];
    for (let i = 0; i < this.gridN; i++) {
      for (let j = 0; j < this.gridN; j++) {
        const lat = this.lats[i];
        const lon = this.lons[j];
        if (!this.isNavigable(lat, lon)) continue;
        const { current } = this.conditionsAt(lat, lon, tMs);
        if (current.speed < 0.05) continue;
        points.push({
          lat: +lat.toFixed(4),
          lon: +lon.toFixed(4),
          toward: +current.towardDir.toFixed(0),
          speed: +current.speed.toFixed(2),
        });
      }
    }
    return {
      timeMs: Math.round(tMs),
      timeUtc: new Date(tMs).toISOString().replace(".000Z", "Z"),
      points,
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
  const build = async () => {
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

  // ---- Elevation (statisch land/zee-masker, per punt gecacht) ----
  async function fetchElevationBatch(batch) {
    if (!batch.length) return;
    const latStr = batch.map((c) => c.lat.toFixed(4)).join(",");
    const lonStr = batch.map((c) => c.lon.toFixed(4)).join(",");
    const data = await fetchJson(`${ELEVATION_URL}?latitude=${latStr}&longitude=${lonStr}`);
    const elev = data.elevation || [];
    batch.forEach((c, idx) => {
      const v = elev[idx];
      if (v == null) return;
      field.elevation[c.i][c.j] = v;
      setCachedElevation(c.lat, c.lon, v);
    });
  }

  for (const c of coords) {
    const cached = getCachedElevation(c.lat, c.lon);
    if (cached != null) field.elevation[c.i][c.j] = cached;
  }

  let needElev = coords.filter((c) => field.elevation[c.i][c.j] == null);
  for (const batch of chunk(needElev, 100)) {
    try {
      await fetchElevationBatch(batch);
    } catch (err) {
      log.warn("elevation_batch_failed", { n: batch.length, msg: err.message });
      if (err instanceof OpenMeteoRateLimitError) break;
    }
  }

  const missingElev = coords.filter((c) => field.elevation[c.i][c.j] == null).length;
  if (missingElev > 0) {
    log.warn("elevation_incomplete", { missing: missingElev, total: coords.length });
  }

  // ---- Wind (verplicht) ----
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

  // ---- Stroming (marine) — optioneel; overslaan bij rate limit ----
  if (!isOpenMeteoBlocked()) {
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
          field.curSpeed[c.i][c.j] = (h.ocean_current_velocity || []).map((v) => (v == null ? null : v * KMH_TO_KN));
          field.curToward[c.i][c.j] = h.ocean_current_direction || null;
          field.waveHeight[c.i][c.j] = h.wave_height || null;
        });
      } catch (err) {
        log.warn("marine_batch_skipped", { msg: err.message });
        break;
      }
    }
  }

  if (!field.times) {
    throw new Error("Geen winddata ontvangen van Open-Meteo voor dit gebied/tijdvak.");
  }
  return field;
  };

  const timeoutMs = config.weatherFetchTimeoutMs;
  let timer;
  try {
    return await Promise.race([
      build(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Weerdata ophalen duurde te lang (>${Math.round(timeoutMs / 1000)}s). Probeer het later opnieuw.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
