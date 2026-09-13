import { getLogsRange } from "../rpc.mjs";
import { decodeTransfer } from "../decode.mjs";
import {
  AI, GENESIS_BLOCK, POOL_MANAGER, LONG_HOOK, COMMUNITY_VAULT, FEE_SPLITTER, BURN_ADDRESS,
} from "../config.mjs";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const STEP = 4 * 3600;          // snapshot cadence
const WINDOW = 250_000;          // blocks per outer read; see the memory note below
const WEEK = 7 * 86400;

/* Bumped when the state gains fields a replay from genesis has to fill. A seed
   with a newer schema is adopted over a cache that is merely further along,
   because the cache cannot backfill what it never recorded. */
export const HOLDER_STATE_SCHEMA = 3;   // 3: churn by set difference between snapshots

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

/* Concentration is reported at these ranks, as shares of what holders (not
   machinery) hold between them. Top-10 is the "could five wallets dump this"
   question; top-100 is the one that moves over weeks. */
export const TOP_RANKS = [10, 50, 100];

/* A transfer this size is a whale move: about $65k at the September price. Below
   it the tape is noise; above it a reader can name the wallet and watch what it
   does next. */
export const WHALE_MIN_AI = 250_000;
const WHALE_MIN = BigInt(WHALE_MIN_AI) * 10n ** 18n;
const WHALE_KEEP = 400;          // in state
const WHALE_PUBLISH = 200;       // in the artifact
const TOP_HOLDERS_PUBLISH = 25;

/**
 * Who holds AI, in dollars, every four hours since genesis.
 *
 * Built by replaying every AI Transfer ever emitted -- roughly six million of
 * them -- into a balance per address, and bucketing the balances by dollar value
 * at each four-hour boundary. Nothing is sampled: a holder count here is the
 * number of addresses with a non-zero balance at that moment.
 *
 * Why it can lead price where most on-chain measures only describe it: the
 * breadth of meaningful holders changes before a move shows up in the tape. A
 * rising count of $1k+ holders at a flat price is accumulation; a falling one on
 * a rally is distribution into strength. Neither is visible in volume.
 *
 * Three readings sit on top of the counts, all from the same replay and costing
 * no extra request:
 *   - concentration: what share of holder-owned AI the top 10 / 50 / 100 hold,
 *     per snapshot, so distribution and accumulation by size are visible;
 *   - churn: addresses that went from zero to funded and funded to zero between
 *     snapshots, which is the gross behind the net holder count;
 *   - a whale tape and a first-seen date per address, from which cohorts are
 *     built -- of the wallets that first bought in a given week, how many still
 *     hold, and how much.
 *
 * Memory: getLogsRange accumulates everything it reads, and six million raw logs
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

  /* First-seen times are only complete when the replay started at genesis. A state
     that began life as a balances-only seed cannot recover them, so the flag says
     whether the cohort figures below describe every holder or only the ones who
     arrived after the seed. */
  const firstSeen = new Map(Object.entries(prev.firstSeen || {}));
  const firstSeenFromGenesis = prev.firstSeenFromGenesis === true || startCursor < GENESIS_BLOCK;
  const whales = prev.whales ? prev.whales.slice() : [];

  /* Churn is a SET DIFFERENCE between snapshots, not a count of transitions.
     Counting every zero-to-funded transition looked right and read 382,640 wallets
     funded in a week against 44,803 holders: routers and aggregators receive and
     forward AI inside one transaction thousands of times a day, and each pass
     counted as a wallet arriving and leaving. A wallet is new only if it holds at
     this boundary and did not at the last one; it has left only if the reverse.
     The previous boundary's holder set rides in the state so the definition
     survives a resume. */
  let prevHolders = new Set(prev.prevHolders || []);
  /* A state written before the set was kept resumes with the wallets funded at the
     cursor standing in for the last boundary's set. One row of churn is then
     approximate rather than every current holder reading as new. */
  if (!prev.prevHolders && prev.snaps?.length) {
    for (const [a, b] of balances) if (b > 0n && !MACHINERY.has(a)) prevHolders.add(a);
  }

  const snapshot = (t) => {
    // The hour that ENDED at t, not the one starting there, so a row never reads a later price.
    const price = priceAt(t - 3600);
    const counts = HOLDER_BUCKETS.map(() => 0);
    const byAi = AI_THRESHOLDS.map(() => 0);
    let holders = 0;
    const sizes = [];
    const curr = new Set();
    for (const [a, b] of balances) {
      if (b <= 0n || MACHINERY.has(a)) continue;
      holders++;
      curr.add(a);
      const ai = Number(b / 10n ** 12n) / 1e6;
      sizes.push(ai);
      for (let k = 0; k < AI_THRESHOLDS.length; k++) if (ai >= AI_THRESHOLDS[k]) byAi[k]++;
      if (price == null) continue;
      const usd = ai * price;
      const i = HOLDER_BUCKETS.findIndex((k) => usd >= k.lo && usd < k.hi);
      counts[i]++;
    }
    /* Concentration, as shares of holder-owned supply. Machinery is excluded from
       the denominator too, or a pool-manager balance that is a third of supply
       would make every wallet look small. */
    sizes.sort((a, b) => b - a);
    let held = 0;
    for (const v of sizes) held += v;
    const top = TOP_RANKS.map((n) => {
      let s = 0;
      for (let i = 0; i < Math.min(n, sizes.length); i++) s += sizes[i];
      return held > 0 ? +(s / held).toFixed(4) : null;
    });
    let newHolders = 0, exits = 0;
    for (const a of curr) if (!prevHolders.has(a)) newHolders++;
    for (const a of prevHolders) if (!curr.has(a)) exits++;
    prevHolders = curr;
    snaps.push({
      t, holders,
      price: price == null ? null : +price.toPrecision(6),
      supply: +(Number(supply / 10n ** 12n) / 1e6).toFixed(2),
      buckets: price == null ? null : counts,
      aboveAi: byAi,
      heldAi: Math.round(held),
      top,
      newHolders, exits,
    });
  };

  /* A large move, classified by which side of it is the pool. v4 settles a buy by
     paying the recipient straight from the PoolManager and a sell by pulling into
     it, so the pool manager on one side names the direction. Fee legs and mints are
     left out: they are the splitter's mechanics, not anyone's decision. */
  const whaleKind = (x) => {
    if (x.from === BURN_ADDRESS || x.to === BURN_ADDRESS) return null;
    if (x.from === FEE_SPLITTER || x.to === COMMUNITY_VAULT || x.to === FEE_SPLITTER) return null;
    if (x.from === POOL_MANAGER) return "buy";
    if (x.to === POOL_MANAGER) return "sell";
    if (x.from === LONG_HOOK || x.to === LONG_HOOK) return "hook";
    return "transfer";
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

      const kind = x.value >= WHALE_MIN ? whaleKind(x) : null;
      let toWasEmpty = false;

      if (x.from === BURN_ADDRESS) supply += x.value;
      else balances.set(x.from, (balances.get(x.from) || 0n) - x.value);
      if (x.to === BURN_ADDRESS) supply -= x.value;
      else {
        const before = balances.get(x.to) || 0n;
        balances.set(x.to, before + x.value);
        if (before <= 0n && x.value > 0n && !MACHINERY.has(x.to)) {
          toWasEmpty = true;
          if (!firstSeen.has(x.to)) firstSeen.set(x.to, ts);
        }
      }
      if (kind) {
        whales.push({
          t: ts, block: x.block, kind, from: x.from, to: x.to,
          ai: Math.round(Number(x.value / 10n ** 12n) / 1e6),
          tx: x.tx, fresh: kind === "buy" && toWasEmpty,
        });
        if (whales.length > WHALE_KEEP * 2) whales.splice(0, whales.length - WHALE_KEEP);
      }
    }
    read += logs.length;
    cursor = reached;
    if (logs.truncated || reached < hi) { partial = true; break; }
  }
  if (whales.length > WHALE_KEEP) whales.splice(0, whales.length - WHALE_KEEP);

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

  /* Cohorts by first-seen week: of the wallets that first held AI in a week, how
     many still do and how much they hold. Retention is the honest version of
     "holders are up" -- a count can rise while every early buyer leaves. */
  const cohorts = new Map();
  for (const [a, t] of firstSeen) {
    if (MACHINERY.has(a)) continue;
    const w = Math.floor(t / WEEK) * WEEK;
    let c = cohorts.get(w);
    if (!c) cohorts.set(w, (c = { t: w, acquired: 0, holding: 0, ai: 0 }));
    c.acquired++;
    const b = balances.get(a);
    if (b && b > 0n) { c.holding++; c.ai += Number(b / 10n ** 12n) / 1e6; }
  }
  const cohortRows = [...cohorts.values()].sort((a, b) => a.t - b.t)
    .map((c) => ({ ...c, ai: Math.round(c.ai), retention: c.acquired ? +(c.holding / c.acquired).toFixed(4) : null }));

  /* The largest wallets, named. Addresses are public by construction; what the
     page adds is the balance, its share, and when the wallet first held AI. */
  const topHolders = [...balances]
    .filter(([a, b]) => b > 0n && !MACHINERY.has(a))
    .sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0))
    .slice(0, TOP_HOLDERS_PUBLISH)
    .map(([a, b]) => ({
      address: a,
      ai: Math.round(Number(b / 10n ** 12n) / 1e6),
      since: firstSeen.get(a) ?? null,
    }));

  return {
    state: {
      schema: HOLDER_STATE_SCHEMA,
      cursor, lastT, supply: supply.toString(), snaps,
      balances: Object.fromEntries([...balances].map(([a, b]) => [a, b.toString()])),
      firstSeen: Object.fromEntries(firstSeen),
      firstSeenFromGenesis,
      whales,
      prevHolders: [...prevHolders],
      seedCursor: prev.seedCursor ?? null,   // which committed seed this state descends from
    },
    artifact: {
      complete, cursor,
      aiThresholds: AI_THRESHOLDS,
      topRanks: TOP_RANKS,
      whaleMinAi: WHALE_MIN_AI,
      buckets: HOLDER_BUCKETS.map(({ key, label, lo, hi }) => ({ key, label, lo, hi: hi === Infinity ? null : hi })),
      machineryExcluded: [...MACHINERY],
      reconciliation: { residualAi: +residualAi.toFixed(6), negativeBalances: negative },
      snapshots: snaps,
      firstSeenFromGenesis,
      cohorts: cohortRows,
      topHolders,
      whales: whales.slice(-WHALE_PUBLISH).reverse(),
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
 *
 * One exception: a seed with a NEWER SCHEMA wins even when the cache is further
 * along, because the cache cannot backfill a field it never recorded. Without
 * this, first-seen dates and the whale tape would exist locally and never reach
 * the published site, since the runner's cache is always a few blocks ahead.
 */
export async function pickHolderState(cached, seedPath) {
  const fs = await import("node:fs");
  const zlib = await import("node:zlib");
  let seed = null;
  try { seed = JSON.parse(zlib.gunzipSync(fs.readFileSync(seedPath)).toString("utf8")); } catch { seed = null; }
  if (!seed) return cached || null;
  /* Lineage decides. A state adopted from a seed remembers that seed's cursor and
     carries it forward; a cache that descends from THIS seed is simply further
     along and wins, while any other cache -- older seed, older schema, a fix that
     needed a fresh replay -- yields to a seed replayed from genesis. Without this
     the runner's cache, always a few blocks ahead, could never be replaced. */
  seed.seedCursor = seed.cursor;
  if (!cached) return seed;
  if ((seed.schema ?? 1) > (cached.schema ?? 1)) return seed;
  if (seed.firstSeenFromGenesis === true && cached.seedCursor !== seed.cursor) return seed;
  if ((seed.cursor ?? 0) > (cached.cursor ?? 0)) return seed;
  return cached;
}
