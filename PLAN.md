# Plan: multi-country support + cloud-cover map

Goal: pick a country (Finland, Sweden, Norway incl. Svalbard, Denmark incl. Faroe, Iceland, Greenland) or an all-Nordic view.
See a map of cloud cover and aurora chance with a time slider, synced with the existing hourly chart and ranking.

Order matters: the multi-country **model fixes come before the map**. Otherwise the map will draw confidently wrong
numbers for Iceland, Greenland and Svalbard.

---

## Phase 0: refactor (no behaviour change)

**Why:** two copies of the model (Python and JS) will drift, and one HTML file won't hold a map, a geography file and an AACGM table.

1. Layout:
   ```
   aurora_fi.py              CLI + --serve (thin; keeps the stdlib-only guarantee)
   aurora/model.py           pure model functions (moved from aurora_fi.py)
   aurora/sources.py         NOAA / Open-Meteo / MET Norway fetchers
   config/places.json        countries, places, timezones, map extents (shared by Python and JS)
   web/index.html            dashboard shell
   web/model.js              JS model (ES module; also imported by node tests)
   web/sources.js  web/charts.js  web/map.js
   web/data/                 nordic.topo.json, aacgm_grid.json (generated, committed)
   tools/                    generators: build_topojson, build_aacgm_grid, build_single (inline into one HTML file)
   tests/
   ```
2. `--serve` becomes the main way to run (serves `web/` and the proxy). `tools/build_single.py` still produces a
   standalone `aurora_dashboard.html` for double-click use, with config and data inlined. Chrome blocks `fetch()` of local files under `file://`.
3. **Parity test:** `tests/test_parity.py` writes about 2,000 random inputs (lat, lon, t, Kp, cloud tuple), runs them
   through `aurora/model.py` and through `node tests/parity.mjs` (which imports `web/model.js`), and asserts |ΔP| < 1e-9.
   Run this in CI or a pre-commit hook.
4. Keep `tests/run_mock.py` and `tests/pw_test.py` working. Add a mock for each new data source.

**Done when:** all existing tests pass, the parity test passes, and the dashboard looks the same as before.

---

## Phase 1: multi-country model

### 1a. Places and time zones (`config/places.json`)
Each place has its own `tz`, because Greenland spans several zones. Country entries carry `name`, `default_place`,
`bbox`, `projection`. Starter list (dipole geomag lat in brackets; AACGM may differ by several degrees, see 1b):

| Country | Places |
|---|---|
| FI | existing 14 presets |
| SE | Abisko 68.35/18.83 (66.4), Kiruna 67.86/20.23 (65.7), Jokkmokk 66.61/19.82, Luleå 65.58/22.15, Östersund 63.18/14.64, Stockholm 59.33/18.07 (58.0) |
| NO | Tromsø 69.65/18.96 (67.5), Alta 69.97/23.27 (67.2), Svolvær 68.23/14.57 (66.9), Kirkenes 69.73/30.05, Bodø 67.28/14.40, Trondheim 63.43/10.40, Oslo 59.91/10.75 (59.7), Longyearbyen 78.22/15.65 (75.3; tz Arctic/Longyearbyen) |
| DK | Skagen 57.72/10.58 (57.6), Copenhagen 55.68/12.57 (55.4), Tórshavn 62.01/−6.77 (64.5; tz Atlantic/Faroe) |
| IS | Reykjavík 64.15/−21.94 (68.8), Þingvellir 64.26/−21.13, Akureyri 65.68/−18.09 (69.7), Höfn 64.25/−15.21 (67.9), Ísafjörður 66.07/−23.13 |
| GL | Narsarsuaq 61.16/−45.43 (69.0), Qaqortoq 60.72/−46.03, Nuuk 64.18/−51.72 (72.5), Kangerlussuaq 67.01/−50.69 (75.2), Ilulissat 69.22/−51.10 (77.3), Tasiilaq 65.61/−37.64 (72.4), Ittoqqortoormiit 70.49/−21.97 (74.7; tz America/Scoresbysund), Qaanaaq 77.47/−69.23 (86.6; tz America/Thule) |

UI: country selector, then place selector. The CLI gains `--country`. The ranking table covers the selected country, or everything in all-Nordic view.

### 1b. AACGM coordinates (confidence that this is needed: 0.85)
The dipole approximation is fine for Fennoscandia (±~1°). It's poor in the North Atlantic and near the pole in north-west Greenland:
Iceland comes out at about 69° dipole versus roughly 65–66° corrected (to verify).
- Python: optional `aacgmv2` (pip wheels exist for Windows). If it's missing, fall back to the dipole and print a warning.
- JS: `tools/build_aacgm_grid.py` uses aacgmv2 to write `web/data/aacgm_grid.json`, with mlat and mlon at 110 km on a 0.5° grid
  over 50–85°N, 80°W–35°E, for a fixed epoch (regenerate yearly). `model.js` interpolates it bilinearly. MLT comes from aacgm mlon minus the subsolar mlon,
  or from `aacgmv2.convert_mlt` grids for exactness.
- Test: grid interpolation against aacgmv2 at 200 random points, |Δmlat| < 0.1°. Python and JS give the same values.

### 1c. Poleward boundary / proper oval model (needed for GL, Svalbard, northern Iceland)
The current `P_geo` only has an equatorward edge, so it says "inside the oval" for any latitude poleward of it.
That's wrong in the polar cap: Qaanaaq, Ilulissat at low Kp, and Longyearbyen at night. Svalbard also sees dayside (cusp)
aurora around magnetic noon in polar night, which the current MLT term actively suppresses.
- Replace the edge formula with an empirical oval giving both boundaries as functions of activity and MLT.
  Candidates: **Starkov (1994)** (polynomial boundaries vs AL/Kp and MLT; simple, published coefficients) or
  **Zhang & Paxton (2008)** (Kp-driven, based on TIMED/GUVI). Start with Starkov, and check boundaries against figures in the papers.
- `P_geo = cap · max( σ((mlat − eq)/w) · σ((pole − mlat)/w),  0.6 · horizon terms toward both boundaries )`.
- Weight OVATION more at high latitude for the next ~1.5 h: it already handles the full oval.
- Optional: polar-cap arcs under northward IMF (Qaanaaq). Note only, low priority.
- Tests: Kangerlussuaq is inside the oval at Kp 2 near midnight. Qaanaaq has low P_geo at Kp 2 and 23 MLT. Longyearbyen has higher P at
  10–14 MLT than at 23 MLT under quiet conditions. Finland's numbers change by less than ~0.05 compared with today (regression guard).

### 1d. Small fixes surfaced by this
- Darkness and moon are already location-generic. Check the moon at Qaanaaq in polar night.
- Thresholds: Denmark needs Kp ≥ 6–7. The model handles this automatically, so just verify with the cases above.

---

## Phase 2: cloud map

### 2a. Data: gridded clouds from Open-Meteo (works everywhere, no new dependencies)
- A regular grid per country bbox: ~0.5° lat × 1.0° lon for FI/SE/NO; ~0.25° × 0.5° for DK/IS;
  ~1° × 2° for GL, masked to within ~150 km of the coast since nobody watches from the ice sheet.
- Fetch through `--serve` with a **disk cache** (TTL 60 min; models update hourly at best). Batch the multi-location
  requests (start at ≤100 points per request; check Open-Meteo's documented limit).
- **API budget:** the free tier is about 10k calls a day for non-commercial use, and multi-location requests are counted
  per location (verify both). A 300-point grid hourly is about 7k a day, so cache hard, cap the grid at about 300 points per view, and refresh the single-point
  forecast every 15 min instead of 5.
- Variables: `cloud_cover_low/mid/high` plus total, 48–60 h, hourly. Compute P_clear per cell exactly as for single points.

### 2b. Rendering: d3-geo on canvas, not Leaflet tiles
Web Mercator badly distorts Greenland and doesn't suit an all-Nordic view. Use **d3-geo + topojson-client** (cdnjs or jsdelivr)
with a bundled **Natural Earth 1:10m** admin-0 subset (Nordics, Iceland, Greenland, neighbours), simplified to under ~300 KB
(`tools/build_topojson` via mapshaper). This avoids tile servers and works the same at any zoom.
- Projections: FI/SE/NO/DK conic conformal fitted to the bbox; IS transverse Mercator; GL and all-Nordic
  azimuthal equal-area centred near (72°N, −30°) or (68°N, 0°). Use `fitExtent` to the container.
- Draw each grid cell as a **projected polygon** (four corners through the projection) on a `<canvas>`. Don't use an image overlay:
  equal-latitude rows don't map linearly to projected y.
- Layers (radio): **Effective cloud** (sequential neutral ramp, clear = transparent → overcast = light grey on the dark
  basemap), **Low cloud**, **Aurora chance** (sequential single hue; reuse series-1 blue ramp from dataviz palette).
  Legend with ticks, and a hover tooltip per cell with the same fields as the hourly tooltip.
- Overlays (checkboxes):
  - places, with dots coloured by verdict and labelled
  - model oval boundaries for the selected hour (equatorward and poleward isolines from 1c)
  - OVATION 10% and 30% contours (d3-contour on its 1° grid), nowcast only
  - the "visible on horizon" line
- Time slider (hour 0–48) with play/pause, two-way synced with the hourly chart's hover or click.
  Clicking the map sets a custom location and recomputes the dashboard.
- Performance: about 300 cells × 49 hours is precomputed once per data refresh (~15k model evaluations, a few ms).

### 2c. Tests
- Playwright: routed mocks for the grid request. Check the canvas has non-transparent pixels over land, the slider changes the
  canvas, and clicking a place updates `#where`.
- A screenshot per country to `tests/shots/`, checked by eye for label collisions and projection sanity.

**Done when:** for each country, the map renders under mocks, the slider and chart stay in sync, and the all-Nordic view keeps Greenland
undistorted. The live run (via `--serve`) stays under the API budget, which you can confirm by logging cache hits and misses.

---

## Phase 3: higher-resolution regional weather models (backend only, optional dependencies)
Only if Phase 2's grid proves too coarse for fjords and fells. These need xarray/cfgrib/netCDF4 in the `--serve` process,
behind a feature flag. Endpoints and parameter names below are **to verify**:
- **MET Norway THREDDS, MEPS 2.5 km** (Fennoscandia + Baltic; low/medium/high cloud) for FI/SE/NO/DK.
- **DMI Open Data, HARMONIE** (Denmark domain; Iceland–Greenland domain) for DK/IS/GL.
- **ECMWF open data 0.25°** as a uniform global fallback (check whether low/mid/high cloud are in the open parameter set).
- Regrid to the Phase 2 cell layout server-side and serve the same JSON shape, so the front end doesn't change.

## Phase 4: observed clouds and calibration
- **Satellite overlay** (observed, not forecast). In polar night only infrared helps. NASA GIBS offers Arctic polar-stereographic
  (EPSG:3413) layers, such as VIIRS/MODIS brightness temperature or cloud products. EUMETSAT EUMETView WMS (Meteosat) is usable but oblique
  above ~65°N. Show it as a toggleable layer with its observation time.
- **Calibration:** fit the P_geo constants (or the oval model's width and cap) by logistic regression against hourly
  aurora present/absent from all-sky camera keograms under clear skies. Candidate sources: FMI/Sodankylä (incl. Kilpisjärvi), IRF Kiruna, Tromsø,
  Kangerlussuaq archives. Report reliability diagrams.

---

## Backtest (deferred — pick up once Phase 2 is done)

Minimum useful version, ~1–2 hours:
- Hand-pick 3–5 known storm nights (May 2024 G5, Oct/Nov 2024 events) and 3–5 known-quiet nights.
- `tools/backtest.py`: for each (date, place), fetch historical Kp (GFZ or NOAA archive), OMNI solar wind,
  ERA5 clouds via `archive-api.open-meteo.com`. Feed through `aurora/model.py`. Print the forecast.
- Sanity target: storm-night scores ≥ 0.3, quiet-night scores < 0.1, at known-aurora locations.
- Not a true backtest; it's a smell test on whether calibration is in the right ballpark.

The proper backtest (keograms + Brier/reliability) and model fitting belong in Phase 4.

## Backlog (small)
- Windows toast or ntfy notification when Bz < −5 nT for ≥30 min after dusk and P ≥ 0.25 for the chosen place
  (scheduled `aurora_fi.py --notify`).
- Cloud-model spread: run 2–3 Open-Meteo models and show the min/max of P_clear as a band, since model disagreement was the deciding uncertainty on 18–19 Nov.
- Show the solar-wind propagation delay as a "reaches Earth at hh:mm" marker on the hourly chart.
- Kp-slot oddity seen on 18 Nov: NOAA's JSON day-1 values differed from the 00:30 UT bulletin (likely an updated forecast). `--kp-raw` exists to inspect it.

## Open questions for Jordan
1. All-Nordic view: one map centred near 68°N, 0° (Greenland and Finland together, both small), or country-only?
2. Include Svalbard and Faroe as their own entries, or inside NO/DK?
3. Is about 300 grid points per view acceptable, or should the backend cache be shared across views to allow a denser grid?
4. Keep the double-click single-file build, or go `--serve` only?

## Suggested first session in Claude Code
1. Phase 0 refactor and parity test.
2. Phase 1b (AACGM), because it decides whether Iceland and Greenland numbers mean anything.
3. Phase 1c oval model, with the regression guard for Finland.
4. Phase 1a config and country selector.
5. Phase 2.
