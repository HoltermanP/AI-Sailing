import express from "express";
import { fileURLToPath } from "url";
import path from "path";

import { config, validateConfig } from "./config.js";
import { log } from "./logger.js";
import { TtlCache } from "./cache.js";
import { boundingBox, distanceNM } from "./routing/geo.js";
import { buildWeatherField, OpenMeteoRateLimitError } from "./routing/weather.js";
import { routeIsochrone } from "./routing/isochrone.js";
import { getBoat, listBoats } from "./routing/polar.js";
import { buildRouteContext } from "./routeContext.js";
import { explainRoute, isExplainAvailable } from "./anthropic.js";

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

// Statische frontend (lokaal / Docker; op Vercel serveert het platform public/ zelf).
app.use(express.static(path.join(__dirname, "..", "public")));

const MAX_FORECAST_HOURS = 240;
const forecastCache = new TtlCache({ ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries });
const forecastInFlight = new Map();

function fieldElevationOk(field) {
  let ok = 0;
  const total = field.gridN * field.gridN;
  for (let i = 0; i < field.gridN; i++) {
    for (let j = 0; j < field.gridN; j++) {
      const e = field.elevation[i]?.[j];
      if (e != null && e < 9000) ok++;
    }
  }
  return ok / total >= 0.85;
}

const rateBuckets = new Map();
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

function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  if (req.get("x-api-key") === config.apiKey) return next();
  return res.status(401).json({ error: "Ongeldige of ontbrekende API-key." });
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptimeS: Math.round(process.uptime()),
    cache: forecastCache.stats(),
    boats: listBoats().length,
    authRequired: !!config.apiKey,
    explainAvailable: isExplainAvailable(),
  });
});

app.get("/api/explain/status", (req, res) => {
  res.json({ available: isExplainAvailable(), model: config.anthropicModel });
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
    const margin = Math.min(2, Math.max(0.25, (directDist / 60) * 0.3));
    const bbox = boundingBox([start, end], margin);

    const estHours = Math.ceil((directDist / 3) * 1.3) + 6;
    const hoursNeeded = Math.min(MAX_FORECAST_HOURS, estHours);

    const span = Math.max(bbox.maxLat - bbox.minLat, bbox.maxLon - bbox.minLon);
    const gridN = Math.max(10, Math.min(12, Math.round(span * 6)));

    const hourBucket = Math.floor(departureMs / (3600 * 1000));
    const cacheKey = JSON.stringify({
      b: [bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon].map((v) => v.toFixed(2)),
      gridN, hourBucket, hoursNeeded,
    });

    const t0 = Date.now();
    let field = forecastCache.get(cacheKey);
    if (field && !fieldElevationOk(field)) {
      forecastCache.delete(cacheKey);
      field = null;
    }
    const cacheHit = !!field;
    if (!field) {
      let pending = forecastInFlight.get(cacheKey);
      if (!pending) {
        pending = buildWeatherField({ bbox, departureMs, hoursNeeded, gridN })
          .finally(() => forecastInFlight.delete(cacheKey));
        forecastInFlight.set(cacheKey, pending);
      }
      field = await pending;
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
      windGrid: field.exportWindGrid(departureMs),
      currentGrid: field.exportCurrentGrid(departureMs),
      meta: {
        boat: { id: boat.id, name: boat.name },
        bbox, gridN, fetchMs, computeMs, cacheHit,
        forecastHoursFetched: hoursNeeded,
        truncatedForecast: estHours > MAX_FORECAST_HOURS,
      },
    });
  } catch (err) {
    log.error("route_failed", { msg: err.message });
    const msg = err.message || "Routeberekening mislukt.";
    const friendly = err instanceof OpenMeteoRateLimitError ? err.message
      : /Open-Meteo 429|duurde te lang/i.test(msg)
        ? "Weer-API tijdelijk overbelast (Open-Meteo). Wacht ~1 minuut en probeer opnieuw."
        : msg;
    res.status(502).json({ error: friendly });
  }
});

app.post("/api/explain", rateLimit, requireApiKey, async (req, res) => {
  try {
    if (!isExplainAvailable()) {
      return res.status(503).json({
        error: "Route-uitleg vereist ANTHROPIC_API_KEY in de serverconfiguratie.",
      });
    }

    const { start, end, boatId = "cruiser", zones = [], useEngine = true, route } = req.body || {};
    if (!route?.waypoints?.length || !route?.summary) {
      return res.status(400).json({ error: "route met waypoints en summary is verplicht." });
    }
    if (!start || !end) {
      return res.status(400).json({ error: "start en end zijn verplicht." });
    }

    const boat = getBoat(boatId);
    const context = buildRouteContext({ start, end, boat, useEngine, zones, route });
    const t0 = Date.now();
    const explanation = await explainRoute(context);

    log.info("explain", { ms: Date.now() - t0, model: explanation.model });
    res.json({ explanation: explanation.text, model: explanation.model, usage: explanation.usage });
  } catch (err) {
    log.error("explain_failed", { msg: err.message });
    res.status(502).json({ error: err.message || "Route-uitleg mislukt." });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: `Onbekende route: ${req.method} ${req.originalUrl}` });
});

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

export default app;
