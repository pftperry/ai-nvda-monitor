#!/usr/bin/env node
import fs from "node:fs";
import * as C from "./config.mjs";
import { blockNumber, rpcCalls } from "./rpc.mjs";
import { hookPermissions } from "./decode.mjs";
import { Store, writeData, readData } from "./store.mjs";
import { loadTimeMap } from "./timemap.mjs";
import { discoverPools, buildRoutingIndex } from "./tasks/pools.mjs";
import { assertTokenMetadata, resolveTokens } from "./tokens.mjs";
import { indexFlow, rollup } from "./tasks/flow.mjs";
import { analyseRouting, routingHoleDay } from "./tasks/routing.mjs";
import { indexDepth } from "./tasks/depth.mjs";
import { snapshotKpis } from "./tasks/kpis.mjs";
import { censusLongPools, rankByActivity, classifyLaunches, anchorPrices, priceLaunchpadTokens, summariseLaunchpad } from "./tasks/launchpad.mjs";
import { indexBurns } from "./tasks/burns.mjs";
import { indexPrices } from "./tasks/prices.mjs";
import { indexTreasury } from "./tasks/treasury.mjs";
import { indexRwa } from "./tasks/rwa.mjs";
import { indexHolders, usdPriceLookup, pickHolderState } from "./tasks/holders.mjs";
import { analyseBridges } from "./tasks/bridges.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };

const quick = flag("quick") || flag("skip-backfill");
const deep = flag("deep");
const TOP_FLOW = opt("top", quick ? 6 : deep ? 18 : 8);

/* Depth knobs. Flow is always backfilled to each pool's birth, so "deep" is about
   the windowed analyses: routing and AI-pair share are measured over a trailing
   window, and a short one can only show a moment. ~845,649 blocks is a day here. */
const DAY_BLOCKS = 845_649;
const ACTIVITY_WINDOW = opt("activity-window", quick ? 400_000 : 600_000);
const ROUTING_WINDOW = opt("routing-window", quick ? 600_000 : deep ? DAY_BLOCKS * 14 : 2_500_000);
const BRIDGES_WINDOW = opt("bridges-window", quick ? 400_000 : deep ? DAY_BLOCKS * 7 : 1_500_000);
const BRIDGES_TOP = opt("bridges", quick ? 4 : deep ? 16 : 8);
/**
 * An optional stage failed. Say so where it will actually be seen.
 *
 * These stages are wrapped in try/catch on purpose -- a throttled RPC or a bad
 * pool must not cost us the AI artifacts that are the point of the run. But a
 * swallowed exception is how this morning's outage stayed invisible for hours: the
 * job reported success while publishing nothing new. Measured again tonight, the
 * launchpad census died on a missing import and the run still exited zero.
 * console.warn is a plain line in a log nobody reads; a workflow annotation is not.
 */
function softFail(stage, e, consequence) {
  console.warn(`  ${stage} failed (${e.message}); ${consequence}`);
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::warning::${stage} failed: ${e.message} — ${consequence}`);
  }
}

const t0 = Date.now();
/* Report the cost of the stage just finished, in seconds and RPC calls. Tuning a
   refresh without this is guesswork: the obvious suspect is rarely the expensive
   one, and "300 calls somewhere in a 221s run" is not an actionable number. */
let lastAt = Date.now(), lastCalls = 0;
const step = (m) => {
  const dt = (Date.now() - lastAt) / 1000, dc = rpcCalls() - lastCalls;
  if (lastCalls || dc) console.log(`      ...previous stage: ${dt.toFixed(1)}s, ${dc} rpc calls`);
  lastAt = Date.now(); lastCalls = rpcCalls();
  console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
};

const store = new Store();
const latest = await blockNumber();
console.log(`Robinhood Chain (${C.CHAIN_ID}) head block ${latest.toLocaleString()}`);
console.log(`AI genesis block ${C.GENESIS_BLOCK.toLocaleString()} -> ${(latest - C.GENESIS_BLOCK).toLocaleString()} blocks of history`);
if (quick) console.log("QUICK MODE: shortened windows, fewer pools");
if (deep) console.log("DEEP MODE: 18 pools, 14-day routing window, 7-day bridge window");
console.log(`windows -> activity ${(ACTIVITY_WINDOW / DAY_BLOCKS).toFixed(1)}d · routing ${(ROUTING_WINDOW / DAY_BLOCKS).toFixed(1)}d · bridges ${(BRIDGES_WINDOW / DAY_BLOCKS).toFixed(1)}d · top ${TOP_FLOW} pools · ${BRIDGES_TOP} bridge tokens`);

step("Verifying token metadata");
await assertTokenMetadata();

step("Building block -> time anchors");
const tm = await loadTimeMap(store, latest, { read: readData, write: writeData });
console.log(`  head = ${new Date(tm.at(latest) * 1000).toISOString()}`);

/* Feed the previous run's series back in so only new blocks are scanned.

   --rebuild-pools <match,match> drops the stored series for just the matching
   pools, forcing those to re-derive while every other pool resumes from its
   cursor. A decoding fix usually touches a couple of venues -- USDG's wrong
   decimals corrupted exactly two pools' prices -- and re-deriving all eight to
   repair two turned a two-minute job into a forty-five-minute one. Match is a
   substring of the pool id or the pair symbol. */
const rebuildOnly = (() => {
  const i = argv.indexOf("--rebuild-pools");
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
})();
const priorFlow = flag("rebuild") ? null : readData("flow.json");
const prev = new Map((priorFlow?.pools || []).map((p) => [p.poolId, p]));
/* Pools being repaired must survive the selection that follows.

   Dropping a pool from `prev` is how a repair forces it to re-derive -- but
   selection also keeps pools BECAUSE they are in `prev` with depth, so the drop
   silently removed the target from the retention set and rotation then evicted it.
   Asking to repair a pool was a way to lose it: measured, a targeted repair of one
   AI/ETH venue produced a run that did not index that venue at all. They are
   pinned for the run instead. */
const rebuildTargets = [];
if (rebuildOnly) {
  for (const [id, p] of [...prev]) {
    if (rebuildOnly.some((m) => `${id} ${p.pairSymbol || ""}`.toLowerCase().includes(m))) {
      prev.delete(id);
      rebuildTargets.push(id);
    }
  }
  console.log(`  --rebuild-pools ${rebuildOnly.join(",")}: re-deriving ${rebuildTargets.length} pool(s) and pinning them for this run, resuming the rest`);
}
if (prev.size) console.log(`  resuming from stored series for ${prev.size} pools (--rebuild to force a full re-scan)`);

/* Two stages cannot be made incremental, because both measure a trailing window
   and so must re-read it: ranking pool activity across ~5,470 ids, and building
   the routing index across the active ones. Together they dominate a refresh and
   are why a run takes minutes rather than seconds.
   They also do not need to run often. Venue ranking and κ move over days; price
   and flow move continuously. So --fast does only the parts that change fast:
   it reuses the previous run's pool selection (flow.json already carries every
   field indexFlow needs) and leaves pools.json and routing.json untouched, so a
   scheduled refresh costs a handful of small queries. A periodic full run keeps
   the slow-moving figures honest. */
const fast = flag("fast") && priorFlow?.pools?.length > 0;
let all = [], active = [], seedTxIndex = null, seedFrom = latest, selected = [];

if (fast) {
  console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s] FAST refresh: reusing the last run's ${priorFlow.pools.length} pools; ranking, routing and bridges untouched`);
  selected = priorFlow.pools.map((p) => ({
    poolId: p.poolId, pairSymbol: p.pairSymbol, pairToken: p.pairToken,
    pairDecimals: p.pairDecimals, aiIsCurrency0: p.aiIsCurrency0,
    fee: p.fee, dynamicFee: p.dynamicFee, isLongHook: p.isLongHook,
    hooks: p.hooks, createdBlock: p.createdBlock,
  }));
} else {
  step("Discovering AI pools");
  // Ranking needs breadth (all pools) but not depth (a short window suffices).
  ({ all, active, seedTxIndex, seedFrom } = await discoverPools(latest, {
    activityWindow: ACTIVITY_WINDOW,
    nameTop: quick ? 40 : 120,
    // Initialize events are append-only, so the pool catalogue resumes too.
    knownPools: flag("rebuild") ? null : store.get("poolCatalogue"),
    store,
  }));
  /* The flagship venues are always indexed regardless of rank. Raw swap count
     is dominated by freshly-launched dust churning through its first hours, which
     would otherwise push AI/NVDA -- the pool that actually feeds the vault -- off
     the list entirely.

     The two busiest AI/USDG venues are pinned rather than one, because USDG is the
     only dollar quote on this chain and dollar history is the series a holder
     actually reads. The busiest pool opened on 3 September; a 1.00% pool has
     traded since 22 July, ranks nowhere near the top on recent activity, and is
     where forty extra days of dollar price live.

     Two, not all of them: "every pool paired with USDG" is about a hundred and
     ninety once dormant venues are counted, and pinning that list filled all
     eight flow slots with USDG dust and evicted AI/ETH, AI/OPEN and AI/HENT
     entirely. Ranking the ACTIVE ones by swap count picks the two that carry
     essentially all of the dollar volume and adapts if a third venue takes over. */
  const usdgVenues = active
    .filter((p) => p.pairToken === C.USDG)
    .sort((a, b) => b.swapsInWindow - a.swapsInWindow)
    .slice(0, 2)
    .map((p) => p.poolId);
  const PINNED = [...new Set([C.AI_NVDA_POOL, C.AI_USDG_POOL, ...usdgVenues, ...rebuildTargets])];
  const pinned = PINNED
    .map((id) => active.find((p) => p.poolId === id) || all.find((p) => p.poolId === id))
    .filter(Boolean);
  /* Pins must never crowd out the ranked set. A pin rule that matched more pools
     than intended silently filled all eight flow slots with USDG dust and evicted
     AI/ETH, AI/OPEN and AI/HENT -- the run looked healthy and produced a useless
     index. Half the slots is a generous ceiling for a deliberate pin list. */
  if (pinned.length - rebuildTargets.length > Math.floor(TOP_FLOW / 2)) {
    throw new Error(
      `pin rule matched ${pinned.length} pools for ${TOP_FLOW} flow slots; it would crowd out the ranked set ` +
      `(${pinned.map((p) => p.pairSymbol || p.poolId.slice(0, 8)).join(", ")})`);
  }
  /* History already paid for is not given up to a ranking wobble.

     Selection is by recent activity, and flow.json holds exactly the pools selected
     -- so a pool that slips one place past the cap is dropped from the artifact and
     its whole backfill is gone, to be re-derived from genesis if it ever ranks
     again. Some of these cost real time: BONER is 71,852 swaps over 533 hourly
     buckets, SIT 69,074 over 376. Losing that to a quiet afternoon is pure waste,
     and worse, it silently shrinks the coverage every cross-venue figure depends on.

     So a pool that already has depth and is still trading keeps its slot, and TOP_FLOW
     becomes the floor for new entrants rather than a hard ceiling. Retention cannot
     grow without bound either, so there is a hard stop at twice TOP_FLOW; `active`
     arrives sorted by swap count, so what gets cut first is the least active new
     entrant, and only once every one of those is gone does a retained pool go. A
     pool that stops trading altogether is not retained at all -- it is absent from
     `active` -- which is the one case where dropping the history is correct. */
  const priorDeep = new Set([...prev].filter(([, p2]) => (p2.hourly || []).length >= 24).map(([id]) => id));
  const retained = active.filter((p) => priorDeep.has(p.poolId) && !PINNED.includes(p.poolId));
  const fresh = active.filter((p) => !priorDeep.has(p.poolId) && !PINNED.includes(p.poolId));
  const CEILING = TOP_FLOW * 2;
  selected = [...pinned, ...retained, ...fresh].slice(0, Math.min(CEILING, Math.max(TOP_FLOW, pinned.length + retained.length)));
  const droppedDeep = [...priorDeep].filter((id) => !selected.some((p) => p.poolId === id));
  console.log(`  pinned flagships: ${pinned.map((p) => "AI/" + (p.pairSymbol || "?")).join(", ")}`);
  console.log(`  ${retained.length} pools retained for existing depth, ${Math.max(0, selected.length - pinned.length - retained.length)} new entrants, ${selected.length} indexed in all`);
  if (droppedDeep.length) {
    console.log(`  dropped ${droppedDeep.length} pool(s) that had depth but went dormant or fell past the ${CEILING} ceiling`);
  }
}

step(`Indexing buy/sell flow for ${selected.length} pools`);
const flow = await indexFlow(selected, latest, tm, { prev });

/* Routing is now incremental: a transaction sits in one day, so only days the new
   scan touches are recomputed and the rest of the daily series carries forward.
   A fast run therefore still refreshes κ -- it just scans the last couple of hours
   instead of three days, and merges. The headline ratio is always taken from the
   merged series over a fixed trailing window, so it means the same thing whichever
   mode produced it. */
step("Measuring cross-routing (κ)");
const priorRouting = flag("rebuild") ? null : readData("routing.json");
const rankedPools = all.length ? all : (readData("pools.json")?.pools || []);
const activeForRouting = active.length ? active : rankedPools.slice(0, 250);

/* Where the scan starts, and whether it adds to the stored days or replaces them.

   A full run rescans its window and REPLACES every day it touches, so it must
   start on a day boundary or the first day is rebuilt from a fraction of itself.
   A fast run resumes from the stored cursor and APPENDS: a transaction sits in one
   block, so blocks never seen before add exactly to the days they fall in. The
   old fast path replaced the current day with its last three hours on every
   refresh, which is how a complete day came to read 0.0M routed against 101M of
   flow. Either mode widens to repair a day that reads as a hole, so a corrupt
   series heals itself on the next run instead of waiting for a person. */
const dayStartBlock = (block) => tm.blockAt(tm.dayBucket(block)) ?? block;
const repairDay = routingHoleDay(flow.perPool, priorRouting, tm.dayBucket(latest));
const repairFrom = repairDay == null ? null : tm.blockAt(repairDay);
const routingPlan = (() => {
  if (!fast) {
    const from = Math.min(dayStartBlock(latest - ROUTING_WINDOW), repairFrom ?? Infinity);
    return { from, additive: false, why: "full window from a day boundary" };
  }
  if (repairFrom != null) return { from: repairFrom, additive: false, why: "repairing a day whose routing volume disagrees with flow" };
  const cursor = priorRouting?.cursor;
  if (cursor && latest - cursor <= DAY_BLOCKS * 2) return { from: cursor + 1, additive: true, why: `appending ${(latest - cursor).toLocaleString()} new blocks` };
  return { from: dayStartBlock(latest), additive: false, why: cursor ? "cursor too old, rebuilding today" : "no cursor yet, building today" };
})();
if (repairFrom != null) console.log(`  a recent routing day disagrees with flow; scan widened to block ${repairFrom.toLocaleString()} to repair it`);
console.log(`  routing scan: ${routingPlan.why}`);

let routing = null, routingFrom = null;
if (activeForRouting.length) {
  const built = await buildRoutingIndex(rankedPools, activeForRouting, latest, {
    from: routingPlan.from,
    seed: seedTxIndex, seedFrom,
  });
  routingFrom = built.routingFrom;
  routing = analyseRouting(built.txIndex, rankedPools, tm, {
    priorDaily: priorRouting?.daily || [],
    rescanFromDay: tm.dayBucket(built.routingFrom),
    additive: routingPlan.additive,
    prior: priorRouting,
    windowDays: 3,
  });
  console.log(`  κ = ${(routing.measuredKappaRatio * 100).toFixed(2)}% of direct volume over ${routing.kappaWindowDays}d -> regime "${routing.impliedRegime}"`);
  console.log(`  ${routing.transactions.crossRouting.toLocaleString()} cross-routing txs of ${routing.transactions.multiLeg.toLocaleString()} multi-leg (${routing.scanMode})`);
} else {
  console.log("  no ranked pools available; leaving routing.json untouched");
}

step("Indexing burn / lock / vault ledger");
const burns = await indexBurns(latest, tm, {
  prev: flag("rebuild") ? null : readData("burns.json"),
  flowPools: flow.perPool,    // the effective fee rate divides fees by measured sell volume
});
console.log(`  burned ${burns.burned.toLocaleString()} AI over ${burns.burnEvents} events`);
console.log(`  vault holds ${burns.vault.aiBalance.toLocaleString()} AI + ${burns.vault.nvdaBalance.toLocaleString()} NVDA`);
console.log(`  observed fee split burn:lock:platform = 1 : ${burns.observedSplit?.lock} : ${burns.observedSplit?.platform}`);
console.log(`  effective fee rate ${burns.effectiveFeeRate ? (burns.effectiveFeeRate * 100).toFixed(3) + "%" : "n/a"} (${burns.feeRateBasis})`);
console.log(`  supply reconciliation: ${burns.reconciles ? "PASS" : "FAIL"} (residual ${burns.reconcileResidual})`);

step("Writing core data artifacts");
const now = tm.at(latest);
const windows = [1, 6, 24, 72];
const flowOut = flow.perPool.map((p) => ({
  ...p,
  rollups: windows.map((h) => rollup(p.hourly, h, now)),
}));

writeData("meta.json", {
  // Provenance stamp. Only a real indexing run sets this, and verify.mjs refuses
  // to pass without it -- so test fixtures can never be mistaken for measurements.
  source: "robinhood-chain-rpc",
  updatedAt: Math.floor(Date.now() / 1000),
  headBlock: latest,
  headTime: now,
  chainId: C.CHAIN_ID,
  // Host only. The full endpoint URL carries the API key and this file is public.
  rpc: C.RPC_LABEL,
  genesisBlock: C.GENESIS_BLOCK,
  contracts: {
    poolManager: C.POOL_MANAGER, aiToken: C.AI, nvdaToken: C.NVDA, usdg: C.USDG,
    longHook: C.LONG_HOOK, feeSplitter: C.FEE_SPLITTER, communityVault: C.COMMUNITY_VAULT,
    platformFeeRecipient: C.PLATFORM_FEE_RECIPIENT,
    aiNvdaPool: C.AI_NVDA_POOL, aiUsdgPool: C.AI_USDG_POOL,
  },
  hookPermissions: hookPermissions(C.LONG_HOOK),
  mode: fast ? "fast" : (quick ? "quick" : deep ? "deep" : "standard"),
  poolCounts: fast
    ? { ...(readData("meta.json")?.poolCounts || {}), indexed: selected.length }
    : { withAI: all.length, active: active.length, indexed: selected.length },
  rpcCalls: rpcCalls(),
  buildSeconds: Math.round((Date.now() - t0) / 1000),
});
if (!fast) writeData("pools.json", { updatedAt: now, pools: active.slice(0, 250) });
writeData("flow.json", { updatedAt: now, windows, pools: flowOut });
writeData("burns.json", burns);
// cursor is what the next fast run appends from; windowFrom is where this scan began.
if (routing) writeData("routing.json", { updatedAt: now, windowFrom: routingFrom, cursor: latest, ...routing });
writeData("tape.json", { updatedAt: now, pools: flow.perPool.map((p) => p.pairSymbol), swaps: flow.tape });

/* NVDA in dollars, so the vault and AI's beta to its anchor can be stated in
   money. Two or three small requests; the venues are cached after the first run. */
step("Pricing NVDA in dollars");
let prices = null;
try {
  prices = await indexPrices(latest, tm, { store, flowPools: flowOut, prior: readData("prices.json") });
  writeData("prices.json", prices);
} catch (e) {
  softFail("prices", e, "the previous prices.json stays in place");
}
/* Liquidity depth. Runs on every mode including --fast, because it is cheap after
   the first pass (ModifyLiquidity is append-only and resumes from a cursor) and
   because it is the only forward-looking measure here -- a stale order book is
   worth much less than a stale volume figure. The dollar anchor comes from the
   busiest AI/USDG pool's own close, the same one the page treats as canonical. */
step("Measuring liquidity depth");
let depth = null;
try {
  const usdgPool = flowOut
    .filter((p) => p.pairSymbol === "USDG")
    .sort((a, b) => b.totalSwaps - a.totalSwaps)[0];
  const aiUsd = usdgPool?.hourly?.filter((h) => h.close > 0).at(-1)?.close ?? 0;
  if (!(aiUsd > 0)) {
    console.log("  no AI/USDG close available, so no dollar anchor; skipping depth");
  } else {
    const withState = flowOut.map((p) => {
      const meta = (all.length ? all : (readData("pools.json")?.pools || []))
        .find((x) => x.poolId === p.poolId);
      return { ...p, lastSqrtPriceX96: p.lastSqrtPriceX96 ?? meta?.lastSqrtPriceX96,
               pairDecimals: p.pairDecimals ?? meta?.pairDecimals };
    });
    depth = await indexDepth(withState, latest, aiUsd, {
      store, windowPct: 0.5, bins: 120,
      io: { read: readData, write: writeData },
      dayOf: (b) => tm.dayBucket(b),
      budgetSeconds: opt("depth-budget", fast ? 90 : 420),
    });
    writeData("depth.json", { updatedAt: now, ...depth });
  }
} catch (e) {
  softFail("depth", e, "the previous depth.json stays in place");
}

/* Where the fees go: the platform fee wallet and the wallets it forwards to, in
   AI, NVDA, USDG and WETH, plus the platform-wide take across every token. Slow
   path only; the ledgers resume from a cursor so a refresh reads new blocks. */
if (!fast && !flag("no-treasury")) {
  step("Following the fees");
  try {
    const px = new Map([[C.USDG, 1]]);
    if (prices?.nvdaUsd) px.set(C.NVDA, prices.nvdaUsd);
    if (prices?.aiUsd) px.set(C.AI, prices.aiUsd);
    for (const t of readData("launchpad.json")?.top || []) if (t.priceUsd > 0) px.set(t.token, t.priceUsd);
    const treasury = await indexTreasury(latest, tm, {
      store, budgetSeconds: opt("treasury-budget", 420), priceOf: (a) => px.get(a) ?? null,
    });
    writeData("treasury.json", treasury);
  } catch (e) {
    softFail("treasury", e, "the previous treasury.json stays in place");
  }
}

/* The LONG platform census. Its own cursor, its own artifact, and last in the run
   on purpose: understanding AI's value accretion is this project's job, and a
   platform-wide scan must never be able to slow that down or fail it. Skipped
   entirely on a fast refresh, hard time budget otherwise, and any failure leaves
   the previous artifact in place. */
if (!fast && !flag("no-launchpad")) {
  step("Censusing the LONG launchpad");
  try {
    const budget = opt("launchpad-budget", deep ? 900 : 420);
    const deadline = Date.now() + budget * 1000;
    const prior = readData("launchpad.json");
    const census = await censusLongPools(latest, store.get("longCensus") || prior?.census, { deadline });
    store.set("longCensus", { cursor: census.cursor, pools: census.pools, usdgPools: census.usdgPools });

    /* Symbols only for tokens that behave like anchors. Resolving eighteen thousand
       memecoins to classify forty anchors would cost more than the census. */
    const degree = new Map();
    for (const p of census.pools) for (const t of [p.c0, p.c1]) degree.set(t, (degree.get(t) || 0) + 1);
    const likely = [...degree].filter(([, n]) => n >= 20).map(([a]) => a);
    const anchorMeta = await resolveTokens(likely, { log: () => {} });
    const symbols = new Map([...anchorMeta].map(([a, m]) => [a, m.symbol]));
    const decimals = new Map([...anchorMeta].map(([a, m]) => [a, m.decimals]));

    const { launches, degree: deg, unlisted } = classifyLaunches(census.pools, symbols, console.log);
    // Two hours of blocks, from the constant the config actually exports. Written
    // as C.SEC_PER_BLOCK first, which does not exist -- that would have made the
    // window NaN and ranked nothing, silently.
    const rank = await rankByActivity(latest, Math.round(C.BLOCKS_PER_DAY / 12), { deadline });
    const anchors = anchorPrices(census.usdgPools, rank, decimals);

    // Names for the launched side, but only for the ones that will be shown.
    const busiest = launches
      .map((l) => ({ l, n: rank.counts.get(l.id) || 0 }))
      .sort((a, b) => b.n - a.n).slice(0, 300).map((x) => x.l.token);
    const tokMeta = await resolveTokens([...new Set(busiest)], { log: () => {} });
    for (const [a, m] of tokMeta) { symbols.set(a, m.symbol); decimals.set(a, m.decimals); }

    const priced = await priceLaunchpadTokens(
      // token and anchor come from the classifier; the pricer must not re-derive them.
      launches.map((l) => ({ id: l.id, c0: l.c0, c1: l.c1, block: l.block, fee: l.fee, token: l.token, anchor: l.anchor })),
      rank, anchors, store,
      { perRun: opt("launchpad-per-run", 200), topN: 300, decimals, symbols, deadline });

    /* AI's standing as a base pair, which is the platform's own answer to whether
       AI is becoming infrastructure. Everything ranked above it is either a quote
       asset or a real-world asset; AI is the only launched token that other tokens
       choose to quote themselves in, and that is a stronger statement of the hub
       thesis than anything derived from routing. */
    const anchorRank = [...deg]
      .filter(([a]) => (degree.get(a) || 0) >= 20)
      .sort((a, b) => b[1] - a[1])
      .map(([a, n], i) => ({ rank: i + 1, token: a, symbol: symbols.get(a) || null, pools: n }));
    const aiRow = anchorRank.find((r) => r.token === C.AI) || null;

    /* Never replace a finished census with an unfinished one.

       The walk back to genesis costs about 1,600 seconds and the budget here is a
       fraction of that, so a machine with a cold cache produces a partial census on
       its first few runs -- fewer pools, fewer launches, every count lower. That is
       correct as a starting point and wrong as a replacement for a complete one
       already on disk, which is exactly what would happen the first time CI ran this
       after a local backfill. The store still takes the new cursor, so the census
       keeps converging in the background; only the published artifact is protected
       until it can improve on what is there. */
    const priorComplete = prior && prior.censusPartial === false;
    const wouldShrink = priorComplete && (census.partial || census.pools.length < (prior.poolsWithHook ?? 0));
    if (wouldShrink) {
      console.log(`  census still catching up (${census.pools.length.toLocaleString()} pools vs ${(prior.poolsWithHook ?? 0).toLocaleString()} already published); keeping the complete artifact`);
    } else writeData("launchpad.json", {
      updatedAt: now,
      censusPartial: census.partial,
      // census.pools, not launches: the adoption ratio is counted over every LONG
      // pool, so neither term depends on the real-world-asset symbol list.
      ...summariseLaunchpad(launches, priced, (b) => tm.dayBucket(b), prior, census.pools, rank.counts),
      poolsWithHook: census.pools.length,
      anchorRank: anchorRank.slice(0, 20),
      // The list is truncated for the page; the count must not be.
      anchorCount: anchorRank.length,
      aiAnchorRank: aiRow,
      // Twenty-five, not ten: the first census found forty-three and reporting a
      // third of them per run makes convergence needlessly slow.
      unlistedAnchors: unlisted.slice(0, 25),
    });

    /* Tokenized-stock capture: share of every stock token's supply inside DEX
       liquidity and the vault, and share of every stock-token swap that went
       through a LONG pool. Needs the census, the anchor prices and a day of Swap
       logs, so it lives here rather than in its own step. */
    step("Measuring tokenized-stock capture");
    try {
      const rwaDeadline = Date.now() + opt("rwa-budget", 300) * 1000;
      const day = await rankByActivity(latest, C.BLOCKS_PER_DAY, { deadline: rwaDeadline, chunk: 40_000 });
      const rwa = await indexRwa(latest, tm, {
        store, pools: census.pools, symbols, decimals, anchorUsd: anchors,
        swaps: { counts: day.counts, blocks: C.BLOCKS_PER_DAY, total: day.swaps, truncated: day.truncated },
        prior: readData("rwa.json"), deadline: rwaDeadline,
      });
      writeData("rwa.json", rwa);
    } catch (e) {
      softFail("stock capture", e, "the previous rwa.json stays in place");
    }
  } catch (e) {
    softFail("launchpad census", e, "the previous launchpad.json stays in place");
  }
}

/* Holder distribution. Runs on every mode: once backfilled, a fast refresh adds a
   few thousand transfers and costs seconds. The first pass replays roughly four
   million transfers and does not fit one run, so it is budgeted and resumes from
   its cursor -- and, like the census, an unfinished replay never replaces a
   finished artifact already on disk. */
/* Only once there is something to resume from. Without the committed seed or a
   cached replay, a CI run would start from genesis at 75 seconds a pass and publish
   July-era counts labelled as current for a day or more. */
if (!flag("no-holders") && (store.get("holders") || fs.existsSync("seed/holders-state.json.gz"))) {
  step("Replaying AI transfers into holder balances");
  try {
    const budget = opt("holders-budget", fast ? 75 : deep ? 1500 : 600);
    const prior = readData("holders.json");
    const out = await indexHolders(latest, tm, {
      state: await pickHolderState(store.get("holders"), "seed/holders-state.json.gz"),
      priceAt: usdPriceLookup(flowOut),
      deadline: Date.now() + budget * 1000,
    });
    store.set("holders", out.state);
    if (prior?.complete && !out.artifact.complete) {
      console.log("  replay still catching up; keeping the complete holders.json already published");
    } else {
      writeData("holders.json", { updatedAt: now, ...out.artifact });
    }
  } catch (e) {
    softFail("holders", e, "the previous holders.json stays in place");
  }
}

/* An hourly panel of every rating input beside price, for the study of which of
   them actually relate to price and how they should be weighted. Runs after every
   input it records is on disk, so it cannot affect anything it measures. Inputs
   only, never the score -- the weighting is the question, so storing today's
   answer would make the exercise circular. */
try {
  const kpis = snapshotKpis({
    flow: { pools: flowOut }, burns, routing, bridges: readData("bridges.json"), depth,
    holders: readData("holders.json"), prices: prices ?? readData("prices.json"),
    now: Math.floor(Date.now() / 1000), prior: readData("kpis.json"),
  });
  writeData("kpis.json", kpis);
  console.log(`  kpi panel: ${kpis.rows.length} hourly rows`);
} catch (e) {
  softFail("kpi snapshot", e, "the panel keeps its previous rows");
}

store.save();

/* Bridges run last, after everything else is already on disk, and cannot take the
   rest down with them. Per-token venue discovery is by far the most expensive
   step -- a single popular token can have dozens of venues and a heavy tape -- and
   it is the least critical surface. Flow, burn and routing must not sit unwritten
   behind it. The page treats bridges.json as optional for the same reason. */
if (!fast && !flag("no-bridges")) {
  step("Analysing bridges and AI-pair share");
  try {
    const bridges = await analyseBridges(active, latest, tm, {
      window: BRIDGES_WINDOW,
      topN: BRIDGES_TOP,
      // A few tokens per run, rotating oldest-first: bounded work that converges
      // over successive runs rather than timing out trying to do everything.
      perRun: opt("bridges-per-run", deep ? 8 : 4),
      // Deep runs are the ones started on purpose, so they may take their time.
      budgetSeconds: opt("bridges-budget", deep ? 2400 : 600),
      prior: flag("rebuild") ? null : readData("bridges.json"),
      // Formation needs the pools that are dormant too, or the rate it reports is
      // survivorship-filtered: `active` excludes anything that stopped trading, so
      // older days lose their casualties and look quieter than they were.
      allPools: all,
      store,
    });
    writeData("bridges.json", { updatedAt: now, ...bridges });
  } catch (e) {
    softFail("bridge analysis", e, "the previous bridges.json stays in place");
  }
}

console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s using ${rpcCalls()} RPC calls.`);
