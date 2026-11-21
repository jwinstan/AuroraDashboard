// UI glue: state, controls, render loop. Uses model.js + sources.js + charts.js.

import {
  geomagLat, mlt, sunAlt, moonState, moonFactor, kpNeeded, pGeo, pClear, verdict,
  ovationAt, darkness, couplingLabel,
} from "./model.js";
import { solarWind, kpForecast, kpNow, ovation, clouds, kpInBin } from "./sources.js";
import { chart, sw, despike, niceStep, hourTicks } from "./charts.js";
import { loadAacgm, setAacgmGrid } from "./aacgm.js";

const H = 3600e3;

async function loadPlaces() {
  if (window.__PLACES__) return window.__PLACES__;
  const r = await fetch("./config/places.json", { cache: "no-store" });
  return await r.json();
}

let CONFIG;
let PLACES = {};         // key -> [displayName, lat, lon, cc, tz]

function flatten(cfg) {
  const out = {};
  for (const [cc, c] of Object.entries(cfg.countries)) {
    for (const [k, p] of Object.entries(c.places)) out[k] = [p.name, p.lat, p.lon, cc, p.tz || c.tz];
  }
  return out;
}

function placesInCountry(cc) {
  return Object.fromEntries(Object.entries(PLACES).filter(([_, p]) => p[3] === cc));
}

// ---------- outlook / windows ----------
function outlook(lat, lon, hours, d, cl) {
  const now = new Date(), mlat = geomagLat(lat, lon);
  const t0 = new Date(Math.floor(now / H) * H);
  const ovp = d.ov ? ovationAt(d.ov.pts, lat, lon) : null;
  const out = [];
  const P_CAP = 0.8;
  for (let i = 0; i <= hours; i++) {
    const t = new Date(+t0 + i * H), tm = new Date(+t + H / 2);
    const sAlt = sunAlt(tm, lat, lon), dark = darkness(sAlt), m = mlt(tm, lat, lon);
    const bin = d.fc ? kpInBin(d.fc, tm) : null;
    let kp = bin ? bin.kp : null;
    if (d.kn && tm - now < 2 * H) kp = Math.max(kp ?? 0, d.kn.kp);
    let pg = kp !== null ? pGeo(kp, mlat, m) : null;
    if (ovp && tm - now < 1.5 * H) pg = Math.max(pg ?? 0, Math.min(Math.max(ovp[0], 0.5 * ovp[1]) / 100, P_CAP));
    const c = cl.get(+t) || null, pc = pClear(c);
    const [mAlt, mIll] = moonState(tm, lat, lon), mf = moonFactor(mAlt, mIll);
    const score = pg === null ? null : pg * dark * mf * (pc ?? 1);
    out.push({ t, sAlt, dark, m, kp, obs: bin ? bin.obs : "", pg, c, pc, mAlt, mIll, mf, score });
  }
  return out;
}

function bestWindow(rs) {
  const s = rs.filter(r => r.score !== null);
  if (!s.length) return null;
  let i = 0; s.forEach((r, k) => { if (r.score > s[i].score) i = k; });
  const thr = 0.7 * s[i].score;
  let lo = i, hi = i;
  while (lo > 0 && s[lo - 1].score >= thr && s[lo].t - s[lo - 1].t === H) lo--;
  while (hi < s.length - 1 && s[hi + 1].score >= thr && s[hi + 1].t - s[hi].t === H) hi++;
  return { top: s[i], from: s[lo].t, to: new Date(+s[hi].t + H) };
}

// ---------- formatting ----------
let localFmt, localHour, localDay, currentTz = "Europe/Helsinki";
function setTz(tz) {
  currentTz = tz;
  localFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  localHour = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false });
  localDay = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" });
}
const utFmt = t => t.toISOString().slice(11, 16);
const fi = t => localFmt.format(t);
const pct = x => x == null ? "–" : `${Math.round(100 * x)}%`;

// ---------- UI ----------
const $ = id => document.getElementById(id);
const state = { data: null, country: null, sel: null, lat: null, lon: null, rankCache: null, rankAt: 0 };

function fillPlaceOptions(cc) {
  const ps = placesInCountry(cc);
  $("place").innerHTML = Object.entries(ps).map(([k, p]) => `<option value="${k}">${p[0]}</option>`).join("") + `<option value="custom">Custom…</option>`;
}

function initControls() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("aurora-fi") || "{}"); } catch {}
  const ccs = Object.keys(CONFIG.countries);
  $("country").innerHTML = ccs.map(cc => `<option value="${cc}">${CONFIG.countries[cc].name}</option>`).join("");
  state.country = ccs.includes(saved.country) ? saved.country : "FI";
  $("country").value = state.country;
  fillPlaceOptions(state.country);

  const defaultSel = CONFIG.countries[state.country].default_place;
  const candidate = saved.sel && (PLACES[saved.sel]?.[3] === state.country || saved.sel === "custom") ? saved.sel : defaultSel;
  $("csrc").value = saved.csrc || "auto";
  $("cmodel").value = saved.cmodel || "";
  setPlace(candidate, saved.lat, saved.lon);

  $("country").onchange = () => {
    state.country = $("country").value;
    fillPlaceOptions(state.country);
    setPlace(CONFIG.countries[state.country].default_place);
    state.rankCache = null;
    run();
  };
  $("place").onchange = () => { setPlace($("place").value); run(); };
  for (const id of ["lat", "lon"]) $(id).onchange = () => { $("place").value = "custom"; setPlace("custom", +$("lat").value, +$("lon").value); run(); };
  for (const id of ["csrc", "cmodel"]) $(id).onchange = () => { state.rankCache = null; save(); run(); };
  $("hours").onchange = () => render();
  $("refresh").onclick = () => { state.rankCache = null; run(); };
  $("night").onclick = () => document.body.classList.toggle("night");
  setInterval(() => { if ($("auto").checked) run(); }, 5 * 60e3);
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 150); });
}

function setPlace(key, lat, lon) {
  state.sel = key;
  if (key !== "custom" && PLACES[key]) {
    const p = PLACES[key];
    state.lat = p[1]; state.lon = p[2];
    setTz(p[4]);
  } else {
    state.sel = "custom";
    state.lat = Number.isFinite(lat) ? lat : 68.0;
    state.lon = Number.isFinite(lon) ? lon : 25.0;
    setTz(CONFIG.countries[state.country].tz);
  }
  $("place").value = state.sel; $("lat").value = state.lat; $("lon").value = state.lon;
  const country = CONFIG.countries[state.country];
  $("title").textContent = `Aurora dashboard: ${country.name}`;
  save();
}

function save() {
  try { localStorage.setItem("aurora-fi", JSON.stringify({ country: state.country, sel: state.sel, lat: state.lat, lon: state.lon, csrc: $("csrc").value, cmodel: $("cmodel").value })); } catch {}
}

let running = false;

async function run() {
  if (running) return; running = true;
  $("updated").textContent = "Updating…";
  const errors = [];
  const safe = (p, name) => p.catch(e => { errors.push(`${name}: ${e.message}`); return null; });
  const [swd, fc, kn, ov] = await Promise.all([
    safe(solarWind(), "L1 solar wind"), safe(kpForecast(), "Kp forecast"), safe(kpNow(), "Kp nowcast"), safe(ovation(), "OVATION"),
  ]);
  const cl = await clouds([[state.lat, state.lon]], $("csrc").value, $("cmodel").value, errors);
  state.data = { sw: swd, fc, kn, ov, cl: cl.maps[0], clSrc: cl.src, errors, at: new Date() };
  // Expose for map.js (pro build only) so it can compute aurora chance per grid
  // cell and draw per-place dots.
  window.auroraApp = {
    data: state.data,
    country: state.country,
    placesInCountry: () => placesInCountry(state.country),
    rankClouds: () => (state.rankCache && state.rankCountry === state.country) ? state.rankCache : null,
  };
  window.dispatchEvent(new CustomEvent("aurora:data"));
  render();
  running = false;
  if (!state.rankCache || state.rankCountry !== state.country || Date.now() - state.rankAt > 30 * 60e3) {
    const ps = placesInCountry(state.country);
    const pts = Object.values(ps).map(p => [p[1], p[2]]);
    const rc = await clouds(pts, $("csrc").value, $("cmodel").value, []);
    state.rankCache = rc; state.rankAt = Date.now(); state.rankCountry = state.country;
    window.dispatchEvent(new CustomEvent("aurora:rank-ready"));
  }
  renderRank();
}

function render() {
  const d = state.data; if (!d) return;
  const hours = +$("hours").value, lat = state.lat, lon = state.lon, now = new Date();
  const mlat = geomagLat(lat, lon), [kh, ko] = kpNeeded(mlat);
  const name = state.sel === "custom" ? `${lat.toFixed(2)}°N ${lon.toFixed(2)}°E` : PLACES[state.sel][0];
  $("where").textContent = `${name} · ${lat.toFixed(2)}°N ${lon.toFixed(2)}°E · geomag lat ${mlat.toFixed(1)}° · Kp needed near magnetic midnight: ~${kh.toFixed(1)} on the horizon, ~${ko.toFixed(1)} overhead · now MLT ${mlt(now, lat, lon).toFixed(1)}, sun ${sunAlt(now, lat, lon).toFixed(0)}° · clouds: ${d.clSrc || "unavailable"}`;
  $("updated").textContent = `Updated ${fi(d.at)} local (${utFmt(d.at)} UT · ${currentTz})`;

  const s = d.sw;
  let alert = null;
  if (s) {
    $("t-bz").textContent = `${s.bzMean >= 0 ? "+" : ""}${s.bzMean.toFixed(1)} nT`;
    $("t-bznote").textContent = `${Math.round(100 * s.fracSouth)}% southward · Bt ${s.bt.toFixed(1)} nT · ${s.source}${s.ageMin > 15 ? ` · STALE ${s.ageMin.toFixed(0)} min` : ""}`;
    $("t-cpl").textContent = Math.round(s.newell).toLocaleString("en-GB");
    $("t-cplnote").textContent = `${couplingLabel(s.newell)} · ${Math.round(s.v)} km/s · ${s.n.toFixed(1)} /cm³ · reaches Earth in ~${Math.round(s.delayMin)} min`;
    if (s.bzMean < -8 || s.newell > 20000) alert = ["var(--critical)", "STRONG", "Strong driving: activity is likely to intensify soon. Check now if it's dark and clear."];
    else if (s.bzMean < -3 && s.fracSouth > 0.6) alert = ["var(--warning)", "FAVOURABLE", "Sustained southward Bz: a substorm is possible within about an hour."];
    else if (s.fracSouth < 0.3) alert = ["var(--text-muted)", "QUIET", "Bz mostly northward: quiet for now."];
  } else { ["t-bz", "t-cpl"].forEach(i => $(i).textContent = "n/a"); }
  const a = $("alert");
  if (alert) { a.style.display = "flex"; a.innerHTML = `<span class="status"><span class="dot" style="background:${alert[0]}"></span><b>${alert[1]}</b></span><span>${alert[2]}</span>`; }
  else a.style.display = "none";
  $("t-kp").textContent = d.kn ? d.kn.kp.toFixed(2) : "n/a";
  $("t-kpnote").textContent = d.kn ? `at ${utFmt(d.kn.t)} UT` : "";
  if (d.ov) {
    const [o, h] = ovationAt(d.ov.pts, lat, lon);
    $("t-ov").textContent = `${Math.round(o)}%`;
    $("t-ovnote").textContent = `overhead · ${Math.round(h)}% within 500 km north`;
  } else $("t-ov").textContent = "n/a";
  const [mA, mI] = moonState(now, lat, lon);
  $("t-moon").textContent = `${Math.round(100 * mI)}% lit`;
  $("t-moonnote").textContent = mA > 0 ? `${mA.toFixed(0)}° above horizon` : `below horizon (${mA.toFixed(0)}°)`;

  const rs = outlook(lat, lon, hours, d, d.cl);
  const in24 = rs.filter(r => r.t - now < 24 * H);
  const bw = bestWindow(in24);
  if (bw) {
    const [v, c] = verdict(bw.top.score);
    $("t-verdict").innerHTML = `<span class="status"><span class="dot" style="background:${c}"></span>${v}</span>`;
    $("t-window").textContent = bw.top.score >= 0.05 ? `best ${pct(bw.top.score)} · ${fi(bw.from)}–${localHour.format(bw.to)}:00` : `best ${pct(bw.top.score)}`;
  } else { $("t-verdict").textContent = "n/a"; $("t-window").textContent = ""; }

  const x = rs.map(r => r.t);
  chart($("c-hourly"), {
    label: "Hourly aurora chance", categorical: true, x, height: 240, yMin: 0, yMax: 1, yTicks: [0, .25, .5, .75, 1],
    emitHover: true,  // mouse over this chart drives the map slider via aurora:hour-hover
    fmtY: v => `${Math.round(v * 100)}%`, shade: rs.map(r => r.dark === 0),
    xTicks: xs => xs.map((_, i) => i).filter(i => +localHour.format(xs[i]) % 3 === 0),
    fmtX: t => { const h = localHour.format(t); return h === "00" ? localDay.format(t) : h; },
    nowX: 0,
    series: [
      { name: "Chance", type: "bar", color: "var(--series-1)", values: rs.map(r => r.score) },
      { name: "Oval near you", type: "line", color: "var(--series-2)", values: rs.map(r => r.pg) },
      { name: "Clear sky", type: "line", color: "var(--series-3)", values: rs.map(r => r.pc) },
    ],
    tip: i => { const r = rs[i], [v] = verdict(r.score ?? 0); return `<b>${fi(r.t)}</b> (${utFmt(r.t)} UT)<br>${sw("var(--series-1)")}Chance <b>${pct(r.score)}</b> ${r.dark === 0 ? "daylight" : v}<br>${sw("var(--series-2)", 1)}Oval near you ${pct(r.pg)} · Kp ${r.kp == null ? "–" : r.kp.toFixed(2)}${r.obs ? ` (${r.obs})` : ""}<br>${sw("var(--series-3)", 1)}Clear sky ${pct(r.pc)}${r.c ? ` · cloud L/M/H ${r.c.slice(1).map(v => v == null ? "?" : Math.round(v)).join("/")}` : ""}<br>Moon ${r.mAlt > 0 ? `${pct(r.mIll)} lit, ${r.mAlt.toFixed(0)}° up` : "down"} · sun ${r.sAlt.toFixed(0)}° · MLT ${r.m.toFixed(1)}`; },
  });

  $("hourly-table").innerHTML = `<table><thead><tr><th>Local time</th><th>UT</th><th class="num">MLT</th><th class="num">Kp</th><th class="num">Oval</th><th class="num">Cloud L/M/H</th><th class="num">Clear</th><th class="num">Sun</th><th class="num">Moon</th><th class="num">Chance</th></tr></thead><tbody>${
    rs.filter(r => r.dark > 0).map(r => `<tr><td>${fi(r.t)}</td><td>${utFmt(r.t)}</td><td class="num">${r.m.toFixed(1)}</td><td class="num">${r.kp == null ? "–" : r.kp.toFixed(2)}${r.obs ? ` ${r.obs[0]}` : ""}</td><td class="num">${pct(r.pg)}</td><td class="num">${r.c ? r.c.slice(1).map(v => v == null ? "?" : Math.round(v)).join("/") : "n/a"}</td><td class="num">${pct(r.pc)}</td><td class="num">${r.sAlt.toFixed(0)}°</td><td class="num">${r.mAlt > 0 ? `${pct(r.mIll)} ${r.mAlt.toFixed(0)}°` : "down"}</td><td class="num">${pct(r.score)} ${r.score == null ? "" : verdict(r.score)[0]}</td></tr>`).join("")
  }</tbody></table>`;

  if (s && s.mag6.length > 1) {
    const mx = s.mag6.map(r => r[0]);
    const lim = Math.max(10, Math.ceil(Math.max(...s.mag6.map(r => r[3])) / 5) * 5);
    const ticks = []; for (let v = -lim; v <= lim; v += lim / 2) ticks.push(v);
    chart($("c-imf"), {
      label: "IMF Bz and Bt, last 6 hours", x: mx, height: 200, yMin: -lim, yMax: lim, yTicks: ticks, zeroLine: true,
      fmtY: v => `${v}`, xTicks: hourTicks, fmtX: t => utFmt(t), nowX: mx.length - 1,
      series: [
        { name: "Bz (GSM)", type: "line", color: "var(--series-1)", values: s.mag6.map(r => r[1]) },
        { name: "Bt", type: "line", color: "var(--series-2)", values: s.mag6.map(r => r[3]) },
      ],
      tip: i => `<b>${utFmt(mx[i])} UT</b><br>${sw("var(--series-1)", 1)}Bz ${s.mag6[i][1].toFixed(1)} nT<br>${sw("var(--series-2)", 1)}Bt ${s.mag6[i][3].toFixed(1)} nT`,
    });
    const wx = s.wind6.map(r => r[0]), raw = s.wind6.map(r => r[1]);
    const vs = despike(raw), spikes = raw.length - vs.filter(v => v != null).length;
    const good = vs.filter(v => v != null);
    const vmax = Math.max(600, Math.ceil(Math.max(...good) / 100) * 100), vmin = Math.min(300, Math.floor(Math.min(...good) / 100) * 100);
    const step = niceStep((vmax - vmin) / 5);
    const vt = []; for (let v = Math.ceil(vmin / step) * step; v <= vmax; v += step) vt.push(v);
    const dens = s.wind6.map(r => r[2]);
    const dgood = dens.filter(v => v != null && isFinite(v));
    const d2max = Math.max(20, Math.ceil(Math.max(...dgood) / 5) * 5);
    const dstep = niceStep(d2max / 4);
    const dt = []; for (let v = 0; v <= d2max; v += dstep) dt.push(v);
    chart($("c-speed"), {
      label: "Solar wind speed and density, last 6 hours", x: wx, height: 200 + 22, yMin: vmin, yMax: vmax, yTicks: vt,
      fmtY: v => `${v}`, xTicks: hourTicks, fmtX: t => utFmt(t), nowX: wx.length - 1,
      y2Min: 0, y2Max: d2max, y2Ticks: dt, y2FmtY: v => `${v}`,
      series: [
        { name: "Speed (km/s)", type: "line", color: "var(--series-1)", values: vs },
        { name: "Density (/cm³)", type: "line", color: "var(--series-3)", values: dens, axis: "right" },
      ],
      tip: i => `<b>${utFmt(wx[i])} UT</b><br>${sw("var(--series-1)", 1)}${vs[i] == null ? `${Math.round(raw[i])} km/s (spike, excluded)` : `${Math.round(vs[i])} km/s`}<br>${sw("var(--series-3)", 1)}${dens[i] == null ? "– /cm³" : `${dens[i].toFixed(1)} /cm³`}`,
    });
    if (spikes) $("c-speed").insertAdjacentHTML("beforeend", `<div class="sub small">${spikes} spike sample${spikes > 1 ? "s" : ""} hidden as bad data.</div>`);
  } else { $("c-imf").innerHTML = `<div class="muted">No L1 data.</div>`; $("c-speed").innerHTML = ""; }

  if (d.fc && d.fc.length) {
    const fcs = d.fc.filter(b => b.t >= new Date(+now - 2 * 24 * H));
    // Primary: bin that contains "now". Fallback: last bin before "now" — SWPC's
    // feed can briefly lack the current bin right after midnight UT.
    let nowIdx = fcs.findIndex(b => b.t <= now && now < new Date(+b.t + 3 * H));
    if (nowIdx < 0) {
      for (let i = fcs.length - 1; i >= 0; i--) if (fcs[i].t <= now) { nowIdx = i; break; }
    }
    chart($("c-kp"), {
      label: "Kp by 3-hour slot", categorical: true, x: fcs.map(b => b.t), height: 190, yMin: 0, yMax: 9, yTicks: [0, 3, 5, 7, 9],
      fmtY: v => `${v}`, nowX: nowIdx >= 0 ? nowIdx : null,
      xTicks: xs => xs.map((_, i) => i).filter(i => xs[i].getUTCHours() === 0),
      fmtX: t => t.toISOString().slice(5, 10),
      series: [{ name: "Kp", type: "bar", color: "var(--series-1)", values: fcs.map(b => b.kp), colorAt: i => fcs[i].kp >= 4.67 ? "var(--warning)" : null }],
      tip: i => { const b = fcs[i]; const g = b.kp >= 4.67 ? ` · G${Math.min(5, Math.floor(b.kp + 0.34) - 4)}` : ""; return `<b>${b.t.toISOString().slice(0, 16).replace("T", " ")}–${String((b.t.getUTCHours() + 3) % 24).padStart(2, "0")}:00 UT</b><br>Kp ${b.kp.toFixed(2)}${g} · ${b.obs || "–"}`; },
    });
  }
  $("errors").textContent = d.errors.length ? "Data problems:\n" + d.errors.map(e => "• " + e).join("\n") : "";
  renderRank();
}

function renderRank() {
  const d = state.data, rc = state.rankCache;
  if (!d || !rc) { $("rank").innerHTML = `<div class="muted">Loading cloud forecasts for all places…</div>`; return; }
  const now = new Date();
  const ps = placesInCountry(state.rankCountry || state.country);
  const res = Object.entries(ps).map(([k, p], i) => {
    const rs = outlook(p[1], p[2], 24, { ...d, ov: d.ov }, rc.maps[i]).filter(r => r.t - now < 24 * H);
    return { k, p, mlat: geomagLat(p[1], p[2]), bw: bestWindow(rs), hasCloud: rc.maps[i].size > 0 };
  }).sort((a, b) => (b.bw?.top.score ?? -1) - (a.bw?.top.score ?? -1));
  $("rank").innerHTML = `<table><thead><tr><th>Place</th><th class="num">Geomag lat</th><th>Best chance</th><th>Best window (local)</th><th class="num">Low cloud then</th><th class="num">Oval then</th></tr></thead><tbody>${
    res.map(r => {
      const top = r.bw?.top, [v, c] = verdict(top?.score ?? 0);
      return `<tr class="rank${r.k === state.sel ? " sel" : ""}" data-k="${r.k}"><td>${r.p[0]}</td><td class="num">${r.mlat.toFixed(1)}°</td><td><span class="status"><span class="dot" style="background:${c}"></span>${top ? `${pct(top.score)} ${v}` : "n/a"}</span></td><td>${top && top.score >= 0.05 ? `${fi(r.bw.from)}–${localHour.format(r.bw.to)}:00` : "–"}</td><td class="num">${top && top.c && top.c[1] != null ? Math.round(top.c[1]) + "%" : r.hasCloud ? "–" : "n/a"}</td><td class="num">${top ? pct(top.pg) : "–"}</td></tr>`;
    }).join("")
  }</tbody></table><div class="sub small" style="margin-top:6px">Clouds: ${rc.src || "unavailable"}${rc.src ? "" : " (chances are geomagnetic only)"}</div>`;
  document.querySelectorAll("tr.rank").forEach(tr => tr.onclick = () => { setPlace(tr.dataset.k); run(); });
}

(async function main() {
  CONFIG = await loadPlaces();
  PLACES = flatten(CONFIG);
  // AACGM: inlined into the single-file builds, fetched over HTTP in --serve.
  if (window.__AACGM__) setAacgmGrid(window.__AACGM__);
  else await loadAacgm();
  initControls();  // setPlace inside initControls sets the tz
  run();
})();
