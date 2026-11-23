// Renders the "Active events" card: recent SWPC alerts + DONKI CME arrivals.
// One uniform row layout for alerts + CMEs so columns align.

import { swpcAlerts, donkiCmes, rtswSeries, cmeArrivalCheck } from "./sources.js";

const utFmt = t => t.toISOString().slice(11, 16);
const dayFmt = t => t.toISOString().slice(5, 10) + " " + utFmt(t);

function relHours(from, to) {
  const h = (to - from) / 3600e3;
  if (Math.abs(h) < 1) return `${Math.round(h * 60)} min`;
  return `${h >= 0 ? "+" : ""}${h.toFixed(1)} h`;
}

const SEVERITY_COLOR = {
  info:     "var(--text-muted)",
  warn:     "var(--warning)",
  serious:  "var(--serious)",
  critical: "var(--critical)",
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function alertRow(a, now) {
  const dot = SEVERITY_COLOR[a.severity] || SEVERITY_COLOR.info;
  const ageH = (now - a.time) / 3600e3;
  const ageTxt = ageH < 1 ? `${Math.round(ageH * 60)} min ago` : `${ageH.toFixed(1)} h ago`;
  const validUntil = a.fields.nowValidUntil || a.fields.validUntil;
  const validTxt = validUntil ? ` · valid until ${escapeHtml(validUntil)}` : "";
  const threshold = a.fields.thresholdReached ? ` · threshold reached ${escapeHtml(a.fields.thresholdReached)}` : "";
  return `
    <div class="ev-row">
      <div class="ev-left">
        <span class="dot" style="background:${dot}"></span>
        <span class="ev-kind">${a.kind}</span>
        <span class="ev-code">${escapeHtml(a.code)}</span>
      </div>
      <div class="ev-main">
        <div class="ev-headline">${escapeHtml(a.summary || "(no headline)")}</div>
        <div class="ev-desc">${escapeHtml(a.desc)}${validTxt}${threshold}</div>
      </div>
      <div class="ev-right">
        <div class="ev-time">${ageTxt}</div>
      </div>
    </div>`;
}

// DONKI CME type codes → word. See NASA DONKI reference.
const CME_TYPE_WORD = { S: "Slow", C: "Common", O: "Occasional", R: "Rare", ER: "Extreme" };

function cmeImpact(c) {
  // Rough geoeffectiveness heuristic by shock speed, assuming favourable Bz.
  const v = c.speed || 0;
  if (v >= 1500) return ["critical", "likely G3–G4 if Bz turns south"];
  if (v >= 1000) return ["serious",  "likely G2–G3 if Bz turns south"];
  if (v >= 700)  return ["warn",     "G1–G2 possible if Bz turns south"];
  if (v >= 500)  return ["warn",     "G1 possible if Bz turns south"];
  return ["info", "weak geomagnetic impact likely; Bz orientation sets outcome"];
}

function arrivalStatus(c, check, now) {
  const rel = relHours(now, c.arrival);
  if (!check || check.state === "pending") {
    return { sev: null, right: `arrives in ${rel.replace("+", "")}`, line: null };
  }
  if (check.state === "observed") {
    const s = check.shock;
    return {
      sev: "serious",
      right: `arrived ${relHours(s.time, now).replace("-", "")} ago`,
      line: `L1 shock at ${dayFmt(s.time)} UT — Δv +${Math.round(s.dv)} km/s, ΔBt +${s.dBt.toFixed(1)} nT (v ${Math.round(s.vBefore)}→${Math.round(s.vAfter)} km/s, Bt ${s.btBefore.toFixed(1)}→${s.btAfter.toFixed(1)} nT)`,
    };
  }
  if (check.state === "waiting") {
    return {
      sev: null,
      right: `due ±${check.hoursUntilClose.toFixed(1)} h`,
      line: `inside arrival window — no shock signature at L1 yet`,
    };
  }
  if (check.state === "missed") {
    const vTxt = check.vNow != null ? `v=${Math.round(check.vNow)} km/s` : "v=?";
    const btTxt = check.btNow != null ? `Bt=${check.btNow.toFixed(1)} nT` : "Bt=?";
    return {
      sev: "info",
      right: `expected ${check.hoursSince.toFixed(1)} h ago`,
      line: `no shock signature at L1 (${vTxt}, ${btTxt}) — likely missed Earth or still delayed`,
    };
  }
  // nodata
  const past = c.arrival < now;
  return {
    sev: null,
    right: past ? `arrived ${rel.replace("-", "")} ago` : `arrives in ${rel.replace("+", "")}`,
    line: `L1 data unavailable — can't confirm arrival`,
  };
}

function cmeRow(c, now, check) {
  const [impSev, impact] = cmeImpact(c);
  const st = arrivalStatus(c, check, now);
  const sev = st.sev || impSev;
  const dot = SEVERITY_COLOR[sev];
  const ar = c.ar ? ` · AR ${escapeHtml(String(c.ar))}` : "";
  const speed = c.speed ? `${Math.round(c.speed)} km/s` : "v=?";
  const uncertainty = c.nRuns > 1
    ? `${c.nRuns} Enlil runs`
    : "1 Enlil run (climatological ±)";
  const typeWord = CME_TYPE_WORD[c.type] || null;
  const statusLine = st.line ? `<div class="ev-status">${escapeHtml(st.line)}</div>` : "";
  return `
    <div class="ev-row">
      <div class="ev-left">
        <span class="dot" style="background:${dot}"></span>
        <span class="ev-kind">CME</span>
        <span class="ev-code">${escapeHtml(typeWord || "")}</span>
      </div>
      <div class="ev-main">
        <div class="ev-headline">Earth-directed CME, arrival ${dayFmt(c.arrival)} UT ±${c.arrivalErrH.toFixed(0)} h</div>
        <div class="ev-desc">${typeWord ? `${typeWord} CME` : "CME"} — ${impact} · launched ${dayFmt(c.launch)} UT from ${escapeHtml(c.source)}${ar} · ${speed} · ${uncertainty}</div>
        ${statusLine}
      </div>
      <div class="ev-right">
        <div class="ev-time">${st.right}</div>
      </div>
    </div>`;
}

function ensureStyle() {
  if (document.getElementById("ev-style")) return;
  const s = document.createElement("style");
  s.id = "ev-style";
  s.textContent = `
    .ev-row { display: grid; grid-template-columns: 170px 1fr 120px; gap: 12px;
              align-items: start; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .ev-row:last-child { border-bottom: none; }
    .ev-left { display: flex; align-items: center; gap: 8px; }
    .ev-kind { font-weight: 600; font-size: 12px; letter-spacing: 0.3px; color: var(--text-primary); }
    .ev-code { color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .ev-main { min-width: 0; }
    .ev-headline { font-size: 13px; color: var(--text-primary); }
    .ev-desc { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
    .ev-right { text-align: right; font-size: 12px; color: var(--text-secondary);
                font-variant-numeric: tabular-nums; }
    .ev-status { font-size: 12px; color: var(--text-primary); margin-top: 3px;
                 padding: 2px 6px; background: var(--card-bg, rgba(255,255,255,0.03));
                 border-left: 2px solid var(--border); border-radius: 2px;
                 font-variant-numeric: tabular-nums; }
    .ev-sep { margin: 6px 0 2px; font-size: 12px; color: var(--text-muted);
              text-transform: uppercase; letter-spacing: 0.5px; }
    .ev-empty { padding: 8px 0; color: var(--text-secondary); font-size: 13px; }
    @media (max-width: 620px) {
      .ev-row { grid-template-columns: 1fr; }
      .ev-right { text-align: left; }
    }
  `;
  document.head.appendChild(s);
}

function renderEvents(card, body, alerts, cmes, errs, series) {
  const now = new Date();
  if (!alerts.length && !cmes.length && !errs.length) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";
  ensureStyle();
  const parts = [];
  parts.push(`<div class="ev-sep">SWPC — last 48 h</div>`);
  if (alerts.length) {
    // Dedupe by headline (SWPC often re-issues the same alert): keep latest.
    const seen = new Set();
    const uniq = [];
    for (const a of [...alerts].reverse()) {
      const key = (a.summary || a.code).toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(a);
    }
    uniq.reverse();
    for (const a of uniq.slice(-5)) parts.push(alertRow(a, now));
  } else {
    parts.push(`<div class="ev-empty">No active geomagnetic warnings. Nothing in the last 48 h is still within its validity window.</div>`);
  }
  if (cmes.length) {
    const src = cmes._source || {};
    const srcBits = [];
    if (src.from) srcBits.push(src.from);
    if (src.cacheAgeMin != null) srcBits.push(`cached ${src.cacheAgeMin.toFixed(0)} min ago`);
    const srcTag = srcBits.length ? ` · ${srcBits.join(" · ")}` : "";
    parts.push(`<div class="ev-sep">DONKI — CMEs with predicted Earth arrival${srcTag}</div>`);
    for (const c of cmes) {
      const check = cmeArrivalCheck(c, series, now);
      parts.push(cmeRow(c, now, check));
    }
  }
  if (errs.length) {
    parts.push(`<div class="errors" style="margin-top:8px">Events data problems:\n${errs.map(e => "• " + escapeHtml(e)).join("\n")}</div>`);
  }
  body.innerHTML = parts.join("");
}

let _lastAlerts = [], _lastCmes = [], _lastErrs = [], _lastSeries = null;

async function loadAndRender() {
  const card = document.getElementById("events-card");
  const body = document.getElementById("events-body");
  if (!card || !body) return;
  body.innerHTML = `<div class="muted">Loading alerts and CMEs…</div>`;
  card.style.display = "";
  const errs = [];
  const safe = async (p, name) => { try { return await p; } catch (e) { errs.push(`${name}: ${e.message}`); return []; } };
  // donkiCmes uses stale-while-revalidate: returns cached data fast (if any),
  // revalidates in the background, re-renders via onFresh when fresh arrives.
  const onFresh = (freshCmes, err) => {
    if (err) { _lastErrs = _lastErrs.concat([`DONKI CMEs (background refresh): ${err.message}`]); }
    if (freshCmes) { _lastCmes = freshCmes; }
    renderEvents(card, body, _lastAlerts, _lastCmes, _lastErrs, _lastSeries);
  };
  const [alerts, cmes, series] = await Promise.all([
    safe(swpcAlerts(), "SWPC alerts"),
    safe(donkiCmes({ onFresh }), "DONKI CMEs"),
    safe(rtswSeries(), "L1 series (CME arrival check)"),
  ]);
  _lastAlerts = alerts; _lastCmes = cmes; _lastErrs = errs;
  _lastSeries = series && series.mag ? series : null;
  renderEvents(card, body, alerts, cmes, errs, _lastSeries);
}

loadAndRender();
window.addEventListener("aurora:data", () => loadAndRender());
