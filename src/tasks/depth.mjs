import { POOL_MANAGER, GENESIS_BLOCK, LONG_HOOK } from "../config.mjs";
import { getLogsRange } from "../rpc.mjs";
import { TOPICS, decodeModifyLiquidity } from "../decode.mjs";

/**
 * Liquidity depth: what it would actually cost to move the price.
 *
 * Everything else on this site is backward-looking -- volume that happened, fees
 * that were taken, flow that already crossed. Depth is the one structural measure
 * that faces forward: concentrated liquidity sitting below spot is money committed
 * to buying, and AI sitting above spot is tokens committed to selling. The gap
 * between them says which direction is cheaper to push, right now, before anyone
 * trades.
 *
 * Reconstructed from ModifyLiquidity logs rather than read from contract storage.
 * v4 keeps pool state behind extsload and this chain serves no archive state, so
 * replaying the events is both the portable option and the auditable one: every
 * position that was ever opened or closed is in the tape. Two checks say the replay
 * is right -- net liquidity across all ticks must come to exactly zero, and the
 * liquidity active at the current tick must equal what the pool itself reports in
 * its last Swap. Measured on AI/NVDA: 2,404 events, 298 ticks, residual zero, and
 * active liquidity matching the pool to the wei.
 */

const Q96 = 2 ** 96;
const tickToSqrt = (t) => Math.pow(1.0001, t / 2);

/** Raw token amounts a position holds, given where spot sits relative to it. */
function amountsFor(L, sqrtA, sqrtB, sqrtP) {
  if (sqrtP <= sqrtA) return { a0: L * (1 / sqrtA - 1 / sqrtB), a1: 0 };
  if (sqrtP >= sqrtB) return { a0: 0, a1: L * (sqrtB - sqrtA) };
  return { a0: L * (1 / sqrtP - 1 / sqrtB), a1: L * (sqrtP - sqrtA) };
}

/**
 * One pool's tick ladder, replayed from its ModifyLiquidity tape.
 * Resumes from a cursor: positions are append-only deltas, so a later scan only
 * has to add to the ladder rather than rebuild it.
 */
export const LADDER_VERSION = 2;   // v2 keeps the hook's own positions apart; older ladders are rebuilt once
export async function poolTickLadder(poolId, latest, prior = null, opts = {}) {
  const usable = prior && prior.v === LADDER_VERSION ? prior : null;
  const from = usable?.cursor ? Math.max(GENESIS_BLOCK, usable.cursor + 1) : GENESIS_BLOCK;
  const logs = from > latest ? [] : await getLogsRange(
    { address: POOL_MANAGER, topics: [TOPICS.MODIFY_LIQUIDITY, poolId] },
    from, latest, { chunk: 25_000_000, deadline: opts.deadline });

  const net = new Map(), hookNet = new Map();
  for (const [t, v] of Object.entries(usable?.net || {})) net.set(Number(t), BigInt(v));
  for (const [t, v] of Object.entries(usable?.hook?.net || {})) hookNet.set(Number(t), BigInt(v));
  /* The hook's own liquidity changes, by day and by tick range. The protocol seeds
     a launch's liquidity and, since its second week, folds the pool's fees back into
     it on every swap; this is the tape of that compounding. Ranges are kept so the
     deltas can be turned into token amounts later, at whatever price then rules. */
  const hookDays = {};
  for (const [d, r] of Object.entries(usable?.hook?.days || {})) hookDays[d] = { ...r };
  for (const l of logs) {
    const m = decodeModifyLiquidity(l);
    net.set(m.tickLower, (net.get(m.tickLower) ?? 0n) + m.liquidityDelta);
    net.set(m.tickUpper, (net.get(m.tickUpper) ?? 0n) - m.liquidityDelta);
    if (m.sender === LONG_HOOK) {
      hookNet.set(m.tickLower, (hookNet.get(m.tickLower) ?? 0n) + m.liquidityDelta);
      hookNet.set(m.tickUpper, (hookNet.get(m.tickUpper) ?? 0n) - m.liquidityDelta);
      const d = opts.dayOf ? opts.dayOf(m.block) : null;
      if (d) {
        const day = (hookDays[d] ||= {});
        const key = `${m.tickLower}:${m.tickUpper}`;
        day[key] = (BigInt(day[key] || 0) + m.liquidityDelta).toString();
      }
    }
  }
  const asObj = (map) => Object.fromEntries([...map].filter(([, v]) => v !== 0n).map(([t, v]) => [t, v.toString()]));
  return {
    v: LADDER_VERSION,
    cursor: logs.reachedBlock ?? latest,
    partial: !!logs.truncated,
    events: (usable?.events || 0) + logs.length,
    net: asObj(net),
    hook: { net: asObj(hookNet), days: hookDays },
  };
}

/**
 * Walk the tick ladder from spot in one direction, either until a given amount of
 * AI has been absorbed or until a target sqrt price is reached. Returns where the
 * price ends and how much AI it took. `side` is what the trader does with AI:
 * "sell" puts AI into the pool, "buy" takes it out. Everything is in raw units.
 */
export function walkBook(net, sqrtP, aiIsC0, side, { amountRaw = Infinity, targetSqrt = null } = {}) {
  const ticks = Object.keys(net).map(Number).sort((a, b) => a - b);
  if (!ticks.length || !(sqrtP > 0)) return null;
  const curTick = Math.floor(Math.log(sqrtP * sqrtP) / Math.log(1.0001));
  let i = -1;
  for (let k = 0; k < ticks.length && ticks[k] <= curTick; k++) i = k;
  let L = 0;
  for (let k = 0; k <= i; k++) L += Number(net[ticks[k]]);
  /* Buying token0 or selling token1 pushes token1-per-token0 up. */
  const up = (aiIsC0 && side === "buy") || (!aiIsC0 && side === "sell");
  let p = sqrtP, used = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    if (up) {
      if (i + 1 >= ticks.length) return { sqrtEnd: p, used, exhausted: true };
      const edge = tickToSqrt(ticks[i + 1]);
      const bound = targetSqrt != null ? Math.min(edge, targetSqrt) : edge;
      if (L > 0 && bound > p) {
        const cap = aiIsC0 ? L * (1 / p - 1 / bound) : L * (bound - p);
        const rem = amountRaw - used;
        if (rem <= cap) return { sqrtEnd: aiIsC0 ? 1 / (1 / p - rem / L) : p + rem / L, used: amountRaw, exhausted: false };
        used += cap;
      }
      p = bound;
      if (targetSqrt != null && bound >= targetSqrt) return { sqrtEnd: p, used, exhausted: false };
      i++; L += Number(net[ticks[i]]);
    } else {
      if (i < 0) return { sqrtEnd: p, used, exhausted: true };
      const edge = tickToSqrt(ticks[i]);
      const bound = targetSqrt != null ? Math.max(edge, targetSqrt) : edge;
      if (L > 0 && bound < p) {
        const cap = aiIsC0 ? L * (1 / bound - 1 / p) : L * (p - bound);
        const rem = amountRaw - used;
        if (rem <= cap) return { sqrtEnd: aiIsC0 ? 1 / (1 / p + rem / L) : p - rem / L, used: amountRaw, exhausted: false };
        used += cap;
      }
      p = bound;
      if (targetSqrt != null && bound <= targetSqrt) return { sqrtEnd: p, used, exhausted: false };
      L -= Number(net[ticks[i]]); i--;
    }
  }
  return { sqrtEnd: p, used, exhausted: true };
}

/** AI's price ratio (end over start) implied by two sqrt prices, for either token ordering. */
export const aiRatio = (sqrtEnd, sqrtStart, aiIsC0) => (aiIsC0 ? (sqrtEnd / sqrtStart) ** 2 : (sqrtStart / sqrtEnd) ** 2);

/** The notional sizes a desk would ask about, in dollars. */
export const IMPACT_SIZES = [1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6];

/**
 * Price impact of selling or buying a dollar amount of AI in one pool: the move in
 * AI's price after the trade, as a fraction. 1 means the book ran out.
 */
export function poolImpact(pool, ladder, aiUsd) {
  const sqrtP = Number(pool.lastSqrtPriceX96) / Q96;
  if (!(sqrtP > 0) || !(aiUsd > 0)) return null;
  const one = (side) => IMPACT_SIZES.map((usd) => {
    const r = walkBook(ladder.net, sqrtP, pool.aiIsCurrency0, side, { amountRaw: (usd / aiUsd) * 1e18 });
    if (!r) return { usd, pct: null };
    const pct = r.exhausted ? 1 : Math.abs(aiRatio(r.sqrtEnd, sqrtP, pool.aiIsCurrency0) - 1);
    return { usd, pct: +Math.min(1, pct).toFixed(5) };
  });
  return { sell: one("sell"), buy: one("buy") };
}

/**
 * Impact across every venue at once, as a router would see it: the single AI price
 * move at which the pools together absorb the whole amount. Found by bisection on
 * the price ratio, walking each pool to that target.
 */
export function mergedImpact(entries, aiUsd) {
  const usable = entries.filter((e) => e.pool.lastSqrtPriceX96 && e.ladder?.net && Object.keys(e.ladder.net).length);
  if (!usable.length || !(aiUsd > 0)) return null;
  const absorbed = (ratio, side) => usable.reduce((s, { pool, ladder }) => {
    const sqrtP = Number(pool.lastSqrtPriceX96) / Q96;
    const target = pool.aiIsCurrency0 ? sqrtP * Math.sqrt(ratio) : sqrtP / Math.sqrt(ratio);
    const r = walkBook(ladder.net, sqrtP, pool.aiIsCurrency0, side, { targetSqrt: target });
    return s + (r ? r.used : 0);
  }, 0);
  const solve = (usd, side) => {
    const want = (usd / aiUsd) * 1e18;
    let lo = 0, hi = 0.999;                      // |ratio − 1|: 0 is no move, 0.999 is the book gone
    if (absorbed(side === "sell" ? 1 - hi : 1 + hi, side) < want) return { usd, pct: 1 };
    for (let k = 0; k < 48; k++) {
      const mid = (lo + hi) / 2;
      if (absorbed(side === "sell" ? 1 - mid : 1 + mid, side) >= want) hi = mid; else lo = mid;
    }
    return { usd, pct: +hi.toFixed(5) };
  };
  return { sell: IMPACT_SIZES.map((u) => solve(u, "sell")), buy: IMPACT_SIZES.map((u) => solve(u, "buy")), venues: usable.length };
}

/** Dollar value of every position in a ladder at the pool's spot, split into AI and quote legs. */
function ladderValueUsd(net, pool, aiUsd) {
  const dec0 = pool.aiIsCurrency0 ? 18 : (pool.pairDecimals ?? 18);
  const dec1 = pool.aiIsCurrency0 ? (pool.pairDecimals ?? 18) : 18;
  const sqrtP = Number(pool.lastSqrtPriceX96) / Q96;
  const rawToPrice = (sp) => sp * sp * 10 ** (dec0 - dec1);
  const spotQuotePerAi = pool.aiIsCurrency0 ? rawToPrice(sqrtP) : 1 / rawToPrice(sqrtP);
  const quoteUsd = aiUsd / spotQuotePerAi;
  const ticks = Object.keys(net).map(Number).sort((a, b) => a - b);
  let L = 0n, ai = 0, quote = 0, active = 0;
  const curTick = Math.floor(Math.log(sqrtP * sqrtP) / Math.log(1.0001));
  for (let i = 0; i < ticks.length - 1; i++) {
    L += BigInt(net[ticks[i]]);
    if (L <= 0n) continue;
    if (ticks[i] <= curTick && curTick < ticks[i + 1]) active = Number(L);
    const { a0, a1 } = amountsFor(Number(L), tickToSqrt(ticks[i]), tickToSqrt(ticks[i + 1]), sqrtP);
    ai += pool.aiIsCurrency0 ? a0 / 10 ** dec0 : a1 / 10 ** dec1;
    quote += pool.aiIsCurrency0 ? a1 / 10 ** dec1 : a0 / 10 ** dec0;
  }
  return { ai, quote, aiUsd: ai * aiUsd, quoteUsd: quote * quoteUsd, usd: ai * aiUsd + quote * quoteUsd, active, quotePriceUsd: quoteUsd, dec0, dec1, sqrtP };
}

/**
 * The hook's compounding, per day, in today's dollars: each day's liquidity deltas
 * turned into the AI and quote they would hold at the current price. Adds and
 * removals kept apart, because a seeded launch and a fee fold-in look the same in
 * liquidity units and different in intent.
 */
function hookByDay(ladder, pool, aiUsd) {
  const v = ladderValueUsd({}, pool, aiUsd);   // just for the unit conversions
  const out = [];
  for (const [d, ranges] of Object.entries(ladder.hook?.days || {})) {
    let addAi = 0, addQuote = 0, remAi = 0, remQuote = 0, n = 0;
    for (const [key, delta] of Object.entries(ranges)) {
      const [lo, hi] = key.split(":").map(Number);
      const L = Number(BigInt(delta));
      if (!L) continue;
      const { a0, a1 } = amountsFor(Math.abs(L), tickToSqrt(lo), tickToSqrt(hi), v.sqrtP);
      const ai = pool.aiIsCurrency0 ? a0 / 10 ** v.dec0 : a1 / 10 ** v.dec1;
      const quote = pool.aiIsCurrency0 ? a1 / 10 ** v.dec1 : a0 / 10 ** v.dec0;
      if (L > 0) { addAi += ai; addQuote += quote; } else { remAi += ai; remQuote += quote; }
      n++;
    }
    out.push({ t: Number(d), addAi, addQuoteUsd: addQuote * v.quotePriceUsd, addUsd: addAi * aiUsd + addQuote * v.quotePriceUsd,
      remAi, remUsd: remAi * aiUsd + remQuote * v.quotePriceUsd, ranges: n });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Depth for one pool, in USD, binned across a window around spot.
 *
 * The USD side needs one anchor and no oracle. AI's dollar price comes from the
 * AI/USDG pools (USDG is a dollar stablecoin), and every other quote token then
 * prices itself off its own pool: if 1 AI = P NVDA and 1 AI = $X, then NVDA is
 * $X/P. So NVDA, ETH and the rest get dollar values without trusting anything
 * beyond the stablecoin peg, which the Method tab already states as an assumption.
 */
/**
 * The bands a trade can actually reach.
 *
 * The full book is measured over +/-50% because that is the shape worth drawing.
 * It is the wrong window for asking which way price goes next. Measured on this
 * book: bids are 57.8% of depth across +/-50% and 49.1% across +/-2%, so the
 * "buyside imbalance" the headline reported was almost entirely liquidity parked
 * far out of range, not money standing under the price. Depth fifty percent away
 * cannot be hit by any trade that matters this week; depth two percent away is hit
 * by an ordinary one. These are summed exactly from the tick ladder rather than
 * from the 0.83%-wide display bins, which cannot resolve a 2% band.
 */
export const NEAR_WINDOWS = [0.02, 0.05, 0.10];

export function poolDepth(pool, ladder, aiUsd, opts = {}) {
  const windowPct = opts.windowPct ?? 0.5;
  const bins = opts.bins ?? 120;
  const dec0 = pool.aiIsCurrency0 ? 18 : (pool.pairDecimals ?? 18);
  const dec1 = pool.aiIsCurrency0 ? (pool.pairDecimals ?? 18) : 18;

  const sqrtP = Number(pool.lastSqrtPriceX96) / Q96;
  if (!(sqrtP > 0) || !(aiUsd > 0)) return null;

  /* Raw sqrt price is token1-per-token0 before decimals. Everything below works in
     raw units and converts once at the end, because mixing the two conventions
     mid-calculation is how price maths goes quietly wrong. */
  const rawToPrice = (sp) => sp * sp * 10 ** (dec0 - dec1);      // quote per AI, if AI is token0
  const spotQuotePerAi = pool.aiIsCurrency0 ? rawToPrice(sqrtP) : 1 / rawToPrice(sqrtP);
  if (!(spotQuotePerAi > 0)) return null;
  const quoteUsd = aiUsd / spotQuotePerAi;                        // the anchor, propagated

  /* Bin on DOLLARS per AI, not on each pool's own quote.
     Every pool prices AI in a different unit -- NVDA at 0.0015, USDG at 0.33, ETH at
     0.00013 -- so binning in native quote and then merging across pools stacks three
     incompatible axes on one chart and produces a picture of nothing. The same
     mistake as summing bridge volumes in different tokens, and just as invisible
     once drawn. A pool's price converts to dollars by the ratio to its own spot,
     which is exactly what makes one shared grid possible. */
  const lo = aiUsd * (1 - windowPct);
  const hi = aiUsd * (1 + windowPct);
  const step = (hi - lo) / bins;
  const toUsd = (quotePerAi) => aiUsd * (quotePerAi / spotQuotePerAi);
  const rows = Array.from({ length: bins }, (_, i) => ({
    lo: lo + i * step, hi: lo + (i + 1) * step, bid: 0, ask: 0,
  }));

  const ticks = Object.keys(ladder.net).map(Number).sort((a, b) => a - b);
  let L = 0n;
  let bidUsd = 0, askUsd = 0, tvlUsd = 0;
  const near = NEAR_WINDOWS.map((pct) => ({ pct, bidUsd: 0, askUsd: 0 }));

  for (let i = 0; i < ticks.length - 1; i++) {
    L += BigInt(ladder.net[ticks[i]]);
    if (L <= 0n) continue;
    const Lf = Number(L);
    const sqrtA = tickToSqrt(ticks[i]), sqrtB = tickToSqrt(ticks[i + 1]);

    /* Subdivide a tick range across the bins it spans. A single position can cover
       most of the window -- full-range ones cover all of it -- so attributing its
       whole balance to one bin would draw a spike where the book is actually flat. */
    const SUB = 24;
    for (let s = 0; s < SUB; s++) {
      const a = sqrtA + ((sqrtB - sqrtA) * s) / SUB;
      const b = sqrtA + ((sqrtB - sqrtA) * (s + 1)) / SUB;
      const { a0, a1 } = amountsFor(Lf, a, b, sqrtP);
      const ai   = (pool.aiIsCurrency0 ? a0 / 10 ** dec0 : a1 / 10 ** dec1) * aiUsd;
      const quote = (pool.aiIsCurrency0 ? a1 / 10 ** dec1 : a0 / 10 ** dec0) * quoteUsd;
      tvlUsd += ai + quote;

      const midRaw = (a + b) / 2;
      const priceUsd = toUsd(pool.aiIsCurrency0 ? rawToPrice(midRaw) : 1 / rawToPrice(midRaw));
      if (priceUsd < lo || priceUsd >= hi) continue;
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((priceUsd - lo) / step)));
      /* Quote below spot is somebody's committed bid; AI above spot is committed
         supply. Anything on the wrong side of spot is the same position's other
         leg and is not depth in that direction. */
      rows[idx].bid += quote;
      rows[idx].ask += ai;
      bidUsd += quote;
      askUsd += ai;
      /* Same rule as the bins, on tighter bands: quote below spot is a committed
         bid, AI above spot is committed supply. A position straddling spot lands
         its two legs on opposite sides, which is what it is. */
      for (const n of near) {
        if (priceUsd >= aiUsd * (1 - n.pct) && priceUsd < aiUsd) n.bidUsd += quote;
        else if (priceUsd > aiUsd && priceUsd <= aiUsd * (1 + n.pct)) n.askUsd += ai;
      }
    }
  }

  return {
    poolId: pool.poolId, pair: pool.pairSymbol, fee: pool.lastFeePips ?? pool.fee,
    spot: +spotQuotePerAi.toPrecision(8), spotUsd: +aiUsd.toPrecision(8),
    tvlUsd: Math.round(tvlUsd), bidUsd: Math.round(bidUsd), askUsd: Math.round(askUsd),
    near: near.map((n) => ({ pct: n.pct, bidUsd: Math.round(n.bidUsd), askUsd: Math.round(n.askUsd) })),
    bins: rows.map((r) => ({ p: +((r.lo + r.hi) / 2).toPrecision(6), bid: Math.round(r.bid), ask: Math.round(r.ask) })),
  };
}

/**
 * Depth across every indexed pool, and the imbalance that falls out of it.
 *
 * The imbalance is the one number here that a holder can act on: buyside is dollars
 * already committed to buying AI below spot, sellside is AI already committed to
 * selling above it. A large buyside imbalance means the book is thicker underneath
 * than overhead, so the same size moves the price further up than down. It is a
 * statement about cost to move, not a forecast -- liquidity can be pulled, and a
 * position that is not there in an hour was never a promise.
 */
export async function indexDepth(pools, latest, aiUsd, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store;
  const windowPct = opts.windowPct ?? 0.5;
  const bins = opts.bins ?? 120;
  const deadline = opts.budgetSeconds ? Date.now() + opts.budgetSeconds * 1000 : undefined;

  /* Ladders live beside the other artifacts, not only in the build cache.
     Replaying a pool's whole position history is the expensive part of this step and
     the result never changes once computed -- but held only in the Actions cache it
     is rebuilt on any cold key, which is how the first run covered 2 pools of 20
     before its budget ran out. Committed, it is built once and every later run just
     extends it from a cursor. The file is small: twenty pools of tick deltas is
     about 40 KB. */
  const stored = opts.io?.read?.("ladders.json")?.ladders;
  const ladders = stored || (store && store.get("tickLadders")) || {};
  const out = [];
  const complete = [];      // { pool, ladder } for every fully replayed venue, for the cross-venue walk
  let skipped = 0;

  for (const p of pools) {
    if (!p.lastSqrtPriceX96 || p.lastSqrtPriceX96 === "0") { skipped++; continue; }
    if (deadline && Date.now() > deadline) { skipped++; continue; }
    const prior = ladders[p.poolId];
    const ladder = await poolTickLadder(p.poolId, latest, prior, { deadline, dayOf: opts.dayOf });
    ladders[p.poolId] = ladder;
    if (ladder.partial) { skipped++; continue; }   // a half-replayed ladder is not a book
    const d = poolDepth(p, ladder, aiUsd, { windowPct, bins });
    if (!d) continue;
    /* What a desk asks: the move a given dollar sale causes, and how much of the
       book the protocol itself owns. Walked from the same ladder as the picture. */
    d.impact = poolImpact(p, ladder, aiUsd);
    const all = ladderValueUsd(ladder.net, p, aiUsd);
    const own = ladderValueUsd(ladder.hook?.net || {}, p, aiUsd);
    d.hookTvlUsd = Math.round(own.usd);
    d.hookShare = all.usd > 0 ? +(own.usd / all.usd).toFixed(4) : null;
    d.hookActiveShare = all.active > 0 ? +(own.active / all.active).toFixed(4) : null;
    d.hookDays = hookByDay(ladder, p, aiUsd);
    out.push(d);
    complete.push({ pool: p, ladder });
  }
  if (store) store.set("tickLadders", ladders);

  /* Cross-venue impact and the protocol's compounding, summed over every venue. */
  const impact = mergedImpact(complete, aiUsd);
  const compounding = new Map();
  for (const d of out) for (const r of d.hookDays || []) {
    const row = compounding.get(r.t) || { t: r.t, addUsd: 0, addAi: 0, addQuoteUsd: 0, remUsd: 0, remAi: 0 };
    row.addUsd += r.addUsd; row.addAi += r.addAi; row.addQuoteUsd += r.addQuoteUsd; row.remUsd += r.remUsd; row.remAi += r.remAi;
    compounding.set(r.t, row);
  }
  const hookTvlUsd = out.reduce((s, d) => s + (d.hookTvlUsd || 0), 0);
  if (opts.io?.write) opts.io.write("ladders.json", { updatedAt: Math.floor(Date.now() / 1000), ladders });

  out.sort((a, b) => b.tvlUsd - a.tvlUsd);
  const near = NEAR_WINDOWS.map((pct, i) => ({
    pct,
    bidUsd: out.reduce((s, d) => s + (d.near?.[i]?.bidUsd || 0), 0),
    askUsd: out.reduce((s, d) => s + (d.near?.[i]?.askUsd || 0), 0),
  }));
  const bidUsd = out.reduce((s, d) => s + d.bidUsd, 0);
  const askUsd = out.reduce((s, d) => s + d.askUsd, 0);

  /* Keep a history, even though nothing reads it yet.
     Depth is the one measure here with a plausible claim to leading price -- order
     book imbalance has real support in market microstructure, unlike anything else
     on this page, which the backtest showed leads nothing. But that claim is
     testable only against a series, and today there is one observation. So the
     series starts accumulating now: every day not recorded is a day that can never
     be backtested later, and the cost is one row.
     Deliberately NOT wired into the rating. Scoring it today would mean inventing a
     threshold, which is exactly the borrowed-anchor problem the rating was just
     rebuilt to remove. It earns a place when it has history to be ranked against
     and a backtest that says it leads something. */
  const stamp = Math.floor(Date.now() / 1000);
  const priorHistory = opts.io?.read?.("depth.json")?.history || [];
  const hourKey = Math.floor(stamp / 3600) * 3600;
  const history = priorHistory.filter((h) => h.t !== hourKey).slice(-24 * 90);
  history.push({
    t: hourKey, bid: Math.round(bidUsd), ask: Math.round(askUsd),
    imbalance: Math.round(bidUsd - askUsd), aiUsd: +aiUsd.toPrecision(8),
    /* The tightest band, hour by hour. Nothing can rank today against its own
       history until there is a history, and there are four hours of it; this is
       what makes the percentile possible later rather than an excuse to skip it. */
    nearBid: near[0].bidUsd, nearAsk: near[0].askUsd, nearPct: near[0].pct,
    venues: out.length,
    /* The platform view's series: total liquidity, the protocol's own share of it,
       and what a million-dollar sale would move the price, hour by hour. */
    tvl: Math.round(out.reduce((s, d) => s + d.tvlUsd, 0)),
    hookTvl: Math.round(hookTvlUsd),
    sell1m: impact?.sell.find((x) => x.usd === 1e6)?.pct ?? null,
    buy1m: impact?.buy.find((x) => x.usd === 1e6)?.pct ?? null,
  });
  history.sort((a, b) => a.t - b.t);

  /* One merged book across pools, on a shared price grid. Routers do not care which
     venue the liquidity sits in, so neither should the picture of it. */
  const merged = new Map();
  for (const d of out) {
    for (let i = 0; i < d.bins.length; i++) {
      const b = d.bins[i];
      const row = merged.get(i) || { p: b.p, bid: 0, ask: 0 };
      row.bid += b.bid; row.ask += b.ask;
      merged.set(i, row);
    }
  }

  log(`  near spot (+/-${(near[0].pct * 100).toFixed(0)}%): buyside $${Math.round(near[0].bidUsd).toLocaleString()} vs sellside $${Math.round(near[0].askUsd).toLocaleString()}`);
  log(`  depth across ${out.length} pools: buyside ${(bidUsd / 1e6).toFixed(2)}M vs sellside ${(askUsd / 1e6).toFixed(2)}M` +
      `${skipped ? ` (${skipped} pool(s) skipped)` : ""}`);

  return {
    windowPct, bins, aiUsd, near,
    // Every pool shares one dollars-per-AI grid, so these bins are addable.
    gridIsUsdPerAi: true,
    pools: out,
    skipped,
    bidUsd: Math.round(bidUsd),
    askUsd: Math.round(askUsd),
    imbalanceUsd: Math.round(bidUsd - askUsd),
    tvlUsd: out.reduce((s, d) => s + d.tvlUsd, 0),
    hookTvlUsd: Math.round(hookTvlUsd),
    impactSizes: IMPACT_SIZES,
    impact,
    compounding: [...compounding.values()].sort((a, b) => a.t - b.t)
      .map((r) => ({ t: r.t, addUsd: Math.round(r.addUsd), addAi: Math.round(r.addAi), addQuoteUsd: Math.round(r.addQuoteUsd), remUsd: Math.round(r.remUsd), remAi: Math.round(r.remAi) })),
    book: [...merged.values()].sort((a, b) => a.p - b.p),
    history,
  };
}
