// Load web/data/aacgm_grid.json and bilinearly interpolate AACGM-v2 mlat.
// See aurora/aacgm.py for background. Must stay bit-identical to the Python
// version — the parity test enforces this.

let gridPromise = null;
let grid = null;

export async function loadAacgm() {
  if (gridPromise) return gridPromise;
  gridPromise = fetch("./data/aacgm_grid.json", { cache: "no-store" })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)
    .then(g => { grid = g || {}; return grid; });
  return gridPromise;
}

// Sync setter used by the single-file build (which inlines the grid as window.__AACGM__).
export function setAacgmGrid(g) {
  grid = g || {};
  gridPromise = Promise.resolve(grid);
}

function bilinear(table, i0, j0, fi, fj) {
  const a = table[i0][j0];
  const b = table[i0 + 1][j0];
  const c = table[i0][j0 + 1];
  const d = table[i0 + 1][j0 + 1];
  if (a == null || b == null || c == null || d == null) return null;
  return a * (1 - fi) * (1 - fj) + b * fi * (1 - fj) + c * (1 - fi) * fj + d * fi * fj;
}

export function aacgmMlat(lat, lon) {
  if (!grid || !grid.mlat) return null;
  const fiRaw = (lat - grid.lat_min) / grid.lat_step;
  const fjRaw = (lon - grid.lon_min) / grid.lon_step;
  const i0 = Math.floor(fiRaw);
  const j0 = Math.floor(fjRaw);
  if (i0 < 0 || i0 >= grid.n_lat - 1 || j0 < 0 || j0 >= grid.n_lon - 1) return null;
  return bilinear(grid.mlat, i0, j0, fiRaw - i0, fjRaw - j0);
}
