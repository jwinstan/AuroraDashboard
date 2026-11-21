#!/usr/bin/env python3
"""Generate web/data/aacgm_grid.json: AACGM-v2 magnetic lat/lon at 110 km.

Needs `aacgmv2` (pip install aacgmv2). On Windows, install under WSL since
aacgmv2 ships C extensions and Windows wheels lag the current Python.

The grid covers the Nordic + Iceland + Greenland region at 0.5° resolution,
written at a fixed epoch. Regenerate yearly — the magnetic field drifts
noticeably over a few years, but the grid file is small (~200 KB).

aurora/aacgm.py and web/aacgm.js bilinearly interpolate this file at runtime,
with no `aacgmv2` dependency. If the grid file is missing, both fall back to
the centered dipole in model.py / model.js.
"""
import json
import sys
from datetime import datetime
from pathlib import Path

try:
    import aacgmv2
except ImportError:
    sys.exit("install aacgmv2 first:  .wsl-venv/bin/pip install aacgmv2")

# Fixed epoch — mid-year keeps drift errors minimal across the year.
EPOCH = datetime(2026, 6, 15)

LAT_MIN, LAT_MAX, LAT_STEP = 50.0, 85.0, 0.5
LON_MIN, LON_MAX, LON_STEP = -80.0, 35.0, 0.5
ALT_KM = 110  # auroral emission altitude

OUT = Path(__file__).resolve().parent.parent / "web" / "data" / "aacgm_grid.json"


def main():
    import math
    n_lat = int(round((LAT_MAX - LAT_MIN) / LAT_STEP)) + 1
    n_lon = int(round((LON_MAX - LON_MIN) / LON_STEP)) + 1
    print(f"grid: {n_lat} lat × {n_lon} lon = {n_lat * n_lon} cells @ 0.5°")

    mlat = [[None] * n_lon for _ in range(n_lat)]
    mlon = [[None] * n_lon for _ in range(n_lat)]

    for i in range(n_lat):
        lat = LAT_MIN + i * LAT_STEP
        for j in range(n_lon):
            lon = LON_MIN + j * LON_STEP
            try:
                la, lo, _ = aacgmv2.get_aacgm_coord(lat, lon, ALT_KM, EPOCH)
                if la is not None and not (isinstance(la, float) and math.isnan(la)):
                    mlat[i][j] = round(float(la), 3)
                    mlon[i][j] = round(float(lo), 3)
            except Exception:
                pass
        if i % 10 == 0:
            print(f"  row {i}/{n_lat}  lat={lat:.1f}")

    OUT.parent.mkdir(exist_ok=True)
    result = {
        "epoch": EPOCH.isoformat(),
        "alt_km": ALT_KM,
        "lat_min": LAT_MIN, "lat_max": LAT_MAX, "lat_step": LAT_STEP,
        "lon_min": LON_MIN, "lon_max": LON_MAX, "lon_step": LON_STEP,
        "n_lat": n_lat, "n_lon": n_lon,
        "mlat": mlat,
        "mlon": mlon,
    }
    OUT.write_text(json.dumps(result))
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
