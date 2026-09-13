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
const partition = burns.vault.aiBalance + burns.poolManagerAI + burns.effectiveFloat;
check("live supply partitions exactly into vault + pool inventory + float",
  Math.abs(partition - burns.totalSupply) < 1,
  `${partition.toFixed(2)} vs totalSupply ${burns.totalSupply.toFixed(2)}`);
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
} else console.log("  --  holders.json absent (optional)");
console.log(`
${checks - failures}/${checks} checks passed${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`);
if (failures) {
  console.error(`${failures} FAILED — the indexed data is not trustworthy.`);
  process.exit(1);
}
