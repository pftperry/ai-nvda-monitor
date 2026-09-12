#!/usr/bin/env node
/* Post-index assertions. Catches a silently-wrong index, which is worse than a
   failed one: a dashboard that renders confidently from bad data will be trusted.
   Run after `npm run index`; CI fails the build if anything here fails. */
import { readData } from "./store.mjs";
import * as C from "./config.mjs";

let failures = 0, checks = 0, warnings = 0;
function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
}

/* Not everything that is worth saying should stop a deploy.
   A failure means the data is WRONG and publishing it would mislead. Incomplete is
   a different thing: if coverage drifts because the chain grew a busy new venue,
   the right response is to widen the indexed set, not to take the site down and
   leave readers on data that is now hours older still. Those report and carry on;
   CI surfaces them as annotations. */
function warn(name, ok, detail = "") {
  checks++;
  if (!ok) { warnings++; console.log(` WARN  ${name}${detail ? `  — ${detail}` : ""}`); if (process.env.GITHUB_ACTIONS) console.log(`::warning::${name}: ${detail}`); }
  else console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`);
}

const meta = readData("meta.json");
const burns = readData("burns.json");
const flow = readData("flow.json");
const routing = readData("routing.json");
const bridges = readData("bridges.json");
const poolsArtifact = readData("pools.json");

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
/* The anti-double-count assertion. Burned AI is destroyed and is NOT part of
   totalSupply; vault-locked AI still exists and IS. They are near-identical in
   size only because the fee splits them 1:1, which makes the pair look like one
   quantity counted twice. This partition proves they are not: the live supply
   divides exactly into vault + pool inventory + float, with burned outside it. */
const partition = burns.vault.aiBalance + burns.poolManagerAI + burns.effectiveFloat;
check("live supply partitions exactly into vault + pool inventory + float",
  Math.abs(partition - burns.totalSupply) < 1,
  `${partition.toFixed(2)} vs totalSupply ${burns.totalSupply.toFixed(2)}`);
check("nothing has ever left the vault",
  Math.abs(burns.lockedInVault - burns.vault.aiBalance) < 1,
  `inbound ${burns.lockedInVault.toFixed(2)} vs balance ${burns.vault.aiBalance.toFixed(2)}`);
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
/* Coverage, and the bias hiding inside it.
   Every cross-venue figure on the site -- fee leakage above all -- is measured over
   the pools indexed in depth, so how much of the chain that set represents is part
   of what those figures mean. It is also not just a question of size: eight pools
   covered 73% of swaps but happened to include the large hookless venues and miss a
   dozen small hooked ones, so leakage read 74% against 65% for the full active set.
   A partial sample is fine and unavoidable; a partial sample that leans one way is
   a wrong answer. Both are asserted. */
if (poolsArtifact?.pools?.length) {
  const ranked = poolsArtifact.pools.filter((p) => p.swapsInWindow > 0);
  const indexed = new Set(flow.pools.map((p) => p.poolId));
  const swaps = (rows) => rows.reduce((s, p) => s + p.swapsInWindow, 0);
  const totalSwaps = swaps(ranked);
  const inSet = ranked.filter((p) => indexed.has(p.poolId));
  const cover = totalSwaps > 0 ? swaps(inSet) / totalSwaps : 0;
  /* Two thresholds for the same quantity, because they mean different things. Below
     60% the cross-venue figures stop describing the chain and publishing them would
     mislead, so that fails. Between 60% and 80% they are still broadly right but the
     indexed set wants widening, which is work for a person and no reason to withhold
     an otherwise-good refresh. */
  check("the indexed pools cover enough activity to mean anything",
    cover >= 0.6,
    `${(cover * 100).toFixed(1)}% of swaps across ${inSet.length} of ${ranked.length} active pools`);
  warn("the indexed pools cover most measured activity", cover >= 0.8,
    `${(cover * 100).toFixed(1)}% — consider raising --top`);

  const hooklessShare = (rows) => {
    const t = swaps(rows);
    return t > 0 ? swaps(rows.filter((p) => !p.isLongHook)) / t : 0;
  };
  const skew = Math.abs(hooklessShare(inSet) - hooklessShare(ranked));
  warn("the indexed set is not skewed on hook status",
    skew <= 0.07,
    `indexed ${(hooklessShare(inSet) * 100).toFixed(1)}% hookless vs ${(hooklessShare(ranked) * 100).toFixed(1)}% across all active (gap ${(skew * 100).toFixed(1)}pt)`);
}

/* The indexed set must stay diverse. Everything that depends on it -- fee
   leakage, net flow, the USD price -- is a comparison ACROSS venues, and a set
   collapsed onto one counterparty still produces confident-looking numbers. A
   pin rule that over-matched did exactly that: eight slots, seven of them USDG
   dust, AI/ETH and AI/OPEN gone, and nothing failed. */
{
  const counterparties = new Set(flow.pools.map((p) => p.pairToken));
  check("the indexed set spans several counterparty tokens",
    counterparties.size >= Math.min(4, flow.pools.length),
    `${counterparties.size} distinct tokens across ${flow.pools.length} pools`);
}
/* A four-order-of-magnitude jump between two adjacent hourly closes is not a
   price move, it is a units change. This is the check that should have existed when USDG's
   decimals were corrected: the fix applied to new buckets only, so 205 of 211
   stored closes stayed 1e12 too small and the 24h change tile read
   "+1,170,701,449,776x" without anything failing. Incremental indexing makes this
   a whole class of bug -- a decode fix repairs the future and leaves the past -- so
   the seam itself is what gets asserted.
   The threshold is 10,000x, and the first three hours of a pool's life are
   exempt: a launch can legitimately print an absurd first price before real
   trading sets a level (AI/OPEN's largest real hourly ratio is 30x, in its
   opening hour). Every decimals error is a power of ten at least 1e3 and usually
   1e12, so the gap between "loud price move" and "wrong units" is wide. */
for (const p of flow.pools) {
  const closes = p.hourly.filter((h) => h.close > 0).slice(3);
  let worst = null;
  for (let i = 1; i < closes.length; i++) {
    const r = Math.max(closes[i].close / closes[i - 1].close, closes[i - 1].close / closes[i].close);
    if (!worst || r > worst.r) worst = { r, t: closes[i].t };
  }
  check(`AI/${p.pairSymbol || "?"} (${p.poolId.slice(0, 8)}) closes have no units seam`,
    !worst || worst.r < 10_000,
    worst ? `largest hour-on-hour ratio ${worst.r < 1000 ? worst.r.toFixed(2) : worst.r.toExponential(1)}x at ${new Date(worst.t * 1000).toISOString()}` : "no prices");
}
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
  /* The population headline must lie inside the range of the per-token shares it
     summarises. This is the check that would have caught the aggregate built by
     summing volumes denominated in different tokens: it reported 9.05% organic
     while every organic token but one sat under 2%. Any statistic outside
     [min, max] is not a summary of this population. */
  for (const [kind, s] of Object.entries(bridges.byKind || {})) {
    const rows = bridges.tokens.filter((t) => t.kind === kind);
    if (!rows.length) continue;
    const lo = Math.min(...rows.map((t) => t.aiPairShare));
    const hi = Math.max(...rows.map((t) => t.aiPairShare));
    const stats = ["medianShare", "meanShare", "weightedShare"]
      .filter((f) => s[f] != null).map((f) => [f, s[f]]);
    check(`${kind} aggregates lie within the per-token share range`,
      stats.every(([, v]) => v >= lo - 1e-9 && v <= hi + 1e-9),
      `[${(lo * 100).toFixed(2)}%, ${(hi * 100).toFixed(2)}%] vs ${stats.map(([f, v]) => `${f} ${(v * 100).toFixed(2)}%`).join(", ")}`);
    check(`${kind} volume sums are flagged non-comparable`, s.unitsComparable === false);
  }
} else console.log("  --  bridges.json absent (optional)");

console.log(`
${checks - failures}/${checks} checks passed${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`);
if (failures) {
  console.error(`${failures} FAILED — the indexed data is not trustworthy.`);
  process.exit(1);
}
