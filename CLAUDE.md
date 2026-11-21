# aurora-fi: project context for Claude Code

Aurora-chance forecaster for Finland, being extended to the Nordic countries, Iceland and Greenland.
Owner: Jordan (computational cosmologist). Windows / PowerShell, Python 3.

## What exists
- `aurora_fi.py`: CLI forecaster, **stdlib only**. Also `--serve`: a local HTTP server for the dashboard
  plus an allow-listed JSON proxy (`/proxy?u=`; hosts in `PROXY_HOSTS`).
- `aurora_dashboard.html`: single-file browser dashboard. Same model ported to JS; hand-built SVG charts;
  no build step. Works via `file://` (direct fetch, if the APIs allow browser requests) or via `--serve` (proxy).
- `tests/`: `test_model.py` (pytest, pure model functions), `run_mock.py` (CLI against synthetic API data),
  `pw_test.py` (Playwright render of the dashboard with routed mock APIs; set `CHROME` to a Chrome path if needed).
- `docs/MODEL.md`: the physical chain and the scoring model. `PLAN.md`: the next work.

## Run
```
python aurora_fi.py kilpisjarvi                 # CLI table
python aurora_fi.py --cloud-source metno --hours 48
python aurora_fi.py --serve                     # dashboard at http://127.0.0.1:8765/
python -m pytest -q tests/test_model.py
python tests/run_mock.py dicts rovaniemi        # offline CLI check ("lists" = list-of-lists API format)
python tests/pw_test.py                         # offline dashboard render -> tests/shot.png
```

## Model in one line
P(hour) = P_geo(Kp, geomag lat, MLT) × P_clear(clouds) × darkness(sun alt) × moon_factor(alt, illumination).
Constants are at the top of both files and **must stay identical in Python and JS** (see PLAN.md: parity test).

## Conventions
- Python: stdlib only in `aurora_fi.py` (it must run on any machine). Optional heavy deps (xarray, aacgmv2)
  only behind a separate module or backend, and degrade gracefully when they're missing.
- Dashboard: one HTML file (or `--serve`-d static files if it outgrows that), dark UI, CDN libs only from
  cdnjs/unpkg/jsdelivr. Charts follow the dataviz rules: one y-axis per chart, legend for ≥2 series,
  hover tooltips, sequential = one hue, status colours only with a text label.
- Minimal code comments: only where non-obvious.
- Every data source fails independently; surface failures in "Data problems", never crash.
- All times are internally UTC; display local time per country (Europe/Helsinki for Finland today).

## Data sources (no API keys)
- NOAA SWPC: `json/rtsw/rtsw_{mag,wind}_1m.json` (fallback `products/solar-wind/*-1-day.json`),
  `products/noaa-planetary-k-index-forecast.json`, `json/planetary_k_index_1m.json`, `json/ovation_aurora_latest.json`.
  RTSW rows carry `active`; filter on it. Formats differ (list-of-lists with header vs list-of-dicts); `rows()` handles both.
- Open-Meteo forecast API (hourly `cloud_cover{,_low,_mid,_high}`; supports comma-separated multi-location).
- MET Norway Locationforecast 2.0 `complete` (needs an identifying User-Agent; the proxy sets one).

## Known unknowns (verify against live data first)
- NOAA field names for the 2026 SOLAR-1 / IMAP feeds were written from memory with fallbacks. Worked live on 2026-11-18/19.
- Whether NOAA / Open-Meteo / MET Norway send CORS headers for `file://` use. `--serve` sidesteps this.
- Calibration of P_geo is rule-of-thumb (confidence ~0.6), not fitted.

## Owner preferences
Correctness over speed; state confidence (0–1) and caveats for non-trivial conclusions; direct, technical.
