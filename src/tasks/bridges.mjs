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

    /* Two meters, deliberately. aiVol/otherVol are in the TOKEN's units and only
       ever divided by each other, which is the valid per-token ratio. aiSideVol is
       the same AI-pool flow measured on the AI leg, in AI units -- the only figure
       that is comparable ACROSS tokens, so it is what weights the population
       average. Without it the aggregate is either a sum of incommensurable units
       (wrong) or an unweighted median that lets a dust-sized wrapper count the
       same as the token carrying nearly all the flow. */
    let aiVol = 0, otherVol = 0, aiSwaps = 0, otherSwaps = 0, aiSideVol = 0;
    for (const l of swaps) {
      const s = decodeSwap(l);
      const m = meta.get(s.poolId);
      if (!m) continue;
      const tAmt = Math.abs(fmtUnits(m.tIsC0 ? s.amount0 : s.amount1, c.pairDecimals ?? 18));
      if (m.isAIPool) {
        aiVol += tAmt; aiSwaps++;
        aiSideVol += Math.abs(fmtUnits(m.tIsC0 ? s.amount1 : s.amount0, 18));
      } else { otherVol += tAmt; otherSwaps++; }
    }
    const total = aiVol + otherVol;
    const row = {
      symbol: c.pairSymbol, token: T, poolId: c.poolId,
      venues: ids.length,
      aiVenues: [...meta.values()].filter((m) => m.isAIPool).length,
      volumeInAIPools: r6(aiVol), volumeElsewhere: r6(otherVol),
      aiSideVolume: r6(aiSideVol),
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

  /* Summarise the two populations separately -- and NOT by summing volumes.
     Each row's volume is denominated in its own token, so adding BONER units to
     PONS units to ANTHROPIC units produces a number with no meaning, and the
     resulting ratio is dominated by whichever token happens to have the largest
     raw supply. Measured here that inflated the organic figure to 9.05% when the
     typical organic token is at 1.9%.
     Per-token shares ARE valid (same token both sides of the ratio), so the
     population is described by the distribution of those shares, plus one aggregate
     that is legitimate: those same shares weighted by AI-denominated bridge flow,
     which is comparable across tokens. Raw unit sums are retained only for
     reference and labelled as non-comparable. */
  const summarise = (rows) => {
    const shares = rows.map((r) => r.aiPairShare).sort((a, b) => a - b);
    // True median: average the two middle values on an even count, rather than
    // taking the upper one, which biased a 4-token population upward.
    const n = shares.length;
    const median = !n ? 0 : n % 2 ? shares[(n - 1) / 2] : (shares[n / 2 - 1] + shares[n / 2]) / 2;
    const mean = shares.length ? shares.reduce((s, v) => s + v, 0) / shares.length : 0;
    return {
      tokens: rows.length,
      medianShare: +median.toFixed(4),
      meanShare: +mean.toFixed(4),
      minShare: shares.length ? +shares[0].toFixed(4) : 0,
      maxShare: shares.length ? +shares[shares.length - 1].toFixed(4) : 0,
      // Importance-weighted share: each token's own valid ratio, weighted by the
      // AI-denominated flow through its bridge. Weights are all in AI units, so
      // this one IS comparable across tokens: of the AI moving through these
      // bridges, what fraction of the tokens' own trading settles on AI.
      weightedShare: (() => {
        const w = rows.reduce((s, r) => s + (r.aiSideVolume || 0), 0);
        if (!w) return null;
        return +(rows.reduce((s, r) => s + r.aiPairShare * (r.aiSideVolume || 0), 0) / w).toFixed(4);
      })(),
      aiSideVolume: r6(rows.reduce((s, r) => s + (r.aiSideVolume || 0), 0)),
      // Kept for reference only: these sum different tokens' units.
      volumeInAIPoolsRaw: r6(rows.reduce((s, r) => s + r.volumeInAIPools, 0)),
      volumeElsewhereRaw: r6(rows.reduce((s, r) => s + r.volumeElsewhere, 0)),
      unitsComparable: false,
    };
  };
  const byKind = {
    organic: summarise(out.filter((r) => r.kind === "organic")),
    native: summarise(out.filter((r) => r.kind === "native")),
  };

  /* Bridge formation rate: the thesis treats acceleration here as the core signal.

     Two counts per day, because one of them lies. `opened` is every pool created
     against AI that day. `stillTrading` is the subset that traded in the recent
     activity window -- the better measure of a real bridge, but survivorship-
     filtered, so the further back you look the more of that day's casualties are
     missing and the quieter the past appears. Reporting only the survivors
     manufactures a downward trend in formation out of nothing. */
  const formation = new Map();
  const bump = (p, key) => {
    const d = tm.dayBucket(p.createdBlock);
    if (!d) return;
    const row = formation.get(d) || { t: d, opened: 0, stillTrading: 0 };
    row[key]++;
    formation.set(d, row);
  };
  for (const p of (opts.allPools || aiPools)) bump(p, "opened");
  for (const p of aiPools) if (p.swapsInWindow) bump(p, "stillTrading");
  return {
    windowBlocks: window,
    tokens: out,
    byKind,
    formation: [...formation.values()].sort((a, b) => a.t - b.t)
      .map((r) => ({ t: r.t, opened: r.opened, stillTrading: r.stillTrading, newBridges: r.stillTrading })),
  };
}
