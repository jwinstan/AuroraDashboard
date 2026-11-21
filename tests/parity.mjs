// Run model.js on inputs from argv[2], write results to argv[3].
// Paired with tests/test_parity.py.
import { readFileSync, writeFileSync } from "fs";
import { setAacgmGrid } from "../web/aacgm.js";
import {
  geomagLat, mlt, sunAlt, moonState, moonFactor, darkness,
  pGeo, pClear, kpNeeded, fromDipole,
} from "../web/model.js";

// Load the AACGM grid synchronously so geomagLat uses AACGM (not dipole
// fallback) during parity. Python reads the same file in aurora/aacgm.py.
try {
  const grid = JSON.parse(readFileSync("web/data/aacgm_grid.json", "utf8"));
  setAacgmGrid(grid);
} catch (e) {
  // grid file missing -> both sides fall back to dipole, still parity-equal
}

const inputs = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = inputs.map(([lat, lon, tMs, kp, cTot, cLo, cMi, cHi]) => {
  const t = new Date(tMs);
  const mlat = geomagLat(lat, lon);
  const m = mlt(t, lat, lon);
  const sa = sunAlt(t, lat, lon);
  const [ma, mi] = moonState(t, lat, lon);
  const mf = moonFactor(ma, mi);
  const dk = darkness(sa);
  const pg = pGeo(kp, mlat, m);
  const pc = pClear([cTot, cLo, cMi, cHi]);
  const [kh, ko] = kpNeeded(mlat, m);
  // Use kp (0-9) as a dipole mlat and the cell longitude*10 as a dipole mlon
  // just to get two deterministic inputs — we only care they're the same on both sides.
  const [gLat, gLon] = fromDipole(kp * 8, (lon * 7) % 360 - 180);
  return [mlat, m, sa, ma, mi, mf, dk, pg, pc, kh, ko, gLat, gLon];
});
writeFileSync(process.argv[3], JSON.stringify(out));
