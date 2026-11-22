// Data fetchers for NOAA SWPC, Open-Meteo, MET Norway. Routes through local proxy when served from 127.0.0.1.

import { median, newell, L1_KM } from "./model.js";

const SWPC = "https://services.swpc.noaa.gov";
export const URLS = {
  mag: [`${SWPC}/json/rtsw/rtsw_mag_1m.json`, `${SWPC}/products/solar-wind/mag-1-day.json`],
  wind: [`${SWPC}/json/rtsw/rtsw_wind_1m.json`, `${SWPC}/products/solar-wind/plasma-1-day.json`],
  kpFc: [`${SWPC}/products/noaa-planetary-k-index-forecast.json`],
  kpNow: [`${SWPC}/json/planetary_k_index_1m.json`],
  ovation: [`${SWPC}/json/ovation_aurora_latest.json`],
};
export const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
export const METNO = "https://api.met.no/weatherapi/locationforecast/2.0/complete";

// Only use the --serve proxy when we're actually behind one. The static build
// (served from file:// or a plain http.server, or from GitHub Pages) marks
// itself with <meta name="aurora-static-deploy"> so we don't try to hit a
// non-existent /proxy endpoint. The hostname check alone was insufficient
// because local testing of build/ via python -m http.server is also 127.0.0.1.
const isStaticDeploy = !!document.querySelector('meta[name="aurora-static-deploy"]');
const viaProxy = !isStaticDeploy && location.protocol.startsWith("http") && ["localhost", "127.0.0.1"].includes(location.hostname);

export async function getJSON(url) {
  const tries = viaProxy ? [`/proxy?u=${encodeURIComponent(url)}`, url] : [url];
  let err;
  for (const u of tries) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(u, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        if (!text.trim()) return null;  // SWPC occasionally returns empty bodies during quiet periods.
        return parseLenient(text);
      } catch (e) { err = e; }
    }
  }
  throw new Error(`${new URL(url).hostname}${new URL(url).pathname}: ${err && err.message}`);
}

// NOAA SWPC occasionally serves a payload with a stray trailing byte (e.g. an
// extra newline-after-close, or two responses concatenated); the JSON is valid
// up through its final `]`/`}` but strict JSON.parse rejects it. If that
// happens, truncate at the matching close so the day's data still renders
// instead of blanking the panel until the next hourly fetch.
function parseLenient(text) {
  try { return JSON.parse(text); }
  catch (e) {
    const trimmed = text.trimEnd();
    try { return JSON.parse(trimmed); } catch {}
    const last = Math.max(trimmed.lastIndexOf("]"), trimmed.lastIndexOf("}"));
    if (last > 0) return JSON.parse(trimmed.slice(0, last + 1));
    throw e;
  }
}

async function firstOf(urls) {
  let e;
  for (const u of urls) { try { return await getJSON(u); } catch (x) { e = x; } }
  throw e;
}

export function rows(data) {
  if (!Array.isArray(data) || !data.length) return [];
  if (Array.isArray(data[0])) { const h = data[0]; return data.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); }
  return data;
}

export function activeRows(rs) {
  if (rs.some(r => "active" in r)) {
    const a = rs.filter(r => r.active === true || r.active === 1 || r.active === "true" || r.active === "True");
    return a.length ? a : rs;
  }
  return rs;
}

export function num(d, ...keys) {
  for (const k of keys) {
    const v = d[k];
    if (v === null || v === undefined || v === "") continue;
    const x = Number(v);
    if (Number.isFinite(x)) return x;
  }
  return null;
}

export function ptime(s) {
  let t = String(s).trim().replace(" ", "T");
  if (!/([zZ]|[+-]\d\d:?\d\d)$/.test(t)) t += "Z";
  const d = new Date(t);
  if (isNaN(d)) throw new Error(`bad time ${s}`);
  return d;
}

export async function solarWind() {
  const [mag, wind] = await Promise.all([firstOf(URLS.mag), firstOf(URLS.wind)]);
  const series = (rs, spec) => {
    const out = [];
    for (const r of activeRows(rows(rs))) {
      let t; try { t = ptime(r.time_tag); } catch { continue; }
      const vals = spec.map(k => num(r, ...k));
      if (vals.every(v => v !== null)) out.push([t, ...vals]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  };
  const m = series(mag, [["bz_gsm"], ["by_gsm"], ["bt"]]);
  const w = series(wind, [["proton_speed", "speed"], ["proton_density", "density"]]);
  if (!m.length || !w.length) throw new Error("no valid L1 samples");
  const last = (s, min) => { const tl = s[s.length - 1][0]; return s.filter(x => tl - x[0] <= min * 60e3); };
  const m30 = last(m, 30), w30 = last(w, 30);
  const v = median(w30.map(x => x[1])), n = median(w30.map(x => x[2]));
  const bz = m30.map(x => x[1]);
  const src = [...activeRows(rows(mag))].reverse().find(r => r.source)?.source || "L1";
  return {
    source: src,
    ageMin: (Date.now() - Math.max(m[m.length - 1][0], w[w.length - 1][0])) / 60e3,
    bzMean: bz.reduce((a, b) => a + b, 0) / bz.length,
    bzMin: Math.min(...bz),
    fracSouth: bz.filter(b => b < 0).length / bz.length,
    bt: m30.reduce((a, x) => a + x[3], 0) / m30.length,
    v, n,
    newell: m30.reduce((a, x) => a + newell(v, x[3], x[2], x[1]), 0) / m30.length,
    delayMin: L1_KM / v / 60,
    mag6: last(m, 360), wind6: last(w, 360),
  };
}

export async function kpForecast() {
  const out = [];
  for (const r of rows(await firstOf(URLS.kpFc))) {
    const kp = num(r, "kp", "Kp");
    if (kp === null) continue;
    try { out.push({ t: ptime(r.time_tag), kp, obs: String(r.observed || "") }); } catch {}
  }
  return out.sort((a, b) => a.t - b.t);
}

export function kpInBin(fc, t) {
  for (const b of fc) if (b.t <= t && t < new Date(+b.t + 3 * 3600e3)) return b;
  return null;
}

export async function kpNow() {
  const rs = rows(await firstOf(URLS.kpNow));
  for (let i = rs.length - 1; i >= 0; i--) {
    const k = num(rs[i], "estimated_kp", "kp_index");
    if (k !== null) return { kp: k, t: ptime(rs[i].time_tag) };
  }
  throw new Error("no Kp nowcast");
}

export async function ovation() {
  const d = await firstOf(URLS.ovation);
  return { pts: d.coordinates.filter(p => p[1] >= 50 && p[1] <= 80), time: d["Forecast Time"] };
}

const CL_KEYS = ["cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"];

function parseOpenMeteo(o) {
  const h = o.hourly, map = new Map();
  h.time.forEach((ts, i) => map.set(+ptime(ts), CL_KEYS.map(k => h[k] ? h[k][i] : null)));
  return map;
}

async function cloudsOpenMeteo(pts, model) {
  const q = new URLSearchParams({
    latitude: pts.map(p => p[0]).join(","), longitude: pts.map(p => p[1]).join(","),
    timezone: "UTC", forecast_days: 3, hourly: CL_KEYS.join(","),
  });
  if (model) q.set("models", model);
  const d = await getJSON(`${OPEN_METEO}?${q}`);
  return (Array.isArray(d) ? d : [d]).map(parseOpenMeteo);
}

async function cloudsMetno(lat, lon) {
  const d = await getJSON(`${METNO}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
  const map = new Map();
  for (const e of d.properties.timeseries) {
    const x = e.data.instant.details;
    map.set(+ptime(e.time), [x.cloud_area_fraction, x.cloud_area_fraction_low, x.cloud_area_fraction_medium, x.cloud_area_fraction_high].map(v => v ?? null));
  }
  return map;
}

export async function clouds(pts, source, model, errors) {
  const order = { auto: ["openmeteo", "metno"], openmeteo: ["openmeteo"], metno: ["metno"] }[source];
  for (const src of order) {
    try {
      const maps = src === "openmeteo" ? await cloudsOpenMeteo(pts, model)
        : await Promise.all(pts.map(p => cloudsMetno(p[0], p[1])));
      if (maps.length === pts.length) return { maps, src };
    } catch (e) { errors.push(`Clouds (${src}): ${e.message}`); }
  }
  return { maps: pts.map(() => new Map()), src: null };
}

// ---- Active events: SWPC alerts + NASA DONKI CMEs ---------------------------
// Mirrors aurora.sources.swpc_alerts / donki_cmes.

const DONKI_CCMC = "https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get";
const DONKI_NASA = "https://api.nasa.gov/DONKI";
// NASA API key is injected server-side by the --serve proxy (reads NASA_API_KEY env var).
// Direct file:// use falls back to DEMO_KEY implicitly (api.nasa.gov default).
const CME_CLIMATOLOGICAL_HALFWIDTH_H = 8.0;

const ALERT_KINDS = { ALT: "ALERT", WAT: "WATCH", WAR: "WARNING", EXT: "EXTENDED", SUM: "SUMMARY" };
const ALERT_HEADLINE_PREFIXES = [
  "ALERT:", "WATCH:", "WARNING:", "EXTENDED WARNING:", "SUMMARY:",
  "CONTINUED ALERT:", "CANCEL WARNING:",
];
const FIELD_PREFIXES = {
  thresholdReached: "Threshold Reached:",
  validFrom: "Valid From:",
  validTo: "Valid To:",
  validUntil: "Valid Until:",
  nowValidUntil: "Now Valid Until:",
  synopticPeriod: "Synoptic Period:",
  activeWarning: "Active Warning:",
  predictedArrival: "Predicted Arrival:",
};
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// SWPC alert body times look like "2026 Nov 19 0900 UTC".
export function parseSwpcTime(s) {
  const m = String(s).match(/(\d{4})\s+(\w{3})\s+(\d{1,2})\s+(\d{2})(\d{2})/);
  if (!m) return null;
  const mo = MONTHS[m[2]];
  if (mo === undefined) return null;
  return new Date(Date.UTC(+m[1], mo, +m[3], +m[4], +m[5]));
}

// Explicit Valid To / Now Valid Until / Valid Until, otherwise infer from
// Synoptic Period (HHMM-HHMM) anchored to the Threshold Reached date.
export function alertExpiry(fields) {
  const explicit = fields.validTo || fields.nowValidUntil || fields.validUntil;
  if (explicit) {
    const t = parseSwpcTime(explicit);
    if (t) return t;
  }
  const period = fields.synopticPeriod, reached = parseSwpcTime(fields.thresholdReached);
  if (period && reached) {
    const m = period.match(/^\s*(\d{4})\s*-\s*(\d{4})\s*$/);
    if (m) {
      const endHH = +m[2].slice(0, 2), endMM = +m[2].slice(2);
      return new Date(Date.UTC(reached.getUTCFullYear(), reached.getUTCMonth(), reached.getUTCDate(), endHH, endMM));
    }
  }
  return null;
}

function parseAlertMessage(msg) {
  let kind = null, headline = "";
  const fields = {};
  for (const line of String(msg || "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (kind === null && s.startsWith("Space Weather Message Code:")) {
      kind = ALERT_KINDS[s.split(":", 2)[1].trim().slice(0, 3).toUpperCase()] || null;
      continue;
    }
    if (!headline && ALERT_HEADLINE_PREFIXES.some(p => s.startsWith(p))) headline = s;
    for (const [name, prefix] of Object.entries(FIELD_PREFIXES)) {
      if (!(name in fields) && s.startsWith(prefix)) fields[name] = s.slice(prefix.length).trim();
    }
  }
  return { kind, headline, fields };
}

async function tryUrls(urls) {
  let err;
  for (const u of urls) {
    try {
      const data = await getJSON(u);
      return { data, from: new URL(u).hostname };
    } catch (e) { err = e; }
  }
  throw err;
}

const CACHE_PREFIX = "aurora-fi:events:";
function cacheGet(key, ttlMs) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { at, data, from } = JSON.parse(raw);
    if (Date.now() - at > ttlMs) return null;
    return { data, from, cacheAgeMin: (Date.now() - at) / 60e3 };
  } catch { return null; }
}
function cacheSet(key, data, from) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data, from })); } catch {}
}

// Human-readable context for an alert product_id, phrased for a Nordic viewer.
export function describeAlert(code) {
  const k = code.match(/^K(\d\d)[AW]$/);
  if (k) {
    const level = parseInt(k[1], 10);
    const table = {
      4: ["info",     "Kp 4 — unsettled, no storm. Aurora overhead in Lapland (~66° N and north) when dark."],
      5: ["warn",     "Kp 5 = G1 minor storm. Aurora overhead across the Nordics; faint glow possible to southern Finland and the Baltic."],
      6: ["warn",     "Kp 6 = G2 moderate storm. Aurora overhead mid-Nordics; visible to the UK, Denmark, northern Germany."],
      7: ["serious",  "Kp 7 = G3 strong storm. Aurora visible mid-Europe; overhead across the Nordics."],
      8: ["serious",  "Kp 8 = G4 severe storm. Aurora possible to central Europe, overhead across most of the Nordics."],
      9: ["critical", "Kp 9 = G5 extreme storm. Aurora possible to the Mediterranean and US mid-latitudes."],
    };
    return table[level] || ["warn", `Kp ${level} geomagnetic level.`];
  }
  if (code.startsWith("EF")) return ["info", "Electron flux ≥2 MeV elevated — satellite anomaly risk at GEO. No direct aurora impact."];
  if (code.startsWith("TII")) return ["warn", "Type II radio sweep — CME shock wave leaving the Sun. Possible Earth impact in 1–3 days."];
  if (code.startsWith("TIV")) return ["warn", "Type IV radio burst — flare continuum, often CME-associated."];
  if (code.startsWith("A20") || code.startsWith("A50")) return ["info", "A-index forecast elevated — day expected to be geomagnetically active."];
  if (/^S\d/.test(code)) return ["serious", "Solar radiation storm — energetic protons. Satellite + polar HF impacts; no direct aurora relevance."];
  if (/^G\d/.test(code)) return ["warn", "Geomagnetic storm scale alert."];
  if (/^R\d/.test(code)) return ["info", "Radio blackout — HF propagation degraded on the dayside. Not aurora-related."];
  return ["info", ""];
}

export async function swpcAlerts({ hoursBack = 48, skipKinds = new Set(["SUMMARY"]), hideExpired = true } = {}) {
  const now = new Date();
  const cutoff = new Date(+now - hoursBack * 3600e3);
  const raw = rows(await getJSON(`${SWPC}/products/alerts.json`));
  const out = [];
  for (const r of raw) {
    let t; try { t = ptime(r.issue_datetime); } catch { continue; }
    if (t < cutoff) continue;
    const { kind, headline, fields } = parseAlertMessage(r.message);
    if (!kind || skipKinds.has(kind)) continue;
    if (hideExpired) {
      const expiry = alertExpiry(fields);
      if (expiry && expiry < now) continue;
    }
    const code = String(r.product_id || "").trim();
    const [severity, desc] = describeAlert(code);
    out.push({ time: t, code, kind, summary: headline, desc, severity, fields });
  }
  return out.sort((a, b) => a.time - b.time);
}

function cmePickAnalysis(analyses) {
  if (!analyses || !analyses.length) return null;
  const best = analyses.find(a => a.isMostAccurate);
  return best || analyses[analyses.length - 1];
}

function enlilArrivals(enlilList) {
  const out = [];
  for (const e of enlilList || []) {
    const s = e.estimatedShockArrivalTime;
    if (!s) continue;
    try { out.push(ptime(s)); } catch {}
  }
  return out.sort((a, b) => a - b);
}

function arrivalCentreHalfwidth(times) {
  const mid = times[Math.floor(times.length / 2)];
  if (times.length === 1) return { mid, halfH: CME_CLIMATOLOGICAL_HALFWIDTH_H };
  const spanH = (times[times.length - 1] - times[0]) / 3600e3;
  return { mid, halfH: Math.max(spanH / 2, 4.0) };
}

// Read cache ignoring TTL — used for stale-while-revalidate.
function cacheGetAny(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { at, data, from } = JSON.parse(raw);
    return { data, from, cacheAgeMin: (Date.now() - at) / 60e3 };
  } catch { return null; }
}

async function fetchCmes(qs) {
  // Prefer the GitHub-Pages pre-baked file (fetched at deploy time with the
  // real NASA_API_KEY) so visitors don't share the public DEMO_KEY bucket.
  // The build widens the date window beyond what the browser asks for, so
  // cmesOut's own filtering still trims to the requested window.
  if (isStaticDeploy) {
    try {
      const r = await fetch("./donki/cmes.json", { cache: "no-store" });
      if (r.ok) {
        const data = await r.json();
        return { data, from: "donki/cmes.json" };
      }
    } catch { /* fall through to live endpoint */ }
  }
  // api.nasa.gov requires api_key on every request; DEMO_KEY is the public
  // throttled fallback. The --serve proxy swaps this for NASA_API_KEY when set
  // in env ([aurora_fi.py:202-208]), so this works on both static and --serve.
  // kauai.ccmc.gsfc.nasa.gov has no CORS, so only usable via the proxy.
  const nasaQs = qs.includes("api_key=") ? qs : `${qs}&api_key=DEMO_KEY`;
  const urls = [`${DONKI_NASA}/CME?${nasaQs}`];
  if (viaProxy) urls.push(`${DONKI_CCMC}/CME?${qs}`);
  const r = await tryUrls(urls);
  return r;
}

function cmesOut(data, source, now, windowBeforeH, windowAfterH) {
  const out = [];
  out._source = source;
  for (const cme of data || []) {
    const analysis = cmePickAnalysis(cme.cmeAnalyses || []);
    if (!analysis) continue;
    const arrivals = enlilArrivals(analysis.enlilList);
    if (!arrivals.length) continue;
    const { mid, halfH } = arrivalCentreHalfwidth(arrivals);
    const earliest = new Date(+now - windowBeforeH * 3600e3);
    const latest = new Date(+now + windowAfterH * 3600e3);
    if (mid < earliest || mid > latest) continue;
    let launch; try { launch = ptime(cme.startTime); } catch { continue; }
    out.push({
      launch,
      source: (cme.sourceLocation || "").trim() || "?",
      ar: cme.activeRegionNum,
      speed: analysis.speed,
      halfAngle: analysis.halfAngle,
      type: analysis.type,
      note: (cme.note || "").trim(),
      arrival: mid,
      arrivalErrH: halfH,
      nRuns: arrivals.length,
    });
  }
  return out.sort((a, b) => a.arrival - b.arrival);
}

// Stale-while-revalidate: returns fresh cache immediately, or kicks off a
// background fetch that resolves via onFresh() when done.
export async function donkiCmes({ daysBack = 4, windowBeforeH = 12, windowAfterH = 72,
                                  freshMinutes = 15, onFresh = null } = {}) {
  const now = new Date();
  const end = new Date(now); end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - (daysBack + 1));
  const iso = d => d.toISOString().slice(0, 10);
  const qs = `startDate=${iso(start)}&endDate=${iso(end)}`;
  const cacheKey = `cme:${qs}`;
  const fresh = cacheGet(cacheKey, freshMinutes * 60e3);
  const stale = fresh || cacheGetAny(cacheKey);

  // Fire a background revalidation when we're serving stale, or when nothing
  // was cached at all (first-ever call).
  if (!fresh) {
    (async () => {
      try {
        const r = await fetchCmes(qs);
        cacheSet(cacheKey, r.data, r.from);
        if (onFresh) {
          const out = cmesOut(r.data, { from: r.from, cacheAgeMin: 0 }, new Date(), windowBeforeH, windowAfterH);
          onFresh(out);
        }
      } catch (e) { if (onFresh) onFresh(null, e); }
    })();
  }

  if (stale) return cmesOut(stale.data, { from: stale.from, cacheAgeMin: stale.cacheAgeMin }, now, windowBeforeH, windowAfterH);

  // Nothing cached: block on the first fetch so the caller gets a real result.
  const r = await fetchCmes(qs);
  cacheSet(cacheKey, r.data, r.from);
  return cmesOut(r.data, { from: r.from, cacheAgeMin: 0 }, now, windowBeforeH, windowAfterH);
}
