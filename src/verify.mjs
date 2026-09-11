#!/usr/bin/env node
/* Post-index assertions. Catches a silently-wrong index, which is worse than a
   failed one: a dashboard that renders confidently from bad data will be trusted.
   Run after `npm run index`; CI fails the build if anything here fails. */
import { readData } from "./store.mjs";
import * as C from "./config.mjs";

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
}

const meta = readData("meta.json");
const burns = readData("burns.json");
const flow = readData("flow.json");
const routing = readData("routing.json");
const bridges = readData("bridges.json");

if (!meta || !burns || !flow) {
  console.error("Missing data artifacts. Run `npm run index` first.");
  process.exit(1);
}

/* Provenance first. Synthetic fixtures were once committed by accident, and
   plausible-looking fake numbers on a page someone makes decisions from are worse
   than no page at all. Nothing ships unless it carries the indexer's own stamp. */
console.log("Provenance");
check("data carries the indexer's provenance stamp", meta.source === "robinhood-chain-rpc",
  `source = ${JSON.stringify(meta.source)}`);
check("data is not marked synthetic", !meta.synthetic);
check("head block is plausible for this chain", meta.headBlock > 50_000_000,
  `${meta.headBlock?.toLocaleString?.() ?? meta.headBlock}`);

console.log("\nSupply ledger");
check("exactly one mint event ever", burns.mintEvents === 1, `${burns.mintEvents} mints`);
check("genesis supply is 1e9", Math.abs(burns.mintedTotal - 1e9) < 1, `${burns.mintedTotal}`);
check(
  "genesis - burned == live totalSupply",
  Math.abs(burns.genesisSupply - burns.burned - burns.totalSupply) < 1,
  `residual ${(burns.genesisSupply - burns.burned - burns.totalSupply).toExponential(3)} AI`
);
check("burns are non-zero", burns.burned > 0, `${burns.burned.toFixed(2)} AI`);
check(
  "vault AI balance matches summed inbound locks",
  Math.abs(burns.vault.aiBalance - burns.lockedInVault) <= Math.max(1, burns.lockedInVault * 0.001),
  `balance ${burns.vault.aiBalance.toFixed(2)} vs inbound ${burns.lockedInVault.toFixed(2)}`
);
check("effective float is positive and below total supply",
  burns.effectiveFloat > 0 && burns.effectiveFloat < burns.totalSupply,
  `${burns.effectiveFloat.toFixed(0)} of ${burns.totalSupply.toFixed(0)}`);
check("NVDA reserve is non-negative", burns.vault.nvdaBalance >= 0, `${burns.vault.nvdaBalance}`);

console.log("\nFee mechanics");
check("observed split is present", !!burns.observedSplit);
/* Assert the structure, not a remembered ratio. The burn and lock legs are paid
   in lockstep by the splitter, which is a strong structural claim worth testing;
   the platform leg's size is a policy choice that could legitimately change, so
   pinning it to a constant would turn a config change into a false alarm. */
check(
  "burn and vault-lock legs are paid in lockstep",
  burns.observedSplit && Math.abs(burns.observedSplit.lock - 1) < 0.02,
  burns.observedSplit ? `lock/burn = ${burns.observedSplit.lock}` : "n/a"
);
check("platform leg is a positive, bounded share of the burn leg",
  burns.observedSplit && burns.observedSplit.platform > 0 && burns.observedSplit.platform < 3,
  burns.observedSplit ? `platform/burn = ${burns.observedSplit.platform}` : "n/a");
check("fee legs are measured on the splitter's own outflows",
  !!burns.feeLegs && burns.feeLegs.burn > 0,
  burns.feeLegs ? `burn ${burns.feeLegs.burn.toFixed(0)} / lock ${burns.feeLegs.lock.toFixed(0)} / platform ${burns.feeLegs.platform.toFixed(0)} AI` : "missing");
check("splitter burn leg does not exceed all burns",
  burns.feeLegs && burns.feeLegs.burn <= burns.burned + 1,
  burns.feeLegs ? `${burns.feeLegs.burn.toFixed(0)} of ${burns.burned.toFixed(0)}` : "n/a");

console.log("\nPools and flow");
check("the flagship AI/NVDA pool is indexed",
  flow.pools.some((p) => p.poolId === C.AI_NVDA_POOL),
  flow.pools.map((p) => p.pairSymbol).join(", "));
const nvda = flow.pools.find((p) => p.poolId === C.AI_NVDA_POOL);
check("AI/NVDA carries the dynamic-fee flag", nvda && nvda.fee === C.DYNAMIC_FEE_FLAG, nvda ? `fee=${nvda.fee}` : "missing");
check("AI/NVDA dynamic fee resolves to 7000 pips (0.70%)", nvda && nvda.lastFeePips === 7000, nvda ? `${nvda.lastFeePips} pips` : "missing");
check("AI/NVDA uses the LONG hook", nvda && nvda.isLongHook);
check("every indexed pool has hourly buckets", flow.pools.every((p) => p.hourly.length > 0));
check("hourly buckets are strictly ordered in time",
  flow.pools.every((p) => p.hourly.every((h, i) => i === 0 || h.t > p.hourly[i - 1].t)));
check("no bucket reports negative volume",
  flow.pools.every((p) => p.hourly.every((h) => h.aiBuy >= 0 && h.aiSell >= 0)));
check("buy/sell counts match bucket totals",
  flow.pools.every((p) => p.hourly.every((h) => (h.buys > 0 ? h.aiBuy > 0 : h.aiBuy === 0))));
check("distinct buyers never exceed buy count",
  flow.pools.every((p) => p.hourly.every((h) => h.buyers <= h.buys && h.sellers <= h.sells)));
check("every pool records a resume cursor", flow.pools.every((p) => p.cursor > 0));
check("more pools contain AI than are active", meta.poolCounts.withAI > meta.poolCounts.active,
  `${meta.poolCounts.withAI} total vs ${meta.poolCounts.active} active`);

console.log("\nRouting");
if (routing) {
  check("cross-routing ratio is a sane fraction",
    routing.measuredKappaRatio >= 0 && routing.measuredKappaRatio < 5, `${routing.measuredKappaRatio}`);
  check("direct volume is positive", routing.directAI > 0, `${routing.directAI}`);
  check("cross-routing txs do not exceed multi-leg txs",
    routing.transactions.crossRouting <= routing.transactions.multiLeg,
    `${routing.transactions.crossRouting} of ${routing.transactions.multiLeg}`);
} else check("routing.json present", false);

console.log("\nBridges");
if (bridges && bridges.tokens) {
  check("AI-pair shares are within [0,1]",
    bridges.tokens.every((t) => t.aiPairShare >= 0 && t.aiPairShare <= 1));
  check("each bridged token has at least one AI venue",
    bridges.tokens.every((t) => t.aiVenues >= 1));
} else console.log("  --  bridges.json absent (optional)");

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures) {
  console.error(`${failures} FAILED — the indexed data is not trustworthy.`);
  process.exit(1);
}
