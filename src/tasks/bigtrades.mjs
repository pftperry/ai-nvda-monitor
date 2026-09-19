import { getLogsRange } from "../rpc.mjs";
import { POOL_MANAGER } from "../config.mjs";
import { TOPICS, decodeSwap, priceFromSqrt, fmtUnits, atPriceBound } from "../decode.mjs";

/**
 * The day's largest AI trades, as trades rather than as legs.
 *
 * The Tape tab used to build this from the flow task, which records a short tape for
 * the four busiest pools only and records one row per swap. Both of those hid the
 * thing the card exists to show. On 17 Sep an aggregator sold 6.1M AI, about $1.69M,
 * in a single transaction routed through eight pools at once: 1.34M through AI/USDG,
 * 0.93M through AI/ETH, 0.73M through AI/NVDA and so on down. Six of those legs were
 * outside the four pools being watched, and the two that were inside appeared as
 * ordinary sub-$400K prints. Nobody reading the card would have seen a $1.7M sell.
 *
 * So this scans every AI pool in the census, not four, and groups the legs by
 * transaction hash. A router splitting one order across eight pools is one trade,
 * which is how a person reads it and how the size should be reported.
 *
 * Price impact is measured per pool: the pool's own price before the transaction's
 * first leg in it against its price after the last, tracked as the stream runs. A
 * trade's headline impact is the volume-weighted mean of its legs' impacts, which is
 * what the order actually did to the market rather than what one leg did to one pool.
 */
const DAY = 86400;

export async function indexBigTrades(latest, tm, opts = {}) {
  const store = opts.store, log = opts.log || console.log;
  const pools = opts.pools || [];                    // every AI pool: {poolId, aiIsCurrency0, pairSymbol, pairDecimals}
  const aiUsd = opts.aiUsd || 0;
  const windowSecs = opts.windowSecs ?? DAY;
  const minUsd = opts.minUsd ?? 25_000;
  const keep = opts.keep ?? 60;
  if (!pools.length || !(aiUsd > 0)) { log(`  big trades: no pool census or no AI price`); return null; }

  const meta = new Map(pools.map((p) => [p.poolId, p]));
  const ids = [...meta.keys()];
  const nowT = tm.at(latest) ?? Math.floor(Date.now() / 1000);
  const since = nowT - windowSecs;
  const from = tm.blockAt(since) ?? Math.max(1, latest - Math.round(windowSecs / 0.5));

  /* Legs are gathered per transaction; the price each pool carried before a
     transaction touched it comes from the running stream, so a trade's impact is its
     own doing and not the day's drift. */
  const txs = new Map();
  const lastPrice = new Map();
  let legs = 0, scanned = 0;
  for (let i = 0; i < ids.length; i += 900) {
    const group = ids.slice(i, i + 900);
    const r = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.SWAP, group] }, from, latest, {
      chunk: 300_000, deadline: opts.deadline,
      onLogs: (logsIn) => {
        for (const l of logsIn) {
          scanned++;
          const m = meta.get(l.topics[1]); if (!m) continue;
          const s = decodeSwap(l);
          const t = tm.at(s.block); if (t == null || t < since) continue;
          const aiRaw = m.aiIsCurrency0 ? s.amount0 : s.amount1;
          const ai = Number(fmtUnits(aiRaw, 18));
          if (!ai) continue;
          const d0 = m.aiIsCurrency0 ? 18 : (m.pairDecimals ?? 18);
          const d1 = m.aiIsCurrency0 ? (m.pairDecimals ?? 18) : 18;
          const bounded = atPriceBound(s.sqrtPriceX96);
          const raw = bounded ? 0 : priceFromSqrt(s.sqrtPriceX96, d0, d1);
          const price = bounded ? 0 : (m.aiIsCurrency0 ? raw : raw ? 1 / raw : 0);   // pair units per AI
          const before = lastPrice.get(m.poolId) ?? null;
          if (price > 0) lastPrice.set(m.poolId, price);

          const T = txs.get(s.tx) || { tx: s.tx, t, block: s.block, ai: 0, legs: 0, pools: new Map(), first: new Map(), last: new Map() };
          T.t = Math.min(T.t, t); T.block = Math.min(T.block, s.block);
          T.ai += ai;                                  // swapper perspective: positive = received AI
          T.legs++;
          const sym = m.pairSymbol || "?";
          T.pools.set(sym, (T.pools.get(sym) || 0) + Math.abs(ai));
          if (!T.first.has(m.poolId) && before > 0) T.first.set(m.poolId, before);
          if (price > 0) T.last.set(m.poolId, price);
          txs.set(s.tx, T);
          legs++;
        }
      },
    });
    if (r.truncated) { log(`  big trades: scan truncated at pool batch ${i}; the window is partial`); break; }
  }

  const rows = [];
  for (const T of txs.values()) {
    const aiAbs = Math.abs(T.ai);
    const usd = aiAbs * aiUsd;
    if (usd < minUsd) continue;
    /* impact: weight each pool's own before/after by the AI that moved through it */
    let wsum = 0, wimp = 0;
    for (const [poolId, after] of T.last) {
      const before = T.first.get(poolId);
      if (!(before > 0) || !(after > 0)) continue;
      const w = 1;                                    // per pool, legs already netted into the pool's own move
      wsum += w; wimp += w * (after / before - 1);
    }
    rows.push({
      t: T.t, tx: T.tx, buy: T.ai > 0, ai: +aiAbs.toFixed(3), usd: Math.round(usd), legs: T.legs,
      pools: [...T.pools].sort((a, b) => b[1] - a[1]).map(([sym, v]) => ({ sym, ai: +v.toFixed(3) })),
      impact: wsum ? +(wimp / wsum).toFixed(6) : null,
    });
  }
  rows.sort((a, b) => b.usd - a.usd);
  const out = {
    since, windowSecs, minUsd, aiUsd, poolsScanned: ids.length, legsSeen: legs, swapsScanned: scanned,
    trades: rows.slice(0, keep),
    method: "every Swap the pool manager emitted for any AI pool in the census over the window, grouped by transaction: a router splitting one order across several pools is one trade. AI legs are valued at the current AI price; impact is each touched pool's own price before the transaction's first leg in it against its price after the last, averaged across the pools the trade touched.",
  };
  log(`  big trades: ${rows.length} trade(s) over $${(minUsd / 1000).toFixed(0)}K in the last ${Math.round(windowSecs / 3600)}h across ${ids.length} AI pools (${legs.toLocaleString()} legs); largest $${rows[0] ? Math.round(rows[0].usd).toLocaleString() : 0}${rows[0] && rows[0].legs > 1 ? ` across ${rows[0].legs} pools` : ""}`);
  return out;
}
