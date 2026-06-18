import express from "express";
import { fileURLToPath } from "url";
import path from "path";

import { boundingBox, distanceNM } from "./routing/geo.js";
import { buildWeatherField } from "./routing/weather.js";
import { routeIsochrone } from "./routing/isochrone.js";
import { getBoat, listBoats } from "./routing/polar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const MAX_FORECAST_HOURS = 240; // grens van bruikbare voorspelling

app.get("/api/boats", (req, res) => {
  res.json({ boats: listBoats() });
});

app.post("/api/route", async (req, res) => {
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

    const t0 = Date.now();
    const field = await buildWeatherField({ bbox, departureMs, hoursNeeded, gridN });
    const fetchMs = Date.now() - t0;

    const t1 = Date.now();
    const result = routeIsochrone({ start, end, field, boat, departureMs, zones, options: { useEngine } });
    const computeMs = Date.now() - t1;

    res.json({
      ...result,
      meta: {
        boat: { id: boat.id, name: boat.name },
        bbox,
        gridN,
        fetchMs,
        computeMs,
        forecastHoursFetched: hoursNeeded,
        truncatedForecast: estHours > MAX_FORECAST_HOURS,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Routeberekening mislukt." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI-sailing draait op http://localhost:${PORT}`);
});
