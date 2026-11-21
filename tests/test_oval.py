"""Phase 1c regression guards for the oval model.

Finland numbers must not shift more than 0.05 when the poleward edge is added
(else the old intuition breaks), and polar-cap locations must drop to low P at
quiet Kp. Confidence that these constants are right: ~0.6. See PLAN.md.
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aurora import model as M  # noqa: E402

# Old formula (Phase 0) that we require Finnish places to stay within 0.05 of.
def _p_geo_pre_poleward(kp, mlat, mlt_h):
    w = M.EDGE_SLOPE * M.WIDTH_KP
    edge = M.oval_edge(kp, mlt_h)
    sig = M.sigmoid
    return M.P_CAP * max(
        0.6 * sig((mlat - edge + M.HORIZON_MARGIN) / w),
        sig((mlat - edge) / w),
    )


FINLAND_MLATS = [
    57.8,   # Helsinki
    60.6,   # Oulu
    62.8,   # Rovaniemi
    64.4,   # Sodankylä
    66.7,   # Kilpisjärvi
]


def test_finland_within_0_05_of_pre_poleward():
    # Compares the *raw* geometric probability to the Phase 0 formula. The
    # Platt calibration layer (Phase 4) deliberately shifts the numbers to
    # match observations, so the structural guard runs on p_geo_raw, not on
    # the calibrated p_geo_from_kp.
    worst = 0.0
    for mlat in FINLAND_MLATS:
        for kp10 in range(0, 91):  # 0.0 to 9.0 in 0.1 steps
            kp = kp10 / 10
            for mlt_h in (21.0, 22.0, 23.0, 0.0, 1.0, 2.0, 3.0):
                a = _p_geo_pre_poleward(kp, mlat, mlt_h)
                b = M.p_geo_raw(kp, mlat, mlt_h)
                d = abs(a - b)
                if d > worst:
                    worst = d
                assert d < 0.05, f"Finland regression: mlat={mlat} kp={kp} mlt={mlt_h} old={a:.3f} new={b:.3f} Δ={d:.3f}"
    assert worst < 0.05


def test_polar_cap_low_at_quiet():
    # Qaanaaq-ish dipole latitude at magnetic midnight, quiet Kp.
    p = M.p_geo_from_kp(2.0, 86.6, 23.0)
    assert p < 0.1, f"Qaanaaq at Kp 2 midnight should be low, got {p:.3f}"


def test_longyearbyen_lower_at_midnight_than_edge_at_kp_zero():
    # Not a cusp model (TODO: PLAN.md Phase 1c poleward boundary refinement).
    # But midnight polar cap should still be lower than the edge of the oval.
    p_midnight = M.p_geo_from_kp(0.0, 75.3, 23.0)
    p_edge = M.p_geo_from_kp(0.0, 66.5, 23.0)
    assert p_midnight < p_edge


def test_oval_still_monotonic_in_kp_for_mid_latitudes():
    # Kilpisjärvi: more Kp = more chance, up to saturation.
    vals = [M.p_geo_from_kp(k, 66.7, 23.0) for k in (0, 1, 2, 3, 4, 5)]
    for a, b in zip(vals, vals[1:]):
        assert b >= a - 1e-9, f"non-monotonic: {vals}"
