/* AI / NVDA Monitor — client.
   Reads pre-indexed JSON for history, and talks to the Robinhood Chain RPC
   directly for live state (the RPC sends access-control-allow-origin: *, so the
   browser can query the chain with no backend in between). */

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const AI_TOKEN = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const AI_NVDA_POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

/* A selector that misses returns a detached element rather than null. Renderers
   write into many optional targets, and the page has been restructured more than
   once; a card that no longer exists must not take down the renderer that used
   to fill it. Writes to the detached element simply go nowhere. */
const $ = (s, r = document) => r.querySelector(s) || document.createElement("div");
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
const pctOrMult = (x, d = 1) => (x == null || !isFinite(x) ? "—"
  : x > 9 ? `${(1 + x).toFixed(1)}×`
  : x < -0.9 ? `${(1 / (1 + x)).toFixed(1)}× lower`
  : pct(x, d));
const sig = (x, n = 6) => (x == null || !isFinite(x) || x === 0 ? "—" : x.toPrecision(n).replace(/\.?0+$/, ""));
const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : "—");
/* Times render in Central explicitly rather than in the viewer's local zone.
   Pinning it means a timestamp means the same thing on the desktop that produced
   it and the phone that reads it, and removes the ambiguity that makes a stale
   chart look like a timezone bug -- which is exactly how this came up. */
const TZ = "America/Chicago";
const tsFmt = (t) => (t ? new Date(t * 1000).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
/* Daily buckets are UTC days, so a day is labelled with its UTC date. Rendering a
   bucket's start instant in Central put "Sep 11" under the bar for 12 September on
   every daily chart: midnight UTC is 7 pm the previous evening in Chicago. Hourly
   points keep Central, because an hour is an instant and a day is a name. */
const dayFmt = (t) => (t ? new Date(t * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }) : "—");
const hourFmt = (t) => (t ? new Date(t * 1000).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: true }) : "—");
const clockFmt = (t) => (t ? new Date(t * 1000).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) + " CT" : "—");
const ago = (t) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
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
  const nonNegative = min >= 0;
  if (o.zeroBase) min = Math.min(0, min);
  const padv = (max - min) * 0.08 || Math.abs(max) * 0.1 || 1;
  min = nonNegative ? Math.max(0, min - padv) : min - padv;
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
/**
 * The order book, as a wall.
 *
 * Bids and asks sit on opposite sides of spot by construction, so one bar per price
 * bin coloured by side reads better than two stacked series: the eye is looking for
 * which wall is taller, and stacking invites it to compare totals instead. Spot is
 * drawn as a line rather than implied by the colour change, because the interesting
 * cases are exactly the ones where the two sides are lopsided around it.
 */
function _depthChart(host, rows, o) {
  if (rows.length < 2) { host.innerHTML = '<p class="muted" style="padding:20px 0">Not enough depth data.</p>'; return; }
  const f = frame(host, { height: o.height || 220 });
  const val = (r) => r.bid + r.ask;
  const max = maxOf(rows.map(val)) || 1;
  yAxis(f, 0, max, o.fmt || compact);
  const bw = f.iw / rows.length;
  const w = Math.max(1, bw - 1);
  const g = mk("g");
  rows.forEach((r, i) => {
    const v = val(r);
    if (v <= 0) return;
    const h = (v / max) * f.ih;
    g.appendChild(mk("rect", {
      x: f.padL + i * bw, y: f.padT + f.ih - h, width: w, height: Math.max(1, h),
      rx: Math.min(3, w / 2), fill: r.bid >= r.ask ? "var(--buy)" : "var(--sell)",
    }));
  });
  f.svg.appendChild(g);

  // Spot, drawn where it actually falls between the bins rather than snapped to one.
  if (o.spot != null) {
    const lo = rows[0].p, hi = rows[rows.length - 1].p;
    if (o.spot > lo && o.spot < hi) {
      const x = f.padL + ((o.spot - lo) / (hi - lo)) * f.iw;
      f.svg.appendChild(mk("line", {
        x1: x, x2: x, y1: f.padT, y2: f.padT + f.ih,
        stroke: "var(--text-primary)", "stroke-width": 1.5, "stroke-dasharray": "3 3", opacity: .75,
      }));
    }
  }

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
  xLabels(f, rows, "p", o.xFmt || ((v) => `${Number(v).toPrecision(3)}`));
}

const barChart      = wrapChart(_barChart);
const depthChart    = wrapChart(_depthChart);
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
const S = { meta: null, flow: null, burns: null, routing: null, bridges: null, tape: null, pools: null, depth: null, launchpad: null, holders: null, prices: null, poolIdx: 0, hours: 24 };
// Everything but meta/flow/burns may be absent or lag; the page renders without it.
const OPTIONAL_ARTIFACTS = ["routing.json", "bridges.json", "tape.json", "pools.json", "depth.json", "launchpad.json", "holders.json", "prices.json", "treasury.json", "rwa.json"];

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
    const [routing, bridges, tape, pools, depth, launchpad, holders, prices, treasury, rwa] = await Promise.all(
      OPTIONAL_ARTIFACTS.map((f) => loadJSON(f).catch(() => null))
    );
    Object.assign(S, {
      meta, flow, burns,
      routing: routing ?? S.routing, bridges: bridges ?? S.bridges,
      tape: tape ?? S.tape, pools: pools ?? S.pools, depth: depth ?? S.depth, launchpad: launchpad ?? S.launchpad,
      holders: holders ?? S.holders, prices: prices ?? S.prices, treasury: treasury ?? S.treasury, rwa: rwa ?? S.rwa,
    });
    renderAll();
    refreshLiveTail();   // the live window starts at the new head, so re-scope it
  } catch { /* a failed refresh leaves the last good render in place */ }
}

/* The chain's public endpoint throttles, and its throttle responses are malformed
   for browsers: a 429 arrives with "Access-Control-Allow-Origin: *,*", which the
   browser rejects as a CORS failure. So from here a rate limit is indistinguishable
   from a dropped connection -- fetch just throws a TypeError. Measured: 5 of 15
   back-to-back log queries came back that way. Retrying 400ms later lands inside
   the same throttle window, so a transport failure now backs off, and after a call
   exhausts its retries every live call pauses briefly instead of feeding the limiter. */
let rpcCooldownUntil = 0;
async function rpcCall(method, params, tries = 3) {
  if (Date.now() < rpcCooldownUntil) throw new Error("live RPC cooling down after throttling");
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);   // a real JSON-RPC error: do not retry
      return j.result;
    } catch (e) {
      lastErr = e;
      // Only a transport failure is worth retrying; a node that answered and said
      // no will say no again. In a browser, a throttled request lands here too.
      const transport = e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e.message || "");
      if (!transport) throw e;
      if (i === tries - 1) { rpcCooldownUntil = Date.now() + 20_000; throw e; }
      await new Promise((res) => setTimeout(res, 1500 * 2 ** i));
    }
  }
  throw lastErr;
}

/* ── live header ─────────────────────────────────────────────────────────── */

/**
 * ONE paint for every place the price and market cap appear.
 *
 * The header, the cockpit tiles and the price card used to repaint on different
 * timers -- the header every 20 seconds, the card only when the tab re-rendered --
 * so for stretches they showed different prints a few pixels apart. Everything
 * that displays price or cap now goes through here, from one marketState().
 * The 24-hour change is computed from the on-chain series, not read from an
 * aggregator whose price is not the one being shown.
 */
function onChainChange24(price) {
  const hrs = usdSeries().hrs;
  if (!hrs.length || !price) return null;
  // Anchored to the clock, not to the last indexed hour: the live price is now,
  // so the reference has to be 24 hours before now or a stale index stretches it.
  const t = Math.floor(Date.now() / 1000) - 24 * 3600;
  let prior = null;
  for (const h of hrs) if (h.t <= t) prior = h;
  if (!prior || !(prior.close > 0) || t - prior.t > 6 * 3600) return null;   // no close near enough to call it 24h
  const r = price / prior.close;
  return r > 20 || r < 0.05 ? null : r - 1;   // a units seam is not a move
}
const moneyPx = (v) => `$${v < 0.01 ? v.toExponential(2) : v.toFixed(4)}`;
function paintHeaderMarket() {
  if (!S.flow || !S.burns) return;                  // marketState needs the artifacts
  const M = marketState();
  if (!M.price) return;
  const ch = onChainChange24(M.price);
  const chHtml = ch == null ? "" : `<span class="${ch >= 0 ? "up" : "down"}">${pct(ch, 1)}</span>`;
  $("#hUsd").innerHTML = `${moneyPx(M.price)} <span style="font-size:12px">${chHtml}</span>`;
  $("#hUsd").title = `price source: ${M.source}`;
  // When the print was read, so a reader can see it is moving.
  $("#hUsdLbl").textContent = S.livePriceAt ? `AI · USD · ${ago(S.livePriceAt)}` : "AI · USD";
  if (M.mcap) {
    $("#hMcap").textContent = "$" + compact(M.mcap);
    $("#hMcapLbl").textContent = `Cap · ${compact(M.supply, 1)} supply`;
    $("#hMcap").title = `${M.supplyLive ? "live" : "indexed"} supply × ${M.source}`;
  }
  // the same numbers wherever else they are on screen
  const tp = $("#ctPrice .val"), tm = $("#ctMcap .val");
  tp.innerHTML = moneyPx(M.price);
  $("#ctPrice .note").innerHTML = `${chHtml || "—"} over 24h, on chain`;
  tm.textContent = M.mcap ? "$" + compact(M.mcap) : "—";
  $("#ctMcap .note").textContent = M.mcap ? `× ${compact(M.supply, 1)} AI ${M.supplyLive ? "live" : "indexed"} supply` : "";
  const big = $("#kpiPrice .big");
  if (big.isConnected) {
    big.textContent = moneyPx(M.price);
    const d = $("#kpiPrice .delta"); if (d.isConnected && ch != null) { d.textContent = `${pctOrMult(ch, 1)} 24h`; d.className = `delta ${ch >= 0 ? "up" : "down"}`; }
    const u = $("#kpiPrice .unit"); if (u.isConnected && M.mcap) u.textContent = `market cap $${compact(M.mcap)}`;
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

    /* The latest print on the flagship AND on the dollar venue, in one request:
       pool id is topic1 and topics accept an OR-list. The dollar print is what the
       header price and market cap are painted from, so it is read here on the fast
       timer rather than waiting for the live tail's slower sweep. */
    const usd = S.flow ? usdPool() : null;
    const ids = usd ? [AI_NVDA_POOL, usd.poolId] : [AI_NVDA_POOL];
    const logs = await rpcCall("eth_getLogs", [{
      address: POOL_MANAGER, topics: [SWAP_TOPIC, ids],
      fromBlock: "0x" + (bn - 40000).toString(16), toBlock: "latest",
    }]);
    const lastFor = (id) => { let l = null; for (const x of logs) if ((x.topics[1] || "").toLowerCase() === id.toLowerCase()) l = x; return l; };
    const nv = lastFor(AI_NVDA_POOL);
    if (nv) {
      const sq = BigInt("0x" + nv.data.slice(2 + 128, 2 + 192));
      const x = Number(sq) / 2 ** 96;
      $("#hPrice").textContent = sig(x * x, 5);
    }
    if (usd) {
      const l = lastFor(usd.poolId);
      if (l) {
        const s = decodeLiveSwap(l, usd);
        if (s.price > 0) {
          S.live = S.live || { priceByPool: {} };
          S.live.priceByPool = { ...(S.live.priceByPool || {}), [usd.poolId]: s.price };
          S.livePriceAt = Math.floor(Date.now() / 1000);
        }
      }
    }
    paintHeaderMarket();
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
    { lbl: "Swaps", val: `${(buys + sells).toLocaleString()}`, note: `${buys.toLocaleString()} buy · ${sells.toLocaleString()} sell · pool events, not people` },
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
      <div><span style="color:var(--buy)">▲</span> bought ${compact(r.aiBuy)} AI <span class="k">(${r.buys} swaps)</span></div>
      <div><span style="color:var(--sell)">▼</span> sold ${compact(r.aiSell)} AI <span class="k">(${r.sells} swaps)</span></div>
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

  /* Swaps, not people: a v4 Swap's sender is the router, so the per-address
     columns this table used to carry counted routers and are gone. Wallet-level
     activity lives on the holders replay, netted per transaction. */
  table($("#tRollup"), [
    { h: "Window", f: (r) => `last ${r.hours} complete hour${r.hours === 1 ? "" : "s"}` },
    { h: "Buy swaps", f: (r) => r.buys.toLocaleString() },
    { h: "Sell swaps", f: (r) => r.sells.toLocaleString() },
    { h: "AI bought", f: (r) => compact(r.aiBuy) },
    { h: "AI sold", f: (r) => compact(r.aiSell) },
    { h: "Net AI", f: (r) => `<span class="${r.netAI >= 0 ? "up" : "down"}">${compact(r.netAI)}</span>` },
    { h: "Imbalance", f: (r) => `<span class="${r.imbalance >= 0 ? "up" : "down"}">${pct(r.imbalance)}</span>` },
    { h: "Price Δ", f: (r) => `<span class="${r.priceChange >= 0 ? "up" : "down"}">${r.priceChange.toFixed(2)}%</span>` },
  ], p.rollups);

  const names = S.tape?.pools || [];   // the tape is optional; a missing file must not blank the tab
  table($("#tTape"), [
    { h: "Time", f: (r) => tsFmt(r.t) },
    { h: "Pool", f: (r) => `AI / ${names[r.pool] || "?"}` },
    { h: "Side", f: (r) => `<span class="${r.buy ? "up" : "down"}">${r.buy ? "BUY" : "SELL"}</span>` },
    { h: "AI", f: (r) => compact(r.ai) },
    { h: "Quote", f: (r) => compact(r.pair) },
    { h: "Price", f: (r) => sig(r.price, 5) },
  ], (S.tape?.swaps || []).slice(0, 40));
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
    { lbl: "Implied fee volume", val: compact(b.impliedAILegVolume),
      note: (() => { const fr = measuredFeeRate(); return fr
        ? `sell-side notional at the measured ${pctLevel(fr, 2)} effective rate`
        : "sell-side notional — effective rate not measurable yet"; })() },
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
/**
 * Who holds AI.
 *
 * Two readings of one replay. The dollar buckets are the view holder dashboards
 * show, and a reader can check the counts against one. The AI-balance line is the
 * one that says something about the future: dollar buckets rise with the price by
 * construction, so only a count at a fixed token balance can tell accumulation
 * from appreciation.
 */
const HOLDER_AI_INDEX = 1;   // which of aiThresholds the line and the verdict track

function renderHolders() {
  const h = S.holders;
  const snaps = (h?.snapshots || []).filter((x) => x.holders > 0);
  // Hidden entirely until the first replay is published, rather than an empty card.
  const card = $("#kpiHolders")?.closest(".card");
  if (card) card.hidden = snaps.length < 2;
  if (snaps.length < 2) {
    $("#kpiHolders").innerHTML = `<p class="muted">Holder replay not published yet.</p>`;
    for (const id of ["#cHolderBuckets", "#cHoldersAi", "#takeHolders", "#cConcentration", "#tTopHolders", "#tCohorts", "#tWhalesFull", "#takeConcentration"]) { const e = $(id); if (e) e.innerHTML = ""; }
    return;
  }
  const last = snaps.at(-1);
  const wk = snaps[Math.max(0, snaps.length - 1 - 42)];          // 42 four-hour rows = 7 days
  const thr = h.aiThresholds?.[HOLDER_AI_INDEX];
  const aiNow = last.aboveAi?.[HOLDER_AI_INDEX], aiWk = wk.aboveAi?.[HOLDER_AI_INDEX];
  const dHolders = last.holders - wk.holders;

  $("#kpiHolders").innerHTML = kpiEl(last.holders.toLocaleString(),
    `${dHolders >= 0 ? "+" : ""}${dHolders.toLocaleString()} in 7d`, dHolders >= 0 ? "up" : "down",
    "addresses holding AI, excluding protocol contracts")
    + (h.complete ? "" : `<div class="warnline">The replay has not reached the chain head yet, so these counts are as of an earlier block.</div>`)
    + `<div class="livenote">replayed from every AI transfer since genesis
       · balances reconcile to supply to within <b>${Math.abs(h.reconciliation?.residualAi ?? 0).toFixed(6)}</b> AI
       · as of ${dayFmt(last.t)}</div>`;

  /* Tiles, not a stacked chart: under $10 is most of the population and the top
     bucket is a few percent of it, the same spread that made the launchpad bars
     unreadable. The weekly change sits under each count. */
  if (last.buckets && wk.buckets) {
    $("#cHolderBuckets").innerHTML = `<div class="bucketrow">${h.buckets.map((b, i) => {
      const n = last.buckets[i], d = n - wk.buckets[i];
      return `<div class="bucket"><div class="bn">${n.toLocaleString()}</div><div class="bl">${b.label}</div>
        <div class="bl" style="color:${d >= 0 ? "var(--buy)" : "var(--sell)"}">${d >= 0 ? "+" : ""}${d.toLocaleString()} in 7d</div></div>`;
    }).join("")}</div>`;
  } else $("#cHolderBuckets").innerHTML = "";

  if (thr != null) {
    const rows = snaps.slice(-360).map((x) => ({ t: x.t, n: x.aboveAi?.[HOLDER_AI_INDEX] ?? null })).filter((x) => x.n != null);
    lineChart($("#cHoldersAi"), rows, {
      xKey: "t", yKey: "n", color: "var(--series-1)", area: true, xFmt: dayFmt,
      fmt: (v) => v.toFixed(0),
      tip: (d) => `<div class="k">${dayFmt(d.t)} ${new Date(d.t * 1000).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric" })}</div>
        <div>${d.n.toLocaleString()} addresses hold ${compact(thr, 0)}+ AI</div>`,
    });
  }

  /* The verdict compares breadth at a fixed token balance with the price over the
     same week. A band of one percent either way is "flat", because a few addresses
     crossing a threshold on a single transfer is not a trend. */
  const pWk = wk.price && last.price ? last.price / wk.price - 1 : null;
  const aWk = aiWk ? aiNow / aiWk - 1 : null;
  const dir = (x) => (x == null ? null : x > 0.01 ? "up" : x < -0.01 ? "down" : "flat");
  const a = dir(aWk), p = dir(pWk);
  const read =
    a === "up" && p !== "up" ? ["pos", "accumulation", "more addresses are holding meaningful size while the price has not run, which is buying rather than appreciation"] :
    a === "up" && p === "up" ? ["pos", "broadening into strength", "the base of meaningful holders is growing along with the price rather than the rally being carried by fewer hands"] :
    a === "down" && p === "up" ? ["warn", "distribution into the rally", "the price is rising while fewer addresses hold meaningful size, which is holders selling into strength"] :
    a === "down" ? ["warn", "thinning", "fewer addresses hold meaningful size and the price is not rising to compensate"] :
    ["neu", "steady", "the count of meaningful holders is within a percent of where it was a week ago"];

  $("#takeHolders").innerHTML = takeEl(read[0],
    `<b>${aiNow?.toLocaleString() ?? "—"}</b> addresses hold ${compact(thr, 0)} AI or more, against
     <b>${aiWk?.toLocaleString() ?? "—"}</b> a week ago${aWk == null ? "" : ` (<b>${pct(aWk, 1)}</b>)`},
     while the price moved <b>${pWk == null ? "—" : pct(pWk, 1)}</b>. That reads as <b>${read[1]}</b>:
     ${read[2]}.
     ${(h.aiThresholds || []).length > 1 && last.aboveAi && wk.aboveAi ? `<br>Across every tier this week:
       ${h.aiThresholds.map((t, i) => {
         const d = wk.aboveAi[i] ? last.aboveAi[i] / wk.aboveAi[i] - 1 : null;
         return `${compact(t, 0)}+ AI <b>${last.aboveAi[i].toLocaleString()}</b>${d == null ? "" : ` (${pct(d, 1)})`}`;
       }).join(" · ")}. Tiers moving in opposite directions mean tokens are changing hands between sizes of
       holder rather than entering or leaving the market as a whole.` : ""}
     <span class="muted">The threshold is in AI, not dollars, on purpose. Dollar buckets climb whenever the price
     does, so a rally manufactures "new $1k holders" without anyone buying; a fixed token balance cannot be crossed
     that way. Protocol contracts (pool manager, vault, hook, fee splitter) are excluded from every count and kept
     in the supply reconciliation. An address is not a person: exchanges and bots hold for many, and one person
     can hold across many.</span>`);

  /* Concentration, the largest wallets, cohorts and the whale tape: the detail
     behind the Investor View's holder card, for the reader who wants names. */
  const px = marketState().price || 0;
  const ranks = h.topRanks || [10, 50, 100];
  if (last.top && wk.top) {
    $("#cConcentration").innerHTML = `<div class="bucketrow">${ranks.map((n, i) => {
      const v = last.top[i], d = wk.top[i] == null || v == null ? null : v - wk.top[i];
      return `<div class="bucket"><div class="bn">${pctLevel(v, 1)}</div><div class="bl">held by the top ${n}</div>
        <div class="bl" style="color:${d == null ? "inherit" : d <= 0 ? "var(--buy)" : "var(--sell)"}">${d == null ? "—" : `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}pt in 7d`}</div></div>`;
    }).join("")}
    <div class="bucket"><div class="bn">${compact(last.heldAi ?? 0)}</div><div class="bl">AI held by wallets</div><div class="bl">${pctLevel((last.heldAi ?? 0) / (last.supply || 1), 1)} of supply; the rest is pools, vault, hook</div></div></div>`;
    const top100 = last.top[2], top100wk = wk.top[2];
    const dTop = top100 != null && top100wk != null ? top100 - top100wk : null;
    $("#takeConcentration").innerHTML = takeEl(dTop == null ? "neu" : dTop < -0.005 ? "pos" : dTop > 0.005 ? "warn" : "neu",
      `The 100 largest wallets hold <b>${pctLevel(top100, 1)}</b> of all wallet-held AI${dTop == null ? "" : `, <b>${dTop >= 0 ? "+" : ""}${(dTop * 100).toFixed(1)} points</b> on the week`}.
       ${dTop == null ? "" : dTop < -0.005 ? "Falling concentration with a rising holder count is tokens spreading into more hands, which is the healthier shape for a market this thin."
         : dTop > 0.005 ? "Rising concentration means the large wallets are absorbing what smaller ones sell; that supports price while it lasts and is the supply overhang when it stops."
         : "Concentration is where it was a week ago."}
       <span class="muted">Shares are of what wallets hold, with the pool manager, vault, hook and splitter excluded from both sides. One entity can be many wallets, so this is a floor on concentration, not a ceiling.</span>`);
  } else { $("#cConcentration").innerHTML = ""; $("#takeConcentration").innerHTML = ""; }

  table($("#tTopHolders"), [
    { h: "#", f: (r) => `${r.i + 1}` },
    { h: "Wallet", f: (r) => addrCell(r.address) },
    { h: "AI", f: (r) => compact(r.ai) },
    { h: "Share", f: (r) => pctLevel(r.ai / Math.max(1, last.heldAi || last.supply), 2) },
    { h: "USD", f: (r) => (px ? `$${compact(r.ai * px)}` : "—") },
    { h: "First held", f: (r) => (r.since ? dayFmt(r.since) : `<span class="muted">before the seed</span>`) },
  ], (h.topHolders || []).map((r, i) => ({ ...r, i })));

  const cohorts = (h.cohorts || []).slice().reverse();
  table($("#tCohorts"), [
    { h: "First held (week of)", f: (c) => dayFmt(c.t) },
    { h: "Wallets", f: (c) => c.acquired.toLocaleString() },
    { h: "Still holding", f: (c) => c.holding.toLocaleString() },
    { h: "Retention", attrs: () => ({ class: "bar-cell" }), f: (c) => `<div class="fill" style="width:${(c.retention || 0) * 100}px"></div><span>${pctLevel(c.retention, 0)}</span>` },
    { h: "AI held now", f: (c) => compact(c.ai) },
  ], cohorts);
  // Replace rather than append: this renders on every tab switch and refresh.
  $("#cohortNote")?.remove();
  if (!h.firstSeenFromGenesis && cohorts.length) {
    $("#tCohorts").insertAdjacentHTML("afterend", `<div id="cohortNote" class="warnline">First-seen dates only cover wallets that arrived after the replay seed; earlier holders appear in no cohort until a genesis replay is published.</div>`);
  }

  table($("#tWhalesFull"), whaleCols(px), (h.whales || []).slice(0, 60));
  whaleStamp($("#tWhalesFull"), "whaleStampFull");
}

/* A quiet tape looks like a stuck one. Under each whale table, say how far the
   replay has read and how long ago the last move of tape size happened, so a
   newest row from hours back reads as "nothing that big since", not "stale". */
function whaleStamp(afterEl, id) {
  const h = S.holders; if (!h || !afterEl?.parentNode) return;
  $(`#${id}`)?.remove();   // replace, not append: this renders on every tab switch and refresh
  const newest = h.whales?.[0]?.t, readTo = h.updatedAt || h.snapshots?.at(-1)?.t;
  afterEl.insertAdjacentHTML("afterend", `<div class="livenote" id="${id}">Tape read to block <b>${h.cursor ? h.cursor.toLocaleString() : "—"}</b>${readTo ? ` (${ago(readTo)})` : ""};
    the last move of ${compact(h.whaleMinAi || 250000, 0)}+ AI was <b>${newest ? ago(newest) : "—"}</b>. Newer rows mean newer moves of that size, not a newer read.</div>`);
}

/* Addresses the page can name. Anything else is shown short, with the full
   address in the title. The platform's fee wallet is the one that would otherwise
   sit unnamed near the top of the holder table. */
function knownName(a) {
  const c = S.meta?.contracts || {};
  const k = {
    ...(S.treasury?.names || {}),   // routers and bridges the treasury task identified
    [c.platformFeeRecipient || ""]: "LONG platform fee wallet",
    [c.communityVault || ""]: "community vault",
    [c.longHook || ""]: "LONG hook",
    [c.poolManager || ""]: "v4 pool manager",
    [c.feeSplitter || ""]: "fee splitter",
  };
  const lc = (a || "").toLowerCase();
  const treasury = (S.treasury?.treasuryWallets || []).some((w) => w.address === lc);
  return k[lc] || S.treasury?.identities?.[lc]?.short || (treasury ? "LONG treasury wallet" : null);
}
const addrCell = (a) => {
  const name = knownName(a);
  return `<span class="mono" title="${a}">${name ? `<b>${name}</b> ` : ""}${short(a)}</span>`;
};

/** Columns for a whale-move table, shared by the Investor View card and the Float tab. */
function whaleCols(px) {
  const kindBand = (k) => k === "buy" ? "bull" : k === "sell" ? "bear" : k === "hook" ? "na" : "base";
  const kindWord = (k) => k === "buy" ? "bought" : k === "sell" ? "sold" : k === "received" ? "received" : k === "sent" ? "sent" : k === "hook" ? "hook / launch" : "wallet to wallet";
  /* Rows written before netting carry from/to instead of wallet; pick the side the
     old classification pointed at, so an older artifact still renders. */
  const walletOf = (w) => w.wallet || (w.kind === "sell" ? w.from : w.to);
  return [
    { h: "When", f: (w) => tsFmt(w.t) },
    { h: "Move", f: (w) => `<span class="band ${kindBand(w.kind)}">${kindWord(w.kind)}</span>${w.fresh ? ` <span class="muted" title="the wallet held no AI before this transaction">new wallet</span>` : ""}` },
    { h: "AI", f: (w) => compact(w.ai) },
    { h: "USD now", f: (w) => (px ? `$${compact(w.ai * px)}` : "—") },
    { h: "Wallet", f: (w) => addrCell(walletOf(w)) },
  ];
}

function renderFloat() {
  const b = S.burns;
  const removed = b.burned + b.vault.aiBalance;
  const hook = b.heldByHook ?? b.hookAI ?? 0;
  $("#floatTiles").innerHTML = [
    /* Two denominators live on this tab and they are not interchangeable.
       Removal is measured against the GENESIS mint, because burned AI has already
       left total supply and dividing by what remains would understate it. Holdings
       are measured against CURRENT supply, because that is what exists to hold.
       Both are right; leaving either unlabelled is what made one screen show a
       float of 96.7% beside a chart segment reading 95.8%. So each note names its
       base. */
    { lbl: "Permanently removed", val: compact(removed),
      note: `${pctLevel(removed / b.genesisSupply, 2)} of the ${compact(b.genesisSupply)} genesis mint: ${compact(b.burned)} burned + ${compact(b.vault.aiBalance)} vault-locked, equal by construction` },
    { lbl: "Pool inventory", val: compact(b.poolManagerAI),
      note: `${pctLevel(b.poolManagerAI / b.totalSupply, 2)} of current supply, sitting in v4 pools` },
    { lbl: "Hook reserves", val: compact(hook),
      note: `${pctLevel(hook / b.totalSupply, 2)} of current supply, held by the LONG hook to seed launches` },
    { lbl: "Effective float", val: compact(b.effectiveFloat),
      note: `${pctLevel(b.effectiveFloat / b.totalSupply, 1)} of the ${compact(b.totalSupply)} in existence — what can change hands` },
  ].map((t) => `<div class="tile"><div class="lbl">${t.lbl}</div><div class="val">${t.val}</div><div class="note">${t.note}</div></div>`).join("");

  shareBars($("#cWaterfall"), [
    { k: "Burned to 0x0 — destroyed", v: b.burned },
    { k: "Locked in the vault — still exists, never moves", v: b.vault.aiBalance },
    { k: "Held as v4 pool inventory", v: b.poolManagerAI },
    { k: "Held by the LONG hook — launch reserves", v: hook },
    { k: "Free float", v: b.effectiveFloat },
  ], ["var(--sell)", "var(--series-2)", "var(--series-3)", "var(--text-muted)", "var(--mid)"]);

  /* Burned and locked are two different sets of tokens of the same size, and the
     table says why, because two identical numbers side by side read as one counted
     twice. Burned AI is outside total supply; vault AI is inside it. */
  table($("#tSupply"), [
    { h: "Component", f: (r) => r.k },
    { h: "AI", f: (r) => nf(r.v, 0) },
    { h: "Share of genesis", f: (r) => pctLevel(r.v / b.genesisSupply, 3) },
    { h: "In total supply?", f: (r) => r.inSupply },
    { h: "Reversible?", f: (r) => r.rev },
  ], [
    { k: "Genesis supply (single mint)", v: b.genesisSupply, inSupply: "—", rev: "—" },
    { k: "Burned to 0x0 — destroyed", v: b.burned, inSupply: "No, gone", rev: "No" },
    { k: "Locked in community vault — the other half of every fee split", v: b.vault.aiBalance, inSupply: "Yes", rev: "No (no observed outflow)" },
    { k: "Held as v4 pool inventory", v: b.poolManagerAI, inSupply: "Yes", rev: "Yes, if LPs withdraw" },
    { k: "Held by the LONG hook (launch reserves)", v: hook, inSupply: "Yes", rev: "Yes, as launches are seeded" },
    { k: "Effective float", v: b.effectiveFloat, inSupply: "Yes", rev: "—" },
    { k: "Current total supply = vault + pools + hook + float", v: b.totalSupply, inSupply: "—", rev: "—" },
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
  const fr = measuredFeeRate();
  $("#splitNote").textContent =
    `Measured ratio burn : lock : platform = 1 : ${s.lock} : ${s.platform}. ` +
    `Total AI fees taken: ${nf(b.totalAIFee, 0)} AI, implying ${compact(b.totalAIFee / (fr || 0.007))} AI of sell-side notional through tolled pools ` +
    (fr ? `at the measured ${pctLevel(fr, 2)} effective rate (the logs say 0.70%; the splitter receives less).` : "at the nominal 0.70% rate.");
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

  /* Markers are this series' own quartiles, with the outside writeup's cases kept
     only as two faint reference ticks. Four borrowed thresholds across the scale made
     them read as the axis -- as though "bull" were a property of the measurement
     rather than of someone's assumption. */
  const kHist = (r.daily || []).map((d) => d.ratio).filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  const kq = (f) => (kHist.length >= 10 ? kHist[Math.min(kHist.length - 1, Math.floor(f * kHist.length))] : null);
  const ownMarks = [
    { name: "own low", at: kq(0.1) },
    { name: "own median", at: kq(0.5) },
    { name: "own high", at: kq(0.9) },
  ].filter((m) => m.at != null);
  bulletGauge($("#cGauge"), {
    value: r.measuredKappaRatio, max: Math.max(0.45, r.measuredKappaRatio * 1.2),
    fmt: (v) => pctLevel(v, 1),
    label: "of direct volume cross-routed",
    markers: ownMarks.length ? ownMarks : [
      { name: "ref base", at: r.scenarios.base },
      { name: "ref bull", at: r.scenarios.bull },
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

/**
 * Swaps for MANY pools in one request.
 *
 * A v4 Swap log carries the pool id in topic1, and eth_getLogs accepts an array of
 * accepted values for a topic position. So N pools cost one round trip, not N --
 * which is the difference between a live layer that covers the three busiest venues
 * and one that covers everything that matters. That matters more here than it
 * normally would: the indexing workflow is throttled to roughly one run every few
 * hours, so anything the browser cannot compute for itself is stale by default.
 *
 * Logs come back interleaved, so each is routed to its pool by topic1.
 */
const LOG_CAP = 10_000;          // the endpoint truncates a response at this many

async function liveSwapsMulti(pools, fromBlock, toBlock) {
  if (!pools.length) return { byPool: new Map(), from: fromBlock, truncated: false };
  const byId = new Map(pools.map((p) => [p.poolId.toLowerCase(), p]));
  const ids = pools.map((p) => p.poolId);

  /* The endpoint caps a response at 10,000 logs and says nothing when it truncates,
     so a window that overflows comes back looking like a quiet period. Widening
     coverage from three venues to twenty made that reachable: about 21 trades a
     minute across the indexed set puts twelve hours near 15,000 logs. So a response
     at the cap is treated as a failure to cover the window, and the window is
     halved until it fits. What is reported afterwards is the range actually
     covered, never the range requested. */
  let from = fromBlock, logs = null, truncated = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    logs = await rpcCall("eth_getLogs", [{
      address: POOL_MANAGER, topics: [SWAP_TOPIC, ids],
      fromBlock: "0x" + from.toString(16), toBlock: "0x" + toBlock.toString(16),
    }]);
    if (logs.length < LOG_CAP) break;
    truncated = true;
    const span = toBlock - from;
    if (span < 2) break;
    from = toBlock - Math.floor(span / 2);
  }

  const out = new Map(pools.map((p) => [p.poolId, []]));
  for (const l of logs) {
    const pool = byId.get((l.topics[1] || "").toLowerCase());
    if (pool) out.get(pool.poolId).push(decodeLiveSwap(l, pool));
  }
  return { byPool: out, from, truncated };
}

/* Uniswap's tick bounds, mirrored from decode.mjs. A swap that leaves the pool
   sitting on one of these exhausted it rather than pricing it: AI/OPENAIx1L
   printed MAX_SQRT_PRICE - 1 and decoded to 3.4e38 pair-units per AI. Real chain
   state, correct arithmetic, not a price. The browser derives prices independently
   of the indexer, so the guard has to exist in both places or the live tail
   reintroduces exactly what the indexer now discards. */
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const atPriceBound = (v) => v <= MIN_SQRT_PRICE + 1n || v >= MAX_SQRT_PRICE - 1n;

/** One Swap log, decoded to the AI leg of a given pool. */
function decodeLiveSwap(l, pool) {
  const dec = pool.pairDecimals ?? 18;
  {
    const a0 = i128(l.data, 0), a1 = i128(l.data, 1);
    const aiRaw = pool.aiIsCurrency0 ? a0 : a1;
    const pairRaw = pool.aiIsCurrency0 ? a1 : a0;
    const sq = u256(l.data, 2);
    const bounded = atPriceBound(sq);
    const r = Number(sq) / 2 ** 96;
    const d0 = pool.aiIsCurrency0 ? 18 : dec, d1 = pool.aiIsCurrency0 ? dec : 18;
    const p = bounded ? 0 : r * r * 10 ** (d0 - d1);
    return {
      block: parseInt(l.blockNumber, 16),
      ai: Number(aiRaw) / 1e18,
      pair: Number(pairRaw) / 10 ** dec,
      buy: aiRaw > 0n,                        // swapper receives AI — see decode.mjs
      price: bounded ? 0 : (pool.aiIsCurrency0 ? p : (p ? 1 / p : 0)),
    };
  }
}

/**
 * Poll for everything since the last indexed block and keep it as a live tail.
 *
 * This used to cover three venues, on the reasoning that the browser shares a
 * throttled endpoint with the indexer and should be frugal. That reasoning was
 * right about the constraint and wrong about the cost: pool id is topic1 on a v4
 * Swap log, so twenty venues fit in the SAME single request as three. The narrow
 * version was paying three round trips for a third of the coverage.
 *
 * Coverage matters because the indexed layer is hours old in practice, so anything
 * outside the tail is stale. With the venues that carry essentially all the volume
 * inside it, the live layer can carry not just price but the numbers that decide
 * things -- how much flow is crossing pools that pay the vault nothing, and which
 * way the net is running.
 */
async function refreshLiveTail() {
  if (!S.flow || !S.meta || !S.flow.pools.length) return;
  try {
    const head = parseInt(await rpcCall("eth_blockNumber", []), 16);
    /* The tail bridges from the last indexed block to now, and that gap is bigger
       than it was designed for. The indexing workflow is supposed to refresh every
       five minutes; GitHub throttles the schedule to roughly one run every four
       hours, so the gap is routinely hours. A four-hour cap meant the tail could not
       reach the indexed head at all and the page had a silent hole in the middle.

       Twelve hours now, and the strip reports when even that cannot close the gap,
       because an unreported hole is worse than a visible one. The cost is bounded:
       one getLogs for every venue at once, and the endpoint caps a response at 10,000
       logs -- if a window is busier than that the tail is short rather than wrong,
       which the strip also says. All indexed venues ride in that one request. */
    const HOUR_BLOCKS = Math.round(3600 / SEC_PER_BLOCK);
    const MAX_TAIL_HOURS = 12;
    const from = Math.max(S.meta.headBlock + 1, head - MAX_TAIL_HOURS * HOUR_BLOCKS);
    const gapBlocks = Math.max(0, head - (S.meta.headBlock + 1));
    const coversGap = from <= S.meta.headBlock + 1;
    if (head <= from) { S.live = null; renderLiveStrip(); return; }

    /* Every indexed venue, busiest first. One request covers them all; the order
       only decides which pool is treated as the price leader below. */
    const recent = (p) => p.hourly.slice(-24).reduce((a, h) => a + (h.aiBuy || 0) + (h.aiSell || 0), 0);
    const pools = [...S.flow.pools].sort((a, b) => recent(b) - recent(a));
    const fetched = await liveSwapsMulti(pools, from, head)
      .catch(() => ({ byPool: new Map(), from, truncated: false }));
    const perPool = pools.map((p) => fetched.byPool.get(p.poolId) || []);
    // What was actually covered, which is not always what was asked for.
    const covFrom = fetched.from;
    const coversGapReal = coversGap && covFrom <= S.meta.headBlock + 1;

    const nowSec = Math.floor(Date.now() / 1000);
    const tOf = (b) => nowSec - Math.round((head - b) * SEC_PER_BLOCK);

    /* Toll leakage, live. This is the figure the page calls its dominant fact, and
       it was only ever as fresh as the last index -- hours. The tail now has every
       indexed venue and each one's hook status, so the same logs answer it for the
       window just polled, at no extra request. */
    let buy = 0, sell = 0, n = 0, last = null, hookedVol = 0, hooklessVol = 0;
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
        if (pools[i].isLongHook) hookedVol += Math.abs(s.ai); else hooklessVol += Math.abs(s.ai);
        if (s.price > 0) row.close = s.price;   // a boundary print leaves the close alone
        bk.set(h, row);
        if (i === 0) last = s;
        if (s.price > 0) priceByPool[pools[i].poolId] = s.price;   // last GENUINE print per venue
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
      pools: pools.map((p, i) => {
        const dup = pools.some((q, j) => j !== i && q.pairSymbol === p.pairSymbol);
        return dup ? `${p.pairSymbol} ${p.poolId.slice(0, 6)}` : p.pairSymbol;
      }), at: nowSec, priceByPool,
      pointsByPool: Object.fromEntries(Object.entries(pointsByPool).map(([k, m]) => [k, [...m.values()].sort((a, b) => a.t - b.t)])),
      lastPrice: last ? last.price : null,
      minutes: Math.max(1, Math.round((head - covFrom) * SEC_PER_BLOCK / 60)),
      coversGap: coversGapReal, gapMinutes: Math.round(gapBlocks * SEC_PER_BLOCK / 60),
      truncated: fetched.truncated,
      venues: pools.length,
      leak: hookedVol + hooklessVol > 0 ? hooklessVol / (hookedVol + hooklessVol) : null,
    };
    renderLiveStrip();
    renderStaleBanner();   // the live head is what reveals how old the index is
    paintHeaderMarket();   // the live print changes the canonical price
    if (!$("#p-investor").hidden) { try { renderInvestor(); } catch { /* never blank the tab */ } }
  } catch { /* the live tail is a bonus; its failure must not disturb the page */ }
}

const fmtAge = (mins) => (mins == null ? "—"
  : mins < 90 ? (Math.round(mins) <= 1 ? "a minute" : `${Math.round(mins)} minutes`)
  : mins < 48 * 60 ? `${(mins / 60).toFixed(1)} hours`
  : `${Math.round(mins / 1440)} days`);

/**
 * How stale the indexed layer is, said out loud.
 *
 * This was a footnote at the bottom of the page, which was defensible when the
 * refresh was believed to be every five minutes. It is not: GitHub throttles the
 * schedule to roughly one run every four hours, and measured on the deployed site
 * the indexed data was 4.8 hours behind the chain. Live price and live flow come
 * straight from the browser's own RPC calls and are current; every LEVEL below
 * them -- fee run-rate, leakage, cross-routing, the rating built on all three -- is
 * as old as the last successful index. Someone deciding anything off those levels
 * has to know that without hunting for it.
 */
function renderStaleBanner() {
  const host = $("#staleBanner");
  if (!host || !S.meta) return;
  const headBlock = S.live?.head;
  const lagMin = headBlock
    ? Math.round((headBlock - S.meta.headBlock) * SEC_PER_BLOCK / 60)
    : Math.round((Date.now() / 1000 - (S.meta.updatedAt || 0)) / 60);
  if (!isFinite(lagMin) || lagMin < 45) { host.hidden = true; return; }
  host.hidden = false;
  host.className = lagMin >= 180 ? "bad" : "";
  host.innerHTML = `The indexed history behind every level on this page is <b>${fmtAge(lagMin)} old</b>.
    Price, market cap and the live flow strip are read from the chain directly and are current; the fee
    run-rate, leakage, cross-routing and the rating built on them are not. Refreshes normally land every few
    minutes, so a gap this long means the refresh chain has stalled; it restarts itself within a few hours.`;
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
        <b>${L.swaps.toLocaleString()} trades</b> across ${L.venues} venues in the last <b>${fmtAge(L.minutes)}</b>,
        read from the chain just now. Refreshes every 30s.
        ${L.leak == null ? "" : `<b>${pctLevel(L.leak, 1)}</b> of it crossed pools that pay the vault nothing.`}
        ${L.coversGap === false
          ? `<span class="warnline">This does not reach the indexed history below, which stops
             ${fmtAge(L.gapMinutes)} back — there is an unmeasured window between them. The figures below exclude it.${
             L.truncated ? " The endpoint capped the response, so the live window was shortened to fit." : ""}</span>`
          : `It continues the indexed history below, which stops at block ${S.meta.headBlock.toLocaleString()}.`}
      </div>
    </div>`;
}

/* ── tab 0: investor view ────────────────────────────────────────────────
   Everything here is derived from the same artifacts the other tabs use. No
   number is hardcoded and no takeaway is written in advance: each conclusion is
   computed from the series it sits under, so it cannot drift out of agreement
   with its own chart. Where a figure is an estimate or a proxy, the text says so. */

/**
 * Effective fee rate, divided out of the data rather than assumed.
 *
 * The constant here used to be 0.007, on the reasoning that AI/NVDA's dynamic fee
 * resolves to 7000 pips in the swap logs. Dividing measured fee income by measured
 * sell volume on the pools that actually carry the hook gives 0.60% pooled over
 * the last fortnight, and the daily figure ranges 0.27%-0.77%. Three reasons it is
 * not 0.70%: the per-swap fee in the logs appears to include a chain-level
 * component the splitter never receives (across sixteen static pools the logged fee
 * exceeds the pool's configured fee by up to 1000 pips, capped there); the hook now
 * runs on several pools at different tiers, not just AI/NVDA; and buys pay in NVDA,
 * so the AI-denominated leg divides by sell volume only.
 *
 * So the rate is measured per window. Anything derived from it -- implied notional,
 * above all -- is then a ratio of two measured quantities instead of one measured
 * quantity and one borrowed assumption. Returns null rather than a fallback when
 * there is nothing to divide: a missing number is honest, a stale constant is not.
 */
function measuredFeeRate(days = 14) {
  const b = S.burns, f = S.flow;
  // The indexer now makes the same measurement and ships it; one source, not two.
  if (b?.effectiveFeeRate > 0) return b.effectiveFeeRate;
  if (!b?.daily?.length || !f?.pools?.length) return null;
  const hooked = f.pools.filter((p) => p.isLongHook);
  if (!hooked.length) return null;
  const sellByDay = new Map();
  for (const p of hooked) {
    for (const h of p.hourly) {
      const d = Math.floor(h.t / DAY) * DAY;
      sellByDay.set(d, (sellByDay.get(d) || 0) + (h.aiSell || 0));
    }
  }
  let fees = 0, sells = 0;
  for (const d of completeDays(b.daily).slice(-days)) {
    const v = sellByDay.get(d.t);
    if (!v) continue;
    fees += (d.burnAI || 0) + (d.lockAI || 0) + (d.platformAI || 0);
    sells += v;
  }
  return sells > 0 ? fees / sells : null;
}
const DAY = 86400;

/** A level, not a change: no leading sign. Using pct() here reads as a delta. */
const pctLevel = (x, d = 1) => (x == null || !isFinite(x) ? "—" : `${(+(x * 100).toFixed(d)).toFixed(d)}%`);

/**
 * Where does today sit in this asset's own measured range?
 *
 * The scoring used to lean on an outside model's four scenarios -- cross-routing
 * "base" at 23%, "bull" at 34%, and so on. Those are one analyst's assumptions
 * about a token with two months of history, and wiring them into the headline made
 * a stranger's spreadsheet the benchmark every measurement was judged against. A
 * percentile of the asset's own distribution needs no such import: it answers "is
 * this high or low FOR THIS THING", which is the question a level actually
 * supports.
 *
 * Returns null below a minimum sample, because a percentile over four points is
 * theatre. Ties count as half, so a flat series lands at the middle rather than at
 * an arbitrary end.
 */
function percentileOf(values, v, minN = 10) {
  const xs = values.filter((x) => x != null && isFinite(x));
  if (v == null || !isFinite(v) || xs.length < minN) return null;
  let below = 0, equal = 0;
  for (const x of xs) { if (x < v) below++; else if (x === v) equal++; }
  return (below + equal / 2) / xs.length;
}

/** Percentile mapped to the -1..+1 the rating works in; median scores zero. */
const pctlScore = (values, v, minN = 10) => {
  const p = percentileOf(values, v, minN);
  return p == null ? null : (p - 0.5) * 2;
};

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
/**
 * AI/NVDA's share of indexed volume, per day, with the venue count beside it.
 *
 * That count matters more than it looks. This share is measured over the pools
 * indexed in depth, and that set grew from one pool to eight -- so for fifty of the
 * first sixty days the share is exactly 100%, not because the toll captured
 * everything but because nothing else was being measured. Ranking today's figure
 * against a history like that says "lowest ever" when what changed was the
 * denominator, so callers comparing across time filter on `venues`.
 */
function dailyVolumes() {
  const rows = new Map();
  for (const p of S.flow.pools) {
    const isMain = p.poolId === S.meta.contracts.aiNvdaPool;
    for (const h of p.hourly) {
      const d = Math.floor(h.t / DAY) * DAY;
      const v = (h.aiBuy || 0) + (h.aiSell || 0);
      if (!(v > 0)) continue;
      const r = rows.get(d) || { t: d, total: 0, main: 0, pools: new Set() };
      r.total += v;
      if (isMain) r.main += v;
      r.pools.add(p.poolId);
      rows.set(d, r);
    }
  }
  return [...rows.values()].sort((a, b) => a.t - b.t)
    .map((r) => ({ t: r.t, total: r.total, main: r.main, venues: r.pools.size,
      share: r.total > 0 ? r.main / r.total : 0 }));
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
  /* Breadth of demand beside its volume: a day's net flow can be one wallet, a
     day's buyer count cannot. Summed per pool-hour, so it is an upper bound. */
  const buyersDaily = completeDays(dailyBuyers());
  if (buyersDaily.length) {
    divergingBars($("#cBuyers"), buyersDaily.slice(-30), {
      xKey: "t", posKey: "buyers", negKey: "sellers", height: 200, xFmt: dayFmt, fmt: (v) => Math.abs(v).toFixed(0),
      tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div><span style="color:var(--buy)">▲</span> ${d.buyers.toLocaleString()} wallets net bought</div>
        <div><span style="color:var(--sell)">▼</span> ${d.sellers.toLocaleString()} wallets net sold</div>`,
    });
  } else $("#cBuyers").innerHTML = `<p class="muted" style="padding:16px 0">Wallet-level buyers accrue from the next holder replay.</p>`;

  /* ── 2. fee run-rate ──────────────────────────────────────────────── */
  const fee = (d) => (d.burnAI || 0) + (d.lockAI || 0) + (d.platformAI || 0);
  const feeSeries = completeDays(b.daily.map((d) => ({ t: d.t, fee: fee(d), burn: d.burnAI || 0 })));
  const fee7 = trailing(feeSeries, 7, (d) => d.fee), fee7p = trailing(feeSeries, 7, (d) => d.fee, 7);
  const feeAnnual = (fee7 / 7) * 365;
  /* Implied notional divides measured fees by the measured effective rate, so both
     sides come from the chain. With the old assumed 0.70% this figure ran about a
     sixth low. Null when the rate cannot be measured, rather than silently assumed. */
  const feeRate = measuredFeeRate();
  const impliedVol = feeRate ? (fee7 / 7) / feeRate : null;
  const feeTrend = trend(fee7, fee7p);
  $("#kpiFee").innerHTML = kpiEl(compact(feeAnnual),
    feeTrend == null ? "" : `${pct(feeTrend, 0)} vs prior 7d`, feeTrend >= 0 ? "up" : "down",
    "AI/yr fee run-rate");
  lineChart($("#cInvFee"), feeSeries.slice(-30), {
    xKey: "t", yKey: "fee", zeroBase: true, area: true, color: "var(--series-2)", xFmt: dayFmt,
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>${compact(d.fee)} AI of fees</div>
      ${feeRate ? `<div class="k">implies ${compact(d.fee / feeRate)} AI of tolled volume</div>` : ""}`,
  });
  $("#takeFee").innerHTML = takeEl(feeTrend >= 0 ? "pos" : "warn",
    `Fees are running at <b>${compact(feeAnnual)} AI/yr</b> and
     ${feeTrend == null ? "have no prior period to compare" :
       `<b>${feeTrend >= 0 ? "rose" : "fell"} ${pct(Math.abs(feeTrend), 0).replace("+", "")}</b> against the prior week`}.
     AI-denominated fees are charged on <b>sells only</b> (buys pay in NVDA).
     ${impliedVol == null ? "" : `Dividing measured fee income by measured sell volume on the hooked pools gives an
       effective rate of <b>${pctLevel(feeRate, 2)}</b>, which implies <b>${compact(impliedVol)} AI/day</b> of
       <i>sell-side</i> notional through tolled pools — roughly half the round-trip volume.
       <span class="muted">That rate is measured, not the 0.70% the swap logs report per trade: across sixteen
       static pools the logged fee runs up to 1000 pips above the pool's own fee, so some of it never reaches
       the splitter.</span>`}
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
  /* Judged against its own range, with the outside scenarios mentioned second and
     labelled as someone's assumptions rather than as the scale. */
  const kOwn = percentileOf(kd.map((d) => d.ratio), kappa);
  $("#takeKappa").innerHTML = takeEl(kOwn == null ? "warn" : kOwn >= 0.5 ? "pos" : "warn",
    `<b>${pctLevel(kappa, 1)}</b> of direct AI volume is other tokens passing through AI, measured from transactions
     where AI is a genuine intermediate hop — not assumed, which is the part that matters: this is the number that
     decides whether AI becomes infrastructure or stays a trade.
     ${kOwn == null ? "Too little history yet to say whether that is high or low for this asset." :
       `That is the <b>${Math.round(kOwn * 100)}th percentile</b> of its own measured range over
        ${kd.length} days, so it is ${kOwn >= 0.75 ? "near the top of" : kOwn >= 0.5 ? "above the middle of"
        : kOwn >= 0.25 ? "below the middle of" : "near the bottom of"} what this token has actually done.`}
     <span class="muted">For reference, one circulating valuation writeup assumed cases of
     ${pctLevel(sc.bear, 0)} / ${pctLevel(sc.base, 0)} / ${pctLevel(sc.bull, 0)} / ${pctLevel(sc.extraBull, 0)} for this input.
     Those are that author's assumptions about a two-month-old token, shown for comparison only — nothing on this
     page is scored against them.</span>`);

  /* ── 5. fee capture ───────────────────────────────────────────────── */
  const cap = vols.filter((v) => v.total > 0);
  /* Days with a single indexed venue cannot inform a share comparison -- the share
     is 100% by construction. Ranking against them reported "lowest in its range"
     for a figure whose denominator had simply acquired seven more pools. */
  const capComparable = cap.filter((v) => v.venues > 1);
  // The tile and the dial read the same population: comparable days only.
  const cap7 = capComparable.slice(-7), cap7p = capComparable.slice(-14, -7);
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
     feeds the vault, so success in indicator 6 can quietly shrink indicator 4. Watch them together, not apart.
     <span class="muted">Denominator is indexed pools only, so treat the level as a trend, not an absolute.</span>`);

  /* ── 6. float removal ─────────────────────────────────────────────── */
  const removed = b.burned + b.vault.aiBalance;
  const rem7 = trailing(bDaily, 7, (d) => (d.burnAI || 0) + (d.lockAI || 0));
  const yrs = rem7 > 0 ? (b.effectiveFloat / (rem7 / 7 * 365)) : Infinity;
  $("#kpiFloat").innerHTML = kpiEl(compact(removed),
    `${pctLevel(removed / b.genesisSupply, 2)} of genesis`, "up", "AI destroyed or locked")
    + `<div class="livenote">${compact(b.burned)} burned + ${compact(b.vault.aiBalance)} locked. Two different sets of tokens, the same size
       because every fee is split 1:1; burned AI is gone from supply, vault AI still exists and has never moved.</div>`;
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
  try { renderAdoption(); } catch { /* the census is optional; never blank the tab */ }
  try { renderNearDepth(); } catch { /* near-spot depth is optional */ }
  try { renderDepth(); } catch { /* depth is optional; never blank the tab */ }
  try { renderAnchorRank(); } catch { /* the anchor census is optional */ }
  try { renderRunners(); renderLaunches(); } catch { /* the launchpad tab is optional */ }
  const leak = renderLeak();
  renderVenues();
  const mult = renderMultiple(feeSeries);
  try { renderDollars(feeSeries); } catch (e) { console.error("renderDollars", e); }
  try { renderBreadth(); } catch (e) { console.error("renderBreadth", e); }
  try { renderPlatform(); } catch (e) { console.error("renderPlatform", e); }
  try { renderTreasury(); } catch (e) { console.error("renderTreasury", e); }

  /* ── the two dials ────────────────────────────────────────────────────
     Every input is a trailing-7-day level (or a week-over-week change) ranked
     inside the asset's OWN last 30 days; see RATING and renderCockpit for why
     that window and not the whole history. */
  const H = (S.holders?.snapshots || []).filter((x) => x.holders > 0);
  const capRoll = rolling(capComparable, 7, (w) => { const t = sumOf(w, (d) => d.total); return t > 0 ? sumOf(w, (d) => d.main) / t : null; });
  const leakRoll = rolling(leak?.comparable || [], 7, (w) => { const t = sumOf(w, (d) => d.total); return t > 0 ? sumOf(w, (d) => d.hookless) / t : null; });
  const nvRoll = rolling(bDaily, 7, (w) => sumOf(w, (d) => d.nvdaIn) / 7);
  const feeRoll = rolling(feeSeries, 14, (w) => { const a = sumOf(w.slice(7), (d) => d.fee), p2 = sumOf(w.slice(0, 7), (d) => d.fee); return p2 > 0 ? a / p2 - 1 : null; });
  const flowRoll = rolling(flows, 7, (w) => { const bb = sumOf(w, (d) => d.buy), ss = sumOf(w, (d) => d.sell); return bb + ss > 0 ? (bb - ss) / (bb + ss) : null; });
  const buyersRoll = rolling(completeDays(dailyBuyers()), 7, (w) => sumOf(w, (d) => d.buyers) / 7);
  const launchRoll = rolling(completeDays(S.launchpad?.launchesByDay || []), 7, (w) => sumOf(w, (d) => d.launched));
  const adoptRoll = rolling(completeDays(S.launchpad?.anchorFlow || []), 7, (w) => { const a = sumOf(w, (d) => d.all); return a > 0 ? sumOf(w, (d) => d.ai) / a : null; });
  const breadthRoll = H.map((x, i) => {
    const p = H[i - 42];   // 42 four-hour rows = 7 days
    const a = x.aboveAi?.[HOLDER_AI_INDEX], b0 = p?.aboveAi?.[HOLDER_AI_INDEX];
    return b0 ? { t: x.t, v: a / b0 - 1 } : null;
  }).filter(Boolean);
  const nearHist = (S.depth?.history || []).filter((hh) => hh.nearBid != null && hh.nearBid + hh.nearAsk > 0)
    .map((hh) => ({ t: hh.t, v: hh.nearBid / (hh.nearBid + hh.nearAsk) }));
  const tightBand = S.depth?.near?.[0];
  const bookShare = tightBand && tightBand.bidUsd + tightBand.askUsd > 0 ? tightBand.bidUsd / (tightBand.bidUsd + tightBand.askUsd) : null;
  const L = S.live;
  const cur = (roll) => (roll.length ? roll.at(-1).v : null);
  const wk = (roll) => (roll.length > 7 ? roll.at(-1).v - roll[roll.length - 8].v : null);     // over the last 7 daily points
  const wk4h = (roll) => (roll.length > 42 ? roll.at(-1).v - roll[roll.length - 43].v : null); // over the last 7 days of 4h points
  const adoptNow = cur(adoptRoll), adoptPrior = adoptRoll.length > 7 ? adoptRoll[adoptRoll.length - 8].v : null;
  const thr = S.holders?.aiThresholds?.[HOLDER_AI_INDEX] ?? 1e5;

  const structure = [
    { k: "Fee capture on AI/NVDA", v: pctLevel(cur(capRoll), 1), d: wk(capRoll), dFmt: pts,
      s: levelScore(capRoll, cur(capRoll), +1),
      why: "share of indexed volume crossing the tolled pool, trailing 7 days, on days with both venue kinds" },
    { k: "Toll leakage", v: cur(leakRoll) == null ? "—" : pctLevel(cur(leakRoll), 1) + " pays nothing", d: wk(leakRoll), dFmt: pts, invert: true,
      s: levelScore(leakRoll, cur(leakRoll), -1),
      why: "share of indexed volume on pools that pay the vault nothing; high is bad, so its rank is inverted" },
    { k: "Hub conversion κ", v: pctLevel(kappa, 1), d: k7pr > 0 ? k7r - k7pr : null, dFmt: pts,
      s: levelScore(kd.map((d) => ({ t: d.t, v: d.ratio })), kappa, +1),
      why: "cross-routed ÷ direct AI volume, trailing 3 days, ranked among its own daily values" },
    { k: "AI's share of new LONG pools", v: pctLevel(adoptNow, 1), d: adoptPrior ? adoptNow / adoptPrior - 1 : null, dFmt: (x) => pct(x, 0),
      s: adoptPrior ? clamp1((adoptNow / adoptPrior - 1) / 0.5) : null,
      why: "scored on its week-over-week change, not a percentile: for most of the history the platform anchored nothing in AI, so there is no range to rank against" },
    { k: "NVDA accretion", v: cur(nvRoll) == null ? "—" : `+${nf(cur(nvRoll), 1)}/day`, d: wk(nvRoll), dFmt: (x) => `${x >= 0 ? "+" : ""}${nf(x, 1)}/day`,
      s: levelScore(nvRoll, cur(nvRoll), +1), why: "NVDA into the vault per day, trailing 7 days" },
    { k: "Fee run-rate trend", v: feeTrend == null ? "—" : pct(feeTrend, 0) + " wk/wk", d: wk(feeRoll), dFmt: pts,
      s: levelScore(feeRoll, feeTrend, +1), why: "this week's fees against last week's, ranked among its own weekly changes" },
  ];
  const demand = [
    { k: "Net flow imbalance, 7d", v: pctLevel(Math.abs(imb7), 1) + (imb7 >= 0 ? " net buying" : " net selling"), d: wk(flowRoll), dFmt: pts,
      s: levelScore(flowRoll, imb7, +1) ?? clamp1(imb7 * 4),
      why: "(bought − sold) ÷ (bought + sold) across indexed venues, trailing 7 days" },
    { k: `Holders with ${compact(thr, 0)}+ AI, 7d change`, v: cur(breadthRoll) == null ? "—" : pct(cur(breadthRoll), 1), d: wk4h(breadthRoll), dFmt: pts,
      s: levelScore(breadthRoll, cur(breadthRoll), +1, 6),
      why: "week-over-week change in addresses above a fixed AI balance, which a price move cannot manufacture" },
    { k: "Wallets net buying per day, 7d", v: cur(buyersRoll) == null ? "—" : Math.round(cur(buyersRoll)).toLocaleString(), d: wk(buyersRoll), dFmt: (x) => `${x >= 0 ? "+" : ""}${Math.round(x)}`,
      s: levelScore(buyersRoll, cur(buyersRoll), +1),
      why: "wallets whose AI balance rose through a pool, netted per transaction so routers cancel out; trailing 7-day average" },
    { k: "Near-spot book lean, ±2%", v: bookShare == null ? "—" : pctLevel(bookShare, 1) + " bids", d: nearHist.length > 24 ? bookShare - nearHist[nearHist.length - 25].v : null, dFmt: pts,
      s: levelScore(nearHist, bookShare, +1, 24, 12) ?? (bookShare == null ? null : clamp1((bookShare - 0.5) * 8)),
      why: "bids as a share of resting liquidity within 2% of spot; above half, it is cheaper to push the price up than down. Ranked once a day of history exists, a level until then" },
    { k: "Launch cadence, 7d", v: cur(launchRoll) == null ? "—" : cur(launchRoll).toLocaleString() + " tokens", d: wk(launchRoll), dFmt: (x) => `${x >= 0 ? "+" : ""}${Math.round(x)}`,
      s: levelScore(launchRoll, cur(launchRoll), +1),
      why: "tokens the platform minted in the last 7 days: attention on the ecosystem AI anchors" },
    { k: "Live tail", w: 0.5, v: L && L.swaps ? `${L.net >= 0 ? "net buying" : "net selling"} ${compact(Math.abs(L.net))} AI` : "—", d: null,
      s: L && L.swaps >= 20 ? clamp1(L.imbalance * 4) : null,
      why: `the last ${L ? fmtAge(L.minutes) : "window"}, read from the chain just now; half weight because it is minutes, not days` },
  ];
  const read = renderCockpit(structure, demand);
  renderValuation(feeAnnual, impliedVol, vols);
  renderTriggers(kappa, sc, capNow, feeAnnual, fee7, fee7p, leak, kd.map((d) => d.ratio));
  renderVerdict(read, net7, net7p, feeAnnual, feeTrend, kappa, sc, capNow, capPrior, removed, leak, kd.map((d) => d.ratio));

  /* Once per page load, not on the three-minute refresh: the comparison is against
     the last time a person looked, and re-snapshotting every cycle would reset the
     clock while they were still reading. */
  if (!S.sinceDone) {
    S.sinceDone = true;
    try {
      renderSinceLast({
        at: Math.floor(Date.now() / 1000),
        price: marketState().price, feeAnnual, leak: leak ? leak.leakNow : null,
        kappa, nvda: b.vault.nvdaBalance,
        structure: read.structure.score, demand: read.demand.score, word: read.title,
        holders100k: H.at(-1)?.aboveAi?.[HOLDER_AI_INDEX] ?? null,
      });
    } catch { /* a convenience must never blank the tab */ }
  }
  /* The cockpit is rewritten on every live tick, so long intros in these panels are
     re-clamped here as well as in renderAll; already-clamped ones are left alone. */
  collapseIntros($("#p-investor"));
  collapseIntros($("#p-valuation"));
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

  /* The chain price is authoritative. This used to hand the display to the
     aggregator whenever the two disagreed by a quarter, which made the header
     jump between sources with nothing on screen to say why. The disagreement is
     still measured and the price card says so; the number shown never switches. */
  const price = livePx || indexedPx || agg || null;
  const source = livePx ? "live on-chain AI/USDG"
    : indexedPx ? "indexed on-chain AI/USDG"
    : agg ? "aggregator (no on-chain print)" : "none";
  const chainPx = livePx || indexedPx;
  const disagrees = !!(chainPx && agg && (chainPx / agg > 1.25 || agg / chainPx > 1.25));

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
  /* Anchored to the clock: the price compared against is the live one, so "24h
     ago" has to mean 24 hours before now, not before the last indexed hour. */
  const at = (hoursAgo) => {
    const t = Math.floor(Date.now() / 1000) - hoursAgo * 3600;
    let best = null;
    for (const h of hrs) if (h.t <= t) best = h;
    return best && t - best.t <= 6 * 3600 ? best.close : null;
  };
  const M = marketState();
  const px = M.price || last.close;
  /* Withhold history that is on a different SCALE, not history that is merely far
     from today's price.

     The first version of this compared each point against the current price and
     rejected anything outside a 20x band. That caught the bug it was written for --
     USDG's decimals error left old closes 10^12 too small and rendered
     "+139,740,061,052,265% 24h" -- but it also threw away the truth: AI traded at
     $0.0107 on 22 July and $0.34 now, a genuine 32x, so two thirds of the real
     dollar history failed the test and the chart claimed 23 days of a 52-day record.
     Absolute distance from today cannot distinguish a big move from a wrong unit.
     Continuity can. A units error is a STEP -- one adjacent-hour ratio in the
     thousands with smooth series either side -- while a rally is a slope. So the
     series is cut at the last such discontinuity and everything after it is kept,
     however far that is from today. The server-side invariant fails the build on
     the same signature, so this is the second line of defence rather than the only
     one. */
  const SCALE_STEP = 1000;
  const scaleCut = (rows) => {
    let cut = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1].close, b = rows[i].close;
      if (a > 0 && b > 0 && Math.max(a / b, b / a) > SCALE_STEP) cut = i;
    }
    return cut;
  };
  const cutAt = scaleCut(hrs);
  const onScaleAll = hrs.slice(cutAt);
  const sane = (h) => {
    if (h == null || !px) return null;
    const first = onScaleAll.length ? onScaleAll[0].close : null;
    // Anything at or after the cut is on the current scale by construction.
    return first != null && h >= Math.min(first, px) / SCALE_STEP ? h : null;
  };
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
    c24 == null ? "" : `${pctOrMult(c24, 1)} 24h`, c24 >= 0 ? "up" : "down",
    `market cap $${compact(mcap)}`);

  /* Chart = settled hourly history + the live five-minute tail. Without the tail
     the line simply stops at the last indexed hour, which on a page that calls
     itself a monitor reads as broken rather than as "not yet indexed". */
  const onScale = onScaleAll;
  const offScale = cutAt;
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
      : `AI is <b>${money(px)}</b>, a market cap of <b>$${compact(mcap)}</b>${c24 == null ? "" : `, <b>${pct(c24, 1)}</b> over 24h`}${c7 == null ? "" : ` and <b>${pctOrMult(c7, 1)}</b> over 7 days`}${c30 == null ? "" : `, <b>${pctOrMult(c30, 1)}</b> over 30 days`}.
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
  /* Each day records whether BOTH kinds of venue were actually trading in the
     indexed set, because otherwise the ratio is structural rather than economic:
     for the first fifty days only hooked pools were indexed, so leakage reads 0%,
     and ranking today against that history reports a record high for a figure whose
     denominator merely acquired seven more pools. Comparisons across time use the
     `comparable` days only. */
  const perDay = new Map();
  for (const p of S.flow.pools) {
    for (const h of p.hourly) {
      const v = (h.aiBuy || 0) + (h.aiSell || 0);
      if (!(v > 0)) continue;
      const d = Math.floor(h.t / DAY) * DAY;
      const row = perDay.get(d) || { t: d, hooked: 0, hookless: 0, sawHooked: false, sawHookless: false };
      if (p.isLongHook) { row.hooked += v; row.sawHooked = true; }
      else { row.hookless += v; row.sawHookless = true; }
      perDay.set(d, row);
    }
  }
  const series = completeDays([...perDay.values()].sort((a, b) => a.t - b.t))
    .map((r) => ({ ...r, total: r.hooked + r.hookless,
      comparable: r.sawHooked && r.sawHookless,
      leak: (r.hooked + r.hookless) > 0 ? r.hookless / (r.hooked + r.hookless) : 0 }))
    .slice(-DAYS);

  const last = series[series.length - 1];
  /* The baseline is the first COMPARABLE day in the window, never a single-venue
     day whose leakage is 0% by construction. The tile read "from 0.0% on Aug 15"
     against exactly the artifact the comparable filter exists to remove. */
  const comparable = series.filter((d) => d.comparable);
  const first = comparable[0] || null;
  /* The headline is the trailing WEEK over comparable days, the same figure the
     Demand/Structure dial ranks, so the tile, the dial and the verdict can never
     quote three different leakages. The last day sits beside it. */
  const wk7 = comparable.slice(-7);
  const wkTot = sumOf(wk7, (d) => d.total);
  const leakNow = wkTot > 0 ? sumOf(wk7, (d) => d.hookless) / wkTot : (last ? last.leak : 0);
  const leakDay = last ? last.leak : null;
  const wkPrior = comparable.slice(-14, -7);
  const wkPriorTot = sumOf(wkPrior, (d) => d.total);
  const leakPrior = wkPriorTot > 0 ? sumOf(wkPrior, (d) => d.hookless) / wkPriorTot : null;

  const liveLeak = S.live?.leak;
  $("#kpiLeak").innerHTML = kpiEl(pctLevel(leakNow, 1),
    leakPrior == null ? "" : `${pts(leakNow - leakPrior)} wk/wk`, leakPrior != null && leakNow > leakPrior ? "down" : "up",
    `of indexed volume pays the vault nothing, 7d`)
    + `<div class="livenote">${leakDay == null ? "" : `Last complete day <b>${pctLevel(leakDay, 1)}</b>`}${first ? ` · ${pctLevel(first.leak, 1)} on ${dayFmt(first.t)}` : ""}${liveLeak == null ? "" : ` · live <b>${pctLevel(liveLeak, 1)}</b> over the last ${fmtAge(S.live.minutes)}`}</div>`;
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
    `<b>${pctLevel(leakNow, 1)} of AI volume this week crossed pools that pay the vault nothing</b>${first ? `, against ${pctLevel(first.leak, 1)} on ${dayFmt(first.t)}` : ""}.
     ${worst && worst.v > 0
        ? `The largest of them is <b>AI / ${worst.p.pairSymbol} at ${feeOf(worst.p)}</b>, opened ${dayFmt(worst.p.createdAt)} with no hook —
           versus <b>${feeOf(main)}</b> on the tolled AI/NVDA pool. Routers choose on execution cost, so the cheaper hookless venue wins the flow.`
        : ""}
     This is why revenue fell while total volume did not. It is a <b>structural</b> problem, not a cyclical one:
     v4 pools are permissionless, so the toll can always be undercut by a pool that provides no funding to the protocol.`);

  return { leakNow, leakDay, worst, series, comparable };
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
    { m: "Capitalised at 7.5%", ai: `${compact(feeAnnual / 0.075)} AI`, u: usd(feeAnnual / 0.075),
      n: "yield method — the discount rate is an assumption, not a measurement" },
    { m: "Capitalised at 6.0%", ai: `${compact(feeAnnual / 0.06)} AI`, u: usd(feeAnnual / 0.06),
      n: "same stream, 1.5 points cheaper: note how far the answer moves" },
    { m: "Capitalised at 5.0%", ai: `${compact(feeAnnual / 0.05)} AI`, u: usd(feeAnnual / 0.05),
      n: "a rate typically given to listed venues with durable revenue" },
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
      : `On the fee stream alone, capitalised at 6%, the measured revenue supports about
         <b>$${compact(capBase)}</b> against a market cap of <b>$${compact(mcap)}</b> —
         <b>${ratio >= 1 ? `${ratio.toFixed(2)}× above` : `${(1 / ratio).toFixed(2)}× below`}</b> the current price.
         ${ratio >= 1
            ? "The revenue alone would justify the price, which means the monetary premium is being had for free."
            : "So the price already embeds growth the current fee stream does not cover; you are paying for the hub thesis converting, not for today's cash flow."}
         Treat this as a floor calculation: it values the toll and ignores both the NVDA reserve and any monetary premium.
         <span class="muted">The only measured input here is the fee run-rate. Every discount rate is an assumption —
         at 7.5% the same stream supports ${usd(feeAnnual / 0.075)} and at 5% it supports ${usd(feeAnnual / 0.05)}, so
         the rate moves the answer by more than half. Read the spread, not any single row.</span>`);
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
  if (S.bridges?.byKind?.organic?.tokens) {
    const org = (S.bridges?.byKind?.organic) || {};
    const shown = org.weightedShare ?? org.medianShare;
    const host = $("#takeBoner");
    if (host) host.innerHTML = (takeEl(shown != null && shown < 0.10 ? "neg" : "warn",
      `This is the question the hub story turns on, so read the population and not one row.
       Across the <b>${org.tokens ?? 0}</b> organic bridges measured — tokens that had their own venues before an AI
       pool existed — AI wins
       ${shown == null ? "an unmeasured share" : `<b>${pctLevel(shown, 1)}</b> of their trading on a flow-weighted basis`}${org.medianShare == null ? "" :
       `, with a median of <b>${pctLevel(org.medianShare, 1)}</b> and a range of
        ${pctLevel(org.minShare ?? 0, 1)}–${pctLevel(org.maxShare ?? 0, 1)}`}. The spread is the finding: the largest
       organic bridge routes a real fraction through AI while the typical one barely does, so "AI is becoming the
       hub" is true of one token and not yet of the population.
       ${boner ? `<span class="muted">For context, a circulating writeup put AI/BONER at 35–37% of all BONER trading.
       Measured here across its ${boner.venues.toLocaleString()} venues it is ${pctLevel(boner.aiPairShare, 1)} — which is
       worth knowing, but one token was never the test either way.</span>` : ""}`));
  } else { const host = $("#takeBoner"); if (host) host.innerHTML = ""; }
  $("#takeVenues").innerHTML = takeEl(paying / total < 0.5 ? "neg" : "pos",
    `Of the last 72 hours of indexed AI volume, <b>${pctLevel(paying / total, 1)}</b> crossed a venue that funds the vault.
     The tolled pool is the oldest and the most expensive; every newer hookless pool competes with it directly on price
     while contributing nothing to the burn. Fee capture is therefore a function of venue competition, not of demand —
     which is why it can fall on a day when total volume rises.`);
}

function renderTriggers(kappa, sc, capNow, feeAnnual, fee7, fee7p, leak, kappaHist = []) {
  const sorted = kappaHist.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  const q = (f) => (sorted.length >= 10 ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : null);
  const hi = q(0.9), lo = q(0.1);
  const rows = [
    ["Hookless share of AI volume keeps climbing",
     `${leak ? pctLevel(leak.leakNow, 1) : "—"} of volume now pays the vault nothing. This is the live cause of the revenue decline; if it keeps rising, fee-based valuation keeps falling regardless of how well the ecosystem does.`,
     leak && leak.leakNow > 0.5 ? "neg" : "warn"],
    [hi == null ? "Hub conversion breaks to a new high" : `Hub conversion sustains above ${pctLevel(hi, 0)}`,
     `κ is ${pctLevel(kappa, 1)}${hi == null ? "" : `, against a 90th percentile of ${pctLevel(hi, 1)} over its own history`}.
      Holding in the top decile of its own range would mean routers are choosing AI as the path more than they
      ever have — the strongest add signal on this page.`,
     hi != null && kappa >= hi ? "pos" : "warn"],
    [lo == null ? "Hub conversion falls to a new low" : `Hub conversion drops under ${pctLevel(lo, 0)}`,
     `${lo == null ? "" : `That is the bottom decile of its own range. `}It would mean routers stopped choosing AI as the
      path, which is the cleanest single disconfirmation available — and unlike a price move it cannot be
      explained away as sentiment.`,
     lo != null && kappa < lo ? "neg" : "pos"],
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

/* ── the two dials ───────────────────────────────────────────────────────
   One large word used to sit here: a weighted sum of eight inputs snapped to
   BULLISH / NEUTRAL / BEARISH at ±0.25. Three things were wrong with it.

   It mixed two different questions. Whether the toll, the hub and the reserve are
   improving is a question about the protocol and moves over weeks; whether money
   is arriving or leaving is a question about the crowd and moves over hours. One
   number averaged them, so "the business is deteriorating while buyers pile in"
   and "the business is improving while holders leave" both came out NEUTRAL, and
   those are the two situations a holder most needs told apart.

   It ranked every level against the asset's WHOLE history. AI is two months old
   and launched into its all-time peak of everything, so a full-history percentile
   reads "lowest ever" for any input that has cooled since launch and will keep
   reading that way for months whatever happens next. The last 30 days is the
   range that says whether something is turning.

   And it had a threshold, which is a false claim of precision: −0.24 and −0.26
   are the same reading and the word flipped between them on a phone refresh.

   So: two dials, each a plain average of its inputs (equal weights, stated; the
   kpis.json panel exists to earn unequal ones), each input ranked inside its own
   trailing 30 days with the week's direction beside it, and a reading matrix over
   the pair instead of a word over a sum. The backtest's finding stands and is
   printed under the dials: nothing here has yet been shown to LEAD the dollar
   price; the Demand dial is the crowd's current behaviour, not a forecast of it. */
const RATING = {
  windowDays: 30,     // the asset's own trailing range each level is ranked inside
  minHistory: 10,     // fewer points than this and the input is shown, not scored
  flat: 0.15,         // |score| under this reads as "steady", not a direction
};

/** Trailing-window aggregates over a daily (or 4-hourly) series; each row keeps its own t. */
function rolling(rows, n, agg) {
  const out = [];
  for (let i = n - 1; i < rows.length; i++) {
    const v = agg(rows.slice(i - n + 1, i + 1));
    if (v != null && isFinite(v)) out.push({ t: rows[i].t, v });
  }
  return out;
}
const sumOf = (w, pick) => w.reduce((s, d) => s + (pick(d) || 0), 0);
const clamp1 = (x) => (x == null || !isFinite(x) ? null : Math.max(-1, Math.min(1, x)));
const pts = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;

/**
 * Where the latest value sits inside the asset's own trailing window, as -1..+1.
 * `dir` is -1 for inputs where high is bad. `pointsPerDay` scales the window for
 * series finer than daily. Null below the minimum sample, never a guess.
 */
function levelScore(roll, current, dir = 1, pointsPerDay = 1, minN = RATING.minHistory) {
  const xs = roll.slice(-RATING.windowDays * pointsPerDay).map((r) => r.v);
  const p = pctlScore(xs, current, minN);
  return p == null ? null : p * dir;
}

/** Equal-weight average of the inputs that could be scored, with coverage. */
function axis(inputs) {
  const scored = inputs.filter((c) => c.s != null);
  const weight = scored.reduce((s, c) => s + (c.w ?? 1), 0);
  const allWeight = inputs.reduce((s, c) => s + (c.w ?? 1), 0);
  return {
    score: weight ? scored.reduce((s, c) => s + c.s * (c.w ?? 1), 0) / weight : null,
    scored: scored.length, n: inputs.length, weight, allWeight, inputs,
  };
}
const bandOf = (x) => (x == null ? "na" : x > RATING.flat ? "up" : x < -RATING.flat ? "down" : "flat");

/* The reading over the pair. Titles are what the phone shows first, so each one is
   a sentence a holder can act on, and the body says what would change it. */
const READINGS = {
  "up|up":     ["pos", "Compounding, with buyers behind it",
    "The toll, the hub and the reserve are improving against their own recent range, and flow and holder breadth are confirming it. This is the combination the thesis needs, and the one to be positioned for; it ends when either dial rolls over."],
  "up|flat":   ["pos", "Structure improving, crowd not here yet",
    "The protocol is getting stronger while demand is balanced. If the structure keeps improving this is the quiet period before the crowd notices; if demand fades into selling it becomes the next reading down."],
  "up|down":   ["neu", "Improving underneath, being sold",
    "Fundamentals are strengthening while flow and breadth are net negative. Read it as the market disagreeing with the mechanics: an accumulation zone if the structure holds, a warning if the selling persists for more than a week."],
  "flat|up":   ["neu", "Demand without a structural change",
    "Buyers are arriving but the toll, the hub and the reserve are where they were. Momentum, not earnings. It can run, and it needs the Structure dial to follow within weeks or it is a trade rather than a position."],
  "flat|flat": ["neu", "Steady on both dials",
    "Nothing is moving against its own recent range. The next turn on either dial is the information."],
  "flat|down": ["warn", "Being sold into an unchanged structure",
    "Holders are leaving while nothing in the protocol has changed. Without a structural improvement to lean on, this is price finding the next buyer on its own."],
  "down|up":   ["warn", "Demand without the fundamentals",
    "Flow and breadth are improving while the business underneath deteriorates. A rally on this footing is sentiment; trade it as one and watch the Structure dial for the turn that would make it more."],
  "down|flat": ["warn", "Deteriorating, quietly",
    "The toll, the hub or the reserve are weakening against their own range and demand has not reacted yet. The crowd usually notices late; the dial noticed now."],
  "down|down": ["neg", "Deteriorating on both dials",
    "The fundamentals are weakening and holders are leaving. Nothing here says when it stops, and neither dial has to reverse before the other."],
};
function reading(s, d) {
  const S1 = bandOf(s), D1 = bandOf(d);
  if (S1 === "na" && D1 === "na") return { tone: "neu", title: "Not enough history to read yet", body: "Both dials need at least ten days of their own measurements to rank anything. They accrue with every refresh." };
  if (S1 === "na") return { tone: D1 === "up" ? "pos" : D1 === "down" ? "warn" : "neu", title: `Demand ${D1 === "up" ? "buying" : D1 === "down" ? "selling" : "balanced"}; structure not yet rankable`, body: "The Structure inputs have too little history to place; the Demand reading stands on its own for now." };
  if (D1 === "na") return { tone: S1 === "up" ? "pos" : S1 === "down" ? "warn" : "neu", title: `Structure ${S1 === "up" ? "improving" : S1 === "down" ? "deteriorating" : "steady"}; demand not yet rankable`, body: "The Demand inputs have too little history to place; the Structure reading stands on its own for now." };
  const [tone, title, body] = READINGS[`${S1}|${D1}`];
  return { tone, title, body };
}

/** A tile sparkline: the shape of a series, no axes, filled under the line. */
function spark(vals, color) {
  const xs = (vals || []).filter((v) => v != null && isFinite(v));
  if (xs.length < 4) return "";
  const W = 100, Hh = 26, lo = minOf(xs), hi = maxOf(xs), span = hi - lo || 1;
  const pts2 = xs.map((v, i) => `${((i / (xs.length - 1)) * W).toFixed(1)},${(Hh - 2 - ((v - lo) / span) * (Hh - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="0,${Hh} ${pts2.join(" ")} ${W},${Hh}" fill="${color}"/>
    <polyline points="${pts2.join(" ")}" stroke="${color}"/></svg>`;
}

/* Re-render a host without losing which <details> the reader had opened. The
   cockpit is rewritten on every live tick; without this, "How this is scored"
   snapped shut twenty seconds after being opened. */
function rerender(host, html) {
  const open = new Set([...host.querySelectorAll("details[data-k]")].filter((d) => d.open).map((d) => d.dataset.k));
  host.innerHTML = html;
  for (const d of host.querySelectorAll("details[data-k]")) if (open.has(d.dataset.k)) d.open = true;
}

/** Dollar figures the cockpit and the dollars card share. Null where an input is missing. */
function dollarState() {
  const M = marketState();
  const px = M.price;
  const b = S.burns;
  const pool = usdPool();
  const nvdaPool = S.flow?.pools.find((p) => p.poolId === S.meta?.contracts?.aiNvdaPool);
  const aiNvda = [...(nvdaPool?.hourly || [])].reverse().find((h) => h.close > 0)?.close ?? null;
  const impliedNvda = px && aiNvda ? px / aiNvda : null;
  const fresh = S.prices && (Date.now() / 1000 - (S.prices.updatedAt || 0)) < 8 * 3600;
  const nvdaUsd = (fresh && S.prices.nvdaUsd) || impliedNvda || (S.prices?.nvdaUsd ?? null);
  const nvdaSource = fresh && S.prices?.nvdaUsd ? "NVDA's own USDG pool" : impliedNvda ? "AI/USDG ÷ AI/NVDA (implied)" : S.prices?.nvdaUsd ? "NVDA's own USDG pool (stale)" : null;
  const closeAt = usdCloseAt();
  const head = S.meta?.headTime || Math.floor(Date.now() / 1000);
  let vol24 = 0, volAi24 = 0;
  for (const p of S.flow?.pools || []) {
    for (const h of p.hourly) {
      if (h.t < head - 24 * 3600) continue;
      const v = (h.aiBuy || 0) + (h.aiSell || 0);
      const c = closeAt(h.t) ?? px;
      if (c) { vol24 += v * c; volAi24 += v; }
    }
  }
  const lastDay = completeDays(b?.daily || []).at(-1);
  const fee = (d) => (d.burnAI || 0) + (d.lockAI || 0) + (d.platformAI || 0);
  const feesAiDay = lastDay ? fee(lastDay) : null;
  /* Priced at that day's own average close, the same way the dollars chart prices
     it, so the tile and the bar for the same day cannot disagree. */
  let dayPx = null;
  if (lastDay) {
    const cl = usdSeries().hrs.filter((h) => h.t >= lastDay.t && h.t < lastDay.t + DAY).map((h) => h.close);
    dayPx = cl.length ? cl.reduce((s, v) => s + v, 0) / cl.length : px;
  }
  return {
    px, mcap: M.mcap, nvdaUsd, nvdaSource, impliedNvda,
    vaultUsd: nvdaUsd && b ? b.vault.nvdaBalance * nvdaUsd : null,
    vol24: vol24 || null, volAi24,
    feesUsdDay: feesAiDay != null && dayPx ? feesAiDay * dayPx : null,
    // Fees are earned in AI, so the yield on the cap is price-invariant: AI fees × 365 ÷ supply.
    feeYield: feesAiDay != null && M.supply ? (feesAiDay * 365) / M.supply : null,
  };
}

function renderCockpit(structure, demand) {
  const Sx = axis(structure), Dx = axis(demand);
  const read = reading(Sx.score, Dx.score);
  read.structure = Sx; read.demand = Dx;
  S.ratingRead = read;

  const M = marketState();
  const D = dollarState();
  const H = (S.holders?.snapshots || []).filter((x) => x.holders > 0);
  const hNow = H.at(-1), hWk = H[Math.max(0, H.length - 1 - 42)];
  const b100 = hNow?.aboveAi?.[HOLDER_AI_INDEX], b100w = hWk?.aboveAi?.[HOLDER_AI_INDEX];
  const L = S.live;
  const thr = S.holders?.aiThresholds?.[HOLDER_AI_INDEX] ?? 1e5;

  /* Sparklines carry the shape; the number carries the level. Price is the last
     7 days of hourly closes, holders the last 30 days of snapshots, volume the last
     30 complete days in dollars. The price and cap tiles are filled by
     paintHeaderMarket so they can never disagree with the header. */
  const pxSpark = usdSeries().hrs.slice(-24 * 7).map((h) => h.close);
  const hSpark = H.slice(-6 * 30).map((x) => x.aboveAi?.[HOLDER_AI_INDEX]).filter((v) => v != null);
  const vSpark = completeDays(dailyDollars(null)).slice(-30).map((d) => d.volUsd);
  const ch24 = onChainChange24(M.price);
  const tiles = [
    { id: "ctPrice", lbl: "AI · USD", val: M.price ? moneyPx(M.price) : "—",
      note: ch24 == null ? "on chain" : `<span class="${ch24 >= 0 ? "up" : "down"}">${pct(ch24, 1)}</span> over 24h, on chain`,
      spark: spark(pxSpark, (ch24 ?? 0) >= 0 ? "var(--buy)" : "var(--sell)") },
    { id: "ctMcap", lbl: "Market cap", val: M.mcap ? `$${compact(M.mcap)}` : "—",
      note: M.mcap ? `× ${compact(M.supply, 1)} AI ${M.supplyLive ? "live" : "indexed"} supply` : "" },
    { lbl: "Live flow", val: L && L.swaps ? `${L.net >= 0 ? "+" : "−"}${compact(Math.abs(L.net))}` : "—",
      cls: L && L.swaps ? (L.net >= 0 ? "up" : "down") : "",
      note: L && L.swaps ? `AI net ${L.net >= 0 ? "bought" : "sold"} in ${fmtAge(L.minutes)} · ${L.swaps.toLocaleString()} trades` : "waiting on the chain" },
    { lbl: `Holders, ${compact(thr, 0)}+ AI`, val: b100 == null ? "—" : b100.toLocaleString(),
      cls: b100w ? (b100 >= b100w ? "up" : "down") : "",
      note: b100w ? `${pct(b100 / b100w - 1, 1)} in 7d · ${hNow.holders.toLocaleString()} holders in all` : "replay pending",
      spark: spark(hSpark, b100w && b100 < b100w ? "var(--sell)" : "var(--buy)") },
    { lbl: "Vault, in dollars", val: D.vaultUsd ? `$${compact(D.vaultUsd)}` : "—",
      note: D.vaultUsd && M.mcap ? `${pctLevel(D.vaultUsd / M.mcap, 2)} of cap · not redeemable` : "NVDA price pending" },
    { lbl: "Volume, 24h", val: D.vol24 ? `$${compact(D.vol24)}` : "—",
      note: D.vol24 && M.mcap ? `${pctLevel(D.vol24 / M.mcap, 1)} of cap turned over · ${S.flow.pools.length} venues` : "indexed venues",
      spark: spark(vSpark, "var(--series-3)") },
  ];

  const dial = (name, ax, words) => {
    const b = bandOf(ax.score);
    const word = words[b];
    const pos = ax.score == null ? 50 : ((ax.score + 1) / 2) * 100;
    return `<div class="dial">
      <div class="dial-hd"><span class="dial-name">${name}</span>
        <b class="${b === "up" ? "up" : b === "down" ? "down" : ""}">${word}</b>
        <span class="dial-score">${ax.score == null ? "n/a" : `${ax.score >= 0 ? "+" : ""}${ax.score.toFixed(2)}`}</span></div>
      <div class="scale${ax.score == null ? " empty" : ""}"><div class="needle" style="left:calc(${pos.toFixed(1)}% - 1.5px)"></div></div>
      <div class="scale-ends"><span>${words.down}</span><span>${ax.scored} of ${ax.n} inputs ranked</span><span>${words.up}</span></div>
    </div>`;
  };
  const rows = (inputs) => inputs.map((c) => {
    const band = c.s == null ? ["na", "no range yet"] : c.s > 0.6 ? ["xbull", "top of range"] : c.s > 0.2 ? ["bull", "high"] : c.s < -0.6 ? ["bear", "bottom of range"] : c.s < -0.2 ? ["bear", "low"] : ["base", "typical"];
    const dTxt = c.d == null || !isFinite(c.d) ? "" : `<span class="${(c.invert ? -c.d : c.d) >= 0 ? "up" : "down"}">${(c.dFmt || pts)(c.d)}</span> <span class="muted">7d</span>`;
    return `<div class="row">
      <div><div>${c.k}</div><div class="muted why">${c.why}</div></div>
      <div class="v">${c.v}<div class="d">${dTxt}</div></div>
      <div class="w"><span class="band ${band[0]}">${band[1]}</span><br>${c.s == null ? "n/a" : `${c.s >= 0 ? "+" : ""}${c.s.toFixed(2)}`}${c.w != null && c.w !== 1 ? ` · w ${c.w}` : ""}</div>
    </div>`;
  }).join("");

  /* Two homes. The Investor tab (the platform view) carries the market tiles, the
     Demand dial and the combined reading; the Valuation tab carries the Structure
     dial with Coulou's inputs and credit. Same computation, split by audience. */
  rerender($("#ratingDemand"), `
    <div class="rating">
      <div class="cockpit">${tiles.map((t) => `<div class="ctile"${t.id ? ` id="${t.id}"` : ""}>${t.spark || ""}<div class="lbl">${t.lbl}</div><div class="val ${t.cls || ""}">${t.val}</div><div class="note">${t.note}</div></div>`).join("")}</div>
      <div class="dials one">
        ${dial("Demand", Dx, { up: "buying", flat: "balanced", down: "selling", na: "unranked" })}
      </div>
      <div class="reading ${read.tone}"><b>${read.title}.</b> ${read.body} <span class="muted">Structure is scored on the Valuation tab.</span></div>
      <details data-k="dinputs"><summary>The ${Dx.n} demand inputs</summary>
        <div class="components">${rows(demand)}</div>
        <div class="coverage">Each input is a trailing-7-day level ranked inside AI's own last ${RATING.windowDays} days: 0 is typical for this
          asset lately, ±1 is the edge of that range. Equal weights (the live tail at half).</div>
      </details>
    </div>`);
  rerender($("#rating"), `
    <div class="rating">
      <div class="dials">
        ${dial("Structure", Sx, { up: "improving", flat: "steady", down: "deteriorating", na: "unranked" })}
        ${dial("Demand", Dx, { up: "buying", flat: "balanced", down: "selling", na: "unranked" })}
      </div>
      <div class="reading ${read.tone}"><b>${read.title}.</b> ${read.body}</div>
      <details data-k="inputs"><summary>The ${Sx.n + Dx.n} inputs behind the dials</summary>
        <div class="components">
          <div class="grp">Structure — the protocol</div>${rows(structure)}
          <div class="grp">Demand — the crowd</div>${rows(demand)}
        </div>
        <div class="coverage">Each input is a trailing-7-day level ranked inside AI's own last ${RATING.windowDays} days: 0 is typical for this
          asset lately, ±1 is the edge of that range. Inputs are equal-weighted within a dial (the live tail at half) until the
          hourly panel in kpis.json has enough history to justify anything else. Inputs with under ${RATING.minHistory} points are
          shown and left unranked rather than scored against a guess.</div>
      </details>
      <div class="attribution">
        <b>Methodology credit — not the site owner’s view.</b> The Structure dial scores the inputs identified in
        <a href="https://x.com/okay_lets_ride/status/2098082744899190788" target="_blank" rel="noopener noreferrer">Coulou’s
        “AI – Valuation Report”</a> (@okay_lets_ride, 10 Sep 2026): protocol fee revenue, main-pool fee capture,
        AI-pair share, cross-routing κ and the NVDA vault, with the 5–7.5% capitalisation rates used in the valuation
        frame below. <b>Two things differ from the report:</b> each input is ranked against AI’s own measured history
        rather than its bear/base/bull scenario values, and the weights are this site’s. The Demand dial is this site’s
        addition and is not in the report. Neither is the report’s conclusion — a probability-weighted valuation well
        above today’s market cap — and neither is investment advice.
      </div>
      <details data-k="how"><summary>How this is scored, and what it is not</summary>
        <p class="scope">
          <b>Structure</b> asks whether the business behind AI is improving: fee capture, toll leakage, hub conversion,
          how often new launches choose AI as a base pair, NVDA accreting to the vault, and the fee run-rate’s trend.
          <b>Demand</b> asks what holders are doing right now: net flow, the count of wallets above a fixed AI balance
          (which a price move cannot manufacture), distinct buyers per day, which side of the near-spot book is heavier,
          how fast the platform is minting, and the live tail. Every level is ranked inside the asset’s own trailing
          ${RATING.windowDays} days rather than its whole history, because a two-month-old token that launched into its
          peak reads “lowest ever” on everything forever; the last month is the range that says whether something is
          turning. <b>Neither dial is a price forecast.</b> Tested against the dollar price over the asset’s life, no
          input here has yet been shown to lead it (the Method tab shows the test); Demand describes the crowd’s current
          behaviour, and Structure describes the protocol’s. The hourly panel in <code>kpis.json</code> records every input
          beside price so the weights can be earned rather than assumed.
        </p>
      </details>
    </div>`);
  return read;
}

/* ── dollars ─────────────────────────────────────────────────────────────
   Most of the site is denominated in AI because that is what the chain measures.
   A holder's question is in dollars. Each figure below multiplies an AI quantity
   by the on-chain USDG price of the hour it happened in, so a price move inside a
   day is not averaged away. */

/** AI's dollar close for any hour, from the stitched USDG series (nearest earlier hour within a day). */
function usdCloseAt() {
  const hrs = usdSeries().hrs;
  const m = new Map(hrs.map((h) => [h.t, h.close]));
  const ts = hrs.map((h) => h.t);
  return (t) => {
    if (m.has(t)) return m.get(t);
    let lo = 0, hi = ts.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best >= 0 && t - ts[best] <= 86400 ? m.get(ts[best]) : null;
  };
}

/**
 * Wallets that net-bought and net-sold AI per UTC day.
 *
 * From the holder replay, which nets every transfer in a transaction per address
 * so routers cancel out and the wallet whose balance changed is the trader. The
 * flow index's per-hour "buyers" were v4 Swap senders, which are routers: the
 * busiest hour on AI/NVDA showed 5,019 swaps from 18 of them. Summed over the six
 * four-hour periods of a day, so a wallet active in two periods counts twice; an
 * upper bound on people, and a real one.
 */
function dailyBuyers() {
  const byDay = new Map();
  for (const s of S.holders?.snapshots || []) {
    if (s.buyers == null) continue;
    const d = Math.floor((s.t - 1) / DAY) * DAY;   // the row at 00:00 closes the previous day
    const r = byDay.get(d) || { t: d, buyers: 0, sellers: 0, rows: 0 };
    r.buyers += s.buyers; r.sellers += s.sellers || 0; r.rows++;
    byDay.set(d, r);
  }
  return [...byDay.values()].filter((r) => r.rows === 6).sort((a, b) => a.t - b.t);
}

/** Per-day AI volume and fees in dollars, priced hour by hour. */
function dailyDollars(feeSeries) {
  const closeAt = usdCloseAt();
  const m = new Map();
  for (const p of S.flow.pools) {
    for (const h of p.hourly) {
      const c = closeAt(h.t);
      if (!c) continue;
      const d = Math.floor(h.t / DAY) * DAY;
      const r = m.get(d) || { t: d, volUsd: 0, volAi: 0, pxSum: 0, pxN: 0 };
      const v = (h.aiBuy || 0) + (h.aiSell || 0);
      r.volUsd += v * c; r.volAi += v; r.pxSum += c; r.pxN++;
      m.set(d, r);
    }
  }
  const feeByDay = new Map((feeSeries || []).map((d) => [d.t, d.fee]));
  return [...m.values()].sort((a, b) => a.t - b.t).map((r) => {
    const avgPx = r.pxN ? r.pxSum / r.pxN : null;
    const feeAi = feeByDay.get(r.t);
    return { ...r, avgPx, feeUsd: feeAi != null && avgPx ? feeAi * avgPx : null };
  });
}

/**
 * NVDA in dollars, hour by hour. The direct series (NVDA's own USDG pool) is
 * preferred once it is a week deep; until then the implied one -- AI in USDG over
 * AI in NVDA -- stands in, labelled. Both exist so AI's beta to the stock it is
 * anchored to can be measured instead of assumed.
 */
function nvdaHistory() {
  const direct = (S.prices?.history || []).filter((h) => h.nvdaUsd > 0).map((h) => ({ t: h.t, v: h.nvdaUsd }));
  if (direct.length >= 168 && direct.at(-1).t - direct[0].t >= 7 * 86400) return { rows: direct, source: "NVDA's own USDG pool" };
  const nvdaPool = S.flow.pools.find((p) => p.poolId === S.meta.contracts.aiNvdaPool);
  const closeAt = usdCloseAt();
  const rows = [];
  for (const h of nvdaPool?.hourly || []) {
    if (!(h.close > 0)) continue;
    const usd = closeAt(h.t);
    if (usd) rows.push({ t: h.t, v: usd / h.close });
  }
  return { rows, source: "implied from AI/USDG ÷ AI/NVDA" };
}

/** Slope and correlation of AI's hourly log returns on NVDA's, over aligned hours. */
function betaTo(aiRows, nvRows, hours = 24 * 30) {
  const nv = new Map(nvRows.map((r) => [r.t, r.v]));
  const xs = [], ys = [];
  const recent = aiRows.slice(-hours - 1);
  for (let i = 1; i < recent.length; i++) {
    const a0 = recent[i - 1], a1 = recent[i];
    const n0 = nv.get(a0.t), n1 = nv.get(a1.t);
    if (!(a0.close > 0 && a1.close > 0 && n0 > 0 && n1 > 0) || a1.t - a0.t !== 3600) continue;
    xs.push(Math.log(n1 / n0)); ys.push(Math.log(a1.close / a0.close));
  }
  const n = xs.length;
  if (n < 48) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return { beta: sxx ? sxy / sxx : null, r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, n };
}

function renderDollars(feeSeries) {
  const host = $("#kpiDollars");
  if (!host) return;
  const D = dollarState();
  const days = completeDays(dailyDollars(feeSeries));
  const last7 = days.slice(-7), prior7 = days.slice(-14, -7);
  const avg = (rows, pick) => (rows.length ? rows.reduce((s, r) => s + (pick(r) || 0), 0) / rows.length : null);
  const vol7 = avg(last7, (r) => r.volUsd), vol7p = avg(prior7, (r) => r.volUsd);
  const fee7 = avg(last7.filter((r) => r.feeUsd != null), (r) => r.feeUsd);
  const turnover = D.vol24 && D.mcap ? D.vol24 / D.mcap : null;

  const tiles = [
    { lbl: "Volume, last 24h", val: D.vol24 ? `$${compact(D.vol24)}` : "—",
      note: vol7 ? `7d avg $${compact(vol7)}/day${vol7p ? ` · ${pct(vol7 / vol7p - 1, 0)} vs prior week` : ""}` : "indexed venues, priced hourly" },
    { lbl: "Turnover", val: pctLevel(turnover, 1), note: "of market cap traded in 24h" },
    { lbl: "Fees, per day", val: D.feesUsdDay != null ? `$${compact(D.feesUsdDay)}` : "—",
      note: fee7 != null ? `7d avg $${compact(fee7)}/day${D.feeYield != null ? ` · ${pctLevel(D.feeYield, 2)} of cap, annualised` : ""}` : "last complete day, all three legs" },
    { lbl: "Vault, in dollars", val: D.vaultUsd ? `$${compact(D.vaultUsd)}` : "—",
      note: D.vaultUsd && D.mcap ? `${pctLevel(D.vaultUsd / D.mcap, 2)} of market cap · ${nf(S.burns.vault.nvdaBalance, 0)} NVDA at $${D.nvdaUsd ? D.nvdaUsd.toFixed(0) : "—"}` : "needs an NVDA dollar price" },
  ];
  host.innerHTML = `<div class="grid g4 tight">${tiles.map((t) => `<div class="tile"><div class="lbl">${t.lbl}</div><div class="val">${t.val}</div><div class="note">${t.note}</div></div>`).join("")}</div>`;

  barChart($("#cDollars"), days.slice(-30), {
    xKey: "t", yKey: "volUsd", color: "var(--series-1)", xFmt: dayFmt, fmt: (v) => `$${compact(v, 0)}`,
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>$${compact(d.volUsd)} traded</div>
      <div class="k">${compact(d.volAi)} AI at an average $${d.avgPx ? d.avgPx.toFixed(4) : "—"}${d.feeUsd != null ? ` · fees $${compact(d.feeUsd)}` : ""}</div>`,
  });

  /* AI against the stock it is anchored to. */
  const N = nvdaHistory();
  const U = usdSeries().hrs;
  const lastU = U.at(-1);
  const atHours = (rows, back, pick) => { const t = rows.at(-1).t - back * 3600; let best = null; for (const r of rows) if (r.t <= t) best = r; return best ? pick(best) : null; };
  const ai7 = U.length && lastU ? (() => { const p = atHours(U, 168, (r) => r.close); return p ? lastU.close / p - 1 : null; })() : null;
  const nv7 = N.rows.length ? (() => { const p = atHours(N.rows, 168, (r) => r.v); return p ? N.rows.at(-1).v / p - 1 : null; })() : null;
  const beta = N.rows.length ? betaTo(U, N.rows) : null;
  const ratioNote = ai7 != null && nv7 != null
    ? `Over 7 days AI moved <b>${pctOrMult(ai7, 1)}</b> in dollars while NVDA moved <b>${pct(nv7, 1)}</b>, so the AI/NVDA ratio itself ${ai7 > nv7 ? "rose" : "fell"}: ${ai7 > nv7 ? "AI outran its anchor" : "AI lagged its anchor"}.`
    : "";
  const betaNote = beta && beta.beta != null
    ? ` Over the last ${Math.round(beta.n / 24)} days of hourly data AI's beta to NVDA is <b>${beta.beta.toFixed(2)}</b> (correlation ${beta.r.toFixed(2)}): ${Math.abs(beta.r) < 0.15 ? "essentially no relationship at the hourly grain, so NVDA's own moves are not what has been driving AI" : beta.beta > 1.2 ? "AI has amplified NVDA's moves" : beta.beta > 0.5 ? "AI has tracked a meaningful part of NVDA's moves" : "AI has largely ignored NVDA's moves"}.`
    : "";

  $("#takeDollars").innerHTML = takeEl(turnover == null ? "neu" : turnover > 0.25 ? "warn" : "neu",
    `${D.vol24 ? `<b>$${compact(D.vol24)}</b> of AI traded across the indexed venues in the last 24 hours, <b>${pctLevel(turnover, 1)}</b> of the market cap${vol7 ? ` (a week's average is $${compact(vol7)} a day)` : ""}.` : "No dollar volume yet."}
     ${D.feesUsdDay != null ? `Fees ran at <b>$${compact(D.feesUsdDay)}</b> on the last complete day${D.feeYield != null ? `, which annualises to <b>${pctLevel(D.feeYield, 2)}</b> of the market cap — the yield the toll pays holders in burned and locked AI` : ""}.` : ""}
     ${D.vaultUsd ? `The vault's <b>${nf(S.burns.vault.nvdaBalance, 0)} NVDA</b> is worth <b>$${compact(D.vaultUsd)}</b> at $${D.nvdaUsd.toFixed(0)} a share, <b>${pctLevel(D.vaultUsd / D.mcap, 2)}</b> of the market cap: real, growing, and small next to the price. The reserve supports the story; it does not support the valuation.` : ""}
     ${ratioNote}${betaNote}
     <span class="muted">Dollar figures multiply each hour's AI volume by that hour's AI/USDG close. NVDA's dollar price is ${D.nvdaSource || "pending"}${N.source.startsWith("implied") ? "; its history is implied from AI's two prices until the direct series is a week deep" : ""}. Turnover above a quarter of the cap a day is a market being traded, not held.</span>`);
}

/* ── holder breadth and whales ─────────────────────────────────────────── */
function renderBreadth() {
  const host = $("#kpiBreadth");
  if (!host) return;
  const h = S.holders;
  const snaps = (h?.snapshots || []).filter((x) => x.holders > 0);
  if (snaps.length < 43) {
    host.innerHTML = `<p class="muted">The holder replay needs a week of snapshots before this can say anything.</p>`;
    for (const id of ["#cBreadth", "#tWhales", "#takeBreadth"]) { const e = $(id); if (e) e.innerHTML = ""; }
    return;
  }
  const last = snaps.at(-1), wk = snaps[snaps.length - 43];
  const thr = h.aiThresholds?.[HOLDER_AI_INDEX];
  const aNow = last.aboveAi?.[HOLDER_AI_INDEX], aWk = wk.aboveAi?.[HOLDER_AI_INDEX];
  const dA = aWk ? aNow / aWk - 1 : null;
  const t100 = last.top?.[2], t100w = wk.top?.[2];
  const dT = t100 != null && t100w != null ? t100 - t100w : null;
  const t10 = last.top?.[0];
  const px = marketState().price || 0;

  /* Churn per complete UTC day, from the four-hour rows. Only rows that carry the
     counters are summed; a day with fewer than six such rows is not shown. */
  const byDay = new Map();
  for (const s of snaps) {
    if (s.newHolders == null) continue;
    const d = Math.floor((s.t - 1) / DAY) * DAY;   // the row at 00:00 closes the previous day
    const r = byDay.get(d) || { t: d, n: 0, x: 0, rows: 0 };
    r.n += s.newHolders; r.x += s.exits; r.rows++;
    byDay.set(d, r);
  }
  const churn = completeDays([...byDay.values()].filter((r) => r.rows === 6).sort((a, b) => a.t - b.t));
  const c7 = churn.slice(-7);
  const new7 = sumOf(c7, (r) => r.n), exit7 = sumOf(c7, (r) => r.x);

  host.innerHTML = kpiEl(aNow == null ? "—" : aNow.toLocaleString(),
    dA == null ? "" : `${pct(dA, 1)} in 7d`, (dA ?? 0) >= 0 ? "up" : "down",
    `wallets holding ${compact(thr, 0)}+ AI`)
    + `<div class="livenote">${last.holders.toLocaleString()} holders in all (${last.holders - wk.holders >= 0 ? "+" : ""}${(last.holders - wk.holders).toLocaleString()} in 7d)
       ${c7.length ? `· last 7 days: <b>${new7.toLocaleString()}</b> wallets funded, <b>${exit7.toLocaleString()}</b> emptied` : ""}
       ${t100 != null ? `· top 100 hold <b>${pctLevel(t100, 1)}</b>${dT == null ? "" : ` (${pts(dT)} in 7d)`}` : ""}
       ${t10 != null ? `· top 10 hold <b>${pctLevel(t10, 1)}</b>` : ""}</div>`;

  if (churn.length) {
    divergingBars($("#cBreadth"), churn.slice(-30), {
      xKey: "t", posKey: "n", negKey: "x", height: 200, xFmt: dayFmt, fmt: (v) => Math.abs(v).toFixed(0),
      tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div><span style="color:var(--buy)">▲</span> ${d.n.toLocaleString()} wallets funded</div>
        <div><span style="color:var(--sell)">▼</span> ${d.x.toLocaleString()} emptied</div><div class="k">net ${d.n - d.x >= 0 ? "+" : ""}${(d.n - d.x).toLocaleString()}</div>`,
    });
  } else $("#cBreadth").innerHTML = `<p class="muted" style="padding:16px 0">Wallet churn accrues from the next replay; the count above is already live.</p>`;

  table($("#tWhales"), whaleCols(px), (h.whales || []).slice(0, 8));
  whaleStamp($("#tWhales"), "whaleStamp");

  /* Breadth against concentration is the read: four combinations, each a sentence. */
  const up = (x) => x != null && x > 0.01, down = (x) => x != null && x < -0.01;
  const conc = dT == null ? null : dT > 0.005 ? "up" : dT < -0.005 ? "down" : "flat";
  const [tone, verdict] =
    up(dA) && conc === "down" ? ["pos", "spreading into more hands: more wallets hold size and the largest hold a smaller share, which is the healthiest shape a thin market can have"] :
    up(dA) && conc === "up"   ? ["neu", "growing at both ends: more wallets hold size and the largest are also absorbing more, so both retail and whales are accumulating"] :
    down(dA) && conc === "up" ? ["warn", "consolidating: fewer wallets hold size while the largest hold more, which is smaller holders selling to bigger ones and is the overhang if those turn"] :
    down(dA) && conc === "down" ? ["warn", "thinning at both ends: fewer wallets hold size and the largest are also reducing, which is distribution"] :
    up(dA) ? ["pos", "broadening, with concentration where it was"] :
    down(dA) ? ["warn", "thinning, with concentration where it was"] :
    ["neu", "steady on both counts"];
  const fresh = (h.whales || []).filter((w) => w.kind === "buy" && w.fresh && w.t > last.t - 7 * 86400).length;
  const wBuys = (h.whales || []).filter((w) => w.kind === "buy" && w.t > last.t - 7 * 86400);
  const wSells = (h.whales || []).filter((w) => w.kind === "sell" && w.t > last.t - 7 * 86400);
  $("#takeBreadth").innerHTML = takeEl(tone,
    `<b>${aNow?.toLocaleString() ?? "—"}</b> wallets hold ${compact(thr, 0)} AI or more${dA == null ? "" : ` (<b>${pct(dA, 1)}</b> on the week)`}${t100 == null ? "" : `, and the largest 100 hold <b>${pctLevel(t100, 1)}</b> of wallet-held supply${dT == null ? "" : ` (${pts(dT)})`}`}.
     The base is <b>${verdict}</b>.
     ${wBuys.length || wSells.length ? `Moves of ${compact(h.whaleMinAi || 250000, 0)}+ AI this week: <b>${wBuys.length}</b> bought from pools (${compact(sumOf(wBuys, (w) => w.ai))} AI${fresh ? `, ${fresh} by wallets that held none before` : ""}) against <b>${wSells.length}</b> sold into them (${compact(sumOf(wSells, (w) => w.ai))} AI).` : ""}
     <span class="muted">Counts are at a fixed AI balance so a price move cannot manufacture them. Every move is netted per transaction, so the wallet shown is the one whose balance changed, not the router it went through; "received" and "sent" are moves that touched no pool. One entity can be many wallets.</span>`);
}

/* ── where the fees go ───────────────────────────────────────────────────
   The platform fee wallet is a pipe: everything it receives is forwarded. The
   card states what reached it (fees from the splitter against the hook's launch
   allocation), where it went, and what those wallets hold or have sold now. */
/**
 * A flow diagram, hand-rolled: columns of nodes, ribbons between them whose
 * width is value. Every column sums to about the same total (value is conserved
 * from sources to uses), so one scale serves all columns and widths are
 * comparable across the picture.
 */
function _sankey(host, { cols, links, fmt = (v) => `$${compact(v)}` }) {
  host.innerHTML = "";
  const phone = isPhone();
  const width = Math.max(240, host.clientWidth || 600);
  const height = phone ? 340 : 380;
  const svg = mk("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img" });
  host.appendChild(svg);
  const nodeW = 10, padY = 14, gap = phone ? 8 : 12, labelW = phone ? 74 : 130;
  const x0 = labelW, x1 = width - labelW;
  const totals = cols.map((c) => c.reduce((s, n) => s + n.v, 0));
  const maxTot = maxOf(totals) || 1;
  const maxN = maxOf(cols.map((c) => c.length));
  const scale = (height - 2 * padY - gap * (maxN - 1)) / maxTot;
  const pos = new Map();
  cols.forEach((col, ci) => {
    const x = cols.length === 1 ? x0 : x0 + (ci / (cols.length - 1)) * (x1 - x0);
    const h = totals[ci] * scale + gap * (col.length - 1);
    let y = (height - h) / 2;
    for (const n of col) {
      const nh = Math.max(1, n.v * scale);
      pos.set(n.id, { x, y, h: nh, outY: y, inY: y, ci });
      svg.appendChild(mk("rect", { x: x - nodeW / 2, y, width: nodeW, height: nh, rx: 2, fill: n.color || "var(--text-secondary)" }));
      const right = ci === cols.length - 1 || (ci > 0 && ci < cols.length - 1 && n.labelRight);
      const t = mk("text", { x: right ? x + nodeW : x - nodeW, y: y + Math.min(nh / 2 + 4, Math.max(11, nh / 2 + 4)), "text-anchor": right ? "start" : "end", style: `font:10.5px var(--mono)`, fill: "var(--text-primary)" });
      t.textContent = phone && n.label.length > 14 ? n.label.slice(0, 13) + "…" : n.label;
      svg.appendChild(t);
      const t2 = mk("text", { x: right ? x + nodeW : x - nodeW, y: y + Math.min(nh / 2 + 4, Math.max(11, nh / 2 + 4)) + 12, "text-anchor": right ? "start" : "end", style: `font:10px var(--mono)`, fill: "var(--text-muted)" });
      t2.textContent = fmt(n.v);
      if (nh >= 18 || n.v / totals[ci] > 0.15) svg.appendChild(t2);
      y += nh + gap;
    }
  });
  for (const l of links) {
    const s = pos.get(l.s), t = pos.get(l.t);
    if (!s || !t || l.v <= 0) continue;
    const w = Math.max(0.75, l.v * scale);
    const ya = s.outY, yb = t.inY;
    s.outY += w; t.inY += w;
    const xa = s.x + nodeW / 2, xb = t.x - nodeW / 2, xm = (xa + xb) / 2;
    const d = `M${xa},${ya} C${xm},${ya} ${xm},${yb} ${xb},${yb} L${xb},${yb + w} C${xm},${yb + w} ${xm},${ya + w} ${xa},${ya + w} Z`;
    const p = mk("path", { d, fill: l.color || "var(--text-muted)", opacity: .38 });
    p.appendChild(mk("title")).textContent = `${l.label || ""} ${fmt(l.v)}`.trim();
    svg.appendChild(p);
  }
}
const sankey = wrapChart(_sankey);

/* ── where the fees go ───────────────────────────────────────────────────
   The platform fee wallet is a pipe: everything it receives is forwarded. The
   tab states what reached it, where it went, and what those wallets did with it
   -- held, sold, seeded as liquidity, bought back, or moved on -- because the
   difference between a treasury that recycles into the ecosystem and one that
   sells into it is the difference between a flywheel and an overhang. */
function renderTreasury() {
  const host = $("#kpiTreasury");
  const T = S.treasury;
  if (!T?.feeWallet) {
    host.innerHTML = `<p class="muted">The fee ledger is built on the slow path; it appears after the next standard run.</p>`;
    for (const id of ["#tTreasury", "#tPlatformFees", "#takeTreasury", "#readTreasury", "#cSankey", "#cTreasuryWeekly", "#tTreasuryPools", "#treasuryDest", "#tTerminals"]) $(id).innerHTML = "";
    return;
  }
  const px = marketState().price || 0;
  const nvdaUsd = dollarState().nvdaUsd || 0;
  const rate = { AI: px, NVDA: nvdaUsd, USDG: 1, WETH: 0 };
  const usdOf = (sym, v) => (v || 0) * (rate[sym] || 0);
  const fw = T.feeWallet.ledgers;
  const srcOf = (L, name) => (L?.topSources || []).filter((s) => s.name === name).reduce((s, x) => s + x.v, 0);
  const aiFees = srcOf(fw.AI, "fee splitter"), aiHook = srcOf(fw.AI, "LONG hook");
  const nvFees = srcOf(fw.NVDA, "fee splitter"), nvHook = srcOf(fw.NVDA, "LONG hook");
  const pf = T.platformFees || {};
  const otherUsd = (pf.tokens || []).filter((t) => t.usd != null && ![AI_TOKEN, S.meta.contracts.nvdaToken].includes(t.token)).reduce((s, t) => s + t.usd, 0);

  /* Uses per wallet, in dollars at today's prices, from the classified transactions. */
  const W = (T.treasuryWallets || []).map((w) => {
    const L = w.ledgers || {};
    const agg = { held: 0, sold: 0, lpAdded: 0, bought: 0, sentOn: 0, internal: 0, lpRemoved: 0, bridged: 0, inUsd: 0 };
    const via = {};
    for (const [sym, l] of Object.entries(L)) {
      const u = l.uses || {};
      agg.held += usdOf(sym, l.balance); agg.inUsd += usdOf(sym, l.in);
      for (const k of ["sold", "lpAdded", "bought", "sentOn", "internal", "lpRemoved", "bridged"]) agg[k] += usdOf(sym, u[k]);
      for (const [name, v] of Object.entries(u.via || {})) via[name] = (via[name] || 0) + usdOf(sym, v);
    }
    const aiU = L.AI?.uses || {};
    /* "Sent on" is a first hop, not an end state. Split each wallet's plain AI
       sends by where the AI sat when the transaction ended: in a pool or a router
       (a sale through a hand-off), in a wallet outside the operator's set (paid
       out), or unresolved. Older artifacts without sentOnTo keep the one bucket. */
    const so = aiU.sentOnTo;
    const split = { handoffSold: 0, paidOut: 0, other: 0 };
    if (so) {
      for (const [label, v] of Object.entries(so)) {
        if (label === "v4 pools" || /Uniswap v3|Algebra|Settler|router|Router|Permit2|hook/.test(label)) split.handoffSold += v;
        else if (label.startsWith("0x")) split.paidOut += v;
        else split.other += v;
      }
      split.other += Math.max(0, (aiU.sentOn || 0) - split.handoffSold - split.paidOut - split.other);
    } else split.other = aiU.sentOn || 0;
    agg.handoffSold = usdOf("AI", split.handoffSold); agg.paidOut = usdOf("AI", split.paidOut);
    agg.movedOther = agg.sentOn - agg.handoffSold - agg.paidOut;   // non-AI sends plus unresolved AI
    return { a: w.address, L, agg, via, aiU, split, ai: L.AI || {}, nv: L.NVDA || {}, ug: L.USDG || {} };
  });
  const sum = (k) => W.reduce((s, w) => s + w.agg[k], 0);
  const held = sum("held"), sold = sum("sold"), lp = sum("lpAdded"), bought = sum("bought"), sentOn = sum("sentOn"), bridged = sum("bridged");
  const handoffSold = sum("handoffSold"), paidOut = sum("paidOut"), movedOther = sum("movedOther");
  const soldAll = sold + handoffSold;
  const recycled = lp + bought, out = sold + sentOn + bridged;
  const recycleShare = recycled + out > 0 ? recycled / (recycled + out) : null;
  const viaAll = {};
  for (const w of W) for (const [n, v] of Object.entries(w.via)) viaAll[n] = (viaAll[n] || 0) + v;
  const viaRows = Object.entries(viaAll).sort((a, b) => b[1] - a[1]);

  host.innerHTML = `<div class="kpis">
    <div>${kpiEl(`$${compact(usdOf("AI", aiFees) + usdOf("NVDA", nvFees))}`, `${compact(aiFees)} AI + ${nf(nvFees, 0)} NVDA`, "", "fees from AI trading, today's prices")}</div>
    <div>${kpiEl(`$${compact(usdOf("AI", aiHook) + usdOf("NVDA", nvHook))}`, `${compact(aiHook)} AI + ${nf(nvHook, 0)} NVDA`, "", "LP fees collected from the protocol's own positions, 15–27 Jul; auto-compounded since")}</div>
    <div>${kpiEl(recycleShare == null ? "—" : pctLevel(recycleShare, 1), recycleShare == null ? "" : "recycled", recycleShare == null ? "" : recycleShare >= 0.5 ? "up" : "down", "of what left the treasury went back into AI or its liquidity; the rest was sold or moved out")}</div>
  </div>
  <div class="livenote">The fee wallet forwards everything: ${(fw.AI?.transfersIn || 0).toLocaleString()} transfers in, ${(fw.AI?.transfersOut || 0).toLocaleString()} out, balance <b>${compact(fw.AI?.balance ?? 0)} AI</b>.
    Across the whole launchpad <b>${(pf.tokenCount || 0).toLocaleString()}</b> tokens have paid it; the ${(pf.tokens || []).length} most active are worth <b>$${compact(pf.pricedUsd || 0)}</b> today${pf.unpriced ? ` (${pf.unpriced} unpriced)` : ""}.</div>`;

  /* The reading: what a holder should take from the treasury's behaviour. */
  const wk = (T.weeklyAi || []).slice(-4);
  const rSold = sumOf(wk, (r) => r.sold), rBought = sumOf(wk, (r) => r.bought), rLp = sumOf(wk, (r) => r.lpAdded), rMoved = sumOf(wk, (r) => r.sentOn), rPaid = sumOf(wk, (r) => r.paidOut || 0), rBridged = sumOf(wk, (r) => r.bridged || 0);
  const rOut = rSold + rMoved + rPaid + rBridged, rIn = rBought + rLp;
  const recentTone = rOut > rIn * 2 ? "warn" : rIn > rOut ? "pos" : "neu";
  /* The paragraph reads from the same end-state view as the table below it: where
     the AI sat when each transaction ENDED, not which address it was first handed
     to. By counterparty, a hand-off to a router that sold into a pool in the same
     transaction read as "moved to an address this page cannot name"; it is a sale. */
  /* Same recipient set as the end-state table below (wentTo), so the count and the
     dollars in the paragraph match the "Paid to N external wallets" row. */
  const wentTo = {};
  for (const w of W) for (const [label, v] of Object.entries(w.aiU.wentTo || {})) wentTo[label] = (wentTo[label] || 0) + v;
  const paidOutRows = Object.entries(wentTo).filter(([l]) => l.startsWith("0x"));
  const paidOutN = paidOutRows.length, paidOutUsd = paidOutRows.reduce((s, [, v]) => s + v, 0) * px;
  const heldOnFomo = W.filter((w) => /FOMO/.test(T.identities?.[w.a]?.short || "")).reduce((s, w) => s + w.agg.held, 0);
  $("#readTreasury").innerHTML = takeEl(recentTone,
    `Over the treasury's life, about <b>$${compact(soldAll)}</b> was sold${viaRows.length ? ` ($${compact(sold)} in swaps the wallets signed themselves: ${viaRows.map(([n, v]) => `$${compact(v)} via ${n}`).join(", ")}; $${compact(handoffSold)} more handed to a router or pool that sold it in the same transaction)` : ""},
     <b>$${compact(paidOutUsd)}</b> was paid to <b>${paidOutN}</b> wallets outside the operator's set, <b>$${compact(bridged)}</b> was bridged off the chain${movedOther > 0 ? `, <b>$${compact(movedOther)}</b> moved to unresolved addresses` : ""},
     <b>$${compact(lp)}</b> was seeded as liquidity and <b>$${compact(bought)}</b> spent buying; <b>$${compact(held)}</b> is still held${heldOnFomo ? `, <b>$${compact(heldOnFomo)}</b> of it in a personal FOMO trading wallet` : " in the operator's accounts"}, at today's prices.
     Over the last four weeks in AI: sold <b>${compact(rSold)}</b>, bought <b>${compact(rBought)}</b>, seeded <b>${compact(rLp)}</b>, bridged <b>${compact(rBridged)}</b>${rPaid ? `, paid to outside wallets <b>${compact(rPaid)}</b>` : ""}${rMoved ? `, moved unresolved <b>${compact(rMoved)}</b>` : ""}.
     ${recentTone === "pos" ? "Recently the treasury has put more back into AI and its pools than it has taken out: a flywheel, while it lasts."
       : recentTone === "warn" ? "Recently the treasury has been a net source of supply: selling, bridging or moving fee income out faster than it recycles it. That is the overhang to price in."
       : "Recently the two roughly balance."}
     ${T.unclassified ? `<span class="warnline">${T.unclassified} transactions are still waiting to be classified; the figures grow as they are.</span>` : ""}
     <span class="muted">Every transaction is netted for the wallet across all tokens: sent one token and received another is a sale of what was sent,
     whichever router carried it (Robinhood Wallet's 0x Settler, Rainbow, Relay or the v4 pools directly); sent alongside a positive
     ModifyLiquidity is liquidity seeded; sent to Relay's depository is bridged off the chain. Prices are today's throughout.</span>`);

  /* Where it went: bridge destinations by chain and recipient, and who ended up
     holding the AI on the far side of every sale or hand-off. */
  const wentRows = Object.entries(wentTo).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const bridgesRows = (T.bridges || []).filter((b) => b.deposits > 0);
  const destLabel = (label) => label.startsWith("0x") ? addrCell(label) : label.startsWith("treasury wallet ") ? `<b>treasury</b> ${addrCell(label.slice(16))}` : `<b>${label}</b>`;
  const notes = T.notes || {};
  const treasurySet2 = new Set(W.map((w) => w.a));

  /* Every unit's end state, in one table. AI by where it ended up; the bridged
     dollars by chain and recipient; balances still held. Categories, not
     addresses, so the answer to "what did they do with it" is one screen. */
  const usdAi = (v) => v * px;
  const cat = { soldV4: 0, soldRouters: 0, parked: 0, lp: 0, external: { n: 0, v: 0, addrs: [] }, v3: 0, internalOnly: 0 };
  for (const [label, v] of Object.entries(wentTo)) {
    if (label === "v4 pools") cat.soldV4 += v;
    else if (/Uniswap v3|Algebra/.test(label)) cat.v3 += v;
    else if (label.startsWith("treasury wallet ")) cat.internalOnly += v;
    else if (label.startsWith("0x")) { cat.external.n++; cat.external.v += v; cat.external.addrs.push([label, v]); }
    else cat.soldRouters += v;   // a named router kept the AI at the end of the transaction: sold through it, buyer unresolved
  }
  cat.parked = W.reduce((s, w) => s + (w.ai.balance || 0), 0);
  cat.lp = W.reduce((s, w) => s + (w.aiU.lpAdded || 0), 0);
  const seeded = {};
  for (const w of W) for (const [k, v] of Object.entries(w.aiU.pools || {})) seeded[k] = (seeded[k] || 0) + v;
  const bridgedByChain = {};
  for (const b of bridgesRows) { const key = b.chain; bridgedByChain[key] = (bridgedByChain[key] || 0) + (b.byToken.USDG || 0); }
  /* Who holds the parked AI, by name where the chain or a public record says. */
  const ids = T.identities || {};
  const parkedBy = W.filter((w) => (w.ai.balance || 0) >= 1).sort((a, b) => (b.ai.balance || 0) - (a.ai.balance || 0));
  const parkedNote = parkedBy.length
    ? parkedBy.map((w) => `${compact(w.ai.balance)} in ${ids[w.a] ? `<b>${ids[w.a].short}</b> ${short(w.a)}` : short(w.a)}`).join("; ") + (ids[parkedBy[0].a]?.who ? `. ${ids[parkedBy[0].a].who}: ${ids[parkedBy[0].a].evidence}` : "")
    : "nothing held";
  const termRows = [
    { k: "Sold into v4 pools (AI)", ai: cat.soldV4, usd: usdAi(cat.soldV4), note: "the pool manager held the AI at the end of the transaction; sold on Robinhood Chain's own DEX, through whichever router" },
    { k: "Sent into Uniswap v3 / Algebra pools (AI)", ai: cat.v3, usd: usdAi(cat.v3), note: "sold or seeded on v3-style venues; classified per transaction by their own Swap and Mint events" },
    { k: "Sold through a router, buyer unresolved (AI)", ai: cat.soldRouters, usd: usdAi(cat.soldRouters), note: "a Settler or router still held the AI when the transaction ended" },
    { k: `Paid to ${cat.external.n} external wallets (AI)`, ai: cat.external.v, usd: usdAi(cat.external.v), note: `round amounts to smart accounts and EOAs outside the operator's set; most have since sold or moved it${cat.external.addrs.filter(([a]) => ids[a]).map(([a, v]) => `; ${compact(v)} of it to the ${ids[a].short} ${short(a)}`).join("")}` },
    { k: "Parked in the operator's accounts (AI)", ai: cat.parked, usd: usdAi(cat.parked), note: parkedNote },
    { k: "Seeded as liquidity (AI)", ai: cat.lp, usd: usdAi(cat.lp), note: Object.entries(seeded).map(([k, v]) => `${k} ${compact(v)}`).join(", ") || "none observed" },
    ...Object.entries(bridgedByChain).sort((a, b) => b[1] - a[1]).map(([chain, v]) => ({ k: `Bridged to ${chain} (USDG)`, ai: null, usd: v,
      note: bridgesRows.filter((b) => b.chain === chain).map((b) => b.recipient ? `${b.recipient.slice(0, 6)}…${b.recipient.slice(-4)}${notes[b.recipient] ? ` (${notes[b.recipient].split(";")[0]})` : /^0x/.test(b.recipient) && (treasurySet2.has(b.recipient.toLowerCase()) || b.recipient.toLowerCase() === (S.meta.contracts.platformFeeRecipient || "").toLowerCase()) ? " (the operator's own address on that chain)" : ""} $${compact(b.byToken.USDG || 0)}` : `unresolved $${compact(b.byToken.USDG || 0)}`).join(" · ") })),
  ].filter((r) => (r.ai || 0) > 0 || (r.usd || 0) > 0);
  const termTotal = termRows.reduce((s, r) => s + (r.usd || 0), 0);
  table($("#tTerminals"), [
    { h: "End state", f: (r) => r.k },
    { h: "AI", f: (r) => (r.ai == null ? "—" : compact(r.ai)) },
    { h: "USD today", f: (r) => `$${compact(r.usd)}` },
    { h: "Share", f: (r) => pctLevel(r.usd / Math.max(1, termTotal), 1) },
    { h: "Detail", f: (r) => `<span class="muted">${r.note}</span>` },
  ], termRows);

  $("#treasuryDest").innerHTML =
    (bridgesRows.length ? `<div class="livenote"><b>Bridged off the chain</b> (Relay's index, by destination): ${bridgesRows.map((b) =>
      `${Object.entries(b.byToken).map(([s, v]) => `${s === "USDG" ? "$" : ""}${compact(v)}${s === "USDG" ? "" : " " + s}`).join(" + ")} → <b>${b.chain}</b>${b.recipient ? ` <span class="mono" title="${b.recipient}${notes[b.recipient] ? " — " + notes[b.recipient] : ""}">${b.recipient.slice(0, 6)}…${b.recipient.slice(-4)}</span>` : ""} in ${b.deposits} deposit${b.deposits === 1 ? "" : "s"}`).join(" · ")}.</div>` : "")
    + (wentRows.length ? `<div class="livenote"><b>Where the AI that left ended up</b>, by the address holding it at the end of each transaction: ${wentRows.map(([l, v]) => `${destLabel(l)} <b>${compact(v)}</b>`).join(" · ")}.</div>` : "")
    + (Object.keys(notes).length ? `<div class="livenote"><b>Off-chain hops, identified by hand on the public Solana RPC (13 Sep 2026):</b> ${Object.entries(notes).map(([a, n]) => `<span class="mono" title="${a}">${a.slice(0, 6)}…${a.slice(-4)}</span> ${n}`).join(" · ")}.</div>` : "")
    + (Object.keys(ids).length ? `<div class="livenote"><b>Who the wallets are</b> (Safe owners read from the chain): ${Object.entries(ids).map(([a, d]) => `<span class="mono" title="${a}">${short(a)}</span> <b>${d.short}</b>, ${d.who} <span class="muted">(${d.evidence})</span>`).join(" · ")}.</div>` : "");

  /* The flow diagram. */
  const wallets = W.map((w, i) => ({ id: `w${i}`, label: knownName(w.a) || short(w.a), v: w.agg.inUsd, color: "var(--series-3)", labelRight: false }));
  const usesCol = [
    { id: "held", label: "Still held", v: held, color: "var(--buy)" },
    { id: "lp", label: "Seeded as liquidity", v: lp, color: "var(--series-2)" },
    { id: "bought", label: "Bought", v: bought, color: "var(--buy)" },
    { id: "sold", label: "Sold", v: soldAll, color: "var(--sell)" },
    { id: "paid", label: "Paid to outside wallets", v: paidOut, color: "var(--warning)" },
    { id: "bridged", label: "Bridged off chain", v: bridged, color: "var(--sell)" },
    { id: "moved", label: "Moved, unresolved", v: movedOther, color: "var(--text-muted)" },
  ].filter((n) => n.v > 0);
  const feeIn = usdOf("AI", aiFees) + usdOf("NVDA", nvFees), hookIn = usdOf("AI", aiHook) + usdOf("NVDA", nvHook);
  const sources = [
    { id: "fees", label: "AI trading fees", v: feeIn, color: "var(--buy)" },
    { id: "hook", label: "LP fees collected (Jul 15–27)", v: hookIn, color: "var(--series-3)" },
    { id: "other", label: "Other launches' fees", v: otherUsd, color: "var(--series-2)" },
  ].filter((n) => n.v > 0);
  const feeNode = { id: "fw", label: "Fee wallet", v: sources.reduce((s, n) => s + n.v, 0), color: "var(--text-secondary)", labelRight: true };
  const links = [
    ...sources.map((n) => ({ s: n.id, t: "fw", v: n.v, color: n.color, label: n.label })),
    ...wallets.map((w) => ({ s: "fw", t: w.id, v: w.v, color: "var(--series-3)", label: w.label })),
  ];
  W.forEach((w, i) => {
    const a = { ...w.agg, soldAll: w.agg.sold + w.agg.handoffSold };
    for (const [k, id, color] of [["held", "held", "var(--buy)"], ["lpAdded", "lp", "var(--series-2)"], ["bought", "bought", "var(--buy)"], ["soldAll", "sold", "var(--sell)"], ["paidOut", "paid", "var(--warning)"], ["bridged", "bridged", "var(--sell)"], ["movedOther", "moved", "var(--text-muted)"]]) {
      if (a[k] > 0 && usesCol.some((n) => n.id === id)) links.push({ s: `w${i}`, t: id, v: a[k], color, label: `${wallets[i].label} → ${id}` });
    }
  });
  if (sources.length && wallets.length && usesCol.length) sankey($("#cSankey"), { cols: [sources, [feeNode], wallets, usesCol], links });
  else $("#cSankey").innerHTML = `<p class="muted" style="padding:16px 0">Not enough classified flow to draw yet.</p>`;

  /* Weekly uses of AI. */
  const weekly = (T.weeklyAi || []).slice(-16);
  if (weekly.length > 1) {
    groupedBars($("#cTreasuryWeekly"), weekly.map((d) => ({ ...d, out: (d.sentOn || 0) + (d.paidOut || 0) + (d.bridged || 0) })), {
      xKey: "t", keys: ["sold", "bought", "lpAdded", "out"], colors: ["var(--sell)", "var(--buy)", "var(--series-2)", "var(--text-muted)"], xFmt: dayFmt,
      tip: (d) => `<div class="k">week of ${dayFmt(d.t)}</div><div><span style="color:var(--sell)">●</span> sold ${compact(d.sold)} AI</div>
        <div><span style="color:var(--buy)">●</span> bought ${compact(d.bought)} AI</div><div><span style="color:var(--series-2)">●</span> seeded ${compact(d.lpAdded)} AI</div>
        <div><span style="color:var(--text-muted)">●</span> paid out, moved or bridged ${compact(d.out)} AI${d.paidOut ? ` (${compact(d.paidOut)} to outside wallets)` : ""}</div>`,
    });
  } else $("#cTreasuryWeekly").innerHTML = `<p class="muted" style="padding:16px 0">Weekly uses accrue as transactions are classified.</p>`;

  table($("#tTreasury"), [
    { h: "Wallet", f: (r) => addrCell(r.a) },
    { h: "AI received", f: (r) => compact(r.ai.in || 0) },
    { h: "Held now", f: (r) => compact(r.ai.balance ?? 0) },
    { h: "Sold", f: (r) => `<span class="down">${compact((r.aiU.sold || 0) + r.split.handoffSold)}</span>` },
    { h: "Bought", f: (r) => `<span class="up">${compact(r.aiU.bought || 0)}</span>` },
    { h: "Seeded as LP", f: (r) => compact(r.aiU.lpAdded || 0) },
    { h: "Bridged out", f: (r) => compact(r.aiU.bridged || 0) },
    { h: "To another treasury wallet", f: (r) => compact(r.aiU.internal || 0) },
    { h: "Paid to outside wallets", f: (r) => compact(r.split.paidOut) },
    { h: "Moved, unresolved", f: (r) => compact(r.split.other) },
    { h: "NVDA held", f: (r) => nf(r.nv.balance ?? 0, 0) },
    { h: "USDG held", f: (r) => `$${compact(r.ug.balance ?? 0)}` },
  ], W);
  const pools = {};
  for (const w of W) for (const [k, v] of Object.entries(w.aiU.pools || {})) pools[k] = (pools[k] || 0) + v;
  const poolRows = Object.entries(pools).sort((a, b) => b[1] - a[1]);
  /* Where the paid-out AI went: the treasury wallets' largest AI destinations
     that are neither pools nor other treasury wallets. The next hop, named so a
     reader can look them up; this page stops following there. */
  const onward = {};
  const treasurySet = new Set(W.map((w) => w.a));
  for (const w of W) for (const d of w.ai.topDests || []) {
    if (d.name || treasurySet.has(d.address) || d.address === POOL_MANAGER.toLowerCase()) continue;
    onward[d.address] = (onward[d.address] || 0) + d.v;
  }
  const onwardRows = Object.entries(onward).sort((a, b) => b[1] - a[1]).slice(0, 6);
  $("#tTreasuryPools").innerHTML =
    (poolRows.length
      ? `<div class="livenote">Liquidity seeded, by pool: ${poolRows.map(([k, v]) => `<b>${k}</b> ${compact(v)} AI`).join(" · ")}.</div>`
      : `<div class="livenote">No liquidity seeded by the treasury wallets has been observed.</div>`)
    + (onwardRows.length
      ? `<div class="livenote">Largest outside wallets paid in AI: ${onwardRows.map(([a, v]) => `${addrCell(a)} <b>${compact(v)}</b>`).join(" · ")}. This page does not follow further; a wallet that then sells would show in the tape as a whale sale by that address.</div>`
      : "");

  /* Symbols are attacker-controlled: two tokens calling themselves USDG have paid
     the fee wallet. Anything sharing a name with a known token but not its
     address is shown with its address. */
  const canon = new Map(Object.entries(S.meta.contracts).map(([k, v]) => [v.toLowerCase(), k]));
  const symCount = {};
  for (const t of pf.tokens || []) symCount[t.symbol] = (symCount[t.symbol] || 0) + 1;
  const tokenLabel = (t) => (symCount[t.symbol] > 1 && !canon.has(t.token)) ? `${t.symbol} <span class="muted" title="${t.token}">${t.token.slice(0, 8)}… (not the real one)</span>` : t.symbol;
  table($("#tPlatformFees"), [
    { h: "Token", f: (t) => tokenLabel(t) },
    { h: "Transfers", f: (t) => t.transfers.toLocaleString() },
    { h: "Amount", f: (t) => compact(t.amount) },
    { h: "USD today", f: (t) => (t.usd == null ? `<span class="muted">unpriced</span>` : `$${compact(t.usd)}`) },
  ], (pf.tokens || []).slice(0, 15));

  $("#takeTreasury").innerHTML = takeEl("neu",
    `Read left to right: what reached the fee wallet (the split hook fee from AI trading; the LP fees the operator collected from the
     protocol's own AI/NVDA positions in eighteen <code>collect()</code> calls between 15 and 27 Jul, after which the hook began folding
     them back into liquidity instead; and fees from other launches
     where a price exists), where it was forwarded, and what became of it. <span class="muted">Values at today's prices, so a token that
     was sold at a different price is drawn at today's. Only the four tracked tokens (AI, NVDA, USDG, WETH) are followed past the fee wallet.</span>`);
}

/* ── The platform view ───────────────────────────────────────────────────
   LONG's thesis is to be the liquidity layer for tokenized stocks on Robinhood
   Chain. This measures that thesis directly: how much of the chain's stock-token
   supply and stock-token trading the ecosystem has captured, how big the
   liquidity is and how much of it the protocol owns and compounds, and what it
   would cost to trade size against it. */
const tile = (lbl, val, note, cls = "", extra = "") => `<div class="ctile ${extra}"><div class="lbl">${lbl}</div><div class="val ${cls}">${val}</div><div class="note">${note}</div></div>`;

function renderRwa() {
  const R = S.rwa, D = S.depth;
  const px = marketState().price || 0;
  const pending = `<p class="muted">Built on the slow path; this card fills after the next standard run.</p>`;

  /* ── capture ─────────────────────────────────────────────────────────── */
  if (!R?.tokens?.length) {
    $("#rwaTiles").innerHTML = pending;
    for (const id of ["#readRwa", "#tStocks", "#cStockDex", "#takeStockDex", "#rwaSwaps", "#tSwapShare", "#cSwapShare", "#readSwaps"]) $(id).innerHTML = "";
  } else {
    const T = R.totals;
    const nv = R.tokens.find((t) => t.token === (S.meta.contracts.nvdaToken || "").toLowerCase()) || R.tokens[0];
    const hist = R.history || [];
    const wk = hist.find((h) => h.t >= (hist.at(-1)?.t || 0) - 7 * 86400);
    const dShare = wk && wk !== hist.at(-1) && wk.share != null && T.share != null ? T.share - wk.share : null;
    $("#rwaTiles").innerHTML = `<div class="tiles">
      ${tile("Stock supply captured", T.share == null ? "—" : pctLevel(T.share, 1),
        `$${compact(T.dexUsd + T.vaultUsd)} of $${compact(T.supplyUsd)} across ${T.priced} priced stock tokens${dShare != null ? ` · <span class="${dShare >= 0 ? "up" : "down"}">${pts(dShare)}</span> in 7d` : ""}`, "", "hero")}
      ${tile(`${nv.symbol} captured`, pctLevel(nv.share, 1), `${nf(nv.inDex + nv.inVault, 0)} of ${nf(nv.supply, 0)} ${nv.symbol} on chain · ${pctLevel(nv.dexShare, 1)} in pools, ${pctLevel(nv.vaultShare, 1)} in the vault`)}
      ${tile("In DEX liquidity", `$${compact(T.dexUsd)}`, `stock tokens held by the pool manager, all venues`)}
      ${tile("Stock pools", `${T.poolsLong.toLocaleString()} / ${T.poolsAll.toLocaleString()}`, `pools quoting a stock token carry the LONG hook (${pctLevel(T.poolsAll ? T.poolsLong / T.poolsAll : null, 0)})`)}
    </div>`;
    $("#readRwa").innerHTML = takeEl(T.share >= 0.25 ? "pos" : "neu",
      `<b>${pctLevel(T.share, 1)}</b> of the tokenized-stock value on Robinhood Chain sits inside DEX liquidity or the community vault,
       and <b>${pctLevel(T.poolsAll ? T.poolsLong / T.poolsAll : null, 0)}</b> of the pools that quote a stock token are LONG launches.
       ${nv.symbol} leads: <b>${pctLevel(nv.share, 1)}</b> of every ${nv.symbol} token on the chain is in a pool or the vault.
       <span class="muted">Supply is the token's on-chain <code>totalSupply</code>; the pool-manager balance is DEX inventory on every venue,
       LONG-hooked or not, so the share is an upper bound on LONG's own. Prices from each stock's busiest USDG pool.</span>`);
    const sw = R.swapShare?.perToken || [];
    table($("#tStocks"), [
      { h: "Stock", f: (t) => `<b>${t.symbol}</b>` },
      { h: "On chain", f: (t) => nf(t.supply, 0) },
      { h: "In pools", f: (t) => nf(t.inDex, 0) },
      { h: "In vault", f: (t) => (t.inVault ? nf(t.inVault, 0) : `<span class="muted">0</span>`) },
      { h: "Captured", attrs: () => ({ class: "bar-cell" }), f: (t) => `<div class="fill" style="width:${Math.min(120, t.share * 120)}px"></div><span>${pctLevel(t.share, 1)}</span>` },
      { h: "USD in pools", f: (t) => (t.dexUsd == null ? `<span class="muted">unpriced</span>` : `$${compact(t.dexUsd)}`) },
      { h: "LONG pools / all", f: (t) => `${t.poolsLong.toLocaleString()} / ${t.poolsAll.toLocaleString()}${t.poolsPartial ? "*" : ""}` },
      { h: "Swaps 24h via LONG", f: (t) => { const s = sw.find((x) => x.token === t.token); return s ? `${s.long.toLocaleString()} / ${s.all.toLocaleString()} <span class="muted">${pctLevel(s.share, 0)}</span>` : "—"; } },
    ], R.tokens);
    const nvAddr = Object.keys(R.daily || {})[0];
    const daily = nvAddr ? (R.daily[nvAddr] || []) : [];
    if (daily.length > 1) {
      const sym = R.dailyTracked?.[nvAddr] || "NVDA";
      lineChart($("#cStockDex"), daily.slice(-120), {
        xKey: "t", yKey: "cum", zeroBase: true, area: true, color: "var(--series-3)", xFmt: dayFmt, fmt: (v) => nf(v, 0),
        tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>${nf(d.cum, 0)} ${sym} in DEX liquidity</div><div class="k">${d.net >= 0 ? "+" : ""}${nf(d.net, 1)} that day</div>`,
      });
      const d7 = daily.at(-1).cum - (daily.find((d) => d.t >= daily.at(-1).t - 7 * 86400)?.cum ?? daily[0].cum);
      $("#takeStockDex").innerHTML = takeEl(d7 >= 0 ? "pos" : "warn",
        `<b>${nf(daily.at(-1).cum, 0)} ${sym}</b> sits in DEX liquidity today, <b>${d7 >= 0 ? "+" : ""}${nf(d7, 0)}</b> over the last 7 days.
         Stock tokens enter the pools when traders buy AI-side tokens with them and when liquidity is seeded; they leave when
         traders sell tokens for stock or liquidity is pulled. A rising line is stock being absorbed into the ecosystem.${R.dailyPartial?.[nvAddr] ? " <span class=\"warnline\">Replay still catching up; the series ends early.</span>" : ""}`);
    } else { $("#cStockDex").innerHTML = pending; $("#takeStockDex").innerHTML = ""; }

    /* ── trading share ──────────────────────────────────────────────────── */
    const ss = R.swapShare;
    if (ss) {
      $("#rwaSwaps").innerHTML = `<div class="tiles">
        ${tile("Stock swaps via LONG", pctLevel(ss.share, 1), `${ss.longSwaps.toLocaleString()} of ${ss.stockSwaps.toLocaleString()} swaps touching a stock token, last 24h`, "", "hero")}
        ${tile("Stock swaps, 24h", ss.stockSwaps.toLocaleString(), ss.chainSwaps ? `${pctLevel(ss.stockSwaps / ss.chainSwaps, 1)} of ${ss.chainSwaps.toLocaleString()} swaps on the chain` : "all venues")}
        ${tile("Paired with AI", ss.longSwaps ? pctLevel(ss.aiPairedSwaps / ss.longSwaps, 0) : "—", `of LONG's stock swaps were in an AI pool (${ss.aiPairedSwaps.toLocaleString()})`)}
        ${tile("Elsewhere", (ss.stockSwaps - ss.longSwaps).toLocaleString(), `stock swaps in hookless or other-hook pools${ss.truncated ? " · window cut short by budget" : ""}`)}
      </div>`;
      table($("#tSwapShare"), [
        { h: "Stock", f: (r) => `<b>${r.symbol}</b>` },
        { h: "Swaps 24h", f: (r) => r.all.toLocaleString() },
        { h: "Via LONG", f: (r) => r.long.toLocaleString() },
        { h: "Share", attrs: () => ({ class: "bar-cell" }), f: (r) => `<div class="fill" style="width:${Math.min(120, (r.share || 0) * 120)}px"></div><span>${pctLevel(r.share, 0)}</span>` },
      ], ss.perToken.slice(0, 12));
      const sh = hist.filter((h) => h.swapShare != null);
      if (sh.length > 1) {
        lineChart($("#cSwapShare"), sh.slice(-24 * 14), {
          xKey: "t", yKey: "swapShare", zeroBase: true, area: true, color: "var(--series-3)", xFmt: dayFmt, fmt: (v) => pctLevel(v, 0),
          tip: (h) => `<div class="k">${tsFmt(h.t)}</div><div>${pctLevel(h.swapShare, 1)} of stock swaps via LONG</div><div class="k">${(h.longSwaps || 0).toLocaleString()} of ${(h.stockSwaps || 0).toLocaleString()}, trailing 24h</div>`,
        });
      } else $("#cSwapShare").innerHTML = `<p class="muted" style="padding:12px 0">The share is sampled each slow-path run; a line appears once there are two.</p>`;
      $("#readSwaps").innerHTML = takeEl(ss.share >= 0.5 ? "pos" : "neu",
        `Over the last day, <b>${pctLevel(ss.share, 1)}</b> of every swap on Robinhood Chain that touched a tokenized stock went through a
         LONG pool${ss.longSwaps ? `, and <b>${pctLevel(ss.aiPairedSwaps / ss.longSwaps, 0)}</b> of those were AI pairs` : ""}. The rest traded in
         pools without the hook, which pay LONG nothing. <span class="muted">Counted from every Swap the pool manager emitted in the window,
         matched against every pool that was ever initialised with a stock token on either side.</span>`);
    } else { $("#rwaSwaps").innerHTML = pending; for (const id of ["#tSwapShare", "#cSwapShare", "#readSwaps"]) $(id).innerHTML = ""; }
  }

  /* ── liquidity: size, ownership, compounding ─────────────────────────── */
  if (!D?.pools?.length) {
    for (const id of ["#rwaLiq", "#rwaCompound"]) $(id).innerHTML = pending;
    for (const id of ["#cTvl", "#readLiq", "#cCompound", "#readCompound", "#tImpact", "#readImpact"]) $(id).innerHTML = "";
    return;
  }
  const tvl = D.tvlUsd || 0, own = D.hookTvlUsd ?? null;
  const flagship = D.pools.find((p) => p.poolId === S.meta.contracts.aiNvdaPool) || D.pools[0];
  const H = (D.history || []).map((h) => ({ ...h, tvl: h.tvl ?? (h.bid + h.ask) }));
  const wkRow = H.find((h) => h.t >= (H.at(-1)?.t || 0) - 7 * 86400);
  const tvlD = wkRow && wkRow !== H.at(-1) ? tvl / wkRow.tvl - 1 : null;
  $("#rwaLiq").innerHTML = `<div class="tiles three">
    ${tile("Total liquidity", `$${compact(tvl)}`, `${D.pools.length} indexed venues${tvlD != null ? ` · <span class="${tvlD >= 0 ? "up" : "down"}">${pct(tvlD, 1)}</span> in 7d` : ""}`, "", "hero")}
    ${tile("Protocol-owned", own == null ? "—" : pctLevel(tvl ? own / tvl : null, 1), own == null ? "ladders predate the split" : `$${compact(own)} held by the LONG hook itself`)}
    ${tile("Flagship pool", `$${compact(flagship.tvlUsd)}`, `AI/${flagship.pair}${flagship.hookShare != null ? ` · ${pctLevel(flagship.hookShare, 0)} protocol-owned` : ""}`)}
  </div>`;
  if (H.length > 1) {
    multiLine($("#cTvl"), H.slice(-24 * 14), {
      xKey: "t", series: [{ key: "tvl", color: "var(--series-3)" }, ...(H.some((h) => h.hookTvl != null) ? [{ key: "hookTvl", color: "var(--buy)" }] : [])],
      zeroBase: true, area: true, xFmt: dayFmt, fmt: (v) => `$${compact(v)}`,
      tip: (h) => `<div class="k">${tsFmt(h.t)}</div><div>$${compact(h.tvl)} total liquidity</div>${h.hookTvl != null ? `<div>$${compact(h.hookTvl)} protocol-owned</div>` : ""}<div class="k">${h.venues} venues</div>`,
    });
  } else $("#cTvl").innerHTML = `<p class="muted" style="padding:12px 0">Accrues hourly.</p>`;
  $("#readLiq").innerHTML = takeEl("neu",
    `<b>$${compact(tvl)}</b> of resting liquidity across AI's ${D.pools.length} indexed venues${own != null ? `, of which <b>${pctLevel(tvl ? own / tvl : null, 1)}</b> is the protocol's own position` : ""}.
     Liquidity the protocol owns cannot be pulled by a market maker on a bad day, which is the "sell wall" the founder describes; the rest can leave in one block.
     <span class="muted">Values every position at spot from the ModifyLiquidity tape; the hourly series is total value, not near-spot depth.</span>`);

  const comp = D.compounding || [];
  if (comp.length) {
    const seedDay = comp[0];                                  // the launch seed dwarfs every later day
    const since = comp.slice(1);
    const total = sumOf(since, (r) => r.addUsd), removed = sumOf(since, (r) => r.remUsd);
    const now = Math.floor(Date.now() / 1000), d7 = sumOf(since.filter((r) => r.t >= now - 8 * 86400 && r.t < Math.floor(now / 86400) * 86400), (r) => r.addUsd);
    const days = since.filter((r) => r.addUsd > 0).length;
    $("#rwaCompound").innerHTML = `<div class="tiles three">
      ${tile("Compounded, 7d", `$${compact(d7)}`, "fees folded into the hook's positions, complete days", "", "hero")}
      ${tile("Since launch", `$${compact(total)}`, `over ${days} days, after the $${compact(seedDay.addUsd)} seed on ${dayFmt(seedDay.t)}`)}
      ${tile("Withdrawn", `$${compact(removed)}`, removed > 0 ? "liquidity the hook has removed" : "the hook has removed nothing", removed > 0 ? "warn" : "")}
    </div>`;
    barChart($("#cCompound"), since.slice(-30), {
      xKey: "t", yKey: "addUsd", color: "var(--buy)", xFmt: dayFmt, fmt: (v) => `$${compact(v)}`,
      tip: (r) => `<div class="k">${dayFmt(r.t)}</div><div>$${compact(r.addUsd)} added to the hook's positions</div><div class="k">${compact(r.addAi)} AI + $${compact(r.addQuoteUsd)} of quote${r.remUsd ? ` · $${compact(r.remUsd)} removed` : ""}</div>`,
    });
    $("#readCompound").innerHTML = takeEl(d7 > 0 ? "pos" : "warn",
      `The hook has folded <b>$${compact(total)}</b> of fees back into its own liquidity since launch, <b>$${compact(d7)}</b> of it in the last week.
       This is the mechanism the founder calls liquidity compounding: it does not bid the price up, it thickens the book under it.
       <span class="muted">Each day's liquidity additions by the hook, converted to tokens at today's price; the operator's eighteen
       <code>collect()</code> withdrawals of LP fees between 15 and 27 Jul are on the Treasury tab.</span>`);
  } else { $("#rwaCompound").innerHTML = pending; $("#cCompound").innerHTML = ""; $("#readCompound").innerHTML = ""; }

  /* ── cost to trade ──────────────────────────────────────────────────── */
  const imp = D.impact;
  if (imp) {
    const rows = imp.sell.map((s, i) => ({
      usd: s.usd, sell: s.pct, buy: imp.buy[i]?.pct,
      fSell: flagship.impact?.sell[i]?.pct, fBuy: flagship.impact?.buy[i]?.pct,
    }));
    const cell = (v) => v == null ? "—" : v >= 0.999 ? `<span class="down">book exhausted</span>` : `<span class="${v > 0.2 ? "down" : v > 0.05 ? "" : "up"}">${pctLevel(v, 1)}</span>`;
    table($("#tImpact"), [
      { h: "Order", f: (r) => `<b>$${compact(r.usd, 1)}</b>` },
      { h: `Sell, all ${imp.venues} venues`, f: (r) => cell(r.sell) },
      { h: `Sell, AI/${flagship.pair} only`, f: (r) => cell(r.fSell) },
      { h: `Buy, all venues`, f: (r) => cell(r.buy) },
      { h: `Buy, AI/${flagship.pair} only`, f: (r) => cell(r.fBuy) },
    ], rows);
    const m1 = rows.find((r) => r.usd === 1e6);
    $("#readImpact").innerHTML = takeEl(m1?.sell <= 0.1 ? "pos" : m1?.sell <= 0.25 ? "neu" : "warn",
      `A <b>$1M sale</b> of AI, routed across every venue, would move the price <b>${m1 ? pctLevel(m1.sell, 1) : "—"}</b>;
       in the flagship pool alone <b>${m1?.fSell != null ? pctLevel(m1.fSell, 1) : "—"}</b>. A $1M purchase: <b>${m1 ? pctLevel(m1.buy, 1) : "—"}</b>.
       These are the numbers a desk asks before it asks anything else, and they come from the same ladder as the depth picture.
       <span class="muted">Walked tick by tick from spot at today's price; routed figures assume a perfect split across venues, so they are a floor on real slippage.</span>`);
  } else { $("#tImpact").innerHTML = ""; $("#readImpact").innerHTML = pending; }
  collapseIntros($("#p-investor"));
}

/* ── AI against its platform ─────────────────────────────────────────────
   The launchpad census prices the platform's biggest tokens every slow-path run,
   and now keeps those prices as a series. Whether AI is leading or lagging its own
   cohort is a different question from whether it is up or down. */
function renderPlatform() {
  const host = $("#kpiPlatform");
  if (!host) return;
  const lp = S.launchpad;
  const ph = lp?.priceHistory || [];
  if (ph.length < 2) {
    host.innerHTML = `<p class="muted">Price history for the platform's tokens accrues from the census, one row every few hours; comparisons appear after a day.</p>`;
    for (const id of ["#tPlatform", "#takePlatform"]) { const e = $(id); if (e) e.innerHTML = ""; }
    return;
  }
  const last = ph.at(-1);
  const near = (back) => {
    const target = last.t - back;
    let best = null;
    for (const r of ph) if (Math.abs(r.t - target) <= 4 * 3600 && (!best || Math.abs(r.t - target) < Math.abs(best.t - target))) best = r;
    return best;
  };
  const r24 = near(86400), r7 = near(7 * 86400);
  const aiTok = S.meta.contracts.aiToken;
  const capOf = new Map((lp.top || []).map((t) => [t.token, t.mcapUsd]));
  const rows = Object.entries(last.p).map(([tok, p]) => ({
    tok, p, isAi: tok === aiTok,
    sym: lp.priceSymbols?.[tok] || short(tok),
    mcap: capOf.get(tok) ?? null,
    c24: r24?.p?.[tok] ? p / r24.p[tok] - 1 : null,
    c7: r7?.p?.[tok] ? p / r7.p[tok] - 1 : null,
  })).sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));
  const ai = rows.find((r) => r.isAi);
  const rank = (key) => {
    const xs = rows.filter((r) => r[key] != null).sort((a, b) => b[key] - a[key]);
    const i = xs.findIndex((r) => r.isAi);
    return i >= 0 ? { i: i + 1, n: xs.length } : null;
  };
  const k7 = rank("c7"), k24 = rank("c24");
  host.innerHTML = kpiEl(k7 ? `#${k7.i}` : k24 ? `#${k24.i}` : "—",
    k7 ? `of ${k7.n} over 7 days` : k24 ? `of ${k24.n} over 24h` : "", ai && (ai.c7 ?? ai.c24 ?? 0) >= 0 ? "up" : "down",
    "AI's rank by return among the platform's largest tokens")
    + `<div class="livenote">${rows.length} tokens tracked · prices from each token's busiest pool, sampled ${ph.length} times since ${dayFmt(ph[0].t)}</div>`;
  const chg = (x) => (x == null ? "—" : `<span class="${x >= 0 ? "up" : "down"}">${pctOrMult(x, 1)}</span>`);
  table($("#tPlatform"), [
    { h: "Token", f: (r) => (r.isAi ? `<b>${r.sym}</b>` : r.sym) },
    { h: "Nominal cap", f: (r) => (r.mcap == null ? "—" : `$${compact(r.mcap)}`) },
    { h: "24h", f: (r) => chg(r.c24) },
    { h: "7d", f: (r) => chg(r.c7) },
  ], rows);
  const med = (key) => { const xs = rows.map((r) => r[key]).filter((x) => x != null).sort((a, b) => a - b); return xs.length ? xs[Math.floor(xs.length / 2)] : null; };
  const m7 = med("c7"), m24 = med("c24");
  $("#takePlatform").innerHTML = takeEl(!ai ? "neu" : (ai.c7 ?? ai.c24 ?? 0) >= (m7 ?? m24 ?? 0) ? "pos" : "warn",
    !ai ? "AI is not among the tracked tokens in the latest census row."
      : `${ai.c7 != null ? `Over 7 days AI is <b>${pctOrMult(ai.c7, 1)}</b> against a median of <b>${pct(m7, 1)}</b> across the platform's largest tokens, ranking <b>#${k7.i} of ${k7.n}</b>.` : ai.c24 != null ? `Over 24 hours AI is <b>${pct(ai.c24, 1)}</b> against a platform median of <b>${pct(m24, 1)}</b> (#${k24.i} of ${k24.n}); a week of history is still accruing.` : "Not enough history yet."}
         ${ai.c7 != null && m7 != null ? (ai.c7 > m7 ? "AI is leading its own platform, which is what a hub should do when the ecosystem is bid; when it lags, the money is going to the launches rather than the base pair." : "AI is lagging its own platform: the launches are being bid ahead of the base pair they settle against, which is worth knowing before attributing a move to the hub thesis.") : ""}
         <span class="muted">Every price is a pool print on a thin book, so single-token moves can be one trade. The median is the robust read.</span>`);
}

/**
 * What moved since this browser last looked.
 *
 * The first question anyone opening a monitor has is "what changed", and answering
 * it previously meant reading eight cards and remembering the old numbers. Someone
 * checking on a phone will not do that, so the page did not really support the
 * decision it was built for.
 *
 * Deliberately per-browser and never sent anywhere: the snapshot is a handful of
 * numbers in localStorage. Every access is wrapped, because localStorage throws
 * outright in some contexts (private windows, blocked site data, thumbnailing) and
 * a convenience must never be able to blank the page. No snapshot, a snapshot from
 * this hour, or storage that refuses to answer all render nothing at all -- the
 * strip appears only when it has something to say.
 */
const SINCE_KEY = "ainvda.lastSeen.v2";   // v2: two dial scores and a holder count instead of one word
const MIN_GAP_MIN = 30;

function readSnapshot() {
  try { return JSON.parse(localStorage.getItem(SINCE_KEY) || "null"); } catch { return null; }
}
function writeSnapshot(snap) {
  try { localStorage.setItem(SINCE_KEY, JSON.stringify(snap)); } catch { /* nothing to do */ }
}

function renderSinceLast(now) {
  const host = $("#sinceLast");
  if (!host) return;
  const prev = readSnapshot();
  writeSnapshot(now);                      // always record, even when nothing is shown
  if (!prev || !prev.at) { host.hidden = true; return; }

  const mins = Math.round((now.at - prev.at) / 60);
  if (mins < MIN_GAP_MIN) { host.hidden = true; return; }

  /* Only movement worth a sentence. A threshold per field, because a 0.3% drift in
     the fee run-rate is noise and a 0.3 move in the rating score is not. */
  const lines = [];
  const rel = (label, a, b, min, fmtv) => {
    if (a == null || b == null || !isFinite(a) || !isFinite(b) || a === 0) return;
    const d = b / a - 1;
    if (Math.abs(d) < min) return;
    lines.push(`<span class="${d >= 0 ? "up" : "down"}">${pct(d, 0)}</span> ${label}, now <b>${fmtv(b)}</b>`);
  };
  const abs = (label, a, b, min, fmtv) => {
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) return;
    const d = b - a;
    if (Math.abs(d) < min) return;
    lines.push(`<span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}pt</span> ${label}, now <b>${fmtv(b)}</b>`);
  };

  rel("AI in dollars", prev.price, now.price, 0.02, (v) => "$" + v.toFixed(4));
  rel("fee run-rate", prev.feeAnnual, now.feeAnnual, 0.05, (v) => compact(v) + " AI/yr");
  abs("toll leakage", prev.leak, now.leak, 0.02, (v) => pctLevel(v, 1));
  abs("cross-routing", prev.kappa, now.kappa, 0.02, (v) => pctLevel(v, 1));
  rel("NVDA in the vault", prev.nvda, now.nvda, 0.01, (v) => nf(v, 1) + " NVDA");
  rel("holders with 100K+ AI", prev.holders100k, now.holders100k, 0.01, (v) => v.toLocaleString());
  if (prev.word && now.word && prev.word !== now.word) {
    lines.push(`the reading moved from <b>${prev.word}</b> to <b>${now.word}</b>`);
  } else {
    for (const [key, label] of [["structure", "the Structure dial"], ["demand", "the Demand dial"]]) {
      if (prev[key] == null || now[key] == null || Math.abs(now[key] - prev[key]) < 0.15) continue;
      const d = now[key] - prev[key];
      lines.push(`<span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${d.toFixed(2)}</span> on ${label}, now <b>${now[key] >= 0 ? "+" : ""}${now[key].toFixed(2)}</b>`);
    }
  }

  if (!lines.length) { host.hidden = true; return; }
  host.hidden = false;
  host.innerHTML = `<button class="dismiss" type="button">hide</button>
    <div class="hd">Since you last looked, ${fmtAge(mins)} ago</div>
    <ul>${lines.map((l) => "<li>" + l + "</li>").join("")}</ul>`;
  host.querySelector(".dismiss")?.addEventListener("click", () => { host.hidden = true; });
}

/**
 * Liquidity depth, and the imbalance a holder can act on.
 *
 * The imbalance is deliberately the headline and the chart is the evidence: the
 * question is "which way is cheaper to push", and a wall of bars answers that only
 * after you have squinted at it. Signed with pctOrMult-style care -- buyside and
 * sellside are named rather than left as a sign, because "+$1.1M" tells you nothing
 * about direction unless you already know the convention.
 */
/**
 * 1. Platform adoption of AI.
 *
 * Share of new LONG pools that put AI on one side, weekly and daily. The stock
 * version of this (card 6b) can only rise, so it cannot tell anyone that adoption
 * halved; the flow can, and did.
 */
/**
 * 1. Launch cadence, and how much of it is still alive.
 *
 * The bar is tokens created that day; the lit segment is the ones whose pool traded
 * in the ranking window. Both segments are counts of tokens, which is what makes a
 * stack legitimate here -- a second axis carrying market cap would not be, and the
 * cap figures live beside the chart as platform-wide totals instead, because a
 * per-day cap can only be built from the 300 priced tokens and most days hold one
 * or two of those.
 */
/**
 * 1. Tokens launched per day.
 *
 * A census, not a sample: every pool carrying the LONG hook is a launchpad token and
 * the hook address is in the pool’s own Initialize log, so the cadence covers the
 * whole population. The cap figures beside it do not -- they come from the ~300
 * priced tokens -- and are labelled as the ceiling they are.
 */
function renderAdoption() {
  const rows = completeDays(S.launchpad?.anchorFlow || []);
  if (rows.length < 3) {
    $("#kpiAdopt").innerHTML = `<p class="muted">Anchor adoption not measured yet. It needs the LONG census, which builds over the first few runs.</p>`;
    for (const id of ["#cAdopt", "#takeAdopt"]) { const e = $(id); if (e) e.innerHTML = ""; }
    return;
  }

  /* Weekly, not daily, for the headline. Pool creation is bursty enough that a
     single day swings the ratio by a factor of five, and a number that moves that
     much on its own is not a level anyone can act on. */
  const ai7 = trailing(rows, 7, (d) => d.ai), all7 = trailing(rows, 7, (d) => d.all);
  const ai7p = trailing(rows, 7, (d) => d.ai, 7), all7p = trailing(rows, 7, (d) => d.all, 7);
  const share = all7 ? ai7 / all7 : null;
  const sharePrior = all7p ? ai7p / all7p : null;
  const rel = share != null && sharePrior ? share / sharePrior - 1 : null;

  /* No percentile on this one, deliberately.

     Ranking today against the full sixty days put the latest day at the 89th
     percentile while the week was down 59%, because most of those days predate
     the platform anchoring anything in AI at all. That is the changing-composition
     trap the capture and leakage series were already rebuilt to avoid: a
     percentile is only meaningful over a period that measures the same thing
     throughout, and the early history here does not. What the data does support
     is two windows of different length, which is what it gets. */
  const ai3 = trailing(rows, 3, (d) => d.ai), all3 = trailing(rows, 3, (d) => d.all);
  const ai3p = trailing(rows, 3, (d) => d.ai, 3), all3p = trailing(rows, 3, (d) => d.all, 3);
  const short = all3 ? ai3 / all3 : null, shortPrior = all3p ? ai3p / all3p : null;
  const shortRel = short != null && shortPrior ? short / shortPrior - 1 : null;

  $("#kpiAdopt").innerHTML = kpiEl(pctLevel(share, 1),
    rel == null ? "" : `${pct(rel, 0)} vs prior week`, (rel ?? 0) >= 0 ? "up" : "down",
    "of new LONG pools anchored in AI, last 7 complete days")
    + `<div class="livenote"><b>${ai7.toLocaleString()}</b> AI-anchored pools created in those 7 days,
       out of <b>${all7.toLocaleString()}</b>
       ${short == null ? "" : `\u00b7 last 3 days <b>${pctLevel(short, 1)}</b>${shortRel == null ? "" :
          `, ${shortRel >= 0 ? "up" : "down"} ${pctLevel(Math.abs(shortRel), 0)} on the 3 before`}`}</div>`;

  lineChart($("#cAdopt"), rows.slice(-45), {
    xKey: "t", yKey: "share", color: "var(--series-1)", area: true, zeroBase: true, xFmt: dayFmt,
    fmt: (v) => pctLevel(v, 0),
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>${pctLevel(d.share, 1)} of new pools</div>
      <div class="k">${d.ai.toLocaleString()} of ${d.all.toLocaleString()}</div>`,
  });

  /* The trough that matters is the one AFTER the peak. Taking the minimum over a
     fixed trailing window found 23 August, before the platform had adopted AI at
     all, and printed "peaked 4 Sep, bottomed 23 Aug, climbing since" -- a story
     whose bottom precedes its top. */
  const peakIdx = rows.reduce((bi, r, i) => (r.share > rows[bi].share ? i : bi), 0);
  const peak = rows[peakIdx];
  const after = rows.slice(peakIdx + 1);
  const trough = after.length ? after.reduce((a, b) => (b.share < a.share ? b : a)) : null;
  const last = rows.at(-1);
  const offLow = trough && trough.share > 0 ? last.share / trough.share - 1 : null;

  /* The week is down and the last three days are up, and both are true. Leading
     with either alone would be a call rather than a reading. */
  $("#takeAdopt").innerHTML = takeEl(
    (rel ?? 0) >= 0 ? "pos" : (shortRel ?? 0) > 0 ? "neu" : "warn",
    `<b>${pctLevel(share, 1)}</b> of the pools LONG created in the last 7 complete days put AI on one side,
     against <b>${pctLevel(sharePrior, 1)}</b> the week before${rel == null ? "" : ` \u2014 <b>${pct(rel, 0)}</b>`}.
     That is <b>${ai7.toLocaleString()}</b> new pools, each needing an AI side seeded before it can trade.
     ${trough == null ? "" : `The weekly number is still carrying the collapse: adoption peaked at
       <b>${pctLevel(peak.share, 0)}</b> on ${dayFmt(peak.t)}, fell to <b>${pctLevel(trough.share, 1)}</b> by
       ${dayFmt(trough.t)}, and has recovered to <b>${pctLevel(last.share, 1)}</b>${offLow == null ? "" :
       `, ${(offLow + 1).toFixed(1)}\u00d7 off that low`}. The week is down because the comparison week contains
       the peak; the last three days are up. Both are the same series.`}
     <span class="muted">Read the direction over a week and the turn over three days, never the level on one.
       The anchor rank beside this is the cumulative standing this flow feeds, and it will keep reporting third
       place whatever this does.</span>`);
}

/**
 * 2. Near-spot depth imbalance.
 *
 * The same book as the depth card above, read at the distance a trade reaches.
 */
function renderNearDepth() {
  const d = S.depth;
  const near = d?.near || [];
  if (!near.length) {
    $("#kpiNear").innerHTML = `<p class="muted">Near-spot depth not measured yet.</p>`;
    for (const id of ["#cNear", "#takeNear"]) { const e = $(id); if (e) e.innerHTML = ""; }
    return;
  }
  const tight = near[0];
  const bidShare = tight.bidUsd + tight.askUsd > 0 ? tight.bidUsd / (tight.bidUsd + tight.askUsd) : null;
  const wide = d.bidUsd + d.askUsd > 0 ? d.bidUsd / (d.bidUsd + d.askUsd) : null;

  /* Percentile against its own history, once there is one. Four hourly points is
     not a distribution, and saying so is better than ranking against it. */
  const hist = (d.history || []).filter((h) => h.nearBid != null && h.nearBid + h.nearAsk > 0)
    .map((h) => h.nearBid / (h.nearBid + h.nearAsk));
  const p = percentileOf(hist, bidShare, 12);

  /* A band, not a verdict. Anything inside a couple of points of even is even --
     the two sides are within a rounding error of each other and calling that
     direction would be reading noise. */
  const tone = bidShare == null ? "" : bidShare >= 0.55 ? "up" : bidShare <= 0.45 ? "down" : "";
  const word = bidShare == null ? "—" : bidShare >= 0.55 ? "bid-heavy" : bidShare <= 0.45 ? "offered" : "level";

  $("#kpiNear").innerHTML = kpiEl(pctLevel(bidShare, 1), word, tone,
    `of depth within ±${(tight.pct * 100).toFixed(0)}% of spot is bids`)
    + `<div class="livenote"><b>$${compact(tight.askUsd)}</b> of asks to lift AI ${(tight.pct * 100).toFixed(0)}%
       · <b>$${compact(tight.bidUsd)}</b> of bids to push it down the same
       ${p == null
         ? `· <span class="muted">${hist.length} hour(s) of history, too few to rank this against; it accrues</span>`
         : `· ranks <b>${pctLevel(p, 0)}</b> against its own ${hist.length} hours`}</div>`;

  /* The profile is the point: one bar per band, showing where the skew appears.
     A single number for "the imbalance" hides that it is entirely a wide-window
     effect, which is the thing a reader most needs to know. */
  const prof = near.map((n) => ({
    label: `±${(n.pct * 100).toFixed(0)}%`,
    share: n.bidUsd + n.askUsd > 0 ? n.bidUsd / (n.bidUsd + n.askUsd) : 0,
    bid: n.bidUsd, ask: n.askUsd,
  }));
  prof.push({ label: `±${(d.windowPct * 100).toFixed(0)}%`, share: wide ?? 0, bid: d.bidUsd, ask: d.askUsd });
  barChart($("#cNear"), prof, {
    xKey: "label", yKey: "share", color: "var(--buy)", xFmt: (v) => v,
    fmt: (v) => pctLevel(v, 0),
    tip: (x) => `<div class="k">within ${x.label} of spot</div>
      <div>${pctLevel(x.share, 1)} bids</div>
      <div class="k">$${compact(x.bid)} bid · $${compact(x.ask)} ask</div>`,
  });

  const cap = marketState().mcap ?? null;
  $("#takeNear").innerHTML = takeEl(tone === "up" ? "pos" : tone === "down" ? "warn" : "neu",
    `Within ±${(tight.pct * 100).toFixed(0)}% of spot the book is <b>${word}</b> at
     <b>${pctLevel(bidShare, 1)}</b> bids: <b>$${compact(tight.askUsd)}</b> standing above the price and
     <b>$${compact(tight.bidUsd)}</b> below it.
     ${wide == null ? "" : `Across the full ±${(d.windowPct * 100).toFixed(0)}% window the same book reads
       <b>${pctLevel(wide, 1)}</b> bids, so the buyside imbalance the headline reports is
       ${wide - (bidShare ?? 0) > 0.04
         ? `<b>almost entirely liquidity parked out of range</b> rather than money standing under the price`
         : `broadly the same story at both distances`}.`}
     <span class="muted">The size is the part worth sitting with${cap ? `: about $${compact(tight.askUsd)} of buying
     moves a $${compact(cap)} market cap by ${(tight.pct * 100).toFixed(0)}%` : ""}. A cap that large resting on a
     book that thin is a nominal valuation in the same sense the launchpad tokens' are, and it cuts both ways:
     the same thinness that lets a modest bid run the price lets a modest sale retrace it. Positions can also be
     pulled in a block, so treat this as the shape of the book now, not support that will be there later.</span>`);
}

function renderDepth() {
  const d = S.depth;
  if (!d || !d.pools?.length) {
    for (const id of ["#cDepth", "#tDepth"]) $(id).innerHTML = "";
    return;
  }
  /* The near-spot card carries the headline; this draws the whole book and the
     per-venue table under it. */
  depthChart($("#cDepth"), d.book, {
    spot: d.pools[0]?.spotUsd ?? d.aiUsd,
    fmt: (v) => `$${compact(v, 0)}`,
    xFmt: (v) => `$${Number(v).toPrecision(3)}`,
    tip: (r) => `<div class="k">$${Number(r.p).toPrecision(4)} per AI</div>
      ${r.bid > 0 ? `<div><span style="color:var(--buy)">\u25cf</span> bids $${compact(r.bid)}</div>` : ""}
      ${r.ask > 0 ? `<div><span style="color:var(--sell)">\u25cf</span> asks $${compact(r.ask)}</div>` : ""}`,
  });

  table($("#tDepth"), [
    { h: "Venue", f: (p) => `AI / ${p.pair || "?"}` },
    { h: "Fee", f: (p) => (p.fee > 100000 ? "dynamic" : pctLevel((p.fee || 0) / 1e6, 2)) },
    { h: "Depth TVL", f: (p) => `$${compact(p.tvlUsd)}` },
    { h: "Bids", f: (p) => `$${compact(p.bidUsd)}` },
    { h: "Asks", f: (p) => `$${compact(p.askUsd)}` },
    { h: "Lean", f: (p) => {
        const t = p.bidUsd + p.askUsd;
        if (!t) return "\u2014";
        const s = (p.bidUsd - p.askUsd) / t;
        return `<span class="band ${s >= 0 ? "bull" : "bear"}">${s >= 0 ? "bid" : "ask"} ${pctLevel(Math.abs(s), 0)}</span>`;
      } },
  ], d.pools);
}

/**
 * The launchpad's output by size.
 *
 * Deliberately leads with the backed count rather than the raw one. A launchpad
 * that has produced five tokens above a million dollars sounds like a platform;
 * that four of those five are valued at thirty to ninety times the money standing
 * behind them is the part that decides whether the first sentence means anything.
 * Reporting the raw count alone would be true and misleading, which is the failure
 * mode this whole site has spent its time removing.
 */
/**
 * Launch cadence: how fast the platform is producing tokens, and whether that rate
 * is holding. The daily bars answer "is it still going"; the cumulative line
 * answers "was this infrastructure or an event", which is the shape a platform
 * thesis actually rests on.
 */
/**
 * Where AI sits among the anchors other tokens choose.
 *
 * The strongest evidence for the hub thesis on this whole site, and it arrived by
 * accident: censusing the launchpad meant counting how often each token is used as
 * the other side of a pool, and AI came out sixth of everything on the platform.
 * Every token above it is either a quote asset or a real-world asset. AI is the
 * only LAUNCHED token that other launches quote themselves in, which is what
 * "becoming infrastructure" would look like if it were happening.
 *
 * Reported as a rank with the field visible rather than as a bare count, because
 * 1,083 pools means nothing without knowing that ETH has 3,040 and GOOGL has 308.
 */
function renderAnchorRank() {
  const lp = S.launchpad;
  const me = lp?.aiAnchorRank;
  if (!lp?.anchorRank?.length || !me) {
    $("#kpiAnchor").innerHTML = `<p class="muted">Anchor census not measured yet.</p>`;
    for (const id of ["#cAnchor", "#takeAnchor"]) { const e = $(id); if (e) e.innerHTML = ""; }
    return;
  }
  const rows = lp.anchorRank.slice(0, 12);
  const above = rows.filter((r) => r.rank < me.rank);
  const rwaAbove = above.filter((r) => !/^(ETH|WETH|USDG)$/i.test(r.symbol || "")).length;

  $("#kpiAnchor").innerHTML = kpiEl(`#${me.rank}`,
    `of ${(lp.anchorCount ?? lp.anchorRank.length).toLocaleString()} anchors`, me.rank <= 10 ? "up" : "down",
    `${me.pools.toLocaleString()} pools quote themselves in AI`)
    + `<div class="livenote">Everything ranked above it is a quote asset or a real-world asset
       \u00b7 <b>AI is the only launched token above ${rows[rows.length - 1]?.pools?.toLocaleString() ?? "the rest"} pools</b>
       \u00b7 counted across ${lp.poolsWithHook?.toLocaleString() ?? "all"} LONG pools</div>`;

  barChart($("#cAnchor"), rows.map((r) => ({ label: r.symbol || r.token.slice(0, 6), n: r.pools, isAi: r.token === S.meta?.contracts?.aiToken })), {
    xKey: "label", yKey: "n", xFmt: (v) => v, fmt: (v) => compact(v, 0),
    color: "var(--series-2)",
    tip: (d) => `<div class="k">${d.label}</div><div>${d.n.toLocaleString()} pools anchored to it</div>`,
  });

  /* Built here rather than inline: "1 real-world assets and 1 quote assets" was
     the first version, and bad grammar in a number-heavy page reads as carelessness
     about the numbers too. */
  const countOf = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [];
  if (rwaAbove) parts.push(countOf(rwaAbove, "real-world asset"));
  if (above.length - rwaAbove) parts.push(countOf(above.length - rwaAbove, "quote asset"));
  const aboveDesc = above.length
    ? `The ${above.length} above it ${above.length === 1 ? "is" : "are"} ${parts.join(" and ")}`
    : "Nothing is used as an anchor more often";
  $("#takeAnchor").innerHTML = takeEl(me.rank <= 10 ? "pos" : "warn",
    `AI is the <b>#${me.rank}</b> most-used anchor on the platform, with <b>${me.pools.toLocaleString()}</b> pools quoting themselves in it.
     ${aboveDesc} — so <b>AI is the only launched token anywhere near the top</b>.
     That is the hub thesis stated as a count rather than inferred from routing: other tokens are choosing AI as
     a base pair, which is a slower and more durable signal than volume passing through it.
     <span class="muted">A pool existing is not a pool trading. This counts adoption, not activity, and the two
     can diverge \u2014 read it beside cross-routing above, which counts the volume.</span>`);
}

function renderLaunches() {
  const r = S.launchpad;
  const rows = completeDays(r?.launchesByDay || []);
  if (!rows.length) {
    $("#kpiLaunches").innerHTML = `<p class="muted">Launch history not measured yet.</p>`;
    for (const id of ["#cLaunches", "#cLaunchCum", "#takeLaunches"]) { const e = $(id); if (e) e.innerHTML = ""; }
    return;
  }
  /* A partial census is the dangerous state for this tab specifically. Every other
     figure on the site degrades into "unknown" when its data is short; a launch
     count degrades into a smaller number that looks exactly like a real one. The
     scan resumes from a cursor across runs, so until it has reached genesis every
     total here is a floor, and it has to say so before it says anything else. */
  const partial = !!r.censusPartial;
  const last7 = rows.slice(-7).reduce((s, d) => s + d.launched, 0);
  const prior7 = rows.slice(-14, -7).reduce((s, d) => s + d.launched, 0);
  const trend = prior7 > 0 ? last7 / prior7 - 1 : null;
  const total = rows.at(-1).cumulative;

  $("#kpiLaunches").innerHTML = kpiEl(`${last7}`,
    trend == null ? "" : `${pct(trend, 0)} wk/wk`, (trend ?? 0) >= 0 ? "up" : "down",
    "tokens launched in the last 7 complete days")
    + (partial
      ? `<div class="warnline">The census has not finished walking back to genesis, so every count on this tab is a <b>floor</b> rather than a total. It resumes from a cursor each run and settles after a few.</div>`
      : "")
    + `<div class="livenote"><b>${total.toLocaleString()}</b> launched across <b>${rows.length}</b> days · busiest day <b>${maxOf(rows.map((d) => d.launched))}</b> · counted from every LONG-hook pool, not only the ones valued below</div>`;

  barChart($("#cLaunches"), rows.slice(-45), {
    xKey: "t", yKey: "launched", color: "var(--series-3)", xFmt: dayFmt,
    fmt: (v) => v.toFixed(0),
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>${d.launched} launched</div>
      <div class="k">${d.cumulative.toLocaleString()} cumulative</div>`,
  });
  lineChart($("#cLaunchCum"), rows, {
    xKey: "t", yKey: "cumulative", color: "var(--series-1)", area: true, zeroBase: true, xFmt: dayFmt,
    fmt: (v) => v.toFixed(0),
    tip: (d) => `<div class="k">${dayFmt(d.t)}</div><div>${d.cumulative.toLocaleString()} launched to date</div>`,
  });

  /* The honest read of a launch count is not the count. A platform that mints a
     thousand tokens nobody trades has produced a number, not an ecosystem, so the
     cadence is reported next to how many of them reached any size. */
  const priced = r.priced ?? 0, big = r.runners ?? 0;
  $("#takeLaunches").innerHTML = takeEl((trend ?? 0) >= 0 ? "pos" : "warn",
    `<b>${last7}</b> tokens launched in the last 7 complete days${trend == null ? "" :
      `, ${trend >= 0 ? "up" : "down"} <b>${pctLevel(Math.abs(trend), 0)}</b> on the week before`},
     bringing the total to <b>${total.toLocaleString()}</b>.
     <span class="muted">Launch count on its own says how busy the mint is, not whether anything survives it:
     of the ${priced} tokens currently priced, ${big} carry a nominal cap above $${compact(r.runnerFloor || 1e6, 0)}.
     Read this chart with the size distribution below.</span>${(r.unlistedAnchors || []).length ? `<br><b>Undercounting.</b> ${r.unlistedAnchors.length} token(s) are used as an anchor by dozens of pools but are absent from the real-world-asset list (${r.unlistedAnchors.slice(0, 4).map((u) => (u.symbol || u.token.slice(0, 8)) + " " + u.pools).join(", ")}). Launches against them are not counted until that list is updated, so every figure here is a floor.` : ""}`);
}

function renderRunners() {
  const r = S.launchpad;
  if (!r || !r.buckets?.length) {
    $("#kpiRunners").innerHTML = `<p class="muted">Launchpad token census not measured yet.</p>`;
    for (const id of ["#cRunners", "#tRunners", "#takeRunners"]) { const e = $(id); if (e) e.innerHTML = ""; }
    return;
  }

  /* The headline is the count of tokens above the floor.

     It used to be the count "backed within 20x", a gate nothing on this platform
     passes, so the tile read "0 of 20 above $1 million" while the table beneath it
     listed twenty such tokens. A figure that is structurally zero belongs nowhere
     near the top of a card. Backing is still reported, as the distribution it is. */
  /* The 24h change is only sometimes a measurement.

     Pricing a token costs two calls, so only the most active few hundred get priced,
     and the runner count is drawn from that rationed set. The first reading of this
     showed "-4 in 24h" while the set itself grew from 213 tokens to 300: four tokens
     had not fallen below a million, a different population had been measured. A delta
     across two populations is not a delta, so it is shown only when the set is the
     same size to within 5% and the comparison point is genuinely a day old. */
  const last = (r.history || []).at(-1);
  const dayAgo = (r.history || []).find((h) => h.t >= (last?.t ?? 0) - 86400 && h.t <= (last?.t ?? 0) - 20 * 3600);
  const comparable = dayAgo && dayAgo.runners != null && dayAgo.priced > 0 &&
    Math.abs(dayAgo.priced - r.priced) / r.priced <= 0.05;
  const rDelta = comparable ? r.runners - dayAgo.runners : null;
  $("#kpiRunners").innerHTML = kpiEl(`${r.runners}`,
    rDelta == null ? "" : `${rDelta >= 0 ? "+" : ""}${rDelta} in 24h`, (rDelta ?? 0) >= 0 ? "up" : "down",
    `launchpad tokens whose nominal cap is above $${compact(r.runnerFloor, 0)}`)
    + `<div class="livenote"><b>${r.priced}</b> LONG-hook tokens priced
       \u00b7 combined nominal cap <b>$${compact((r.history?.at(-1)?.totalMcapUsd) ?? 0)}</b>
       ${r.capToBackingMedian == null ? "" : `\u00b7 median cap-to-backing among the ${r.runners}:
          <b>${r.capToBackingMedian}\u00d7</b>, with <b>${r.thinRunners}</b> at ${r.thinThreshold}\u00d7 or worse`}</div>`;

  /* A list, not a bar chart.

     The distribution runs from 246 tokens in the smallest bucket to 1 in the
     largest, and on a linear axis a bar of 4 beside a bar of 246 is 1.6% of the
     height -- indistinguishable from empty. The chart was read, reasonably, as
     saying one coin was above ten million when five are. A log axis would fix the
     geometry and still make the reader do arithmetic to recover a count; five
     labelled numbers do not need a chart at all. */
  $("#cRunners").innerHTML = `<div class="bucketrow">${r.buckets.map((b) => `<div class="bucket${b.count ? "" : " empty"}"><div class="bn">${b.count}</div><div class="bl">${b.label}</div></div>`).join("")}</div>`;

  table($("#tRunners"), [
    { h: "Token", f: (t) => t.symbol || `<span class="muted" title="${t.token}">unnamed</span>` },
    { h: "Nominal cap", f: (t) => `$${compact(t.mcapUsd)}` },
    { h: "Liquidity \u00b110%", f: (t) => (t.backingUsd == null ? "\u2014" : `$${compact(t.backingUsd)}`) },
    { h: "Cap / backing", f: (t) => {
        if (t.capToBacking == null) return "\u2014";
        const hot = r.thinThreshold != null && t.capToBacking >= r.thinThreshold;
        return `<span class="band ${hot ? "bear" : "bull"}">${t.capToBacking}\u00d7</span>`;
      } },
    { h: "Swaps", f: (t) => (t.swaps || 0).toLocaleString() },
  ], r.top);

  /* The honest headline of the distribution is the floor of it: four in five priced
     tokens never clear $100k. */
  const smallB = r.buckets.find((b) => b.key === "dust");
  const share = r.priced ? (smallB?.count ?? 0) / r.priced : 0;
  $("#takeRunners").innerHTML = takeEl(r.runners >= 10 ? "pos" : "warn",
    `The launchpad has <b>${r.priced}</b> priced tokens, <b>${pctLevel(share, 0)}</b> of them under
     $100k, and <b>${r.runners}</b> above $1M on nominal cap.
     ${r.capToBackingMedian == null ? "" : `Across those ${r.runners}, the median token carries
       <b>${r.capToBackingMedian}\u00d7</b> more nominal cap than the liquidity standing within 10% of its
       price, and <b>${r.thinRunners}</b> are at ${r.thinThreshold}\u00d7 or worse. Read those caps as prices a
       thin book printed, not as money that could leave.`}
     <span class="muted">Three things to hold in mind. Backing is measured in each token\u2019s busiest pool only,
     so a token trading across several pools is understated and its ratio overstated. This counts tokens that
     still trade, so launches that died are absent and the census flatters the present. And the population is
     overwhelmingly memecoins: the tokenised real-world assets here should track their underlying rather than
     their pool, which makes the cap-to-backing ratio the wrong lens for those specifically.</span>`);
}

function renderVerdict(read, net7, net7p, feeAnnual, feeTrend, kappa, sc, capNow, capPrior, removed, leak, kappaHist = []) {
  const b = S.burns;
  const kMed = (() => {
    const xs = (kappaHist || []).filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
    return xs.length >= 10 ? xs[Math.floor(xs.length / 2)] : null;
  })();
  /* The lead is the cockpit's reading, so the summary can never say something the
     dials above it do not. It used to count three coin-flips of its own. */
  const tone = read.tone === "pos" ? "pos" : read.tone === "neg" ? "neg" : "";
  const lead = read.title + ".";

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
      ? `<b>Right now that has flipped:</b> the last ${fmtAge(L.minutes)} show net
         ${L.net >= 0 ? "buying" : "selling"} of <b>${compact(Math.abs(L.net))} AI</b>, against the week's
         net ${net7 >= 0 ? "buying" : "selling"}. ${spanWord(L.minutes)} is not a trend against
         seven days, but a turn shows here first.`
      : `The last ${fmtAge(L.minutes)} agree with the week: net ${L.net >= 0 ? "buying" : "selling"} of
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
        hub conversion measures <b>${pctLevel(kappa, 1)}</b>${kMed == null ? "" :
          `, ${kappa >= kMed ? "above" : "below"} its own ${pctLevel(kMed, 1)} median`}; and
        <b>${pctLevel(removed / b.genesisSupply, 2)}</b> of genesis supply is now destroyed or locked, backed by
        <b>${nf(b.vault.nvdaBalance, 1)} NVDA</b> that has never been withdrawn.
        ${leak ? `The dominant fact right now is that <b>${pctLevel(leak.leakNow, 1)}</b> of the volume on the ${S.flow.pools.length} venues indexed in depth <b>crosses pools that pay the vault nothing</b>, so revenue is falling even though total volume is not — this is venue competition, not weakening demand.` : ""}
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
      <p><b style="color:var(--text-primary)">The two dials, and their credit.</b> The Investor View opens with two
      dials rather than one word. <b>Structure</b> scores the inputs identified in
      <a href="https://x.com/okay_lets_ride/status/2098082744899190788" target="_blank" rel="noopener noreferrer">Coulou’s
      “AI – Valuation Report”</a> (@okay_lets_ride, 10 Sep 2026) — fee revenue, main-pool capture, AI-pair share,
      cross-routing κ and the NVDA vault — plus how often new launches choose AI as a base pair; the valuation frame
      uses the report’s 5–7.5% capitalisation rates. <b>Demand</b> is this site’s addition: net flow, wallets above a
      fixed AI balance, distinct buyers, the near-spot book, launch cadence and the live tail. Each input is a
      trailing-7-day level ranked inside AI’s own <b>last 30 days</b> (not its whole history: a token that launched into
      its peak reads “lowest ever” on everything forever), inputs are equal-weighted within a dial, and a reading is
      taken over the pair rather than a threshold over a sum. The site does not use the report’s scenario values or
      weights, and the result is neither the report’s conclusion nor the site owner’s investment view.</p>

      <p><b style="color:var(--text-primary)">The platform view.</b> The Investor tab measures LONG's own thesis: be the
      liquidity layer for tokenized stocks on Robinhood Chain. <b>Stock tokens</b> are identified by bytecode, not name:
      Robinhood's tokenized equities share one 283-byte proxy template, so every anchor token in the LONG census is
      checked against it once. <b>Capture</b> is the share of each stock's on-chain supply held by the v4 pool manager
      (DEX liquidity across all pools, LONG-hooked or not) plus the community vault; NVDA's daily series is rebuilt from
      its transfers into and out of the manager. <b>Trading share</b> counts every Swap on the chain in the last day
      whose pool holds a stock token and asks whether that pool carries the LONG hook. <b>LP size</b> values every
      resting position in AI's indexed venues at spot; the <b>protocol-owned</b> share is the part held by the hook
      itself, and <b>compounding</b> is the hook's own liquidity additions by day (its fee fold-ins since 27 Jul; the
      launch seed on 14 Jul is shown separately), valued at today's prices. <b>Cost to trade</b> walks the tick ladder
      from spot until a dollar amount is absorbed, per venue and across all venues at once (the single price at which
      the pools together take the whole order, which is what a router achieves).</p>

      <p><b style="color:var(--text-primary)">Holders.</b> Every AI transfer since genesis is replayed into a balance per
      address and snapshotted every four hours; balances must sum to supply exactly before anything is published. On
      top of the counts: concentration (the share of wallet-held AI in the top 10, 50 and 100, with the pool manager,
      vault, hook and splitter excluded from both sides), churn (wallets funded from zero and emptied to zero between
      snapshots), a tape of every move of 250,000 AI or more classified by which side of it was the pool, and a
      first-seen date per wallet from which weekly cohorts and their retention are built. One entity can be many
      wallets, so concentration is a floor and holder counts are a ceiling.</p>

      <p><b style="color:var(--text-primary)">Actors.</b> A Uniswap v4 <code>Swap</code> names the router as its sender, not the
      person, so nothing on this site counts swap senders as people. Wallet-level activity comes from the transfer replay:
      every transfer in a transaction is netted per address, routers cancel to zero, and the wallet whose balance changed
      is the trader. Buyers and sellers per period, and every whale move, are attributed that way.</p>

      <p><b style="color:var(--text-primary)">Where the fees go.</b> The platform fee wallet's ledgers in AI, NVDA, USDG and
      WETH are kept from its transfers, and the wallets it forwards to are found from those transfers and given ledgers of
      their own: received, held now, sold into pools (sent to the pool manager), dollars back from pools, moved onward.
      Every token that has ever paid the fee wallet is summed platform-wide and valued at today's prices where one exists.
      Which wallets belong to the protocol is inferred from the forwards, not declared anywhere.</p>

      <p><b style="color:var(--text-primary)">Dollars.</b> Volume and fees are multiplied by the AI/USDG close of the hour
      they happened in. NVDA’s dollar price is read from the stock token’s own busiest USDG pool each run (two or
      three requests, no history scanned) and cross-checked against the price implied by AI in USDG over AI in NVDA;
      the page says when the two disagree. The vault is therefore stated in dollars and as a share of market cap, and
      AI’s beta to NVDA is measured on hourly returns rather than assumed.</p>

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
      genuine directional demand. This makes κ an observed quantity rather than an assumption. The daily series is
      kept incrementally: a refresh appends only the blocks it has not seen, a full run rebuilds whole days from a
      day boundary, and any day whose routing volume falls far below flow’s over the same day is treated as a hole
      and rebuilt on the next run. (Until 13 September a refresh rebuilt the current day from its last three hours,
      which hollowed out the series; the check that catches that now fails the build.)</p>

      <p><b style="color:var(--text-primary)">Timestamps.</b> Swap logs on this chain carry a zeroed
      <code>blockTimestamp</code>, so block times are sampled at 250,000-block
      intervals and interpolated. Block production is steady near 0.102 s, keeping error far
      inside the one-hour buckets.</p>

      <p><b style="color:var(--text-primary)">What anything is scored against.</b> Every band, percentile and
      dial input on this site is ranked against <b>the asset's own measured history</b> — its last 30 days for the
      dials, the full comparable series for the scorecard table. That is a change: an
      earlier version scored these inputs against the four scenarios in a circulating valuation writeup — a
      cross-routing "base case" of 23%, a fee-capture "bull case" of 12%, discount rates labelled bear and bull.
      Those are one author's assumptions about a token with two months of history, and scoring against them meant
      the headline was really measuring agreement with a spreadsheet. It also inverted readings: fee capture at
      22.7% counted as <i>extra-bull</i> on that scale while sitting near the bottom of its own range. The writeup
      is still quoted where it is useful, always labelled as someone's assumption. Where an input has too little
      history to rank, it is shown and left unscored rather than scored against a guess, and each dial says how
      many of its inputs are actually ranked.</p>

      <p><b style="color:var(--text-primary)">Comparisons across time.</b> The indexed set grew from one pool to
      eight, so any share-of-indexed-volume figure has a break in it: before 3 September fee capture reads 100%
      and leakage 0%, not because the toll captured everything but because nothing else was being measured. Days
      without at least one venue of each kind are excluded from those comparisons, so a denominator change cannot
      masquerade as a record high or low.</p>

      <p><b style="color:var(--text-primary)">The effective fee rate is divided out, not assumed.</b> Swap logs
      report about 7000 pips on the tolled pool, but dividing measured fee income by measured sell volume on the
      hooked pools gives roughly 0.60% over the last fortnight. Across sixteen static pools the logged per-swap fee
      exceeds the pool's own configured fee by up to 1000 pips, capped there, so part of what the log reports never
      reaches the splitter. Anything derived from the rate — implied notional above all — therefore divides one
      measured quantity by another.</p>

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
/**
 * An age note on every card fed by a slow-path artifact.
 *
 * The banner at the top reads meta.json, which the fast refresh rewrites every few
 * hours. Bridges, the launchpad census and the holder replay are written by other
 * runs, so when those stopped for a day the banner stayed quiet and the bridge chart
 * simply ended a day early with nothing saying why. Each card now checks its own
 * artifact. Eight hours is past the six-hour refresh plus a run’s length; anything
 * older than that is a stall, not a schedule.
 */
/**
 * Long card intros collapse to two lines, with the rest one tap away.
 *
 * Most cards opened with a paragraph of methodology before the number, and on a
 * phone that put the chart below the fold on nearly every card. The explanations
 * are still the reason anyone should trust a figure here, so nothing is removed:
 * each long intro is clamped, and "How it’s measured" expands it in place.
 * Clamping in CSS rather than splitting sentences keeps every link, bold and code
 * span intact whatever the markup. The methodology credit under the rating is
 * deliberately never collapsed.
 */
const COLLAPSE_OVER = 180;
function collapseIntros(root = document) {
  // The cockpit's own explanation lives in a <details>, so it is not clamped here.
  for (const p of root.querySelectorAll(".card p.sub")) {
    if (p.dataset.collapsible || p.textContent.replace(/\s+/g, " ").trim().length <= COLLAPSE_OVER) continue;
    p.dataset.collapsible = "1";
    p.classList.add("clamped");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "howbtn";
    b.setAttribute("aria-expanded", "false");
    b.textContent = "How it’s measured ▾";
    b.addEventListener("click", () => {
      const open = p.classList.toggle("clamped") === false;
      b.setAttribute("aria-expanded", String(open));
      b.textContent = open ? "Show less ▴" : "How it’s measured ▾";
    });
    p.after(b);
  }
}

function renderAges() {
  const now = Date.now() / 1000;
  for (const el of document.querySelectorAll("[data-age]")) {
    const a = S[el.dataset.age];
    const mins = a?.updatedAt ? Math.round((now - a.updatedAt) / 60) : null;
    if (mins == null || mins < 8 * 60) { el.hidden = true; continue; }
    el.hidden = false;
    el.innerHTML = `Measured <b>${fmtAge(mins)} ago</b> \u2014 this card refreshes on the slower cycle and has missed at least one.`;
  }
}

function renderAll() {
  renderInvestor(); renderFlow(); renderBurn(); renderFloat(); renderBridges(); renderMethod();
  try { renderRwa(); } catch (e) { console.error("renderRwa", e); }
  try { renderHolders(); } catch (e) { console.error("renderHolders", e); /* optional; never blank the tab */ }
  renderAges();
  collapseIntros();
  /* Also on first paint, from the artifact timestamp -- waiting for the live poll
     would leave the staleness unreported for thirty seconds, or forever if the RPC
     is blocked, which is exactly when it matters most. */
  renderStaleBanner();
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
    const [routing, bridges, tape, pools, depth, launchpad, holders, prices, treasury, rwa] = await Promise.all(
      OPTIONAL_ARTIFACTS.map((f) => loadJSON(f).catch(() => null))
    );
    Object.assign(S, { meta, flow, burns, routing, bridges, tape, pools, depth, launchpad, holders, prices, treasury, rwa });
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
  setInterval(refreshLive, 15000);
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
