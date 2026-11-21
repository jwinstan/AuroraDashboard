#!/usr/bin/env python3
"""Statistical backtest of the aurora-fi model against ground truth.

Ground truth: IMAGE magnetometer chain (FMI) — per-hour X-component range as
a proxy for auroral electrojet activity. H-component range > ~100 nT within
an hour at an auroral station is a well-established substorm / active-aurora
proxy (Davis & Sugiura 1966, many since).

Model inputs for the hindcast:
  * Kp: GFZ Potsdam archive (3-hour, observed).
  * Clouds: Open-Meteo ERA5 reanalysis (hourly, 0.25°).
  * Darkness / moon: computed locally (deterministic astronomy).
  * No solar wind: we'd need OMNI retrieved L1 values; skipped. Equivalent to
    running --cloud-source openmeteo without --rt in the forecast app, so this
    is a lower bound on model skill (the real-time wind nudge is absent).

Outputs:
  backtest/cache/*         raw downloaded data (resumable)
  backtest/predictions.csv one row per (station, hour) with model P + observed
  backtest/report.md       Brier, reliability, ROC-AUC per station

Run:
  python tools/backtest.py --start 2024-09-01 --end 2024-11-30
"""
import argparse
import csv
import gzip
import json
import math
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from aurora import model as M

CACHE = ROOT / "backtest" / "cache"
OUT = ROOT / "backtest"

# IMAGE stations: code -> (lat, lon, name). Coordinates from
# https://space.fmi.fi/image/www/?page=stations.
# Picked to span the auroral oval across Fennoscandia:
#   NUR 57 geomag (sub-auroral baseline, aurora rare)
#   HAN 59 geomag
#   OUJ 61 geomag
#   SOD 64 geomag (classic auroral)
#   PEL 63 geomag
#   KEV 66 geomag (deep auroral)
#   KIL 66 geomag
#   TRO 67 geomag
#   ABK 66 geomag
#   KIR 65 geomag
STATIONS = {
    "NUR": (60.50, 24.65, "Nurmijärvi"),
    "HAN": (62.30, 26.65, "Hankasalmi"),
    "OUJ": (64.52, 27.23, "Oulujärvi"),
    "SOD": (67.37, 26.63, "Sodankylä"),
    "PEL": (66.90, 24.08, "Pello"),
    "KEV": (69.76, 27.01, "Kevo"),
    "KIL": (69.06, 20.77, "Kilpisjärvi"),
    "TRO": (69.66, 18.94, "Tromsø"),
    "ABK": (68.35, 18.82, "Abisko"),
    "KIR": (67.84, 20.42, "Kiruna"),
}

UA = "aurora-fi-backtest/0.1 (jordanwinstanley98@gmail.com)"

# Use certifi if available — Windows Python frequently lacks a working root store.
try:
    import certifi
    SSLCTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSLCTX = ssl.create_default_context()


def _get(url, retries=3, backoff=2.0):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60, context=SSLCTX) as r:
                return r.read()
        except Exception as e:
            last = e
            time.sleep(backoff * (i + 1))
    raise last


# --------------------------------------------------------------------- IMAGE
# IMAGE caps length at 14400 min (10 days). We chunk into 10-day blocks.
CHUNK_DAYS = 10
# Missing-data sentinel in IMAGE text output. The standard convention is
# 99999.9 nT, sometimes 9999.9 appears at lower-order columns; mask anything
# with |X| > 80000 nT (true fields are 10-60k nT at these stations).
MISS_NT = 80000.0


def image_fetch(station, start, length_min):
    """Fetch one chunk of IMAGE 1-minute data. Returns the raw text."""
    cache_path = CACHE / "image" / station / f"{start:%Y%m%d}_{length_min}.txt"
    if cache_path.exists():
        return cache_path.read_text(encoding="utf-8")
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    url = (
        f"https://space.fmi.fi/image/www/data_download.php"
        f"?starttime={start:%Y%m%d}&length={length_min}&format=text"
        f"&sample_rate=60&stations={station}"
    )
    data = _get(url).decode("utf-8", errors="replace")
    cache_path.write_text(data, encoding="utf-8")
    time.sleep(0.5)  # gentle on their server
    return data


def parse_image(text):
    """Yield (utc_datetime, X_nT, Y_nT) rows. Missing values yielded as None."""
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 9:
            continue
        if not parts[0].isdigit():
            continue
        try:
            Y, M_, D, h, mi, s = (int(parts[i]) for i in range(6))
            x = float(parts[6])
            y = float(parts[7])
        except ValueError:
            continue
        t = datetime(Y, M_, D, h, mi, s, tzinfo=timezone.utc)
        if abs(x) > MISS_NT:
            yield t, None, None
        else:
            yield t, x, y


def station_hourly_activity(station, start_date, end_date):
    """For each UTC hour in [start_date, end_date], compute the per-hour range
    of X-component (max - min) in nT. Returns dict[datetime] -> range_nT or
    None if too many minute samples missing (>50%)."""
    out = {}
    cur = start_date
    while cur < end_date:
        length_min = min(CHUNK_DAYS * 1440, int((end_date - cur).total_seconds() // 60))
        txt = image_fetch(station, cur, length_min)
        # Bin to hour -> list of X values
        hourly = {}
        for t, x, _y in parse_image(txt):
            if x is None:
                continue
            hr = t.replace(minute=0, second=0, microsecond=0)
            hourly.setdefault(hr, []).append(x)
        for hr, xs in hourly.items():
            # We expect ~60 min samples; accept if >=30 present.
            if len(xs) >= 30:
                out[hr] = max(xs) - min(xs)
            else:
                out[hr] = None
        cur += timedelta(days=CHUNK_DAYS)
    return out


# --------------------------------------------------------------------- Kp
KP_URL = "https://kp.gfz.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt"


def kp_fetch():
    cache_path = CACHE / "kp.txt"
    if cache_path.exists() and (time.time() - cache_path.stat().st_mtime) < 86400 * 30:
        return cache_path.read_text(encoding="utf-8")
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    data = _get(KP_URL).decode("utf-8", errors="replace")
    cache_path.write_text(data, encoding="utf-8")
    return data


def parse_kp(text, start, end):
    """Return {datetime_utc_bin_start: kp} for every 3-hour UT bin in [start,end).
    GFZ format columns (whitespace-sep, after '#' header):
      yyyy mm dd days days_m Bsr dB Kp1..Kp8 ap1..ap8 Ap SN F10.7o F10.7a D
    Kp1 is 00-03 UT, Kp2 is 03-06 UT, ..., Kp8 is 21-24 UT.
    """
    out = {}
    for line in text.splitlines():
        if line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 23:
            continue
        try:
            y, mo, d = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            continue
        day = datetime(y, mo, d, tzinfo=timezone.utc)
        if day < start - timedelta(days=1) or day > end:
            continue
        kps = parts[7:15]  # 8 values
        for i, v in enumerate(kps):
            try:
                kp = float(v)
            except ValueError:
                continue
            if kp < 0:
                continue
            slot = day + timedelta(hours=3 * i)
            out[slot] = kp
    return out


def kp_at(kp_bins, t):
    """Nearest-preceding 3-hr Kp bin for the hour-aligned UTC time t."""
    bin_start = t.replace(hour=(t.hour // 3) * 3, minute=0, second=0, microsecond=0)
    return kp_bins.get(bin_start)


# --------------------------------------------------------------------- Clouds
def clouds_fetch(lat, lon, start, end):
    """Open-Meteo ERA5 archive. Returns {datetime_utc: (tot, lo, mid, hi)}."""
    cache_path = CACHE / "clouds" / f"{lat:.3f}_{lon:.3f}_{start:%Y%m%d}_{end:%Y%m%d}.json"
    if cache_path.exists():
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        url = (
            "https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={lat:.4f}&longitude={lon:.4f}"
            f"&start_date={start:%Y-%m-%d}&end_date={end:%Y-%m-%d}"
            "&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high"
            "&timezone=UTC"
        )
        data = json.loads(_get(url).decode("utf-8", errors="replace"))
        cache_path.write_text(json.dumps(data), encoding="utf-8")
        time.sleep(0.2)
    h = data["hourly"]
    out = {}
    for i, iso in enumerate(h["time"]):
        t = datetime.fromisoformat(iso).replace(tzinfo=timezone.utc)
        tot = h["cloud_cover"][i]
        lo = h["cloud_cover_low"][i]
        mi = h["cloud_cover_mid"][i]
        hi = h["cloud_cover_high"][i]
        out[t] = (tot, lo, mi, hi)
    return out


# --------------------------------------------------------------------- Score
def build_predictions(start, end, stations):
    kp_bins = parse_kp(kp_fetch(), start, end)
    rows = []
    for code in stations:
        lat, lon, name = STATIONS[code]
        print(f"[{code}] {name}  lat {lat:.2f} lon {lon:.2f}")
        print(f"[{code}] fetching IMAGE {start:%Y-%m-%d} .. {end:%Y-%m-%d}")
        obs = station_hourly_activity(code, start, end)
        print(f"[{code}] fetching clouds")
        cl = clouds_fetch(lat, lon, start, end)
        mlat = M.geomag_lat(lat, lon)
        print(f"[{code}] geomag_lat {mlat:.2f}")
        for hr, dx in obs.items():
            if dx is None:
                continue
            # Centre of the hour for sun / moon / MLT.
            tm = hr + timedelta(minutes=30)
            # Model: P = P_geo × darkness × moon_factor × P_clear.
            kp = kp_at(kp_bins, hr)
            if kp is None:
                continue
            m_h = M.mlt(tm, lat, lon)
            pg = M.p_geo_from_kp(kp, mlat, m_h)
            s_alt = M.sun_alt(tm, lat, lon)
            dark = M.darkness(s_alt)
            m_alt, m_ill = M.moon_state(tm, lat, lon)
            mf = M.moon_factor(m_alt, m_ill)
            cv = cl.get(hr)
            pc = M.p_clear(cv) if cv else None
            # Model's product (no solar-wind nudge in hindcast).
            full = pg * dark * mf * (pc if pc is not None else 1.0)
            # Also record the pre-cloud, pre-darkness "geomagnetic only"
            # probability: this is what the magnetometer actually reflects,
            # since the ground current doesn't care about clouds or daylight.
            geo_only = pg
            rows.append({
                "t": hr.isoformat(),
                "station": code,
                "lat": lat, "lon": lon, "mlat": round(mlat, 2),
                "kp": kp,
                "mlt": round(m_h, 2),
                "sun_alt": round(s_alt, 1),
                "dark": round(dark, 3),
                "moon_factor": round(mf, 3),
                "p_clear": round(pc, 3) if pc is not None else "",
                "p_geo": round(pg, 4),
                "p_full": round(full, 4),
                "dX_range_nT": round(dx, 1),
            })
    return rows


# --------------------------------------------------------------------- Metrics
def brier(ps, ys):
    """Brier score: mean (p - y)^2; lower is better. 0.25 = climatology for
    a 50/50 event, so 'good' depends on base rate."""
    return sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ps)


def reliability(ps, ys, nbins=10):
    """Bin predictions into deciles, return [(mean_p, observed_rate, n)]."""
    bins = [[] for _ in range(nbins)]
    for p, y in zip(ps, ys):
        idx = min(nbins - 1, int(p * nbins))
        bins[idx].append((p, y))
    out = []
    for b in bins:
        if not b:
            out.append((None, None, 0))
        else:
            mp = sum(p for p, _ in b) / len(b)
            my = sum(y for _, y in b) / len(b)
            out.append((mp, my, len(b)))
    return out


def roc_auc(ps, ys):
    """ROC-AUC via the Wilcoxon-Mann-Whitney identity:
       AUC = P(score(pos) > score(neg)). Uses mid-rank for ties."""
    paired = sorted(zip(ps, ys))
    n = len(paired)
    # Assign average ranks.
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and paired[j + 1][0] == paired[i][0]:
            j += 1
        avg = (i + j) / 2 + 1  # 1-based average rank
        for k in range(i, j + 1):
            ranks[k] = avg
        i = j + 1
    sum_ranks_pos = sum(r for r, (_, y) in zip(ranks, paired) if y == 1)
    n_pos = sum(y for _, y in paired)
    n_neg = n - n_pos
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    return (sum_ranks_pos - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


def metrics_for(rows, label_key, score_key, threshold_nT):
    ps, ys = [], []
    for r in rows:
        y = 1 if r["dX_range_nT"] >= threshold_nT else 0
        ps.append(r[score_key])
        ys.append(y)
    if not ps:
        return None
    base = sum(ys) / len(ys)
    return {
        "n": len(ps),
        "base_rate": base,
        "brier": brier(ps, ys),
        "brier_climo": base * (1 - base),  # score if we always predicted base
        "auc": roc_auc(ps, ys),
        "reliability": reliability(ps, ys, nbins=10),
    }


# --------------------------------------------------------------------- Report
def ascii_reliability(rel, width=40):
    """One line per bin: 'p=0.05  obs=0.07 ####·········· n=312'."""
    lines = []
    for mp, my, n in rel:
        if n == 0:
            lines.append("  (empty)")
            continue
        pbar = "#" * int(mp * width)
        obar = " " * int(mp * width) + "o"
        # Overlay: show both p (#) and observed (o) on a shared axis.
        axis = [" "] * (width + 2)
        pi = min(width, int(mp * width))
        oi = min(width, int(my * width))
        axis[pi] = "#"
        axis[oi] = "o" if oi != pi else "X"
        lines.append(
            f"  p={mp:4.2f}  obs={my:4.2f}  |{''.join(axis)}|  n={n:>5}"
        )
    return "\n".join(lines)


def write_report(rows, threshold_nT):
    OUT.mkdir(parents=True, exist_ok=True)
    # Per-station metrics using geo-only P (magnetometer-fair) and full P.
    stations = sorted({r["station"] for r in rows})
    md = []
    md.append("# Aurora model backtest")
    md.append("")
    md.append(f"- Rows: **{len(rows)}** station-hours after missing-data filter")
    md.append(f"- Ground truth: IMAGE 1-min X-component, hourly range ≥ **{threshold_nT} nT** = 'active'")
    md.append("- Kp from GFZ archive (3-hour, observed). Clouds from Open-Meteo ERA5.")
    md.append("")
    md.append("Two scores evaluated:")
    md.append("- `P_geo` — model's geomagnetic-only probability. Fair to compare against a magnetometer proxy (clouds / sun don't affect the ground current).")
    md.append("- `P_full` — full product (`P_geo · darkness · moon · P_clear`). This is what the UI shows.")
    md.append("")
    md.append("## Per-station skill (P_geo vs magnetic activity)")
    md.append("")
    md.append("| Station | Name | geomag_lat | n | base_rate | Brier | Brier_climo | AUC |")
    md.append("|---|---|---:|---:|---:|---:|---:|---:|")
    for code in stations:
        srows = [r for r in rows if r["station"] == code]
        if not srows:
            continue
        mlat = srows[0]["mlat"]
        m = metrics_for(srows, "dX_range_nT", "p_geo", threshold_nT)
        md.append(
            f"| {code} | {STATIONS[code][2]} | {mlat:.1f} | {m['n']} | "
            f"{m['base_rate']:.3f} | **{m['brier']:.4f}** | {m['brier_climo']:.4f} | "
            f"**{m['auc']:.3f}** |"
        )
    md.append("")
    md.append("## All-station reliability (P_geo)")
    md.append("")
    md.append("Decile bins. `#` = mean predicted P in that bin, `o` = observed activity rate. `X` = they coincide. Perfect calibration = `#` and `o` always overlap.")
    md.append("")
    md.append("```")
    m_all = metrics_for(rows, "dX_range_nT", "p_geo", threshold_nT)
    md.append(ascii_reliability(m_all["reliability"]))
    md.append("```")
    md.append("")
    md.append(f"**Overall:** N={m_all['n']}, base rate {m_all['base_rate']:.3f}, "
              f"Brier {m_all['brier']:.4f} (climo baseline {m_all['brier_climo']:.4f}), "
              f"AUC {m_all['auc']:.3f}.")
    md.append("")
    md.append("Interpretation:")
    md.append("- **AUC** > 0.5 = ordering better than chance. 0.7 is useful, 0.8+ is strong.")
    md.append("- **Brier < Brier_climo** = model beats always-predicting-the-base-rate. The gap is the skill.")
    md.append("- **Reliability**: if observed rate (`o`) is systematically higher than predicted (`#`), model is under-confident. Lower → over-confident.")
    md.append("")
    (OUT / "report.md").write_text("\n".join(md), encoding="utf-8")
    print(f"wrote {OUT / 'report.md'}")


# --------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", default="2024-09-01", help="UTC YYYY-MM-DD")
    ap.add_argument("--end", default="2024-11-30", help="UTC YYYY-MM-DD (inclusive)")
    ap.add_argument("--stations", default=",".join(STATIONS.keys()))
    ap.add_argument("--threshold", type=float, default=100.0,
                    help="Hourly X-range (nT) above which the hour counts as auroral-active.")
    ap.add_argument("--skip-fetch", action="store_true",
                    help="Fail instead of hitting the network (useful for re-runs).")
    a = ap.parse_args()
    start = datetime.fromisoformat(a.start).replace(tzinfo=timezone.utc)
    end = datetime.fromisoformat(a.end).replace(tzinfo=timezone.utc) + timedelta(days=1)
    stations = [s.strip().upper() for s in a.stations.split(",") if s.strip()]
    for s in stations:
        if s not in STATIONS:
            sys.exit(f"unknown station {s}; known: {sorted(STATIONS)}")
    rows = build_predictions(start, end, stations)
    if not rows:
        sys.exit("no rows — nothing to score")
    OUT.mkdir(parents=True, exist_ok=True)
    # CSV
    csv_path = OUT / "predictions.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {csv_path} ({len(rows)} rows)")
    write_report(rows, a.threshold)


if __name__ == "__main__":
    main()
