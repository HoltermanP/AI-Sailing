import express from "express";
import { fileURLToPath } from "url";
import path from "path";

import { config, validateConfig } from "./config.js";
import { log } from "./logger.js";
import { TtlCache } from "./cache.js";
import { boundingBox, distanceNM } from "./routing/geo.js";
import { buildWeatherField } from "./routing/weather.js";
import { routeIsochrone } from "./routing/isochrone.js";
import { getBoat, listBoats } from "./routing/polar.js";

validateConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// Request-logging (structured).
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    log.info("http", { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 });
  });
  next();
});

// Statische frontend (index.html, app.js, style.css).
app.use(express.static(path.join(__dirname, "..", "public")));

const MAX_FORECAST_HOURS = 240; // grens van bruikbare voorspelling
const forecastCache = new TtlCache({ ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries });

// ---- Eenvoudige in-memory rate limiter per IP ----
const rateBuckets = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + config.rateWindowMs };
    rateBuckets.set(ip, b);
  }
  b.count++;
  if (b.count > config.rateMax) {
    const retryAfter = Math.ceil((b.resetAt - now) / 1000);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: `Te veel verzoeken. Probeer over ${retryAfter}s opnieuw.` });
  }
  next();
}

// ---- Optionele API-key (alleen actief als config.apiKey gezet is) ----
function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  if (req.get("x-api-key") === config.apiKey) return next();
  return res.status(401).json({ error: "Ongeldige of ontbrekende API-key." });
}

// ---- Health endpoint ----
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptimeS: Math.round(process.uptime()),
    cache: forecastCache.stats(),
    boats: listBoats().length,
    authRequired: !!config.apiKey,
  });
});

app.get("/api/boats", (req, res) => {
  res.json({ boats: listBoats() });
});

app.post("/api/route", rateLimit, requireApiKey, async (req, res) => {
  try {
    const { start, end, boatId = "cruiser", departure, zones = [], useEngine = true } = req.body || {};
    if (!start || !end || start.lat == null || end.lat == null) {
      return res.status(400).json({ error: "start en end (met lat/lon) zijn verplicht." });
    }
    for (const [name, p] of [["start", start], ["end", end]]) {
      if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
        return res.status(400).json({ error: `Ongeldige coördinaten voor ${name}.` });
      }
    }
    if (!Array.isArray(zones) || zones.length > 50) {
      return res.status(400).json({ error: "zones moet een lijst van max 50 gebieden zijn." });
    }
    const boat = getBoat(boatId);
    const departureMs = departure ? Date.parse(departure) : Date.now();
    if (Number.isNaN(departureMs)) {
      return res.status(400).json({ error: "Ongeldige vertrektijd." });
    }
    // Forecast-venster: Open-Meteo levert ~recent verleden t/m ~16 dagen vooruit.
    const now = Date.now();
    if (departureMs < now - 2 * 24 * 3600 * 1000) {
      return res.status(400).json({ error: "Vertrektijd ligt te ver in het verleden voor een voorspelling." });
    }
    if (departureMs > now + 15 * 24 * 3600 * 1000) {
      return res.status(400).json({ error: "Vertrektijd ligt voorbij de voorspellingshorizon (~16 dagen)." });
    }

    const directDist = distanceNM(start, end);
    if (directDist > config.maxRouteNM) {
      return res.status(400).json({ error: `Route te lang (${Math.round(directDist)} NM > limiet ${config.maxRouteNM} NM).` });
    }
    // marge in graden (1° ≈ 60 NM): ~30% van de reisafstand, begrensd,
    // zodat opkruisen/omvaren binnen het datagrid blijft maar het grid fijn genoeg blijft.
    const margin = Math.min(2, Math.max(0.25, (directDist / 60) * 0.3));
    const bbox = boundingBox([start, end], margin);

    // geschatte benodigde uren (trage ondergrens ~3 kn) + buffer
    const estHours = Math.ceil((directDist / 3) * 1.3) + 6;
    const hoursNeeded = Math.min(MAX_FORECAST_HOURS, estHours);

    // grid-resolutie meeschalen met gebiedsgrootte
    const span = Math.max(bbox.maxLat - bbox.minLat, bbox.maxLon - bbox.minLon);
    const gridN = Math.max(8, Math.min(16, Math.round(span * 6)));

    // Forecast-cache: sleutel op afgerond gebied + grid + vertrek-uur + venster.
    const hourBucket = Math.floor(departureMs / (3600 * 1000));
    const cacheKey = JSON.stringify({
      b: [bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon].map((v) => v.toFixed(2)),
      gridN, hourBucket, hoursNeeded,
    });

    const t0 = Date.now();
    let field = forecastCache.get(cacheKey);
    const cacheHit = !!field;
    if (!field) {
      field = await buildWeatherField({ bbox, departureMs, hoursNeeded, gridN });
      forecastCache.set(cacheKey, field);
    }
    const fetchMs = Date.now() - t0;

    const t1 = Date.now();
    const result = routeIsochrone({ start, end, field, boat, departureMs, zones, options: { useEngine } });
    const computeMs = Date.now() - t1;

    log.info("route", {
      boat: boat.id, directDist: +directDist.toFixed(1), dist: result.summary.distanceNM,
      durationH: result.summary.durationHours, cacheHit, fetchMs, computeMs,
    });

    res.json({
      ...result,
      meta: {
        boat: { id: boat.id, name: boat.name },
        bbox, gridN, fetchMs, computeMs, cacheHit,
        forecastHoursFetched: hoursNeeded,
        truncatedForecast: estHours > MAX_FORECAST_HOURS,
      },
    });
  } catch (err) {
    log.error("route_failed", { msg: err.message });
    res.status(502).json({ error: err.message || "Routeberekening mislukt." });
  }
});

// Onbekende API-route → JSON 404 (geen HTML-foutpagina; client kan dit parsen).
app.use("/api", (req, res) => {
  res.status(404).json({ error: `Onbekende route: ${req.method} ${req.originalUrl}` });
});

// Centrale error-handler → ALTIJD JSON (vangt o.a. misvormde body / te grote payload).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const msg =
    err.type === "entity.parse.failed" ? "Ongeldige JSON in verzoek." :
    err.type === "entity.too.large" ? "Verzoek te groot." :
    (status >= 500 ? "Serverfout." : err.message);
  log.error("unhandled", { msg: err.message, status });
  res.status(status).json({ error: msg });
});

const server = app.listen(config.port, () => {
  log.info("server_start", { url: `http://localhost:${config.port}`, authRequired: !!config.apiKey });
});

// Nette shutdown.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log.info("server_stop", { signal: sig });
    server.close(() => process.exit(0));
  });
}
