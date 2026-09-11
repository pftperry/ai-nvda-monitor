#!/usr/bin/env node
import * as C from "./config.mjs";
import { blockNumber, rpcCalls } from "./rpc.mjs";
import { hookPermissions } from "./decode.mjs";
import { Store, writeData, readData } from "./store.mjs";
import { loadTimeMap } from "./timemap.mjs";
import { discoverPools, buildRoutingIndex } from "./tasks/pools.mjs";
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
const step = (m) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const store = new Store();
const latest = await blockNumber();
console.log(`Robinhood Chain (${C.CHAIN_ID}) head block ${latest.toLocaleString()}`);
console.log(`AI genesis block ${C.GENESIS_BLOCK.toLocaleString()} -> ${(latest - C.GENESIS_BLOCK).toLocaleString()} blocks of history`);
if (quick) console.log("QUICK MODE: shortened windows, fewer pools");
if (deep) console.log("DEEP MODE: 18 pools, 14-day routing window, 7-day bridge window");
console.log(`windows -> activity ${(ACTIVITY_WINDOW / DAY_BLOCKS).toFixed(1)}d · routing ${(ROUTING_WINDOW / DAY_BLOCKS).toFixed(1)}d · bridges ${(BRIDGES_WINDOW / DAY_BLOCKS).toFixed(1)}d · top ${TOP_FLOW} pools · ${BRIDGES_TOP} bridge tokens`);

step("Building block -> time anchors");
const tm = await loadTimeMap(store, latest);
console.log(`  ${tm.toJSON().length} anchors; head = ${new Date(tm.at(latest) * 1000).toISOString()}`);

step("Discovering AI pools");
// Ranking needs breadth (all pools) but not depth (a short window suffices).
const { all, active, seedTxIndex, seedFrom } = await discoverPools(latest, {
  activityWindow: ACTIVITY_WINDOW,
  nameTop: quick ? 40 : 120,
});

// The two flagship venues are always indexed in depth regardless of how they rank.
// Raw swap count is dominated by freshly-launched dust tokens churning through their
// first hours, which would otherwise push AI/NVDA -- the pool that actually feeds the
// vault -- off the list entirely.
const PINNED = [C.AI_NVDA_POOL, C.AI_USDG_POOL];
const pinned = PINNED
  .map((id) => active.find((p) => p.poolId === id) || all.find((p) => p.poolId === id))
  .filter(Boolean);
const selected = [...pinned, ...active.filter((p) => !PINNED.includes(p.poolId))].slice(0, TOP_FLOW);
console.log(`  pinned flagships: ${pinned.map((p) => "AI/" + (p.pairSymbol || "?")).join(", ")}`);
// Feed the previous run's series back in so only new blocks are scanned.
const priorFlow = flag("rebuild") ? null : readData("flow.json");
const prev = new Map((priorFlow?.pools || []).map((p) => [p.poolId, p]));
if (prev.size) console.log(`  resuming from stored series for ${prev.size} pools (--rebuild to force a full re-scan)`);

step(`Indexing buy/sell flow for top ${selected.length} pools`);
const flow = await indexFlow(selected, latest, tm, { prev });

step("Measuring real cross-routing (κ)");
// Routing wants depth (several days) but only over pools that actually trade.
const { txIndex, routingFrom } = await buildRoutingIndex(all, active, latest, {
  window: ROUTING_WINDOW,
  seed: seedTxIndex, seedFrom,
});
const routing = analyseRouting(txIndex, all, tm);
console.log(`  measured cross-routing = ${(routing.measuredKappaRatio * 100).toFixed(2)}% of direct volume -> regime "${routing.impliedRegime}"`);
console.log(`  ${routing.transactions.crossRouting.toLocaleString()} cross-routing txs of ${routing.transactions.multiLeg.toLocaleString()} multi-leg`);

step("Indexing burn / lock / vault ledger");
const burns = await indexBurns(latest, tm, {});
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
  poolCounts: { withAI: all.length, active: active.length, indexed: selected.length },
  rpcCalls: rpcCalls(),
  buildSeconds: Math.round((Date.now() - t0) / 1000),
});
writeData("pools.json", { updatedAt: now, pools: active.slice(0, 250) });
writeData("flow.json", { updatedAt: now, windows, pools: flowOut });
writeData("burns.json", burns);
writeData("routing.json", { updatedAt: now, windowFrom: routingFrom, ...routing });
writeData("tape.json", { updatedAt: now, pools: flow.perPool.map((p) => p.pairSymbol), swaps: flow.tape });
store.save();

/* Bridges run last, after everything else is already on disk, and cannot take the
   rest down with them. Per-token venue discovery is by far the most expensive
   step -- a single popular token can have dozens of venues and a heavy tape -- and
   it is the least critical surface. Flow, burn and routing must not sit unwritten
   behind it. The page treats bridges.json as optional for the same reason. */
if (!flag("no-bridges")) {
  step("Analysing bridges and AI-pair share");
  try {
    const bridges = await analyseBridges(active, latest, tm, {
      window: BRIDGES_WINDOW,
      topN: BRIDGES_TOP,
    });
    writeData("bridges.json", { updatedAt: now, ...bridges });
  } catch (e) {
    console.warn(`  bridge analysis failed (${e.message}); leaving previous bridges.json in place`);
  }
}

console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s using ${rpcCalls()} RPC calls.`);
