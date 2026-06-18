// Sferische geo-math voor navigatie. Hoeken in graden, afstanden in zeemijl (NM).

export const EARTH_RADIUS_NM = 3440.065; // gemiddelde aardstraal in zeemijl

export const toRad = (deg) => (deg * Math.PI) / 180;
export const toDeg = (rad) => (rad * 180) / Math.PI;

// Normaliseer een koers/peiling naar [0, 360)
export function normalizeBearing(deg) {
  return ((deg % 360) + 360) % 360;
}

// Kleinste verschil tussen twee hoeken, resultaat in [-180, 180]
export function angleDiff(a, b) {
  let d = normalizeBearing(a - b);
  if (d > 180) d -= 360;
  return d;
}

// Haversine-afstand in zeemijl tussen twee {lat, lon}
export function distanceNM(p1, p2) {
  const dLat = toRad(p2.lat - p1.lat);
  const dLon = toRad(p2.lon - p1.lon);
  const lat1 = toRad(p1.lat);
  const lat2 = toRad(p2.lat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Begin-peiling (initial bearing) van p1 naar p2, in graden [0,360)
export function bearing(p1, p2) {
  const lat1 = toRad(p1.lat);
  const lat2 = toRad(p2.lat);
  const dLon = toRad(p2.lon - p1.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeBearing(toDeg(Math.atan2(y, x)));
}

// Bestemmingspunt vanaf {lat,lon} met gegeven koers (graden) en afstand (NM)
export function destinationPoint(p, brng, distNM) {
  const d = distNM / EARTH_RADIUS_NM; // hoekafstand in radialen
  const b = toRad(brng);
  const lat1 = toRad(p.lat);
  const lon1 = toRad(p.lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lon: normalizeLon(toDeg(lon2)) };
}

function normalizeLon(lon) {
  return ((lon + 540) % 360) - 180;
}

// Zet een snelheidsvector (knopen, koers in graden) om naar oost/noord componenten (knopen)
export function vecFromSpeedDir(speed, dirToDeg) {
  const r = toRad(dirToDeg);
  return { e: speed * Math.sin(r), n: speed * Math.cos(r) };
}

// Zet oost/noord-componenten terug naar {speed, dir}
export function speedDirFromVec(e, n) {
  return {
    speed: Math.hypot(e, n),
    dir: normalizeBearing(toDeg(Math.atan2(e, n))),
  };
}

// Bounding box rond een set punten, met marge in graden
export function boundingBox(points, marginDeg = 0.5) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  return {
    minLat: minLat - marginDeg,
    maxLat: maxLat + marginDeg,
    minLon: minLon - marginDeg,
    maxLon: maxLon + marginDeg,
  };
}
