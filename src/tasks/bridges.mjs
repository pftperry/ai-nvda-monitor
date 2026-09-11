import { POOL_MANAGER, AI, GENESIS_BLOCK } from "../config.mjs";
import { getLogsRange, getLogsByTopicSet, padAddr } from "../rpc.mjs";
import { TOPICS, decodeInitialize, decodeSwap, fmtUnits } from "../decode.mjs";

const r6 = (x) => (x === 0 ? 0 : +x.toPrecision(6));

/**
 * AI-pair share per token: of all the trading a token does anywhere on the chain,
 * how much settles on its AI bridge?
 *
 * This is the quantity the thesis rests on (BONER is claimed at 35-37%). Measuring it
 * requires finding every venue a token trades on, not just its AI pool, then splitting
 * measured volume in that token's own units between AI pools and everything else.
 */
export async function analyseBridges(aiPools, latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const window = opts.window ?? 2_000_000;       // ~2.4 days
  const topN = opts.topN ?? 14;
  const from = Math.max(GENESIS_BLOCK, latest - window);

  // Candidate tokens: the busiest AI counterparties, excluding the base quote assets.
  const skip = new Set(["USDG", "WETH", "NVDA"]);
  const candidates = aiPools
    .filter((p) => p.pairSymbol && !skip.has(p.pairSymbol) && p.swapsInWindow > 0)
    .slice(0, topN);

  const out = [];
  for (const c of candidates) {
    const T = c.pairToken;
    // Every pool containing T, on either side.
    const [a, b] = [
      await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, padAddr(T)] }, GENESIS_BLOCK, latest, { chunk: 25_000_000 }),
      await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, null, padAddr(T)] }, GENESIS_BLOCK, latest, { chunk: 25_000_000 }),
    ];
    const all = [...a, ...b].map(decodeInitialize);
    const meta = new Map();
    for (const p of all) {
      if (meta.has(p.poolId)) continue;
      const tIsC0 = p.currency0 === T;
      meta.set(p.poolId, { tIsC0, isAIPool: (tIsC0 ? p.currency1 : p.currency0) === AI, block: p.block });
    }

    /* Native launch vs organic bridge -- the distinction the thesis turns on.
       A token the launchpad created against AI settles ~100% on its AI pair by
       construction, which is evidence of how it was minted, not of AI winning
       flow. A token that had its own venues first and later grew an AI pool is
       the real evidence. Averaging the two populations together flatters the hub
       badly, so each row is labelled and the two are summarised separately. */
    const vals = [...meta.values()];
    const earliest = Math.min(...vals.map((m) => m.block));
    const nativeToAI = vals.some((m) => m.block === earliest && m.isAIPool);

    const ids = [...meta.keys()];
    const swaps = await getLogsByTopicSet(POOL_MANAGER, TOPICS.SWAP, ids, from, latest, { groupSize: 960, chunk: window });

    let aiVol = 0, otherVol = 0, aiSwaps = 0, otherSwaps = 0;
    for (const l of swaps) {
      const s = decodeSwap(l);
      const m = meta.get(s.poolId);
      if (!m) continue;
      const tAmt = Math.abs(fmtUnits(m.tIsC0 ? s.amount0 : s.amount1, c.pairDecimals ?? 18));
      if (m.isAIPool) { aiVol += tAmt; aiSwaps++; } else { otherVol += tAmt; otherSwaps++; }
    }
    const total = aiVol + otherVol;
    const row = {
      symbol: c.pairSymbol, token: T, poolId: c.poolId,
      venues: ids.length,
      aiVenues: [...meta.values()].filter((m) => m.isAIPool).length,
      volumeInAIPools: r6(aiVol), volumeElsewhere: r6(otherVol),
      aiPairShare: total > 0 ? +(aiVol / total).toFixed(4) : 0,
      swapsInAIPools: aiSwaps, swapsElsewhere: otherSwaps,
      bridgeOpenedBlock: c.createdBlock,
      bridgeOpenedAt: tm.at(c.createdBlock),
      kind: nativeToAI ? "native" : "organic",
      firstVenueBlock: earliest,
    };
    out.push(row);
    log(`    ${row.symbol.padEnd(10)} ${row.kind.padEnd(7)} AI-pair share ${(row.aiPairShare * 100).toFixed(1)}%  (${ids.length} venues, ${row.aiVenues} vs AI)`);
  }
  out.sort((x, y) => y.volumeInAIPools - x.volumeInAIPools);

  // Summarise the two populations separately; a blended average is misleading.
  const summarise = (rows) => {
    const ai = rows.reduce((s, r) => s + r.volumeInAIPools, 0);
    const other = rows.reduce((s, r) => s + r.volumeElsewhere, 0);
    return { tokens: rows.length, volumeInAIPools: r6(ai), volumeElsewhere: r6(other),
             aiPairShare: ai + other > 0 ? +(ai / (ai + other)).toFixed(4) : 0 };
  };
  const byKind = {
    organic: summarise(out.filter((r) => r.kind === "organic")),
    native: summarise(out.filter((r) => r.kind === "native")),
  };

  // Bridge formation rate: the thesis treats acceleration here as the core signal.
  const formation = new Map();
  for (const p of aiPools) {
    if (!p.swapsInWindow) continue;
    const d = tm.dayBucket(p.createdBlock);
    if (d) formation.set(d, (formation.get(d) || 0) + 1);
  }
  return {
    windowBlocks: window,
    tokens: out,
    byKind,
    formation: [...formation.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => ({ t, newBridges: n })),
  };
}
