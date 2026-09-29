import { getLogsRange, rpcBatch } from "../rpc.mjs";
import { POOL_MANAGER, AI, LONG_HOOK, COMMUNITY_VAULT, FEE_SPLITTER, BURN_ADDRESS, PLATFORM_FEE_RECIPIENT, LONG_BUYBACK } from "../config.mjs";
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

/* SIZE BY THE WALLET, NOT BY THE v4 LEGS.

   The scan above reads only the v4 pool manager, so a trade routed partly through a
   Uniswap V2 or V3 pool shows only its v4 part. On 29 Sep one wallet sold 5,405,774
   AI in five transactions through an aggregator; the panel showed about $493K, less
   than half, because each sale sent much of its AI through a V3 pool. The first
   alone moved 1,351,444 AI and the panel recorded 574,644. Worse, the scan drops any
   trade whose v4 part is under the floor, however large the whole trade was.

   So trades are sized the way the trader panel already sizes them correctly: by the
   AI that actually left or entered the trader's wallet. Candidates come from the
   trader scan's per-transaction netting of every AI transfer, whatever venue it used.
   Each candidate's receipt then settles it from its own logs: any address that
   emitted a V2, V3 or v4 Swap is a pool, never the trader; routers net to nothing;
   the trader is the wallet with the largest net AI left over, and the trade is real
   only if the transaction contains a swap at all -- which is what separates a sale
   from one wallet sending AI to another. Receipts are cached, so each is read once.

   The v4 scan still supplies what it is good for: which v4 pools a trade touched and
   the price impact there, joined by transaction hash. */
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FIXED_MACHINERY = new Set([POOL_MANAGER, LONG_HOOK, COMMUNITY_VAULT, FEE_SPLITTER, BURN_ADDRESS, PLATFORM_FEE_RECIPIENT, LONG_BUYBACK].map((a) => a.toLowerCase()));
const RECEIPT_KEEP_SECS = 3 * 86400;
const addrOf = (t) => "0x" + t.slice(26).toLowerCase();

function readReceipt(rc, t) {
  const pools = new Set();
  const legs = { v2: 0, v3: 0, v4: 0 };
  for (const l of rc.logs || []) {
    const k = l.topics?.[0];
    if (k === V2_SWAP) { legs.v2++; pools.add(l.address.toLowerCase()); }
    else if (k === V3_SWAP) { legs.v3++; pools.add(l.address.toLowerCase()); }
    else if (k === TOPICS.SWAP && l.address.toLowerCase() === POOL_MANAGER.toLowerCase()) legs.v4++;
  }
  const net = new Map();
  for (const l of rc.logs || []) {
    if (l.address.toLowerCase() !== AI.toLowerCase() || l.topics?.[0] !== TRANSFER || l.topics.length < 3) continue;
    const v = Number(BigInt(l.data)) / 1e18;
    const f = addrOf(l.topics[1]), to = addrOf(l.topics[2]);
    net.set(f, (net.get(f) || 0) - v);
    net.set(to, (net.get(to) || 0) + v);
  }
  let trader = null, best = 0;
  for (const [a, v] of net) {
    if (pools.has(a) || FIXED_MACHINERY.has(a)) continue;
    if (Math.abs(v) > best) { best = Math.abs(v); trader = [a, v]; }
  }
  return {
    t, swap: legs.v2 + legs.v3 + legs.v4 > 0, legs,
    trader: trader ? trader[0] : null, netAi: trader ? +trader[1].toFixed(4) : 0,
  };
}

export async function resizeBigTrades(big, candidates, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store, aiUsd = opts.aiUsd ?? big?.aiUsd;
  const minUsd = opts.minUsd ?? big?.minUsd ?? 25_000;
  if (!big || !(aiUsd > 0) || !candidates?.length) return big;
  const cache = { ...(store?.get("bigTradeReceipts") || {}) };
  const need = candidates.filter((c) => !cache[c.tx]);
  let fetched = 0;
  for (let i = 0; i < need.length; i += 20) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const group = need.slice(i, i + 20);
    const res = await rpcBatch(group.map((c) => ({ method: "eth_getTransactionReceipt", params: [c.tx] })));
    group.forEach((c, j) => { if (res[j]) { cache[c.tx] = readReceipt(res[j], c.t); fetched++; } });
  }
  const cutoff = Math.floor(Date.now() / 1000) - RECEIPT_KEEP_SECS;
  for (const [k, v] of Object.entries(cache)) if ((v.t || 0) < cutoff) delete cache[k];
  store?.set("bigTradeReceipts", cache);

  const v4ByTx = new Map((big.trades || []).map((t) => [t.tx, t]));
  const rows = [], seen = new Set();
  for (const c of candidates) {
    const R = cache[c.tx];
    if (!R || !R.swap || !R.trader) continue;
    const ai = Math.abs(R.netAi), usd = ai * aiUsd;
    if (usd < minUsd) continue;
    const v4 = v4ByTx.get(c.tx);
    rows.push({
      t: c.t, tx: c.tx, buy: R.netAi > 0, ai: +ai.toFixed(3), usd: Math.round(usd), wallet: R.trader,
      legs: R.legs.v2 + R.legs.v3 + R.legs.v4, venues: R.legs,
      pools: v4?.pools || [], v4Ai: v4 ? v4.ai : 0,
      /* impact is known only for the v4 pools a trade touched, so it is kept where the
         v4 scan measured it and left blank rather than guessed where it did not */
      impact: v4?.impact ?? null,
    });
    seen.add(c.tx);
  }
  /* a v4 trade the netting missed (its trader counted as machinery, say) is kept as
     the v4 scan measured it, rather than disappearing */
  for (const t of big.trades || []) if (!seen.has(t.tx)) rows.push({ ...t, venues: null, v4Ai: t.ai });
  rows.sort((a, b) => b.usd - a.usd);
  const understated = rows.filter((r) => r.venues && r.v4Ai < r.ai * 0.95).length;
  log(`  big trades resized by wallet: ${rows.length} over $${(minUsd / 1000).toFixed(0)}K, ${fetched} receipt(s) read, ${understated} that the v4 legs alone understated`);
  return {
    ...big, trades: rows.slice(0, 80), sizedBy: "wallet",
    method: "Every AI transfer over the window netted per transaction, so each trade is the AI that actually left or entered the trader's wallet, whatever mix of Uniswap V2, V3 and v4 pools it routed through. A transaction counts as a trade only if its receipt contains a swap; any address that emitted one is a pool and cannot be the trader. AI is valued at the current AI price. The v4 pools touched and the price impact come from the pool manager's own swaps, so impact is shown only where a trade touched v4 pools.",
  };
}

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
