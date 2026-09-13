import { NVDA, USDG, POOL_MANAGER, GENESIS_BLOCK, BLOCKS_PER_DAY, AI_NVDA_POOL } from "../config.mjs";
import { getLogsRange, getLogsByTopicSet, padAddr } from "../rpc.mjs";
import { TOPICS, decodeInitialize, decodeSwap, priceFromSqrt, atPriceBound } from "../decode.mjs";

/**
 * NVDA in dollars, so the vault can be stated in dollars.
 *
 * The site has always shown the reserve as "1,407 NVDA" and never as money, which
 * left the one question a holder actually asks -- what is that against a $260M
 * market cap -- unanswered. NVDA has USDG pools of its own on this chain, and USDG
 * is a dollar stablecoin, so the stock token gets a dollar price the same way AI
 * does: from a pool's own last print, no oracle, one stated assumption (the peg).
 *
 * Cheap by construction. The venues are discovered once (the launchpad census
 * already knows them) and cached; each run then reads the last few hours of swaps
 * across all of them in ONE request, because the pool id is topic1 and topics can
 * be OR-lists. Two or three calls a run, none of them scanning history.
 *
 * A second dollar price for NVDA falls out of data already on disk: AI in USDG
 * divided by AI in NVDA. It is written beside the direct read as a cross-check,
 * and the page says so when they disagree.
 */
export async function indexPrices(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store;
  const flowPools = opts.flowPools || [];

  /* Venues once. USDG's address sorts below NVDA's, so USDG is currency0 in every
     such pool; the decimals below depend on that and it is checked, not assumed. */
  let venues = store?.get("nvdaUsdgPools");
  if (!venues?.ids?.length) {
    const fromCensus = (store?.get("longCensus")?.usdgPools || [])
      .filter((u) => u.c0 === NVDA || u.c1 === NVDA).map((u) => u.id);
    if (fromCensus.length) venues = { ids: fromCensus, source: "launchpad census" };
    else {
      const logs = await getLogsRange(
        { address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, padAddr(USDG), padAddr(NVDA)] },
        GENESIS_BLOCK, latest, { chunk: 25_000_000 });
      venues = { ids: logs.map(decodeInitialize).map((p) => p.poolId), source: "Initialize scan" };
    }
    store?.set("nvdaUsdgPools", venues);
    log(`  ${venues.ids.length} NVDA/USDG venues (${venues.source})`);
  }
  const usdgIsC0 = USDG.toLowerCase() < NVDA.toLowerCase();

  /* The busiest venue in the window sets the price, from its last genuine print.
     Widen only if a window is empty; NVDA trades constantly, so the first almost
     always answers. */
  let nvdaUsd = null, at = null, venue = null, window = null;
  for (const hours of [4, 24, 72]) {
    const from = Math.max(GENESIS_BLOCK, latest - Math.round((BLOCKS_PER_DAY * hours) / 24));
    const logs = await getLogsByTopicSet(POOL_MANAGER, TOPICS.SWAP, venues.ids, from, latest, { groupSize: 960, chunk: 1_000_000 });
    const count = new Map(), last = new Map();
    for (const l of logs) {
      const id = l.topics[1];
      count.set(id, (count.get(id) || 0) + 1);
      last.set(id, l);
    }
    const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]);
    for (const [id] of ranked) {
      const sw = decodeSwap(last.get(id));
      if (atPriceBound(sw.sqrtPriceX96)) continue;   // an exhausted pool is not a price
      const raw = priceFromSqrt(sw.sqrtPriceX96, usdgIsC0 ? 6 : 18, usdgIsC0 ? 18 : 6);   // token1 per token0
      const usd = usdgIsC0 ? (raw > 0 ? 1 / raw : 0) : raw;
      if (usd > 0 && isFinite(usd)) { nvdaUsd = usd; at = tm.at(sw.block); venue = id; window = hours; break; }
    }
    if (nvdaUsd) break;
  }

  /* AI's own two prices, from the flow artifact: dollars from the busiest USDG
     venue, NVDA from the flagship. Their ratio is the second dollar price of NVDA. */
  const lastClose = (p) => p?.hourly?.filter((h) => h.close > 0).at(-1) ?? null;
  const usdgPool = flowPools.filter((p) => p.pairSymbol === "USDG").sort((a, b) => (b.totalSwaps || 0) - (a.totalSwaps || 0))[0];
  const aiUsdRow = lastClose(usdgPool);
  const aiNvdaRow = lastClose(flowPools.find((p) => p.poolId === AI_NVDA_POOL));
  const aiUsd = aiUsdRow?.close ?? null;
  const aiNvda = aiNvdaRow?.close ?? null;
  const implied = aiUsd && aiNvda ? aiUsd / aiNvda : null;

  if (nvdaUsd) log(`  NVDA $${nvdaUsd.toFixed(2)} from its busiest USDG venue (last ${window}h)` +
    (implied ? `; AI/USDG ÷ AI/NVDA implies $${implied.toFixed(2)}` : ""));
  else log("  no NVDA/USDG print found in 72h; NVDA price left as the implied figure only");

  /* One row an hour, kept for 90 days. The two dollar prices side by side are what
     make AI's beta to NVDA measurable later without another scan. */
  const now = Math.floor(Date.now() / 1000);
  const hourKey = Math.floor(now / 3600) * 3600;
  const history = (opts.prior?.history || []).filter((h) => h.t !== hourKey).slice(-24 * 90);
  history.push({
    t: hourKey,
    nvdaUsd: nvdaUsd == null ? null : +nvdaUsd.toPrecision(6),
    nvdaUsdImplied: implied == null ? null : +implied.toPrecision(6),
    aiUsd: aiUsd == null ? null : +aiUsd.toPrecision(6),
    aiNvda: aiNvda == null ? null : +aiNvda.toPrecision(6),
  });
  history.sort((a, b) => a.t - b.t);

  return {
    updatedAt: now,
    nvdaUsd: nvdaUsd == null ? null : +nvdaUsd.toPrecision(6),
    nvdaUsdAt: at,
    nvdaUsdVenue: venue,
    nvdaUsdWindowHours: window,
    nvdaUsdImplied: implied == null ? null : +implied.toPrecision(6),
    nvdaVenues: venues.ids.length,
    aiUsd, aiNvda,
    assumption: "USDG holds its dollar peg",
    history,
  };
}
