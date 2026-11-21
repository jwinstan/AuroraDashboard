"""Load web/data/aacgm_grid.json and bilinearly interpolate AACGM-v2 mlat.

AACGM corrected geomagnetic coordinates are the standard for auroral physics —
they account for the non-dipolar part of Earth's field that a centered dipole
misses. The difference vs the dipole approximation is small in Fennoscandia
(±1°) but large in the North Atlantic: Iceland ~4.6° lower, Greenland
3-4° lower, meaning our dipole-based code would systematically overpredict
aurora chance there.

If the grid file is missing, callers get None and should fall back to the
centered-dipole value from model.to_dipole().
"""
import json
from pathlib import Path

_GRID_PATH = Path(__file__).resolve().parent.parent / "web" / "data" / "aacgm_grid.json"
_grid = None


def _load():
    global _grid
    if _grid is not None:
        return _grid
    try:
        _grid = json.loads(_GRID_PATH.read_text(encoding="utf-8"))
    except OSError:
        _grid = {}  # missing file -> permanent fallback
    return _grid


def _bilinear(table, i0, j0, fi, fj):
    a = table[i0][j0]
    b = table[i0 + 1][j0]
    c = table[i0][j0 + 1]
    d = table[i0 + 1][j0 + 1]
    if a is None or b is None or c is None or d is None:
        return None
    return a * (1 - fi) * (1 - fj) + b * fi * (1 - fj) + c * (1 - fi) * fj + d * fi * fj


def aacgm_mlat(lat, lon):
    """Bilinearly interpolated AACGM mlat at 110 km, or None if out of grid."""
    g = _load()
    if not g:
        return None
    lat_min, lat_step, n_lat = g["lat_min"], g["lat_step"], g["n_lat"]
    lon_min, lon_step, n_lon = g["lon_min"], g["lon_step"], g["n_lon"]
    fi_raw = (lat - lat_min) / lat_step
    fj_raw = (lon - lon_min) / lon_step
    i0 = int(fi_raw)
    j0 = int(fj_raw)
    if i0 < 0 or i0 >= n_lat - 1 or j0 < 0 or j0 >= n_lon - 1:
        return None
    return _bilinear(g["mlat"], i0, j0, fi_raw - i0, fj_raw - j0)
