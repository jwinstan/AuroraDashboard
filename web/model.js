// Pure model functions. Must stay bit-identical to aurora/model.py (see tests/parity.mjs).

export const GEOMAG_POLE = [80.8, -72.6];
export const EDGE0 = 66.5;
export const EDGE_SLOPE = 2.0;
export const MLT_AMP = 3.5;
export const MLT_MIN = 23.0;
export const HORIZON_MARGIN = 2.5;
export const WIDTH_KP = 0.75;
export const P_CAP = 0.8;
export const MOON_MAX_PENALTY = 0.5;
export const L1_KM = 1.5e6;
// Poleward edge of the oval. Must match aurora/model.py constants (parity test).
export const POLE_WIDTH_BASE = 6.0;
export const POLE_WIDTH_PER_KP = 2.0;
// Platt-scaling calibration fit against IMAGE magnetometer activity
// (Sep-Nov 2024, 10 stations, ~20k station-hours). AUC unchanged; only the
// reported number changes. See backtest/calibration.json and parity test.
export const CALIB_A = 1.9752;
export const CALIB_B = -1.7881;

const rad = Math.PI / 180, deg = 180 / Math.PI;

const unit = (lat, lon) => [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const FRAME = (() => {
  const z = unit(...GEOMAG_POLE);
  let y = cross([0, 0, 1], z);
  const n = Math.hypot(...y);
  y = y.map(c => c / n);
  return [cross(y, z), y, z];
})();

export function toDipole(lat, lon) {
  const r = unit(lat, lon), [x, y, z] = FRAME;
  return [Math.asin(dot(r, z)) * deg, Math.atan2(dot(r, y), dot(r, x)) * deg];
}

// Inverse of toDipole: (dipole lat, dipole lon) -> (geographic lat, lon).
export function fromDipole(mlat, mlon) {
  const r = unit(mlat, mlon);
  const [x, y, z] = FRAME;
  const gx = r[0] * x[0] + r[1] * y[0] + r[2] * z[0];
  const gy = r[0] * x[1] + r[1] * y[1] + r[2] * z[1];
  const gz = r[0] * x[2] + r[1] * y[2] + r[2] * z[2];
  return [Math.asin(gz) * deg, Math.atan2(gy, gx) * deg];
}

// Prefer AACGM-v2 mlat when the grid is loaded (large correction for IS/GL).
// Falls back to centered dipole when the grid is missing or query is out of
// range. Must match aurora/model.py.geomag_lat() exactly (parity test).
import { aacgmMlat } from "./aacgm.js";
export function geomagLat(lat, lon) {
  const v = aacgmMlat(lat, lon);
  return v != null ? v : toDipole(lat, lon)[0];
}

const jdn = t => t.getTime() / 864e5 + 2440587.5 - 2451545.0;

export function sunCoords(t) {
  const n = jdn(t);
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 4e-7 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  return [ra, dec, gmst];
}

function altitude(ra, dec, gmst, lat, lon) {
  const ha = (gmst + lon) * rad - ra, la = lat * rad;
  return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) * deg;
}

export const sunAlt = (t, lat, lon) => { const [ra, dec, g] = sunCoords(t); return altitude(ra, dec, g, lat, lon); };

export function mlt(t, lat, lon) {
  const [ra, dec, gmst] = sunCoords(t);
  const ss = toDipole(dec * deg, ra * deg - gmst)[1], m = toDipole(lat, lon)[1];
  return (((12 + (m - ss) / 15) % 24) + 24) % 24;
}

export function moonCoords(t) {
  const d = jdn(t);
  const L = 218.316 + 13.176396 * d;
  const M = (134.963 + 13.064993 * d) * rad, F = (93.272 + 13.229350 * d) * rad;
  const D = (297.850 + 12.190749 * d) * rad, Ms = (357.529 + 0.98560028 * d) * rad;
  const s = Math.sin;
  const lam = (L + 6.289 * s(M) - 1.274 * s(M - 2 * D) + 0.658 * s(2 * D) - 0.186 * s(Ms) - 0.059 * s(2 * M - 2 * D)
    - 0.057 * s(M - 2 * D + Ms) + 0.053 * s(M + 2 * D) + 0.046 * s(2 * D - Ms) + 0.041 * s(M - Ms) - 0.035 * s(D)
    - 0.031 * s(M + Ms) - 0.015 * s(2 * F - 2 * D) + 0.011 * s(M - 4 * D)) * rad;
  const beta = (5.128 * s(F) + 0.280 * s(M + F) + 0.277 * s(M - F) + 0.173 * s(2 * D - F)
    + 0.055 * s(2 * D - M + F) + 0.046 * s(2 * D - M - F)) * rad;
  const eps = (23.439 - 4e-7 * d) * rad;
  const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps), Math.cos(lam));
  const dec = Math.asin(Math.sin(beta) * Math.cos(eps) + Math.cos(beta) * Math.sin(eps) * Math.sin(lam));
  return [ra, dec];
}

export function moonState(t, lat, lon) {
  const [ra, dec] = moonCoords(t), [sra, sdec, gmst] = sunCoords(t);
  let alt = altitude(ra, dec, gmst, lat, lon);
  alt -= 0.95 * Math.cos(alt * rad);
  const cosPsi = Math.sin(sdec) * Math.sin(dec) + Math.cos(sdec) * Math.cos(dec) * Math.cos(sra - ra);
  return [alt, (1 - cosPsi) / 2];
}

export const moonFactor = (alt, ill) => alt <= 0 ? 1 : 1 - MOON_MAX_PENALTY * ill * Math.min(1, Math.sin(alt * rad) / Math.sin(30 * rad));
export const darkness = alt => alt <= -12 ? 1 : alt >= -6 ? 0 : (-6 - alt) / 6;

export const sigmoid = x => 1 / (1 + Math.exp(-x));
export const mltShift = m => MLT_AMP * (1 - Math.cos(2 * Math.PI * (m - MLT_MIN) / 24));

export function kpNeeded(mlat, m = MLT_MIN) {
  const s = mltShift(m);
  return [Math.max(0, (EDGE0 + s - HORIZON_MARGIN - mlat) / EDGE_SLOPE), Math.max(0, (EDGE0 + s - mlat) / EDGE_SLOPE)];
}

export function pGeoRaw(kp, mlat, m) {
  const w = EDGE_SLOPE * WIDTH_KP;
  const eq = EDGE0 - EDGE_SLOPE * kp + mltShift(m);
  const pole = eq + POLE_WIDTH_BASE + POLE_WIDTH_PER_KP * kp;
  const overhead = sigmoid((mlat - eq) / w) * sigmoid((pole - mlat) / w);
  const horizon = 0.6 * sigmoid((mlat - eq + HORIZON_MARGIN) / w) * sigmoid((pole + HORIZON_MARGIN - mlat) / w);
  return P_CAP * Math.max(overhead, horizon);
}

export function platt(p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const z = Math.log(p / (1 - p));
  return sigmoid(CALIB_A * z + CALIB_B);
}

export const pGeo = (kp, mlat, m) => platt(pGeoRaw(kp, mlat, m));

export const newell = (v, bt, by, bz) => Math.pow(v, 4 / 3) * Math.pow(bt, 2 / 3) * Math.pow(Math.abs(Math.sin(Math.atan2(by, bz) / 2)), 8 / 3);

export function haversine(la1, lo1, la2, lo2) {
  const a = Math.sin((la2 - la1) * rad / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin((lo2 - lo1) * rad / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export function pClear(c) {
  if (!c) return null;
  const [tot, lo, mi, hi] = c;
  const layers = [lo, mi, hi == null ? null : 0.5 * hi].filter(x => x != null);
  const eff = layers.length ? Math.max(...layers) : tot;
  return eff == null ? null : Math.max(0, 1 - eff / 100);
}

export function verdict(p) {
  if (p >= 0.5) return ["GOOD", "var(--good)"];
  if (p >= 0.25) return ["FAIR", "var(--warning)"];
  if (p >= 0.10) return ["POOR", "var(--serious)"];
  return ["UNLIKELY", "var(--text-muted)"];
}

export const couplingLabel = x => x < 4000 ? "weak" : x < 12000 ? "moderate" : x < 25000 ? "strong" : "very strong";

export function ovationAt(pts, lat, lon) {
  const lon360 = ((lon % 360) + 360) % 360;
  let over = 0, horiz = 0;
  for (const [plon, plat, p] of pts) {
    if (plat < lat - 1 || plat > lat + 6) continue;
    const dist = haversine(lat, lon360, plat, plon);
    if (dist <= 80) over = Math.max(over, p);
    if (plat >= lat && dist <= 500) horiz = Math.max(horiz, p);
  }
  return [over, horiz];
}

export const median = xs => { const s = [...xs].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
