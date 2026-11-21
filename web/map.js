// Cloud and aurora map. Loaded only by the pro build.
// Phase 2b: d3-geo canvas, country outlines, grid cells (low cloud), time slider.
// Phase 2c-plus: overlays (places, oval boundaries, OVATION), chart sync, play/pause.

import {
  geoAzimuthalEqualArea, geoMercator, geoPath,
} from "https://cdn.jsdelivr.net/npm/d3-geo@3/+esm";
import { feature, mesh } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
import {
  geomagLat, mlt, sunAlt, sunCoords, moonState, moonFactor, pGeo, pClear,
  darkness, ovationAt, verdict, toDipole, fromDipole,
  EDGE0, EDGE_SLOPE, MLT_AMP, MLT_MIN, POLE_WIDTH_BASE, POLE_WIDTH_PER_KP, P_CAP,
} from "./model.js";
import { kpInBin } from "./sources.js";

const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";

// world-atlas uses UN M49 numeric country IDs.
const ISO_NUM = {
  FI: "246", SE: "752", NO: "578", DK: "208", IS: "352", GL: "304",
};

const canvas = document.getElementById("map-canvas");
const tip = document.getElementById("map-tip");
const slider = document.getElementById("map-time");
const whenLabel = document.getElementById("map-when");
const countrySel = document.getElementById("country");
const layerSel = document.getElementById("map-layer");
const legendLabel = document.getElementById("map-legend-label");
const statsEl = document.getElementById("map-stats");

// Cloud array indices in the backend payload: [total, low, mid, high]
const LAYER_IDX = { tot: 0, low: 1, mid: 2, high: 3 };
const LAYER_LABEL = {
  aurora: "Aurora chance",
  tot: "Total cloud", low: "Low cloud (blocks sky)", mid: "Mid cloud", high: "High cloud (thin)",
};
// `H` (one hour in ms) is declared in app.js; in the pro bundle both files are
// concatenated into one scope, so defining it here would collide.
const HOUR_MS = 3600e3;

if (!canvas) {
  // Lightweight page — no map markup. Nothing to do.
} else {
  init();
}

let worldPromise = null;
function loadWorld() {
  // Prefer inlined topojson (single-file pro build) so the map works offline.
  if (window.__WORLD_ATLAS__) return Promise.resolve(window.__WORLD_ATLAS__);
  if (!worldPromise) worldPromise = fetch(WORLD_URL).then(r => r.json());
  return worldPromise;
}

async function loadGrid(cc) {
  // Prefer a static prebuilt grid (GitHub Pages deploy writes build/grid/<CC>.json),
  // then the --serve backend, then direct Open-Meteo (file:// / email-attachment use).
  try {
    const r = await fetch(`./grid/${cc}.json`, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch { /* no static grid, try backend */ }
  try {
    const r = await fetch(`/grid?country=${cc}`, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch { /* file:// or offline, try direct */ }
  return await fetchGridDirect(cc);
}

// Session-scoped cache keyed by country + bbox; 60-min TTL so a double-clicked
// pro HTML doesn't re-hit Open-Meteo on every reload within an hour.
const _directCache = new Map();

async function fetchGridDirect(cc) {
  const country = (window.__PLACES__ || await (await fetch("./config/places.json")).json()).countries[cc];
  if (!country?.bbox) throw new Error(`no bbox for ${cc}`);
  const bbox = country.bbox;
  const cacheKey = `${cc}:${bbox.join(",")}`;
  const cached = _directCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60 * 60e3) return cached.data;

  const [lat0, lon0, lat1, lon1] = bbox;
  const cosM = Math.max(0.05, Math.cos((lat0 + lat1) / 2 * Math.PI / 180));
  // Mirror aurora/grid.py's step choice (TARGET_CELLS = 400).
  const niceSteps = [0.1, 0.2, 0.25, 0.4, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
  const niceStep = x => niceSteps.find(s => s >= x) ?? niceSteps[niceSteps.length - 1];
  const latStep = niceStep(Math.sqrt((lat1 - lat0) * (lon1 - lon0) * cosM / 400));
  const lonStep = niceStep(latStep / cosM);

  const pts = [];
  for (let la = lat0; la <= lat1 + 1e-9; la += latStep) {
    for (let lo = lon0; lo <= lon1 + 1e-9; lo += lonStep) {
      pts.push([+la.toFixed(3), +lo.toFixed(3)]);
    }
  }

  const cells = new Array(pts.length);
  let times = null;
  const BATCH = 100;
  for (let i = 0; i < pts.length; i += BATCH) {
    if (i > 0) await new Promise(r => setTimeout(r, 300));
    const batch = pts.slice(i, i + BATCH);
    const q = new URLSearchParams({
      latitude: batch.map(p => p[0]).join(","),
      longitude: batch.map(p => p[1]).join(","),
      timezone: "UTC", forecast_days: "3",
      hourly: "cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high",
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    const d = await r.json();
    const results = Array.isArray(d) ? d : [d];
    for (let j = 0; j < results.length; j++) {
      const h = results[j].hourly || {};
      if (!times && h.time) times = h.time;
      const t = h.cloud_cover || [], lo = h.cloud_cover_low || [];
      const mi = h.cloud_cover_mid || [], hi = h.cloud_cover_high || [];
      const n = Math.max(t.length, lo.length, mi.length, hi.length);
      const clouds = n ? Array.from({ length: n }, (_, k) => [t[k] ?? null, lo[k] ?? null, mi[k] ?? null, hi[k] ?? null]) : null;
      cells[i + j] = { lat: batch[j][0], lon: batch[j][1], clouds };
    }
  }
  for (let i = 0; i < pts.length; i++) {
    if (!cells[i]) cells[i] = { lat: pts[i][0], lon: pts[i][1], clouds: null };
  }
  const data = {
    country: cc, bbox, lat_step: latStep, lon_step: lonStep,
    times: times || [], cells,
    fetched_at: new Date().toISOString(),
  };
  _directCache.set(cacheKey, { data, at: Date.now() });
  return data;
}

function projectionFor(cc, bbox, width, height) {
  const [lat0, lon0, lat1, lon1] = bbox;
  const mid = [(lon0 + lon1) / 2, (lat0 + lat1) / 2];
  let proj;
  if (cc === "GL") {
    // Greenland spans 59–84°N: Mercator would stretch to infinity, use azimuthal.
    proj = geoAzimuthalEqualArea().rotate([-mid[0], -mid[1]]).center([0, 0]);
  } else {
    // Mercator is fine for 55–72°N and avoids conic-apex artifacts.
    proj = geoMercator();
  }
  // fitExtent with a Polygon treats edges as great circles, which bulge outward
  // badly at high latitudes and make the projection tiny. Use MultiPoint so d3
  // computes bounds from the four corners only.
  const bboxPoints = {
    type: "MultiPoint",
    coordinates: [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1]],
  };
  proj.fitExtent([[12, 12], [width - 12, height - 12]], bboxPoints);
  return proj;
}

// Sequential neutral ramp per PLAN.md: clear = fully transparent (dark basemap
// shows through = aurora-friendly), overcast = opaque light grey.
function cloudColor(pct) {
  if (pct == null) return null;
  const a = Math.min(1, Math.max(0, pct / 100));
  const bright = Math.round(255 * a);
  return `rgba(${bright},${bright},${bright},${a.toFixed(2)})`;
}

// Sequential single-hue blue ramp for aurora chance: low chance = transparent,
// high chance = saturated series-1 blue. Matches dataviz palette.
function auroraColor(p) {
  if (p == null) return null;
  const a = Math.min(1, Math.max(0, p));
  // #3987e5 is var(--series-1). Interpolate alpha only; colour is fixed hue.
  return `rgba(57,135,229,${a.toFixed(2)})`;
}

// Compute aurora chance for one cell-hour. Mirrors app.js's outlook() formula
// end-to-end, including the hour midpoint and the per-cell cloud multiplier so
// this matches the number the hourly chart would show for the same hour.
function auroraChanceAt(lat, lon, tMs, appData, cloudsAtHour) {
  if (!appData) return null;
  // Evaluate at the hour midpoint (t+30 min) — same as outlook() in app.js.
  // Top-of-hour sits on Kp 3-hour bin edges and biases MLT/sun by half an hour.
  const tm = new Date(tMs + HOUR_MS / 2);
  const now = Date.now();
  const mlat = geomagLat(lat, lon);
  const m = mlt(tm, lat, lon);
  const dark = darkness(sunAlt(tm, lat, lon));
  if (dark === 0) return 0;  // daylight

  const bin = appData.fc ? kpInBin(appData.fc, tm) : null;
  let kp = bin ? bin.kp : null;
  if (appData.kn && (tm - now) < 2 * HOUR_MS) kp = Math.max(kp ?? 0, appData.kn.kp);

  let pg = kp != null ? pGeo(kp, mlat, m) : null;
  if (appData.ov && (tm - now) < 1.5 * HOUR_MS) {
    const [over, horiz] = ovationAt(appData.ov.pts, lat, lon);
    pg = Math.max(pg ?? 0, Math.min(Math.max(over, 0.5 * horiz) / 100, P_CAP));
  }
  if (pg == null) return null;

  const [mAlt, mIll] = moonState(tm, lat, lon);
  const mf = moonFactor(mAlt, mIll);
  const pc = cloudsAtHour ? pClear(cloudsAtHour) : null;
  return pg * dark * mf * (pc ?? 1);
}

function fmtWhen(iso) {
  if (!iso) return "–";
  const d = new Date(iso.length === 16 ? iso + "Z" : iso);
  const base = `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UT`;
  // Show offset from now so it's obvious when the slider has moved off "now".
  const dh = Math.round((d - Date.now()) / 3600e3);
  if (dh === 0) return `${base} · now`;
  const sign = dh > 0 ? "+" : "";
  return `${base} · ${sign}${dh} h`;
}

let mapState = {
  cc: null,
  grid: null,
  world: null,
  proj: null,
  path: null,
  hour: 0,
  layer: "low",
  cellBounds: [],
};

async function render() {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#0a0a09";
  ctx.fillRect(0, 0, W, H);

  if (!mapState.grid || !mapState.world) return;

  // Bind this render's context to the path up front; avoids the chained
  // path.context(ctx)(feature) pattern that confused earlier versions.
  const path = geoPath(mapState.proj, ctx);

  const nordicNums = new Set(Object.values(ISO_NUM));
  const countries = feature(mapState.world, mapState.world.objects.countries);
  const nordics = {
    type: "FeatureCollection",
    features: countries.features.filter(f => f && f.id != null && nordicNums.has(String(f.id))),
  };

  // Land fill for Nordic countries (very subtle).
  ctx.beginPath();
  path(nordics);
  ctx.fillStyle = "rgba(60,60,55,0.35)";
  ctx.fill();

  // Grid cells, clipped to the active country's land so the tile pattern
  // doesn't bleed over the surrounding sea. One `clip()` is much cheaper than
  // intersecting cell polygons against country geometry.
  const active = nordics.features.find(f => String(f.id) === ISO_NUM[mapState.cc]);
  const h = mapState.hour;
  const half_lat = mapState.grid.lat_step / 2;
  const half_lon = mapState.grid.lon_step / 2;
  mapState.cellBounds = [];
  ctx.save();
  if (active) {
    ctx.beginPath();
    path(active);
    ctx.clip();
  }
  const isAurora = mapState.layer === "aurora";
  const idx = LAYER_IDX[mapState.layer] ?? 1;
  const vals = [];
  const proj = mapState.proj;
  const appData = window.auroraApp?.data;
  const tMs = mapState.grid.times[h] ? Date.parse(mapState.grid.times[h] + "Z") : Date.now();

  // Build a small bitmap, one pixel per grid cell. Browser bilinear filtering
  // on the subsequent drawImage turns the mosaic into a smooth gradient.
  const bbox = mapState.grid.bbox;  // [lat0, lon0, lat1, lon1]
  const latStep = mapState.grid.lat_step, lonStep = mapState.grid.lon_step;
  // `floor + 1` matches the Python grid generator, which stops before overshooting
  // lat1/lon1. Using `round` here left an empty top row that the bilinear filter
  // smeared halfway across the map (looked like missing data in the north).
  const cols = Math.floor((bbox[3] - bbox[1]) / lonStep + 1e-9) + 1;
  const rows = Math.floor((bbox[2] - bbox[0]) / latStep + 1e-9) + 1;
  const off = document.createElement("canvas");
  off.width = cols; off.height = rows;
  const octx = off.getContext("2d");
  const img = octx.createImageData(cols, rows);

  const rgba = (css) => {
    // Parse "rgba(r,g,b,a)" — the only format cloudColor / auroraColor emit.
    const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return [0, 0, 0, 0];
    return [+m[1], +m[2], +m[3], Math.round((m[4] != null ? +m[4] : 1) * 255)];
  };

  for (let i = 0; i < mapState.grid.cells.length; i++) {
    const c = mapState.grid.cells[i];
    const cloudsHere = c.clouds && c.clouds[h];
    let v, color;
    if (isAurora) {
      v = auroraChanceAt(c.lat, c.lon, tMs, appData, cloudsHere);
      if (v != null) vals.push(Math.round(v * 100));
      color = auroraColor(v);
    } else {
      v = cloudsHere ? cloudsHere[idx] : null;
      if (v != null) vals.push(v);
      color = cloudColor(v);
    }
    mapState.cellBounds.push([c.lat - half_lat, c.lon - half_lon, c.lat + half_lat, c.lon + half_lon]);
    if (!color) continue;
    const col = Math.round((c.lon - bbox[1]) / lonStep);
    // Image y grows southward, map lat grows northward -> flip.
    const row = rows - 1 - Math.round((c.lat - bbox[0]) / latStep);
    if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
    const pxIdx = (row * cols + col) * 4;
    const [r, g, b, a] = rgba(color);
    img.data[pxIdx] = r;
    img.data[pxIdx + 1] = g;
    img.data[pxIdx + 2] = b;
    img.data[pxIdx + 3] = a;
  }
  octx.putImageData(img, 0, 0);

  // Draw the small bitmap over the map area. Align the rectangle to the actual
  // cell-center extent (not the bbox corners) so the top/left pixels of the
  // bitmap line up with the northernmost/westernmost cell centers.
  const firstLat = bbox[0], firstLon = bbox[1];
  const lastLat = firstLat + (rows - 1) * latStep;
  const lastLon = firstLon + (cols - 1) * lonStep;
  const nw = proj([firstLon, lastLat]);
  const se = proj([lastLon, firstLat]);
  if (nw && se) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, nw[0], nw[1], se[0] - nw[0], se[1] - nw[1]);
  }
  ctx.restore();

  if (statsEl) {
    if (vals.length) {
      const mean = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      statsEl.textContent = `${LAYER_LABEL[mapState.layer]}: ${Math.min(...vals)}–${Math.max(...vals)}% across cells (mean ${mean}%)`;
    } else {
      statsEl.textContent = isAurora && !appData ? "Waiting for aurora data…" : "";
    }
  }
  if (legendLabel) legendLabel.textContent = LAYER_LABEL[mapState.layer];
  // Repaint the legend ramp to match the active layer's palette.
  const ramp = document.querySelector(".map-legend .ramp");
  if (ramp) {
    ramp.style.background = isAurora
      ? "linear-gradient(to right, rgba(57,135,229,0) 0%, rgba(57,135,229,1) 100%), #0a0a09"
      : "linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(128,128,128,0.5) 50%, rgba(255,255,255,1) 100%), #0a0a09";
  }

  // Place dots: one per preset in the active country, coloured by that place's
  // own aurora chance for the selected hour. Cloud is sampled from the nearest
  // grid cell. Draws above the cell layer but below borders/coast.
  drawPlaces(ctx, tMs, appData);

  // Internal borders between Nordic neighbours only, so the stroke stays local.
  const borders = mesh(
    mapState.world, mapState.world.objects.countries,
    (a, b) => a !== b && nordicNums.has(String(a.id)) && nordicNums.has(String(b.id)),
  );
  ctx.beginPath();
  path(borders);
  ctx.strokeStyle = "rgba(140,140,130,0.55)";
  ctx.lineWidth = 0.6;
  ctx.stroke();

  // Coast outline for the active country (re-use `active` found before the clip).
  if (active) {
    ctx.beginPath();
    path(active);
    ctx.strokeStyle = "rgba(220,220,210,0.7)";
    ctx.lineWidth = 1.0;
    ctx.stroke();
  }

  // Oval edges last so the green lines + labels sit above everything else.
  drawOvalEdges(ctx, tMs, appData);
}

function updateWhen() {
  const t = mapState.grid?.times?.[mapState.hour];
  whenLabel.textContent = fmtWhen(t);
}

function fitCanvasToParent() {
  const parent = canvas.parentElement;
  const w = Math.max(320, parent.clientWidth);
  const h = Math.round(w * (mapState.cc === "GL" ? 0.65 : 0.55));
  canvas.width = w;
  canvas.height = h;
}

function recomputeProjection() {
  if (!mapState.grid) return;
  mapState.proj = projectionFor(mapState.cc, mapState.grid.bbox, canvas.width, canvas.height);
  mapState.path = geoPath(mapState.proj);
}

async function loadFor(cc) {
  mapState.cc = cc;
  // Sync layer in case the browser auto-restored a previous dropdown selection
  // without firing a change event (common on back/forward and bfcache).
  if (layerSel) mapState.layer = layerSel.value || "low";
  whenLabel.textContent = "Loading grid…";
  try {
    const [grid, world] = await Promise.all([loadGrid(cc), loadWorld()]);
    mapState.grid = grid;
    mapState.world = world;
    // If the pre-built grid is empty (every batch 429'd during the CI build),
    // paint the country outline only and tell the user instead of leaving
    // the previous country's canvas up.
    if (!grid.times || grid.times.length === 0) {
      slider.max = 0;
      slider.value = 0;
      mapState.hour = 0;
      fitCanvasToParent();
      recomputeProjection();
      whenLabel.textContent = "No cloud data for this country right now — the grid rebuilds hourly.";
      render();
      return;
    }
    slider.max = Math.max(0, grid.times.length - 1);
    // Default the slider to the hour nearest "now", not the first grid hour
    // (which is 00:00 UTC of today — often already in the past).
    const now = Date.now();
    let nowIdx = 0, bestD = Infinity;
    for (let i = 0; i < grid.times.length; i++) {
      const d = Math.abs(Date.parse(grid.times[i] + "Z") - now);
      if (d < bestD) { bestD = d; nowIdx = i; }
    }
    slider.value = nowIdx;
    mapState.hour = nowIdx;
    fitCanvasToParent();
    recomputeProjection();
    updateWhen();
    render();
  } catch (e) {
    whenLabel.textContent = `Error: ${e.message}`;
  }
}

// Verdict colours resolved to literal hex so canvas can use them.
const VERDICT_COLOR = { GOOD: "#0ca30c", FAIR: "#fab219", POOR: "#ec835a", UNLIKELY: "#8f8e86" };

function drawOvalEdges(ctx, tMs, appData) {
  if (!appData?.fc) return;
  const t = new Date(tMs);
  // Find the forecast Kp for the selected hour. Falls back to nowcast if the
  // hour is within the first 2 h (same rule outlook() uses).
  let bin = null;
  for (const b of appData.fc) if (b.t <= t && t < new Date(+b.t + 3 * HOUR_MS)) { bin = b; break; }
  let kp = bin ? bin.kp : null;
  if (appData.kn && (tMs - Date.now()) < 2 * HOUR_MS) kp = Math.max(kp ?? 0, appData.kn.kp);
  if (kp == null) return;

  // Subsolar dipole longitude at time t: anchor for MLT -> magnetic longitude.
  const [ra, dec, gmst] = sunCoords(t);
  const DEG = 180 / Math.PI;
  const mlonSub = toDipole(dec * DEG, ra * DEG - gmst)[1];

  const N = 97;  // 24 h in 0.25 h steps, plus a closing point
  const eq = [], pole = [];
  for (let i = 0; i < N; i++) {
    const mltH = (i / (N - 1)) * 24;
    const mlon = mlonSub + (mltH - 12) * 15;
    const shift = MLT_AMP * (1 - Math.cos(2 * Math.PI * (mltH - MLT_MIN) / 24));
    const mlatEq = EDGE0 - EDGE_SLOPE * kp + shift;
    const mlatPole = mlatEq + POLE_WIDTH_BASE + POLE_WIDTH_PER_KP * kp;
    eq.push(fromDipole(mlatEq, mlon));
    pole.push(fromDipole(mlatPole, mlon));
  }

  const drawLine = (pts) => {
    ctx.beginPath();
    let pen = false, lastX = 0;
    for (const [lat, lon] of pts) {
      const xy = mapState.proj([lon, lat]);
      if (!xy || !isFinite(xy[0]) || !isFinite(xy[1])) { pen = false; continue; }
      // Break the line if a point jumps across the canvas (projection seam).
      if (pen && Math.abs(xy[0] - lastX) > ctx.canvas.width * 0.5) pen = false;
      if (!pen) { ctx.moveTo(xy[0], xy[1]); pen = true; }
      else ctx.lineTo(xy[0], xy[1]);
      lastX = xy[0];
    }
    ctx.stroke();
  };

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(60,220,110,0.9)";
  ctx.lineWidth = 1.6;
  drawLine(eq);
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "rgba(60,220,110,0.6)";
  ctx.lineWidth = 1.3;
  drawLine(pole);
  ctx.restore();

  // Place labels at the east end of the visible curve so they land in the
  // Russian/Barents area east of Finland instead of covering the country. As
  // the slider moves the oval north/south with Kp, the labels ride along.
  const W = ctx.canvas.width, Hc = ctx.canvas.height;
  const eastmostVisible = (pts) => {
    let best = null;
    for (const [lat, lon] of pts) {
      const xy = mapState.proj([lon, lat]);
      if (!xy || !isFinite(xy[0]) || !isFinite(xy[1])) continue;
      if (xy[0] < 0 || xy[0] > W || xy[1] < 10 || xy[1] > Hc - 10) continue;
      if (!best || xy[0] > best[0]) best = xy;
    }
    return best;
  };
  const labelAtXY = (xy, text, dy) => {
    if (!xy) return;
    // Nudge further east so the text sits clear of the country outline.
    const tx = Math.min(W - 6, xy[0] + 14);
    const ty = xy[1] + dy;
    ctx.save();
    ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = tx + 120 > W ? "right" : "left";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(10,10,9,0.9)";
    ctx.strokeText(text, tx, ty);
    ctx.fillStyle = "rgba(90,235,130,1)";
    ctx.fillText(text, tx, ty);
    ctx.restore();
  };
  labelAtXY(eastmostVisible(eq), `oval edge (Kp ${kp.toFixed(1)})`, -8);
  labelAtXY(eastmostVisible(pole), "poleward edge", -8);
}

function nearestCellCloudsAt(lat, lon, hour) {
  if (!mapState.grid) return null;
  let bestDist = Infinity, best = null;
  for (const c of mapState.grid.cells) {
    const dlat = c.lat - lat, dlon = c.lon - lon;
    const d = dlat * dlat + dlon * dlon;
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best && best.clouds ? best.clouds[hour] : null;
}

function drawPlaces(ctx, tMs, appData) {
  const places = window.auroraApp?.placesInCountry?.();
  if (!places) return;
  // Per-place cloud forecast (same one the "Where to go" table uses). Open-Meteo
  // is sampled at each place's exact lat/lon, which is strictly more accurate
  // than snapping to the nearest ~50 km grid cell. Falls back to nearest-cell
  // only while the rank cache is still loading.
  const rc = window.auroraApp?.rankClouds?.();
  const placeKeys = Object.keys(places);
  ctx.save();
  ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  placeKeys.forEach((key, i) => {
    const p = places[key];
    const [name, lat, lon] = p;
    const xy = mapState.proj([lon, lat]);
    if (!xy) return;
    const [x, y] = xy;
    const pointClouds = rc?.maps?.[i]?.get(tMs);
    const cloudsForDot = pointClouds ?? nearestCellCloudsAt(lat, lon, mapState.hour);
    const chance = auroraChanceAt(lat, lon, tMs, appData, cloudsForDot);
    const [vName] = chance != null ? verdict(chance) : ["UNLIKELY"];
    const fill = VERDICT_COLOR[vName] || VERDICT_COLOR.UNLIKELY;
    // Dot: filled with verdict colour, dark halo so it reads on any cloud shade.
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(10,10,9,0.9)";
    ctx.stroke();
    // Label: offset to the right, dark outline for contrast on bright cells.
    const label = chance != null ? `${name} ${Math.round(chance * 100)}%` : name;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(10,10,9,0.85)";
    ctx.strokeText(label, x + 8, y);
    ctx.fillStyle = "#f0efec";
    ctx.fillText(label, x + 8, y);
  });
  ctx.restore();
}

function onPointerMove(ev) {
  if (!mapState.grid) return;
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * canvas.width / rect.width;
  const y = (ev.clientY - rect.top) * canvas.height / rect.height;
  const inv = mapState.proj.invert([x, y]);
  if (!inv) { tip.style.display = "none"; return; }
  const [lon, lat] = inv;
  // Find containing cell.
  const half_lat = mapState.grid.lat_step / 2;
  const half_lon = mapState.grid.lon_step / 2;
  const cell = mapState.grid.cells.find(c => Math.abs(c.lat - lat) <= half_lat && Math.abs(c.lon - lon) <= half_lon);
  if (!cell || !cell.clouds) { tip.style.display = "none"; return; }
  const c = cell.clouds[mapState.hour];
  if (!c) { tip.style.display = "none"; return; }
  let extra = "";
  if (mapState.layer === "aurora") {
    const tMs = mapState.grid.times[mapState.hour] ? Date.parse(mapState.grid.times[mapState.hour] + "Z") : Date.now();
    // Must pass `c` (this cell's clouds for the hour) so the tooltip matches the
    // dot label and the background shading; omitting it gives a cloud-free number.
    const p = auroraChanceAt(cell.lat, cell.lon, tMs, window.auroraApp?.data, c);
    if (p != null) extra = `<br><b>Aurora chance: ${Math.round(p * 100)}%</b>`;
  }
  tip.innerHTML = `<b>${cell.lat.toFixed(1)}°N ${cell.lon.toFixed(1)}°E</b><br>low ${c[1] ?? "?"}% · mid ${c[2] ?? "?"}% · high ${c[3] ?? "?"}%<br>total ${c[0] ?? "?"}%${extra}`;
  tip.style.display = "block";
  tip.style.left = `${Math.min(ev.clientX - rect.left + 12, rect.width - 160)}px`;
  tip.style.top = `${ev.clientY - rect.top + 12}px`;
}

function init() {
  // Country changes: re-fetch grid.
  if (countrySel) {
    countrySel.addEventListener("change", () => loadFor(countrySel.value));
  }
  slider.addEventListener("input", () => {
    mapState.hour = +slider.value;
    updateWhen();
    render();
    // Tell the hourly chart to pin its crosshair at this hour.
    const iso = mapState.grid?.times?.[mapState.hour];
    if (iso) window.dispatchEvent(new CustomEvent("aurora:hour-set", { detail: { t: Date.parse(iso + "Z") } }));
  });
  // Hourly chart hover -> jump the map slider to that hour.
  window.addEventListener("aurora:hour-hover", (ev) => {
    const t = ev.detail?.t;
    if (t == null || !mapState.grid?.times?.length) return;
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < mapState.grid.times.length; i++) {
      const d = Math.abs(Date.parse(mapState.grid.times[i] + "Z") - t);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI === mapState.hour) return;
    mapState.hour = bestI;
    slider.value = bestI;
    updateWhen();
    render();
  });
  if (layerSel) {
    layerSel.addEventListener("change", () => {
      mapState.layer = layerSel.value;
      render();
    });
  }
  // app.js dispatches this once its Kp/OVATION/solar-wind data has loaded,
  // which the aurora-chance layer needs.
  window.addEventListener("aurora:data", () => {
    if (mapState.layer === "aurora") render();
  });
  // Per-place cloud forecasts arrive after the main data. Repaint so the place
  // dot numbers switch from nearest-cell fallback to the exact per-point values.
  window.addEventListener("aurora:rank-ready", () => render());
  canvas.addEventListener("mousemove", onPointerMove);
  canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; });

  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      fitCanvasToParent();
      recomputeProjection();
      render();
    }, 150);
  });

  // app.js initialises mapState.country in its own startup; wait a tick to pick it up.
  const start = () => {
    const cc = countrySel?.value || "FI";
    loadFor(cc);
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}
