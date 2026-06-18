# ⛵ AI-Sailing — Weather Routing voor zeilers

Bepaalt de **optimale (snelste) route van A naar B** voor een zeilboot, rekening
houdend met:

- **Wind** (richting & sterkte, per uur, uit voorspelling)
- **Getijstroming / zeestroming** (richting & sterkte)
- **Boot-polaire** (hoe snel de boot vaart bij elke windhoek/windsterkte)
- **Vaarbeperkingen** — land wordt vermeden en je kunt zelf **verboden zones**
  tekenen (natuurgebied, verkeersscheidingsstelsel, ondiepte, militair gebied …)

De berekening gebruikt de klassieke **isochronen-methode** uit de wedstrijd- en
oceaanzeilerij: vanuit het startpunt wordt per tijdstap de bereikbare "horizon"
(isochroon) uitgerekend; door tegen de wind in vanzelf te kruisen en met gunstige
stroming mee te liften ontstaat de tijd-optimale route.

## Starten

```bash
npm install
npm start                 # open http://localhost:3000  (health: /health)
```

### Scripts

```bash
npm test          # node:test — geo, polairen, offline solver-gedrag
npm run typecheck # syntax-check alle modules
npm run lint      # eslint
npm run dev       # auto-herstart bij wijzigingen
```

### Configuratie

Alle instellingen via env-vars (zie [.env.example](.env.example)) — **geen verplichte secrets**.
Lokaal met een `.env`: `node --env-file=.env server/index.js`. Zie [AUDIT.md](AUDIT.md)
voor de volledige env-checklist en deploy-stappen.

Vier selecteerbare schepen (`synthetic_baseline`-polairen): cruiser, performance
cruiser, heavy bluewater, performance racer — elk met motor-fallback voor windstilte.

Gebruik:
1. Klik op de kaart voor **Start (A)** en daarna **Bestemming (B)**.
2. Kies boottype en vertrektijd.
3. (Optioneel) teken één of meer **verboden zones**.
4. Klik **Bereken optimale route**.

Je krijgt de route op de kaart (met de isochronen als achtergrond), de
reistijd/ETA, en een tabel met koers (COG), snelheid (SOG), windhoek (TWA) en
stroming per beenstuk — inclusief de **kruisrakken (tacks)**.

## Architectuur

```
server/
  index.js              Express API (/api/route, /api/boats) + static hosting
  routing/
    geo.js              sferische navigatie-math (afstand, peiling, bestemmingspunt)
    polar.js            boot-polairen + bilineaire interpolatie
    weather.js          Open-Meteo provider: wind + stroming + land/zee-masker,
                        op een grid met ruimtelijke & temporele interpolatie
    isochrone.js        de routing-engine (isochronen + land/zone-vermijding)
public/                 Leaflet-frontend (index.html, app.js, style.css)
```

## Databron

[Open-Meteo](https://open-meteo.com) — gratis, zonder API-key:
- Forecast-API → wind op 10 m
- Marine-API → zee-/getijstroming
- Elevation-API → land/zee-masker (zee ≈ hoogte ≤ 0 m)

## Beperkingen (prototype)

- Het land/zee-masker is grid-gebaseerd; smalle vaargeulen of kleine eilandjes
  kunnen worden gemist. Niet gebruiken voor echte navigatie.
- Getijstroming komt uit een mondiaal model; lokale getijstromen (bv. zeegaten,
  binnenwateren) kunnen afwijken.
- Voorspellingshorizon ~10–16 dagen; langere reizen worden afgekapt.

## Mogelijke uitbreidingen

- Eigen polaire-bestanden importeren (ORC/`.pol`).
- Dieptebeperkingen op basis van de kiel-diepgang (bathymetrie).
- Officiële beperkingen inlezen (TSS, Natura 2000, ankerverbod) als GeoJSON.
- "Veiligste" i.p.v. "snelste" route (golfhoogte, max windkracht vermijden).
- Meerdere vertrektijden vergelijken (departure planner).
```
