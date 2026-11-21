// Hand-built SVG charts. One y-axis per chart, legend for >=2 series, hover tooltips.

const NS = "http://www.w3.org/2000/svg";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export function chart(host, cfg) {
  // Cancel any listeners wired by the previous chart() call on this host so
  // stale handlers don't accumulate across re-renders.
  if (host.__chartController) host.__chartController.abort();
  host.__chartController = new AbortController();
  const _signal = host.__chartController.signal;
  host.innerHTML = "";
  const { x, series, yMin, yMax, yTicks, fmtY, fmtX, tip, height = 220, shade, zeroLine, nowX, syncGroup, arrivalBand,
          y2Min, y2Max, y2Ticks, y2FmtY } = cfg;
  const hasY2 = y2Ticks && y2Min != null && y2Max != null;
  if (series.length > 1) {
    const lg = document.createElement("div"); lg.className = "legend";
    lg.innerHTML = series.map(s => `<span><i class="${s.type === "bar" ? "sw-bar" : "sw-line"}" style="background:${s.color}"></i>${esc(s.name)}</span>`).join("");
    host.appendChild(lg);
  }
  const W = Math.max(320, host.clientWidth || 600), Hh = height;
  const m = { l: 44, r: hasY2 ? 44 : 10, t: 8, b: 26 };
  const iw = W - m.l - m.r, ih = Hh - m.t - m.b;
  const svg = el("svg", { viewBox: `0 0 ${W} ${Hh}`, height: Hh, role: "img", "aria-label": cfg.label || "chart" });
  host.appendChild(svg);
  const n = x.length, xMin = +x[0], xMax = +x[n - 1];
  const band = cfg.categorical ? iw / n : null;
  const X = cfg.categorical ? (i => m.l + band * (i + 0.5)) : (i => m.l + (n > 1 ? (+x[i] - xMin) / (xMax - xMin) : 0.5) * iw);
  const Y = v => m.t + ih - (v - yMin) / (yMax - yMin) * ih;
  const Y2 = hasY2 ? (v => m.t + ih - (v - y2Min) / (y2Max - y2Min) * ih) : null;
  if (shade && band) shade.forEach((s, i) => { if (s) el("rect", { x: m.l + band * i, y: m.t, width: band, height: ih, fill: "var(--surface-2)" }, svg); });
  yTicks.forEach(v => {
    el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: v === 0 && zeroLine ? "var(--text-muted)" : "var(--grid)", "stroke-width": 1 }, svg);
    const tx = el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", fill: "var(--text-muted)", "font-size": 11 }, svg);
    tx.textContent = fmtY(v);
  });
  // Right-side y-axis ticks (no gridlines — those would double up with the left axis).
  if (hasY2) {
    y2Ticks.forEach(v => {
      const tx = el("text", { x: W - m.r + 6, y: Y2(v) + 4, "text-anchor": "start", fill: "var(--text-muted)", "font-size": 11 }, svg);
      tx.textContent = (y2FmtY || (x => `${x}`))(v);
    });
  }
  const ticks = cfg.xTicks(x);
  ticks.forEach(i => {
    const tx = el("text", { x: X(i), y: Hh - 8, "text-anchor": "middle", fill: "var(--text-muted)", "font-size": 11 }, svg);
    tx.textContent = fmtX(x[i], i);
  });
  if (nowX != null) {
    el("line", { x1: X(nowX), x2: X(nowX), y1: m.t, y2: m.t + ih, stroke: "var(--warning)", "stroke-width": 2, "stroke-dasharray": "4 3", opacity: 0.85 }, svg);
    const label = el("text", { x: X(nowX), y: m.t - 2, "text-anchor": "middle", fill: "var(--warning)", "font-size": 10, "font-weight": 700 }, svg);
    label.textContent = "now";
  }
  const bars = series.filter(s => s.type === "bar");
  bars.forEach(s => {
    const bw = Math.max(2, band - 2);
    s.values.forEach((v, i) => {
      if (v == null) return;
      const y0 = Y(Math.max(yMin, 0)), y1 = Y(v), h = Math.abs(y0 - y1);
      if (h < 0.5) return;
      const r = Math.min(4, h, bw / 2), x0 = X(i) - bw / 2, top = Math.min(y0, y1);
      const d = `M${x0},${y0} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${y0} Z`;
      el("path", { d, fill: (s.colorAt && s.colorAt(i)) || s.color }, svg);
    });
  });
  series.filter(s => s.type === "line").forEach(s => {
    const Yfn = (s.axis === "right" && Y2) ? Y2 : Y;
    let d = "", pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Yfn(v).toFixed(1)} `; pen = true;
    });
    el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round" }, svg);
  });
  const tipEl = document.createElement("div"); tipEl.className = "tip"; host.appendChild(tipEl);
  // Arrival band: a shaded strip that follows sync events, offset by minLagMs..maxLagMs.
  // Used on the proton chart to show where SEPs from a hovered X-ray feature would land.
  const arrivalBandEl = arrivalBand ? el("rect", {
    y: m.t, height: ih, fill: arrivalBand.color || "rgba(250,180,40,0.15)",
    stroke: arrivalBand.stroke || "rgba(250,180,40,0.45)", "stroke-width": 1, "stroke-dasharray": "3 3",
    visibility: "hidden", "pointer-events": "none",
  }, svg) : null;
  const cross = el("line", { y1: m.t, y2: m.t + ih, stroke: "var(--text-muted)", "stroke-width": 1, visibility: "hidden" }, svg);
  const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
  const nearest = px => {
    if (cfg.categorical) return Math.max(0, Math.min(n - 1, Math.floor((px - m.l) / band)));
    const tv = xMin + (px - m.l) / iw * (xMax - xMin);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (+x[mid] < tv) lo = mid; else hi = mid; }
    return Math.abs(+x[lo] - tv) < Math.abs(+x[hi] - tv) ? lo : hi;
  };
  hit.addEventListener("mousemove", ev => {
    const bb = svg.getBoundingClientRect(), px = (ev.clientX - bb.left) * W / bb.width;
    const i = nearest(px);
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
    tipEl.innerHTML = tip(i); tipEl.style.display = "block";
    const left = X(i) * bb.width / W, tw = tipEl.offsetWidth;
    tipEl.style.left = `${Math.min(Math.max(0, left + 12), bb.width - tw)}px`;
    tipEl.style.top = `${(host.querySelector(".legend")?.offsetHeight || 0) + 6}px`;
    // Broadcast so the map slider can track the hovered hour. Opt-in: only
    // charts whose x-axis is in absolute time (hourly chart) get this flag.
    if (cfg.emitHover) window.dispatchEvent(new CustomEvent("aurora:hour-hover", { detail: { t: +x[i] } }));
    // Group-scoped sync so sibling panels (e.g. X-ray <-> proton) pin to the
    // same UT without dragging unrelated time-series (the aurora map) along.
    if (syncGroup) window.dispatchEvent(new CustomEvent(`aurora:sync:${syncGroup}`, { detail: { t: +x[i] } }));
  });
  hit.addEventListener("mouseleave", () => { tipEl.style.display = "none"; cross.setAttribute("visibility", "hidden"); });

  // Listen for external hour selection (e.g. map slider) and pin the crosshair.
  // The cross element is re-created on every chart() call, so any stale listener
  // from a previous render will just mutate a detached element — harmless.
  const onExternalHour = (ev) => {
    const t = ev.detail?.t;
    if (t == null) return;
    const span = xMax - xMin;
    if (!span || t < xMin - span * 0.02 || t > xMax + span * 0.02) {
      // Outside this chart's time range — don't pin.
      return;
    }
    let bestI = 0, bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const d = Math.abs(+x[k] - t);
      if (d < bestD) { bestD = d; bestI = k; }
    }
    cross.setAttribute("x1", X(bestI));
    cross.setAttribute("x2", X(bestI));
    cross.setAttribute("visibility", "visible");
  };
  window.addEventListener("aurora:hour-set", onExternalHour, { signal: _signal });

  // Group-scoped sync listener. Pins the crosshair at the peer's hovered time,
  // and — if this chart is configured with an arrivalBand — positions a shaded
  // strip at peer_time + [minLagMs, maxLagMs] to visualise an expected delay.
  if (syncGroup) {
    const onSync = (ev) => {
      const t = ev.detail?.t;
      if (t == null) return;
      onExternalHour(ev);  // pin crosshair at peer's time
      if (arrivalBandEl && arrivalBand) {
        const t0 = t + arrivalBand.minLagMs;
        const t1 = t + arrivalBand.maxLagMs;
        const span = xMax - xMin;
        if (!span || t1 < xMin || t0 > xMax) { arrivalBandEl.setAttribute("visibility", "hidden"); return; }
        const x0 = m.l + Math.max(0, (t0 - xMin) / span) * iw;
        const x1 = m.l + Math.min(1, (t1 - xMin) / span) * iw;
        arrivalBandEl.setAttribute("x", x0);
        arrivalBandEl.setAttribute("width", Math.max(1, x1 - x0));
        arrivalBandEl.setAttribute("visibility", "visible");
      }
    };
    window.addEventListener(`aurora:sync:${syncGroup}`, onSync, { signal: _signal });
  }
}

export const sw = (c, line) => `<i class="${line ? "sw-line" : "sw-bar"}" style="background:${c};vertical-align:middle;margin-right:5px"></i>`;

export function despike(vs, half = 10, tol = 250) {
  const med = xs => { const s = [...xs].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  return vs.map((v, i) => {
    const w = vs.slice(Math.max(0, i - half), i + half + 1);
    return Math.abs(v - med(w)) > tol ? null : v;
  });
}

export function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

export function hourTicks(xs) {
  const out = []; let last = -1;
  xs.forEach((t, i) => { const h = t.getUTCHours(); if (t.getUTCMinutes() < 2 && h !== last && h % 1 === 0) { out.push(i); last = h; } });
  return out;
}
