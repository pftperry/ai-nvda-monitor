import { getLogsRange } from "../rpc.mjs";
import { POOL_MANAGER, GENESIS_BLOCK } from "../config.mjs";
import { TOPICS, decodeSwap } from "../decode.mjs";

/**
 * Backfill of the backing table, per tracked pair, from the pool's own Swap tape.
 *
 * The forward history records each pair every four hours from 16 Sep 2026; this
 * rebuilds the same measures backwards so the metrics can be tested against price
 * action instead of waiting for a month of points. For each pair's main LONG pool,
 * every Swap the pool manager emitted for it (topic 1 is the pool id) is folded into
 * UTC days: the stock leg's pool-perspective delta (Dune's swap-delta definition of
 * what a pool holds), the gross stock traded, the swap count, and the day's closing
 * sqrtPrice. The level of stock is anchored to today's exact position-replay figure
 * and walked backwards through the daily deltas, so the two histories meet at the
 * head. Prices are in the stock (AI per NVDA share, say), which is what the
 * pair's chart trades and what removes the stock's own moves from the test; the
 * asset's supply is taken as today's (launches mint once; burns are small).
 *
 * One cursor per pool, resumed across runs, with a shared deadline: the largest
 * pool (AI/NVDA, thousands of swaps an hour) may take several runs to reach sixty
 * days back, and says so.
 */
const DAY = 86400, BACK_DAYS = 60;

export async function indexBackingBackfill(latest, tm, opts = {}) {
  const store = opts.store, log = opts.log || console.log, deadline = opts.deadline || Date.now() + 120_000;
  const timeLeft = () => Date.now() < deadline;
  const pairs = opts.pairs || [];
  const t0 = Date.now();
  let BF = store && store.get("backingBackfill");
  if (!BF || BF.v !== 1) BF = { v: 1, pools: {} };
  const startBlock = Math.max(GENESIS_BLOCK, tm.blockAt(Math.floor(Date.now() / 1000) - BACK_DAYS * DAY) ?? GENESIS_BLOCK);
  let streamed = 0, done = 0;
  for (const p of pairs) {
    if (!timeLeft()) break;
    const P = (BF.pools[p.poolId] ||= { cursor: Math.max(startBlock, p.createdBlock || 0) - 1, days: {}, first: null });
    P.first ??= P.cursor + 1;
    if (P.cursor + 1 > latest) { done++; continue; }
    const snap = JSON.stringify(P.days);
    const r = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.SWAP, p.poolId] }, P.cursor + 1, latest, {
      chunk: 300_000, deadline,
      onLogs: (logs) => {
        for (const l of logs) {
          const s = decodeSwap(l), d = tm.dayBucket(s.block ?? parseInt(l.blockNumber, 16)); if (d == null) continue;
          const D = (P.days[d] ||= { net: 0, gross: 0, swaps: 0, last: null, lastBlock: 0 });
          const stockAmt = Number(p.stockSide === 0 ? s.amount0 : s.amount1) / 10 ** (p.stockDecimals ?? 18);   // swapper's delta: positive = swapper received stock
          D.net -= stockAmt; D.gross += Math.abs(stockAmt); D.swaps++;
          const blk = parseInt(l.blockNumber, 16);
          if (blk >= D.lastBlock) { D.lastBlock = blk; D.last = s.sqrtPriceX96.toString(); }
          streamed++;
        }
      },
    });
    const reach = r.reachedBlock ?? latest;
    if (reach < P.cursor + 1) { P.days = JSON.parse(snap); P.partial = true; continue; }
    P.cursor = reach; P.partial = !!r.truncated;
    if (!P.partial) done++;
  }
  if (store) store.set("backingBackfill", BF);

  /* Publish: per pair, complete UTC days with the stock level walked back from today's
     exact figure, the day's close in the stock, market cap in stock, and backing. */
  const todayStart = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const out = {};
  for (const p of pairs) {
    const P = BF.pools[p.poolId]; if (!P) continue;
    const keys = Object.keys(P.days).map(Number).sort((a, b) => a - b).filter((t) => t < todayStart);
    if (!keys.length) { out[p.asset] = { symbol: p.symbol, anchorSymbol: p.anchorSymbol, cursor: P.cursor, partial: !!P.partial, days: [] }; continue; }
    /* stock units at each day's close: today's exact units less every later day's net (today's own bucket included) */
    const laterNet = Object.entries(P.days).filter(([t]) => Number(t) >= todayStart).reduce((s, [, v]) => s + v.net, 0);
    /* The level walk needs every day between the stream's reach and today; until the
       stream is at the head the levels (and backing, share) are withheld, and only
       the day's own flow, activity and price are published. */
    const atHead = !P.partial && P.cursor >= latest;
    let level = atHead ? (p.stockUnits ?? 0) - laterNet : null;
    const rows = [];
    for (let i = keys.length - 1; i >= 0; i--) {
      const t = keys[i], D = P.days[t];
      const sq = D.last ? Number(BigInt(D.last)) / 2 ** 96 : null;
      const stockIs0 = p.stockSide === 0, dec = p.decimals ?? 18, sdec = p.stockDecimals ?? 18;
      const p1per0 = sq ? sq * sq * 10 ** ((stockIs0 ? sdec : dec) - (stockIs0 ? dec : sdec)) : null;
      const priceInStock = p1per0 == null ? null : stockIs0 ? (p1per0 > 0 ? 1 / p1per0 : null) : p1per0;
      const mcapInStock = priceInStock && p.supply > 0 ? priceInStock * p.supply : null;
      rows.push({ t, units: level == null ? null : +level.toFixed(4), net: +D.net.toFixed(4), gross: +D.gross.toFixed(4), swaps: D.swaps, priceInStock, mcapInStock,
        backing: level != null && mcapInStock > 0 ? level / mcapInStock : null, share: level != null && p.stockSupply > 0 ? level / p.stockSupply : null, turnover: mcapInStock > 0 ? D.gross / mcapInStock : null });
      if (level != null) level -= D.net;   // the level at the previous day's close
    }
    rows.reverse();
    out[p.asset] = { symbol: p.symbol, anchorSymbol: p.anchorSymbol, poolId: p.poolId, cursor: P.cursor, partial: !!P.partial, from: P.first, days: rows };
  }
  const summary = { since: Math.floor(Date.now() / 1000) - BACK_DAYS * DAY, backDays: BACK_DAYS, pairs: pairs.length, complete: done, streamedThisRun: streamed, secs: Math.round((Date.now() - t0) / 1000),
    method: "each pair's main LONG pool's Swap events folded into UTC days: pool-perspective stock delta (Dune's swap-delta definition), gross stock traded, swap count, closing sqrtPrice; the stock level is today's position-replay figure walked back through the deltas; prices are in the stock; the asset's supply is today's" };
  log(`  backing backfill: ${done} of ${pairs.length} pair(s) at the head, ${streamed.toLocaleString()} swaps folded this run, ${Object.values(out).reduce((s, o) => s + o.days.length, 0)} pair-days published, ${summary.secs}s`);
  return { ...summary, pools: out };
}
