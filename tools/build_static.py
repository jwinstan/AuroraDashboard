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
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from aurora import grid as G  # noqa: E402
from aurora import places as P  # noqa: E402


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

    places_cfg = P.load()
    grid_dir = BUILD / "grid"
    grid_dir.mkdir(exist_ok=True)

    errors: list[str] = []
    for cc in places_cfg["countries"]:
        print(f"[grid] {cc} ...", flush=True)
        try:
            data, origin = G.fetch_grid(cc, places_cfg, errors=errors, force=True)
            out = grid_dir / f"{cc}.json"
            out.write_text(json.dumps(data), encoding="utf-8")
            print(f"[grid] {cc} {origin} cells={len(data.get('cells', []))} -> {out.relative_to(ROOT)}")
        except Exception as e:
            print(f"[grid] {cc} FAILED: {e}", file=sys.stderr)
            errors.append(f"{cc}: {e}")

    if errors:
        print("\nBuild finished with grid errors:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)

    print(f"\nStatic site built at {BUILD.relative_to(ROOT)}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
