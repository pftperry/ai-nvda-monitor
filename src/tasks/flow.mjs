import { POOL_MANAGER } from "../config.mjs";
import { getLogsRange } from "../rpc.mjs";
import { TOPICS, decodeSwap, priceFromSqrt, fmtUnits } from "../decode.mjs";

const r6 = (x) => (x === 0 ? 0 : +x.toPrecision(6));

/**
 * Per-pool buy/sell flow, bucketed hourly from every Swap log in the pool's life.
 *
 * Runs are incremental: the previous run's series is passed back in and only new
 * blocks are fetched, which is what makes a scheduled refresh viable against 59
 * days of history.
 */
export async function indexFlow(pools, latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const prev = opts.prev || new Map();   // poolId -> stored series from the last run

  const perPool = [];
  const tape = [];

  for (let idx = 0; idx < pools.length; idx++) {
    const p = pools[idx];
    const hourly = new Map();
    let nSwaps = 0, lastPrice = null, lastLiq = null, lastFee = null;

    /* Resume where the previous run stopped. Hourly buckets are additive, so
       merging a fresh tail onto stored history is exact provided no block is ever
       scanned twice -- hence cursor + 1. Without this, every refresh would re-read
       all 59 days of swaps, which is far too slow for a scheduled job. */
    const old = prev.get(p.poolId);
    const resumeFrom = old && old.cursor ? Math.max(p.createdBlock, old.cursor + 1) : p.createdBlock;
    if (old && old.hourly) {
      for (const h of old.hourly) {
        // baseBuyers/baseSellers carry forward stored distinct-address counts; the
        // sets below only track addresses seen in THIS run's tail.
        hourly.set(h.t, { ...h, baseBuyers: h.buyers || 0, baseSellers: h.sellers || 0, _b: new Set(), _s: new Set() });
      }
      nSwaps = old.totalSwaps || 0;
      lastPrice = old.lastPrice ?? null;
    }

    const logs = resumeFrom > latest ? [] : await getLogsRange(
      { address: POOL_MANAGER, topics: [TOPICS.SWAP, p.poolId] },
      resumeFrom, latest, { chunk: 2_000_000 }
    );

    for (const l of logs) {
      const s = decodeSwap(l);
      nSwaps++;
      // Orient amounts so "ai" is always the AI leg regardless of currency ordering.
      const aiRaw   = p.aiIsCurrency0 ? s.amount0 : s.amount1;
      const pairRaw = p.aiIsCurrency0 ? s.amount1 : s.amount0;
      const ai   = fmtUnits(aiRaw, 18);
      const pair = fmtUnits(pairRaw, p.pairDecimals ?? 18);
      const isBuy = aiRaw > 0n; // swapper receives AI -- see decode.mjs sign proof

      const d0 = p.aiIsCurrency0 ? 18 : (p.pairDecimals ?? 18);
      const d1 = p.aiIsCurrency0 ? (p.pairDecimals ?? 18) : 18;
      const raw = priceFromSqrt(s.sqrtPriceX96, d0, d1);
      const price = p.aiIsCurrency0 ? raw : (raw ? 1 / raw : 0); // pair units per AI

      const h = tm.hourBucket(s.block);
      if (h !== null) {
        let row = hourly.get(h);
        if (!row) hourly.set(h, (row = {
          t: h, buys: 0, sells: 0, aiBuy: 0, aiSell: 0, pairBuy: 0, pairSell: 0,
          close: 0, feePips: 0, baseBuyers: 0, baseSellers: 0, _b: new Set(), _s: new Set(),
        }));
        if (isBuy) { row.buys++; row.aiBuy += ai;  row.pairBuy += -pair; row._b.add(s.sender); }
        else       { row.sells++; row.aiSell += -ai; row.pairSell += pair; row._s.add(s.sender); }
        row.close = price;
        row.feePips = s.fee;
      }
      lastPrice = price; lastLiq = s.liquidity; lastFee = s.fee;

      // A short live tape, kept only for the handful of pools shown in the UI.
      // (Cross-routing is measured in the pool-discovery task instead, which already
      // scans every AI pool over its window.)
      if (idx < 4) {
        tape.push({ t: tm.at(s.block), pool: idx, buy: isBuy, ai: r6(Math.abs(ai)), pair: r6(Math.abs(pair)), price: r6(price), tx: s.tx });
      }
    }

    const series = [...hourly.values()].sort((a, b) => a.t - b.t).map((row) => ({
      t: row.t, buys: row.buys, sells: row.sells,
      aiBuy: r6(row.aiBuy), aiSell: r6(row.aiSell),
      pairBuy: r6(row.pairBuy), pairSell: r6(row.pairSell),
      buyers: (row.baseBuyers || 0) + row._b.size,
      sellers: (row.baseSellers || 0) + row._s.size,
      close: r6(row.close), feePips: row.feePips,
    }));

    perPool.push({
      poolId: p.poolId, pairSymbol: p.pairSymbol, pairToken: p.pairToken,
      pairDecimals: p.pairDecimals ?? 18, aiIsCurrency0: p.aiIsCurrency0,
      fee: p.fee, dynamicFee: p.dynamicFee, lastFeePips: lastFee,
      hooks: p.hooks, isLongHook: p.isLongHook,
      createdBlock: p.createdBlock, createdAt: tm.at(p.createdBlock),
      totalSwaps: nSwaps, lastPrice: r6(lastPrice ?? 0),
      lastLiquidity: lastLiq ? lastLiq.toString() : (old?.lastLiquidity ?? "0"),
      cursor: latest,        // next run resumes from cursor + 1
      hourly: series,
    });
    const tail = logs.length.toLocaleString();
    log(`    ${(p.pairSymbol || "?").padEnd(10)} ${nSwaps.toString().padStart(8)} swaps total  ${series.length} buckets  (+${tail} new)`);
  }

  tape.sort((a, b) => b.t - a.t);
  return { perPool, tape: tape.slice(0, 400) };
}

/** Rolling buy/sell imbalance over the trailing `hours` window. */
export function rollup(hourly, hours, nowSec) {
  const cut = nowSec - hours * 3600;
  const w = hourly.filter((h) => h.t >= cut);
  const aiBuy = w.reduce((s, h) => s + h.aiBuy, 0);
  const aiSell = w.reduce((s, h) => s + h.aiSell, 0);
  const buys = w.reduce((s, h) => s + h.buys, 0);
  const sells = w.reduce((s, h) => s + h.sells, 0);
  const total = aiBuy + aiSell;
  return {
    hours, buys, sells, aiBuy: r6(aiBuy), aiSell: r6(aiSell),
    netAI: r6(aiBuy - aiSell),
    imbalance: total > 0 ? +((aiBuy - aiSell) / total).toFixed(4) : 0,
    buyers: w.reduce((s, h) => s + h.buyers, 0),
    sellers: w.reduce((s, h) => s + h.sellers, 0),
    priceChange: w.length > 1 && w[0].close ? +((w[w.length - 1].close / w[0].close - 1) * 100).toFixed(3) : 0,
  };
}
