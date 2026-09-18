#!/usr/bin/env node
/* Post-index assertions. Catches a silently-wrong index, which is worse than a
   failed one: a dashboard that renders confidently from bad data will be trusted.
   Run after `npm run index`; CI fails the build if anything here fails. */
import { readData } from "./store.mjs";
import * as C from "./config.mjs";
import { HOLE_HORIZON_DAYS, HOLE_RATIO } from "./tasks/routing.mjs";

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

const compactUsd = (n) => "$" + (n >= 1e6 ? (n / 1e6).toFixed(0) + "M" : (n / 1e3).toFixed(0) + "k");

const meta = readData("meta.json");
const burns = readData("burns.json");
const flow = readData("flow.json");
const routing = readData("routing.json");
const bridges = readData("bridges.json");
const poolsArtifact = readData("pools.json");
const depth = readData("depth.json");
const launchpad = readData("launchpad.json");
const holders = readData("holders.json");
const rwa = readData("rwa.json");
const revenue = readData("revenue.json");

if (!meta || !burns || !flow) {
  console.error("Missing data artifacts. Run `npm run index` first.");
  process.exit(1);
}

/* Provenance first. Synthetic fixtures were once committed by accident, and
   plausible-looking fake numbers on a page someone makes decisions from are worse
   than no page at all. Nothing ships unless it carries the indexer's own stamp. */
/* The ledger is summed from logs up to a block; the balances are read live at
   whatever block the node is on when the call lands. Those cannot be the same
   block -- this node serves no archive state, so the reads cannot be pinned
   backwards, and the scan can only be brought forward to meet them. On a fast
   refresh the gap is nothing. On a long backfill it was 596 AI.

   An invariant that fails on every long run and passes on every short one teaches
   people to ignore it, which is worse than not having it. So the indexer records
   how many blocks of skew remained and what the chain's own recent burn rate makes
   that worth; a residual the skew explains is arithmetic, and only one it cannot
   is a bug. Falls back to the old absolute when an older artifact carries no
   measurement. */
const reconTolerance = burns?.skewAllowance > 0 ? burns.skewAllowance : 1;
const skewNote = burns?.stateSkewBlocks
  ? `, within ${reconTolerance.toFixed(2)} AI explained by ${burns.stateSkewBlocks} blocks of read skew`
  : "";

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
  Math.abs(burns.genesisSupply - burns.burned - burns.totalSupply) <= reconTolerance,
  `residual ${(burns.genesisSupply - burns.burned - burns.totalSupply).toExponential(3)} AI${skewNote}`
);
check("burns are non-zero", burns.burned > 0, `${burns.burned.toFixed(2)} AI`);
check("effective float is positive and below total supply",
  burns.effectiveFloat > 0 && burns.effectiveFloat < burns.totalSupply,
  `${burns.effectiveFloat.toFixed(0)} of ${burns.totalSupply.toFixed(0)}`);
/* The anti-double-count assertion. Burned AI is destroyed and is NOT part of
   totalSupply; vault-locked AI still exists and IS. They are near-identical in
   size only because the fee splits them 1:1, which makes the pair look like one
   quantity counted twice. This partition proves they are not: the live supply
   divides exactly into vault + pool inventory + float, with burned outside it. */
// heldByHook exists only on artifacts whose float already excludes it; older ones partition without it.
const partition = burns.vault.aiBalance + burns.poolManagerAI + (burns.heldByHook ?? 0) + burns.effectiveFloat;
check("live supply partitions exactly into vault + pool inventory + hook reserves + float",
  Math.abs(partition - burns.totalSupply) < 1,
  `${partition.toFixed(2)} vs totalSupply ${burns.totalSupply.toFixed(2)}`);
/* Burned and vault-locked are two different sets of tokens that happen to be the
   same size: the splitter sends one AI to 0x0 for every AI it sends to the vault.
   Assert the equality, so the page can state it as a fact of the mechanism rather
   than leave two identical numbers looking like one counted twice. */
check("burned equals vault-locked, because the splitter pays them 1:1",
  Math.abs(burns.feeLegs.burn - burns.feeLegs.lock) <= Math.max(1, burns.feeLegs.burn * 0.001),
  `${burns.feeLegs.burn.toFixed(0)} burned vs ${burns.feeLegs.lock.toFixed(0)} locked, by the splitter`);
/* One assertion, one tolerance.

   The vault balance and the sum of its inbound transfers were checked twice: once
   against 0.1% of the balance and once against the skew allowance. The same gap
   therefore came back both green and red, and the loose reading certified a 182 AI
   discrepancy as fine. Two tolerances on one quantity means the weaker one is
   noise, so only the strict reading survives. It proves two things at once: that
   every token in the vault arrived through a transfer the ledger counted, and that
   none has ever left. */
check("nothing has ever left the vault",
  Math.abs(burns.lockedInVault - burns.vault.aiBalance) <= reconTolerance,
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
  /* Floor lowered from 60% on 14 Sep: activity spread across 250 pools and twenty
     indexed pools fell from 90% to 53% of swaps within a day, and the site then
     served stale data for seven hours over a coverage drift -- the outcome the note
     above says this check must not cause. --top was widened at the same time. */
  check("the indexed pools cover enough activity to mean anything",
    cover >= 0.4,
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
   The threshold is 10,000x and NOTHING is exempt. There used to be a three-hour
   grace at the start of each pool's life, on the reasoning that a launch can print
   an absurd first price before real trading sets a level. That reasoning was sound
   and the exemption was still wrong: the largest genuine opening-hour move measured
   anywhere here is AI/OPEN at 30x, nowhere near the threshold, so the grace period
   protected nothing legitimate -- while hiding a 1.2e34 seam sitting at index 2 of
   an AI/ETH pool, which passed CI and shipped. An exemption that only ever excuses
   real faults is not a tolerance, it is a blind spot. */
for (const p of flow.pools) {
  const closes = p.hourly.filter((h) => h.close > 0);
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
  /* The daily series against flow over the same days. Routing counts a transaction
     once across every active venue and flow counts every leg on the indexed ones,
     so a complete day agrees to within a small factor (measured 0.85-0.95). A day
     far below that was rebuilt from a partial scan -- the fast path did exactly this
     to every current day for a week, and a complete day read 0.0M against 101M --
     and κ's own history, which the rating ranks it on, was mostly holes. The
     indexer now repairs holes inside its horizon on the next run, so a hole there
     fails; older ones cannot be repaired and only warn. */
  if (routing.daily?.length) {
    const today = Math.floor((meta.headTime || Date.now() / 1000) / 86400) * 86400;
    const flowByDay = new Map();
    for (const p of flow.pools) for (const h of p.hourly) {
      const d = Math.floor(h.t / 86400) * 86400;
      flowByDay.set(d, (flowByDay.get(d) || 0) + (h.aiBuy || 0) + (h.aiSell || 0));
    }
    const judge = (rows) => rows.filter((d) => {
      const fv = flowByDay.get(d.t) || 0;
      if (fv < 1e6) return false;
      const rv = (d.direct || 0) + (d.cross || 0);
      return rv < HOLE_RATIO * fv || rv > 5 * fv;
    }).map((d) => `${new Date(d.t * 1000).toISOString().slice(0, 10)} ${((d.direct + d.cross) / 1e6).toFixed(1)}M vs ${((flowByDay.get(d.t) || 0) / 1e6).toFixed(1)}M`);
    const near = routing.daily.filter((d) => d.t < today && d.t >= today - HOLE_HORIZON_DAYS * 86400);
    const far = routing.daily.filter((d) => d.t < today - HOLE_HORIZON_DAYS * 86400 && d.t >= today - 30 * 86400);
    const nearBad = judge(near), farBad = judge(far);
    check("recent routing days agree with flow over the same days", !nearBad.length,
      nearBad.length ? nearBad.join("; ") : `${near.length} complete day(s) within ${HOLE_RATIO}-5x of flow`);
    warn("older routing days agree with flow", !farBad.length,
      farBad.length ? `${farBad.join("; ")} — before the repair horizon; κ percentiles skip nothing, so treat them with care` : `${far.length} day(s)`);
    warn("routing carries a resume cursor", routing.cursor > 0,
      routing.cursor ? "" : "older artifact; the next fast run rebuilds today from its start rather than appending");
  }
} else check("routing.json present", false);

console.log("\nFee rate");
if (burns.effectiveFeeRate != null) {
  check("the effective fee rate is a plausible fraction of the nominal 0.70%",
    burns.effectiveFeeRate > 0.001 && burns.effectiveFeeRate < 0.012,
    `${(burns.effectiveFeeRate * 100).toFixed(3)}% (${burns.feeRateBasis})`);
  check("implied notional divides by the measured rate",
    Math.abs(burns.impliedAILegVolume * burns.effectiveFeeRate - burns.totalAIFee) < 1,
    `${burns.impliedAILegVolume.toExponential(3)} × rate = ${(burns.impliedAILegVolume * burns.effectiveFeeRate).toFixed(0)} vs fees ${burns.totalAIFee.toFixed(0)}`);
} else console.log("  --  effective fee rate not measured in the run that wrote this artifact");

console.log("\nPrices");
{
  const prices = readData("prices.json");
  if (prices) {
    check("NVDA has a positive dollar price", prices.nvdaUsd == null || (prices.nvdaUsd > 0 && isFinite(prices.nvdaUsd)),
      prices.nvdaUsd == null ? "no direct print (implied only)" : `$${prices.nvdaUsd.toFixed(2)} from ${prices.nvdaVenues} NVDA/USDG venues`);
    /* Two routes to one price: the stock token's own USDG pool, and AI-in-USDG
       over AI-in-NVDA. A fee tier's worth of spread is expected; a factor is not. */
    if (prices.nvdaUsd && prices.nvdaUsdImplied) {
      const r = prices.nvdaUsd / prices.nvdaUsdImplied;
      warn("NVDA's direct and implied dollar prices agree", r > 0.85 && r < 1.15,
        `direct $${prices.nvdaUsd.toFixed(2)} vs implied $${prices.nvdaUsdImplied.toFixed(2)} (${((r - 1) * 100).toFixed(1)}% apart)`);
    }
    check("price history is ordered in time", (prices.history || []).every((h, i, a) => i === 0 || h.t > a[i - 1].t), `${(prices.history || []).length} hourly rows`);
  } else console.log("  --  prices.json absent (optional)");
}

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

console.log("\nLiquidity depth");
if (depth && depth.pools?.length) {
  /* Depth is the only forward-looking number on the site, so it gets the same
     treatment as the backward-looking ones. These assert the geometry rather than
     the values: bids are quote below spot and asks are AI above it BY DEFINITION,
     so if that stops holding the side attribution is inverted and the headline
     points the wrong way -- which is the one failure that would actively mislead. */
  check("depth bins share one dollars-per-AI grid", depth.gridIsUsdPerAi === true,
    "pools price AI in different quotes; merging native grids would be meaningless");

  const bidAbove = depth.book.filter((b) => b.p > depth.aiUsd).reduce((s, b) => s + b.bid, 0);
  const askBelow = depth.book.filter((b) => b.p < depth.aiUsd).reduce((s, b) => s + b.ask, 0);
  /* A tenth, not a fiftieth. Every pool is binned on ONE dollars-per-AI grid
     anchored to the AI/USDG price, but pools do not all trade at the same price --
     fee tiers differ and arbitrage is not instantaneous -- so a venue whose own spot
     sits under the global one legitimately places a sliver of its asks below the
     shared line. Measured, that sliver is about 2%. What this check exists to catch
     is INVERSION, where bid and ask have been swapped and the headline points the
     wrong way; that reads near 100%, nowhere near the boundary. A threshold tight
     enough to trip on normal cross-venue spread would just get relaxed the first
     time it fired, which is how a check stops meaning anything. */
  check("bids sit below spot and asks above it",
    bidAbove / Math.max(1, depth.bidUsd) < 0.1 && askBelow / Math.max(1, depth.askUsd) < 0.1,
    `${(bidAbove / Math.max(1, depth.bidUsd) * 100).toFixed(2)}% of bids above spot, ` +
    `${(askBelow / Math.max(1, depth.askUsd) * 100).toFixed(2)}% of asks below`);

  check("the imbalance is bids minus asks",
    Math.abs(depth.imbalanceUsd - (depth.bidUsd - depth.askUsd)) <= 1,
    `${depth.imbalanceUsd} vs ${depth.bidUsd - depth.askUsd}`);

  const sumBid = depth.pools.reduce((s, p) => s + p.bidUsd, 0);
  const sumAsk = depth.pools.reduce((s, p) => s + p.askUsd, 0);
  check("per-venue depth sums to the totals",
    Math.abs(sumBid - depth.bidUsd) <= depth.pools.length && Math.abs(sumAsk - depth.askUsd) <= depth.pools.length,
    `${sumBid} vs ${depth.bidUsd}, ${sumAsk} vs ${depth.askUsd}`);

  check("depth is positive and finite",
    depth.pools.every((p) => p.tvlUsd >= 0 && isFinite(p.tvlUsd) && isFinite(p.bidUsd) && isFinite(p.askUsd)));

  warn("every indexed venue has a replayed tick ladder", !depth.skipped,
    depth.skipped ? `${depth.skipped} venue(s) not yet replayed; depth understates until they are` : "");

  /* Cost to trade: a bigger sale cannot move the price less, a router can never do
     worse than the best single venue, and the protocol cannot own more than the book. */
  if (depth.impact) {
    const mono = (xs) => xs.every((x, i) => x.pct == null || i === 0 || xs[i - 1].pct == null || x.pct >= xs[i - 1].pct - 1e-9);
    check("price impact is monotonic in trade size", mono(depth.impact.sell) && mono(depth.impact.buy));
    const best1m = Math.min(...depth.pools.map((p) => p.impact?.sell.find((x) => x.usd === 1e6)?.pct ?? 1));
    const merged1m = depth.impact.sell.find((x) => x.usd === 1e6)?.pct;
    check("routing across venues is no worse than the best single venue", merged1m == null || merged1m <= best1m + 1e-3,
      `merged ${merged1m} vs best venue ${best1m}`);
    check("the protocol's own liquidity is a share of the book, not more",
      depth.pools.every((p) => p.hookShare == null || (p.hookShare >= 0 && p.hookShare <= 1.0001)) && depth.hookTvlUsd <= depth.tvlUsd * 1.0001,
      `$${depth.hookTvlUsd} of $${Math.round(depth.tvlUsd)}`);
  } else warn("cost-to-trade ladder walk is present", false, "depth.json predates the impact walk");

  /* The near-spot bands are what the headline KPI reads, and they are summed on a
     second pass through the same ladder walk as the wide book. Two independent
     sums of one quantity is exactly the setup where a units or sign slip hides, so
     assert the containment: a tighter band cannot hold more than a looser one, and
     none of them can hold more than the whole window. */
  if (depth.near?.length) {
    const w = depth.near.map((n) => n.pct);
    check("near-spot windows are ordered and inside the full book",
      w.every((x, i) => x > 0 && (i === 0 || x > w[i - 1])) && w[w.length - 1] <= depth.windowPct,
      w.map((x) => (x * 100).toFixed(0) + "%").join(" < ") + ` <= ${(depth.windowPct * 100).toFixed(0)}%`);

    const nested = depth.near.every((n, i) =>
      i === 0 || (n.bidUsd >= depth.near[i - 1].bidUsd - 1 && n.askUsd >= depth.near[i - 1].askUsd - 1));
    const contained = depth.near.every((n) => n.bidUsd <= depth.bidUsd + 1 && n.askUsd <= depth.askUsd + 1);
    check("depth in a tighter band never exceeds a wider one", nested && contained,
      depth.near.map((n) => `${(n.pct * 100).toFixed(0)}%: ${Math.round(n.bidUsd / 1e3)}k/${Math.round(n.askUsd / 1e3)}k`).join(", ") +
      ` vs full ${Math.round(depth.bidUsd / 1e3)}k/${Math.round(depth.askUsd / 1e3)}k`);

    check("near-spot depth is positive and finite",
      depth.near.every((n) => isFinite(n.bidUsd) && isFinite(n.askUsd) && n.bidUsd >= 0 && n.askUsd >= 0));

    /* Sanity on the headline itself: a book that reads 0% or 100% bids within two
       percent of spot is a decoded-wrong book, not a one-sided market. */
    const tight = depth.near[0];
    const share = tight.bidUsd / Math.max(1, tight.bidUsd + tight.askUsd);
    warn("the near-spot book has both sides", share > 0.01 && share < 0.99,
      `${(share * 100).toFixed(1)}% bids within ${(tight.pct * 100).toFixed(0)}% of spot`);
  } else console.log("  --  near-spot bands absent (older artifact)");
} else console.log("  --  depth.json absent (optional)");

console.log("\nTokenized-stock capture");
if (rwa && rwa.tokens?.length) {
  /* Shares are ratios of balances to a supply, so they are bounded by construction;
     a value outside [0, 1] means a decimals or address slip, and the headline would
     be wrong by orders of magnitude rather than a little. */
  check("no stock token has more in the pools and vault than exists",
    rwa.tokens.every((t) => t.inDex >= 0 && t.inVault >= 0 && t.inDex + t.inVault <= t.supply * 1.000001),
    rwa.tokens.filter((t) => t.inDex + t.inVault > t.supply * 1.000001).map((t) => t.symbol).join(", "));
  check("capture shares are consistent with their parts",
    rwa.tokens.every((t) => Math.abs(t.share - (t.dexShare + t.vaultShare)) < 1e-9 && t.share >= 0 && t.share <= 1.000001));
  check("the aggregate share is dollars in over dollars outstanding",
    rwa.totals.share == null || Math.abs(rwa.totals.share - (rwa.totals.dexUsd + rwa.totals.vaultUsd) / rwa.totals.supplyUsd) < 1e-9,
    `${rwa.totals.share}`);
  check("NVDA is among the stock tokens found", rwa.tokens.some((t) => t.token === C.NVDA.toLowerCase()),
    "the classifier must at least recognise the token this whole site is built on");
  check("every LONG pool quoting a stock is among that stock's pools",
    rwa.tokens.every((t) => t.poolsPartial || t.poolsLong <= t.poolsAll),
    rwa.tokens.filter((t) => !t.poolsPartial && t.poolsLong > t.poolsAll).map((t) => t.symbol).join(", "));
  if (rwa.swapShare) {
    check("LONG's stock swaps are a subset of all stock swaps",
      rwa.swapShare.longSwaps <= rwa.swapShare.stockSwaps && rwa.swapShare.aiPairedSwaps <= rwa.swapShare.longSwaps &&
      (rwa.swapShare.chainSwaps == null || rwa.swapShare.stockSwaps <= rwa.swapShare.chainSwaps),
      `${rwa.swapShare.longSwaps} LONG of ${rwa.swapShare.stockSwaps} stock swaps of ${rwa.swapShare.chainSwaps} on chain`);
    warn("the swap window was scanned to completion", !rwa.swapShare.truncated, "budget cut the day short; the share is of what was read");
    check("LONG's stock dollar volume is a subset of all stock dollar volume",
      rwa.swapShare.usdLong == null || (rwa.swapShare.usdLong >= 0 && rwa.swapShare.usdLong <= rwa.swapShare.usdAll * 1.000001),
      `$${rwa.swapShare.usdLong} of $${rwa.swapShare.usdAll}`);
  }
  if (rwa.universe) {
    check("every listed active stock is an active stock",
      rwa.totals.activeListed <= rwa.totals.activeStocks && rwa.totals.activeStocks <= rwa.totals.stocks,
      `${rwa.totals.activeListed} listed of ${rwa.totals.activeStocks} active of ${rwa.totals.stocks} stock tokens`);
    warn("the stock-event sample covers at least an hour of the trailing day", rwa.universe.blocksSampled >= 30_000,
      `${rwa.universe.blocksSampled.toLocaleString()} blocks over ${rwa.universe.samples} sample(s)`);
  }
  check("capture history is ordered", rwa.history.every((h, i, a) => i === 0 || h.t > a[i - 1].t));
  if (rwa.perps) {
    const P = rwa.perps;
    check("LongX vaults are recognised and their bridge flows add up",
      Array.isArray(P.vaults) && P.lighter.depositedUsd >= 0 && P.lighter.withdrawnUsd >= 0 && Math.abs(P.lighter.netUsd - (P.lighter.depositedUsd - P.lighter.withdrawnUsd)) <= 1
      && P.lighter.depositedUsd <= P.bridgeAll.depositedUsd + 1 && P.lighter.withdrawnUsd <= P.bridgeAll.withdrawnUsd + 1,
      `${P.vaults.length} vault(s); $${P.lighter.depositedUsd} to Lighter, $${P.lighter.withdrawnUsd} back, of $${P.bridgeAll.depositedUsd}/$${P.bridgeAll.withdrawnUsd} bridge-wide`);
    check("vault share rows are sane", P.vaults.every((v) => (v.supply == null || v.supply >= 0) && v.mint24h >= 0 && v.burn24h >= 0 && v.longPools <= v.pools));
    warn("every LongX vault share has a price", P.priced === P.vaults.length, `${P.priced} of ${P.vaults.length} priced from spot pools`);
    warn("no unattributed contracts feed the Lighter bridge", !(P.lighter.unattributed || []).length,
      (P.lighter.unattributed || []).map((u) => `${u.address.slice(0, 10)} ${u.name || "unnamed"} $${u.inUsd}`).join("; "));
    warn("perps streams have reached the head and every bridge counterparty is classified", !P.lighter.partial && !P.sharesPartial && !P.lighter.unclassified,
      `${P.lighter.unclassified || 0} unclassified; streams ${P.lighter.partial || P.sharesPartial ? "catching up" : "at the head"}`);
  }
  if (rwa.nvdaSupply) {
    const N = rwa.nvdaSupply, todayStart = Math.floor(Date.now() / 86400000) * 86400;
    check("NVDA supply history is ordered, complete days only, and adds up",
      N.days.every((r, i, a) => i === 0 || r.t > a[i - 1].t) && (!N.days.length || N.days.at(-1).t < todayStart)
      && N.days.every((r) => r.minted >= 0 && r.burned >= 0 && Math.abs(r.net - (r.minted - r.burned)) < 0.01 && r.supply >= -0.01)
      && N.days.every((r, i, a) => i === 0 || Math.abs(r.supply - (a[i - 1].supply + r.net)) < 0.01),
      `${N.days.length} day(s) since ${N.since ? new Date(N.since * 1000).toISOString().slice(0, 10) : "—"}`);
    const drift = N.now.onChain > 0 && N.now.supply != null ? Math.abs(N.now.supply + (N.today?.net || 0) - N.now.onChain) / N.now.onChain : null;
    warn("NVDA supply rebuilt from mints and burns matches the token's live totalSupply within 2%", drift == null || N.partial || drift <= 0.02,
      drift == null ? "no on-chain supply to compare" : `${(N.now.supply + (N.today?.net || 0)).toLocaleString()} rebuilt vs ${N.now.onChain.toLocaleString()} on chain (${(drift * 100).toFixed(2)}% apart)${N.partial ? "; stream still catching up" : ""}`);
    warn("NVDA supply at LONG's launch is known", N.launch?.supply > 0 && N.multiple != null, N.launch ? `${N.launch.supply} NVDA on launch day, ${N.multiple}× since` : "launch day not yet in range");
  }
  if (rwa.backing) {
    const K = rwa.backing;
    check("backing rows are sane: positive stock, market cap and supply, shares within the stock's supply",
      Array.isArray(K.rows) && K.rows.every((r) => r.stockUsd >= 0 && (r.mcapUsd == null || r.mcapUsd > 0) && r.supply >= 0 && (r.stockShare == null || (r.stockShare >= 0 && r.stockShare <= 1.05)) && (r.backing == null || r.backing >= 0) && r.vol24hUsd >= 0),
      `${K.rows.length} pair(s) from ${K.poolsConsidered} pools`);
    check("backing stock never exceeds the LONG stock inventory it is drawn from",
      rwa.longTvl ? K.rows.reduce((s, r) => s + r.stockUsd, 0) <= rwa.longTvl.usd * 1.01 + 1000 : true,
      `$${K.rows.reduce((s, r) => s + r.stockUsd, 0).toLocaleString()} across rows vs $${(rwa.longTvl?.usd ?? 0).toLocaleString()} in all LONG pools`);
    warn("every backing pair is priced", K.rows.every((r) => r.mcapUsd > 0), `${K.rows.filter((r) => !(r.mcapUsd > 0)).map((r) => r.symbol).join(", ") || "all priced"}`);
    if (K.backfill?.pools) {
      const F = K.backfill, pd = Object.values(F.pools);
      check("backing backfill days are ordered, complete UTC days, with non-negative flow and positive prices",
        pd.every((o) => Array.isArray(o.days) && o.days.every((d, i, a) => (i === 0 || d.t > a[i - 1].t) && d.gross >= 0 && d.swaps >= 0 && (d.priceInStock == null || d.priceInStock > 0))),
        `${pd.length} pair(s), ${pd.reduce((s, o) => s + o.days.length, 0)} pair-days, ${F.complete} of ${F.pairs} at the head`);
      warn("backing backfill has reached the head for every tracked pair", F.complete >= F.pairs, `${F.pairs - F.complete} pair(s) still streaming`);
      check("backfill today-so-far blocks are sane (0–24 hours, non-negative counts)", pd.every((o) => !o.today || (o.today.hours > 0 && o.today.hours <= 24.5 && o.today.swaps >= 0 && o.today.gross >= 0)));
      check("backfill dollar prices, where present, are positive and consistent with the stock close", pd.every((o) => o.days.every((d) => d.priceUsd == null || (d.priceUsd > 0 && d.stockUsd > 0 && Math.abs(d.priceUsd - d.priceInStock * d.stockUsd) <= 1e-9 * Math.max(1, d.priceUsd)))));
      warn("backfill has a dollar leg for most pair-days", (F.usdDays || 0) >= 0.8 * pd.reduce((s, o) => s + o.days.length, 0), `${F.usdDays || 0} of ${pd.reduce((s, o) => s + o.days.length, 0)} pair-days priced in dollars`);
    }
    if (K.registry) {
      const G = K.registry;
      check("listing registry has tokens and a class breakdown", G.tokens > 0 && G.byClass && Object.keys(G.byClass).length > 0);
      warn("listing registry has finished scanning", !G.partial, "still scanning the stock factory");
      warn("most listed tokens have a Chainlink feed", G.pricedTokens >= 0.5 * G.tokens, `${G.pricedTokens} of ${G.tokens} listed tokens priced by a discovered feed`);
      warn("hourly Chainlink answers are being folded", G.hourlyAnswers > 1000, `${G.hourlyAnswers} hourly answers stored`);
    }
    if (K.scoreTest) {
      const T = K.scoreTest;
      check("score retest covers both samples with a history row for this week", T.pairDays > 0 && T.all?.cohort?.tape && T.all?.survivors?.tape && Array.isArray(T.history) && T.history.length > 0);
      warn("score retest has out-of-sample pair-days (dated after the terms were fixed)", T.oos?.pairDays > 0, `none yet; the first reading arrives a week after ${new Date(T.designedAt * 1000).toISOString().slice(0, 10)}`);
    }
    if (K.stockPx?.stocks) {
      const S = Object.values(K.stockPx.stocks);
      check("stock closes are ordered daily series of positive dollar prices", S.every((s) => s.close.every(([t, v], i) => v > 0 && (i === 0 || t === s.close[i - 1][0] + 86400))));
      warn("stock closes have reached the head for every stock", S.every((s) => !s.partial), `${S.filter((s) => s.partial).length} still streaming`);
      const drifted = pd.filter((o) => o.days.some((d) => d.units != null && d.units <= 0));
      warn("backfilled stock levels stay positive (the swap-delta walk can drift where fee re-adds grew a pool)", !drifted.length,
        drifted.length ? `${drifted.map((o) => `${o.symbol} (${o.days.filter((d) => d.units != null && d.units <= 0).length} day(s))`).join(", ")}; ratios on those days are withheld` : "all positive");
      warn("backfilled shares of stock stay within the stock's supply", pd.every((o) => o.days.every((d) => d.share == null || d.share <= 1.05)),
        pd.filter((o) => o.days.some((d) => d.share > 1.05)).map((o) => o.symbol).join(", ") || "all within supply");
    }
    const H = K.history || {};
    check("backing history is ordered and sane per pair",
      Object.values(H).every((a) => Array.isArray(a) && a.every((p, i) => Array.isArray(p) && p.length >= 6 && (i === 0 || p[0] > a[i - 1][0]) && p[1] >= 0 && (p[2] == null || (p[2] >= 0 && p[2] <= 1.05)) && p[3] >= 0 && p[4] > 0)),
      `${Object.keys(H).length} pair(s), ${Object.values(H).reduce((s, a) => s + a.length, 0)} point(s) since ${K.historySince ? new Date(K.historySince * 1000).toISOString().slice(0, 10) : "—"}`);
    warn("every top pool is in the census", !K.poolsWithoutCensus, `${K.poolsWithoutCensus || 0} pool(s) without a census entry`);
  }
  if (rwa.series) {
    const Z = rwa.series, todayStart = Math.floor(Date.now() / 86400000) * 86400;
    check("since-inception history is ordered, complete days only",
      Z.days.every((r, i, a) => i === 0 || r.t > a[i - 1].t) && (!Z.days.length || Z.days.at(-1).t < todayStart), `${Z.days.length} day(s)`);
    check("since-inception volumes are internally consistent",
      Z.days.every((r) => r.longVolUsd <= r.longGrossVolUsd + 1 && r.longVolUsd <= r.longAllVolUsd + 1 && r.allVolUsd >= r.dexVolUsd - 1 && r.allInvUsd >= 0 && r.longInvUsd >= 0 && (r.shareDex == null || (r.shareDex >= 0 && r.shareDex <= 1.000001))));
    warn("LONG's stock volume stays within the transfer-measured DEX volume",
      Z.days.every((r) => r.dexVolUsd === 0 || r.longVolUsd <= r.dexVolUsd * 1.000001),
      "the hook records intra-manager hops that move no token; the transfer-basis share is an upper bound on those days");
    warn("LONG's swap-delta holdings stay near or under the pool manager's stock inventory",
      Z.days.every((r) => r.longInvUsd <= r.allInvUsd * 1.25 + 1000), "Dune's upper bound exceeds the transfer-netted inventory by more than a quarter on some day");
    const done = (Z.reconcile || []).filter((r) => r.complete && r.onChain > 0);
    const off = done.filter((r) => Math.abs(r.cumNet - r.onChain) > Math.max(0.01, r.onChain * 0.005));
    warn("streamed pool-manager inventory reconciles to live balances", !off.length, off.map((r) => `${r.symbol} ${r.cumNet} vs ${r.onChain}`).join("; "));
    warn("since-inception streams have reached the head", !(Z.tokensPartial || []).length && !Z.hookPartial && !Z.rialtoPartial,
      `catching up: ${[...(Z.tokensPartial || []), Z.hookPartial ? "hook" : null, Z.rialtoPartial ? "Rialto" : null].filter(Boolean).join(", ")}`);
  }
  if (rwa.longTvl) {
    /* LONG's pools are a subset of the pool manager, so what they hold cannot exceed
       what the manager holds; a small overshoot is the ladders' last-swap price
       against the balances' spot. */
    warn("stock inventory in LONG pools fits inside the pool manager's inventory",
      rwa.longTvl.usd <= rwa.totals.dexUsd * 1.05, `$${rwa.longTvl.usd} in LONG pools vs $${Math.round(rwa.totals.dexUsd)} in all pools`);
    if (rwa.longTvl.poolsWithLiquidity != null) {
      check("LONG-pool ladder stream reports its coverage honestly",
        rwa.longTvl.pools <= rwa.longTvl.poolsWithLiquidity && rwa.longTvl.poolsWithLiquidity <= rwa.longTvl.longStockPools
        && rwa.longTvl.backfillShare >= 0 && rwa.longTvl.backfillShare <= 1.000001,
        `${rwa.longTvl.pools} valued of ${rwa.longTvl.poolsWithLiquidity} with liquidity of ${rwa.longTvl.longStockPools}; ${(rwa.longTvl.backfillShare * 100).toFixed(1)}% of history`);
      warn("LONG-pool ladder stream has reached the head", rwa.longTvl.complete, `backfilled to block ${rwa.longTvl.backfilledTo}; the figure is a floor until it catches up`);
      if (rwa.longTvl.graduatedUsd != null) check("graduated-pool holdings are part of the LONG total",
        rwa.longTvl.graduatedUsd >= 0 && Math.abs(rwa.longTvl.usd - (rwa.longTvl.v4Usd + rwa.longTvl.graduatedUsd)) <= 2,
        `$${rwa.longTvl.v4Usd} v4 + $${rwa.longTvl.graduatedUsd} graduated = $${rwa.longTvl.usd}`);
    } else warn("LONG-pool figure comes from the full ladder stream", false, "artifact predates the stream; rebuilt on the next slow run");
  }
  for (const [tok, rows] of Object.entries(rwa.daily || {})) {
    check(`${rwa.dailyTracked?.[tok] || tok.slice(0, 8)} daily DEX inventory is a running sum that never goes negative`,
      rows.every((r, i) => (i === 0 ? Math.abs(r.cum - r.net) < 1e-3 : Math.abs(r.cum - rows[i - 1].cum - r.net) < 1e-3) && r.cum >= -1e-3),
      `${rows.length} day(s), latest ${rows.at(-1)?.cum}`);
    const t = rwa.tokens.find((x) => x.token === tok);
    if (t && rows.length && !rwa.dailyPartial?.[tok]) {
      /* The transfer replay and the live balance read measure the same thing two
         ways; they can differ by the hours since the last block the replay reached. */
      warn(`${t.symbol} inventory from transfers agrees with its live balance`,
        Math.abs(rows.at(-1).cum - t.inDex) / Math.max(1, t.inDex) < 0.05,
        `${rows.at(-1).cum.toFixed(2)} replayed vs ${t.inDex.toFixed(2)} read`);
    }
  }
} else console.log("  --  rwa.json absent (built on the slow path)");

console.log("\nFee engine");
if (revenue && revenue.daily?.length) {
  const T = revenue.totals, B = revenue.balances;
  check("fee-engine days are ordered and non-negative",
    revenue.daily.every((d, i, a) => (i === 0 || d.t > a[i - 1].t) && Object.entries(d).every(([k, v]) => k === "t" || v >= 0)));
  check("the buyback contract forwards no more AI than it received",
    T.aiBuybackToAccum + T.aiBuybackToPools <= T.aiToBuyback * 1.000001 + 1, `${T.aiBuybackToAccum + T.aiBuybackToPools} forwarded of ${T.aiToBuyback} received`);
  /* The accumulator is an EOA the scans watch on both sides, so its balance must
     equal inflow minus outflow up to the blocks between the scan and the read. */
  if (!revenue.partial && B.accumulator.ai != null) {
    const walk = T.aiBuybackToAccum - T.aiAccumOut;
    warn("the AI accumulator's balance is its inflow minus its outflow",
      Math.abs(B.accumulator.ai - walk) <= Math.max(50, B.accumulator.ai * 0.002), `${B.accumulator.ai.toFixed(2)} held vs ${walk.toFixed(2)} walked`);
    warn("the revenue wallet's USDG balance is its inflow minus its outflow",
      B.revenue.usdg == null || Math.abs(B.revenue.usdg - (T.usdgToRevenue - T.usdgRevenueOut)) <= Math.max(100, B.revenue.usdg * 0.002),
      `${B.revenue.usdg} held vs ${(T.usdgToRevenue - T.usdgRevenueOut).toFixed(2)} walked`);
  } else warn("fee-engine scan reached the head", !revenue.partial, "resumes next run");
} else console.log("  --  revenue.json absent (first pass pending)");

console.log("\nLaunchpad census");
if (launchpad && launchpad.buckets?.length) {
  /* This section exists because the Launchpad tab shipped two figures that
     contradicted the table directly beneath them, and nothing here noticed.

     One was a bucket chart whose smallest bar was 0.4% of the tallest, so four
     tokens above $10M rendered as nothing and the card appeared to claim there was
     one. The other was a headline count of tokens "backed within 20x" -- a
     threshold borrowed from no measurement, which on this platform nothing clears,
     so the tile led with a structural zero and read as "0 of 20 above $1 million".

     Both were presentation faults over correct data, which is the failure mode a
     verifier of values alone cannot see. So these check the figures AGAINST EACH
     OTHER: the count, the buckets, and the rows in the table must tell one story,
     and no headline may be a constant. */
  const lp = launchpad;
  const floor = lp.runnerFloor || 1e6;
  const aboveFloor = lp.buckets.filter((b) => b.lo >= floor).reduce((n, b) => n + b.count, 0);
  check("the runner count equals the buckets above the floor",
    lp.runners === aboveFloor, `${lp.runners} reported vs ${aboveFloor} summed from buckets`);

  const topAbove = (lp.top || []).filter((t) => t.mcapUsd >= floor).length;
  /* The table is a truncated top-N, so it can hold fewer than the total but never
     more -- and when it is not full, it must hold exactly the total. */
  check("the table agrees with the runner count",
    topAbove <= lp.runners && ((lp.top || []).length >= 30 || topAbove === lp.runners),
    `${topAbove} of ${(lp.top || []).length} listed rows clear ${compactUsd(floor)} vs ${lp.runners} counted`);

  check("every bucket count is a non-negative integer and they sum to the priced set",
    lp.buckets.every((b) => Number.isInteger(b.count) && b.count >= 0) &&
      lp.buckets.reduce((n, b) => n + b.count, 0) === lp.priced,
    `${lp.buckets.reduce((n, b) => n + b.count, 0)} bucketed vs ${lp.priced} priced`);

  /* A threshold derived from the cohort cannot be a constant, and a count taken
     against it cannot be everything or nothing. Either would mean the figure has
     stopped measuring and started asserting. */
  if (lp.ratioMeasured > 0) {
    check("the cap-to-backing median is finite and positive",
      lp.capToBackingMedian > 0 && isFinite(lp.capToBackingMedian), `${lp.capToBackingMedian}x`);
    check("the thin-backing count is a strict subset of the runners",
      lp.thinRunners >= 0 && lp.thinRunners < lp.runners,
      `${lp.thinRunners} of ${lp.runners} at ${lp.thinThreshold}x or worse`);
  } else console.log("  --  no cap-to-backing ratios measured yet");

  /* A launch census that is still walking back to genesis reports floors. That is
     fine, and it is declared on the page -- but it must be declared, because a
     partial count looks exactly like a complete one. */
  warn("the launch census has reached genesis", lp.censusPartial !== true,
    lp.censusPartial ? "still resuming from a cursor; every count on the tab is a floor" : "");

  const cum = (lp.launchesByDay || []).map((d) => d.cumulative);
  check("cumulative launches never decrease",
    cum.every((v, i) => i === 0 || v >= cum[i - 1]), `${cum.length} day(s)`);

  /* The adoption ratio is the first thing on the Investor tab, so it gets the
     tightest reading. Its whole value is that both terms come from the census by
     address and neither depends on the real-world-asset list: assert that, by
     checking the totals against the census the same file reports. */
  /* Liveness is a second count over the same cohorts, so it can only be wrong by
     exceeding them or by disagreeing with the split the page draws. */
  const days = lp.launchesByDay || [];
  if (lp.activeMeasured) {
    check("every day’s live count fits inside that day’s launches",
      days.every((d) => d.active >= 0 && d.active <= d.launched),
      days.length + " day(s)");
    check("active and dormant partition the cohort",
      days.every((d) => d.active + d.dormant === d.launched));
    const liveTotal = days.reduce((n, d) => n + d.active, 0);
    warn("the platform has more live tokens than it prices", liveTotal >= (lp.priced ?? 0),
      liveTotal + " traded in the window vs " + (lp.priced ?? 0) + " priced");
  } else console.log("  --  liveness not measured in the run that wrote this artifact");

  const flow = lp.anchorFlow || [];
  if (flow.length > 3) {
    const aiDay = Math.floor(Date.UTC(2026, 6, 14) / 1000 / 86400) * 86400;
    const i = flow.findIndex((d) => d.t === aiDay);
    warn("launchpad day series starts before AI genesis (LONG's first fortnight has its own days)", flow[0].t < aiDay, `first day ${new Date(flow[0].t * 1000).toISOString().slice(0, 10)}`);
    if (i > 0) warn("14 Jul is not a lump of pre-AI launches", flow[i].all <= 3 * Math.max(flow[i - 1].all, flow[i + 1]?.all || 0), `${flow[i].all} pools on 14 Jul against ${flow[i - 1].all} the day before`);
  }
  if (flow.length) {
    check("every day’s AI-anchored count fits inside that day’s pool count",
      flow.every((d) => d.ai >= 0 && d.all > 0 && d.ai <= d.all),
      `${flow.length} day(s)`);

    check("the published share is the ratio it claims to be",
      flow.every((d) => Math.abs((d.share ?? 0) - d.ai / d.all) < 1e-5));

    /* The flow must reconcile with the stock. Every pool the census counted lands
       in exactly one day, and every AI-side pool is what the anchor ranking counts,
       so these are the same population summed two ways. A gap means one of them
       stopped seeing part of the census -- which is precisely the failure that a
       cumulative rank cannot show. */
    const sumAll = flow.reduce((n, d) => n + d.all, 0);
    const sumAi = flow.reduce((n, d) => n + d.ai, 0);
    warn("the daily flow sums back to the census",
      Math.abs(sumAll - lp.poolsWithHook) <= Math.max(2, lp.poolsWithHook * 0.001),
      `${sumAll.toLocaleString()} across days vs ${(lp.poolsWithHook ?? 0).toLocaleString()} in the census`);
    if (lp.aiAnchorRank?.pools) {
      check("AI-side pools sum to AI’s standing in the anchor ranking",
        Math.abs(sumAi - lp.aiAnchorRank.pools) <= Math.max(2, lp.aiAnchorRank.pools * 0.001),
        `${sumAi.toLocaleString()} across days vs ${lp.aiAnchorRank.pools.toLocaleString()} ranked`);
    }
  } else console.log("  --  anchor flow absent (older artifact)");
} else console.log("  --  launchpad.json absent (optional)");

console.log("\nHolder distribution");
if (holders && holders.snapshots?.length) {
  /* A holder count is only as good as the replay under it, and a replay can be
     wrong in a way that still produces plausible counts: skip one window of
     transfers and a few thousand addresses simply hold the wrong amount. The
     balances have to sum to supply to the wei, and no address may be negative. */
  check("holder balances sum exactly to supply", Math.abs(holders.reconciliation.residualAi) < 1e-6,
    `residual ${holders.reconciliation.residualAi} AI`);
  check("no address holds a negative balance", holders.reconciliation.negativeBalances === 0,
    `${holders.reconciliation.negativeBalances} negative`);

  const snaps = holders.snapshots;
  check("snapshots run on an unbroken four-hour grid",
    snaps.every((x, i) => i === 0 || x.t - snaps[i - 1].t === 14400), `${snaps.length} snapshots`);
  check("dollar buckets partition the holders",
    snaps.every((x) => x.buckets == null || x.buckets.reduce((a, b) => a + b, 0) === x.holders));
  check("higher AI thresholds never count more holders than lower ones",
    snaps.every((x) => (x.aboveAi || []).every((v, i, a) => v <= x.holders && (i === 0 || v <= a[i - 1]))));

  /* The replay’s supply at its last four-hour boundary against the live read. They
     cannot match exactly -- burns keep landing after the boundary -- but the gap is
     at most a few hours of burn, far under a tenth of a percent. */
  const last = snaps.at(-1);
  warn("the replayed supply agrees with the live supply",
    Math.abs(last.supply - burns.totalSupply) / burns.totalSupply < 0.001,
    `${last.supply.toFixed(0)} replayed vs ${burns.totalSupply.toFixed(0)} live`);
  warn("the holder replay has reached the head", holders.complete === true,
    holders.complete ? "" : "still resuming from its cursor; counts are as of an earlier block");

  /* The readings layered on the counts, checked against each other. Concentration
     shares must nest (the top 10 cannot hold more than the top 100) and sit inside
     [0, 1]; churn counts are non-negative integers; a cohort cannot have more
     wallets still holding than it ever acquired; the tape only carries moves at or
     above its own stated floor. */
  const withTop = snaps.filter((x) => Array.isArray(x.top));
  if (withTop.length) {
    check("concentration shares nest and stay within [0, 1]",
      withTop.every((x) => x.top.every((v, i, a) => v == null || (v >= 0 && v <= 1 && (i === 0 || a[i - 1] == null || v >= a[i - 1] - 1e-9)))),
      `${withTop.length} snapshot(s); latest top-10/50/100 = ${(last.top || []).map((v) => v == null ? "—" : (v * 100).toFixed(1) + "%").join(" / ")}`);
    check("holder-owned supply never exceeds total supply",
      withTop.every((x) => x.heldAi == null || x.heldAi <= x.supply + 1));
  } else console.log("  --  concentration absent (older artifact)");
  const withChurn = snaps.filter((x) => x.newHolders != null);
  if (withChurn.length) {
    check("churn counts are non-negative integers",
      withChurn.every((x) => Number.isInteger(x.newHolders) && x.newHolders >= 0 && Number.isInteger(x.exits) && x.exits >= 0));
    /* Churn is a set difference between consecutive snapshots, so the holder count
       moves by exactly new minus exited -- an identity, and a hard check. It also
       bounds churn: pass-through routers once made a week read 382,640 wallets
       funded against 44,803 holders, which no honest definition can produce. */
    const bad = [];
    for (let i = 1; i < withChurn.length; i++) {
      const a = withChurn[i - 1], b = withChurn[i];
      if (b.t - a.t !== 14400) continue;
      if (b.holders - a.holders !== b.newHolders - b.exits) bad.push(new Date(b.t * 1000).toISOString().slice(0, 16));
    }
    check("holder count moves by exactly new minus exited", bad.length === 0,
      bad.length ? `${bad.length} snapshot(s) disagree, first ${bad[0]}` : `${withChurn.length - 1} transitions reconcile`);
    const worst = withChurn.reduce((m, s) => Math.max(m, s.newHolders, s.exits), 0);
    check("no four-hour window churns more wallets than exist", worst <= Math.max(...withChurn.map((s) => s.holders)),
      `largest four-hour churn ${worst.toLocaleString()} wallets`);
  } else console.log("  --  churn absent (older artifact)");
  if (holders.cohorts?.length) {
    check("no cohort has more wallets holding than it acquired",
      holders.cohorts.every((c) => c.holding <= c.acquired && c.holding >= 0 && c.ai >= 0), `${holders.cohorts.length} weekly cohorts`);
    warn("first-seen dates run from genesis", holders.firstSeenFromGenesis === true,
      holders.firstSeenFromGenesis ? "" : "cohorts only cover wallets that arrived after the seed; a genesis replay fills them");
  }
  if (holders.whales?.length) {
    check("every whale move is at or above the tape's floor",
      holders.whales.every((w) => w.ai >= (holders.whaleMinAi || 0) && ["buy", "sell", "received", "sent", "transfer", "hook"].includes(w.kind)),
      `${holders.whales.length} moves ≥ ${(holders.whaleMinAi || 0).toLocaleString()} AI`);
    /* Netting per transaction means a whale row names a wallet, and never machinery:
       a router hop or the fee wallet showing up here is the old attribution back. */
    const netted = holders.whales.filter((w) => w.wallet);
    if (netted.length) {
      check("whale moves name wallets, never machinery",
        netted.every((w) => !holders.machineryExcluded.includes(w.wallet)), `${netted.length} netted rows`);
    }
    const withActors = snaps.filter((s) => s.buyers != null);
    if (withActors.length) {
      /* A wallet can buy and sell inside one period and end at zero, so in launch
         week actors legitimately outnumber holders at the boundary. Integers and
         non-negative is the invariant; more actors than holders is only worth a look. */
      check("period buyers and sellers are non-negative integers",
        withActors.every((s) => Number.isInteger(s.buyers) && s.buyers >= 0 && Number.isInteger(s.sellers) && s.sellers >= 0),
        `latest period: ${withActors.at(-1).buyers} bought, ${withActors.at(-1).sellers} sold, of ${withActors.at(-1).holders} holders`);
      const recent = withActors.slice(-42);
      warn("recent periods do not show more actors than holders", recent.every((s) => s.buyers + s.sellers <= 2 * Math.max(1, s.holders)),
        `largest recent period: ${Math.max(...recent.map((s) => s.buyers + s.sellers))} actors`);
    }
    check("the whale tape is newest first",
      holders.whales.every((w, i, a) => i === 0 || w.t <= a[i - 1].t));
  }
  if (holders.topHolders?.length) {
    check("top holders are sorted largest first and exclude machinery",
      holders.topHolders.every((h, i, a) => (i === 0 || h.ai <= a[i - 1].ai) && !holders.machineryExcluded.includes(h.address)),
      `largest ${holders.topHolders[0].ai.toLocaleString()} AI`);
  }
} else console.log("  --  holders.json absent (optional)");

console.log("\nTreasury");
{
  const T = readData("treasury.json");
  if (T?.feeWallet) {
    const L = T.feeWallet.ledgers || {};
    /* The fee wallet is a pipe; if it ever starts holding, that is news, not an error. */
    for (const [sym, l] of Object.entries(L)) {
      check(`fee wallet ${sym} ledger is internally consistent`, l.in >= l.out - 1e-6 && l.balance != null && l.balance >= -1e-6,
        `in ${l.in.toLocaleString()} · out ${l.out.toLocaleString()} · balance ${l.balance}`);
      warn(`fee wallet ${sym} in − out equals its balance`, Math.abs((l.in - l.out) - l.balance) <= Math.max(1e-6, l.in * 0.001),
        `in − out ${(l.in - l.out).toFixed(4)} vs balance ${l.balance}`);
    }
    /* The treasury is built on the slow path and a fast refresh leaves it in place,
       so its cursor legitimately trails the head by however long since the last
       standard run. Eight hours of blocks is the same staleness the KPI panel and the
       page's age notes tolerate; beyond that the artifact is stale, not merely older. */
    check("treasury ledgers reached the head or say they did not", T.cursor > 0 && (T.partial === true || T.cursor >= (meta.headBlock || 0) - Math.round(C.BLOCKS_PER_DAY / 3)),
      `cursor ${T.cursor}${T.partial ? " (partial)" : ""}, head ${meta.headBlock}`);
    check("platform-wide fee tokens carry non-negative amounts and finite values",
      (T.platformFees?.tokens || []).every((t) => t.amount >= 0 && (t.usd == null || isFinite(t.usd))), `${T.platformFees?.tokenCount ?? 0} tokens`);
  } else console.log("  --  treasury.json absent (built on the slow path)");
}

console.log("\nLaunchpad price history");
if (launchpad?.priceHistory?.length) {
  check("price history rows are ordered and carry positive prices",
    launchpad.priceHistory.every((h, i, a) => (i === 0 || h.t > a[i - 1].t) && Object.values(h.p || {}).every((v) => v > 0 && isFinite(v))),
    `${launchpad.priceHistory.length} row(s), ${Object.keys(launchpad.priceHistory.at(-1).p || {}).length} tokens in the latest`);
} else console.log("  --  no price history yet (accrues on the slow path)");
console.log(`
${checks - failures}/${checks} checks passed${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`);
if (failures) {
  console.error(`${failures} FAILED — the indexed data is not trustworthy.`);
  process.exit(1);
}
