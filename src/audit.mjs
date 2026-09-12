#!/usr/bin/env node
/**
 * Cross-validation sweep: derive the headline numbers a SECOND, independent way
 * and compare.
 *
 * verify.mjs asserts properties of one derivation -- is it positive, is it ordered,
 * does it net to zero. That catches a lot, but it cannot catch a number that is
 * self-consistently wrong, and self-consistently wrong is what most of this
 * project's real bugs were. A tally of them:
 *
 *   dimensional / unit errors   5   USDG at 18 decimals not 6; bridge volumes summed
 *                                   across different tokens; depth binned in each
 *                                   pool's own quote then merged; swap count used as
 *                                   a proxy for volume; TVL read as if it were volume
 *   unstated denominator        3   leakage over 8 pools presented as "AI volume";
 *                                   float over genesis in one place and current
 *                                   supply in another; three market caps on one page
 *
 * Every single one of those would have failed a cross-derivation on sight, because
 * two independent routes to the same quantity do not make the same mistake. A
 * decimals error shows up as a factor of 10^12, not as a suspicious-looking chart.
 *
 * So this file computes each headline twice, by paths that share as little as
 * possible, and reports the disagreement as a percentage. It is deliberately
 * separate from verify.mjs: verify gates the deploy on data being sound, this asks
 * the harder question of whether the numbers agree with themselves, and a
 * disagreement here wants a human before it wants a build failure.
 */
import { readData } from "./store.mjs";
import * as C from "./config.mjs";

const meta = readData("meta.json");
const flow = readData("flow.json");
const burns = readData("burns.json");
const routing = readData("routing.json");
const depth = readData("depth.json");

if (!meta || !flow || !burns) {
  console.error("Missing artifacts. Run `npm run index` first.");
  process.exit(1);
}

let checks = 0, bad = 0;
const DAY = 86400;
const pct = (x) => `${(x * 100).toFixed(2)}%`;

/** Two routes to one number. Tolerance is what the routes can legitimately differ by. */
function agree(name, a, b, tol, note = "") {
  checks++;
  const A = Number(a), B = Number(b);
  if (!isFinite(A) || !isFinite(B)) {
    console.log(` SKIP  ${name}  — one route unavailable`);
    return;
  }
  const base = Math.max(Math.abs(A), Math.abs(B), 1e-30);
  const diff = Math.abs(A - B) / base;
  const ok = diff <= tol;
  if (!ok) bad++;
  const fmt = (v) => (Math.abs(v) >= 1000 || Math.abs(v) < 0.001 ? v.toExponential(4) : v.toFixed(6));
  console.log(`${ok ? "  ok  " : " DIFF "} ${name}  — ${fmt(A)} vs ${fmt(B)} (${pct(diff)} apart, tolerance ${pct(tol)})${note ? ` · ${note}` : ""}`);
}

console.log("\nPrice — the anchor everything else is denominated in");

/* Two AI/USDG venues, independently reconstructed from their own swap tapes. They
   are different pools at different fee tiers with different LPs, so agreement is
   evidence the decode is right; a decimals error would put them 10^12 apart only if
   it hit one of them, which is exactly the case that shipped once. */
const usdgPools = flow.pools.filter((p) => p.pairSymbol === "USDG");
const closes = usdgPools
  .map((p) => ({ id: p.poolId, c: p.hourly.filter((h) => h.close > 0).at(-1)?.close }))
  .filter((x) => x.c > 0);
if (closes.length >= 2) {
  agree("AI in USD: busiest USDG pool vs the next one",
    closes[0].c, closes[1].c, 0.05, "different fee tiers, so a spread is expected");
}

/* The depth module derives spot from sqrtPriceX96 -- a completely different field of
   a completely different event than the hourly close, which comes from swap
   amounts. If these disagree the price maths is wrong somewhere. */
if (depth?.aiUsd && closes.length) {
  agree("AI in USD: hourly close vs sqrtPrice-derived spot",
    closes[0].c, depth.aiUsd, 0.05, "close is from swap amounts, spot from sqrtPriceX96");
}

console.log("\nSupply and market cap");

/* Live totalSupply against the ledger's own arithmetic. This one already exists in
   verify, repeated here because it is the anchor for market cap. */
agree("supply: live totalSupply vs genesis minus burned",
  burns.totalSupply, burns.genesisSupply - burns.burned,
  (burns.skewAllowance ?? 1) / Math.max(1, burns.totalSupply));

/* Market cap two ways. Same price, different supply routes -- so this isolates the
   supply term, which is where the "three different market caps" bug lived. */
if (closes.length) {
  agree("market cap: price x live supply vs price x (genesis - burned)",
    closes[0].c * burns.totalSupply,
    closes[0].c * (burns.genesisSupply - burns.burned),
    0.001);
}

console.log("\nFees — the revenue the valuation rests on");

/* The splitter's three legs, against the burn and lock totals scanned by separate
   filters. Same money, two different log queries: legs constrain sender AND
   recipient, the totals constrain only the recipient. They should agree closely,
   and the gap is exactly the non-fee inflow the page reports separately. */
const legs = (burns.feeLegs?.burn ?? 0) + (burns.feeLegs?.lock ?? 0);
const totals = (burns.burned ?? 0) + (burns.lockedInVault ?? 0);
agree("AI fees: splitter legs vs burn+lock totals", legs, totals, 0.02,
  "any gap is AI burned or locked by something other than the fee splitter");

/* Burn and lock are paid in lockstep by the contract, so they are two measurements
   of one quantity. A decode fault on either side breaks the identity. */
agree("the 1:1 split: burned vs vault-locked", burns.feeLegs?.burn, burns.feeLegs?.lock, 0.01);

console.log("\nVolume and routing");

/* Flow buckets against the routing index over the SAME days. Flow sums the AI leg
   of every swap; routing sums per-transaction direct plus cross-routed. A
   transaction with several legs is counted once by routing and several times by
   flow, so routing should read lower -- but not by an order of magnitude, and never
   higher. */
if (routing?.daily?.length) {
  const rDays = new Set(routing.daily.map((d) => d.t));
  const flowByDay = new Map();
  for (const p of flow.pools) {
    for (const h of p.hourly) {
      const d = Math.floor(h.t / DAY) * DAY;
      if (rDays.has(d)) flowByDay.set(d, (flowByDay.get(d) || 0) + (h.aiBuy || 0) + (h.aiSell || 0));
    }
  }
  const common = routing.daily.filter((d) => flowByDay.has(d.t));
  if (common.length) {
    const rTot = common.reduce((s, d) => s + d.direct + d.cross, 0);
    const fTot = common.reduce((s, d) => s + flowByDay.get(d.t), 0);
    checks++;
    const ratio = fTot > 0 ? rTot / fTot : 0;
    const ok = ratio > 0.2 && ratio < 3;
    if (!ok) bad++;
    console.log(`${ok ? "  ok  " : " DIFF "} volume: routing total vs flow buckets over ${common.length} shared days` +
      `  — ${(rTot / 1e6).toFixed(2)}M vs ${(fTot / 1e6).toFixed(2)}M (ratio ${ratio.toFixed(2)}, expected 0.2-3)`);
  }
}

console.log("\nRatios — where a wrong denominator hides");

/* Toll leakage, by AI volume and again by swap count. These answer different
   questions and SHOULD differ -- hookless venues trade in bigger tickets -- but
   knowing by how much is the point. Quoting the count version as though it were the
   volume version is precisely the mistake that produced a confident, wrong "true
   leakage is 65%" in this project's history. */
const hooked = flow.pools.filter((p) => p.isLongHook);
const hookless = flow.pools.filter((p) => !p.isLongHook);
const vol = (ps) => ps.reduce((s, p) => s + p.hourly.slice(-72).reduce((a, h) => a + (h.aiBuy || 0) + (h.aiSell || 0), 0), 0);
const cnt = (ps) => ps.reduce((s, p) => s + p.hourly.slice(-72).reduce((a, h) => a + (h.buys || 0) + (h.sells || 0), 0), 0);
const leakVol = vol(hookless) / Math.max(1e-9, vol(hooked) + vol(hookless));
const leakCnt = cnt(hookless) / Math.max(1e-9, cnt(hooked) + cnt(hookless));
checks++;
console.log(`  note  leakage by AI volume ${pct(leakVol)} vs by swap count ${pct(leakCnt)}` +
  `  — these measure different things; the site quotes the volume one`);

/* Bridge shares are per-token ratios, which is legitimate, but their AGGREGATE was
   once built by summing volumes denominated in different tokens. The flow-weighted
   figure and the median answer the same question two ways; a large gap is the
   distribution being skewed, not an error, but a flow-weighted figure OUTSIDE the
   min-max range of its own members would be arithmetic gone wrong. */
const org = readData("bridges.json")?.byKind?.organic;
if (org && org.tokens) {
  const w = org.weightedShare, m = org.medianShare;
  checks++;
  const inRange = w == null || (w >= org.minShare - 1e-9 && w <= org.maxShare + 1e-9);
  if (!inRange) bad++;
  console.log(`${inRange ? "  ok  " : " DIFF "} organic bridge share: flow-weighted ${w == null ? "n/a" : pct(w)} vs median ${pct(m)}` +
    `  — range ${pct(org.minShare)}-${pct(org.maxShare)}${inRange ? "" : "  AGGREGATE OUTSIDE ITS OWN RANGE"}`);
}

console.log("\nDepth");

if (depth?.pools?.length) {
  /* The merged book against the per-pool totals it was built from. These share the
     bin maths but not the merge, which is where a shared-grid bug lives: merging
     pools that were binned in their own quote units produced a book that summed
     fine and meant nothing. */
  const bookBid = depth.book.reduce((s, b) => s + b.bid, 0);
  const bookAsk = depth.book.reduce((s, b) => s + b.ask, 0);
  agree("depth: merged book bids vs per-venue bids", bookBid, depth.bidUsd, 0.001);
  agree("depth: merged book asks vs per-venue asks", bookAsk, depth.askUsd, 0.001);

  /* Depth's own spot against the price panel's. Different modules, different
     inputs; this is the check that would have caught the per-pool grid immediately. */
  if (closes.length) agree("depth spot vs the canonical price", depth.aiUsd, closes[0].c, 0.02);
}

console.log(`\n${checks - bad}/${checks} cross-checks agree${bad ? ` — ${bad} DISAGREE, look at those before trusting the page` : ""}.`);
process.exit(0);   // reporting tool: never gates a deploy on its own
