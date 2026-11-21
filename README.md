# AuroraDashboard

An aurora-chance forecaster for the Nordics, Iceland, and Greenland. Combines live NOAA solar-wind and Kp data with cloud forecasts from Open-Meteo and MET Norway to estimate the hourly probability of seeing the aurora from a given place.

See [docs/MODEL.md](docs/MODEL.md) for how the forecast is built.

---

## For my parents — how to use this

**Just open the link.** Nothing to install.

Bookmark it. Come back whenever you want to check the aurora chance.

**If something looks broken:** scroll to the "Data problems" box on the dashboard — it lists which feeds are down. Individual feeds fail independently, so the rest of the dashboard will still work.

### Optional — running your own copy locally

If you ever want to run it on your own computer (for offline use, or because GitHub Pages is down):

1. Install Python 3 from https://www.python.org/downloads/ — tick **"Add Python to PATH"**.
2. On the GitHub page, click the green **Code** button → **Download ZIP**. Unzip it.
3. Double-click `run.bat`.

---

## For maintainers

Owner: Jordan. Windows / PowerShell, Python 3. Stdlib only in `aurora_fi.py` (so it runs on any machine without `pip install`).

### Run

```powershell
python aurora_fi.py kilpisjarvi                 # CLI table
python aurora_fi.py --cloud-source metno --hours 48
python aurora_fi.py --serve                     # dashboard at http://127.0.0.1:8765/
python aurora_fi.py --serve --open /hifi        # open the hifi view directly (run.bat uses this)
python tools/build_static.py                    # build build/ for GitHub Pages locally
python -m pytest -q tests/test_model.py
python tests/run_mock.py dicts rovaniemi        # offline CLI check
python tests/pw_test.py                         # offline dashboard render (needs Playwright)
```

### Deployment (GitHub Pages)

`.github/workflows/pages.yml` runs `tools/build_static.py` on every push to `main` and hourly on a cron. The build:
- copies `web/` + `config/` into `build/`,
- renames `hifi.html` → `index.html`,
- pre-generates `build/grid/<CC>.json` for each country so the map works without a backend and without hammering Open-Meteo from every visitor's browser.

[web/map.js:loadGrid](web/map.js) tries `./grid/<CC>.json` first (static deploy), then `/grid?country=` (`--serve`), then direct Open-Meteo (file:// fallback).

API keys are not shipped in the static site. NASA DONKI uses `DEMO_KEY` on the public deploy (30/hour, enough for personal use). To hide a real key, use the `--serve` path or a server-side proxy (e.g. a Cloudflare Worker).

### Layout

- `aurora_fi.py` — CLI + local HTTP server (stdlib only). `--serve` runs the dashboard with an allow-listed JSON proxy for CORS-blocked APIs. Routes: `/` → `web/pro.html` (map), `/hifi` → `web/hifi.html`, `/lite` → `web/index.html`.
- `aurora/` — model internals: `model.py` (scoring), `sources.py` (data feeds), `grid.py` (country grids), `places.py`, `aacgm.py` (geomagnetic lat lookup).
- `web/` — dashboard HTML/JS/CSS, vendored D3 + TopoJSON, `data/aacgm_grid.json` (precomputed geomagnetic grid).
- `config/places.json` — country/place definitions.
- `tools/` — `build_single.py` (bundle a dashboard to one HTML file), `build_aacgm_grid.py` (regenerate the grid, needs `aacgmv2`), `backtest.py`, `calibrate.py`.
- `tests/` — pure-model pytest + offline mocks + Playwright render.
- `docs/MODEL.md` — the physical chain and scoring model. `PLAN.md` — what's next.
- `CLAUDE.md` — project context for Claude Code.

### Model in one line

```
P(hour) = P_geo(Kp, geomag lat, MLT) × P_clear(clouds) × darkness(sun alt) × moon_factor(alt, illumination)
```

Constants are at the top of both `aurora_fi.py` and the dashboard JS and **must stay identical** (see `PLAN.md`: parity test).

### Conventions

- Python: stdlib only in `aurora_fi.py`. Optional heavy deps (xarray, aacgmv2) behind a separate module; degrade gracefully when missing.
- Dashboard: dark UI, hand-built SVG charts, CDN libs only from cdnjs/unpkg/jsdelivr. One y-axis per chart, legend for ≥2 series, hover tooltips, sequential = one hue.
- Minimal code comments — only where non-obvious.
- Every data source fails independently; surface failures in "Data problems", never crash.
- All times are internally UTC; display local time per country.

### Data sources (no API keys)

- **NOAA SWPC** — RTSW magnetometer + plasma, Kp observed/forecast, OVATION. `--serve` sets a User-Agent.
- **Open-Meteo** — hourly cloud cover in low/mid/high layers. Multi-location in one call.
- **MET Norway Locationforecast 2.0** — cloud cover; hourly for ~48h then 6-hourly. Requires an identifying User-Agent (the proxy sets one).
- **NASA DONKI** — CME catalogue. Uses `DEMO_KEY` by default; set `NASA_API_KEY` env var for a higher rate limit when running `--serve`.

### License

MIT — see `LICENSE`.
