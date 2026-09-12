#!/usr/bin/env node
import * as C from "./config.mjs";
import { blockNumber, rpcCalls } from "./rpc.mjs";
import { hookPermissions } from "./decode.mjs";
import { Store, writeData, readData } from "./store.mjs";
import { loadTimeMap } from "./timemap.mjs";
import { discoverPools, buildRoutingIndex } from "./tasks/pools.mjs";
import { assertTokenMetadata } from "./tokens.mjs";
import { indexFlow, rollup } from "./tasks/flow.mjs";
import { analyseRouting } from "./tasks/routing.mjs";
import { indexBurns } from "./tasks/burns.mjs";
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
if (rebuildOnly) {
  let dropped = 0;
  for (const [id, p] of [...prev]) {
    if (rebuildOnly.some((m) => `${id} ${p.pairSymbol || ""}`.toLowerCase().includes(m))) { prev.delete(id); dropped++; }
  }
  console.log(`  --rebuild-pools ${rebuildOnly.join(",")}: re-deriving ${dropped} pool(s), resuming the rest`);
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
  /* The two flagship venues are always indexed regardless of rank. Raw swap count
     is dominated by freshly-launched dust churning through its first hours, which
     would otherwise push AI/NVDA -- the pool that actually feeds the vault -- off
     the list entirely. */
  const PINNED = [C.AI_NVDA_POOL, C.AI_USDG_POOL];
  const pinned = PINNED
    .map((id) => active.find((p) => p.poolId === id) || all.find((p) => p.poolId === id))
    .filter(Boolean);
  selected = [...pinned, ...active.filter((p) => !PINNED.includes(p.poolId))].slice(0, TOP_FLOW);
  console.log(`  pinned flagships: ${pinned.map((p) => "AI/" + (p.pairSymbol || "?")).join(", ")}`);
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
const routingScan = fast ? Math.round(DAY_BLOCKS / 8) : ROUTING_WINDOW;   // ~3h vs full
const rankedPools = all.length ? all : (readData("pools.json")?.pools || []);
const activeForRouting = active.length ? active : rankedPools.slice(0, 250);

let routing = null, routingFrom = null;
if (activeForRouting.length) {
  const built = await buildRoutingIndex(rankedPools, activeForRouting, latest, {
    window: routingScan,
    seed: seedTxIndex, seedFrom,
  });
  routingFrom = built.routingFrom;
  routing = analyseRouting(built.txIndex, rankedPools, tm, {
    priorDaily: priorRouting?.daily || [],
    rescanFromDay: tm.dayBucket(built.routingFrom),
    windowDays: 3,
  });
  console.log(`  κ = ${(routing.measuredKappaRatio * 100).toFixed(2)}% of direct volume over ${routing.kappaWindowDays}d -> regime "${routing.impliedRegime}"`);
  console.log(`  this scan: ${routing.transactions.crossRouting.toLocaleString()} cross-routing txs of ${routing.transactions.multiLeg.toLocaleString()} multi-leg`);
} else {
  console.log("  no ranked pools available; leaving routing.json untouched");
}

step("Indexing burn / lock / vault ledger");
const burns = await indexBurns(latest, tm, { prev: flag("rebuild") ? null : readData("burns.json") });
console.log(`  burned ${burns.burned.toLocaleString()} AI over ${burns.burnEvents} events`);
console.log(`  vault holds ${burns.vault.aiBalance.toLocaleString()} AI + ${burns.vault.nvdaBalance.toLocaleString()} NVDA`);
console.log(`  observed fee split burn:lock:platform = 1 : ${burns.observedSplit?.lock} : ${burns.observedSplit?.platform}`);
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
  rpc: C.RPCS[0],
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
if (routing) writeData("routing.json", { updatedAt: now, windowFrom: routingFrom, ...routing });
writeData("tape.json", { updatedAt: now, pools: flow.perPool.map((p) => p.pairSymbol), swaps: flow.tape });
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
      prior: flag("rebuild") ? null : readData("bridges.json"),
      // Formation needs the pools that are dormant too, or the rate it reports is
      // survivorship-filtered: `active` excludes anything that stopped trading, so
      // older days lose their casualties and look quieter than they were.
      allPools: all,
      store,
    });
    writeData("bridges.json", { updatedAt: now, ...bridges });
  } catch (e) {
    console.warn(`  bridge analysis failed (${e.message}); leaving previous bridges.json in place`);
  }
}

console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s using ${rpcCalls()} RPC calls.`);
