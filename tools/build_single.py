#!/usr/bin/env python3
"""Inline web/ into a standalone HTML dashboard.

Two output variants:
  default    web/index.html + model/sources/charts/app.js  -> aurora_dashboard.html
  --pro      web/pro.html   + same + map.js                 -> aurora_dashboard_pro.html

The output has no external file dependencies (no fetches, no module imports), so
it can be opened directly from disk. CORS still applies to the live data APIs —
use `aurora_fi.py --serve` if the browser blocks them.
"""
import argparse
import base64
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
VENDOR = WEB / "vendor"

# URL -> local vendor file. When these are present we rewrite ES module imports
# from the CDN URL to a data: URL built from the vendor file, so the pro
# single-file build has zero CDN dependency for the map scaffolding.
VENDOR_URLS = {
    "https://cdn.jsdelivr.net/npm/d3-geo@3/+esm": VENDOR / "d3-geo.mjs",
    "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm": VENDOR / "topojson-client.mjs",
}
# Transitive imports to rewrite *inside* a vendor file before we base64 it.
# jsdelivr's +esm bundles re-import shared leaves by absolute path, e.g.
# d3-geo has `from"/npm/d3-array@3.2.5/+esm"`. Absolute paths don't resolve
# against a data: URL base (no origin), so when we inline d3-geo as a data:
# URL the browser throws "Invalid relative url or base scheme isn't
# hierarchical". Each entry here is replaced with a nested data: URL.
VENDOR_TRANSITIVE = {
    "/npm/d3-array@3.2.5/+esm": VENDOR / "d3-array.mjs",
}
# Data payloads inlined as window globals (same pattern as __PLACES__, __AACGM__).
VENDOR_JSON = {
    "__WORLD_ATLAS__": VENDOR / "countries-50m.json",
}

# Order matters: later files reference symbols from earlier ones. aacgm.js must
# come before model.js (model.js imports geomagLat from aacgm.js at the top).
LITE = {
    "html": "index.html",
    "js": ["aacgm.js", "model.js", "sources.js", "charts.js", "app.js"],
    "entry": "./app.js",
    "out": "aurora_dashboard.html",
}
PRO = {
    "html": "pro.html",
    "js": ["aacgm.js", "model.js", "sources.js", "charts.js", "app.js", "map.js", "events.js"],
    "entry": "./pro.js",
    "out": "aurora_dashboard_pro.html",
}
HIFI = {
    "html": "hifi.html",
    "js": ["aacgm.js", "model.js", "sources.js", "charts.js", "app.js", "map.js", "events.js", "hifi_extras.js"],
    "entry": "./hifi.js",
    "out": "aurora_dashboard_hifi.html",
}


def strip_esm(src: str) -> str:
    """Strip export keywords and relative-path imports. URL imports (https://cdn...)
    are left in place because the single-file bundle still runs as an ES module —
    the browser resolves CDN URLs for us, and the bindings end up in module scope
    so the IIFE-wrapped entry files can see them as free variables."""
    src = re.sub(r"^export\s+default\s+", "", src, flags=re.M)
    src = re.sub(r"^export\s+(const|let|var|function|async\s+function|class)\b", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[^}]*\}\s*(from\s*[\"'][^\"']+[\"'])?\s*;?\s*$", "", src, flags=re.M)
    # Only strip relative imports (./, ../). Keep URL imports.
    src = re.sub(r"^import\s+[^;]*?from\s*[\"']\.\.?/[^\"']+[\"']\s*;?\s*$", "", src, flags=re.M)
    src = re.sub(r"^import\s*[\"']\.\.?/[^\"']+[\"']\s*;?\s*$", "", src, flags=re.M)
    return src


def extract_url_imports(src: str):
    """Pull URL-based import statements (including multi-line `import { ... } from`)
    out of src and return (hoisted_imports, src_without_them). Needed because ES
    import statements aren't legal inside IIFEs — they must sit at module top level."""
    pattern = re.compile(
        r"^(import\s+(?:[^\"';]*?\{[^{}]*?\}\s*)?from\s*[\"']https?://[^\"']+[\"']\s*;?)\s*$",
        re.M | re.S,
    )
    hoisted = pattern.findall(src)
    stripped = pattern.sub("", src)
    return "\n".join(hoisted), stripped


_DATA_URL_CACHE: dict = {}


def _to_data_url(local_path):
    key = str(local_path)
    if key in _DATA_URL_CACHE:
        return _DATA_URL_CACHE[key]
    source = local_path.read_text(encoding="utf-8")
    # Strip the sourceMappingURL comment — the map file isn't inlined.
    source = re.sub(r"//# sourceMappingURL=.*$", "", source, flags=re.M)
    # Recursively inline transitive deps (e.g. d3-geo → d3-array) only when
    # the parent file actually references them, to keep the recursion finite.
    for abs_path, tr_local in VENDOR_TRANSITIVE.items():
        if abs_path in source and tr_local.exists():
            source = source.replace(abs_path, _to_data_url(tr_local))
    b64 = base64.b64encode(source.encode("utf-8")).decode("ascii")
    url = f"data:text/javascript;base64,{b64}"
    _DATA_URL_CACHE[key] = url
    return url


def vendor_rewrite(import_block: str) -> str:
    """Rewrite CDN URLs in import statements to data: URLs built from local
    vendor files, so the single-file HTML has no CDN dependency."""
    out = import_block
    for cdn_url, local_path in VENDOR_URLS.items():
        if not local_path.exists():
            continue
        out = out.replace(cdn_url, _to_data_url(local_path))
    return out


def build(variant):
    index = (WEB / variant["html"]).read_text(encoding="utf-8")
    places = json.loads((ROOT / "config" / "places.json").read_text(encoding="utf-8"))

    # AACGM grid is 255 KB — inline when available so single-file HTML works
    # from file:// without any network. If the grid file isn't there, the JS
    # silently falls back to the centered dipole (parity with --serve offline).
    aacgm_path = WEB / "data" / "aacgm_grid.json"
    aacgm_js = ""
    if aacgm_path.exists():
        aacgm_json = aacgm_path.read_text(encoding="utf-8")
        aacgm_js = f"window.__AACGM__ = {aacgm_json};\n"

    # vendor_json_js is set below, only for variants that actually use the map.

    # Shared libs (model, sources, charts, aacgm) stay top-level so their
    # functions are visible to both entry files. The entry files (app.js,
    # map.js, pro.js, events.js, hifi_extras.js) get wrapped in IIFEs so
    # their private top-level names don't collide when concatenated.
    entry_files = {"app.js", "map.js", "pro.js", "events.js", "hifi_extras.js"}
    hoisted_imports = []
    parts = []
    for f in variant["js"]:
        src = strip_esm((WEB / f).read_text(encoding="utf-8"))
        hoisted, src = extract_url_imports(src)
        if hoisted:
            hoisted_imports.append(vendor_rewrite(hoisted))
        if f in entry_files:
            src = f"(function() {{\n{src}\n}})();"
        parts.append(src)
    bundled = "\n".join(hoisted_imports + parts)

    # Only inline world-atlas etc. when the variant has CDN imports to go with
    # them (i.e. it has a map). Skipping for lite keeps that build small.
    vendor_json_js = ""
    if hoisted_imports:
        for global_name, path in VENDOR_JSON.items():
            if path.exists():
                vendor_json_js += f"window.{global_name} = {path.read_text(encoding='utf-8')};\n"
    inline = (
        f"window.__PLACES__ = {json.dumps(places, ensure_ascii=False)};\n"
        + aacgm_js
        + vendor_json_js
        + bundled
    )
    replacement = f'<script type="module">\n{inline}\n</script>'
    # Match the entry script tag (./app.js or ./pro.js) and swap it for the inline module.
    entry_re = re.compile(
        r'<script\s+type="module"\s+src="' + re.escape(variant["entry"]) + r'"\s*>\s*</script>',
    )
    out, n = entry_re.subn(lambda _m: replacement, index, count=1)
    if n == 0:
        sys.exit(f"build_single: could not find script tag for {variant['entry']} in {variant['html']}")

    _syntax_check(bundled)

    out_path = ROOT / variant["out"]
    out_path.write_text(out, encoding="utf-8")
    print(f"wrote {out_path} ({out_path.stat().st_size // 1024} KB)")


def _syntax_check(bundled: str) -> None:
    if not shutil.which("node"):
        return
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False, encoding="utf-8") as f:
        f.write(bundled)
        tmp = f.name
    try:
        r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"build_single: bundled JS fails node --check:\n{r.stderr}")
    finally:
        Path(tmp).unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pro", action="store_true", help="build the heavyweight version with the map")
    ap.add_argument("--hifi", action="store_true", help="build the hi-fi personal build (adds solar imagery + X-ray + finer map grid)")
    ap.add_argument("--all", action="store_true", help="build lite + pro + hifi")
    a = ap.parse_args()
    if a.all:
        build(LITE); build(PRO); build(HIFI)
    elif a.hifi:
        build(HIFI)
    elif a.pro:
        build(PRO)
    else:
        build(LITE)


if __name__ == "__main__":
    main()
