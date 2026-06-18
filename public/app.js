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
  .then((r) => r.json())
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
  $("modeHint").innerHTML =
    mode === "start"
      ? "Klik op de kaart om het <b>startpunt</b> te plaatsen."
      : "Klik op de kaart om de <b>bestemming</b> te plaatsen.";
}
$("setStart").onclick = () => setMode("start");
$("setEnd").onclick = () => setMode("end");

function fmt(c) { return `${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`; }

function placePoint(latlng) {
  const c = { lat: latlng.lat, lon: latlng.lng };
  if (state.mode === "start") {
    state.start = c;
    if (state.startMarker) state.startMarker.setLatLng(latlng);
    else state.startMarker = L.marker(latlng, { title: "Start" }).addTo(map).bindTooltip("A");
    state.startMarker.setLatLng(latlng);
    $("startCoord").textContent = fmt(c);
    setMode("end");
  } else {
    state.end = c;
    if (state.endMarker) state.endMarker.setLatLng(latlng);
    else state.endMarker = L.marker(latlng, { title: "Bestemming" }).addTo(map).bindTooltip("B");
    state.endMarker.setLatLng(latlng);
    $("endCoord").textContent = fmt(c);
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

// ---- Kaart-klik & dubbelklik ----
map.on("click", (e) => {
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
  const body = {
    start: state.start,
    end: state.end,
    boatId: $("boat").value,
    departure: $("departure").value + ":00Z",
    zones: state.zones,
    useEngine: $("useEngine").checked,
  };
  $("compute").disabled = true;
  setStatus("Weerdata ophalen en route berekenen…", "busy");
  state.routeLayer.clearLayers();
  state.isoLayer.clearLayers();

  try {
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Onbekende fout");
    state.hasRoute = true;
    drawResult(data);
    setStatus(`Klaar in ${(data.meta.fetchMs + data.meta.computeMs) / 1000}s.`, "ok");
  } catch (err) {
    setStatus("Fout: " + err.message, "error");
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
  data.waypoints.forEach((w, i) => {
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

setMode("start");
