import {
  AI, NVDA, USDG, COMMUNITY_VAULT, BURN_ADDRESS, FEE_SPLITTER,
  PLATFORM_FEE_RECIPIENT, POOL_MANAGER, GENESIS_BLOCK, TOKENS, LONG_HOOK,
} from "../config.mjs";
import { getLogsRange, padAddr } from "../rpc.mjs";
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
  const scan = (filter) => (from > latest ? Promise.resolve([]) : getLogsRange(filter, from, latest, { chunk: 8_000_000 }));

  log("  scanning AI burns (Transfer -> 0x0)...");
  const burns = (await scan({ address: AI, topics: [TOPICS.TRANSFER, null, padAddr(BURN_ADDRESS)] })).map(decodeTransfer);

  log("  scanning AI locks (Transfer -> community vault)...");
  const locks = (await scan({ address: AI, topics: [TOPICS.TRANSFER, null, padAddr(COMMUNITY_VAULT)] })).map(decodeTransfer);

  log("  scanning NVDA reserve accretion (Transfer -> community vault)...");
  const nvda = (await scan({ address: NVDA, topics: [TOPICS.TRANSFER, null, padAddr(COMMUNITY_VAULT)] })).map(decodeTransfer);

  /* The fee split must be measured on the splitter's OWN outflows, constraining
     both `from` and `to`. Summing everything that lands on the platform address
     instead conflates the fee leg with every other transfer that address receives
     -- which inflates its share by an order of magnitude and turns the "split"
     into a statement about that wallet's total income rather than about the fee. */
  log("  scanning the fee splitter's three legs...");
  const legFrom = (to) =>
    scan({ address: AI, topics: [TOPICS.TRANSFER, padAddr(FEE_SPLITTER), padAddr(to)] }).then((l) => l.map(decodeTransfer));
  const legBurn = await legFrom(BURN_ADDRESS);
  const legLock = await legFrom(COMMUNITY_VAULT);
  const legPlatform = await legFrom(PLATFORM_FEE_RECIPIENT);

  // Tracked separately and labelled as such: everything the platform address
  // receives, from any source. Not the fee leg.
  log("  scanning total AI inflow to the platform address (all sources)...");
  const platform = (await scan({ address: AI, topics: [TOPICS.TRANSFER, null, padAddr(PLATFORM_FEE_RECIPIENT)] })).map(decodeTransfer);

  log("  scanning AI mints (Transfer from 0x0)...");
  const mints = (await scan({ address: AI, topics: [TOPICS.TRANSFER, padAddr(BURN_ADDRESS)] })).map(decodeTransfer);

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

  // Live state, straight from the chain.
  const [supply, vaultAI, vaultNVDA, pmAI, hookAI, nvdaSupply] = await Promise.all([
    erc20(AI, "totalSupply"),
    balanceOf(AI, COMMUNITY_VAULT),
    balanceOf(NVDA, COMMUNITY_VAULT),
    balanceOf(AI, POOL_MANAGER),
    balanceOf(AI, LONG_HOOK),
    erc20(NVDA, "totalSupply"),
  ]);

  const genesis = TOKENS.AI.genesisSupply;
  const totalSupply = fmtUnits(supply);
  // Reconciliation: this must hold, and is surfaced in the UI as a self-check.
  const reconciles = Math.abs(genesis - totalBurn - totalSupply) < 1;

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
    reconcileResidual: genesis - totalBurn - totalSupply,
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
