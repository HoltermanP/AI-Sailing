// Boot-polairen: bootsnelheid (knopen) als functie van ware windhoek (TWA, 0-180°)
// en ware windsnelheid (TWS, knopen). Bilineaire interpolatie tussen tabelwaarden.
//
// De rij TWA=0..nogo geeft ~0 snelheid: hoger aan de wind dan de "no-go"-hoek
// kan de boot niet zeilen. De isochronen-engine ontdekt daardoor vanzelf dat er
// gekruist (opgekruist) moet worden om tegen de wind in te varen.

const TWA_COLS = [0, 30, 40, 50, 60, 75, 90, 110, 120, 135, 150, 165, 180];

// Snelheidstabellen per windsnelheid. Index van rij komt overeen met TWS_ROWS.
const TWS_ROWS = [4, 6, 8, 10, 12, 14, 16, 20, 25];

export const BOATS = {
  cruiser: {
    id: "cruiser",
    name: "Cruising yacht (~36ft)",
    nogo: 32, // kan niet hoger dan ~32° aan de wind
    motorKn: 5.5, // kruissnelheid op de motor (windstilte)
    source: "synthetic_baseline",
    twa: TWA_COLS,
    tws: TWS_ROWS,
    // speed[twsIndex][twaIndex]
    speed: [
      [0, 0, 2.6, 3.4, 4.0, 4.5, 4.7, 4.6, 4.4, 4.0, 3.4, 2.6, 2.2], // 4 kn
      [0, 0, 3.8, 4.6, 5.2, 5.7, 5.9, 5.8, 5.6, 5.1, 4.4, 3.5, 3.0], // 6 kn
      [0, 0, 4.7, 5.5, 6.0, 6.4, 6.6, 6.6, 6.4, 6.0, 5.3, 4.4, 3.9], // 8 kn
      [0, 0, 5.4, 6.1, 6.5, 6.9, 7.1, 7.2, 7.1, 6.8, 6.2, 5.3, 4.8], // 10 kn
      [0, 0, 5.8, 6.4, 6.8, 7.2, 7.5, 7.7, 7.7, 7.6, 7.1, 6.2, 5.6], // 12 kn
      [0, 0, 6.0, 6.6, 7.0, 7.4, 7.8, 8.1, 8.2, 8.3, 8.0, 7.1, 6.5], // 14 kn
      [0, 0, 6.1, 6.7, 7.1, 7.6, 8.0, 8.4, 8.6, 8.9, 8.8, 7.9, 7.3], // 16 kn
      [0, 0, 6.2, 6.8, 7.3, 7.8, 8.3, 8.9, 9.2, 9.8, 10.0, 9.1, 8.4], // 20 kn
      [0, 0, 6.0, 6.7, 7.2, 7.8, 8.4, 9.2, 9.7, 10.6, 11.2, 10.3, 9.5], // 25 kn
    ],
  },
  perfcruiser: {
    id: "perfcruiser",
    name: "Performance cruiser (~38ft)",
    nogo: 30,
    motorKn: 6.0,
    source: "synthetic_baseline",
    twa: TWA_COLS,
    tws: TWS_ROWS,
    speed: [
      [0, 0, 3.0, 3.9, 4.5, 4.9, 5.1, 5.0, 4.8, 4.4, 3.8, 3.0, 2.5],
      [0, 0, 4.3, 5.1, 5.7, 6.1, 6.4, 6.4, 6.2, 5.7, 5.0, 4.0, 3.5],
      [0, 0, 5.2, 6.0, 6.5, 6.9, 7.2, 7.3, 7.1, 6.8, 6.1, 5.1, 4.5],
      [0, 0, 5.9, 6.6, 7.0, 7.4, 7.7, 8.0, 8.0, 7.8, 7.2, 6.2, 5.6],
      [0, 0, 6.3, 6.9, 7.3, 7.8, 8.2, 8.6, 8.7, 8.7, 8.3, 7.3, 6.6],
      [0, 0, 6.5, 7.1, 7.5, 8.1, 8.6, 9.1, 9.3, 9.6, 9.4, 8.4, 7.7],
      [0, 0, 6.6, 7.2, 7.7, 8.3, 8.9, 9.6, 10.0, 10.5, 10.5, 9.5, 8.7],
      [0, 0, 6.7, 7.4, 7.9, 8.6, 9.4, 10.5, 11.1, 12.1, 12.4, 11.3, 10.4],
      [0, 0, 6.6, 7.3, 8.0, 8.8, 9.8, 11.2, 12.1, 13.7, 14.6, 13.4, 12.3],
    ],
  },
  bluewater: {
    id: "bluewater",
    name: "Heavy bluewater cruiser (~45ft)",
    nogo: 38, // langkieler, kruist slecht
    motorKn: 7.0,
    source: "synthetic_baseline",
    twa: TWA_COLS,
    tws: TWS_ROWS,
    speed: [
      [0, 0, 0.0, 2.6, 3.3, 3.8, 4.0, 4.0, 3.8, 3.4, 2.9, 2.2, 1.9],
      [0, 0, 3.0, 3.9, 4.5, 4.9, 5.2, 5.2, 5.0, 4.6, 4.0, 3.2, 2.7],
      [0, 0, 4.0, 4.7, 5.2, 5.6, 5.9, 6.0, 5.9, 5.5, 4.9, 4.1, 3.6],
      [0, 0, 4.6, 5.3, 5.7, 6.1, 6.4, 6.6, 6.6, 6.3, 5.8, 5.0, 4.5],
      [0, 0, 5.0, 5.6, 6.0, 6.4, 6.8, 7.1, 7.2, 7.1, 6.7, 5.9, 5.4],
      [0, 0, 5.2, 5.8, 6.2, 6.7, 7.1, 7.5, 7.7, 7.9, 7.6, 6.8, 6.3],
      [0, 0, 5.4, 6.0, 6.4, 6.9, 7.4, 7.9, 8.2, 8.6, 8.5, 7.7, 7.1],
      [0, 0, 5.6, 6.2, 6.7, 7.3, 7.9, 8.7, 9.2, 9.9, 10.1, 9.3, 8.6],
      [0, 0, 5.6, 6.3, 6.9, 7.6, 8.3, 9.3, 9.9, 11.0, 11.5, 10.7, 9.9],
    ],
  },
  racer: {
    id: "racer",
    name: "Performance racer (~40ft)",
    nogo: 28,
    motorKn: 6.0,
    source: "synthetic_baseline",
    twa: TWA_COLS,
    tws: TWS_ROWS,
    speed: [
      [0, 0, 3.6, 4.5, 5.0, 5.4, 5.6, 5.5, 5.3, 4.9, 4.2, 3.3, 2.8],
      [0, 0, 5.0, 5.8, 6.3, 6.7, 7.0, 7.0, 6.8, 6.4, 5.7, 4.6, 4.0],
      [0, 0, 6.0, 6.7, 7.1, 7.5, 7.8, 8.0, 7.9, 7.6, 7.0, 5.9, 5.2],
      [0, 0, 6.6, 7.2, 7.6, 8.0, 8.4, 8.7, 8.8, 8.7, 8.2, 7.1, 6.4],
      [0, 0, 6.9, 7.5, 7.9, 8.4, 8.9, 9.4, 9.6, 9.8, 9.5, 8.4, 7.6],
      [0, 0, 7.1, 7.7, 8.1, 8.7, 9.3, 10.0, 10.4, 11.0, 10.9, 9.8, 9.0],
      [0, 0, 7.2, 7.8, 8.3, 9.0, 9.7, 10.6, 11.2, 12.2, 12.4, 11.2, 10.3],
      [0, 0, 7.3, 8.0, 8.6, 9.5, 10.5, 11.9, 12.9, 14.6, 15.4, 14.0, 12.8],
      [0, 0, 7.2, 8.0, 8.8, 9.9, 11.2, 13.2, 14.6, 17.2, 18.6, 17.0, 15.5],
    ],
  },
};

function interp1d(x, x0, x1, y0, y1) {
  if (x1 === x0) return y0;
  const t = (x - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

function findBracket(arr, v) {
  if (v <= arr[0]) return [0, 0];
  if (v >= arr[arr.length - 1]) return [arr.length - 1, arr.length - 1];
  for (let i = 0; i < arr.length - 1; i++) {
    if (v >= arr[i] && v <= arr[i + 1]) return [i, i + 1];
  }
  return [arr.length - 1, arr.length - 1];
}

// Bootsnelheid in knopen. twaDeg verwacht 0..180 (absolute windhoek).
export function polarSpeed(boat, twaDeg, twsKnots) {
  const twa = Math.min(180, Math.abs(twaDeg));
  const [ti0, ti1] = findBracket(boat.tws, twsKnots);
  const [ai0, ai1] = findBracket(boat.twa, twa);

  const tws0 = boat.tws[ti0], tws1 = boat.tws[ti1];
  const twa0 = boat.twa[ai0], twa1 = boat.twa[ai1];

  // bilineair: eerst over TWA, dan over TWS
  const s00 = boat.speed[ti0][ai0];
  const s01 = boat.speed[ti0][ai1];
  const s10 = boat.speed[ti1][ai0];
  const s11 = boat.speed[ti1][ai1];

  const sLow = interp1d(twa, twa0, twa1, s00, s01);
  const sHigh = interp1d(twa, twa0, twa1, s10, s11);
  let speed = interp1d(twsKnots, tws0, tws1, sLow, sHigh);

  // Veilige extrapolatie:
  // - boven de hoogste TWS: clamp (vlak) — conservatief, geen onrealistische groei
  // - onder de laagste TWS: lineair naar 0 schalen i.p.v. de laagste rij overschatten
  const twsMin = boat.tws[0];
  if (twsKnots < twsMin) speed *= Math.max(0, twsKnots / twsMin);

  return Math.max(0, speed);
}

export function getBoat(id) {
  return BOATS[id] || BOATS.cruiser;
}

export function listBoats() {
  return Object.values(BOATS).map((b) => ({
    id: b.id, name: b.name, nogo: b.nogo, motorKn: b.motorKn, source: b.source,
  }));
}
