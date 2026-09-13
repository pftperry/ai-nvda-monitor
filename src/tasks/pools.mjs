import { POOL_MANAGER, AI, GENESIS_BLOCK, DYNAMIC_FEE_FLAG, LONG_HOOK } from "../config.mjs";
import { getLogsRange, getLogsByTopicSet, padAddr } from "../rpc.mjs";
import { TOPICS, decodeInitialize, decodeSwap, priceFromSqrt, fmtUnits } from "../decode.mjs";
import { resolveTokens } from "../tokens.mjs";

/**
 * Discover every v4 pool that contains AI, then rank by real activity.
 *
 * v4 lets anyone initialise a pool for any (pair, fee, tickSpacing, hook) combo, and
 * the LONG launchpad creates one per token launch, so raw existence is meaningless:
 * there are thousands of pools with AI and almost all are dust. Ranking by measured
 * swap activity in a recent window is what separates real venues from noise.
 */
export async function discoverPools(latest, opts = {}) {
  const activityWindow = opts.activityWindow ?? 2_000_000; // ~2.4 days
  const log = opts.log || console.log;

  /* The pool catalogue is append-only -- a pool, once initialised, never
     un-initialises -- so it resumes from a cursor like everything else. A refresh
     then costs two small queries instead of two full-history scans. */
  const known = opts.knownPools;
  const catalogueFrom = known && known.cursor ? Math.max(GENESIS_BLOCK, known.cursor + 1) : GENESIS_BLOCK;
  log(known && known.cursor
    ? `  scanning Initialize from block ${catalogueFrom.toLocaleString()} (${known.pools.length} pools already known)...`
    : "  scanning Initialize events for AI pools...");
  const asC0 = await getLogsRange(
    { address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, padAddr(AI)] },
    catalogueFrom, latest, { chunk: 25_000_000 }
  );
  const asC1 = await getLogsRange(
    { address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, null, padAddr(AI)] },
    catalogueFrom, latest, { chunk: 25_000_000 }
  );
  const fresh = [...asC0, ...asC1].map(decodeInitialize);
  // Stored entries come back with sqrtPriceX96 as a string; restore the bigint.
  const restored = (known && known.pools ? known.pools : []).map((p) => ({ ...p, sqrtPriceX96: BigInt(p.sqrtPriceX96) }));
  const pools = [...restored, ...fresh];
  if (opts.store) {
    opts.store.set("poolCatalogue", {
      cursor: latest,
      pools: pools.map((p) => ({ ...p, sqrtPriceX96: String(p.sqrtPriceX96) })),
    });
  }
  log(`  ${pools.length} pools contain AI (${fresh.length} new this run)`);

  // Measure activity so dust can be dropped.
  const ids = pools.map((p) => p.poolId);
  const from = Math.max(GENESIS_BLOCK, latest - activityWindow);
  log(`  measuring swap activity across ${ids.length} pools over ${activityWindow.toLocaleString()} blocks...`);
  const swaps = await getLogsByTopicSet(POOL_MANAGER, TOPICS.SWAP, ids, from, latest, {
    groupSize: 960, chunk: activityWindow,
  });
  log(`  ${swaps.length} swaps in window`);

  const act = new Map();
  const decoded = [];
  for (const l of swaps) {
    const s = decodeSwap(l);
    decoded.push(s);
    let a = act.get(s.poolId);
    if (!a) act.set(s.poolId, (a = { n: 0, last: null, senders: new Set() }));
    a.n++;
    a.last = s;
    a.senders.add(s.sender);
  }

  const byId = new Map();
  for (const p of pools) {
    const aiIsC0 = p.currency0 === AI;
    const other = aiIsC0 ? p.currency1 : p.currency0;
    const a = act.get(p.poolId);
    // a pool can be initialised twice only if re-inited; keep the first sighting
    if (byId.has(p.poolId)) continue;
    byId.set(p.poolId, {
      poolId: p.poolId,
      aiIsCurrency0: aiIsC0,
      pairToken: other,
      fee: p.fee,
      dynamicFee: p.fee === DYNAMIC_FEE_FLAG,
      tickSpacing: p.tickSpacing,
      hooks: p.hooks,
      isLongHook: p.hooks === LONG_HOOK,
      createdBlock: p.block,
      swapsInWindow: a ? a.n : 0,
      uniqueSendersInWindow: a ? a.senders.size : 0,
      lastFeePips: a && a.last ? a.last.fee : null,
      lastLiquidity: a && a.last ? a.last.liquidity.toString() : "0",
      lastSqrtPriceX96: a && a.last ? a.last.sqrtPriceX96.toString() : p.sqrtPriceX96.toString(),
    });
  }

  const all = [...byId.values()].sort((x, y) => y.swapsInWindow - x.swapsInWindow);
  const active = all.filter((p) => p.swapsInWindow > 0);
  log(`  ${active.length} pools saw at least one swap; ${all.length - active.length} are dormant`);

  // Resolve symbols only for pools worth naming.
  const toName = active.slice(0, opts.nameTop ?? 120).map((p) => p.pairToken);
  const meta = await resolveTokens([...new Set(toName)], { log });
  for (const p of all) {
    const m = meta.get(p.pairToken);
    p.pairSymbol = m ? m.symbol : null;
    p.pairDecimals = m ? m.decimals : 18;
    if (m) {
      const d0 = p.aiIsCurrency0 ? 18 : m.decimals;
      const d1 = p.aiIsCurrency0 ? m.decimals : 18;
      const price = priceFromSqrt(BigInt(p.lastSqrtPriceX96), d0, d1);
      // express as pair-token units per AI
      p.priceInPairToken = p.aiIsCurrency0 ? price : (price ? 1 / price : 0);
    }
  }
  // The ranking window's own swaps seed the routing index for free.
  const seed = buildTxIndex(decoded, all);
  return { all, active, seedTxIndex: seed, seedFrom: from };
}

/** Flat per tx: [block, poolIdx, aiAmount, poolIdx, aiAmount, ...] into `all`. */
function buildTxIndex(decodedSwaps, all, into = new Map()) {
  const pos = new Map(all.map((p, i) => [p.poolId, i]));
  for (const s of decodedSwaps) {
    const i = pos.get(s.poolId);
    if (i === undefined) continue;
    const ai = fmtUnits(all[i].aiIsCurrency0 ? s.amount0 : s.amount1, 18);
    let arr = into.get(s.tx);
    if (!arr) into.set(s.tx, (arr = [s.block]));
    arr.push(i, ai);
  }
  return into;
}

/**
 * Transaction index for cross-routing, over a longer window than ranking uses.
 *
 * Ranking and routing want different things, and conflating them is expensive.
 * Ranking must consider all ~5,400 pools but only needs a short window; routing
 * wants several days but only needs the ~470 pools that actually trade. Querying
 * all 5,400 ids over a multi-day window is the worst of both: each OR-group
 * breaches the 10,000-log cap repeatedly, and every breach costs a full
 * server-side scan that returns nothing. Scanning only active pools cuts the
 * id set by more than 10x and makes each query far more selective.
 */
export async function buildRoutingIndex(all, active, latest, opts = {}) {
  const log = opts.log || console.log;
  const window = opts.window ?? 2_000_000;
  const seed = opts.seed;
  const seedFrom = opts.seedFrom ?? latest;
  // An explicit start wins over the window: the caller aligns it to a day boundary
  // or to a stored cursor, both of which a plain "latest minus N" cannot express.
  const from = Math.max(GENESIS_BLOCK, opts.from ?? (latest - window));

  const txIndex = seed || new Map();
  // The seed already covers [seedFrom, latest]; only fetch what it is missing.
  const need = Math.min(seedFrom - 1, latest);
  if (from <= need) {
    const ids = active.map((p) => p.poolId);
    log(`  extending routing index back ${(need - from + 1).toLocaleString()} blocks over ${ids.length} active pools...`);
    const logs = await getLogsByTopicSet(POOL_MANAGER, TOPICS.SWAP, ids, from, need, {
      groupSize: 960, chunk: Math.min(1_000_000, window),
    });
    buildTxIndex(logs.map(decodeSwap), all, txIndex);
  }
  log(`  routing index: ${txIndex.size.toLocaleString()} transactions across ${active.length} active AI pools`);
  return { txIndex, routingFrom: from };
}
