import { getLogsRange } from "../rpc.mjs";
import { POOL_MANAGER, LONG_GENESIS_BLOCK } from "../config.mjs";
import { TOPICS, decodeSwap } from "../decode.mjs";
import { multicall, resolveTokens } from "../tokens.mjs";

/**
 * Backfill of the backing table, per pair, from the pool's own Swap tape.
 *
 * The forward history records each pair every four hours from 16 Sep 2026; this
 * rebuilds the same measures backwards so the metrics can be tested against price
 * action instead of waiting for a month of points. For each pair's main LONG pool,
 * every Swap the pool manager emitted for it (topic 1 is the pool id), from the
 * pool's creation, is folded into UTC days: the stock leg's pool-perspective delta,
 * the gross stock traded, the swap count, and the day's closing sqrtPrice. The
 * stock level is the running sum of those deltas from creation (Dune's swap-delta
 * definition of what a pool holds: an upper bound, since fee legs leave a pool
 * without a Swap, but internally consistent day to day), with today's exact
 * position-replay figure published beside it for scale. Prices are in the stock
 * (AI per NVDA share, say), which is what the pair's chart trades and what removes
 * the stock's own moves from the test; the asset's supply is taken as today's
 * (launches mint once; burns are small).
 *
 * Two kinds of pair are streamed. The tracked pairs are the ones on the Backing
 * tab today. The cohort is a deterministic sample of LONG stock pairs launched at
 * least thirty days ago, whatever became of them, because a test run on today's
 * survivors alone cannot tell winners from losers: it contains no losers.
 *
 * One cursor per pool, resumed across runs, with a shared deadline: the largest
 * pool (AI/NVDA, thousands of swaps an hour) takes several runs and says so.
 */
const DAY = 86400, SUPPLY_SEL = "0x18160ddd";

/* A sample of LONG stock pairs by launch date, chosen by the low bits of the pool id
   so the same pools are picked every run and nothing about their outcome enters the
   choice. `pools` is the census (id, c0, c1, block); `stocks` maps a stock token to
   its row (decimals, supply, symbol). */
export async function cohortPairs(pools, stocks, latest, tm, opts = {}) {
  const count = opts.count ?? 40, minAgeDays = opts.minAgeDays ?? 30;
  const cutoff = tm.blockAt(Math.floor(Date.now() / 1000) - minAgeDays * DAY) ?? latest;
  const cands = pools.filter((p) => p.block && p.block >= LONG_GENESIS_BLOCK && p.block <= cutoff && (stocks.has(p.c0) !== stocks.has(p.c1)))
    .map((p) => ({ ...p, key: parseInt(p.id.slice(-8), 16) })).sort((a, b) => a.key - b.key || a.block - b.block).slice(0, count);
  if (!cands.length) return [];
  const assets = cands.map((p) => (stocks.has(p.c0) ? p.c1 : p.c0));
  const meta = await resolveTokens(assets);
  const sup = await multicall(assets.map((a) => ({ to: a, data: SUPPLY_SEL })));
  return cands.map((p, i) => {
    const stockIs0 = stocks.has(p.c0), stock = stockIs0 ? p.c0 : p.c1, asset = assets[i], s = stocks.get(stock), m = meta.get(asset);
    const dec = m?.decimals ?? 18;
    const supply = sup[i] && sup[i] !== "0x" ? Number(BigInt(sup[i])) / 10 ** dec : 0;
    return { asset, symbol: m?.symbol || asset.slice(0, 8), anchor: stock, anchorSymbol: s.symbol, poolId: p.id, stockSide: stockIs0 ? 0 : 1, stockDecimals: s.decimals ?? 18, decimals: dec,
      createdBlock: p.block, supply, stockSupply: s.supply || null, stockUnits: null, cohort: true };
  });
}

export async function indexBackingBackfill(latest, tm, opts = {}) {
  const store = opts.store, log = opts.log || console.log, deadline = opts.deadline || Date.now() + 120_000;
  const timeLeft = () => Date.now() < deadline;
  const pairs = opts.pairs || [];
  const t0 = Date.now();
  let BF = store && store.get("backingBackfill");
  if (!BF || BF.v !== 2) BF = { v: 2, pools: {} };
  let streamed = 0, done = 0;
  /* Cohort pools first (small tapes, and the test is worthless without them), then
     the tracked pairs; no single pool may take more than a third of what is left,
     so AI's tape cannot starve the rest. Cursors resume next run regardless. */
  const order = [...pairs.filter((p) => p.cohort), ...pairs.filter((p) => !p.cohort)];
  for (const p of order) {
    if (!timeLeft()) break;
    const P = (BF.pools[p.poolId] ||= { cursor: Math.max(LONG_GENESIS_BLOCK, p.createdBlock || LONG_GENESIS_BLOCK) - 1, days: {} });
    P.first ??= P.cursor + 1;
    if (P.cursor + 1 > latest) { done++; continue; }
    const snap = JSON.stringify(P.days);
    const slice = Math.min(deadline, Date.now() + Math.max(45_000, (deadline - Date.now()) * (p.cohort ? 0.15 : 0.34)));
    const r = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.SWAP, p.poolId] }, P.cursor + 1, latest, {
      chunk: 300_000, deadline: slice,
      onLogs: (logs) => {
        for (const l of logs) {
          const s = decodeSwap(l), blk = parseInt(l.blockNumber, 16), d = tm.dayBucket(blk); if (d == null) continue;
          const D = (P.days[d] ||= { net: 0, gross: 0, swaps: 0, last: null, lastBlock: 0 });
          const stockAmt = Number(p.stockSide === 0 ? s.amount0 : s.amount1) / 10 ** (p.stockDecimals ?? 18);   // swapper's delta: positive = swapper received stock
          D.net -= stockAmt; D.gross += Math.abs(stockAmt); D.swaps++;
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

  /* Publish: per pair, complete UTC days with the running swap-delta level from
     creation, the day's close in the stock, market cap in stock, and backing. */
  const todayStart = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const out = {};
  for (const p of pairs) {
    const P = BF.pools[p.poolId]; if (!P) continue;
    const keys = Object.keys(P.days).map(Number).sort((a, b) => a - b).filter((t) => t < todayStart);
    const atHead = !P.partial && P.cursor >= latest;
    let level = 0;
    const rows = [];
    for (const t of keys) {
      const D = P.days[t];
      level += D.net;
      const sq = D.last ? Number(BigInt(D.last)) / 2 ** 96 : null;
      const stockIs0 = p.stockSide === 0, dec = p.decimals ?? 18, sdec = p.stockDecimals ?? 18;
      const p1per0 = sq ? sq * sq * 10 ** ((stockIs0 ? sdec : dec) - (stockIs0 ? dec : sdec)) : null;
      const priceInStock = p1per0 == null ? null : stockIs0 ? (p1per0 > 0 ? 1 / p1per0 : null) : p1per0;
      const mcapInStock = priceInStock && p.supply > 0 ? priceInStock * p.supply : null;
      rows.push({ t, units: +level.toFixed(4), net: +D.net.toFixed(4), gross: +D.gross.toFixed(4), swaps: D.swaps, priceInStock, mcapInStock,
        backing: level > 0 && mcapInStock > 0 ? level / mcapInStock : null, share: level > 0 && p.stockSupply > 0 ? level / p.stockSupply : null, turnover: mcapInStock > 0 ? D.gross / mcapInStock : null });
    }
    /* Today's exact figure from the position replay, for scale against the swap-delta level. */
    const todayNet = Object.entries(P.days).filter(([t]) => Number(t) >= todayStart).reduce((s, [, v]) => s + v.net, 0);
    out[p.asset] = { symbol: p.symbol, anchorSymbol: p.anchorSymbol, poolId: p.poolId, cohort: !!p.cohort, cursor: P.cursor, partial: !atHead, from: P.first, createdBlock: p.createdBlock ?? null,
      unitsNow: p.stockUnits ?? null, unitsDeltaNow: atHead ? +(level + todayNet).toFixed(4) : null, days: rows };
  }
  const summary = { pairs: pairs.length, tracked: pairs.filter((p) => !p.cohort).length, cohort: pairs.filter((p) => p.cohort).length, complete: done, streamedThisRun: streamed, secs: Math.round((Date.now() - t0) / 1000),
    method: "each pair's main LONG pool's Swap events from the pool's creation, folded into UTC days: pool-perspective stock delta summed into a running level (Dune's swap-delta definition, an upper bound), gross stock traded, swap count, closing sqrtPrice; prices in the stock; the asset's supply is today's; the cohort is a deterministic sample of LONG stock pairs launched at least thirty days ago, chosen by pool id" };
  log(`  backing backfill: ${done} of ${pairs.length} pair(s) at the head (${summary.tracked} tracked, ${summary.cohort} cohort), ${streamed.toLocaleString()} swaps folded this run, ${Object.values(out).reduce((s, o) => s + o.days.length, 0)} pair-days published, ${summary.secs}s`);
  return { ...summary, pools: out };
}
