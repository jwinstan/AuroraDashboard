"""Gridded cloud forecast per country via Open-Meteo multi-location requests.

Cached on disk with a 60-min TTL. Budget math (per PLAN.md):
one country, ~400 points, refreshed hourly = ~9.6k Open-Meteo "locations" per
day, within the 10k/day non-commercial tier. We only ever fetch the active
country, never all six, so the user can switch countries without blowing the
budget.
"""
import json
import math
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from . import sources as S

CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"
TTL_SEC = 3600
TARGET_CELLS = 400  # ~0.4° × ~1.0° for FI; still well under Open-Meteo's budget
# Hi-fi personal build: 2× cells (half the step in each axis). Open-Meteo has
# a 5 000 req/hour cap and the hifi grid is ~8 batches, so even a few mis-timed
# refreshes stay well inside the budget. Hi-fi gets its own cache file + longer TTL.
TARGET_CELLS_HIFI = 800
TTL_SEC_HIFI = 3600
BATCH = 100  # Open-Meteo documents a 100-location cap per multi-request

_NICE_STEPS = [0.1, 0.2, 0.25, 0.4, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]


def _nice_step(x):
    # Round up to the nearest "nice" step so we never exceed target cell count.
    for s in _NICE_STEPS:
        if s >= x:
            return s
    return _NICE_STEPS[-1]


def grid_points(bbox, target=TARGET_CELLS):
    """Even lat/lon grid over bbox. Returns (points, lat_step, lon_step).

    Steps are rounded to nice values so cells line up on obvious parallels/meridians.
    """
    lat0, lon0, lat1, lon1 = bbox
    mean_lat_rad = math.radians((lat0 + lat1) / 2)
    cos_m = max(0.05, math.cos(mean_lat_rad))
    # Square-ish cells on the ground: lon_step = lat_step / cos(mean lat).
    # n ≈ (dlat / lat_step) * (dlon / lon_step) = (dlat * dlon * cos) / lat_step²
    lat_step_raw = math.sqrt((lat1 - lat0) * (lon1 - lon0) * cos_m / target)
    lat_step = _nice_step(lat_step_raw)
    lon_step = _nice_step(lat_step / cos_m)
    pts = []
    la = lat0
    while la <= lat1 + 1e-9:
        lo = lon0
        while lo <= lon1 + 1e-9:
            pts.append((round(la, 3), round(lo, 3)))
            lo += lon_step
        la += lat_step
    return pts, lat_step, lon_step


def _cache_path(country_code, hifi=False):
    suffix = "_hifi" if hifi else ""
    return CACHE_DIR / f"grid_{country_code}{suffix}.json"


def _fresh(path, ttl):
    return path.exists() and (time.time() - path.stat().st_mtime) < ttl


def fetch_grid(country_code, places_cfg, errors=None, force=False, hifi=False):
    cache = _cache_path(country_code, hifi=hifi)
    ttl = TTL_SEC_HIFI if hifi else TTL_SEC
    target = TARGET_CELLS_HIFI if hifi else TARGET_CELLS
    if not force and _fresh(cache, ttl):
        try:
            return json.loads(cache.read_text(encoding="utf-8")), "cache"
        except (OSError, ValueError):
            pass  # fall through to refetch

    c = places_cfg["countries"][country_code]
    bbox = c["bbox"]
    pts, lat_step, lon_step = grid_points(bbox, target=target)

    cells = [None] * len(pts)
    times = None
    any_batch_failed = False
    for i in range(0, len(pts), BATCH):
        batch = pts[i:i + BATCH]
        q = {
            "latitude": ",".join(f"{p[0]:.3f}" for p in batch),
            "longitude": ",".join(f"{p[1]:.3f}" for p in batch),
            "timezone": "UTC",
            "forecast_days": 3,
            "hourly": "cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high",
        }
        url = f"{S.OPEN_METEO}?{urllib.parse.urlencode(q)}"
        # S.fetch already retries, but give Open-Meteo a breather between big batches.
        if i > 0:
            time.sleep(0.3)
        try:
            d = S.fetch([url])
        except Exception as e:
            any_batch_failed = True
            if errors is not None:
                errors.append(f"grid batch {i}-{i + len(batch)}: {e}")
            continue
        results = d if isinstance(d, list) else [d]
        for j, r in enumerate(results):
            h = r.get("hourly") or {}
            if times is None and h.get("time"):
                times = h["time"]
            tot = h.get("cloud_cover") or []
            lo = h.get("cloud_cover_low") or []
            mi = h.get("cloud_cover_mid") or []
            hi = h.get("cloud_cover_high") or []
            n = max(len(tot), len(lo), len(mi), len(hi), 0)
            clouds = [
                [tot[k] if k < len(tot) else None,
                 lo[k] if k < len(lo) else None,
                 mi[k] if k < len(mi) else None,
                 hi[k] if k < len(hi) else None]
                for k in range(n)
            ] if n else None
            cells[i + j] = {"lat": batch[j][0], "lon": batch[j][1], "clouds": clouds}

    # Fill any gaps so the array stays index-aligned with pts.
    for i, p in enumerate(pts):
        if cells[i] is None:
            cells[i] = {"lat": p[0], "lon": p[1], "clouds": None}

    result = {
        "country": country_code,
        "bbox": bbox,
        "lat_step": lat_step,
        "lon_step": lon_step,
        "times": times or [],
        "cells": cells,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    # Only cache if every batch succeeded. A partial grid is worse than no cache
    # because it looks fine at a glance but leaves a chunk of the country blank.
    if not any_batch_failed:
        CACHE_DIR.mkdir(exist_ok=True)
        try:
            cache.write_text(json.dumps(result), encoding="utf-8")
        except OSError:
            pass
        return result, "live"

    # Partial fetch (usually HTTP 429 from Open-Meteo). Prefer any complete
    # cache we already have — stale real data beats a Swiss-cheese map. Hifi
    # callers fall back to the regular-resolution cache if their own is absent.
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8")), "partial-fallback-stale"
        except (OSError, ValueError):
            pass
    if hifi:
        regular = _cache_path(country_code, hifi=False)
        if regular.exists():
            try:
                return json.loads(regular.read_text(encoding="utf-8")), "partial-fallback-regular"
            except (OSError, ValueError):
                pass
    return result, "partial"
