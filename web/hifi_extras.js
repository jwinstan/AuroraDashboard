// Hi-fi-only panels: SDO solar imagery, STEREO HI, GOES X-ray flux, ensemble Kp.
// Uses getJSON (through /proxy on --serve) for JSON; direct <img src> for raster.

import { getJSON, rows, ptime } from "./sources.js";
import { chart, sw, hourTicks } from "./charts.js";

const H = 3600e3;
const utFmt = t => t.toISOString().slice(11, 16);

// ---- SDO solar imagery ------------------------------------------------------
// 193Å shows coronal holes (dark) and quiet corona; 211Å highlights active regions
// and coronal-hole boundaries. Latest 1024px frames; SDO updates ~every 12 min.
const SDO_IMAGES = [
  { wl: "0193", label: "AIA 193Å — coronal holes (dark patches = high-speed stream source)" },
  { wl: "0211", label: "AIA 211Å — active regions and CH boundaries" },
];

function sdoUrl(wl) {
  const base = `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_${wl}.jpg`;
  // Cache-bust once per 5 min so we don't pin a stale frame in the browser cache.
  const bust = Math.floor(Date.now() / (5 * 60e3));
  // Route through the proxy on --serve so it benefits from server-side caching.
  // The static build marks itself with <meta name="aurora-static-deploy"> so we
  // skip the (non-existent) proxy when previewing build/ locally.
  const isStaticDeploy = !!document.querySelector('meta[name="aurora-static-deploy"]');
  const viaProxy = !isStaticDeploy && location.protocol.startsWith("http") && ["localhost", "127.0.0.1"].includes(location.hostname);
  return viaProxy ? `/proxy?u=${encodeURIComponent(base)}&v=${bust}` : `${base}?v=${bust}`;
}

// SDO AIA 1024-px latest frames have the Sun centered with disc radius ~400 px.
// The ±30° longitude strip (where eruptions are Earth-geoeffective) projects to
// an ellipse of horizontal semi-axis R·sin(30°) = 200 and vertical semi-axis R.
const SDO_OVERLAY = `
  <svg class="sdo-overlay" viewBox="0 0 1024 1024" preserveAspectRatio="none" aria-hidden="true">
    <line x1="512" y1="112" x2="512" y2="912" stroke="rgba(240,240,220,0.35)" stroke-dasharray="4,5" stroke-width="1"/>
    <line x1="112" y1="512" x2="912" y2="512" stroke="rgba(240,240,220,0.35)" stroke-dasharray="4,5" stroke-width="1"/>
    <ellipse cx="512" cy="512" rx="200" ry="400" fill="rgba(60,220,110,0.07)" stroke="rgba(90,235,130,0.65)" stroke-width="1.5" stroke-dasharray="6,4"/>
    <circle cx="512" cy="512" r="3" fill="rgba(240,240,220,0.7)"/>
  </svg>
`;

function renderSdo() {
  const host = document.getElementById("sdo-body");
  if (!host) return;
  host.innerHTML = SDO_IMAGES.map(({ wl, label }) => `
    <div class="sdo-cell">
      <div class="sdo-wrap">
        <img src="${sdoUrl(wl)}" alt="${label}" loading="lazy">
        ${SDO_OVERLAY}
      </div>
      <div class="sub small">${label}</div>
    </div>
  `).join("");
}

// ---- GOES X-ray flux chart --------------------------------------------------
async function renderXray() {
  const host = document.getElementById("xray-chart");
  if (!host) return;
  try {
    const raw = await getJSON("https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json");
    if (!raw || !raw.length) {
      host.innerHTML = `<div class="sub small">GOES X-ray: no data in the last day.</div>`;
      return;
    }
    const long = raw.filter(r => r.energy === "0.1-0.8nm");
    const shortRaw = raw.filter(r => r.energy === "0.05-0.4nm");
    if (!long.length) throw new Error("no long-band samples");
    // Pair the short band to the long band by time_tag. SWPC usually delivers
    // paired samples, but a one-off dropout in either band would otherwise either
    // mis-align the series or blank the short trace entirely.
    const shortByTime = new Map(shortRaw.map(r => [r.time_tag, r]));
    const x = long.map(r => ptime(r.time_tag));
    const logFlux = v => v > 0 ? Math.log10(v) : null;
    const longY = long.map(r => logFlux(r.flux));
    const shortMatched = long.map(r => shortByTime.get(r.time_tag) || null);
    const shortY = shortMatched.map(r => r ? logFlux(r.flux) : null);
    const hasShort = shortY.some(v => v != null);
    const yMin = -9, yMax = -3;
    chart(host, {
      label: "GOES X-ray flux (W/m², log scale)", x, height: 200,
      yMin, yMax, yTicks: [-8, -7, -6, -5, -4],
      fmtY: v => ["A", "B", "C", "M", "X"][v + 8] ?? "",
      xTicks: hourTicks, fmtX: t => utFmt(t), nowX: x.length - 1,
      syncGroup: "solar",  // sibling proton chart pins its crosshair here on hover
      series: [
        { name: "Long (0.1–0.8 nm)", type: "line", color: "var(--series-1)", values: longY },
        ...(hasShort ? [{ name: "Short (0.05–0.4 nm)", type: "line", color: "var(--series-2)", values: shortY }] : []),
      ],
      tip: i => {
        const lf = long[i].flux;
        const sf = shortMatched[i]?.flux;
        const lLine = `${sw("var(--series-1)", 1)}Long ${lf.toExponential(2)} W/m² (${fluxClass(lf)})`;
        const sLine = sf ? `<br>${sw("var(--series-2)", 1)}Short ${sf.toExponential(2)} W/m²` : "";
        return `<b>${utFmt(x[i])} UT</b><br>${lLine}${sLine}`;
      },
    });
  } catch (e) {
    host.innerHTML = `<div class="errors">GOES X-ray: ${e.message}</div>`;
  }
}

// ---- GOES proton flux chart -------------------------------------------------
// Three integral channels: >=10, >=50, >=100 MeV. The NOAA S-scale (S1..S5) is
// defined on >=10 MeV flux in pfu = particles / cm^2 / s / sr; each S-step is
// one decade. Background sits at ~0.1 pfu, S1 starts at 10 pfu.
async function renderProtons() {
  const host = document.getElementById("protons-chart");
  if (!host) return;
  try {
    const raw = await getJSON("https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json");
    if (!raw || !raw.length) {
      host.innerHTML = `<div class="sub small">GOES protons: no data in the last day (quiet SEP background).</div>`;
      return;
    }
    const CHANNELS = [
      { match: /10\s*MeV/i,  name: ">=10 MeV (S-scale)", color: "var(--series-1)" },
      { match: /50\s*MeV/i,  name: ">=50 MeV",           color: "var(--series-2)" },
      { match: /100\s*MeV/i, name: ">=100 MeV",          color: "var(--series-3)" },
    ];
    const anchor = raw.filter(r => CHANNELS[0].match.test(r.energy ?? ""));
    if (!anchor.length) throw new Error("no >=10 MeV samples");
    const x = anchor.map(r => ptime(r.time_tag));
    const times = anchor.map(r => r.time_tag);
    const logFlux = v => v > 0 ? Math.log10(v) : null;
    const series = [];
    const perChannel = {};  // name -> fluxes aligned to `times`
    for (const ch of CHANNELS) {
      const rs = raw.filter(r => ch.match.test(r.energy ?? ""));
      if (!rs.length) continue;
      const byT = new Map(rs.map(r => [r.time_tag, r.flux]));
      const fluxes = times.map(tt => byT.get(tt) ?? null);
      perChannel[ch.name] = fluxes;
      series.push({ name: ch.name, type: "line", color: ch.color, values: fluxes.map(logFlux) });
    }
    if (!series.length) throw new Error("no proton channels matched");
    const S_LABELS = { 1: "S1", 2: "S2", 3: "S3", 4: "S4", 5: "S5" };
    chart(host, {
      label: "GOES integral proton flux (pfu, log scale)", x, height: 200,
      yMin: -2, yMax: 5, yTicks: [-1, 0, 1, 2, 3, 4, 5],
      fmtY: v => S_LABELS[v] || (v === 0 ? "1" : v === -1 ? "0.1" : ""),
      xTicks: hourTicks, fmtX: t => utFmt(t), nowX: x.length - 1,
      syncGroup: "solar",  // hover syncs with X-ray chart above
      // When the X-ray chart broadcasts a hovered UT, shade the window where an
      // SEP from that event would arrive: ~20 min (100 MeV) to ~60 min (10 MeV)
      // at 1 AU, assuming good magnetic connectivity to the flare footpoint.
      arrivalBand: { minLagMs: 20 * 60e3, maxLagMs: 60 * 60e3 },
      series,
      tip: i => {
        const lines = series.map(s => {
          const f = perChannel[s.name][i];
          const cell = f == null ? "—" : `${f.toExponential(2)} pfu`;
          return `${sw(s.color, 1)}${s.name}: ${cell}`;
        });
        // Annotate S-scale on the primary channel when above threshold.
        const f10 = perChannel[CHANNELS[0].name][i];
        if (f10 != null && f10 >= 10) {
          const sLevel = Math.min(5, Math.floor(Math.log10(f10)));
          lines[0] += ` (S${sLevel})`;
        }
        return `<b>${utFmt(x[i])} UT</b><br>${lines.join("<br>")}`;
      },
    });
  } catch (e) {
    host.innerHTML = `<div class="errors">GOES protons: ${e.message}</div>`;
  }
}

// Classify a soft X-ray flux into the standard letter + mantissa format.
// Each letter spans one decade; the mantissa is the flux expressed in units of
// that letter's base decade (so X15 = 1.5e-3, A0.3 = 3e-9). The previous
// implementation walked floor(log10(f)) and lost this normalisation at the ends,
// reporting X15 as X1.5 and sub-A flux with A's mantissa off by 10x.
function fluxClass(f) {
  if (!f || f <= 0) return "below A";
  const LETTERS = [["X", 1e-4], ["M", 1e-5], ["C", 1e-6], ["B", 1e-7], ["A", 1e-8]];
  for (const [letter, base] of LETTERS) {
    if (f >= base) return `${letter}${(f / base).toFixed(1)}`;
  }
  return `A${(f / 1e-8).toFixed(1)}`;  // sub-A: report against A's base
}

// ---- Ensemble Kp: persistence baseline alongside SWPC forecast --------------
// Adds a persistence line (current Kp, held constant) to the Kp chart that
// app.js already renders. Updates whenever the main render fires.
function renderEnsemble() {
  const kpChart = document.getElementById("c-kp");
  if (!kpChart || !window.auroraApp?.data) return;
  const d = window.auroraApp.data;
  if (!d.fc || !d.fc.length || !d.kn) return;
  // Draw a note under the Kp chart explaining what's "ensemble" about it.
  let note = document.getElementById("kp-ensemble-note");
  if (!note) {
    note = document.createElement("div");
    note.id = "kp-ensemble-note";
    note.className = "sub small";
    note.style.marginTop = "6px";
    kpChart.parentElement?.appendChild(note);
  }
  const persistence = d.kn.kp.toFixed(2);
  const swpcNext = (d.fc.find(b => b.t > new Date() && b.obs === "predicted")?.kp ?? NaN).toFixed(2);
  note.innerHTML = `
    <b>Ensemble baselines</b> · persistence (hold current): Kp ≈ ${persistence}
    · next SWPC-predicted bin: Kp ≈ ${swpcNext}.
    A large gap between SWPC and persistence means NOAA sees a driver (CME, HSS) that persistence can't.
  `;
}

// ---- Hi-fi map grid: ask the server for the 4× resolution grid --------------
// map.js's loadCountryGrid fetches /grid?country=XX. Monkey-patch that fetch
// to append hifi=1 so we get the denser cache file.
(function patchGridFetch() {
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === "string" && input.startsWith("/grid?")) {
      input += (input.includes("hifi=") ? "" : "&hifi=1");
    }
    return origFetch.call(this, input, init);
  };
})();

// ---- init -------------------------------------------------------------------
function ensureStyle() {
  if (document.getElementById("hifi-style")) return;
  const s = document.createElement("style");
  s.id = "hifi-style";
  s.textContent = `
    .sdo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 760px) { .sdo-grid { grid-template-columns: 1fr; } }
    .sdo-wrap { position: relative; line-height: 0; }
    .sdo-wrap img { width: 100%; border-radius: 6px; background: #0a0a09; display: block; }
    .sdo-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  `;
  document.head.appendChild(s);
}

function initHifi() {
  ensureStyle();
  renderSdo();
  renderXray();
  renderProtons();
  renderEnsemble();
  // Refresh imagery on the main data cycle (5-min auto-refresh).
  window.addEventListener("aurora:data", () => {
    renderSdo();
    renderXray();
    renderProtons();
    renderEnsemble();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initHifi);
} else {
  initHifi();
}
