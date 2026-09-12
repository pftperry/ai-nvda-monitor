#!/usr/bin/env node
/**
 * Do the investor KPIs actually lead price, or only describe it?
 *
 * Two traps this is built to avoid.
 *
 * 1. The mechanical link. In an AMM, price IS a function of net flow within the
 *    same period — buying moves the pool price by construction. So a
 *    contemporaneous correlation between flow imbalance and return is near 1 and
 *    means nothing. Only strictly LAGGED tests can say anything predictive, and
 *    the contemporaneous figure is reported alongside purely to show how much of
 *    the apparent signal is tautology.
 *
 * 2. Multiple testing. Trying enough predictors against enough horizons will
 *    always produce something that looks significant. Every predictor is tested
 *    against every horizon and the whole grid is printed, so a lucky cell is
 *    visible as one cell in a grid rather than as a discovery.
 *
 * Sample is ~60 days of one asset in one regime, so this is powered to reject
 * strong claims, not to confirm subtle ones. Treat anything here as a hypothesis.
 */
import { readData } from "./store.mjs";
import * as C from "./config.mjs";

const flow = readData("flow.json");
const burns = readData("burns.json");
if (!flow) { console.error("No flow.json — run `npm run index` first."); process.exit(1); }

const pool = flow.pools.find((p) => p.poolId === C.AI_NVDA_POOL) || flow.pools[0];
const h = pool.hourly.filter((x) => x.close > 0);
console.log(`Backtest on AI/${pool.pairSymbol}: ${h.length} hourly observations `
  + `(${((h.at(-1).t - h[0].t) / 86400).toFixed(1)} days)\n`);

/* Returns are log returns so they compose across horizons and are symmetric.
   Price here is quote-per-AI from the pool itself. */
const logret = (a, b) => Math.log(b / a);

const pearson = (xs, ys) => {
  const n = xs.length;
  if (n < 30) return { r: NaN, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const r = sxy / Math.sqrt(sxx * syy || 1);
  // t = r*sqrt(n-2)/sqrt(1-r^2); |t| > ~1.96 is the usual 5% threshold
  const t = r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r));
  return { r, t, n };
};

/**
 * Share of periods where the predictor's sign matched the forward return's.
 *
 * Only meaningful for a SIGNED predictor. For a non-negative one (volume, trade
 * count) every prediction is "up", so the hit rate collapses to the base rate of
 * positive returns and looks impressive for no reason — 67% here is just the
 * fraction of up periods, not skill. Those are reported as n/a.
 */
const hitRate = (xs, ys) => {
  const signed = xs.some((v) => v < 0) && xs.some((v) => v > 0);
  if (!signed) return { rate: NaN, tot: 0, unsigned: true };
  let hit = 0, tot = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === 0 || ys[i] === 0) continue;
    tot++; if ((xs[i] > 0) === (ys[i] > 0)) hit++;
  }
  return { rate: tot ? hit / tot : NaN, tot };
};

/**
 * Overlapping forward windows share data, so consecutive observations are not
 * independent and the naive t-stat is inflated by roughly sqrt(k). Deflating by
 * that is crude but far closer to honest than pretending n independent samples.
 */
const deflate = (t, k) => t / Math.sqrt(k);

// ── predictors, all knowable at time t ────────────────────────────────────
const trailing = (i, k, pick) => {
  let s = 0;
  for (let j = Math.max(0, i - k + 1); j <= i; j++) s += pick(h[j]);
  return s;
};
const predictors = {
  "flow imbalance, 1h":    (i) => { const b = h[i].aiBuy, s = h[i].aiSell; return b + s > 0 ? (b - s) / (b + s) : 0; },
  "flow imbalance, 6h":    (i) => { const b = trailing(i, 6, (x) => x.aiBuy), s = trailing(i, 6, (x) => x.aiSell); return b + s > 0 ? (b - s) / (b + s) : 0; },
  "flow imbalance, 24h":   (i) => { const b = trailing(i, 24, (x) => x.aiBuy), s = trailing(i, 24, (x) => x.aiSell); return b + s > 0 ? (b - s) / (b + s) : 0; },
  "net AI flow, 24h":      (i) => trailing(i, 24, (x) => x.aiBuy - x.aiSell),
  "trade count, 1h":       (i) => h[i].buys + h[i].sells,
  "distinct buyers − sellers, 6h": (i) => trailing(i, 6, (x) => (x.buyers || 0) - (x.sellers || 0)),
  "volume, 6h":            (i) => trailing(i, 6, (x) => x.aiBuy + x.aiSell),
  "momentum, prior 24h":   (i) => (i >= 24 ? logret(h[i - 24].close, h[i].close) : 0),
};

const horizons = [1, 6, 24, 72];

console.log("LAGGED: does the predictor at t explain the return from t to t+k?");
console.log("(correlation, |t|>1.96 ≈ 5% significance, and directional hit rate)\n");
const head = "predictor".padEnd(32) + horizons.map((k) => `+${k}h`.padStart(17)).join("");
console.log(head);
console.log("-".repeat(head.length));

const grid = {};
for (const [name, fn] of Object.entries(predictors)) {
  const cells = [];
  grid[name] = {};
  for (const k of horizons) {
    const xs = [], ys = [];
    for (let i = 24; i + k < h.length; i++) {
      const x = fn(i);
      if (!isFinite(x)) continue;
      xs.push(x); ys.push(logret(h[i].close, h[i + k].close));
    }
    const { r, t, n } = pearson(xs, ys);
    const { rate } = hitRate(xs, ys);
    grid[name][k] = { r, t, n, rate };
    // Deflate for overlapping windows before deciding what counts as significant.
    const tAdj = deflate(t, k);
    const star = Math.abs(tAdj) > 1.96 ? "*" : " ";
    const hr = isFinite(rate) ? `${(rate * 100).toFixed(0)}%` : " n/a";
    cells.push(`${(r >= 0 ? "+" : "") + r.toFixed(3)}${star} ${hr}`.padStart(17));
  }
  console.log(name.padEnd(32) + cells.join(""));
}

// ── the tautology check ───────────────────────────────────────────────────
const xs0 = [], ys0 = [];
for (let i = 24; i < h.length; i++) {
  const b = h[i].aiBuy, s = h[i].aiSell;
  if (b + s <= 0) continue;
  xs0.push((b - s) / (b + s));
  ys0.push(i > 0 ? logret(h[i - 1].close, h[i].close) : 0);
}
const same = pearson(xs0, ys0);
console.log(`\nCONTEMPORANEOUS (same hour) flow imbalance vs return: r = ${same.r.toFixed(3)}, |t| = ${Math.abs(same.t).toFixed(1)}`);
console.log("This one is mechanical, not predictive: in an AMM the price moves BECAUSE of net flow.");
console.log("It is the benchmark for how much of any lagged result is just this leaking across a boundary.\n");

// ── daily-frequency KPIs ──────────────────────────────────────────────────
if (burns?.daily?.length > 10) {
  const day = new Map();
  for (const x of h) {
    const d = Math.floor(x.t / 86400) * 86400;
    const cur = day.get(d) || { t: d, first: x.close, last: x.close };
    cur.last = x.close; day.set(d, cur);
  }
  const days = [...day.values()].sort((a, b) => a.t - b.t);
  const feeByDay = new Map(burns.daily.map((d) => [d.t, (d.burnAI || 0) + (d.lockAI || 0) + (d.platformAI || 0)]));

  const xs = [], ys = [];
  for (let i = 1; i < days.length - 1; i++) {
    const fPrev = feeByDay.get(days[i - 1].t), fNow = feeByDay.get(days[i].t);
    if (!fPrev || !fNow) continue;
    xs.push(Math.log(fNow / fPrev));                        // fee growth to date t
    ys.push(logret(days[i].last, days[i + 1].last));        // next day's return
  }
  const fee = pearson(xs, ys);
  const fh = hitRate(xs, ys);
  console.log("DAILY: fee growth on day t vs return on day t+1");
  console.log(`  r = ${isFinite(fee.r) ? fee.r.toFixed(3) : "n/a"}, |t| = ${isFinite(fee.t) ? Math.abs(fee.t).toFixed(2) : "n/a"}, `
    + `n = ${fee.n}, hit rate ${isFinite(fh.rate) ? (fh.rate * 100).toFixed(0) + "%" : "n/a"}`);
}

console.log(`\nSample: one asset, ~${((h.at(-1).t - h[0].t) / 86400).toFixed(0)} days, a single launch-and-cool regime.`);
console.log("Underpowered for subtle effects and wide open to overfitting across this grid.");
console.log("Read a lone starred cell as noise until it survives out of sample.");
