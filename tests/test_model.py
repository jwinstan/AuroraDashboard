import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import aurora_fi as A  # noqa: E402

UTC = timezone.utc


def test_geomag_lat_known_sites():
    # AACGM-v2 at 110 km, epoch 2026-06-15 (matches web/data/aacgm_grid.json).
    assert A.geomag_lat(60.17, 24.94) == pytest.approx(57.24, abs=0.2)  # Helsinki
    assert A.geomag_lat(67.42, 26.59) == pytest.approx(64.75, abs=0.2)  # Sodankylä
    # The headline win from AACGM: Iceland and Greenland shift ~4° equatorward.
    assert A.geomag_lat(64.15, -21.94) == pytest.approx(64.20, abs=0.2)  # Reykjavík
    assert A.geomag_lat(64.18, -51.72) == pytest.approx(68.58, abs=0.2)  # Nuuk


def test_mlt_advances_one_hour_per_hour():
    t = datetime(2026, 11, 19, 12, tzinfo=UTC)
    a, b = A.mlt(t, 66.5, 25.7), A.mlt(t + timedelta(hours=1), 66.5, 25.7)
    assert (b - a) % 24 == pytest.approx(1.0, abs=0.1)  # dipole tilt makes MLT rate vary slightly with UT


def test_magnetic_midnight_finland_evening_ut():
    hours = [h for h in range(24) if abs(A.mlt(datetime(2026, 11, 19, h, 30, tzinfo=UTC), 66.5, 25.7) - 23.5) < 0.6
             or A.mlt(datetime(2026, 11, 19, h, 30, tzinfo=UTC), 66.5, 25.7) < 0.1]
    assert hours and all(19 <= h <= 22 for h in hours)


@pytest.mark.parametrize("iso,alt,ill", [
    ("2026-11-19T18:00:00", 19.65, 0.720),
    ("2026-11-19T22:00:00", 11.60, 0.735),
    ("2026-11-25T20:00:00", 37.45, 0.976),
    ("2026-12-03T23:00:00", -17.74, 0.231),
])
def test_moon_matches_astropy(iso, alt, ill):
    t = datetime.fromisoformat(iso).replace(tzinfo=UTC)
    a, i = A.moon_state(t, 69.05, 20.79)
    assert a == pytest.approx(alt, abs=0.5)
    assert i == pytest.approx(ill, abs=0.01)


def test_moon_factor_bounds():
    assert A.moon_factor(-5, 1.0) == 1.0
    assert A.moon_factor(60, 1.0) == pytest.approx(1 - A.MOON_MAX_PENALTY)
    assert A.moon_factor(60, 0.0) == 1.0


def test_darkness_ramp():
    assert A.darkness(-3) == 0.0
    assert A.darkness(-9) == pytest.approx(0.5)
    assert A.darkness(-20) == 1.0


def test_p_clear_layers_and_fallbacks():
    assert A.p_clear((100, 10, 20, 100)) == pytest.approx(0.5)
    assert A.p_clear((80, None, None, None)) == pytest.approx(0.2)
    assert A.p_clear((None, None, 30, None)) == pytest.approx(0.7)
    assert A.p_clear((None, None, None, None)) is None


def test_p_geo_monotonic_and_mlt_dependent():
    mlat = A.geomag_lat(66.5, 25.73)
    assert A.p_geo_from_kp(4, mlat, 23) > A.p_geo_from_kp(1, mlat, 23)
    assert A.p_geo_from_kp(2.67, mlat, 23) > A.p_geo_from_kp(2.67, mlat, 12)
    assert A.p_geo_from_kp(9, 70, 23) <= A.P_CAP


def test_rows_both_formats_and_active_filter():
    lol = [["time_tag", "kp"], ["2026-11-19 00:00:00", "3.33"]]
    assert A.rows(lol) == [{"time_tag": "2026-11-19 00:00:00", "kp": "3.33"}]
    rs = [{"active": False, "v": 1}, {"active": True, "v": 2}]
    assert A.active(rs) == [{"active": True, "v": 2}]


@pytest.mark.parametrize("s", ["2026-11-19 03:00:00", "2026-11-19T03:00:00Z", "2026-11-19 03:00:00.000", "2026-11-19T03:00"])
def test_ptime_formats(s):
    assert A.ptime(s) == datetime(2026, 11, 19, 3, tzinfo=UTC)


def test_kp_in_bin():
    t0 = datetime(2026, 11, 19, 0, tzinfo=UTC)
    fc = [(t0, 2.0, "predicted"), (t0 + timedelta(hours=3), 4.67, "predicted")]
    assert A.kp_in_bin(fc, t0 + timedelta(hours=4))[0] == 4.67
    assert A.kp_in_bin(fc, t0 + timedelta(hours=7))[0] is None


def test_median():
    assert A.median([3, 1, 2]) == 2
    assert A.median([4, 1, 3, 2]) == 2.5
