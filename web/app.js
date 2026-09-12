/* AI / NVDA Monitor — client.
   Reads pre-indexed JSON for history, and talks to the Robinhood Chain RPC
   directly for live state (the RPC sends access-control-allow-origin: *, so the
   browser can query the chain with no backend in between). */

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const AI_TOKEN = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const AI_NVDA_POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, html) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (html != null) n.innerHTML = html;
  return n;
};

/* ── formatting ─────────────────────────────────────────────────────────── */
const nf = (x, d = 2) => (x == null || !isFinite(x) ? "—" : x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
function compact(x, d = 2) {
  if (x == null || !isFinite(x)) return "—";
  const s = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(d)}B`;
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(d)}M`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(d)}K`;
  if (a === 0) return "0";
  return `${s}${a.toFixed(a < 1 ? 4 : d)}`;
}
const signed = (x, d) => {
  const v = +(x * 100).toFixed(d);
  return (v > 0 ? "+" : "") + v.toFixed(d);
};
const pct = (x, d = 1) => (x == null || !isFinite(x) ? "—" : `${signed(x, d)}%`);
const sig = (x, n = 6) => (x == null || !isFinite(x) || x === 0 ? "—" : x.toPrecision(n).replace(/\.?0+$/, ""));
const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : "—");
/* Times render in Central explicitly rather than in the viewer's local zone.
   Pinning it means a timestamp means the same thing on the desktop that produced
   it and the phone that reads it, and removes the ambiguity that makes a stale
   chart look like a timezone bug -- which is exactly how this came up. */
const TZ = "America/Chicago";
const tsFmt = (t) => (t ? new Date(t * 1000).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const dayFmt = (t) => (t ? new Date(t * 1000).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" }) : "—");
const hourFmt = (t) => (t ? new Date(t * 1000).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: true }) : "—");
const clockFmt = (t) => (t ? new Date(t * 1000).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) + " CT" : "—");
const ago = (t) => {
  const s = Math.floor(Date.now() / 1000) - t;
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

/* ── tiny SVG chart kit ─────────────────────────────────────────────────
   Hand-rolled so the page has zero dependencies and works offline. Every
   chart gets one y-axis, a hover layer, and a table view elsewhere on the
   page as the accessible equivalent. */
const SVGNS = "http://www.w3.org/2000/svg";
const mk = (t, a = {}) => { const n = document.createElementNS(SVGNS, t); for (const [k, v] of Object.entries(a)) n.setAttribute(k, v); return n; };

/* Extrema by loop, never Math.min(...array). Spreading an array passes one
   argument per element, which overflows the call stack on large series -- the
   "All" range on the flagship pool is already ~1,400 points and grows daily.
   The same mistake crashed the indexer's bridge step, so it is fixed on both
   sides rather than only where it happened to bite first. */
const minOf = (xs, seed = Infinity) => { let m = seed; for (const v of xs) if (v < m) m = v; return m; };
const maxOf = (xs, seed = -Infinity) => { let m = seed; for (const v of xs) if (v > m) m = v; return m; };

/** Phone layout is the common case here, so charts shrink their chrome for it. */
const isPhone = () => window.innerWidth <= 620;

/* The viewBox is set to the container's real pixel size and the SVG is NOT
   stretched (no preserveAspectRatio="none"), because stretching a viewBox
   distorts every glyph in the axis labels. Charts re-render on resize instead,
   which also keeps pointer coordinates a 1:1 map into SVG space. */
function frame(host, opts = {}) {
  host.innerHTML = "";
  const phone = isPhone();
  const height = opts.height || (phone ? 180 : 210);
  const padL = opts.padL ?? (phone ? 40 : 52);
  const padR = opts.padR ?? (phone ? 6 : 12);
  const padT = opts.padT ?? (phone ? 16 : 10);
  const padB = opts.padB ?? (phone ? 22 : 24);
  const width = Math.max(240, host.clientWidth || 600);
  const svg = mk("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img" });
  svg.style.touchAction = "pan-y"; // let the page scroll vertically over a chart
  host.appendChild(svg);
  const tip = el("div", { class: "tip" });
  host.appendChild(tip);
  return { svg, tip, width, height, padL, padR, padT, padB, iw: width - padL - padR, ih: height - padT - padB, phone };
}
function showTip(f, host, x, y, html) {
  f.tip.innerHTML = html;
  f.tip.classList.add("on");
  if (f.phone) return; // CSS pins it to the chart's top-left on phones
  const w = f.tip.offsetWidth, h = f.tip.offsetHeight;
  let left = x + 12, top = y - h - 10;
  if (left + w > host.clientWidth) left = x - w - 12;
  if (top < 0) top = y + 14;
  f.tip.style.left = `${Math.max(0, left)}px`;
  f.tip.style.top = `${top}px`;
}
const hideTip = (f) => f.tip.classList.remove("on");

/** One pointer abstraction for mouse and touch, so charts are usable on a phone. */
function onPointer(target, host, move, leave) {
  const pos = (ev) => {
    const t = ev.touches ? ev.touches[0] : ev;
    const r = host.getBoundingClientRect();
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  target.addEventListener("mousemove", (e) => move(pos(e)));
  target.addEventListener("mouseleave", leave);
  target.addEventListener("touchstart", (e) => move(pos(e)), { passive: true });
  target.addEventListener("touchmove", (e) => move(pos(e)), { passive: true });
  target.addEventListener("touchend", leave, { passive: true });
  target.addEventListener("touchcancel", leave, { passive: true });
}

function yAxis(f, min, max, fmt = compact, ticks = 4) {
  const g = mk("g", { class: "axis" });
  for (let i = 0; i <= ticks; i++) {
    const v = min + ((max - min) * i) / ticks;
    const y = f.padT + f.ih - ((v - min) / (max - min || 1)) * f.ih;
    g.appendChild(mk("line", { x1: f.padL, x2: f.padL + f.iw, y1: y, y2: y, class: v === 0 || (min < 0 && Math.abs(v) < 1e-9) ? "zeroline" : "gridline" }));
    const t = mk("text", { x: f.padL - 7, y: y + 3.5, "text-anchor": "end" });
    t.textContent = fmt(v);
    g.appendChild(t);
  }
  f.svg.appendChild(g);
}
function xLabels(f, rows, key, fmt) {
  if (!rows.length) return;
  const g = mk("g", { class: "axis" });
  const n = Math.min(f.phone ? 3 : 6, rows.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (rows.length - 1)) / Math.max(1, n - 1));
    const x = f.padL + ((idx + 0.5) / rows.length) * f.iw;
    const t = mk("text", { x, y: f.height - 7, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" });
    t.textContent = fmt(rows[idx][key]);
    g.appendChild(t);
  }
  f.svg.appendChild(g);
}

/** Diverging bars: positive up, negative down, shared baseline. */
function _divergingBars(host, rows, o) {
  if (!rows.length) { host.innerHTML = '<p class="muted" style="padding:20px 0">No data in range.</p>'; return; }
  const f = frame(host, { height: o.height || 240 });
  const pos = rows.map((r) => r[o.posKey] || 0);
  const neg = rows.map((r) => r[o.negKey] || 0);
  /* Symmetric about zero so a gridline lands exactly on the baseline. An
     independently-scaled axis puts a tick at some arbitrary value next to the
     zero line, which reads as though the baseline itself were non-zero — fatal
     for a chart whose whole job is the sign of the imbalance. Equal arms also
     make "bought above" and "sold below" directly comparable by eye. */
  const m = Math.max(1e-9, maxOf(pos), maxOf(neg));
  const max = m, min = -m;
  yAxis(f, min, max, o.fmt || compact);
  const y0 = f.padT + f.ih - ((0 - min) / (max - min)) * f.ih;
  const bw = f.iw / rows.length;
  const w = Math.max(1, Math.min(18, bw - 2)); // 2px surface gap between bars
  const g = mk("g");
  rows.forEach((r, i) => {
    const cx = f.padL + (i + 0.5) * bw;
    const up = r[o.posKey] || 0, dn = r[o.negKey] || 0;
    const hUp = (up / (max - min)) * f.ih, hDn = (dn / (max - min)) * f.ih;
    if (up > 0) g.appendChild(mk("rect", { x: cx - w / 2, y: y0 - hUp, width: w, height: Math.max(1, hUp), rx: Math.min(4, w / 2), fill: "var(--buy)" }));
    if (dn > 0) g.appendChild(mk("rect", { x: cx - w / 2, y: y0, width: w, height: Math.max(1, hDn), rx: Math.min(4, w / 2), fill: "var(--sell)" }));
  });
  f.svg.appendChild(g);
  // One overlay rather than per-bar hit areas: a fingertip is far wider than a bar.
  const marker = mk("line", { class: "crosshair", y1: f.padT, y2: f.padT + f.ih, x1: 0, x2: 0, opacity: 0 });
  f.svg.appendChild(marker);
  const hit = mk("rect", { x: f.padL, y: f.padT, width: f.iw, height: f.ih, fill: "transparent" });
  onPointer(hit, host, ({ x, y }) => {
    const i = Math.max(0, Math.min(rows.length - 1, Math.floor((x - f.padL) / bw)));
    const r = rows[i]; if (!r) return;
    const cx = f.padL + (i + 0.5) * bw;
    marker.setAttribute("x1", cx); marker.setAttribute("x2", cx); marker.setAttribute("opacity", 1);
    showTip(f, host, cx, y, o.tip(r));
  }, () => { hideTip(f); marker.setAttribute("opacity", 0); });
  f.svg.appendChild(hit);
  xLabels(f, rows, o.xKey, o.xFmt || tsFmt);
}

/** Line chart with crosshair + tooltip. */
function _lineChart(host, rows, o) {
  if (rows.length < 2) { host.innerHTML = '<p class="muted" style="padding:20px 0">Not enough data in range.</p>'; return; }
  const f = frame(host, { height: o.height || 210 });
  const vals = rows.map((r) => r[o.yKey]).filter((v) => isFinite(v));
  let min = minOf(vals), max = maxOf(vals);
  const nonNegative = o.zeroBase && min >= 0;
  if (o.zeroBase) min = Math.min(0, min);
  const padv = (max - min) * 0.08 || Math.abs(max) * 0.1 || 1;
  min = nonNegative ? 0 : min - padv;
  max += padv;
  yAxis(f, min, max, o.fmt || compact);
  const X = (i) => f.padL + (rows.length === 1 ? f.iw / 2 : (i / (rows.length - 1)) * f.iw);
  const Y = (v) => f.padT + f.ih - ((v - min) / (max - min || 1)) * f.ih;
  const d = rows.map((r, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(r[o.yKey]).toFixed(1)}`).join(" ");
  if (o.area) {
    f.svg.appendChild(mk("path", {
      d: `${d} L${X(rows.length - 1)} ${Y(Math.max(min, 0))} L${X(0)} ${Y(Math.max(min, 0))} Z`,
      fill: o.color || "var(--series-1)", opacity: ".12",
    }));
  }
  f.svg.appendChild(mk("path", { d, fill: "none", stroke: o.color || "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  const ch = mk("line", { class: "crosshair", y1: f.padT, y2: f.padT + f.ih, x1: 0, x2: 0, opacity: 0 });
  // >=8px marker so it stays findable under a fingertip
  const dotR = mk("circle", { r: 5, fill: o.color || "var(--series-1)", stroke: "var(--surface-1)", "stroke-width": 2, opacity: 0 });
  f.svg.appendChild(ch); f.svg.appendChild(dotR);
  const hit = mk("rect", { x: f.padL, y: f.padT, width: f.iw, height: f.ih, fill: "transparent" });
  onPointer(hit, host, ({ x }) => {
    const frac = Math.max(0, Math.min(1, (x - f.padL) / f.iw));
    const i = Math.round(frac * (rows.length - 1));
    const r = rows[i]; if (!r) return;
    const px = X(i), py = Y(r[o.yKey]);
    ch.setAttribute("x1", px); ch.setAttribute("x2", px); ch.setAttribute("opacity", 1);
    dotR.setAttribute("cx", px); dotR.setAttribute("cy", py); dotR.setAttribute("opacity", 1);
    showTip(f, host, px, py, o.tip(r));
  }, () => { hideTip(f); ch.setAttribute("opacity", 0); dotR.setAttribute("opacity", 0); });
  f.svg.appendChild(hit);
  xLabels(f, rows, o.xKey, o.xFmt || tsFmt);
}

/** Two or more lines on ONE shared y-scale (never a second axis). */
function _multiLine(host, rows, o) {
  if (rows.length < 2) { host.innerHTML = '<p class="muted" style="padding:20px 0">Not enough data in range.</p>'; return; }
  const f = frame(host, { height: o.height || 210 });
  const all = rows.flatMap((r) => o.series.map((s) => r[s.key])).filter((v) => isFinite(v));
  let min = o.zeroBase ? 0 : minOf(all), max = maxOf(all);
  max += (max - min) * 0.08 || 1;
  yAxis(f, min, max, o.fmt || compact);
  const X = (i) => f.padL + (i / (rows.length - 1)) * f.iw;
  const Y = (v) => f.padT + f.ih - ((v - min) / (max - min || 1)) * f.ih;
  for (const s of o.series) {
    const d = rows.map((r, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(r[s.key] || 0).toFixed(1)}`).join(" ");
    if (o.area) f.svg.appendChild(mk("path", { d: `${d} L${X(rows.length - 1)} ${Y(min)} L${X(0)} ${Y(min)} Z`, fill: s.color, opacity: ".10" }));
    f.svg.appendChild(mk("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  }
  const ch = mk("line", { class: "crosshair", y1: f.padT, y2: f.padT + f.ih, x1: 0, x2: 0, opacity: 0 });
  f.svg.appendChild(ch);
  // a 2px surface ring keeps overlapping markers separable where the lines cross
  const dots = o.series.map((s) => {
    const c = mk("circle", { r: 5, fill: s.color, stroke: "var(--surface-1)", "stroke-width": 2, opacity: 0 });
    f.svg.appendChild(c); return c;
  });
  const hit = mk("rect", { x: f.padL, y: f.padT, width: f.iw, height: f.ih, fill: "transparent" });
  onPointer(hit, host, ({ x }) => {
    const i = Math.round(Math.max(0, Math.min(1, (x - f.padL) / f.iw)) * (rows.length - 1));
    const r = rows[i]; if (!r) return;
    const px = X(i);
    ch.setAttribute("x1", px); ch.setAttribute("x2", px); ch.setAttribute("opacity", 1);
    o.series.forEach((s, k) => {
      dots[k].setAttribute("cx", px); dots[k].setAttribute("cy", Y(r[s.key] || 0)); dots[k].setAttribute("opacity", 1);
    });
    showTip(f, host, px, Y(r[o.series[0].key] || 0), o.tip(r));
  }, () => { hideTip(f); ch.setAttribute("opacity", 0); dots.forEach((d) => d.setAttribute("opacity", 0)); });
  f.svg.appendChild(hit);
  xLabels(f, rows, o.xKey, o.xFmt || dayFmt);
}

/** Simple vertical bars, one series. */
function _barChart(host, rows, o) {
  if (!rows.length) { host.innerHTML = '<p class="muted" style="padding:20px 0">No data in range.</p>'; return; }
  const f = frame(host, { height: o.height || 210 });
  const vals = rows.map((r) => r[o.yKey] || 0);
  const max = Math.max(1e-9, maxOf(vals));
  yAxis(f, 0, max, o.fmt || compact);
  const bw = f.iw / rows.length;
  const w = Math.max(1, Math.min(22, bw - 2));
  const g = mk("g");
  rows.forEach((r, i) => {
    const v = r[o.yKey] || 0;
    const h = (v / max) * f.ih;
    const cx = f.padL + (i + 0.5) * bw;
    if (v > 0) g.appendChild(mk("rect", { x: cx - w / 2, y: f.padT + f.ih - h, width: w, height: Math.max(1, h), rx: Math.min(4, w / 2), fill: o.color || "var(--series-1)" }));
  });
  f.svg.appendChild(g);
  const marker = mk("line", { class: "crosshair", y1: f.padT, y2: f.padT + f.ih, x1: 0, x2: 0, opacity: 0 });
  f.svg.appendChild(marker);
  const hit = mk("rect", { x: f.padL, y: f.padT, width: f.iw, height: f.ih, fill: "transparent" });
  onPointer(hit, host, ({ x, y }) => {
    const i = Math.max(0, Math.min(rows.length - 1, Math.floor((x - f.padL) / bw)));
    const r = rows[i]; if (!r) return;
    const cx = f.padL + (i + 0.5) * bw;
    marker.setAttribute("x1", cx); marker.setAttribute("x2", cx); marker.setAttribute("opacity", 1);
    showTip(f, host, cx, y, o.tip(r));
  }, () => { hideTip(f); marker.setAttribute("opacity", 0); });
  f.svg.appendChild(hit);
  xLabels(f, rows, o.xKey, o.xFmt || dayFmt);
}

/** Grouped bars for two series (never stacked on a shared scale ambiguity). */
function _groupedBars(host, rows, o) {
  if (!rows.length) { host.innerHTML = '<p class="muted" style="padding:20px 0">No data in range.</p>'; return; }
  const f = frame(host, { height: o.height || 210 });
  const max = Math.max(1e-9, maxOf(rows.flatMap((r) => o.keys.map((k) => r[k] || 0))));
  yAxis(f, 0, max, o.fmt || compact);
  const bw = f.iw / rows.length;
  const each = Math.max(1, (Math.min(24, bw - 2) - 2) / o.keys.length);
  const g = mk("g");
  rows.forEach((r, i) => {
    o.keys.forEach((k, j) => {
      const v = r[k] || 0;
      const h = (v / max) * f.ih;
      const x = f.padL + i * bw + (bw - each * o.keys.length - 2) / 2 + j * (each + 2);
      if (v > 0) g.appendChild(mk("rect", { x, y: f.padT + f.ih - h, width: each, height: Math.max(1, h), rx: Math.min(4, each / 2), fill: o.colors[j] }));
    });
  });
  f.svg.appendChild(g);
  const marker = mk("line", { class: "crosshair", y1: f.padT, y2: f.padT + f.ih, x1: 0, x2: 0, opacity: 0 });
  f.svg.appendChild(marker);
  const hit = mk("rect", { x: f.padL, y: f.padT, width: f.iw, height: f.ih, fill: "transparent" });
  onPointer(hit, host, ({ x, y }) => {
    const i = Math.max(0, Math.min(rows.length - 1, Math.floor((x - f.padL) / bw)));
    const r = rows[i]; if (!r) return;
    const cx = f.padL + (i + 0.5) * bw;
    marker.setAttribute("x1", cx); marker.setAttribute("x2", cx); marker.setAttribute("opacity", 1);
    showTip(f, host, cx, y, o.tip(r));
  }, () => { hideTip(f); marker.setAttribute("opacity", 0); });
  f.svg.appendChild(hit);
  xLabels(f, rows, o.xKey, o.xFmt || dayFmt);
}

/** Bullet gauge: one measured value against reference thresholds. */
function _bulletGauge(host, { value, max, markers, label, fmt = (v) => pct(v, 1) }) {
  host.innerHTML = "";
  const phone = isPhone();
  const width = Math.max(240, host.clientWidth || 600), height = phone ? 104 : 92;
  const svg = mk("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height });
  const padL = 10, padR = 10, iw = width - padL - padR;
  const top = 26, bh = 24;
  svg.appendChild(mk("rect", { x: padL, y: top, width: iw, height: bh, rx: 5, fill: "var(--mid)" }));
  const w = Math.max(2, Math.min(iw, (value / max) * iw));
  svg.appendChild(mk("rect", { x: padL, y: top, width: w, height: bh, rx: 5, fill: "var(--series-1)" }));
  const vt = mk("text", { x: padL, y: 17, fill: "var(--text-primary)", style: `font:650 ${phone ? 13 : 15}px var(--mono)` });
  vt.textContent = phone ? fmt(value) : `${fmt(value)} ${label || ""}`;
  svg.appendChild(vt);
  markers.forEach((m, i) => {
    const x = padL + Math.min(1, m.at / max) * iw;
    svg.appendChild(mk("line", { x1: x, x2: x, y1: top - 5, y2: top + bh + 5, stroke: "var(--text-secondary)", "stroke-width": 2 }));
    // stagger two rows on a phone so the threshold labels cannot collide
    const row = phone && i % 2 ? height - 6 : phone ? height - 22 : height - 6;
    const anchor = x < 26 ? "start" : x > width - 26 ? "end" : "middle";
    const t = mk("text", { x, y: row, "text-anchor": anchor, style: "font:10.5px var(--mono)", fill: "var(--text-muted)" });
    t.textContent = `${m.name} ${fmt(m.at)}`;
    svg.appendChild(t);
  });
  host.appendChild(svg);
}

/** Horizontal share bars with direct labels (the light-mode contrast relief). */
function _shareBars(host, rows, colors) {
  host.innerHTML = "";
  const total = rows.reduce((s, r) => s + r.v, 0) || 1;
  const wrap = el("div", { style: "display:flex;flex-direction:column;gap:10px;margin-top:4px" });
  rows.forEach((r, i) => {
    const row = el("div");
    row.appendChild(el("div", { style: "display:flex;justify-content:space-between;font:12px var(--mono);margin-bottom:4px" },
      `<span>${r.k}</span><span>${compact(r.v)} AI &nbsp;<span class="muted">${((r.v / total) * 100).toFixed(1)}%</span></span>`));
    const track = el("div", { style: "height:14px;background:var(--mid);border-radius:4px;overflow:hidden" });
    track.appendChild(el("div", { style: `height:100%;width:${(r.v / total) * 100}%;background:${colors[i % colors.length]};border-radius:4px` }));
    row.appendChild(track);
    wrap.appendChild(row);
  });
  host.appendChild(wrap);
}

/* Charts must track their container, not the window.
   Measuring once at draw time is not enough: a chart drawn inside a hidden tab
   measures zero and keeps a stale viewBox when the tab is shown, and a window
   resize listener misses container changes that are not window resizes. Both
   leave the SVG's viewBox disagreeing with its rendered box, and since the SVG
   is not stretched, the content is scaled down and centred — a chart marooned in
   the middle of its card. On a phone this fires constantly: rotation, and the
   address bar collapsing on scroll.
   So every chart registers how to redraw itself and is observed individually. */
const drawers = new WeakMap();
const chartRO = new ResizeObserver((entries) => {
  for (const e of entries) {
    const host = e.target;
    const w = Math.round(e.contentRect.width);
    if (!w || host.__w === w) continue;   // ignore hidden (0) and no-op reports
    host.__w = w;
    const fn = drawers.get(host);
    if (fn) fn();
  }
});
function draw(host, fn) {
  if (!host) return;
  drawers.set(host, fn);
  host.__w = Math.round(host.clientWidth);
  fn();
  chartRO.observe(host);
}
const wrapChart = (fn) => (host, ...args) => draw(host, () => fn(host, ...args));

const divergingBars = wrapChart(_divergingBars);
const lineChart     = wrapChart(_lineChart);
const multiLine     = wrapChart(_multiLine);
const barChart      = wrapChart(_barChart);
const groupedBars   = wrapChart(_groupedBars);
const bulletGauge   = wrapChart(_bulletGauge);
const shareBars     = wrapChart(_shareBars);

function table(host, cols, rows) {
  host.innerHTML = "";
  const thead = el("thead");
  const tr = el("tr");
  cols.forEach((c) => tr.appendChild(el("th", {}, c.h)));
  thead.appendChild(tr); host.appendChild(thead);
  const tb = el("tbody");
  rows.forEach((r) => {
    const t = el("tr");
    cols.forEach((c) => t.appendChild(el("td", c.attrs ? c.attrs(r) : {}, c.f(r))));
    tb.appendChild(t);
  });
  host.appendChild(tb);
}

/* ── data ───────────────────────────────────────────────────────────────── */
const S = { meta: null, flow: null, burns: null, routing: null, bridges: null, tape: null, pools: null, poolIdx: 0, hours: 24 };

async function loadJSON(name) {
  const r = await fetch(`data/${name}?v=${Date.now()}`);
  if (!r.ok) throw new Error(`data/${name} → HTTP ${r.status}`);
  return r.json();
}

/**
 * Re-fetch the indexed artifacts and re-render when they actually move.
 *
 * Without this the page fetched its data once at load and never again, so every
 * KPI below the live strip froze: a phone left open would show hours-old fees, κ
 * and float while the strip above them refreshed every 30 seconds. The head block
 * is the cheap test for whether a new index has landed at all.
 */
async function refreshData() {
  try {
    const meta = await loadJSON("meta.json");
    if (!meta || meta.headBlock === S.meta?.headBlock) return;   // nothing newly indexed
    const [flow, burns] = await Promise.all(["flow.json", "burns.json"].map(loadJSON));
    const [routing, bridges, tape, pools] = await Promise.all(
      ["routing.json", "bridges.json", "tape.json", "pools.json"].map((f) => loadJSON(f).catch(() => null))
    );
    Object.assign(S, {
      meta, flow, burns,
      routing: routing ?? S.routing, bridges: bridges ?? S.bridges,
      tape: tape ?? S.tape, pools: pools ?? S.pools,
    });
    renderAll();
    refreshLiveTail();   // the live window starts at the new head, so re-scope it
  } catch { /* a failed refresh leaves the last good render in place */ }
}

async function rpcCall(method, params) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/* ── live header ─────────────────────────────────────────────────────────── */

/** Header price and market cap, from the same canonical state the panels use. */
function paintHeaderMarket() {
  if (!S.flow || !S.burns) return;                  // marketState needs the artifacts
  const M = marketState();
  if (M.price) {
    const ch = S.usdChange24h;
    $("#hUsd").innerHTML = `$${M.price < 0.01 ? M.price.toExponential(2) : M.price.toFixed(4)}` +
      (ch == null ? "" : ` <span class="${ch >= 0 ? "up" : "down"}" style="font-size:12px">${ch >= 0 ? "+" : ""}${ch}%</span>`);
    $("#hUsd").title = `price source: ${M.source}`;
  }
  if (M.mcap) {
    $("#hMcap").textContent = "$" + compact(M.mcap);
    $("#hMcap").title = `${M.supplyLive ? "live" : "indexed"} supply × ${M.source}`;
  }
}

/* The figures on screen stay put when the chain polls fail, so say so in text.
   Shown beside the status dot because the dot's colour alone is not readable as
   "these numbers stopped moving", and its title never appears on a touch screen. */
function setLiveLabel(text) {
  const lbl = $("#liveLbl");
  if (!lbl) return;
  lbl.textContent = text || "";
  lbl.hidden = !text;
}

async function refreshLive() {
  try {
    const [bnHex, supplyHex] = await Promise.all([
      rpcCall("eth_blockNumber", []),
      rpcCall("eth_call", [{ to: AI_TOKEN, data: "0x18160ddd" }, "latest"]),
    ]);
    const bn = parseInt(bnHex, 16);
    $("#hBlock").textContent = bn.toLocaleString();
    const supply = Number(BigInt(supplyHex)) / 1e18;
    S.liveSupply = supply;
    paintHeaderMarket();

    // latest pool price straight from the most recent Swap log
    const logs = await rpcCall("eth_getLogs", [{
      address: POOL_MANAGER, topics: [SWAP_TOPIC, AI_NVDA_POOL],
      fromBlock: "0x" + (bn - 40000).toString(16), toBlock: "latest",
    }]);
    if (logs.length) {
      const d = logs[logs.length - 1].data;
      const sq = BigInt("0x" + d.slice(2 + 128, 2 + 192));
      const x = Number(sq) / 2 ** 96;
      const price = x * x;
      $("#hPrice").textContent = sig(price, 5);
    }
    $("#liveDot").classList.remove("stale");
    $("#liveDot").title = `live · block ${bn.toLocaleString()}`;
    setLiveLabel(null);
  } catch (e) {
    $("#liveDot").classList.add("stale");
    $("#liveDot").title = `RPC unreachable: ${e.message}`;
    setLiveLabel(/cors|failed to fetch|networkerror/i.test(e.message || "") ? "rpc blocked" : "rpc down");
  }
  // USD price is a convenience cross-check from a public aggregator.
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${AI_TOKEN}`);
    const j = await r.json();
    const best = (j.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (best) {
      // Cross-check only. The header is painted from marketState() so that the
      // price and market cap shown there are the same ones the panels compute.
      S.usdPrice = Number(best.priceUsd);
      S.usdChange24h = best.priceChange?.h24 ?? null;
      paintHeaderMarket();
    }
  } catch { /* aggregator is optional */ }
  // The valuation table's USD column depends on that price, so refresh it once
  // the first quote lands rather than leaving em-dashes on the opening screen.
  if (S.usdPrice && S.burns && !$("#p-investor").hidden) {
    try { renderInvestor(); } catch { /* a stale price must never blank the tab */ }
  }
}

/* ── tab 1: flow & burn ──────────────────────────────────────────────────── */
function currentPool() { return S.flow.pools[S.poolIdx]; }
function windowRows(hourly) {
  if (!S.hours) return hourly;
  const cut = (S.meta.headTime || Math.floor(Date.now() / 1000)) - S.hours * 3600;
  return hourly.filter((h) => h.t >= cut);
}

function renderFlow() {
  const p = currentPool();
  /* Merge the live tail so this chart does not stop at the last indexed hour.
     That gap is what made a correctly-rendered chart look mis-zoned: it showed
     9 PM at 11 PM because the data genuinely ended there. Live hours are summed
     onto their bucket and flagged, never silently blended into settled ones. */
  const liveB = S.live?.bucketsByPool?.[p.poolId] || [];
  let series = p.hourly;
  if (liveB.length) {
    const byT = new Map(p.hourly.map((x) => [x.t, x]));
    for (const lb of liveB) {
      const ex = byT.get(lb.t);
      byT.set(lb.t, ex
        ? { ...ex, aiBuy: ex.aiBuy + lb.aiBuy, aiSell: ex.aiSell + lb.aiSell,
            buys: ex.buys + lb.buys, sells: ex.sells + lb.sells, close: lb.close || ex.close, live: true }
        : { ...lb });
    }
    series = [...byT.values()].sort((a, b) => a.t - b.t);
  }
  const rows = windowRows(series);
  const q = p.pairSymbol || "quote";

  const aiBuy = rows.reduce((s, r) => s + r.aiBuy, 0);
  const aiSell = rows.reduce((s, r) => s + r.aiSell, 0);
  const buys = rows.reduce((s, r) => s + r.buys, 0);
  const sells = rows.reduce((s, r) => s + r.sells, 0);
  const imb = aiBuy + aiSell > 0 ? (aiBuy - aiSell) / (aiBuy + aiSell) : 0;
  const first = rows[0], last = rows[rows.length - 1];
  const chg = first && last && first.close ? last.close / first.close - 1 : 0;

  const tiles = [
    { lbl: `Net flow (${S.hours ? S.hours + "h" : "all"})`, val: compact(aiBuy - aiSell), note: `AI · ${aiBuy - aiSell >= 0 ? "net bought" : "net sold"}`, cls: aiBuy - aiSell >= 0 ? "up" : "down" },
    { lbl: "Flow imbalance", val: pctLevel(imb), note: `${compact(aiBuy)} bought / ${compact(aiSell)} sold`, cls: imb >= 0 ? "up" : "down" },
    { lbl: "Trade count", val: `${buys + sells}`, note: `${buys} buys · ${sells} sells` },
    { lbl: `Price change (${S.hours ? S.hours + "h" : "all"})`,
      val: Math.abs(chg) > 10 ? `${(1 + chg).toFixed(1)}×` : pct(chg, 2),
      note: `${q} per AI`, cls: chg >= 0 ? "up" : "down" },
  ];
  $("#flowTiles").innerHTML = tiles.map((t) => `
    <div class="tile"><div class="lbl">${t.lbl}</div>
    <div class="val ${t.cls || ""}">${t.val}</div>
    <div class="note">${t.note}</div></div>`).join("");

  divergingBars($("#cFlow"), rows, {
    xKey: "t", posKey: "aiBuy", negKey: "aiSell", height: 250,
    tip: (r) => `<div class="k">${tsFmt(r.t)}</div>
      <div><span style="color:var(--buy)">▲</span> bought ${compact(r.aiBuy)} AI <span class="k">(${r.buys} tx, ${r.buyers} addr)</span></div>
      <div><span style="color:var(--sell)">▼</span> sold ${compact(r.aiSell)} AI <span class="k">(${r.sells} tx, ${r.sellers} addr)</span></div>
      <div class="k">net ${compact(r.aiBuy - r.aiSell)} AI · price ${sig(r.close, 5)}</div>`,
  });

  let cum = 0;
  const net = rows.map((r) => ({ t: r.t, v: (cum += r.aiBuy - r.aiSell) }));
  lineChart($("#cNet"), net, {
    xKey: "t", yKey: "v", zeroBase: true, area: true, color: "var(--series-1)",
    tip: (r) => `<div class="k">${tsFmt(r.t)}</div><div>cumulative net ${compact(r.v)} AI</div>`,
  });

  lineChart($("#cPrice"), rows.filter((r) => r.close > 0), {
    xKey: "t", yKey: "close", color: "var(--series-2)", fmt: (v) => sig(v, 4),
    tip: (r) => `<div class="k">${tsFmt(r.t)}</div><div>${sig(r.close, 6)} ${q} per AI</div>`,
  });

  table($("#tRollup"), [
    { h: "Window", f: (r) => r.hours === 1 ? "1 hour" : `${r.hours} hours` },
    { h: "Buys", f: (r) => r.buys.toLocaleString() },
    { h: "Sells", f: (r) => r.sells.toLocaleString() },
    { h: "AI bought", f: (r) => compact(r.aiBuy) },
    { h: "AI sold", f: (r) => compact(r.aiSell) },
    { h: "Net AI", f: (r) => `<span class="${r.netAI >= 0 ? "up" : "down"}">${compact(r.netAI)}</span>` },
    { h: "Imbalance", f: (r) => `<span class="${r.imbalance >= 0 ? "up" : "down"}">${pct(r.imbalance)}</span>` },
    { h: "Buyers", f: (r) => r.buyers.toLocaleString() },
    { h: "Sellers", f: (r) => r.sellers.toLocaleString() },
    { h: "Price Δ", f: (r) => `<span class="${r.priceChange >= 0 ? "up" : "down"}">${r.priceChange.toFixed(2)}%</span>` },
  ], p.rollups);

  const names = S.tape.pools;
  table($("#tTape"), [
    { h: "Time", f: (r) => tsFmt(r.t) },
    { h: "Pool", f: (r) => `AI / ${names[r.pool] || "?"}` },
    { h: "Side", f: (r) => `<span class="${r.buy ? "up" : "down"}">${r.buy ? "BUY" : "SELL"}</span>` },
    { h: "AI", f: (r) => compact(r.ai) },
    { h: "Quote", f: (r) => compact(r.pair) },
    { h: "Price", f: (r) => sig(r.price, 5) },
  ], S.tape.swaps.slice(0, 40));
}

function renderBurn() {
  const b = S.burns;
  const day = 86400;
  const recent = b.daily.slice(-30);
  const last = b.daily[b.daily.length - 1] || { burnAI: 0 };
  const avg7 = b.daily.slice(-7).reduce((s, r) => s + r.burnAI, 0) / Math.max(1, Math.min(7, b.daily.length));

  $("#burnTiles").innerHTML = [
    { lbl: "Total AI burned", val: compact(b.burned), note: `${pctLevel(b.burned / b.genesisSupply, 2)} of genesis supply` },
    { lbl: "Burn rate (7d avg)", val: compact(avg7), note: "AI per day" },
    { lbl: "Vault NVDA reserve", val: nf(b.vault.nvdaBalance, 1), note: `of ${compact(b.nvdaTotalSupply)} NVDA on chain · not redeemable` },
    { lbl: "Implied fee volume", val: compact(b.impliedAILegVolume), note: `sell-side notional at the measured ${pctLevel(FEE_RATE,2)} fee` },
  ].map((t) => `<div class="tile"><div class="lbl">${t.lbl}</div><div class="val">${t.val}</div><div class="note">${t.note}</div></div>`).join("");

  barChart($("#cBurn"), recent, {
    xKey: "t", yKey: "burnAI", color: "var(--series-2)",
    tip: (r) => `<div class="k">${dayFmt(r.t)}</div><div>burned ${compact(r.burnAI)} AI</div>
      <div class="k">${r.burnEvents} burn events · cumulative ${compact(r.cumBurnAI)}</div>`,
  });
  table($("#tBurn"), [
    { h: "Day", f: (r) => dayFmt(r.t) },
    { h: "AI burned", f: (r) => nf(r.burnAI, 0) },
    { h: "Burn events", f: (r) => `${r.burnEvents}` },
    { h: "AI locked", f: (r) => nf(r.lockAI, 0) },
    { h: "NVDA in", f: (r) => nf(r.nvdaIn, 3) },
    { h: "Cum. burned", f: (r) => compact(r.cumBurnAI) },
    { h: "Cum. NVDA", f: (r) => nf(r.cumNvda, 2) },
  ], b.daily.slice().reverse().slice(0, 40));

  lineChart($("#cReserve"), b.daily, {
    xKey: "t", yKey: "cumNvda", color: "var(--series-3)", area: true, zeroBase: true, xFmt: dayFmt,
    fmt: (v) => nf(v, 0),
    tip: (r) => `<div class="k">${dayFmt(r.t)}</div><div>${nf(r.cumNvda, 2)} NVDA accumulated</div>
      <div class="k">+${nf(r.nvdaIn, 3)} that day</div>`,
  });
}

/* ── tab 2: float & lockup ──────────────────────────────────────────────── */
function renderFloat() {
  const b = S.burns;
  const removed = b.burned + b.vault.aiBalance;
  $("#floatTiles").innerHTML = [
    /* Two denominators live on this tab and they are not interchangeable.
       Removal is measured against the GENESIS mint, because burned AI has already
       left total supply and dividing by what remains would understate it. Holdings
       are measured against CURRENT supply, because that is what exists to hold.
       Both are right; leaving either unlabelled is what made one screen show a
       float of 96.7% beside a chart segment reading 95.8%. So each note names its
       base. */
    { lbl: "Permanently removed", val: compact(removed),
      note: `${pctLevel(removed / b.genesisSupply, 2)} of the ${compact(b.genesisSupply)} genesis mint — burned + vault-locked` },
    { lbl: "Locked as pool inventory", val: compact(b.poolManagerAI),
      note: `${pctLevel(b.poolManagerAI / b.totalSupply, 2)} of current supply, sitting in v4 pools` },
    { lbl: "Effective float", val: compact(b.effectiveFloat),
      note: "current supply less vault and pool inventory" },
    { lbl: "Float / supply", val: pctLevel(b.effectiveFloat / b.totalSupply, 1),
      note: `of the ${compact(b.totalSupply)} in existence — what can change hands` },
  ].map((t) => `<div class="tile"><div class="lbl">${t.lbl}</div><div class="val">${t.val}</div><div class="note">${t.note}</div></div>`).join("");

  shareBars($("#cWaterfall"), [
    { k: "Burned to 0x0 (gone)", v: b.burned },
    { k: "Locked in community vault", v: b.vault.aiBalance },
    { k: "Held as v4 pool inventory", v: b.poolManagerAI },
    { k: "Free float", v: b.effectiveFloat },
  ], ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--mid)"]);

  table($("#tSupply"), [
    { h: "Component", f: (r) => r.k },
    { h: "AI", f: (r) => nf(r.v, 0) },
    { h: "Share of genesis", f: (r) => pctLevel(r.v / b.genesisSupply, 3) },
    { h: "Reversible?", f: (r) => r.rev },
  ], [
    { k: "Genesis supply (single mint)", v: b.genesisSupply, rev: "—" },
    { k: "Burned to 0x0", v: b.burned, rev: "No" },
    { k: "Locked in community vault", v: b.vault.aiBalance, rev: "No (no observed outflow)" },
    { k: "Held as v4 pool inventory", v: b.poolManagerAI, rev: "Yes, if LPs withdraw" },
    { k: "Current total supply", v: b.totalSupply, rev: "—" },
    { k: "Effective float", v: b.effectiveFloat, rev: "—" },
  ]);

  multiLine($("#cRemoval"), b.daily, {
    xKey: "t", zeroBase: true, area: true,
    series: [
      { key: "cumBurnAI", color: "var(--series-1)" },
      { key: "cumLockAI", color: "var(--series-2)" },
    ],
    tip: (r) => `<div class="k">${dayFmt(r.t)}</div>
      <div><span style="color:var(--series-1)">●</span> burned ${compact(r.cumBurnAI)} AI</div>
      <div><span style="color:var(--series-2)">●</span> locked ${compact(r.cumLockAI)} AI</div>
      <div class="k">removed ${compact(r.cumBurnAI + r.cumLockAI)} AI total</div>`,
  });

  const s = b.observedSplit || { burn: 1, lock: 1, platform: 0.5 };
  shareBars($("#cSplit"), [
    { k: "Burned", v: b.burned },
    { k: "Vault-locked", v: b.lockedInVault },
    { k: "Platform fee", v: b.platformLeg },
  ], ["var(--series-1)", "var(--series-2)", "var(--series-3)"]);
  $("#splitNote").textContent =
    `Measured ratio burn : lock : platform = 1 : ${s.lock} : ${s.platform}. ` +
    `Total AI fees taken: ${nf(b.totalAIFee, 0)} AI, implying ${compact(b.impliedAILegVolume)} AI of notional through tolled pools at the observed 0.70% rate.`;
}

/* ── tab 3: bridges & routing ───────────────────────────────────────────── */
function renderBridges() {
  const r = S.routing, br = S.bridges;
  if (!r) {
    $("#routeTiles").innerHTML = `<p class="muted">Routing analysis not available in this build.</p>`;
    return;
  }
  const total = r.directAI + r.crossRoutedAI;
  $("#routeTiles").innerHTML = [
    { lbl: "Measured cross-routing", val: pctLevel(r.measuredKappaRatio, 1), note: `of direct volume — implies "${r.impliedRegime}" regime` },
    { lbl: "Cross-routed AI", val: compact(r.crossRoutedAI), note: `${pctLevel(r.crossRoutedAI / (total || 1), 1)} of all AI volume observed` },
    { lbl: "Cross-routing txs", val: r.transactions.crossRouting.toLocaleString(), note: `of ${r.transactions.multiLeg.toLocaleString()} multi-leg txs` },
    { lbl: "Active AI bridges", val: `${S.meta.poolCounts.active}`, note: `of ${S.meta.poolCounts.withAI.toLocaleString()} pools that contain AI` },
  ].map((t) => `<div class="tile"><div class="lbl">${t.lbl}</div><div class="val">${t.val}</div><div class="note">${t.note}</div></div>`).join("");

  bulletGauge($("#cGauge"), {
    value: r.measuredKappaRatio, max: Math.max(0.45, r.measuredKappaRatio * 1.2),
    fmt: (v) => pctLevel(v, 1),
    label: "of direct volume cross-routed",
    markers: [
      { name: "bear", at: r.scenarios.bear },
      { name: "base", at: r.scenarios.base },
      { name: "bull", at: r.scenarios.bull },
      { name: "x-bull", at: r.scenarios.extraBull },
    ],
  });

  groupedBars($("#cRouting"), r.daily, {
    xKey: "t", keys: ["direct", "cross"], colors: ["var(--series-1)", "var(--series-2)"],
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div>
      <div><span style="color:var(--series-1)">●</span> direct ${compact(d.direct)} AI <span class="k">(${d.directTx} tx)</span></div>
      <div><span style="color:var(--series-2)">●</span> cross-routed ${compact(d.cross)} AI <span class="k">(${d.crossTx} tx)</span></div>
      <div class="k">ratio ${pct(d.ratio, 1)}</div>`,
  });

  if (!br) {
    // Bridge analysis lags or fails independently; say so rather than render blanks.
    $("#bridgeKinds").innerHTML = `<p class="muted">Bridge analysis is still pending for this run.</p>`;
    for (const id of ["#cFormation", "#tBridges"]) $(id).innerHTML = "";
    return;
  }
  /* Bars are the pools still trading, because a pool nobody uses is not a
     bridge. But that count is survivorship-filtered, so the tooltip carries how
     many actually opened that day -- otherwise the chart invents a decline in
     formation out of the older days' casualties. */
  barChart($("#cFormation"), br.formation, {
    xKey: "t", yKey: "newBridges", color: "var(--series-3)",
    fmt: (v) => v.toFixed(0),
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div>
      <div>${d.newBridges} still trading</div>${d.opened == null ? "" :
      `<div class="muted">${d.opened} opened · ${d.opened > d.newBridges
        ? `${d.opened - d.newBridges} since went quiet` : "all still active"}</div>`}`,
  });

  /* Native launches settle ~100% on their AI pair by construction, so blending
     them with organic bridges would overstate how much flow AI actually wins. */
  const k = br.byKind || {};
  $("#bridgeKinds").innerHTML = ["organic", "native"].map((kind) => {
    const s = k[kind]; if (!s || !s.tokens) return "";
    const label = kind === "organic"
      ? "Organic bridges — token existed elsewhere first"
      : "Native launches — created against AI";
    /* Headline is the flow-weighted share when the AI-side meter is available,
       because that is the only cross-token aggregate that is arithmetically valid
       AND weights each token by how much AI actually moves through its bridge.
       The median sits beside it: the two diverge sharply here, and the gap IS the
       finding -- one large token routes through AI while the typical one barely
       does. Falls back to the median on artifacts written before the AI-side
       meter existed. */
    const w = s.weightedShare;
    const head = w ?? s.medianShare ?? s.aiPairShare;
    const basis = w != null ? "flow-weighted" : s.medianShare != null ? "median" : "legacy aggregate";
    const detail = s.medianShare == null ? ""
      : `${w == null ? "" : ` · median ${pctLevel(s.medianShare, 1)}`} · range ${pctLevel(s.minShare ?? 0, 1)}–${pctLevel(s.maxShare ?? 0, 1)}`;
    return `<div class="tile"><div class="lbl">${label}</div>
      <div class="val">${pctLevel(head, 1)}</div>
      <div class="note">${basis} across ${s.tokens} token${s.tokens === 1 ? "" : "s"}${detail}</div></div>`;
  }).join("") || `<p class="muted">No bridge data in window.</p>`;

  const maxShare = Math.max(0.01, maxOf(br.tokens.map((t) => t.aiPairShare)));
  table($("#tBridges"), [
    { h: "Token", f: (t) => t.symbol },
    { h: "Kind", f: (t) => t.kind === "native"
        ? `<span class="muted" title="launched against AI">native</span>`
        : `<b>organic</b>` },
    { h: "AI-pair share", attrs: () => ({ class: "bar-cell" }), f: (t) => `<div class="fill" style="width:${(t.aiPairShare / maxShare) * 100}px"></div><span>${pctLevel(t.aiPairShare, 1)}</span>` },
    { h: "Vol in AI pools", attrs: (t) => ({ title: `in ${t.symbol} units` }), f: (t) => compact(t.volumeInAIPools) },
    { h: "Vol elsewhere", attrs: (t) => ({ title: `in ${t.symbol} units` }), f: (t) => compact(t.volumeElsewhere) },
    ...(br.tokens.some((t) => t.aiSideVolume != null)
      ? [{ h: "AI through bridge", f: (t) => (t.aiSideVolume == null ? "—" : compact(t.aiSideVolume)) }] : []),
    { h: "Venues", f: (t) => t.venues.toLocaleString() },
    { h: "vs AI", f: (t) => `${t.aiVenues}` },
    { h: "Swaps (AI)", f: (t) => t.swapsInAIPools.toLocaleString() },
    { h: "Bridge opened", f: (t) => dayFmt(t.bridgeOpenedAt) },
  ], br.tokens);

  table($("#tRoutes"), [
    { h: "Route", f: (x) => x.route.replace(">", " → AI → ") },
    { h: "Routed AI", f: (x) => compact(x.ai) },
  ], r.topRoutes);

  table($("#tCounter"), [
    // "?" is what artifacts written before counterparties were keyed by address
    // used for a token whose symbol() reverts; treat it as unnamed, not as a name.
    { h: "Paired token", f: (x) => (x.symbol && x.symbol !== "?")
        ? `AI / ${x.symbol}`
        : `AI / <span class="muted" title="${x.token || "symbol() did not return a name"}">unnamed${x.token ? ` · ${x.token.slice(0, 6)}…` : ""}</span>` },
    { h: "Direct AI volume", f: (x) => compact(x.ai) },
  ], r.topCounterparties);
}

/* ── live tail ───────────────────────────────────────────────────────────
   Indexed artifacts are minutes-to-hours old by construction. The things a
   decision actually turns on -- price, and which way flow is leaning right now --
   are read straight from the chain in the browser instead and spliced onto the
   end of the indexed series. This decouples freshness from the cron: the schedule
   governs how much history exists, not how current the top line is. */

const i128 = (hex, i) => BigInt.asIntN(128, BigInt("0x" + hex.slice(2 + 64 * i, 2 + 64 * (i + 1))));
const u256 = (hex, i) => BigInt("0x" + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const SEC_PER_BLOCK = 0.1022;   // measured; used only to bucket the live tail

/** Swaps for one pool over a block range, decoded to the AI leg. */
async function liveSwaps(pool, fromBlock, toBlock) {
  const logs = await rpcCall("eth_getLogs", [{
    address: POOL_MANAGER, topics: [SWAP_TOPIC, pool.poolId],
    fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + toBlock.toString(16),
  }]);
  const dec = pool.pairDecimals ?? 18;
  return logs.map((l) => {
    const a0 = i128(l.data, 0), a1 = i128(l.data, 1);
    const aiRaw = pool.aiIsCurrency0 ? a0 : a1;
    const pairRaw = pool.aiIsCurrency0 ? a1 : a0;
    const r = Number(u256(l.data, 2)) / 2 ** 96;
    const d0 = pool.aiIsCurrency0 ? 18 : dec, d1 = pool.aiIsCurrency0 ? dec : 18;
    const p = r * r * 10 ** (d0 - d1);
    return {
      block: parseInt(l.blockNumber, 16),
      ai: Number(aiRaw) / 1e18,
      pair: Number(pairRaw) / 10 ** dec,
      buy: aiRaw > 0n,                        // swapper receives AI — see decode.mjs
      price: pool.aiIsCurrency0 ? p : (p ? 1 / p : 0),
    };
  });
}

/**
 * Poll for everything since the last indexed block and keep it as a live tail.
 * Deliberately narrow: the busiest few venues and a bounded window, because this
 * runs in the viewer's browser against the same throttled endpoint, on a timer.
 */
async function refreshLiveTail() {
  if (!S.flow || !S.meta || !S.flow.pools.length) return;
  try {
    const head = parseInt(await rpcCall("eth_blockNumber", []), 16);
    const HOUR_BLOCKS = Math.round(3600 / SEC_PER_BLOCK);
    const from = Math.max(S.meta.headBlock + 1, head - 4 * HOUR_BLOCKS);
    if (head <= from) { S.live = null; renderLiveStrip(); return; }

    const pools = S.flow.pools.slice(0, 3);
    const perPool = await Promise.all(pools.map((p) => liveSwaps(p, from, head).catch(() => [])));

    const nowSec = Math.floor(Date.now() / 1000);
    const tOf = (b) => nowSec - Math.round((head - b) * SEC_PER_BLOCK);

    let buy = 0, sell = 0, n = 0, last = null;
    const priceByPool = {};
    /* Five-minute price buckets for the chart tail. Hourly is the right grain for
       settled history but far too coarse for "now": it makes a live chart look
       frozen for up to an hour after the last bucket closed. */
    const pointsByPool = {};
    const bucketsByPool = {};
    perPool.forEach((swaps, i) => {
      for (const s of swaps) {
        n++;
        const h = Math.floor(tOf(s.block) / 3600) * 3600;
        const bk = (bucketsByPool[pools[i].poolId] ||= new Map());
        const row = bk.get(h) || { t: h, aiBuy: 0, aiSell: 0, buys: 0, sells: 0, buyers: 0, sellers: 0, close: 0, live: true };
        if (s.buy) { buy += s.ai; row.aiBuy += s.ai; row.buys++; }
        else { sell += -s.ai; row.aiSell += -s.ai; row.sells++; }
        row.close = s.price;
        bk.set(h, row);
        if (i === 0) last = s;
        priceByPool[pools[i].poolId] = s.price;   // last print per venue
        if (s.price > 0) {
          const slot = Math.floor(tOf(s.block) / 300) * 300;
          const pid = pools[i].poolId;
          (pointsByPool[pid] ||= new Map()).set(slot, { t: slot, close: s.price, live: true });
        }
      }
    });

    S.live = {
      head, from, swaps: n, buy, sell, net: buy - sell,
      imbalance: buy + sell > 0 ? (buy - sell) / (buy + sell) : 0,
      bucketsByPool: Object.fromEntries(Object.entries(bucketsByPool)
        .map(([k, m]) => [k, [...m.values()].sort((x, y) => x.t - y.t)])),
      pools: pools.map((p) => p.pairSymbol), at: nowSec, priceByPool,
      pointsByPool: Object.fromEntries(Object.entries(pointsByPool).map(([k, m]) => [k, [...m.values()].sort((a, b) => a.t - b.t)])),
      lastPrice: last ? last.price : null,
      minutes: Math.max(1, Math.round((head - from) * SEC_PER_BLOCK / 60)),
    };
    renderLiveStrip();
    paintHeaderMarket();   // the live print changes the canonical price
    if (!$("#p-investor").hidden) { try { renderInvestor(); } catch { /* never blank the tab */ } }
  } catch { /* the live tail is a bonus; its failure must not disturb the page */ }
}

function renderLiveStrip() {
  const host = $("#liveStrip");
  if (!host) return;
  const L = S.live;
  if (!L || !L.swaps) {
    host.innerHTML = `<div class="verdict"><div class="detail">No trades on the busiest venues since the last
      indexed block. Everything below is current as of block ${S.meta.headBlock.toLocaleString()}.</div></div>`;
    return;
  }
  host.innerHTML = `
    <div class="verdict ${L.net >= 0 ? "pos" : "neg"}">
      <div class="lead">Live: net ${L.net >= 0 ? "buying" : "selling"} of ${compact(Math.abs(L.net))} AI
        <span style="font-size:13px;font-weight:400;color:var(--text-secondary)">
          (${pctLevel(Math.abs(L.imbalance), 1)} imbalance)</span></div>
      <div class="detail">
        <b>${L.swaps.toLocaleString()} trades</b> across ${L.pools.map((s) => "AI/" + s).join(", ")} in the last
        <b>${L.minutes} minutes</b>, read from the chain just now — ahead of the indexed history below, which
        stops at block ${S.meta.headBlock.toLocaleString()}. Refreshes every 30s.
      </div>
    </div>`;
}

/* ── tab 0: investor view ────────────────────────────────────────────────
   Everything here is derived from the same artifacts the other tabs use. No
   number is hardcoded and no takeaway is written in advance: each conclusion is
   computed from the series it sits under, so it cannot drift out of agreement
   with its own chart. Where a figure is an estimate or a proxy, the text says so. */

const FEE_RATE = 0.007;          // measured: dynamic fee resolves to 7000 pips
const DAY = 86400;

/** A level, not a change: no leading sign. Using pct() here reads as a delta. */
const pctLevel = (x, d = 1) => (x == null || !isFinite(x) ? "—" : `${(+(x * 100).toFixed(d)).toFixed(d)}%`);

/**
 * Drop today's bucket, which is still filling.
 *
 * Every rate and week-over-week comparison here divides by a whole number of
 * days. Including a partial final day understates the current period and
 * therefore manufactures a decline: a run indexed at 06:00 would report the
 * latest week down by a quarter for no reason other than when it was run.
 */
function completeDays(series) {
  if (!series || !series.length) return [];
  const today = Math.floor((S.meta?.headTime || Date.now() / 1000) / DAY) * DAY;
  return series.filter((d) => d.t < today);
}

/** Sum a numeric field over the trailing `days` of a daily series. */
function trailing(series, days, pick, endOffset = 0) {
  if (!series || !series.length) return 0;
  const last = series[series.length - 1].t;
  const hi = last - endOffset * DAY, lo = hi - days * DAY;
  return series.filter((d) => d.t > lo && d.t <= hi).reduce((s, d) => s + (pick(d) || 0), 0);
}
const trend = (now, prior) => (prior > 0 ? now / prior - 1 : null);

/** Daily AI volume per pool, and for the flagship, from the hourly series. */
function dailyVolumes() {
  const all = new Map(), main = new Map();
  for (const p of S.flow.pools) {
    const isMain = p.poolId === S.meta.contracts.aiNvdaPool;
    for (const h of p.hourly) {
      const d = Math.floor(h.t / DAY) * DAY;
      const v = (h.aiBuy || 0) + (h.aiSell || 0);
      all.set(d, (all.get(d) || 0) + v);
      if (isMain) main.set(d, (main.get(d) || 0) + v);
    }
  }
  return [...all.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, total]) => ({ t, total, main: main.get(t) || 0, share: total > 0 ? (main.get(t) || 0) / total : 0 }));
}

/** Net AI flow per day across every indexed pool. */
function dailyNetFlow() {
  const m = new Map();
  for (const p of S.flow.pools) {
    for (const h of p.hourly) {
      const d = Math.floor(h.t / DAY) * DAY;
      const r = m.get(d) || { t: d, buy: 0, sell: 0 };
      r.buy += h.aiBuy || 0; r.sell += h.aiSell || 0;
      m.set(d, r);
    }
  }
  return [...m.values()].sort((a, b) => a.t - b.t).map((r) => ({ ...r, net: r.buy - r.sell }));
}

const takeEl = (tone, html) => `<div class="takeaway ${tone}"><b>Takeaway:</b> ${html}</div>`;
const kpiEl = (big, delta, deltaTone, unit) => `
  <div class="kpi"><span class="big">${big}</span>
  ${delta ? `<span class="delta ${deltaTone}">${delta}</span>` : ""}
  ${unit ? `<span class="unit">${unit}</span>` : ""}</div>`;

function renderInvestor() {
  const b = S.burns, r = S.routing, m = S.meta;
  // Rates and comparisons use whole days only; see completeDays().
  const vols = completeDays(dailyVolumes());
  const flows = completeDays(dailyNetFlow());

  /* ── 1. net flow momentum ─────────────────────────────────────────── */
  const net7 = trailing(flows, 7, (d) => d.net);
  const net7p = trailing(flows, 7, (d) => d.net, 7);
  const buy7 = trailing(flows, 7, (d) => d.buy), sell7 = trailing(flows, 7, (d) => d.sell);
  const imb7 = buy7 + sell7 > 0 ? (buy7 - sell7) / (buy7 + sell7) : 0;
  const liveNet = S.live ? S.live.net : 0;
  $("#kpiFlow").innerHTML = kpiEl(
    `${net7 >= 0 ? "+" : ""}${compact(net7)}`,
    `${pctLevel(imb7, 1)} imbalance`, net7 >= 0 ? "up" : "down", "AI net, 7d");
  lineChart($("#cInvFlow"), flows.slice(-30), {
    xKey: "t", yKey: "net", zeroBase: false, area: true, xFmt: dayFmt,
    color: net7 >= 0 ? "var(--buy)" : "var(--sell)",
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>net ${compact(d.net)} AI</div>
      <div class="k">${compact(d.buy)} bought · ${compact(d.sell)} sold</div>`,
  });
  const liveNote = S.live && S.live.swaps
    ? ` Live, in the last ${S.live.minutes} minutes: net <b>${liveNet >= 0 ? "buying" : "selling"} of ${compact(Math.abs(liveNet))} AI</b> across ${S.live.swaps.toLocaleString()} trades, which is ahead of the indexed series above.`
    : "";
  const flipped = (net7 >= 0) !== (net7p >= 0);
  $("#takeFlow").innerHTML = takeEl(net7 >= 0 ? "pos" : "neg",
    `Traders were net <b>${net7 >= 0 ? "buyers" : "sellers"} of ${compact(Math.abs(net7))} AI</b> over the last 7 days
     (prior 7 days: ${net7p >= 0 ? "+" : ""}${compact(net7p)}).
     ${flipped ? "<b>Direction flipped</b> versus the previous week, which is the signal worth watching."
               : `Direction is unchanged week over week${Math.abs(net7) > Math.abs(net7p) ? " and intensifying" : " and easing"}.`}
     Sustained one-sided absorption is what moves price; a single day is noise.${liveNote}`);

  /* ── 2. fee run-rate ──────────────────────────────────────────────── */
  const fee = (d) => (d.burnAI || 0) + (d.lockAI || 0) + (d.platformAI || 0);
  const feeSeries = completeDays(b.daily.map((d) => ({ t: d.t, fee: fee(d), burn: d.burnAI || 0 })));
  const fee7 = trailing(feeSeries, 7, (d) => d.fee), fee7p = trailing(feeSeries, 7, (d) => d.fee, 7);
  const feeAnnual = (fee7 / 7) * 365;
  const impliedVol = (fee7 / 7) / FEE_RATE;
  const feeTrend = trend(fee7, fee7p);
  $("#kpiFee").innerHTML = kpiEl(compact(feeAnnual),
    feeTrend == null ? "" : `${pct(feeTrend, 0)} vs prior 7d`, feeTrend >= 0 ? "up" : "down",
    "AI/yr fee run-rate");
  lineChart($("#cInvFee"), feeSeries.slice(-30), {
    xKey: "t", yKey: "fee", zeroBase: true, area: true, color: "var(--series-2)", xFmt: dayFmt,
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>${compact(d.fee)} AI of fees</div>
      <div class="k">implies ${compact(d.fee / FEE_RATE)} AI of tolled volume</div>`,
  });
  $("#takeFee").innerHTML = takeEl(feeTrend >= 0 ? "pos" : "warn",
    `Fees are running at <b>${compact(feeAnnual)} AI/yr</b> and
     ${feeTrend == null ? "have no prior period to compare" :
       `<b>${feeTrend >= 0 ? "rose" : "fell"} ${pct(Math.abs(feeTrend), 0).replace("+", "")}</b> against the prior week`}.
     AI-denominated fees are charged on <b>sells only</b> (buys pay in NVDA), so at the measured 0.70% rate this implies <b>${compact(impliedVol)} AI/day</b> of <i>sell-side</i> notional through tolled pools — roughly half the round-trip volume.
     Because the fee is paid in AI, revenue and burn are the same number seen twice — this line is the
     fundamental floor under the token, and it is the one to watch decay.`);

  /* ── 3. hard backing ──────────────────────────────────────────────── */
  const bDaily = completeDays(b.daily);
  const nv7 = trailing(bDaily, 7, (d) => d.nvdaIn), nv7p = trailing(bDaily, 7, (d) => d.nvdaIn, 7);
  const nvTrend = trend(nv7, nv7p);
  const nvdaPerM = (b.vault.nvdaBalance / b.totalSupply) * 1e6;
  $("#kpiVault").innerHTML = kpiEl(nf(b.vault.nvdaBalance, 1),
    `+${nf(nv7 / 7, 2)}/day`, "up", "NVDA in vault");
  lineChart($("#cInvVault"), b.daily.slice(-45), {
    xKey: "t", yKey: "cumNvda", zeroBase: true, area: true, color: "var(--series-3)", xFmt: dayFmt,
    fmt: (v) => nf(v, 0),
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>${nf(d.cumNvda, 1)} NVDA accumulated</div>
      <div class="k">+${nf(d.nvdaIn, 3)} that day</div>`,
  });
  $("#takeVault").innerHTML = takeEl(nvTrend >= 0 ? "pos" : "warn",
    `The vault holds <b>${nf(b.vault.nvdaBalance, 1)} NVDA</b>, growing about
     <b>${nf(nv7 / 7, 2)} per day</b>${nvTrend == null ? "" : ` (${pct(nvTrend, 0)} versus the prior week)`}.
     That is <b>${nf(nvdaPerM, 2)} NVDA per million AI</b> outstanding, and it only ratchets upward —
     no outflow has ever been observed. This is the part of the story that does not depend on the meme holding — but note it is <b>backing, not a claim</b>: the protocol states holders cannot redeem assets from the vault, so it supports the story rather than setting a floor you can exercise.`);

  /* ── 4. hub conversion ────────────────────────────────────────────── */
  const kd = completeDays((r && r.daily) || []);
  const kappa = r ? r.measuredKappaRatio : 0;
  const k7 = trailing(kd, 7, (d) => d.cross), kdir7 = trailing(kd, 7, (d) => d.direct);
  const k7r = kdir7 > 0 ? k7 / kdir7 : 0;
  const k7p = trailing(kd, 7, (d) => d.cross, 7), kdir7p = trailing(kd, 7, (d) => d.direct, 7);
  const k7pr = kdir7p > 0 ? k7p / kdir7p : 0;
  const sc = r ? r.scenarios : { bear: .04, base: .23, bull: .34, extraBull: .40 };
  $("#kpiKappa").innerHTML = kpiEl(pctLevel(kappa, 1),
    k7pr > 0 ? `${pct(k7r - k7pr, 1)} wk/wk` : "", k7r >= k7pr ? "up" : "down",
    "cross-routed vs direct");
  if (kd.length > 1) {
    lineChart($("#cInvKappa"), kd, {
      xKey: "t", yKey: "ratio", zeroBase: true, color: "var(--series-1)", area: true, xFmt: dayFmt,
      fmt: (v) => `${(v * 100).toFixed(0)}%`,
      tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>${pct(d.ratio, 1)} cross-routed</div>
        <div class="k">${compact(d.cross)} routed vs ${compact(d.direct)} direct</div>`,
    });
  } else {
    $("#cInvKappa").innerHTML = `<p class="muted" style="padding:16px 0">Window too short for a trend; the headline figure is the measurement.</p>`;
  }
  $("#takeKappa").innerHTML = takeEl(kappa >= sc.base ? "pos" : "warn",
    `<b>${pctLevel(kappa, 1)}</b> of direct AI volume is other tokens passing through AI, measured from transactions
     where AI is a genuine intermediate hop. That sits <b>${regimeWord(kappa, sc)}</b>
     (bear ${pctLevel(sc.bear, 0)} · base ${pctLevel(sc.base, 0)} · bull ${pctLevel(sc.bull, 0)} · extra-bull ${pctLevel(sc.extraBull, 0)}).
     The circulating model calls this quantity unmeasurable and assumes it; it is not, and this is the number
     that decides whether AI becomes infrastructure or stays a trade.`);

  /* ── 5. fee capture ───────────────────────────────────────────────── */
  const cap = vols.filter((v) => v.total > 0);
  const cap7 = cap.slice(-7), cap7p = cap.slice(-14, -7);
  const capNow = cap7.reduce((s, v) => s + v.main, 0) / Math.max(1e-9, cap7.reduce((s, v) => s + v.total, 0));
  const capPrior = cap7p.length ? cap7p.reduce((s, v) => s + v.main, 0) / Math.max(1e-9, cap7p.reduce((s, v) => s + v.total, 0)) : null;
  $("#kpiCapture").innerHTML = kpiEl(pctLevel(capNow, 1),
    capPrior == null ? "" : `${pct(capNow - capPrior, 1)} wk/wk`, capNow >= (capPrior ?? capNow) ? "up" : "down",
    "of indexed AI volume on AI/NVDA");
  lineChart($("#cInvCapture"), cap.slice(-30), {
    xKey: "t", yKey: "share", zeroBase: true, color: "var(--series-2)", xFmt: dayFmt,
    fmt: (v) => `${(v * 100).toFixed(0)}%`,
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>${pct(d.share, 1)} on AI/NVDA</div>
      <div class="k">${compact(d.main)} of ${compact(d.total)} AI</div>`,
  });
  $("#takeCapture").innerHTML = takeEl(capPrior != null && capNow < capPrior ? "warn" : "pos",
    `<b>${pctLevel(capNow, 1)}</b> of AI volume across the ${S.flow.pools.length} indexed pools crosses the tolled
     AI/NVDA pool${capPrior == null ? "" : `, ${capNow >= capPrior ? "up" : "down"} from ${pctLevel(capPrior, 1)} the week before`}.
     This is the awkward one: every new bridge grows the hub but routes volume <i>away</i> from the pool that
     feeds the vault, so success in indicator 4 can quietly shrink indicator 2. Watch them together, not apart.
     <span class="muted">Denominator is indexed pools only, so treat the level as a trend, not an absolute.</span>`);

  /* ── 6. float removal ─────────────────────────────────────────────── */
  const removed = b.burned + b.vault.aiBalance;
  const rem7 = trailing(bDaily, 7, (d) => (d.burnAI || 0) + (d.lockAI || 0));
  const yrs = rem7 > 0 ? (b.effectiveFloat / (rem7 / 7 * 365)) : Infinity;
  $("#kpiFloat").innerHTML = kpiEl(compact(removed),
    `${pctLevel(removed / b.genesisSupply, 2)} of genesis`, "up", "AI destroyed or locked");
  multiLine($("#cInvFloat"), b.daily.slice(-45), {
    xKey: "t", zeroBase: true, area: true, xFmt: dayFmt,
    series: [{ key: "cumBurnAI", color: "var(--series-1)" }, { key: "cumLockAI", color: "var(--series-2)" }],
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div>
      <div><span style="color:var(--series-1)">●</span> burned ${compact(d.cumBurnAI)} AI</div>
      <div><span style="color:var(--series-2)">●</span> vault-locked ${compact(d.cumLockAI)} AI</div>`,
  });
  $("#takeFloat").innerHTML = takeEl("pos",
    `<b>${compact(removed)} AI (${pctLevel(removed / b.genesisSupply, 2)} of genesis)</b> is gone or immobilised, removing about
     <b>${compact(rem7 / 7)} AI/day</b>. At that pace the current free float would take
     <b>${isFinite(yrs) ? yrs.toFixed(0) + " years" : "indefinitely"}</b> to absorb, so this is a slow structural tailwind,
     <b>not</b> a near-term catalyst. Anyone citing the burn as an imminent supply shock is overselling it.
     <span class="muted">Burned and vault-locked are different tokens, not one counted twice: burned AI is destroyed and
     outside totalSupply, vault AI still exists inside it. They are near-identical in size only because the fee splits 1:1.</span>`);

  renderPrice(feeSeries);
  const leak = renderLeak();
  renderVenues();
  const mult = renderMultiple(feeSeries);
  renderRating({
    feeTrend, leakNow: leak ? leak.leakNow : null,
    leakPrior: leak && leak.series && leak.series.length > 7 ? leak.series[leak.series.length - 8].leak : null,
    kappa, sc,
    multNow: mult ? mult.now : null, multMedian: mult ? mult.median : null,
    nvdaPerDay: nv7 / 7, removedPace: rem7 / 7, net7, net7p,
    organicShare: S.bridges?.byKind?.organic?.tokens
      ? (S.bridges.byKind.organic.weightedShare
         ?? S.bridges.byKind.organic.medianShare
         ?? S.bridges.byKind.organic.aiPairShare) : null,
    organicBasis: S.bridges?.byKind?.organic?.weightedShare != null ? "flow-weighted"
      : S.bridges?.byKind?.organic?.medianShare != null ? "median" : "legacy",
  });
  renderRegime(kappa, sc, capNow, feeAnnual, impliedVol);
  renderValuation(feeAnnual, impliedVol, vols);
  renderTriggers(kappa, sc, capNow, feeAnnual, fee7, fee7p, leak);
  renderVerdict(net7, net7p, feeAnnual, feeTrend, kappa, sc, capNow, capPrior, removed, leak);
}

/**
 * AI priced in USD, from the chain.
 *
 * USDG is a USD stablecoin, so an AI/USDG pool's own price IS the dollar price,
 * with no oracle and no aggregator in the path. That also makes the full history
 * available at hourly resolution, which a spot quote cannot give. The aggregator
 * figure is kept beside it as a cross-check: if the two disagree materially, one
 * is wrong and that is worth surfacing rather than hiding.
 */
function usdPool() {
  const recent = (p) => p.hourly.slice(-72).reduce((s, h) => s + (h.aiBuy || 0) + (h.aiSell || 0), 0);
  return S.flow.pools.filter((p) => p.pairSymbol === "USDG" && p.hourly.length)
    .sort((a, b) => recent(b) - recent(a))[0] || null;
}

/**
 * Dollar history, stitched across every AI/USDG venue.
 *
 * The busiest USDG pool opened on 3 September, so reading price from it alone
 * threw away the dollar history that already existed: an older 1.00% AI/USDG pool
 * has been trading since 22 July. Both quote AI in the same stablecoin, so the
 * earlier pool's closes are the same measurement on a thinner venue, not a
 * different unit — and an investor asking what AI has done in dollars wants the
 * fifty days, not the nine.
 *
 * The splice is conditional, not assumed. Where the two overlap they must agree:
 * if the median ratio across shared hours is off by more than a tenth, the venues
 * are not telling the same story (or one predates a decoding fix) and the older
 * leg is dropped rather than welded on. Inside an hour both have, the busier
 * pool wins, because that is where the price is actually set.
 */
function usdSeries() {
  const pools = S.flow.pools.filter((p) => p.pairSymbol === "USDG" && p.hourly.length);
  if (!pools.length) return { hrs: [], pool: null, spliced: 0, rejected: 0 };
  const recent = (p) => p.hourly.slice(-72).reduce((s, h) => s + (h.aiBuy || 0) + (h.aiSell || 0), 0);
  const ranked = [...pools].sort((a, b) => recent(b) - recent(a));
  const primary = ranked[0];
  const byT = new Map(primary.hourly.filter((h) => h.close > 0).map((h) => [h.t, h]));

  let spliced = 0, rejected = 0;
  for (const other of ranked.slice(1)) {
    const own = other.hourly.filter((h) => h.close > 0);
    const ratios = [];
    for (const h of own) { const m = byT.get(h.t); if (m) ratios.push(h.close / m.close); }
    if (ratios.length >= 3) {
      ratios.sort((a, b) => a - b);
      const med = ratios[Math.floor(ratios.length / 2)];
      if (!(med > 0.9 && med < 1.1)) { rejected++; continue; }
    } else if (ratios.length) {
      rejected++; continue;                 // too little overlap to trust the weld
    }
    for (const h of own) if (!byT.has(h.t)) { byT.set(h.t, { ...h, spliced: true }); spliced++; }
  }
  return {
    hrs: [...byT.values()].sort((a, b) => a.t - b.t),
    pool: primary, spliced, rejected, venues: ranked.length,
  };
}

/**
 * The single source of truth for price, supply and market cap.
 *
 * These were derived three different ways: the header used a live supply call
 * times an aggregator quote, the price panel used indexed supply times the
 * on-chain USDG close, and the valuation table used indexed supply times the
 * aggregator. Three market caps that could never agree, on one page — and
 * whichever a reader happened to look at is the one they would act on.
 *
 * Precedence is freshness then authority: a live on-chain USDG print beats the
 * indexed close, which beats the aggregator; a live supply call beats the indexed
 * figure. The aggregator stays as the cross-check, and when the two disagree
 * materially the caller is told rather than silently handed one of them.
 */
function marketState() {
  const b = S.burns;
  const pool = usdPool();
  const livePx = pool && S.live?.priceByPool ? S.live.priceByPool[pool.poolId] : null;
  const indexedPx = pool?.hourly?.length
    ? [...pool.hourly].reverse().find((h) => h.close > 0)?.close ?? null : null;
  const agg = S.usdPrice || null;

  let price = livePx || indexedPx || agg || null;
  let source = livePx ? "live on-chain AI/USDG"
    : indexedPx ? "indexed on-chain AI/USDG"
    : agg ? "aggregator" : "none";
  const chainPx = livePx || indexedPx;
  const disagrees = !!(chainPx && agg && (chainPx / agg > 1.25 || agg / chainPx > 1.25));
  if (disagrees && agg) { price = agg; source = "aggregator (on-chain price rejected)"; }

  const supply = S.liveSupply || b?.totalSupply || null;
  return {
    price, source, agg, disagrees, pool,
    supply, supplyLive: !!S.liveSupply,
    mcap: price && supply ? price * supply : null,
  };
}

function renderPrice(feeSeries) {
  const b = S.burns;
  const pool = usdPool();
  if (!pool) { $("#kpiPrice").innerHTML = `<p class="muted">No AI/USDG venue indexed.</p>`; return null; }

  const U = usdSeries();
  const hrs = U.hrs;
  if (!hrs.length) { $("#kpiPrice").innerHTML = `<p class="muted">No priced hours yet.</p>`; return null; }
  const last = hrs[hrs.length - 1];
  const at = (hoursAgo) => {
    const t = last.t - hoursAgo * 3600;
    let best = null;
    for (const h of hrs) if (h.t <= t) best = h;
    return best ? best.close : null;
  };
  const M = marketState();
  const px = M.price || last.close;
  /* A change is only meaningful if the historical leg sits on the same scale as
     the current price. Stored buckets can predate a decoding fix — the USDG
     decimals error left old closes 10^12 too small — and comparing today against
     one of those rendered "+139,740,061,052,265% 24h" on screen. Implausible
     comparisons are withheld, because an absurd number is still read as a number. */
  const sane = (h) => (h && px && h / px > 0.05 && h / px < 20 ? h : null);
  const raw24 = at(24), raw168 = at(168), raw720 = at(720);
  const p24 = sane(raw24), p7d = sane(raw168), p30d = sane(raw720);
  const historySuspect = (raw24 && !p24) || (raw168 && !p7d) || (raw720 && !p30d);
  const c24 = p24 ? px / p24 - 1 : null, c7 = p7d ? px / p7d - 1 : null;
  const c30 = p30d ? px / p30d - 1 : null;
  const spanOf = (rows) => {
    if (rows.length < 2) return "one hour";
    const secs = rows[rows.length - 1].t - rows[0].t;
    const days = Math.round(secs / 86400);
    return days >= 1 ? `${days} days` : `${Math.max(1, Math.round(secs / 3600))} hours`;
  };
  const mcap = M.mcap ?? px * b.totalSupply;
  const money = (v) => (v < 0.01 ? `$${v.toExponential(3)}` : `$${v.toFixed(4)}`);

  /* Sanity gate. If the on-chain price and the aggregator disagree by more than
     a quarter, the decimals or the pool choice is wrong. A confidently wrong
     price is worse than none, and this is precisely how a 10^12 decimals error
     (USDG configured at 18 when it is 6) surfaced. */
  const agg = M.agg;
  const disagrees = M.disagrees;

  $("#kpiPrice").innerHTML = kpiEl(money(px),
    c24 == null ? "" : `${pct(c24, 1)} 24h`, c24 >= 0 ? "up" : "down",
    `market cap $${compact(mcap)}`);

  /* Chart = settled hourly history + the live five-minute tail. Without the tail
     the line simply stops at the last indexed hour, which on a page that calls
     itself a monitor reads as broken rather than as "not yet indexed". */
  const onScale = hrs.filter((h) => sane(h.close) != null);
  const offScale = hrs.length - onScale.length;
  const livePts = (S.live?.pointsByPool?.[pool.poolId] || []).filter((pt) => pt.t > (onScale.at(-1)?.t || 0));
  const chartRows = [...onScale.slice(-24 * 30), ...livePts];
  lineChart($("#cInvPrice"), chartRows, {
    xKey: "t", yKey: "close", color: (c7 ?? 0) >= 0 ? "var(--buy)" : "var(--sell)", area: true,
    fmt: (v) => (v < 0.01 ? v.toExponential(1) : `$${v.toFixed(3)}`),
    tip: (h) => `<div class="k">${tsFmt(h.t)}${h.live ? " · live" : ""}</div><div>${money(h.close)} per AI</div>
      <div class="k">market cap $${compact(h.close * (M.supply || b.totalSupply))}</div>`,
  });

  // Price against fundamentals: the comparison that says whether a move was earned.
  const fee7 = trailing(feeSeries, 7, (d) => d.fee), fee7p = trailing(feeSeries, 7, (d) => d.fee, 7);
  const feeChg = fee7p > 0 ? fee7 / fee7p - 1 : null;
  const verdict = feeChg == null ? "" :
    (c7 ?? 0) >= 0 && feeChg < 0 ? "rising while the cash flow behind it shrinks — that re-rating is sentiment, not earnings"
    : (c7 ?? 0) < 0 && feeChg < 0 ? "falling alongside the cash flow, which is at least internally consistent"
    : (c7 ?? 0) >= 0 && feeChg >= 0 ? "rising with the cash flow behind it, which is the healthy combination"
    : "falling while fees improve, which is the combination usually worth buying";
  const suspectNote = historySuspect
    ? ` <span class="muted">Price history before the last re-index is on a different scale and is being withheld until it is re-derived; the current price is unaffected.</span>`
    : "";
  const scaleNote = offScale
    ? ` <span class="muted">${offScale.toLocaleString()} earlier hours are off-scale against the current price and are left off the chart until they are re-derived.</span>`
    : "";
  const splicedShown = onScale.filter((h) => h.spliced).length;
  const sourceNote = splicedShown
    ? ` <span class="muted">Dollar history spans ${spanOf(onScale)} across ${U.venues} AI/USDG venues: the busiest sets the current price, and ${splicedShown.toLocaleString()} earlier hours come from the older pool, accepted only because the two agree where they overlap.</span>`
    : ` <span class="muted">Dollar history spans ${spanOf(onScale)} from the busiest AI/USDG venue.${U.rejected ? ` ${U.rejected} other USDG venue(s) disagreed in the overlap and were left out.` : ""}</span>`;
  $("#takePrice").innerHTML = takeEl(disagrees ? "warn" : historySuspect ? "warn" : (c7 ?? 0) >= 0 ? "pos" : "neg",
    disagrees
      ? `<b>On-chain and aggregator prices disagree materially</b> (${money(px)} vs $${agg.toPrecision(4)}).
         Treat both as suspect until reconciled; this normally means a token's decimals or the chosen pool is wrong.`
      : `AI is <b>${money(px)}</b>, a market cap of <b>$${compact(mcap)}</b>${c24 == null ? "" : `, <b>${pct(c24, 1)}</b> over 24h`}${c7 == null ? "" : ` and <b>${pct(c7, 1)}</b> over 7 days`}${c30 == null ? "" : `, <b>${pct(c30, 1)}</b> over 30 days`}.
         ${feeChg == null ? "" : `Fees over the same week ${feeChg >= 0 ? "rose" : "fell"} <b>${pctLevel(Math.abs(feeChg), 0)}</b>, so price is ${verdict}.`}
         ${agg ? `<span class="muted">Aggregator cross-check: ${agg.toPrecision(4)}.</span>` : ""}${suspectNote}${scaleNote}${sourceNote}`);
  return { px, mcap };
}

/**
 * Cash-flow multiple: market cap divided by the annualised fee run-rate.
 *
 * Both terms scale linearly with the AI price, so it cancels exactly and the
 * multiple reduces to supply / annual-fee-in-AI. That is worth stating plainly,
 * because it has a conclusion most holders will not expect: a price fall does
 * NOT make this token cheaper on cash flow. Revenue is denominated in the token
 * itself, so it falls with the price. Only rising AI-denominated fee income --
 * that is, rising volume through pools that actually charge -- re-rates it.
 */
function renderMultiple(feeSeries) {
  const b = S.burns;
  const byDay = new Map(b.daily.map((d) => [d.t, d]));
  const series = [];
  for (let i = 6; i < feeSeries.length; i++) {
    const window = feeSeries.slice(i - 6, i + 1);
    const annual = (window.reduce((s, d) => s + d.fee, 0) / 7) * 365;
    const cum = byDay.get(feeSeries[i].t)?.cumBurnAI ?? 0;
    const supply = b.genesisSupply - cum;
    if (annual > 0) series.push({ t: feeSeries[i].t, mult: supply / annual });
  }
  const now = series.length ? series[series.length - 1].mult : null;
  const prior = series.length > 7 ? series[series.length - 8].mult : null;
  const chg = prior ? now / prior - 1 : null;

  $("#kpiMultiple").innerHTML = kpiEl(now == null ? "—" : `${now.toFixed(1)}×`,
    chg == null ? "" : `${pct(chg, 0)} wk/wk · ${chg > 0 ? "dearer" : "cheaper"}`,
    chg <= 0 ? "up" : "down", "supply ÷ annual fees");
  if (series.length > 1) {
    lineChart($("#cInvMultiple"), series, {
      xKey: "t", yKey: "mult", color: "var(--series-1)", xFmt: dayFmt,
      fmt: (v) => `${v.toFixed(0)}×`,
      tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>${d.mult.toFixed(1)}× cash flow</div>`,
    });
  } else $("#cInvMultiple").innerHTML = `<p class="muted" style="padding:16px 0">Not enough complete days yet.</p>`;

  const sortedM = series.map((x) => x.mult).sort((a, b) => a - b);
  const median = sortedM.length ? sortedM[Math.floor(sortedM.length / 2)] : null;
  $("#takeMultiple").innerHTML = takeEl(chg == null ? "" : chg <= 0 ? "pos" : "neg",
    now == null ? "No fee history yet."
    : `AI trades at <b>${now.toFixed(1)}× its annualised fee run-rate</b>${chg == null ? "" :
        `, ${chg > 0 ? "up" : "down"} ${pctLevel(Math.abs(chg), 0)} on the week — ${chg > 0 ? "more expensive" : "cheaper"} than seven days ago`}.
       The counterintuitive part: <b>this number does not move when the price moves.</b> Fees are earned in AI, so
       revenue and market cap rise and fall together and the ratio cancels. You cannot buy this dip on cash flow —
       only more volume through fee-bearing pools can re-rate it.`);
  return { now, median };
}

/**
 * Where the fees leak: fee-bearing (hooked) venues versus hookless ones.
 *
 * This is the mechanism behind the revenue decline, and it is not a demand
 * problem. v4 pools are permissionless, so anyone can open a competing AI pool
 * with no hook and a lower fee. Routers then prefer it on price, and the volume
 * that used to pay the vault stops paying anything.
 */
function renderLeak() {
  const DAYS = 30;
  const perDay = new Map();
  for (const p of S.flow.pools) {
    for (const h of p.hourly) {
      const d = Math.floor(h.t / DAY) * DAY;
      const row = perDay.get(d) || { t: d, hooked: 0, hookless: 0 };
      const v = (h.aiBuy || 0) + (h.aiSell || 0);
      if (p.isLongHook) row.hooked += v; else row.hookless += v;
      perDay.set(d, row);
    }
  }
  const series = completeDays([...perDay.values()].sort((a, b) => a.t - b.t))
    .map((r) => ({ ...r, total: r.hooked + r.hookless, leak: (r.hooked + r.hookless) > 0 ? r.hookless / (r.hooked + r.hookless) : 0 }))
    .slice(-DAYS);

  const last = series[series.length - 1];
  const first = series[0];
  const leakNow = last ? last.leak : 0;

  $("#kpiLeak").innerHTML = kpiEl(pctLevel(leakNow, 1),
    first ? `from ${pctLevel(first.leak, 1)} on ${dayFmt(first.t)}` : "", leakNow > (first?.leak ?? 0) ? "down" : "up",
    "of AI volume pays no fee");
  if (series.length > 1) {
    multiLine($("#cInvLeak"), series, {
      xKey: "t", zeroBase: true, area: true, xFmt: dayFmt,
      series: [{ key: "hooked", color: "var(--series-1)" }, { key: "hookless", color: "var(--series-2)" }],
      tip: (d) => `<div class="k">${dayFmt(d.t)}</div>
        <div><span style="color:var(--series-1)">●</span> fee-bearing ${compact(d.hooked)} AI</div>
        <div><span style="color:var(--series-2)">●</span> hookless ${compact(d.hookless)} AI</div>
        <div class="k">${pctLevel(d.leak, 1)} of volume pays nothing</div>`,
    });
  }

  // Name the venue actually doing the damage, rather than describing it abstractly.
  const recent = (p) => p.hourly.slice(-72).reduce((s, h) => s + (h.aiBuy || 0) + (h.aiSell || 0), 0);
  const worst = S.flow.pools.filter((p) => !p.isLongHook)
    .map((p) => ({ p, v: recent(p) })).sort((a, b) => b.v - a.v)[0];
  const feeOf = (p) => p.lastFeePips != null ? pctLevel(p.lastFeePips / 1e6, 2) : (p.dynamicFee ? "dynamic" : pctLevel(p.fee / 1e6, 2));
  const main = S.flow.pools.find((p) => p.poolId === S.meta.contracts.aiNvdaPool);

  $("#takeLeak").innerHTML = takeEl(leakNow > 0.5 ? "neg" : leakNow > 0.25 ? "warn" : "pos",
    `<b>${pctLevel(leakNow, 1)} of AI volume now crosses pools that pay the vault nothing</b>${first ? `, against ${pctLevel(first.leak, 1)} on ${dayFmt(first.t)}` : ""}.
     ${worst && worst.v > 0
        ? `The largest of them is <b>AI / ${worst.p.pairSymbol} at ${feeOf(worst.p)}</b>, opened ${dayFmt(worst.p.createdAt)} with no hook —
           versus <b>${feeOf(main)}</b> on the tolled AI/NVDA pool. Routers choose on execution cost, so the cheaper hookless venue wins the flow.`
        : ""}
     This is why revenue fell while total volume did not. It is a <b>structural</b> problem, not a cyclical one:
     v4 pools are permissionless, so the toll can always be undercut by a pool that provides no funding to the protocol.`);

  return { leakNow, worst, series };
}

function regimeWord(v, sc) {
  if (v >= sc.extraBull) return "at or above the model's extra-bull case";
  if (v >= sc.bull) return "between its bull and extra-bull cases";
  if (v >= sc.base) return "between its base and bull cases";
  if (v >= sc.bear) return "between its bear and base cases";
  return "below even the model's bear case";
}
const bandFor = (v, sc) => v >= sc.extraBull ? ["xbull", "extra-bull"] : v >= sc.bull ? ["bull", "bull"]
  : v >= sc.base ? ["base", "base"] : v >= sc.bear ? ["bear", "bear→base"] : ["bear", "below bear"];

function renderRegime(kappa, sc, capNow, feeAnnual) {
  const b = S.burns;
  const mainSc = { bear: .05, base: .10, bull: .12, extraBull: .12 };  // model's main-pool-share cases
  const rows = [
    { k: "Cross-routing κ (vs direct volume)", v: pctLevel(kappa, 1), band: bandFor(kappa, sc),
      note: "measured from same-tx pass-through hops" },
    { k: "Fee capture on AI/NVDA", v: pctLevel(capNow, 1), band: bandFor(capNow, mainSc),
      note: "indexed pools only; model cases 5 / 10 / 12%" },
    { k: "Fee run-rate", v: `${compact(feeAnnual)} AI/yr`, band: ["na", "measured"],
      note: "all three splitter legs, annualised from 7d" },
    { k: "NVDA reserve (not redeemable)", v: `${nf(b.vault.nvdaBalance, 1)} NVDA`, band: ["na", "measured"],
      note: "no outflow ever observed; holders cannot redeem" },
    { k: "Supply removed", v: pctLevel((b.burned + b.vault.aiBalance) / b.genesisSupply, 2), band: ["na", "measured"],
      note: "burned + vault-locked, of genesis" },
  ];
  table($("#tRegime"), [
    { h: "Input", f: (x) => x.k },
    { h: "Measured", f: (x) => `<b>${x.v}</b>` },
    { h: "Reads as", f: (x) => `<span class="band ${x.band[0]}">${x.band[1]}</span>` },
    { h: "Note", f: (x) => `<span class="muted">${x.note}</span>` },
  ], rows);
  $("#regimeTake").innerHTML = takeEl(kappa >= sc.base ? "pos" : "warn",
    `The two inputs that can be scored against the model land at <b>${bandFor(kappa, sc)[1]}</b> for hub conversion and
     <b>${bandFor(capNow, mainSc)[1]}</b> for fee capture. Everything else here is a measurement, not a forecast —
     the model's own scenarios are assumptions, and the point of this table is that three of these five no longer
     have to be.`);
}

function renderValuation(feeAnnual, impliedVol, vols) {
  const b = S.burns;
  const M = marketState();
  const px = M.price;                  // canonical: see marketState()
  const usd = (ai) => (px ? `$${compact(ai * px)}` : "—");
  const mcap = M.mcap;
  const vol30 = vols.slice(-30);
  const avgDailyVol = vol30.length ? vol30.reduce((s, v) => s + v.total, 0) / vol30.length : 0;

  const rows = [
    { m: "Fee run-rate (annualised)", ai: `${compact(feeAnnual)} AI`, u: usd(feeAnnual), n: "measured, all three legs" },
    { m: "Capitalised at 7.5% (bear discount)", ai: `${compact(feeAnnual / 0.075)} AI`, u: usd(feeAnnual / 0.075), n: "yield method" },
    { m: "Capitalised at 6.0% (base discount)", ai: `${compact(feeAnnual / 0.06)} AI`, u: usd(feeAnnual / 0.06), n: "yield method" },
    { m: "Capitalised at 5.0% (bull discount)", ai: `${compact(feeAnnual / 0.05)} AI`, u: usd(feeAnnual / 0.05), n: "rate the model gives listed venues with real revenue" },
    { m: "Indexed AI volume, 30d average", ai: `${compact(avgDailyVol)} AI/day`, u: usd(avgDailyVol), n: "indexed pools only — a floor, not the full tape" },
    { m: "Current market cap", ai: `${compact(b.totalSupply)} AI supply`, u: mcap ? `$${compact(mcap)}` : "—", n: `${M.source}, ${M.supplyLive ? "live" : "indexed"} supply` },
  ];
  table($("#tValuation"), [
    { h: "Measure", f: (x) => x.m },
    { h: "In AI", f: (x) => x.ai },
    { h: "In USD", f: (x) => x.u },
    { h: "Basis", f: (x) => `<span class="muted">${x.n}</span>` },
  ], rows);

  const capBase = feeAnnual / 0.06 * (px || 0);
  const ratio = mcap && capBase ? capBase / mcap : null;
  $("#takeValuation").innerHTML = takeEl(ratio == null ? "warn" : ratio >= 1 ? "pos" : "neg",
    ratio == null
      ? `No USD price available right now, so only the AI-denominated column is meaningful.`
      : `On the fee stream alone, capitalised at the base 6%, the measured revenue supports about
         <b>$${compact(capBase)}</b> against a market cap of <b>$${compact(mcap)}</b> —
         <b>${ratio >= 1 ? `${ratio.toFixed(2)}× above` : `${(1 / ratio).toFixed(2)}× below`}</b> the current price.
         ${ratio >= 1
            ? "The revenue alone would justify the price, which means the monetary premium is being had for free."
            : "So the price already embeds growth the current fee stream does not cover; you are paying for the hub thesis converting, not for today's cash flow."}
         Treat this as a floor calculation: it values the toll and ignores both the NVDA reserve and any monetary premium.`);
}

function renderVenues() {
  const recent = (p) => p.hourly.slice(-72).reduce((s, h) => s + (h.aiBuy || 0) + (h.aiSell || 0), 0);
  const rows = S.flow.pools.map((p) => ({ p, v: recent(p) })).sort((a, b) => b.v - a.v);
  const total = rows.reduce((s, r) => s + r.v, 0) || 1;
  table($("#tVenues"), [
    { h: "Venue", f: (r) => `AI / ${r.p.pairSymbol || "?"}${r.p.poolId === S.meta.contracts.aiNvdaPool ? " <b>(tolled)</b>" : ""}` },
    { h: "Fee", f: (r) => r.p.lastFeePips != null ? pctLevel(r.p.lastFeePips / 1e6, 2) : (r.p.dynamicFee ? "dynamic" : pctLevel(r.p.fee / 1e6, 2)) },
    { h: "Pays vault?", f: (r) => r.p.isLongHook ? `<span class="band bull">yes</span>` : `<span class="band bear">no</span>` },
    { h: "Vol (72h)", f: (r) => compact(r.v) },
    { h: "Share", attrs: () => ({ class: "bar-cell" }),
      f: (r) => `<div class="fill" style="width:${(r.v / total) * 110}px"></div><span>${pctLevel(r.v / total, 1)}</span>` },
    { h: "Opened", f: (r) => dayFmt(r.p.createdAt) },
    { h: "Swaps", f: (r) => r.p.totalSwaps.toLocaleString() },
  ], rows);
  const paying = rows.filter((r) => r.p.isLongHook).reduce((s, r) => s + r.v, 0);
  const boner = (S.bridges?.tokens || []).find((t) => /boner/i.test(t.symbol || ""));
  if (boner) {
    const host = $("#takeBoner");
    if (host) host.innerHTML = (takeEl(boner.aiPairShare < 0.30 ? "neg" : "pos",
      `The circulating thesis rests on one hard number: that the AI/BONER bridge settles
       <b>35–37%</b> of all BONER trading. Measured here across its ${boner.venues.toLocaleString()} venues, it is
       <b>${pctLevel(boner.aiPairShare, 1)}</b>${boner.aiPairShare < 0.30
        ? ` — under half the claim. That may be decay since the bridge's early peak rather than the
           figure having been wrong when written, but it is the load-bearing evidence for AI as a hub
           and it is no longer where the argument needs it to be.`
        : `, broadly consistent with the claim.`}`));
  } else { const host = $("#takeBoner"); if (host) host.innerHTML = ""; }
  $("#takeVenues").innerHTML = takeEl(paying / total < 0.5 ? "neg" : "pos",
    `Of the last 72 hours of indexed AI volume, <b>${pctLevel(paying / total, 1)}</b> crossed a venue that funds the vault.
     The tolled pool is the oldest and the most expensive; every newer hookless pool competes with it directly on price
     while contributing nothing to the burn. Fee capture is therefore a function of venue competition, not of demand —
     which is why it can fall on a day when total volume rises.`);
}

function renderTriggers(kappa, sc, capNow, feeAnnual, fee7, fee7p, leak) {
  const rows = [
    ["Hookless share of AI volume keeps climbing",
     `${leak ? pctLevel(leak.leakNow, 1) : "—"} of volume now pays the vault nothing. This is the live cause of the revenue decline; if it keeps rising, fee-based valuation keeps falling regardless of how well the ecosystem does.`,
     leak && leak.leakNow > 0.5 ? "neg" : "warn"],
    ["Hub conversion breaks above " + pctLevel(sc.bull, 0),
     `κ is ${pctLevel(kappa, 1)}. Clearing ${pctLevel(sc.bull, 0)} on a sustained basis would move the thesis from "plausible" to "happening" and is the strongest add signal here.`,
     kappa >= sc.bull ? "pos" : "warn"],
    ["Hub conversion falls back under " + pctLevel(sc.bear, 0),
     `That would mean routers stopped choosing AI as the path. It is the cleanest single disconfirmation of the whole thesis.`,
     kappa < sc.bear ? "neg" : "pos"],
    ["Fee run-rate falls two weeks running",
     `Fees ${fee7 >= fee7p ? "rose" : "fell"} this week. Revenue is the floor under the valuation; two consecutive declines means the floor is moving down, not the multiple.`,
     fee7 >= fee7p ? "pos" : "warn"],
    ["Fee capture keeps sliding while κ rises",
     `Capture is ${pctLevel(capNow, 1)}. This combination means the hub is winning volume the vault does not get paid on — growth that does not accrue to holders.`,
     "warn"],
    ["Any outflow from the community vault",
     `Nothing has ever left it. The first withdrawal would break the "permanently locked" premise that the float maths depends on, and should be treated as material.`,
     "pos"],
  ];
  $("#triggers").innerHTML = rows.map(([h, d, tone]) => `
    <div style="display:flex;gap:11px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--border)">
      <span class="band ${tone === "pos" ? "bull" : tone === "neg" ? "bear" : "base"}" style="margin-top:2px;flex:0 0 auto">
        ${tone === "pos" ? "ok" : tone === "neg" ? "alert" : "watch"}</span>
      <div><div style="font-size:13px;font-weight:600;margin-bottom:2px">${h}</div>
      <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.55">${d}</div></div>
    </div>`).join("");
}

/**
 * The headline rating.
 *
 * It rates FUNDAMENTAL CONDITION, not price direction, and says so — because the
 * backtest in src/backtest.mjs does not support a price call. Across ~60 days of
 * hourly data, once t-statistics are deflated for overlapping windows, exactly
 * one predictor/horizon cell survives significance and it is NEGATIVE: six-hour
 * flow imbalance against the next hour, r = −0.10. Flow's apparently huge
 * relationship with price (r = 0.60) is contemporaneous and mechanical — in an
 * AMM price moves *because* of net flow — and it does not persist forward.
 *
 * Weights therefore follow evidence rather than intuition. Fee trend carries most
 * because it is the only measure with even suggestive forward signal (fee growth
 * vs next-day return: r = 0.27, 63% hit, and even that misses 5% significance at
 * n = 46). Structural measures come next, on the reasoning that they drive fees.
 * Net flow is deliberately near zero: the evidence says it is a coincident
 * indicator dressed as a leading one, and weighting it heavily would import a
 * mechanical correlation as though it were foresight.
 */
function renderRating(parts) {
  const { feeTrend, leakNow, leakPrior, kappa, sc, multNow, multMedian, nvdaPerDay, removedPace, net7, net7p } = parts;
  const clamp = (x) => Math.max(-1, Math.min(1, x));   // no single input dominates

  const comps = [
    { k: "Fee run-rate trend", w: 3.0, s: feeTrend == null ? null : clamp(feeTrend / 0.25),
      v: feeTrend == null ? "—" : pct(feeTrend, 0) + " wk/wk",
      why: "the only measure with even suggestive forward signal" },
    { k: "Fee capture (toll leakage)", w: 2.5,
      s: leakNow == null ? null : (leakPrior == null ? clamp((0.5 - leakNow) * 2) : clamp((leakPrior - leakNow) * 6)),
      v: leakNow == null ? "—" : pctLevel(leakNow, 1) + " leaking",
      why: "drives fees directly; more leakage means less revenue at any volume" },
    { k: "Organic bridge share", w: 1.5,
      s: parts.organicShare == null ? null : clamp((parts.organicShare - 0.15) / 0.20),
      v: parts.organicShare == null ? "—"
        : `${pctLevel(parts.organicShare, 1)}${parts.organicBasis ? ` ${parts.organicBasis}` : ""}`,
      why: "the thesis's own test: flow AI was not given by construction" },
    { k: "Hub conversion κ", w: 2.0, s: kappa == null ? null : clamp((kappa - sc.base) / (sc.bull - sc.base)),
      v: kappa == null ? "—" : pctLevel(kappa, 1), why: "structural: the thesis converting, or not" },
    { k: "Cash-flow multiple vs own median", w: 2.0,
      s: multNow && multMedian ? clamp((multMedian - multNow) / multMedian) : null,
      v: multNow ? `${multNow.toFixed(0)}×` : "—", why: "cheap or dear against its own history" },
    { k: "NVDA reserve accretion", w: 1.0, s: nvdaPerDay == null ? null : (nvdaPerDay > 0 ? clamp(nvdaPerDay / 40) : -0.5),
      v: nvdaPerDay == null ? "—" : `+${nf(nvdaPerDay, 1)}/day`, why: "compounds regardless of sentiment" },
    { k: "Float removal pace", w: 0.5, s: removedPace == null ? null : (removedPace > 0 ? 0.3 : -0.3),
      v: removedPace == null ? "—" : `${compact(removedPace)} AI/day`, why: "real, but far too slow to be a catalyst" },
    { k: "Net flow, 7d", w: 0.5,
      s: net7 == null ? null : clamp(net7 / Math.max(1, Math.abs(net7p || net7) * 2)),
      v: net7 == null ? "—" : `${net7 >= 0 ? "+" : ""}${compact(net7)} AI`,
      why: "near-zero weight: measured coincident, not leading" },
  ];

  const scored = comps.filter((c) => c.s != null);
  const total = scored.reduce((s, c) => s + c.w, 0);
  const score = total ? scored.reduce((s, c) => s + c.s * c.w, 0) / total : 0;
  const word = score >= 0.25 ? "BULLISH" : score <= -0.25 ? "BEARISH" : "NEUTRAL";
  const cls = score >= 0.25 ? "bull" : score <= -0.25 ? "bear" : "neutral";
  const pos = ((score + 1) / 2) * 100;

  $("#rating").innerHTML = `
    <div class="rating">
      <div class="rating-top">
        <div class="word ${cls}">${word}</div>
        <div class="scope">
          <b>On fundamentals, not price direction.</b> This scores whether the business behind AI is
          improving — fees, toll capture, hub conversion, the reserve, and how the cash-flow multiple sits
          against its own history. It is <b>not</b> a price forecast: tested over ~60 days, no KPI here
          reliably leads price, and flow's strong-looking link to price is mechanical rather than
          predictive. The Method tab shows the test.
        </div>
      </div>
      <div class="scale"><div class="needle" style="left:calc(${pos.toFixed(1)}% - 1.5px)"></div></div>
      <div class="scale-ends"><span>deteriorating</span><span>score ${score >= 0 ? "+" : ""}${score.toFixed(2)}</span><span>improving</span></div>
      <div class="components">
        ${comps.map((c) => `
          <div class="row">
            <div>${c.k} <span class="muted">— ${c.why}</span></div>
            <div class="v ${c.s == null ? "" : c.s > 0.1 ? "up" : c.s < -0.1 ? "down" : ""}">${c.v}</div>
            <div class="w">w ${c.w.toFixed(1)}${c.s == null ? " · n/a" : ` · ${c.s >= 0 ? "+" : ""}${c.s.toFixed(2)}`}</div>
          </div>`).join("")}
      </div>
    </div>`;
}

function renderVerdict(net7, net7p, feeAnnual, feeTrend, kappa, sc, capNow, capPrior, removed, leak) {
  const b = S.burns;
  const bullish = (net7 >= 0 ? 1 : 0) + (feeTrend >= 0 ? 1 : 0) + (kappa >= sc.base ? 1 : 0);
  const tone = bullish >= 2 ? "pos" : bullish === 1 ? "" : "neg";
  const lead = bullish >= 2
    ? "The measurable parts of the thesis are holding up."
    : bullish === 1
      ? "Mixed: the structure is intact but the flow is not confirming it."
      : "The measurable parts are deteriorating together.";

  /* The summary must not silently contradict the live strip directly above it.
     The week and the last hour genuinely can point opposite ways, and when they
     do, that divergence is information — not something to average away or leave
     for the reader to notice. */
  const L = S.live;
  const spanWord = (mins) => (mins < 90 ? `${mins} minutes`
    : `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? "" : "s"}`);
  const diverges = L && L.swaps > 0 && (L.net >= 0) !== (net7 >= 0);
  const liveLine = !L || !L.swaps ? ""
    : diverges
      ? `<b>Right now that has flipped:</b> the last ${L.minutes} minutes show net
         ${L.net >= 0 ? "buying" : "selling"} of <b>${compact(Math.abs(L.net))} AI</b>, against the week's
         net ${net7 >= 0 ? "buying" : "selling"}. ${spanWord(L.minutes)} is not a trend against
         seven days, but a turn shows here first.`
      : `The last ${L.minutes} minutes agree with the week: net ${L.net >= 0 ? "buying" : "selling"} of
         <b>${compact(Math.abs(L.net))} AI</b>.`;

  const stamp = S.meta?.headTime
    ? `<div class="muted" style="font-size:11.5px;margin-top:9px">
         Indexed history to block ${S.meta.headBlock.toLocaleString()} (${ago(S.meta.updatedAt)});
         live tape read ${L?.at ? ago(L.at) : "—"}. Re-checks itself every 30s.</div>`
    : "";

  $("#verdict").innerHTML = `
    <div class="verdict ${tone}">
      <div class="lead">${lead}</div>
      <div class="detail">
        Over the last 7 days traders were net <b>${net7 >= 0 ? "buyers" : "sellers"}</b> of
        <b>${compact(Math.abs(net7))} AI</b>; fees are running at <b>${compact(feeAnnual)} AI/yr</b>
        (${feeTrend == null ? "no prior week" : `${feeTrend >= 0 ? "up" : "down"} ${pct(Math.abs(feeTrend), 0).replace("+", "")} week over week`});
        hub conversion measures <b>${pctLevel(kappa, 1)}</b>, ${regimeWord(kappa, sc)}; and
        <b>${pctLevel(removed / b.genesisSupply, 2)}</b> of genesis supply is now destroyed or locked, backed by
        <b>${nf(b.vault.nvdaBalance, 1)} NVDA</b> that has never been withdrawn.
        ${leak ? `The dominant fact right now is that <b>${pctLevel(leak.leakNow, 1)} of AI volume crosses pools that pay the vault nothing</b>, so revenue is falling even though total volume is not — this is venue competition, not weakening demand.` : ""}
        The honest summary: the <i>asset</i> side is compounding quietly and verifiably, while the
        <i>monetary</i> case rests on hub conversion continuing AND on the protocol keeping a toll that
        permissionless pools can undercut at will.
        ${liveLine}
      </div>
      ${stamp}
    </div>`;
}

/* ── tab 4: method ──────────────────────────────────────────────────────── */
function renderMethod() {
  const m = S.meta, b = S.burns;
  $("#methodBody").innerHTML = `
    <div style="font-size:13px;line-height:1.65;color:var(--text-secondary)">
      <p><b style="color:var(--text-primary)">Flow.</b> Every Uniswap v4 <code>Swap</code> log for the indexed AI pools is read from
      the singleton PoolManager and bucketed hourly. A trade is a <i>buy</i> when the swapper's
      <code>amount0</code> delta for AI is positive. That sign convention was not assumed: across 484
      consecutive AI/NVDA swaps, a negative AI delta coincided with a falling pool price
      483 times and a rising price zero times, which can only be true if a negative delta
      means AI flowing into the pool. The resulting buy/sell skew matches an independent
      aggregator's counts for the same window.</p>

      <p><b style="color:var(--text-primary)">Burn and lock.</b> The hook takes a dynamic fee that currently resolves to
      7000 pips (0.70%), confirmed by reading the <code>fee</code> field of live swap logs. A splitter
      contract divides it atomically and holds no balance. Rather than assume the split, all
      three legs are measured from transfers: the ratio comes out at
      1 : ${b.observedSplit?.lock} : ${b.observedSplit?.platform} for burn : vault-lock : platform.</p>

      <p><b style="color:var(--text-primary)">Cross-routing (κ).</b> A rotation such as BONER → AI → MEME emits two
      <code>Swap</code> logs under a single transaction hash: one where the trader receives AI and one
      where they spend it. AI is a pass-through hop exactly to the extent the two legs overlap,
      so <code>min(AI received, AI spent)</code> per transaction is routed volume and the remainder is
      genuine directional demand. This makes κ an observed quantity rather than an assumption.</p>

      <p><b style="color:var(--text-primary)">Timestamps.</b> Swap logs on this chain carry a zeroed
      <code>blockTimestamp</code>, so block times are sampled at 250,000-block
      intervals and interpolated. Block production is steady near 0.102 s, keeping error far
      inside the one-hour buckets.</p>

      <p><b style="color:var(--text-primary)">Dollars.</b> There is no USD oracle on this chain, so the
      dollar price is the AI/USDG pool's own price: USDG is a dollar stablecoin, which makes that
      pool's ratio a dollar quote with nothing interpolated and no aggregator in the path. Two limits
      follow. It assumes USDG holds its peg, which is not verified here. And it only exists back to
      <b>3 September 2026</b>, when that pool opened — before then there is no on-chain dollar price
      for AI at all, which is why history further back is shown in NVDA and in each pool's own quote
      token. A public aggregator's quote sits beside it purely as a cross-check; if the two diverge
      materially the page says so rather than picking one.</p>

      <p><b style="color:var(--text-primary)">Known limits.</b> AI-pair share is measured over a recent
      window, not all time. Shares are never added across tokens: each one is a ratio in its own
      token's units, so a sum of them is not a quantity, and the population figure is instead each
      token's own share weighted by the AI measured moving through its bridge. Bridge formation counts
      pools still trading now, which under-reports older days by however many have since gone quiet, so
      the count that opened is shown alongside. Pool inventory held by the PoolManager is an aggregate
      across all pools, so it is attributed to AI in total rather than per pool.</p>
    </div>`;

  const c = m.contracts;
  $("#contractKv").innerHTML = Object.entries({
    "Chain": `Robinhood Chain (id ${m.chainId})`,
    "RPC": m.rpc,
    "v4 PoolManager": c.poolManager,
    "AI token": c.aiToken,
    "NVDA stock token": c.nvdaToken,
    "USDG": c.usdg,
    "LONG hook": `${c.longHook}`,
    "Hook permissions": m.hookPermissions.join(", "),
    "Fee splitter": c.feeSplitter,
    "Community vault": c.communityVault,
    "Platform fee recipient": c.platformFeeRecipient,
    "AI/NVDA pool id": c.aiNvdaPool,
    "AI/USDG pool id": c.aiUsdgPool,
  }).map(([k, v]) => `<div>${k}</div><div><code>${v}</code></div>`).join("");

  const checks = [
    { ok: b.reconciles, t: `Supply reconciliation: genesis ${nf(b.genesisSupply, 0)} − burned ${nf(b.burned, 2)} = live totalSupply ${nf(b.totalSupply, 2)}`, d: `residual ${b.reconcileResidual.toExponential(2)} AI` },
    { ok: b.mintEvents === 1, t: `Exactly one mint event ever (${b.mintEvents})`, d: `${nf(b.mintedTotal, 0)} AI minted at genesis, never again` },
    { ok: Math.abs(b.vault.aiBalance - b.lockedInVault) < Math.max(1, b.lockedInVault * 0.001), t: "Vault AI balance equals summed inbound locks", d: `balance ${nf(b.vault.aiBalance, 2)} vs inbound ${nf(b.lockedInVault, 2)} — no outflow observed` },
  ];
  $("#checks").innerHTML = checks.map((c) => `
    <div style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border)">
      <span class="badge ${c.ok ? "ok" : "bad"}">${c.ok ? "pass" : "fail"}</span>
      <div><div style="font-size:12.5px">${c.t}</div><div class="muted" style="font:11.5px var(--mono)">${c.d}</div></div>
    </div>`).join("");
}

/* ── boot ───────────────────────────────────────────────────────────────── */
function renderAll() {
  renderInvestor(); renderFlow(); renderBurn(); renderFloat(); renderBridges(); renderMethod();
  const m = S.meta;
  $("#footMeta").innerHTML = `
    Indexed to block <span class="mono">${m.headBlock.toLocaleString()}</span>
    (${ago(m.updatedAt)}) · ${m.poolCounts.indexed} pools indexed in depth of
    ${m.poolCounts.active} active / ${m.poolCounts.withAI.toLocaleString()} total containing AI ·
    built in ${m.buildSeconds}s using ${m.rpcCalls.toLocaleString()} RPC calls.<br>
    All figures derived from Robinhood Chain logs. Not investment advice.`;
}

function setupTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((t) => t.addEventListener("click", () => {
    tabs.forEach((o) => {
      const on = o === t;
      o.setAttribute("aria-selected", on ? "true" : "false");
      $("#" + o.getAttribute("aria-controls")).hidden = !on;
    });
    renderAll();
  }));
}

async function boot() {
  setupTabs();
  try {
    // Core three must load. The rest are optional: bridge analysis is the slowest
    // step and is allowed to lag or fail without blanking the whole dashboard.
    const [meta, flow, burns] = await Promise.all(
      ["meta.json", "flow.json", "burns.json"].map(loadJSON)
    );
    const [routing, bridges, tape, pools] = await Promise.all(
      ["routing.json", "bridges.json", "tape.json", "pools.json"].map((f) => loadJSON(f).catch(() => null))
    );
    Object.assign(S, { meta, flow, burns, routing, bridges, tape, pools });
  } catch (e) {
    $("#boot").remove();
    $("#bootErr").innerHTML = `<div class="err"><b>Could not load indexed data.</b><br>
      ${e.message}<br><br>Run <code>npm run index</code> to generate <code>web/data/</code>, then reload.</div>`;
    return;
  }
  $("#boot").remove();
  $("#p-investor").hidden = false;   // the investor view is what opens by default

  /* A token can have several v4 pools (different fee tier, tick spacing or hook),
     and more than one of them can be busy — there are two live AI/USDG venues.
     Labelling both "AI / USDG" would make the picker ambiguous, so collisions get
     their fee tier and a pool-id stub appended. */
  const sel = $("#poolSel");
  const symCount = {};
  for (const p of S.flow.pools) symCount[p.pairSymbol] = (symCount[p.pairSymbol] || 0) + 1;
  S.flow.pools.forEach((p, i) => {
    const feeLabel = p.dynamicFee
      ? `dynamic ${p.lastFeePips ? (p.lastFeePips / 10000).toFixed(2) + "%" : ""}`.trim()
      : `${(p.fee / 10000).toFixed(2)}%`;
    const dup = symCount[p.pairSymbol] > 1 ? ` ${p.poolId.slice(0, 8)}…` : "";
    sel.appendChild(el("option", { value: i },
      `AI / ${p.pairSymbol || "?"}${dup} · ${feeLabel} · ${p.totalSwaps.toLocaleString()} swaps`));
  });
  sel.addEventListener("change", () => { S.poolIdx = +sel.value; renderFlow(); });

  $("#rangeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    [...$("#rangeSeg").children].forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
    S.hours = +b.dataset.h;
    renderFlow();
  });

  renderAll();
  paintHeaderMarket();
  refreshLive();
  setInterval(refreshLive, 20000);
  // The live tail is the real-time layer: it makes the top line independent of
  // how often the indexer runs.
  refreshLiveTail();
  setInterval(refreshLiveTail, 30000);
  // Pick up a newly published index without needing a page reload.
  setInterval(refreshData, 180000);
  // Charts resize themselves via ResizeObserver; only the phone/desktop layout
  // switch needs a full re-render, since it changes chart chrome, not just width.
  let wasPhone = isPhone(), rt;
  addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (isPhone() !== wasPhone) { wasPhone = isPhone(); renderAll(); }
    }, 200);
  });
}

boot();
