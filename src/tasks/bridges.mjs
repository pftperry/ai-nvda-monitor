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

  /* This step has never completed a full pass, and the reason is structural: it
     did two FULL-history Initialize scans per token, so sixteen tokens meant
     thirty-two scans of ~51M blocks plus their swap tapes. It timed out every time.

     Two fixes. Venue discovery per token now resumes from a cursor, because
     Initialize is append-only like everything else. And tokens are processed a few
     per run, oldest measurement first, with the rest carried forward -- so each run
     is bounded and the full set converges over several runs instead of never
     finishing. A slightly stale bridge figure is worth far more than a perpetually
     absent one. */
  const store = opts.store;
  const perRun = opts.perRun ?? 4;
  const priorTokens = new Map((opts.prior?.tokens || []).map((t) => [t.token, t]));
  const venueCache = (store && store.get("bridgeVenues")) || {};

  // Candidate tokens: the busiest AI counterparties, excluding the base quote assets.
  const skip = new Set(["USDG", "WETH", "NVDA", "ETH"]);
  const candidates = aiPools
    .filter((p) => p.pairSymbol && !skip.has(p.pairSymbol) && p.swapsInWindow > 0)
    .slice(0, topN);

  // Refresh the least recently measured first, so coverage rotates fairly.
  const queue = [...candidates].sort(
    (a, b) => (priorTokens.get(a.pairToken)?.measuredAt || 0) - (priorTokens.get(b.pairToken)?.measuredAt || 0)
  ).slice(0, perRun);
  log(`  ${candidates.length} candidate tokens; refreshing ${queue.length} this run, carrying the rest forward`);

  const out = [];
  for (const c of queue) {
    const T = c.pairToken;
    const cached = venueCache[T];
    const vFrom = cached?.cursor ? Math.max(GENESIS_BLOCK, cached.cursor + 1) : GENESIS_BLOCK;
    // Every pool containing T, on either side — only the part we have not seen.
    const [a, b] = [
      await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, padAddr(T)] }, vFrom, latest, { chunk: 25_000_000 }),
      await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, null, padAddr(T)] }, vFrom, latest, { chunk: 25_000_000 }),
    ];
    const meta = new Map();
    for (const v of cached?.venues || []) meta.set(v.poolId, { tIsC0: v.tIsC0, isAIPool: v.isAIPool, block: v.block });
    for (const p of [...a, ...b].map(decodeInitialize)) {
      if (meta.has(p.poolId)) continue;
      const tIsC0 = p.currency0 === T;
      meta.set(p.poolId, { tIsC0, isAIPool: (tIsC0 ? p.currency1 : p.currency0) === AI, block: p.block });
    }
    if (store) {
      venueCache[T] = { cursor: latest, venues: [...meta].map(([poolId, m]) => ({ poolId, ...m })) };
    }

    /* Native launch vs organic bridge -- the distinction the thesis turns on.
       A token the launchpad created against AI settles ~100% on its AI pair by
       construction, which is evidence of how it was minted, not of AI winning
       flow. A token that had its own venues first and later grew an AI pool is
       the real evidence. Averaging the two populations together flatters the hub
       badly, so each row is labelled and the two are summarised separately. */
    /* Loop rather than Math.min(...array). Spreading an array into a call passes
       one argument per element, and a popular token here has thousands of venues,
       which overflows the call stack -- this exact line killed the bridge step
       with "Maximum call stack size exceeded" after three tokens had succeeded. */
    const vals = [...meta.values()];
    let earliest = Infinity;
    for (const m of vals) if (m.block < earliest) earliest = m.block;
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
      measuredAt: Math.floor(Date.now() / 1000),
    };
    out.push(row);
    log(`    ${row.symbol.padEnd(10)} ${row.kind.padEnd(7)} AI-pair share ${(row.aiPairShare * 100).toFixed(1)}%  (${ids.length} venues, ${row.aiVenues} vs AI)`);
  }
  /* Carry forward tokens not refreshed this run, so the table shows the full set
     rather than only the slice this run happened to reach. Each row states when it
     was last measured, so a stale one is visible as stale rather than passed off
     as current. */
  const refreshed = new Set(out.map((r) => r.token));
  for (const [tok, row] of priorTokens) if (!refreshed.has(tok)) out.push(row);
  if (store) store.set("bridgeVenues", venueCache);
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
