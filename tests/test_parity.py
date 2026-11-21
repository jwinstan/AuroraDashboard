"""Parity test: aurora/model.py vs web/model.js over random inputs.

Pure model outputs must agree to |Δ| < 1e-9 so the Python CLI and the JS dashboard
never report different numbers for the same inputs.
"""
import json
import random
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aurora import model as M  # noqa: E402

TOL = 1e-9
N = 2000


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_python_js_model_parity():
    random.seed(0)
    # integer seconds -> exact float round-trip through Python's datetime
    t_lo = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp())
    t_hi = int(datetime(2028, 1, 1, tzinfo=timezone.utc).timestamp())
    inputs = []
    for _ in range(N):
        lat = random.uniform(50, 80)
        lon = random.uniform(-80, 40)
        t_s = random.randint(t_lo, t_hi)
        kp = random.uniform(0, 9)
        c = (
            random.uniform(0, 100), random.uniform(0, 100),
            random.uniform(0, 100), random.uniform(0, 100),
        )
        inputs.append([lat, lon, t_s * 1000, kp, *c])

    with tempfile.TemporaryDirectory() as td:
        inp_p = Path(td) / "inp.json"
        out_p = Path(td) / "out.json"
        inp_p.write_text(json.dumps(inputs))
        subprocess.run(
            ["node", str(ROOT / "tests" / "parity.mjs"), str(inp_p), str(out_p)],
            check=True, capture_output=True,
        )
        js_out = json.loads(out_p.read_text())

    names = ["mlat", "mlt", "sun_alt", "moon_alt", "moon_ill", "moon_factor",
             "darkness", "p_geo", "p_clear", "kp_horiz", "kp_over",
             "from_dipole_lat", "from_dipole_lon"]
    worst = {n: 0.0 for n in names}
    for i, row in enumerate(inputs):
        lat, lon, t_ms, kp, c0, c1, c2, c3 = row
        t = datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc)
        mlat = M.geomag_lat(lat, lon)
        m = M.mlt(t, lat, lon)
        sa = M.sun_alt(t, lat, lon)
        ma, mi = M.moon_state(t, lat, lon)
        mf = M.moon_factor(ma, mi)
        dk = M.darkness(sa)
        pg = M.p_geo_from_kp(kp, mlat, m)
        pc = M.p_clear((c0, c1, c2, c3))
        kh, ko = M.kp_needed(mlat, m)
        g_lat, g_lon = M.from_dipole(kp * 8, (lon * 7) % 360 - 180)
        py = [mlat, m, sa, ma, mi, mf, dk, pg, pc, kh, ko, g_lat, g_lon]
        js = js_out[i]
        for n, a, b in zip(names, py, js):
            d = abs(a - b)
            worst[n] = max(worst[n], d)
            assert d < TOL, f"row {i} {n}: py={a!r} js={b!r} diff={d}"
    print("worst diffs:", worst)
