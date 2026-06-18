# AUDIT — AI-Sailing weather-routing

Datum: 2026-06-18 · Werkwijze: autonome audit + fixes, kleine commits per fase.

## Status (Definition of Done)

| DoD-criterium | Status |
|---|---|
| build / typecheck / lint / tests groen | ✅ `npm run typecheck`, `npm run lint` (0 errors), `npm test` (19/19) |
| één echte A→B-route met echt forecast + gekozen schip + ETA op de kaart | ✅ IJmuiden→Lowestoft, live Open-Meteo (zie [docs/smoke-test.txt](docs/smoke-test.txt)) |
| min. 4 schepen selecteerbaar | ✅ cruiser, performance cruiser, heavy bluewater, racer |
| AUDIT.md met status/fixes/risico's/env/deploy | ✅ dit document |
| geen secrets in repo, geen ongelabelde verzonnen data | ✅ geen secrets; polairen gelabeld `synthetic_baseline` |

## Gedetecteerde stack (Fase 0)

- **Runtime:** Node.js ≥18 (getest op v20.20), ES-modules (`"type": "module"`).
- **Server:** Express 4. Geen database, geen build-stap.
- **Frontend:** vanilla JS + Leaflet 1.9 via CDN (`public/`), geen bundler.
- **Data:** Open-Meteo (forecast-wind, marine-stroming+golven, elevation = land/zee-masker). **Geen API-key vereist.**
- **Deploy-target:** niet vooraf geconfigureerd → Dockerfile + deploy-commando's toegevoegd (zie onder).

### Modulekaart

| Bestand | Functie |
|---|---|
| `server/index.js` | Express-app: `/api/route`, `/api/boats`, `/health`; rate limit, optionele API-key, cache, logging |
| `server/config.js` | env-config + boot-validatie |
| `server/logger.js` | structured JSON-logging |
| `server/cache.js` | in-memory TTL-cache voor forecast-velden |
| `server/routing/geo.js` | sferische navigatie-math (afstand, peiling, bestemmingspunt, vectoren) |
| `server/routing/polar.js` | 4 boot-polairen + bilineaire interpolatie + veilige extrapolatie |
| `server/routing/weather.js` | Open-Meteo provider (grid, interpolatie ruimte+tijd), `makeUniformField` voor tests |
| `server/routing/isochrone.js` | isochronen-solver: polaire+wind+stroom+golf, motor, land-/zonevermijding |
| `public/` | Leaflet-UI (kaart, schip-selector, zones tekenen, route + isochronen + tabel) |
| `test/` | `node:test`: geo, polairen, en offline solver-gedrag (19 tests) |

## Wat werkte al / was stub / dode code (Fase 0)

- **Werkte:** geo-math, polaire-interpolatie, weergrid-ophalen + interpolatie, isochronen-solver (laveren geverifieerd), API, frontend.
- **Stub/ontbrekend:** golf-snelheidscorrectie, windstilte-afhandeling, tests, lint, caching, retries/timeouts, `/health`, env-config; slechts 2 schepen.
- **Dode code:** `bilinScalar` in `weather.js` (ongebruikt) → nu in gebruik voor het golfveld.

## Fixes per fase

**Fase 1 — kern-correctheid**
- Data-pijplijn live geverifieerd: wind in **kn**, stroming **km/h→kn** (factor 0.539957), golven in **m**, tijden **UTC** (ISO zonder `Z` → als UTC geparset). Ruimtelijke bilineaire + temporele lineaire interpolatie; richtingen via u/v-componenten; ontbrekende cellen (`null`) → 0/overslaan.
- **Golf-snelheidscorrectie** toegevoegd (`waveFactor`, heuristiek, géén VPP-fysica): aan-de-wind remt sterker, afgetopt op 50%. Golfhoogte uit dezelfde marine-call (geen extra request).
- Solver gecontroleerd: no-go uit polaire (0 kt onder de hoek), VMG/laveren ontstaat vanzelf, stroomvector correct opgeteld (ware wind herrekend t.o.v. bewegend water), landvermijding via segment-sampling.
- **Edge cases:** windstilte → motor-fallback; bestemming op land → duidelijke fout; coördinaat-validatie; vertrektijd buiten forecast-venster → 400.

**Fase 2 — schepen/polairen**
- Uitgebreid naar **4 archetypes** (cruiser, performance cruiser, heavy bluewater, racer), allemaal `source: "synthetic_baseline"`, elk met `motorKn`.
- **Veilige extrapolatie:** boven hoogste TWS clampen (vlak); onder laagste TWS lineair naar 0 (geen overschatting in lichte lucht).
- UI: schip-selector + motor-toggle; **route herberekent automatisch** bij wisselen van schip/motor.

**Fase 3 — productie-gereed**
- `config.js` met env + boot-validatie; `.env.example`. **Geen verplichte secrets.**
- Externe calls: **timeout (AbortController) + retries met exponentiële backoff**, respecteert `Retry-After` bij 429.
- **Forecast-cache** (in-memory TTL/LRU) — bewust de eenvoudigste werkende optie; vervangbaar door Redis/Upstash met dezelfde interface.
- **Rate limiting** per IP op `/api/route`; **optionele `x-api-key`** (alleen actief als `API_KEY` gezet is).
- **Observability:** `/health` endpoint + structured JSON-logging + request-logging; nette shutdown.
- Geen LLM-laag aanwezig → prompt-injection/kostenlimiet **n.v.t.**

**Fase 4 — deploy + smoke**
- Dockerfile + `.dockerignore` (multi-stage niet nodig; `npm ci --omit=dev`).
- E2E smoke: zie [docs/smoke-test.txt](docs/smoke-test.txt).

## Smoke-test resultaat (live forecast)

Route **IJmuiden (52.47, 4.45) → Lowestoft (52.47, 1.80)**, vertrek 2026-06-18 10:00Z:

| Schip | Afstand | Reistijd | Gem. | Motor | Tacks |
|---|---|---|---|---|---|
| Heavy bluewater (motor aan) | 99.6 NM | 14.5 u | 6.86 kn | 100% | — |
| Performance racer (alleen zeil) | 100.7 NM | 14.0 u | 7.18 kn | 0% | 4 |

De tweede route hergebruikte het gecachte forecast-veld (`cacheHit: true`, fetch 1 ms). Bij de testdatum was de wind licht (6–8 kn), waardoor de motor-cruiser logischerwijs vrijwel volledig motort.

## Openstaande risico's / beperkingen

1. **Land/zee-masker is grid-gebaseerd** (Open-Meteo elevation). Smalle vaargeulen, kleine eilanden en binnenwateren (bv. IJsselmeer ≈ zeeniveau) kunnen verkeerd geclassificeerd worden. **Niet gebruiken voor echte navigatie.**
2. **Golfcorrectie is een heuristiek**, geen gevalideerde VPP-fysica. Gelabeld als zodanig in de code.
3. **Polairen zijn `synthetic_baseline`**, geen echte ORC-VPP-data. Structuur (`{tws[], twa[], boat_speed[][]}`) is klaar om echte `.pol`/ORC-data in te laden.
4. **Getijstroming uit mondiaal model** — lokale getijstromen (zeegaten, estuaria) kunnen sterk afwijken.
5. **Cache is per-proces** (in-memory). Bij meerdere instances geen gedeelde cache → vervang door Redis/Upstash.
6. **Rate limiter is per-proces** en op IP; achter een proxy `app.set('trust proxy', …)` instellen voor correcte IP's.
7. **ORC-scraping niet uitgevoerd** (geen netwerk-/licentiezekerheid) — daarom synthetische seed conform opdracht.

## Env-checklist

| Variabele | Verplicht | Default | Functie |
|---|---|---|---|
| `PORT` | nee | 3000 | webserver-poort |
| `FORECAST_CACHE_TTL_MS` | nee | 1800000 | cache-levensduur (30 min) |
| `FORECAST_CACHE_MAX` | nee | 50 | max gecachte velden |
| `RATE_LIMIT_MAX` | nee | 30 | max verzoeken / venster / IP |
| `RATE_LIMIT_WINDOW_MS` | nee | 60000 | rate-venster |
| `API_KEY` | nee | — | indien gezet: `/api/route` vereist `x-api-key` |
| `MAX_ROUTE_NM` | nee | 1500 | plafond routeafstand (DoS-bescherming) |
| `LOG_LEVEL` | nee | info | error/warn/info/debug |

> Er zijn **geen verplichte secrets**. Open-Meteo werkt zonder key.

## Deploy-stappen (voer jij uit — geen betaalde/onomkeerbare acties door mij)

**1. Lokaal / VPS (plain Node):**
```bash
npm ci --omit=dev
node --env-file=.env server/index.js   # of: PORT=8080 npm start
curl localhost:3000/health
```

**2. Met PM2 (process manager):**
```bash
npm ci --omit=dev
pm2 start server/index.js --name ai-sailing --env production
pm2 save
```

**3. Docker:**
```bash
docker build -t ai-sailing .
docker run -p 3000:3000 --env-file .env ai-sailing
# health: docker inspect --format '{{.State.Health.Status}}' <container>
```
> Image is **niet lokaal gebouwd** in deze sessie (docker niet aanwezig op de auditmachine). Dockerfile is wel volledig.

**4. PaaS (Render/Railway/Fly.io):**
- Build command: `npm ci --omit=dev`
- Start command: `node server/index.js`
- Health check path: `/health`
- Env-vars: zie checklist (alle optioneel; eventueel `API_KEY` zetten voor afscherming).

**Cron / forecast-refresh:** niet vereist — forecast wordt **on-demand** opgehaald en via TTL-cache hergebruikt. Optioneel kun je een warm-up cron toevoegen die `/api/route` voor populaire gebieden pre-fetcht zodat de cache warm blijft; nodig is het niet.

## Snelle verificatie

```bash
npm install
npm run typecheck && npm run lint && npm test
npm start   # open http://localhost:3000  · health: /health
```
