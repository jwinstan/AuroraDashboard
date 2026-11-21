"""Pure model functions for the aurora forecaster.

Stdlib only. Must stay bit-identical to web/model.js (see tests/test_parity.py).
"""
import math
from datetime import datetime, timedelta, timezone

GEOMAG_POLE = (80.8, -72.6)
EDGE0 = 66.5
EDGE_SLOPE = 2.0
MLT_AMP = 3.5
MLT_MIN = 23.0
HORIZON_MARGIN = 2.5
WIDTH_KP = 0.75
P_CAP = 0.8
MOON_MAX_PENALTY = 0.5
L1_KM = 1.5e6
# Poleward edge: oval width above the equatorward edge in dipole degrees.
# Numbers chosen so Finnish places keep ~0.98 of the poleward sigmoid at Kp 0-9
# (Finland regression < 0.05). Loose rule of thumb only; polar-cap accuracy
# needs AACGM coords + Starkov/Zhang–Paxton oval (PLAN.md Phase 1b/1c).
POLE_WIDTH_BASE = 6.0
POLE_WIDTH_PER_KP = 2.0
# Platt-scaling calibration fit against IMAGE magnetometer activity
# (Sep-Nov 2024, 10 Fennoscandian stations, ~20k station-hours).
# Transform: P_cal = sigmoid(CALIB_A · logit(P_raw) + CALIB_B).
# Test-set Brier 0.142 → 0.093; climatology 0.153. See backtest/calibration.json.
# Must match web/model.js exactly (parity test).
CALIB_A = 1.9752
CALIB_B = -1.7881


def _unit(lat, lon):
    la, lo = math.radians(lat), math.radians(lon)
    return (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _frame():
    z = _unit(*GEOMAG_POLE)
    y = _cross((0, 0, 1), z)
    ny = math.sqrt(_dot(y, y))
    y = tuple(c / ny for c in y)
    return _cross(y, z), y, z


FRAME = _frame()


def to_dipole(lat, lon):
    r = _unit(lat, lon)
    x, y, z = FRAME
    return math.degrees(math.asin(_dot(r, z))), math.degrees(math.atan2(_dot(r, y), _dot(r, x)))


def from_dipole(mlat, mlon):
    """Inverse of to_dipole: dipole-frame (mlat, mlon) -> geographic (lat, lon)."""
    r = _unit(mlat, mlon)
    x, y, z = FRAME
    gx = r[0] * x[0] + r[1] * y[0] + r[2] * z[0]
    gy = r[0] * x[1] + r[1] * y[1] + r[2] * z[1]
    gz = r[0] * x[2] + r[1] * y[2] + r[2] * z[2]
    return math.degrees(math.asin(gz)), math.degrees(math.atan2(gy, gx))


def geomag_lat(lat, lon):
    # Prefer AACGM-v2 (corrected magnetic lat) when the grid is available —
    # dipole is off by 3-5° in the North Atlantic (Iceland, Greenland). Grid
    # covers 50-85°N, -80 to 35°E; outside that range we fall back to dipole.
    from .aacgm import aacgm_mlat  # local import keeps model.py standalone
    v = aacgm_mlat(lat, lon)
    return v if v is not None else to_dipole(lat, lon)[0]


def sun_coords(t):
    n = t.timestamp() / 86400 + 2440587.5 - 2451545.0
    L = (280.460 + 0.9856474 * n) % 360
    g = math.radians((357.528 + 0.9856003 * n) % 360)
    lam = math.radians(L + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g))
    eps = math.radians(23.439 - 4e-7 * n)
    ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam))
    dec = math.asin(math.sin(eps) * math.sin(lam))
    gmst = (280.46061837 + 360.98564736629 * n) % 360
    return ra, dec, gmst


def sun_alt(t, lat, lon):
    ra, dec, gmst = sun_coords(t)
    ha = math.radians(gmst + lon) - ra
    la = math.radians(lat)
    return math.degrees(math.asin(math.sin(la) * math.sin(dec) + math.cos(la) * math.cos(dec) * math.cos(ha)))


def mlt(t, lat, lon):
    ra, dec, gmst = sun_coords(t)
    _, mlon_ss = to_dipole(math.degrees(dec), math.degrees(ra) - gmst)
    _, mlon = to_dipole(lat, lon)
    return (12 + (mlon - mlon_ss) / 15) % 24


def oval_edge(kp, mlt_h):
    return EDGE0 - EDGE_SLOPE * kp + MLT_AMP * (1 - math.cos(2 * math.pi * (mlt_h - MLT_MIN) / 24))


def pole_edge(kp, mlt_h):
    return oval_edge(kp, mlt_h) + POLE_WIDTH_BASE + POLE_WIDTH_PER_KP * kp


def kp_needed(mlat, mlt_h=MLT_MIN):
    shift = MLT_AMP * (1 - math.cos(2 * math.pi * (mlt_h - MLT_MIN) / 24))
    overhead = max(0.0, (EDGE0 + shift - mlat) / EDGE_SLOPE)
    horizon = max(0.0, (EDGE0 + shift - HORIZON_MARGIN - mlat) / EDGE_SLOPE)
    return horizon, overhead


def sigmoid(x):
    return 1.0 / (1.0 + math.exp(-x))


def p_geo_raw(kp, mlat, mlt_h):
    """Geometric oval probability (pre-calibration). Equatorward sigmoid times
    poleward sigmoid for overhead; softer horizon fallback 2.5° further south.
    Capped at P_CAP."""
    w = EDGE_SLOPE * WIDTH_KP
    eq = oval_edge(kp, mlt_h)
    pole = pole_edge(kp, mlt_h)
    overhead = sigmoid((mlat - eq) / w) * sigmoid((pole - mlat) / w)
    horizon = 0.6 * sigmoid((mlat - eq + HORIZON_MARGIN) / w) * sigmoid((pole + HORIZON_MARGIN - mlat) / w)
    return P_CAP * max(overhead, horizon)


def platt(p):
    """Monotone 2-parameter calibration fitted against magnetometer activity."""
    if p <= 0.0:
        return 0.0
    if p >= 1.0:
        return 1.0
    z = math.log(p / (1 - p))
    return sigmoid(CALIB_A * z + CALIB_B)


def p_geo_from_kp(kp, mlat, mlt_h):
    return platt(p_geo_raw(kp, mlat, mlt_h))


def moon_coords(t):
    d = t.timestamp() / 86400 + 2440587.5 - 2451545.0
    r = math.radians
    L = 218.316 + 13.176396 * d
    M = r(134.963 + 13.064993 * d)
    F = r(93.272 + 13.229350 * d)
    D = r(297.850 + 12.190749 * d)
    Ms = r(357.529 + 0.98560028 * d)
    lam = (L + 6.289 * math.sin(M) - 1.274 * math.sin(M - 2 * D) + 0.658 * math.sin(2 * D)
           - 0.186 * math.sin(Ms) - 0.059 * math.sin(2 * M - 2 * D) - 0.057 * math.sin(M - 2 * D + Ms)
           + 0.053 * math.sin(M + 2 * D) + 0.046 * math.sin(2 * D - Ms) + 0.041 * math.sin(M - Ms)
           - 0.035 * math.sin(D) - 0.031 * math.sin(M + Ms) - 0.015 * math.sin(2 * F - 2 * D)
           + 0.011 * math.sin(M - 4 * D))
    beta = (5.128 * math.sin(F) + 0.280 * math.sin(M + F) + 0.277 * math.sin(M - F)
            + 0.173 * math.sin(2 * D - F) + 0.055 * math.sin(2 * D - M + F) + 0.046 * math.sin(2 * D - M - F))
    lam, beta = r(lam), r(beta)
    eps = r(23.439 - 4e-7 * d)
    ra = math.atan2(math.sin(lam) * math.cos(eps) - math.tan(beta) * math.sin(eps), math.cos(lam))
    dec = math.asin(math.sin(beta) * math.cos(eps) + math.cos(beta) * math.sin(eps) * math.sin(lam))
    return ra, dec


def moon_state(t, lat, lon):
    ra, dec = moon_coords(t)
    sra, sdec, gmst = sun_coords(t)
    ha = math.radians(gmst + lon) - ra
    la = math.radians(lat)
    alt = math.degrees(math.asin(math.sin(la) * math.sin(dec) + math.cos(la) * math.cos(dec) * math.cos(ha)))
    alt -= 0.95 * math.cos(math.radians(alt))
    cos_psi = math.sin(sdec) * math.sin(dec) + math.cos(sdec) * math.cos(dec) * math.cos(sra - ra)
    illum = (1 - cos_psi) / 2
    return alt, illum


def moon_factor(alt, illum):
    if alt <= 0:
        return 1.0
    return 1 - MOON_MAX_PENALTY * illum * min(1.0, math.sin(math.radians(alt)) / math.sin(math.radians(30)))


def darkness(alt):
    if alt <= -12:
        return 1.0
    if alt >= -6:
        return 0.0
    return (-6 - alt) / 6


def newell(v, bt, by, bz):
    th = math.atan2(by, bz)
    return v ** (4 / 3) * bt ** (2 / 3) * abs(math.sin(th / 2)) ** (8 / 3)


def haversine_km(la1, lo1, la2, lo2):
    la1, lo1, la2, lo2 = map(math.radians, (la1, lo1, la2, lo2))
    a = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def p_clear(c):
    tot, lo, mi, hi = c
    layers = [x for x in (lo, mi, None if hi is None else 0.5 * hi) if x is not None]
    if layers:
        eff = max(layers)
    elif tot is not None:
        eff = tot
    else:
        return None
    return max(0.0, 1 - eff / 100)


def verdict(p):
    if p >= 0.5:
        return "GOOD"
    if p >= 0.25:
        return "FAIR"
    if p >= 0.10:
        return "POOR"
    return "UNLIKELY"


def coupling_label(x):
    if x < 4000:
        return "weak"
    if x < 12000:
        return "moderate"
    if x < 25000:
        return "strong"
    return "very strong"


def median(xs):
    s = sorted(xs)
    k = len(s) // 2
    return s[k] if len(s) % 2 else 0.5 * (s[k - 1] + s[k])


def ovation_at(pts, lat, lon):
    """pts: iterable of (lon_deg, lat_deg, prob_percent). Returns (overhead, horizon)."""
    lon360 = lon % 360
    over = horiz = 0.0
    for plon, plat, p in pts:
        if plat < lat - 1 or plat > lat + 6:
            continue
        dist = haversine_km(lat, lon360, plat, plon)
        if dist <= 80:
            over = max(over, p)
        if plat >= lat and dist <= 500:
            horiz = max(horiz, p)
    return over, horiz


def kp_in_bin(fc, t):
    """fc: sorted list of (t0, kp, obs)."""
    for t0, kp, obs in fc:
        if t0 <= t < t0 + timedelta(hours=3):
            return kp, obs
    return None, None
