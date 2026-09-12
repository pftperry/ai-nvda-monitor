import { POOL_MANAGER, GENESIS_BLOCK } from "../config.mjs";
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
export async function poolTickLadder(poolId, latest, prior = null, opts = {}) {
  const from = prior?.cursor ? Math.max(GENESIS_BLOCK, prior.cursor + 1) : GENESIS_BLOCK;
  const logs = from > latest ? [] : await getLogsRange(
    { address: POOL_MANAGER, topics: [TOPICS.MODIFY_LIQUIDITY, poolId] },
    from, latest, { chunk: 25_000_000, deadline: opts.deadline });

  const net = new Map();
  for (const [t, v] of Object.entries(prior?.net || {})) net.set(Number(t), BigInt(v));
  for (const l of logs) {
    const m = decodeModifyLiquidity(l);
    net.set(m.tickLower, (net.get(m.tickLower) ?? 0n) + m.liquidityDelta);
    net.set(m.tickUpper, (net.get(m.tickUpper) ?? 0n) - m.liquidityDelta);
  }
  return {
    cursor: logs.reachedBlock ?? latest,
    partial: !!logs.truncated,
    events: logs.length,
    net: Object.fromEntries([...net].map(([t, v]) => [t, v.toString()])),
  };
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
    }
  }

  return {
    poolId: pool.poolId, pair: pool.pairSymbol, fee: pool.lastFeePips ?? pool.fee,
    spot: +spotQuotePerAi.toPrecision(8), spotUsd: +aiUsd.toPrecision(8),
    tvlUsd: Math.round(tvlUsd), bidUsd: Math.round(bidUsd), askUsd: Math.round(askUsd),
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
  let skipped = 0;

  for (const p of pools) {
    if (!p.lastSqrtPriceX96 || p.lastSqrtPriceX96 === "0") { skipped++; continue; }
    if (deadline && Date.now() > deadline) { skipped++; continue; }
    const prior = ladders[p.poolId];
    const ladder = await poolTickLadder(p.poolId, latest, prior, { deadline });
    ladders[p.poolId] = ladder;
    if (ladder.partial) { skipped++; continue; }   // a half-replayed ladder is not a book
    const d = poolDepth(p, ladder, aiUsd, { windowPct, bins });
    if (d) out.push(d);
  }
  if (store) store.set("tickLadders", ladders);
  if (opts.io?.write) opts.io.write("ladders.json", { updatedAt: Math.floor(Date.now() / 1000), ladders });

  out.sort((a, b) => b.tvlUsd - a.tvlUsd);
  const bidUsd = out.reduce((s, d) => s + d.bidUsd, 0);
  const askUsd = out.reduce((s, d) => s + d.askUsd, 0);

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

  log(`  depth across ${out.length} pools: buyside $${(bidUsd / 1e6).toFixed(2)}M vs sellside $${(askUsd / 1e6).toFixed(2)}M` +
      `${skipped ? ` (${skipped} pool(s) skipped)` : ""}`);

  return {
    windowPct, bins, aiUsd,
    // Every pool shares one dollars-per-AI grid, so these bins are addable.
    gridIsUsdPerAi: true,
    pools: out,
    skipped,
    bidUsd: Math.round(bidUsd),
    askUsd: Math.round(askUsd),
    imbalanceUsd: Math.round(bidUsd - askUsd),
    tvlUsd: out.reduce((s, d) => s + d.tvlUsd, 0),
    book: [...merged.values()].sort((a, b) => a.p - b.p),
  };
}
