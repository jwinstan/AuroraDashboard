#!/usr/bin/env python3
"""Aurora chance estimator for Finland.

CLI prints an hourly table for a place. `--serve` runs the browser dashboard
locally together with a JSON proxy that bypasses CORS for the data APIs.

Usage:
    python aurora_fi.py                 # Rovaniemi
    python aurora_fi.py oulu
    python aurora_fi.py --lat 60.2 --lon 24.9 --hours 48
    python aurora_fi.py --serve         # dashboard at http://127.0.0.1:8765/
    python aurora_fi.py --list
"""
import argparse
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from aurora import model as M
from aurora import sources as S
from aurora import places as P
from aurora import grid as G

# re-exports so existing tests that do `import aurora_fi as A` keep working
geomag_lat = M.geomag_lat
mlt = M.mlt
sun_alt = M.sun_alt
moon_state = M.moon_state
moon_factor = M.moon_factor
darkness = M.darkness
p_clear = M.p_clear
p_geo_from_kp = M.p_geo_from_kp
kp_needed = M.kp_needed
kp_in_bin = M.kp_in_bin
median = M.median
verdict = M.verdict
coupling_label = M.coupling_label
MOON_MAX_PENALTY = M.MOON_MAX_PENALTY
P_CAP = M.P_CAP
rows = S.rows
active = S.active
ptime = S.ptime
fetch = S.fetch  # tests can monkey-patch aurora_fi.fetch; _sync_fetch() propagates it


PLACES_CFG = P.load()
PLACES_FLAT = P.flat_places(PLACES_CFG)
# {key: (lat, lon)} so existing tests that iterate PLACES see the same shape
PLACES = {k: (lat, lon) for k, (_name, lat, lon, _cc, _tz) in PLACES_FLAT.items()}
# Default TZ kept for back-compat (existing tests import this). Per-place TZ
# comes from PLACES_FLAT[k][4] inside main().
TZ = ZoneInfo(PLACES_CFG["countries"]["FI"]["tz"])


# ---------- data product wrappers (same names as before) ----------

def _sync_fetch():
    """Propagate monkey-patches of aurora_fi.fetch into the sources module."""
    S.fetch = fetch


def solar_wind(window_min=30):
    _sync_fetch()
    return S.solar_wind(window_min)


def kp_forecast():
    _sync_fetch()
    return S.kp_forecast()


def kp_now():
    _sync_fetch()
    return S.kp_now()


def ovation(lat, lon):
    _sync_fetch()
    pts, time = S.ovation_points()
    over, horiz = M.ovation_at(pts, lat, lon)
    return over, horiz, time


def swpc_alerts():
    _sync_fetch()
    return S.swpc_alerts()


def donki_cmes():
    _sync_fetch()
    return S.donki_cmes()


def clouds(lat, lon, source="auto", model=None, errors=None):
    _sync_fetch()
    return S.clouds(lat, lon, source, model, errors)


# ---------- serving ----------

PROXY_HOSTS = {
    "services.swpc.noaa.gov", "api.open-meteo.com", "api.met.no",
    "kauai.ccmc.gsfc.nasa.gov", "api.nasa.gov",
    # Hi-fi image feeds:
    "sdo.gsfc.nasa.gov", "stereo-ssc.nascom.nasa.gov", "stereo.gsfc.nasa.gov",
}

# Per-host proxy cache TTL (seconds). Keeps page loads fast and avoids burning
# NASA API quota on every refresh. Only the response body + status are cached.
_PROXY_CACHE_TTL = {
    "api.nasa.gov": 900,                   # DONKI: 15 min
    "kauai.ccmc.gsfc.nasa.gov": 900,       # DONKI mirror: 15 min
    "services.swpc.noaa.gov": 60,          # SWPC alerts etc.: 1 min
    "sdo.gsfc.nasa.gov": 300,              # Solar imagery: 5 min (SDO updates ~every 12 min)
    "stereo-ssc.nascom.nasa.gov": 1800,    # STEREO HI: 30 min
    "stereo.gsfc.nasa.gov": 1800,
}
_PROXY_CACHE: dict = {}  # cache_key -> (expires_at_epoch, status_code, body_bytes)

_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}


def serve(port, open_path="/"):
    import http.server
    import json
    import os
    import urllib.parse
    import urllib.request
    import webbrowser

    root = os.path.dirname(os.path.abspath(__file__))
    web_dir = os.path.join(root, "web")
    config_dir = os.path.join(root, "config")

    def _resolve(path):
        # Routes:
        #   /            -> web/pro.html   (dev loop, includes map)
        #   /lite        -> web/index.html (emailable lightweight view)
        #   /config/*    -> config/
        #   everything else -> web/
        clean = path.lstrip("/").split("?", 1)[0]
        if clean in ("", "index.html"):
            return os.path.join(web_dir, "pro.html")
        if clean in ("lite", "lite.html"):
            return os.path.join(web_dir, "index.html")
        if clean in ("hifi", "hifi.html"):
            return os.path.join(web_dir, "hifi.html")
        if clean.startswith("config/"):
            base, rel = config_dir, clean[len("config/"):]
        else:
            base, rel = web_dir, clean
        full = os.path.normpath(os.path.join(base, rel))
        if not full.startswith(base):
            return None  # path traversal
        return full

    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, code, body, ctype):
            try:
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                # Client disconnected before we finished writing. Nothing to do.
                pass

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if u.path == "/grid":
                q = urllib.parse.parse_qs(u.query)
                cc = (q.get("country", [""])[0] or "FI").upper()
                if cc not in PLACES_CFG["countries"]:
                    self._send(400, f"unknown country {cc}".encode(), "text/plain")
                    return
                force = q.get("force", ["0"])[0] == "1"
                hifi = q.get("hifi", ["0"])[0] == "1"
                _sync_fetch()
                try:
                    data, origin = G.fetch_grid(cc, PLACES_CFG, force=force, hifi=hifi)
                    self._send(200, json.dumps(data).encode("utf-8"),
                               f"application/json; charset=utf-8")
                    sys.stderr.write(f"[grid] {cc}{'-hifi' if hifi else ''} {origin} cells={len(data.get('cells', []))}\n")
                except Exception as e:
                    self._send(502, str(e).encode(), "text/plain")
                return
            if u.path == "/proxy":
                target = urllib.parse.parse_qs(u.query).get("u", [""])[0]
                parsed = urllib.parse.urlparse(target)
                if parsed.hostname not in PROXY_HOSTS:
                    self._send(403, b"host not allowed", "text/plain")
                    return
                # Inject NASA_API_KEY server-side so it never reaches the browser.
                if parsed.hostname == "api.nasa.gov":
                    q = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
                    env_key = os.environ.get("NASA_API_KEY")
                    if env_key and q.get("api_key") in (None, "", "DEMO_KEY"):
                        q["api_key"] = env_key
                        target = urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(q)))
                # Serve from in-process cache when fresh. Key on the final URL so
                # NASA_API_KEY changes invalidate automatically.
                import time
                cache_key = target
                ttl = _PROXY_CACHE_TTL.get(parsed.hostname, 0)
                hit = _PROXY_CACHE.get(cache_key)
                if ttl and hit and hit[0] > time.time():
                    _, code, body = hit
                    self._send(code, body, "application/json" if code < 400 else "text/plain")
                    return
                # kauai hangs on Windows TLS — fail fast rather than blocking for 30 s.
                timeout_s = 6 if parsed.hostname == "kauai.ccmc.gsfc.nasa.gov" else 20
                try:
                    req = urllib.request.Request(target, headers={"User-Agent": "aurora-fi/1.3 (personal aurora dashboard)"})
                    with urllib.request.urlopen(req, timeout=timeout_s) as r:
                        body = r.read()
                        # Pass through the upstream Content-Type so images stay images.
                        ctype = r.headers.get("Content-Type") or "application/octet-stream"
                        if ttl:
                            _PROXY_CACHE[cache_key] = (time.time() + ttl, 200, body)
                        self._send(200, body, ctype)
                except urllib.error.HTTPError as e:
                    body = e.read() or str(e).encode()
                    if ttl and e.code == 429:
                        _PROXY_CACHE[cache_key] = (time.time() + min(ttl, 60), 429, body)
                    self._send(e.code, body, "text/plain")
                except Exception as e:
                    self._send(502, str(e).encode(), "text/plain")
                return
            full = _resolve(u.path)
            if not full or not os.path.isfile(full):
                self._send(404, f"not found: {u.path}".encode(), "text/plain")
                return
            ext = os.path.splitext(full)[1].lower()
            try:
                with open(full, "rb") as f:
                    self._send(200, f.read(), _MIME.get(ext, "application/octet-stream"))
            except OSError as e:
                self._send(500, str(e).encode(), "text/plain")

        def log_message(self, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
    url = f"http://127.0.0.1:{port}{open_path if open_path.startswith('/') else '/' + open_path}"
    print(f"Dashboard at {url}  (Ctrl+C to stop)")
    webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def safe(fn, *a, errors, name):
    try:
        return fn(*a)
    except Exception as e:
        errors.append(f"{name}: {e}")
        return None


def main():
    countries = sorted(PLACES_CFG["countries"].keys())
    ap = argparse.ArgumentParser(description="Aurora chances in the Nordics, Iceland and Greenland")
    ap.add_argument("place", nargs="?", default="rovaniemi")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--country", choices=countries, help="filter --list and validate place")
    ap.add_argument("--hours", type=int, default=36)
    ap.add_argument("--all", action="store_true", help="show daylight hours too")
    ap.add_argument("--cloud-model", help="Open-Meteo model, e.g. metno_nordic, ecmwf_ifs025")
    ap.add_argument("--cloud-source", choices=["auto", "openmeteo", "metno"], default="auto")
    ap.add_argument("--kp-raw", action="store_true", help="print raw Kp forecast bins")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--serve", action="store_true", help="serve the dashboard locally")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--open", dest="open_path", default="/", help="path to open in the browser when --serve starts (e.g. /hifi, /lite)")
    a = ap.parse_args()

    if a.serve:
        serve(a.port, a.open_path)
        return

    if a.list:
        for cc in countries:
            if a.country and cc != a.country:
                continue
            c = PLACES_CFG["countries"][cc]
            print(f"\n{cc}  {c['name']}  (tz {c['tz']})")
            for k, p in c["places"].items():
                print(f"  {k:18s} {p['lat']:6.2f}N {p['lon']:7.2f}E  geomag {geomag_lat(p['lat'], p['lon']):5.1f}")
        return

    tz = TZ
    if a.lat is not None and a.lon is not None:
        lat, lon, name = a.lat, a.lon, f"{a.lat:.2f}N {a.lon:.2f}E"
    else:
        key = a.place.lower().replace("ä", "a").replace("ö", "o").replace("ø", "o").replace("å", "a").replace("þ", "th").replace("ð", "d")
        if key not in PLACES_FLAT:
            sys.exit(f"Unknown place '{a.place}'. Use --list or --lat/--lon.")
        pname, lat, lon, cc, ptz = PLACES_FLAT[key]
        if a.country and cc != a.country:
            sys.exit(f"Place '{a.place}' is in {cc}, not {a.country}.")
        name = pname
        tz = ZoneInfo(ptz)

    mlat = geomag_lat(lat, lon)
    kh, ko = kp_needed(mlat)
    errors = []
    now = datetime.now(timezone.utc)

    sw = safe(solar_wind, errors=errors, name="L1 solar wind")
    fc = safe(kp_forecast, errors=errors, name="Kp forecast") or []
    kn = safe(kp_now, errors=errors, name="Kp nowcast")
    ov = safe(ovation, lat, lon, errors=errors, name="OVATION")
    alerts = safe(swpc_alerts, errors=errors, name="SWPC alerts") or []
    cmes = safe(donki_cmes, errors=errors, name="DONKI CMEs") or []
    cl, cl_src = clouds(lat, lon, a.cloud_source, a.cloud_model, errors)

    if a.kp_raw and fc:
        print("\nRaw Kp forecast bins (UT):")
        for t0, kp, obs in fc:
            if now - timedelta(days=1) <= t0 <= now + timedelta(days=3):
                print(f"  {t0:%Y-%m-%d %H:%M}  {kp:4.2f}  {obs}")

    loc = now.astimezone(tz)
    print(f"\nAurora outlook: {name} ({lat:.2f}N, {lon:.2f}E), geomag lat ~{mlat:.1f}")
    print(f"Kp needed near magnetic midnight: ~{kh:.1f} low on northern horizon, ~{ko:.1f} overhead")
    print(f"Now: {loc:%a %d %b %H:%M %Z} ({now:%H:%M} UT), MLT {mlt(now, lat, lon):.1f}, "
          f"sun {sun_alt(now, lat, lon):+.0f} deg")
    m_alt, m_ill = moon_state(now, lat, lon)
    print(f"Moon: {100 * m_ill:.0f}% lit, {m_alt:+.0f} deg")
    print(f"Clouds: {cl_src or 'unavailable'}\n")

    if alerts or cmes:
        print("Active events:")
        for al in alerts[-5:]:
            age_h = (now - al["time"]).total_seconds() / 3600
            summary = al["summary"][:90]
            print(f"  {al['kind']:8s} {al['code']:8s}  issued {age_h:4.1f} h ago  {summary}")
        for c in cmes:
            rel_h = (c["arrival"] - now).total_seconds() / 3600
            when = f"in {rel_h:+.1f} h" if rel_h >= 0 else f"{-rel_h:.1f} h ago"
            arr_loc = c["arrival"].astimezone(tz)
            ar = f" AR{c['ar']}" if c["ar"] else ""
            speed = f"{c['speed']:.0f} km/s" if c["speed"] else "v=?"
            runs = f"{c['n_runs']} Enlil runs" if c['n_runs'] > 1 else "climatological"
            print(f"  CME                 launched {c['launch']:%d %b %H:%M} UT  "
                  f"src {c['source']}{ar}, {speed}")
            print(f"                      arrival {arr_loc:%a %H:%M %Z} "
                  f"(±{c['arrival_err_h']:.0f} h, {runs}), {when}")
        print()

    alert = None
    if sw:
        stale = f"  ** STALE: {sw['age_min']:.0f} min old **" if sw["age_min"] > 15 else ""
        print(f"L1 solar wind [{sw['source']}], last 30 min, {sw['age_min']:.0f} min old{stale}")
        print(f"  Bz {sw['bz_mean']:+.1f} nT mean (min {sw['bz_min']:+.1f}, {100 * sw['frac_south']:.0f}% southward), "
              f"Bt {sw['bt']:.1f} nT, v {sw['v']:.0f} km/s, n {sw['n']:.1f} /cc")
        print(f"  Coupling: {coupling_label(sw['newell'])} (Newell {sw['newell']:.0f}); "
              f"this plasma reaches Earth in ~{sw['delay_min']:.0f} min")
        if sw["bz_mean"] < -8 or sw["newell"] > 20000:
            alert = "STRONG driving: activity likely to intensify soon. Check now if dark and clear."
        elif sw["bz_mean"] < -3 and sw["frac_south"] > 0.6:
            alert = "Favourable: sustained southward Bz, substorm possible within ~1 h."
        elif sw["frac_south"] < 0.3:
            alert = "Bz mostly northward: quiet for now."
    if kn:
        print(f"Estimated Kp now: {kn[0]:.2f}")
    if ov:
        print(f"OVATION (valid {ov[2]}): {ov[0]:.0f}% overhead, {ov[1]:.0f}% max within 500 km north")
    if alert:
        print(f"\n>> {alert}")

    print(f"\n{'Local':>11} {'UT':>5} {'MLT':>4}  {'Kp':>5} {'Geo':>4}  {'Cloud L/M/H':>12} {'Clear':>5}  {'Sun':>4} {'Moon':>8}  {'Chance':>6}")
    t0 = now.replace(minute=0, second=0, microsecond=0)
    best, shown = [], 0
    for i in range(a.hours + 1):
        t = t0 + timedelta(hours=i)
        tm = t + timedelta(minutes=30)
        alt = sun_alt(tm, lat, lon)
        dark = darkness(alt)
        if dark == 0 and not a.all:
            continue
        kp, obs = kp_in_bin(fc, tm)
        if kn and tm - now < timedelta(hours=2):
            kp = max(kp or 0, kn[0])
        m = mlt(tm, lat, lon)
        pg = p_geo_from_kp(kp, mlat, m) if kp is not None else None
        if ov and tm - now < timedelta(hours=1.5):
            po = max(ov[0], 0.5 * ov[1]) / 100
            pg = max(pg or 0, min(po, P_CAP))
        c = cl.get(t)
        pc = p_clear(c) if c else None
        malt, mill = moon_state(tm, lat, lon)
        mf = moon_factor(malt, mill)
        if pg is None:
            score = None
        else:
            score = pg * dark * mf * (pc if pc is not None else 1.0)
        ctxt = "/".join("?" if x is None else f"{x:.0f}" for x in c[1:]) if c else "n/a"
        ptxt = f"{100 * pc:4.0f}%" if pc is not None else "  n/a"
        stxt = f"{100 * score:3.0f}% {verdict(score)}" if score is not None else "n/a"
        mtxt = f"{100 * mill:3.0f}%{malt:+4.0f}" if malt > 0 else "  down"
        tag = {"observed": "o", "estimated": "e", "predicted": "p"}.get(obs or "", " ")
        ktxt = f"{kp:4.2f}{tag}" if kp is not None else "  n/a"
        gtxt = f"{pg:4.2f}" if pg is not None else " n/a"
        print(f"{t.astimezone(tz):%a %H:%M} {t:%H:%M} {m:4.1f}  {ktxt} {gtxt}  {ctxt:>12} {ptxt}  {alt:+4.0f} {mtxt:>8}  {stxt}")
        shown += 1
        if score is not None:
            best.append((score, t))

    if not shown:
        print("  (no dark hours in window; try --hours 48)")

    print()
    if best:
        best.sort(key=lambda x: x[1])
        i_top = max(range(len(best)), key=lambda i: best[i][0])
        top, tt = best[i_top]
        thr = 0.7 * top
        lo = hi = i_top
        while lo > 0 and best[lo - 1][0] >= thr and best[lo][1] - best[lo - 1][1] == timedelta(hours=1):
            lo -= 1
        while hi < len(best) - 1 and best[hi + 1][0] >= thr and best[hi + 1][1] - best[hi][1] == timedelta(hours=1):
            hi += 1
        print(f"Overall: {verdict(top)} (best {100 * top:.0f}% at {tt.astimezone(tz):%a %H:%M} local)")
        if top >= 0.05:
            print(f"Best window: {best[lo][1].astimezone(tz):%a %H:%M} to "
                  f"{(best[hi][1] + timedelta(hours=1)).astimezone(tz):%a %H:%M} local")
        if not cl:
            print("(No cloud data: chances are geomagnetic only.)")
    else:
        print("Not enough data to score.")

    if errors:
        print("\nData problems:")
        for e in errors:
            print(f"  - {e}")
    print("\nKp tag: o=observed e=estimated p=predicted. Geo = chance the oval is overhead/near (capped).")
    print("Moon = illuminated fraction and altitude; a bright high moon cuts the chance by up to "
          f"{100 * MOON_MAX_PENALTY:.0f}%.")
    print("Heuristic only. Kp beyond ~24 h is low-skill; substorms can beat the forecast.\n")


if __name__ == "__main__":
    main()
