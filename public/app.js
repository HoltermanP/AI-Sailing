// AI-Sailing frontend — Leaflet kaart + UI voor isochronen weather-routing.

const map = L.map("map", { worldCopyJump: true }).setView([52.9, 4.6], 8);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "© OpenStreetMap",
}).addTo(map);

const state = {
  mode: "start",      // welk punt plaatst de volgende klik
  start: null,
  end: null,
  startMarker: null,
  endMarker: null,
  routeLayer: L.layerGroup().addTo(map),
  isoLayer: L.layerGroup().addTo(map),
  zoneLayer: L.layerGroup().addTo(map),
  zones: [],          // [{name, polygon:[[lat,lon],...]}]
  drawing: null,      // tijdelijke zone-punten tijdens tekenen
  drawingMarkers: L.layerGroup().addTo(map),
};

const $ = (id) => document.getElementById(id);

// Veilig JSON lezen: bij een niet-JSON antwoord (bv. HTML-foutpagina) geven we
// een duidelijke fout i.p.v. de cryptische "string did not match the expected
// pattern" die sommige browsers bij res.json() op niet-JSON gooien.
async function parseJsonSafe(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Server gaf een onverwacht antwoord (HTTP ${res.status}).`);
  }
}

// ---- Boten laden ----
const FALLBACK_BOATS = [
  { id: "cruiser", name: "Cruising yacht (~36ft)", nogo: 32 },
  { id: "racer", name: "Performance racer (~40ft)", nogo: 28 },
];

function fillBoats(boats) {
  const sel = $("boat");
  sel.innerHTML = "";
  boats.forEach((b) => {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = `${b.name} (no-go ${b.nogo}°)`;
    sel.appendChild(o);
  });
}

fetch("/api/boats")
  .then((r) => parseJsonSafe(r))
  .then((d) => fillBoats(d.boats && d.boats.length ? d.boats : FALLBACK_BOATS))
  .catch(() => {
    // server even niet bereikbaar: gebruik ingebouwde lijst zodat selectie altijd werkt
    fillBoats(FALLBACK_BOATS);
    setStatus("Boot-lijst kon niet laden van server — standaardlijst gebruikt.", "busy");
  });

// ---- Vertrektijd standaard = nu (afgerond op uur, UTC) ----
(function initDeparture() {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  $("departure").value = now.toISOString().slice(0, 16);
})();

// ---- Punt-plaatsing modus ----
function setMode(mode) {
  state.mode = mode;
  $("setStart").classList.toggle("active", mode === "start");
  $("setEnd").classList.toggle("active", mode === "end");
  if (mode === "start") {
    $("modeHint").innerHTML = state.start
      ? "Klik op het water om het <b>startpunt</b> te verplaatsen, of sleep marker A."
      : "Klik op de kaart om het <b>startpunt</b> te plaatsen.";
  } else {
    $("modeHint").innerHTML = state.end
      ? "Klik op het water om de <b>bestemming</b> te verplaatsen, of sleep marker B."
      : "Klik op de kaart om de <b>bestemming</b> te plaatsen.";
  }
}
$("setStart").onclick = () => setMode("start");
$("setEnd").onclick = () => setMode("end");

function fmt(c) { return `${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`; }

function clearRouteVisualization() {
  state.hasRoute = false;
  state.routeLayer.clearLayers();
  state.isoLayer.clearLayers();
  $("result").classList.add("hidden");
  $("explanationPanel").classList.add("hidden");
  $("explanation").textContent = "";
  $("summary").innerHTML = "";
  $("legs").innerHTML = "";
}

function bindMarkerDrag(marker, which) {
  marker.on("dragend", () => {
    const ll = marker.getLatLng();
    const c = { lat: ll.lat, lon: ll.lng };
    if (which === "start") {
      state.start = c;
      $("startCoord").textContent = fmt(c);
    } else {
      state.end = c;
      $("endCoord").textContent = fmt(c);
    }
    clearRouteVisualization();
    setStatus("", "");
  });
}

function placePoint(latlng) {
  const c = { lat: latlng.lat, lon: latlng.lng };
  clearRouteVisualization();
  if (state.mode === "start") {
    state.start = c;
    if (state.startMarker) {
      state.startMarker.setLatLng(latlng);
      if (state.startMarker.dragging) state.startMarker.dragging.enable();
    } else {
      state.startMarker = L.marker(latlng, { title: "Start", draggable: true }).addTo(map).bindTooltip("A");
      bindMarkerDrag(state.startMarker, "start");
    }
    $("startCoord").textContent = fmt(c);
    setMode("end");
  } else {
    state.end = c;
    if (state.endMarker) {
      state.endMarker.setLatLng(latlng);
      if (state.endMarker.dragging) state.endMarker.dragging.enable();
    } else {
      state.endMarker = L.marker(latlng, { title: "Bestemming", draggable: true }).addTo(map).bindTooltip("B");
      bindMarkerDrag(state.endMarker, "end");
    }
    $("endCoord").textContent = fmt(c);
    setMode("end");
  }
}

function hintForRouteError(message) {
  if (/startpunt/i.test(message)) {
    setMode("start");
    $("modeHint").innerHTML = "Het startpunt ligt op land. Klik op het <b>water</b> of sleep marker A.";
    return;
  }
  if (/bestemming/i.test(message)) {
    setMode("end");
    $("modeHint").innerHTML = "De bestemming ligt op land. Klik op het <b>water</b> of sleep marker B.";
  }
}

// ---- Zone tekenen ----
$("drawZone").onclick = function () {
  if (state.drawing) { finishZone(); return; }
  state.drawing = [];
  this.classList.add("armed");
  this.textContent = "✓ Zone afronden (of dubbelklik)";
  $("modeHint").innerHTML = "Klik hoekpunten van de verboden zone. Dubbelklik om te sluiten.";
};

function finishZone() {
  $("drawZone").classList.remove("armed");
  $("drawZone").textContent = "+ Verboden zone tekenen";
  if (state.drawing && state.drawing.length >= 3) {
    const poly = state.drawing.map((p) => [p.lat, p.lng]);
    const zone = { name: `Zone ${state.zones.length + 1}`, polygon: poly };
    state.zones.push(zone);
    L.polygon(state.drawing, { color: "#f59e0b", fillOpacity: 0.18, weight: 1.5 }).addTo(state.zoneLayer);
    renderZones();
  }
  state.drawing = null;
  state.drawingMarkers.clearLayers();
}

function renderZones() {
  const ul = $("zoneList");
  ul.innerHTML = "";
  state.zones.forEach((z) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>🛑 ${z.name}</span><span>${z.polygon.length} punten</span>`;
    ul.appendChild(li);
  });
}

$("clearZones").onclick = () => {
  state.zones = [];
  state.zoneLayer.clearLayers();
  renderZones();
};

// ---- Mobiel: inklapbaar bedieningspaneel ----
const sidebar = $("sidebar");
const panelToggle = $("panelToggle");
const MOBILE_MQ = window.matchMedia("(max-width: 768px)");

function isMobileLayout() {
  return MOBILE_MQ.matches;
}

function invalidateMapSize() {
  requestAnimationFrame(() => map.invalidateSize({ animate: false }));
}

function setPanelExpanded(expanded) {
  if (!isMobileLayout()) {
    sidebar.classList.remove("expanded");
    panelToggle.setAttribute("aria-expanded", "false");
    return;
  }
  sidebar.classList.toggle("expanded", expanded);
  panelToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  setTimeout(invalidateMapSize, 300);
}

panelToggle.addEventListener("click", () => setPanelExpanded(true));
sidebar.querySelector(".sheet-handle")?.addEventListener("click", () => setPanelExpanded(false));

MOBILE_MQ.addEventListener("change", () => {
  setPanelExpanded(false);
  invalidateMapSize();
});
window.addEventListener("resize", invalidateMapSize);
window.addEventListener("orientationchange", () => setTimeout(invalidateMapSize, 350));
map.whenReady(invalidateMapSize);

// ---- Kaart-klik & dubbelklik ----
map.on("click", (e) => {
  if (isMobileLayout() && sidebar.classList.contains("expanded")) setPanelExpanded(false);
  if (state.drawing) {
    state.drawing.push(e.latlng);
    L.circleMarker(e.latlng, { radius: 4, color: "#f59e0b" }).addTo(state.drawingMarkers);
  } else {
    placePoint(e.latlng);
  }
});
map.on("dblclick", (e) => { if (state.drawing) { L.DomEvent.stop(e); finishZone(); } });

// ---- Status helper ----
function setStatus(msg, cls = "") {
  const s = $("status");
  s.textContent = msg;
  s.className = cls;
}

// ---- Route berekenen ----
async function computeRoute() {
  if (!state.start || !state.end) {
    setStatus("Plaats eerst start (A) én bestemming (B).", "error");
    return;
  }
  // Vertrektijd: datetime-local levert "YYYY-MM-DDTHH:MM". Bij lege/ongeldige
  // waarde (bv. browser zonder datetime-local-ondersteuning) vallen we terug op nu.
  const depVal = $("departure").value;
  const departure = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(depVal)
    ? depVal + ":00Z"
    : new Date().toISOString();

  const body = {
    start: state.start,
    end: state.end,
    boatId: $("boat").value,
    departure,
    zones: state.zones,
    useEngine: $("useEngine").checked,
  };
  $("compute").disabled = true;
  setStatus("Weerdata ophalen en route berekenen…", "busy");
  state.routeLayer.clearLayers();
  state.isoLayer.clearLayers();
  $("explanationPanel").classList.add("hidden");
  $("explanation").textContent = "";

  try {
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.error || `Serverfout (HTTP ${res.status}).`);
    state.hasRoute = true;
    drawResult(data);
    setStatus(`Klaar in ${(data.meta.fetchMs + data.meta.computeMs) / 1000}s.`, "ok");
  } catch (err) {
    setStatus("Fout: " + err.message, "error");
    hintForRouteError(err.message);
    if (isMobileLayout()) setPanelExpanded(true);
  } finally {
    $("compute").disabled = false;
  }
}

$("compute").onclick = computeRoute;

// Herbereken automatisch bij wisselen van schip of motor-optie (als er al een route is).
function recomputeIfRouted() {
  if (state.hasRoute && state.start && state.end) computeRoute();
}
$("boat").addEventListener("change", recomputeIfRouted);
$("useEngine").addEventListener("change", recomputeIfRouted);

function drawResult(data) {
  // isochronen (achtergrond)
  data.isochrones.forEach((iso) => {
    if (iso.length < 2) return;
    const pts = iso.map((p) => [p.lat, p.lon]).sort((a, b) => {
      // sorteer rond startpunt zodat de lijn ordelijk loopt
      const c = state.start;
      const ba = Math.atan2(a[1] - c.lon, a[0] - c.lat);
      const bb = Math.atan2(b[1] - c.lon, b[0] - c.lat);
      return ba - bb;
    });
    L.polyline(pts, { color: "#38bdf8", weight: 0.8, opacity: 0.35 }).addTo(state.isoLayer);
  });

  // route
  const latlngs = data.waypoints.map((w) => [w.lat, w.lon]);
  L.polyline(latlngs, { color: "#2dd4bf", weight: 4 }).addTo(state.routeLayer);

  // tack-markers waar de koers sterk verandert
  let prevCog = null;
  data.waypoints.forEach((w) => {
    if (w.cog == null) return;
    if (prevCog != null && Math.abs(angleDelta(w.cog, prevCog)) > 30) {
      L.circleMarker([w.lat, w.lon], { radius: 3.5, color: "#2dd4bf", fillOpacity: 1 })
        .addTo(state.routeLayer)
        .bindTooltip(`Koerswijziging → ${w.cog}°`);
    }
    prevCog = w.cog;
  });

  map.fitBounds(L.polyline(latlngs).getBounds().pad(0.25));
  renderSummary(data);
  renderLegs(data);
  fetchExplanation(data);
  if (isMobileLayout()) setPanelExpanded(true);
}

function angleDelta(a, b) {
  let d = ((a - b + 540) % 360) - 180;
  return d;
}

function renderSummary(data) {
  const s = data.summary;
  const eta = new Date(s.etaMs).toUTCString().replace("GMT", "UTC");
  const h = Math.floor(s.durationHours);
  const m = Math.round((s.durationHours - h) * 60);
  $("result").classList.remove("hidden");
  const motorPct = Math.round((s.motorFraction || 0) * 100);
  $("summary").innerHTML = `
    <div class="item"><div class="k">Reistijd</div><div class="v">${h}u ${m}m</div></div>
    <div class="item"><div class="k">Afstand</div><div class="v">${s.distanceNM} NM</div></div>
    <div class="item"><div class="k">Direct (grootcirkel)</div><div class="v">${s.directDistanceNM} NM</div></div>
    <div class="item"><div class="k">Gem. snelheid</div><div class="v">${s.avgSpeedKn} kn</div></div>
    <div class="item"><div class="k">Onder motor</div><div class="v">${motorPct}%</div></div>
    <div class="item"><div class="k">Schip</div><div class="v" style="font-size:13px">${data.meta.boat.name}</div></div>
    <div class="item" style="grid-column:1/3"><div class="k">Aankomst (ETA)</div><div class="v">${eta}</div></div>
  `;
  if (data.meta.truncatedForecast) {
    setStatus("Let op: reis langer dan voorspellingshorizon — laatste deel op laatst bekende weer.", "busy");
  }
}

function renderLegs(data) {
  const wps = data.waypoints;
  let rows = `<tr><th>tijd</th><th>COG°</th><th>SOG kn</th><th>TWA°</th><th>TWS kn</th><th>stroom kn</th><th>golf m</th></tr>`;
  let prevCog = null;
  // toon ~elke n-de waypoint om de tabel beknopt te houden
  const stepEvery = Math.max(1, Math.floor(wps.length / 40));
  wps.forEach((w, i) => {
    if (w.cog == null) return;
    const isTack = prevCog != null && Math.abs(angleDelta(w.cog, prevCog)) > 30;
    if (i % stepEvery !== 0 && !isTack && i !== wps.length - 1) { prevCog = w.cog; return; }
    const t = new Date(w.timeMs).toUTCString().slice(17, 22);
    const mark = (w.motoring ? " ⚙" : "") + (isTack ? " ⟲" : "");
    rows += `<tr class="${isTack ? "tack" : ""}">
      <td>${t}${mark}</td><td>${w.cog}</td><td>${w.sog}</td>
      <td>${w.twa}</td><td>${w.tws}</td><td>${w.curSpeed}</td><td>${w.waveHeight ?? 0}</td></tr>`;
    prevCog = w.cog;
  });
  $("legs").innerHTML = rows;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdownLite(text) {
  const blocks = text.split(/\n\n+/);
  return blocks.map((block) => {
    const lines = block.split("\n");
    if (lines[0].startsWith("## ")) {
      return `<h4>${escapeHtml(lines[0].slice(3))}</h4>${lines.slice(1).map((l) => `<p>${escapeHtml(l)}</p>`).join("")}`;
    }
    if (lines.every((l) => l.startsWith("- ") || l.startsWith("* "))) {
      return `<ul>${lines.map((l) => `<li>${escapeHtml(l.slice(2))}</li>`).join("")}</ul>`;
    }
    return `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

let explainRequestId = 0;

async function fetchExplanation(routeData) {
  const panel = $("explanationPanel");
  const el = $("explanation");
  const reqId = ++explainRequestId;

  panel.classList.remove("hidden");
  el.className = "explanation loading";
  el.textContent = "Route-uitleg genereren via Anthropic…";

  const depVal = $("departure").value;
  const departure = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(depVal)
    ? depVal + ":00Z"
    : new Date().toISOString();

  try {
    const res = await fetch("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start: state.start,
        end: state.end,
        boatId: $("boat").value,
        departure,
        zones: state.zones,
        useEngine: $("useEngine").checked,
        route: {
          waypoints: routeData.waypoints,
          summary: routeData.summary,
          meta: routeData.meta,
        },
      }),
    });
    const data = await parseJsonSafe(res);
    if (reqId !== explainRequestId) return;

    if (!res.ok) {
      el.className = "explanation error";
      el.textContent = data.error || "Route-uitleg kon niet worden opgehaald.";
      return;
    }

    el.className = "explanation";
    el.innerHTML = renderMarkdownLite(data.explanation || "");
  } catch (err) {
    if (reqId !== explainRequestId) return;
    el.className = "explanation error";
    el.textContent = "Fout bij route-uitleg: " + err.message;
  }
}

setMode("start");
