"""Build the static site served by GitHub Pages.

Assembles ``build/`` from ``web/`` + ``config/``, renames ``hifi.html`` to
``index.html``, and pre-generates ``build/grid/<CC>.json`` for every country
so the pro map works without a backend and without hammering Open-Meteo from
every visitor's browser.

Run from the repo root:
    python tools/build_static.py
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from aurora import grid as G  # noqa: E402
from aurora import places as P  # noqa: E402

# The hourly deploy workflow re-runs this script every hour. Extend grid.py's
# default 1 h TTL so the cron builds mostly serve from cache and spend their
# Open-Meteo budget on the countries whose previous fetch failed.
G.TTL_SEC = int(os.environ.get("BUILD_STATIC_GRID_TTL", "14400"))  # 4 h


BUILD = ROOT / "build"
WEB = ROOT / "web"
CONFIG = ROOT / "config"


def copy_tree(src: Path, dst: Path) -> None:
    shutil.copytree(src, dst, dirs_exist_ok=True)


def rmtree_retry(path: Path, attempts: int = 5) -> None:
    """``shutil.rmtree`` with retries. OneDrive on Windows briefly locks files
    after sync, so a naive rmtree hits ``PermissionError`` on local dev builds."""
    def on_error(func, p, exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except Exception:
            pass
    for i in range(attempts):
        try:
            shutil.rmtree(path, onerror=on_error)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.5 * (i + 1))


def main() -> int:
    if BUILD.exists():
        rmtree_retry(BUILD)
    BUILD.mkdir()

    copy_tree(WEB, BUILD)
    copy_tree(CONFIG, BUILD / "config")

    hifi = BUILD / "hifi.html"
    index = BUILD / "index.html"
    if index.exists():
        index.unlink()
    hifi.rename(index)

    # Mark this build as a static (no-backend) deploy. Client-side code checks
    # for this meta tag before trying to use the --serve proxy; without it,
    # loading the built site from 127.0.0.1 (for local testing) would hit a
    # non-existent /proxy and fail on SDO images, etc.
    text = index.read_text(encoding="utf-8")
    marker = '<meta name="aurora-static-deploy" content="true">'
    if marker not in text:
        text = text.replace("<head>", f"<head>\n  {marker}", 1)
        index.write_text(text, encoding="utf-8")

    places_cfg = P.load()
    grid_dir = BUILD / "grid"
    grid_dir.mkdir(exist_ok=True)

    # Open-Meteo throttles ~600 calls/min per IP. Each batched request with N
    # locations counts as N calls, so six countries worth of grid batches fired
    # back-to-back blows past the burst limit and later countries get 429'd into
    # empty grids. A 60 s pause between countries keeps us comfortably under.
    # The first country runs immediately; skip the delay on the first iteration.
    INTER_COUNTRY_SLEEP_S = int(os.environ.get("BUILD_STATIC_INTER_COUNTRY_SLEEP", "60"))

    errors: list[str] = []
    for i, cc in enumerate(places_cfg["countries"]):
        if i > 0 and INTER_COUNTRY_SLEEP_S > 0:
            print(f"[grid] sleeping {INTER_COUNTRY_SLEEP_S}s before next country...", flush=True)
            time.sleep(INTER_COUNTRY_SLEEP_S)
        print(f"[grid] {cc} ...", flush=True)
        try:
            data, origin = G.fetch_grid(cc, places_cfg, errors=errors, force=False)
            out = grid_dir / f"{cc}.json"
            out.write_text(json.dumps(data), encoding="utf-8")
            print(f"[grid] {cc} {origin} cells={len(data.get('cells', []))} -> {out.relative_to(ROOT)}")
        except Exception as e:
            print(f"[grid] {cc} FAILED: {e}", file=sys.stderr)
            errors.append(f"{cc}: {e}")

    # Pre-bake DONKI CMEs with the deploy's NASA_API_KEY so visitors don't share
    # the 30 req/hour DEMO_KEY bucket. Non-fatal: the browser still falls back
    # to the live endpoint if this file is absent.
    fetch_donki_cmes(BUILD, errors)

    if errors:
        print("\nBuild finished with errors:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)

    print(f"\nStatic site built at {BUILD.relative_to(ROOT)}/")
    return 0


def fetch_donki_cmes(build: Path, errors: list[str]) -> None:
    key = os.environ.get("NASA_API_KEY")
    if not key:
        print("[donki] NASA_API_KEY not set — skipping CME pre-fetch (browser will use DEMO_KEY)")
        return
    # Match sources.js: 4 days back to 1 day ahead. Widen by a day either side
    # so the file stays valid as the browser's window drifts across UTC midnight.
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=5)
    end = today + timedelta(days=2)
    qs = f"startDate={start.isoformat()}&endDate={end.isoformat()}&api_key={key}"
    url = f"https://api.nasa.gov/DONKI/CME?{qs}"
    print(f"[donki] fetching CMEs {start} to {end} ...", flush=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "aurora-fi-build/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
        # Validate it's JSON before writing so we don't ship a 429 HTML page.
        data = json.loads(body)
        out_dir = build / "donki"
        out_dir.mkdir(exist_ok=True)
        (out_dir / "cmes.json").write_bytes(body)
        (out_dir / "meta.json").write_text(json.dumps({
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "count": len(data) if isinstance(data, list) else 0,
        }), encoding="utf-8")
        print(f"[donki] wrote {len(data) if isinstance(data, list) else '?'} CMEs -> build/donki/cmes.json")
    except Exception as e:
        print(f"[donki] FAILED: {e}", file=sys.stderr)
        errors.append(f"donki: {e}")


if __name__ == "__main__":
    raise SystemExit(main())
