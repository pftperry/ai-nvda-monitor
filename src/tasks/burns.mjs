import {
  AI, NVDA, USDG, COMMUNITY_VAULT, BURN_ADDRESS, FEE_SPLITTER,
  PLATFORM_FEE_RECIPIENT, POOL_MANAGER, GENESIS_BLOCK, TOKENS, LONG_HOOK, DEDICATED_RPC,
} from "../config.mjs";
import { getLogsRange, padAddr, blockNumber, hexBlock } from "../rpc.mjs";
import { TOPICS, decodeTransfer, fmtUnits } from "../decode.mjs";
import { erc20, balanceOf } from "../tokens.mjs";

/**
 * The permanent-removal ledger.
 *
 * The 0.70% hook fee is split atomically by the fee splitter, which never holds a
 * balance. We do not assume the split ratio: we measure all three legs (burn,
 * vault lock, platform) and let the observed ratio speak. It currently runs 2:2:1.
 */
export async function indexBurns(latest, tm, opts = {}) {
  const log = opts.log || console.log;

  /* Incremental, like flow. Rescanning all ~51M blocks across five filters every
     run cost minutes and dominated the refresh, which is what made a short cron
     interval impossible. Transfers are append-only, so resuming from a cursor and
     merging is exact; only the cumulative columns need recomputing at the end. */
  const prev = opts.prev && opts.prev.cursor ? opts.prev : null;
  const from = prev ? Math.max(GENESIS_BLOCK, prev.cursor + 1) : GENESIS_BLOCK;
  if (prev) log(`  resuming burn ledger from block ${from.toLocaleString()} (+${(latest - from).toLocaleString()} blocks)`);
  /* Filters named once, because they are used twice: for the main scan, and again
     to top up to whatever block the live balance reads answer for. See the
     reconciliation note below. */
  const FILTERS = {
    burns:       { address: AI,   topics: [TOPICS.TRANSFER, null, padAddr(BURN_ADDRESS)] },
    locks:       { address: AI,   topics: [TOPICS.TRANSFER, null, padAddr(COMMUNITY_VAULT)] },
    nvda:        { address: NVDA, topics: [TOPICS.TRANSFER, null, padAddr(COMMUNITY_VAULT)] },
    /* The fee split must be measured on the splitter's OWN outflows, constraining
       both from and to. Summing everything that lands on the platform address
       instead conflates the fee leg with every other transfer that address receives
       -- which inflates its share by an order of magnitude and turns the "split"
       into a statement about that wallet's total income rather than about the fee. */
    legBurn:     { address: AI, topics: [TOPICS.TRANSFER, padAddr(FEE_SPLITTER), padAddr(BURN_ADDRESS)] },
    legLock:     { address: AI, topics: [TOPICS.TRANSFER, padAddr(FEE_SPLITTER), padAddr(COMMUNITY_VAULT)] },
    legPlatform: { address: AI, topics: [TOPICS.TRANSFER, padAddr(FEE_SPLITTER), padAddr(PLATFORM_FEE_RECIPIENT)] },
    // Tracked separately and labelled as such: everything the platform address
    // receives, from any source. Not the fee leg.
    platform:    { address: AI, topics: [TOPICS.TRANSFER, null, padAddr(PLATFORM_FEE_RECIPIENT)] },
    mints:       { address: AI, topics: [TOPICS.TRANSFER, padAddr(BURN_ADDRESS)] },
  };
  /* Sequential on purpose: the limiter counts sub-requests, and firing these in
     parallel exhausts the window and costs far more than it saves. */
  const scanRange = async (filter, a, b) =>
    (a > b ? [] : (await getLogsRange(filter, a, b, { chunk: 8_000_000 })).map(decodeTransfer));
  const scan = (filter) => scanRange(filter, from, latest);

  log("  scanning AI burns (Transfer -> 0x0)...");
  const burns = await scan(FILTERS.burns);

  log("  scanning AI locks (Transfer -> community vault)...");
  const locks = await scan(FILTERS.locks);

  log("  scanning NVDA reserve accretion (Transfer -> community vault)...");
  const nvda = await scan(FILTERS.nvda);

  log("  scanning the fee splitter's three legs...");
  const legBurn = await scan(FILTERS.legBurn);
  const legLock = await scan(FILTERS.legLock);
  const legPlatform = await scan(FILTERS.legPlatform);

  log("  scanning total AI inflow to the platform address (all sources)...");
  const platform = await scan(FILTERS.platform);

  log("  scanning AI mints (Transfer from 0x0)...");
  const mints = await scan(FILTERS.mints);

  /* The top-up must land HERE, before anything reads these arrays.

     It used to sit below the daily buckets and the running totals, which meant
     it appended the newest events to arrays that had already been summed. The
     run logged "topped up 414 blocks so the ledger and the live balances agree"
     and then reconciled against totals that did not contain them. It went unseen
     because the window is usually empty: it takes a fee event landing inside a
     few hundred blocks to produce a residual, and when one finally did, both the
     supply reconciliation and the vault invariant failed by exactly 182.2494 AI --
     one split at block 61,599,036, inside the topped-up range, counted by neither
     leg. Ordering, not arithmetic. */
  /* Close the race between the log scan and the live balance reads.

     The scan covers up to the block captured when the run STARTED; balanceOf and
     totalSupply answer for whatever block is current when they are called. On a
     25-second refresh that is the same block and nobody notices. On a run that
     backfills twenty pools it is twenty-six minutes and some fifteen thousand
     blocks apart, and the ledger stops reconciling -- measured, the vault came back
     423.88 AI above the sum of its own inbound transfers, and supply missed by the
     same amount, because the fee splits 1:1 so both legs lose equally.

     The reads cannot be pinned backwards: this node serves no archive state and
     eth_call at any past block answers "metadata is not found". So the scan is
     brought forward to meet them instead. What remains is the second between the
     head read and the call rather than the length of the whole run. */
  const stateBlock = await blockNumber();
  if (stateBlock > latest) {
    /* A loop, not push(...spread): spreading an array passes one argument per
       element and overflows the call stack on a long one. This top-up is short by
       construction, but that exact line has already taken down the bridge step. */
    const topUp = async (filter, arr) => {
      for (const x of await scanRange(filter, latest + 1, stateBlock)) arr.push(x);
    };
    await topUp(FILTERS.burns, burns);
    await topUp(FILTERS.locks, locks);
    await topUp(FILTERS.nvda, nvda);
    await topUp(FILTERS.legBurn, legBurn);
    await topUp(FILTERS.legLock, legLock);
    await topUp(FILTERS.legPlatform, legPlatform);
    await topUp(FILTERS.platform, platform);
    await topUp(FILTERS.mints, mints);
    log(`  topped up ${(stateBlock - latest).toLocaleString()} blocks so the ledger and the live balances agree on a block`);
    latest = stateBlock;
  }

  // Seed from the stored series so merged buckets accumulate rather than restart.
  const daily = new Map();
  if (prev && Array.isArray(prev.daily)) {
    for (const d of prev.daily) {
      daily.set(d.t, { t: d.t, burnAI: d.burnAI || 0, lockAI: d.lockAI || 0, nvdaIn: d.nvdaIn || 0,
                       platformAI: d.platformAI || 0, burnEvents: d.burnEvents || 0 });
    }
  }
  const bump = (block, key, amount) => {
    const d = tm.dayBucket(block);
    if (d === null) return;
    let row = daily.get(d);
    if (!row) daily.set(d, (row = { t: d, burnAI: 0, lockAI: 0, nvdaIn: 0, platformAI: 0, burnEvents: 0 }));
    row[key] += amount;
    if (key === "burnAI") row.burnEvents++;
  };
  for (const x of burns)    bump(x.block, "burnAI", fmtUnits(x.value));
  for (const x of locks)    bump(x.block, "lockAI", fmtUnits(x.value));
  for (const x of nvda)     bump(x.block, "nvdaIn", fmtUnits(x.value));
  // The FEE leg only. Using every inflow to the platform address would inflate
  // the daily fee series with that wallet's unrelated income, and the daily
  // series is what the revenue run-rate is built from.
  for (const x of legPlatform) bump(x.block, "platformAI", fmtUnits(x.value));

  const series = [...daily.values()].sort((a, b) => a.t - b.t);
  let cb = 0, cl = 0, cn = 0, cp = 0;
  for (const r of series) {
    r.cumBurnAI = cb += r.burnAI;
    r.cumLockAI = cl += r.lockAI;
    r.cumNvda   = cn += r.nvdaIn;
    r.cumPlatformAI = cp += r.platformAI;
  }

  /* Totals carry forward: the scans above now cover only the new range, so each
     total is the prior run's plus what arrived since. The live balances read from
     the chain below are independent, which makes them a running cross-check on
     this arithmetic -- verify asserts vault balance equals summed inbound locks. */
  const sum = (a) => a.reduce((s, x) => s + fmtUnits(x.value), 0);
  const carried = prev || {};
  const totalBurn = (carried.burned || 0) + sum(burns);
  const totalLock = (carried.lockedInVault || 0) + sum(locks);
  const totalPlatform = (carried.platformInflowAllSources || 0) + sum(platform);
  const feeBurn = (carried.feeLegs?.burn || 0) + sum(legBurn);
  const feeLock = (carried.feeLegs?.lock || 0) + sum(legLock);
  const feePlatform = (carried.feeLegs?.platform || 0) + sum(legPlatform);


  /* State read AT the block the ledger was scanned to, when the endpoint can answer
     that. The public node serves no archive state, so the reads used to land on
     whatever block was current by the time they arrived, and everything below about
     skew allowances existed to excuse the gap. An archive endpoint closes it: the
     ledger and the balances describe the same block, and the reconciliation can
     demand exactness again. Without one, the old head-read and its allowance stand. */
  const tag = DEDICATED_RPC ? hexBlock(latest) : "latest";
  const [supply, vaultAI, vaultNVDA, pmAI, hookAI, nvdaSupply] = await Promise.all([
    erc20(AI, "totalSupply", tag),
    balanceOf(AI, COMMUNITY_VAULT, tag),
    balanceOf(NVDA, COMMUNITY_VAULT, tag),
    balanceOf(AI, POOL_MANAGER, tag),
    balanceOf(AI, LONG_HOOK, tag),
    erc20(NVDA, "totalSupply", tag),
  ]);

  /* How wide the remaining window is, and what a block of it is worth.

     Topping the scan up to the head narrows the race but cannot close it: the
     top-up itself takes time, and the chain keeps producing blocks while the
     balance calls are in flight. Measured on a 78-minute run the residual was
     still 596 AI. Demanding exactness here would mean the invariant fails on
     every long run and passes on every short one, which trains everyone to
     ignore it -- the worst possible outcome for a check whose whole job is to be
     believed.

     So the skew is measured instead of wished away, and recorded alongside the
     residual. A residual that the known skew can explain is arithmetic; one that
     it cannot is a bug, and only the second kind should fail a build. */
  const afterBlock = DEDICATED_RPC ? latest : await blockNumber();
  const stateSkewBlocks = Math.max(0, afterBlock - latest);

  const genesis = TOKENS.AI.genesisSupply;
  const totalSupply = fmtUnits(supply);
  // Reconciliation: this must hold, and is surfaced in the UI as a self-check.
  /* What a block of skew is worth, from this chain's own recent burn rate rather
     than a guessed constant. Blocks run at ~0.1022s, so a day is about 845,000 of
     them; the trailing week of burns divided by that is AI-burned-per-block. */
  const BLOCKS_PER_DAY = Math.round(86400 / 0.1022);
  const recentDays = [...daily.values()].sort((a, b) => b.t - a.t).slice(1, 8);
  const burnPerBlock = recentDays.length
    ? recentDays.reduce((x, d) => x + (d.burnAI || 0), 0) / recentDays.length / BLOCKS_PER_DAY
    : 0;
  // Pinned reads leave only floating-point summation error, a small fraction of one AI.
  const skewAllowance = DEDICATED_RPC ? 0.01 : Math.max(1, burnPerBlock * stateSkewBlocks * 3);
  const residual = genesis - totalBurn - totalSupply;
  const reconciles = Math.abs(residual) <= skewAllowance;
  if (!reconciles) log(`  supply residual ${residual.toFixed(2)} AI exceeds what ${stateSkewBlocks} blocks of skew can explain (${skewAllowance.toFixed(2)} AI)`);
  else if (Math.abs(residual) > 1) log(`  supply residual ${residual.toFixed(2)} AI, within the ${skewAllowance.toFixed(2)} AI explained by ${stateSkewBlocks} blocks of read skew`);

  // The AI-side fee legs sum to the total AI fee taken. At a 0.70% rate that implies
  // the AI-denominated notional that crossed tolled pools.
  const totalAIFee = feeBurn + feeLock + feePlatform;
  const impliedAILegVolume = totalAIFee / 0.007;

  return {
    updatedAt: Math.floor(Date.now() / 1000),
    latestBlock: latest,
    cursor: latest,           // next run resumes from cursor + 1
    genesisSupply: genesis,
    mintEvents: (carried.mintEvents || 0) + mints.length,
    mintedTotal: (carried.mintedTotal || 0) + mints.reduce((s, x) => s + fmtUnits(x.value), 0),
    totalSupply,
    burned: totalBurn,
    burnEvents: (carried.burnEvents || 0) + burns.length,
    lockedInVault: totalLock,
    // Everything the platform address received, from any source. NOT the fee leg.
    platformInflowAllSources: totalPlatform,
    // The fee split proper, measured only on the splitter's own outflows.
    feeLegs: { burn: feeBurn, lock: feeLock, platform: feePlatform },
    platformLeg: feePlatform,
    observedSplit: feeBurn > 0
      ? { burn: 1, lock: +(feeLock / feeBurn).toFixed(4), platform: +(feePlatform / feeBurn).toFixed(4) }
      : null,
    reconciles,
    reconcileResidual: residual,
    // Recorded so verify can judge the residual against the skew that produced it
    // rather than against an absolute that no long run can ever meet.
    stateSkewBlocks,
    skewAllowance: +skewAllowance.toFixed(4),
    vault: {
      address: COMMUNITY_VAULT,
      aiBalance: fmtUnits(vaultAI),
      nvdaBalance: fmtUnits(vaultNVDA),
      nvdaAccreted: cn,
    },
    poolManagerAI: fmtUnits(pmAI),
    hookAI: fmtUnits(hookAI),
    nvdaTotalSupply: fmtUnits(nvdaSupply),
    totalAIFee,
    impliedAILegVolume,
    // Effective float: what is actually available to trade.
    permanentlyRemoved: totalBurn + fmtUnits(vaultAI),
    lockedAsPoolInventory: fmtUnits(pmAI),
    effectiveFloat: totalSupply - fmtUnits(vaultAI) - fmtUnits(pmAI),
    daily: series,
  };
}
