import { getLogsRange } from "../rpc.mjs";
import { POOL_MANAGER, LONG_GENESIS_BLOCK, USDG } from "../config.mjs";
import { TOPICS, decodeSwap, priceFromSqrt } from "../decode.mjs";
import { CHAINLINK_FEEDS } from "./rwa.mjs";

/**
 * Daily dollar closes for the stocks behind the backing pairs, so the backfill can
 * be read in USDG rather than in shares of the stock.
 *
 * Where a stock has a Chainlink aggregator on the chain (the feeds LONG's own
 * dashboard prices from), its AnswerUpdated events are the price history: about a
 * thousand updates per feed since inception, no update on days the market is
 * closed. The last update on or before the end of each UTC day is that day's close,
 * carried forward over days without one. Where a stock has no feed, the deepest
 * stock/USDG pool's own Swap tape supplies the close instead (last sqrtPrice of the
 * day), which is what the pool-priced rows on the RWA tab already use for today.
 *
 * Cursor per stock, resumed across runs, shared deadline.
 */
const DAY = 86400;
export const ANSWER_UPDATED = "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f";   // AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)

export async function indexStockPrices(latest, tm, opts = {}) {
  const store = opts.store, log = opts.log || console.log, deadline = opts.deadline || Date.now() + 120_000;
  const stocks = opts.stocks || [], usdgPools = opts.usdgPools || [], rank = opts.rank, decimals = opts.decimals;
  const t0 = Date.now();
  let PX = store && store.get("stockPx");
  if (!PX || PX.v !== 1) PX = { v: 1, stocks: {} };
  /* The deepest USDG pool per stock, for the ones without a feed. */
  const bestPool = new Map();
  for (const p of usdgPools) {
    const other = p.c0 === USDG ? p.c1 : p.c0;
    if (other === USDG) continue;
    const n = rank?.counts?.get(p.id) || 0;
    if (!bestPool.has(other) || bestPool.get(other).n < n) bestPool.set(other, { p, n });
  }
  let streamed = 0, atHead = 0;
  for (const s of stocks) {
    if (Date.now() >= deadline) break;
    const feed = CHAINLINK_FEEDS[s.token], pool = feed ? null : bestPool.get(s.token)?.p;
    if (!feed && !pool) continue;
    const S = (PX.stocks[s.token] ||= { symbol: s.symbol, source: feed ? "chainlink" : "pool", poolId: pool?.id || null, cursor: LONG_GENESIS_BLOCK - 1, days: {}, partial: true });
    if (S.cursor >= latest) { atHead++; continue; }
    const slice = Math.min(deadline, Date.now() + Math.max(20_000, (deadline - Date.now()) * (feed ? 0.2 : 0.4)));
    const fold = (t, blk, usd) => { const D = (S.days[t] ||= { usd: null, blk: 0 }); if (blk >= D.blk && usd > 0 && isFinite(usd)) { D.blk = blk; D.usd = usd; } };
    let r;
    if (feed) {
      r = await getLogsRange({ address: feed, topics: [ANSWER_UPDATED] }, S.cursor + 1, latest, { chunk: 8_000_000, deadline: slice, onLogs: (logs) => {
        for (const l of logs) { const blk = parseInt(l.blockNumber, 16), t = tm.dayBucket(blk); if (t == null) continue; fold(t, blk, Number(BigInt.asIntN(256, BigInt(l.topics[1]))) / 1e8); streamed++; }
      } });
    } else {
      const tokenIsC0 = pool.c0 === s.token, dT = s.decimals ?? decimals?.get(s.token) ?? 18, dU = 6;
      r = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.SWAP, pool.id] }, S.cursor + 1, latest, { chunk: 400_000, deadline: slice, onLogs: (logs) => {
        for (const l of logs) { const blk = parseInt(l.blockNumber, 16), t = tm.dayBucket(blk); if (t == null) continue; const sw = decodeSwap(l); const raw = priceFromSqrt(sw.sqrtPriceX96, tokenIsC0 ? dT : dU, tokenIsC0 ? dU : dT); fold(t, blk, tokenIsC0 ? raw : raw ? 1 / raw : 0); streamed++; }
      } });
    }
    const reach = r.reachedBlock ?? latest;
    if (reach > S.cursor) S.cursor = reach;
    S.partial = !!r.truncated || S.cursor < latest;
    if (!S.partial) atHead++;
  }
  if (store) store.set("stockPx", PX);

  /* Publish complete days as [t, usd], carried forward over days without a print,
     from each stock's first close to yesterday. */
  const todayStart = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const out = {};
  for (const s of stocks) {
    const S = PX.stocks[s.token]; if (!S) continue;
    const keys = Object.keys(S.days).map(Number).filter((t) => t < todayStart && S.days[t].usd > 0).sort((a, b) => a - b);
    if (!keys.length) { out[s.token] = { symbol: S.symbol, source: S.source, poolId: S.poolId, partial: S.partial, close: [] }; continue; }
    const close = []; let last = null;
    for (let t = keys[0]; t < todayStart; t += DAY) { if (S.days[t]?.usd > 0) last = S.days[t].usd; close.push([t, +last.toPrecision(8)]); }
    out[s.token] = { symbol: S.symbol, source: S.source, poolId: S.poolId, partial: S.partial, prints: keys.length, close };
  }
  const summary = { stocks: stocks.length, atHead, streamedThisRun: streamed, secs: Math.round((Date.now() - t0) / 1000),
    method: "Chainlink AnswerUpdated events per feed (last update on or before each UTC day's end is the close, carried forward over days without one); the deepest stock/USDG pool's last Swap of the day where a stock has no feed" };
  log(`  stock closes: ${atHead} of ${stocks.length} stock(s) at the head, ${streamed.toLocaleString()} prints folded this run, ${summary.secs}s`);
  return { ...summary, stocks: out };
}

/** Lookup helper: token → (day t → usd), from the published block. */
export function closeLookup(px) {
  const m = new Map();
  for (const [token, s] of Object.entries(px?.stocks || {})) m.set(token, new Map(s.close || []));
  return (token, t) => m.get(token)?.get(t) ?? null;
}
