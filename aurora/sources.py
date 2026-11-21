"""Data fetchers: NOAA SWPC, Open-Meteo, MET Norway, NASA DONKI. Stdlib only."""
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from .model import median, newell

SWPC = "https://services.swpc.noaa.gov"
DONKI_CCMC = "https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get"
DONKI_NASA = "https://api.nasa.gov/DONKI"
NASA_API_KEY = os.environ.get("NASA_API_KEY", "DEMO_KEY")
URLS = {
    "mag": [f"{SWPC}/json/rtsw/rtsw_mag_1m.json", f"{SWPC}/products/solar-wind/mag-1-day.json"],
    "wind": [f"{SWPC}/json/rtsw/rtsw_wind_1m.json", f"{SWPC}/products/solar-wind/plasma-1-day.json"],
    "kp_fc": [f"{SWPC}/products/noaa-planetary-k-index-forecast.json"],
    "kp_now": [f"{SWPC}/json/planetary_k_index_1m.json"],
    "ovation": [f"{SWPC}/json/ovation_aurora_latest.json"],
    "alerts": [f"{SWPC}/products/alerts.json"],
}
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
METNO = "https://api.met.no/weatherapi/locationforecast/2.0/complete"
L1_KM = 1.5e6
CME_CLIMATOLOGICAL_HALFWIDTH_H = 8.0  # fallback arrival-time ±, when only one Enlil run


def fetch(urls, timeout=30, retries=2):
    err = None
    for u in urls:
        for _ in range(retries):
            try:
                req = urllib.request.Request(u, headers={"User-Agent": "aurora-fi/1.3 (personal aurora script)"})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.load(r)
            except Exception as e:
                err = e
    raise RuntimeError(f"{urls[0]} -> {err}")


def rows(data):
    if not data:
        return []
    if isinstance(data[0], list):
        hdr = data[0]
        return [dict(zip(hdr, r)) for r in data[1:]]
    return list(data)


def active(rs):
    if any("active" in r for r in rs):
        a = [r for r in rs if r.get("active") in (True, 1, "true", "True")]
        return a or rs
    return rs


def num(d, *keys):
    for k in keys:
        v = d.get(k)
        if v in (None, ""):
            continue
        try:
            return float(v)
        except (TypeError, ValueError):
            pass
    return None


def ptime(s):
    s = str(s).strip().replace("Z", "").replace("T", " ").split(".")[0].split("+")[0]
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    raise ValueError(f"bad time: {s}")


def solar_wind(window_min=30):
    mag = active(rows(fetch(URLS["mag"])))
    wind = active(rows(fetch(URLS["wind"])))

    def series(rs, spec):
        out = []
        for r in rs:
            try:
                t = ptime(r.get("time_tag"))
            except ValueError:
                continue
            vals = [num(r, *k) for k in spec]
            if all(v is not None for v in vals):
                out.append((t, *vals))
        out.sort()
        if not out:
            return out
        t_last = out[-1][0]
        return [x for x in out if t_last - x[0] <= timedelta(minutes=window_min)]

    m = series(mag, [("bz_gsm",), ("by_gsm",), ("bt",)])
    w = series(wind, [("proton_speed", "speed"), ("proton_density", "density")])
    if not m or not w:
        raise RuntimeError("no valid L1 samples")

    v = median([x[1] for x in w])
    n = median([x[2] for x in w])
    bz = [x[1] for x in m]
    now = datetime.now(timezone.utc)
    src = next((r.get("source") for r in reversed(mag) if r.get("source")), "L1")
    return {
        "source": src,
        "age_min": (now - max(m[-1][0], w[-1][0])).total_seconds() / 60,
        "bz_mean": sum(bz) / len(bz),
        "bz_min": min(bz),
        "frac_south": sum(b < 0 for b in bz) / len(bz),
        "bt": sum(x[3] for x in m) / len(m),
        "v": v,
        "n": n,
        "newell": sum(newell(v, x[3], x[2], x[1]) for x in m) / len(m),
        "delay_min": L1_KM / v / 60,
    }


def kp_forecast():
    out = []
    for r in rows(fetch(URLS["kp_fc"])):
        kp = num(r, "kp", "Kp")
        if kp is None:
            continue
        try:
            out.append((ptime(r["time_tag"]), kp, str(r.get("observed", ""))))
        except (KeyError, ValueError):
            pass
    return sorted(out)


def kp_now():
    rs = rows(fetch(URLS["kp_now"]))
    for r in reversed(rs):
        k = num(r, "estimated_kp", "kp_index")
        if k is not None:
            return k, ptime(r["time_tag"])
    raise RuntimeError("no Kp nowcast")


def ovation_points():
    d = fetch(URLS["ovation"])
    return d["coordinates"], d.get("Forecast Time")


_ALERT_KINDS = {"ALT": "ALERT", "WAT": "WATCH", "WAR": "WARNING", "EXT": "EXTENDED", "SUM": "SUMMARY"}
_ALERT_HEADLINE_PREFIXES = ("ALERT:", "WATCH:", "WARNING:", "EXTENDED WARNING:", "SUMMARY:",
                            "CONTINUED ALERT:", "CANCEL WARNING:")


def _parse_alert_message(msg):
    """Return (kind, headline) by scanning the message body.

    SWPC alerts carry 'Space Weather Message Code: <KIND><TYPE><LEVEL>' at the top;
    the headline line starts with one of ALERT:/WARNING:/WATCH:/SUMMARY:/EXTENDED WARNING:
    """
    kind = None
    headline = ""
    for line in msg.splitlines():
        s = line.strip()
        if not s:
            continue
        if kind is None and s.startswith("Space Weather Message Code:"):
            code = s.split(":", 1)[1].strip()
            kind = _ALERT_KINDS.get(code[:3].upper())
            continue
        if not headline and any(s.startswith(p) for p in _ALERT_HEADLINE_PREFIXES):
            headline = s
            if kind is not None:
                break
    return kind, headline


def swpc_alerts(hours_back=48, skip_kinds=("SUMMARY",)):
    """Recent SWPC alerts / watches / warnings."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours_back)
    out = []
    for r in rows(fetch(URLS["alerts"])):
        try:
            t = ptime(r["issue_datetime"])
        except (KeyError, ValueError):
            continue
        if t < cutoff:
            continue
        kind, headline = _parse_alert_message(str(r.get("message") or ""))
        if kind is None or kind in skip_kinds:
            continue
        out.append({
            "time": t,
            "code": str(r.get("product_id") or "").strip(),
            "kind": kind,
            "summary": headline,
        })
    out.sort(key=lambda x: x["time"])
    return out


def _cme_pick_analysis(analyses):
    for a in analyses:
        if a.get("isMostAccurate"):
            return a
    return analyses[-1] if analyses else None


def _enlil_arrivals(enlil_list):
    out = []
    for e in enlil_list or []:
        s = e.get("estimatedShockArrivalTime")
        if not s:
            continue
        try:
            out.append(ptime(s))
        except ValueError:
            pass
    return sorted(out)


def _arrival_centre_halfwidth(times):
    mid = times[len(times) // 2]
    if len(times) == 1:
        return mid, CME_CLIMATOLOGICAL_HALFWIDTH_H
    span_h = (times[-1] - times[0]).total_seconds() / 3600
    return mid, max(span_h / 2, 4.0)


def donki_cmes(days_back=4, window_before_h=12, window_after_h=72):
    """Earth-directed CMEs with predicted arrival inside the window.

    Error bar comes from the spread of Enlil runs in the most-accurate analysis;
    if only one run is published, falls back to CME_CLIMATOLOGICAL_HALFWIDTH_H.
    """
    now = datetime.now(timezone.utc)
    end = now.date() + timedelta(days=1)
    start = end - timedelta(days=days_back + 1)
    qs = f"startDate={start.isoformat()}&endDate={end.isoformat()}"
    data = fetch([
        f"{DONKI_CCMC}/CME?{qs}",
        f"{DONKI_NASA}/CME?{qs}&api_key={NASA_API_KEY}",
    ])
    out = []
    for cme in data or []:
        analysis = _cme_pick_analysis(cme.get("cmeAnalyses") or [])
        if analysis is None:
            continue
        arrivals = _enlil_arrivals(analysis.get("enlilList"))
        if not arrivals:
            continue
        mid, half_h = _arrival_centre_halfwidth(arrivals)
        if not (now - timedelta(hours=window_before_h) <= mid <= now + timedelta(hours=window_after_h)):
            continue
        try:
            launch = ptime(cme["startTime"])
        except (KeyError, ValueError):
            continue
        out.append({
            "launch": launch,
            "source": (cme.get("sourceLocation") or "").strip() or "?",
            "ar": cme.get("activeRegionNum"),
            "speed": analysis.get("speed"),
            "half_angle": analysis.get("halfAngle"),
            "type": analysis.get("type"),
            "note": (cme.get("note") or "").strip(),
            "arrival": mid,
            "arrival_err_h": half_h,
            "n_runs": len(arrivals),
        })
    out.sort(key=lambda c: c["arrival"])
    return out


def clouds_openmeteo(lat, lon, model=None):
    q = {
        "latitude": lat, "longitude": lon, "timezone": "UTC", "forecast_days": 3,
        "hourly": "cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high",
    }
    if model:
        q["models"] = model
    h = fetch([f"{OPEN_METEO}?{urllib.parse.urlencode(q)}"])["hourly"]
    out = {}
    for i, ts in enumerate(h["time"]):
        t = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
        out[t] = tuple(h.get(k, [None] * len(h["time"]))[i]
                       for k in ("cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"))
    return out


def clouds_metno(lat, lon):
    d = fetch([f"{METNO}?lat={lat:.4f}&lon={lon:.4f}"])
    out = {}
    for e in d["properties"]["timeseries"]:
        det = e["data"]["instant"]["details"]
        out[ptime(e["time"])] = tuple(det.get(k) for k in (
            "cloud_area_fraction", "cloud_area_fraction_low",
            "cloud_area_fraction_medium", "cloud_area_fraction_high"))
    return out


def clouds(lat, lon, source="auto", model=None, errors=None):
    order = {"auto": ["openmeteo", "metno"], "openmeteo": ["openmeteo"], "metno": ["metno"]}[source]
    for src in order:
        try:
            data = clouds_openmeteo(lat, lon, model) if src == "openmeteo" else clouds_metno(lat, lon)
            if data:
                return data, src
        except Exception as e:
            if errors is not None:
                errors.append(f"Clouds ({src}): {e}")
    return {}, None
