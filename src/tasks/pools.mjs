import { POOL_MANAGER, AI, GENESIS_BLOCK, DYNAMIC_FEE_FLAG, LONG_HOOK } from "../config.mjs";
import { getLogsRange, getLogsByTopicSet, padAddr } from "../rpc.mjs";
import { TOPICS, decodeInitialize, decodeSwap, priceFromSqrt } from "../decode.mjs";
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

  log("  scanning Initialize events for AI pools...");
  const asC0 = await getLogsRange(
    { address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, padAddr(AI)] },
    GENESIS_BLOCK, latest, { chunk: 25_000_000 }
  );
  const asC1 = await getLogsRange(
    { address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, null, padAddr(AI)] },
    GENESIS_BLOCK, latest, { chunk: 25_000_000 }
  );
  const pools = [...asC0, ...asC1].map(decodeInitialize);
  log(`  found ${pools.length} pools containing AI (${asC0.length} as currency0, ${asC1.length} as currency1)`);

  // Measure activity so dust can be dropped.
  const ids = pools.map((p) => p.poolId);
  const from = Math.max(GENESIS_BLOCK, latest - activityWindow);
  log(`  measuring swap activity across ${ids.length} pools over ${activityWindow.toLocaleString()} blocks...`);
  const swaps = await getLogsByTopicSet(POOL_MANAGER, TOPICS.SWAP, ids, from, latest, {
    groupSize: 300, chunk: activityWindow,
  });
  log(`  ${swaps.length} swaps in window`);

  const act = new Map();
  for (const l of swaps) {
    const s = decodeSwap(l);
    let a = act.get(s.poolId);
    if (!a) act.set(s.poolId, (a = { n: 0, absAI: 0n, last: null, senders: new Set() }));
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
  const meta = await resolveTokens([...new Set(toName)]);
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
  return { all, active };
}
