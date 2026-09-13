import { getLogsRange } from "../rpc.mjs";
import { decodeTransfer } from "../decode.mjs";
import {
  AI, GENESIS_BLOCK, POOL_MANAGER, LONG_HOOK, COMMUNITY_VAULT, FEE_SPLITTER, BURN_ADDRESS,
} from "../config.mjs";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const STEP = 4 * 3600;          // snapshot cadence
const WINDOW = 250_000;          // blocks per outer read; see the memory note below

/* Addresses that hold AI as machinery rather than as an owner. The pool manager
   holds every v4 pool's inventory, the vault holds the locked leg, the splitter
   passes fees through and the hook holds launch reserves. Counting any of them as
   "a holder" would put one address with tens of millions of AI in the top bucket
   and call it a whale. They are still in the supply reconciliation below. */
const MACHINERY = new Set([BURN_ADDRESS, POOL_MANAGER, LONG_HOOK, COMMUNITY_VAULT, FEE_SPLITTER]);

/* Dollar buckets, matching the convention holder dashboards use, so a reader can
   check the count against one. The top bucket is split at $10k because "share of
   holders above $10k" is the figure those dashboards quote. */
/* The same population counted by balance in AI, which price cannot move.

   Dollar buckets are what dashboards show, and they carry a trap: when the price
   rises every holder drifts into a higher bucket without buying a token, so "more
   $1k+ holders" during a rally is mostly the rally. Counting addresses above a
   fixed AI balance separates accumulation from appreciation -- a rising count at
   these thresholds means tokens moved into more hands, whatever the price did. */
export const AI_THRESHOLDS = [10_000, 100_000, 1_000_000];

export const HOLDER_BUCKETS = [
  { key: "dust",  label: "under $10",       lo: 0,    hi: 10 },
  { key: "small", label: "$10 - $100",      lo: 10,   hi: 100 },
  { key: "mid",   label: "$100 - $1k",      lo: 100,  hi: 1e3 },
  { key: "large", label: "$1k - $10k",      lo: 1e3,  hi: 1e4 },
  { key: "whale", label: "$10k and above",  lo: 1e4,  hi: Infinity },
];

/**
 * Who holds AI, in dollars, every four hours since genesis.
 *
 * Built by replaying every AI Transfer ever emitted -- roughly four million of
 * them -- into a balance per address, and bucketing the balances by dollar value
 * at each four-hour boundary. Nothing is sampled: a holder count here is the
 * number of addresses with a non-zero balance at that moment.
 *
 * Why it can lead price where most on-chain measures only describe it: the
 * breadth of meaningful holders changes before a move shows up in the tape. A
 * rising count of $1k+ holders at a flat price is accumulation; a falling one on
 * a rally is distribution into strength. Neither is visible in volume.
 *
 * Memory: getLogsRange accumulates everything it reads, and four million raw logs
 * is gigabytes. So the range is read in 250k-block windows, each replayed and
 * dropped before the next -- about 60k logs held at the densest point.
 *
 * Resumable like the census: the cursor, the balances and the snapshots live in
 * the resume store, and a run that runs out of budget stops at a window boundary
 * with everything up to there kept.
 */
export async function indexHolders(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const deadline = opts.deadline || Infinity;
  const priceAt = opts.priceAt || (() => null);
  const prev = opts.state || {};

  const balances = new Map();
  for (const [a, v] of Object.entries(prev.balances || {})) balances.set(a, BigInt(v));
  let supply = BigInt(prev.supply || "0");
  let cursor = prev.cursor ?? GENESIS_BLOCK - 1;
  let lastT = prev.lastT ?? null;
  const snaps = prev.snaps ? prev.snaps.slice() : [];
  const startCursor = cursor;

  const snapshot = (t) => {
    // The hour that ENDED at t, not the one starting there, so a row never reads a later price.
    const price = priceAt(t - 3600);
    const counts = HOLDER_BUCKETS.map(() => 0);
    const byAi = AI_THRESHOLDS.map(() => 0);
    let holders = 0;
    for (const [a, b] of balances) {
      if (b <= 0n || MACHINERY.has(a)) continue;
      holders++;
      const ai = Number(b / 10n ** 12n) / 1e6;
      for (let k = 0; k < AI_THRESHOLDS.length; k++) if (ai >= AI_THRESHOLDS[k]) byAi[k]++;
      if (price == null) continue;
      const usd = ai * price;
      const i = HOLDER_BUCKETS.findIndex((k) => usd >= k.lo && usd < k.hi);
      counts[i]++;
    }
    snaps.push({
      t, holders,
      price: price == null ? null : +price.toPrecision(6),
      supply: +(Number(supply / 10n ** 12n) / 1e6).toFixed(2),
      buckets: price == null ? null : counts,
      aboveAi: byAi,
    });
  };

  let read = 0, partial = false;
  while (cursor < latest) {
    if (Date.now() > deadline) { partial = true; break; }
    const hi = Math.min(latest, cursor + WINDOW);
    const logs = await getLogsRange({ address: AI, topics: [TRANSFER] }, cursor + 1, hi,
      { chunk: 50_000, deadline });
    const reached = logs.reachedBlock ?? hi;

    for (const raw of logs) {
      const x = decodeTransfer(raw);
      const ts = tm.at(x.block);
      if (ts == null) continue;
      const bucket = Math.floor(ts / STEP) * STEP;
      if (lastT == null) lastT = bucket;
      /* Emit the state as it stood at the END of every four-hour period this
         transfer steps past, before applying it. Quiet periods still get a row,
         carrying the same balances, so the series has no holes to misread. */
      while (bucket > lastT) { snapshot(lastT + STEP); lastT += STEP; }

      if (x.from === BURN_ADDRESS) supply += x.value;
      else balances.set(x.from, (balances.get(x.from) || 0n) - x.value);
      if (x.to === BURN_ADDRESS) supply -= x.value;
      else balances.set(x.to, (balances.get(x.to) || 0n) + x.value);
    }
    read += logs.length;
    cursor = reached;
    if (logs.truncated || reached < hi) { partial = true; break; }
  }

  /* Drop emptied addresses so the stored map tracks holders, not history. */
  for (const [a, b] of balances) if (b === 0n) balances.delete(a);

  /* The accounting check. Every token that exists sits at some address, so the
     balances must sum to supply exactly. A negative balance anywhere means a
     transfer was missed or replayed twice, and either makes every count a guess. */
  let sum = 0n, negative = 0;
  for (const b of balances.values()) { sum += b; if (b < 0n) negative++; }
  const residualAi = Number(sum - supply) / 1e18;

  const complete = !partial && cursor >= latest;
  log(`  replayed ${read.toLocaleString()} transfers over ${(cursor - startCursor).toLocaleString()} blocks` +
      `; ${balances.size.toLocaleString()} funded addresses; ${snaps.length} snapshots` +
      (complete ? "" : " (partial, resumes next run)"));

  return {
    state: {
      cursor, lastT, supply: supply.toString(), snaps,
      balances: Object.fromEntries([...balances].map(([a, b]) => [a, b.toString()])),
    },
    artifact: {
      complete, cursor,
      aiThresholds: AI_THRESHOLDS,
      buckets: HOLDER_BUCKETS.map(({ key, label, lo, hi }) => ({ key, label, lo, hi: hi === Infinity ? null : hi })),
      machineryExcluded: [...MACHINERY],
      reconciliation: { residualAi: +residualAi.toFixed(6), negativeBalances: negative },
      snapshots: snaps,
    },
  };
}

/**
 * Dollars per AI at a given time, from the indexed USDG pools' hourly closes.
 *
 * The busiest pool with a close in that hour wins; a gap carries the last close
 * forward for up to a day. Before the first USDG pool traded there is no dollar
 * price on chain at all, and those snapshots get a holder count with no buckets
 * rather than a bucket built on a guess.
 */
export function usdPriceLookup(flowPools) {
  const pools = (flowPools || []).filter((p) => p.pairSymbol === "USDG")
    .sort((a, b) => (b.totalSwaps || 0) - (a.totalSwaps || 0));
  const byHour = new Map();
  for (const p of pools) {
    for (const h of p.hourly || []) {
      if (h.close > 0 && !byHour.has(h.t)) byHour.set(h.t, h.close);
    }
  }
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  return (t) => {
    let lo = 0, hi = hours.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hours[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0 || t - hours[best] > 86400) return null;
    return byHour.get(hours[best]);
  };
}

/**
 * Whichever replay has got further: the resume cache or the committed seed.
 *
 * The first replay takes about half an hour, which no CI run has, and the resume
 * cache it would build in is per-runner and evicted without notice. So a
 * finished replay is committed once as a compressed seed. A run adopts it only
 * when its own state is behind, and from then on the cache carries it forward;
 * the seed never overrides newer work.
 */
export async function pickHolderState(cached, seedPath) {
  const fs = await import("node:fs");
  const zlib = await import("node:zlib");
  let seed = null;
  try { seed = JSON.parse(zlib.gunzipSync(fs.readFileSync(seedPath)).toString("utf8")); } catch { seed = null; }
  if (!seed) return cached || null;
  if (!cached || (seed.cursor ?? 0) > (cached.cursor ?? 0)) return seed;
  return cached;
}
