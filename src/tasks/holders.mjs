import { getLogsRange } from "../rpc.mjs";
import { decodeTransfer } from "../decode.mjs";
import {
  AI, GENESIS_BLOCK, POOL_MANAGER, LONG_HOOK, COMMUNITY_VAULT, FEE_SPLITTER, BURN_ADDRESS, PLATFORM_FEE_RECIPIENT,
} from "../config.mjs";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const STEP = 4 * 3600;          // snapshot cadence
const WINDOW = 250_000;          // blocks per outer read; see the memory note below
const WEEK = 7 * 86400;

/* Bumped when the state gains fields a replay from genesis has to fill. A seed
   with a newer schema is adopted over a cache that is merely further along,
   because the cache cannot backfill what it never recorded. */
/* The bump is what forces a replay, and these fields need one: every value here is
   computed as a snapshot is taken and is never written back into one already
   stored, so a resumed cache leaves the history blank and fills only the newest
   four-hourly row.
     5: gini, nakamoto, hhi, top1pct, medianAi per snapshot
     6: the whale ledger (per-wallet position history and cost basis) and flow
        banded by the seller's size
     7: contracts proved by eth_getCode (pools, routers, proxies) excluded as
        machinery, and counted as pool contact for the trade/move split */
export const HOLDER_STATE_SCHEMA = 7;   // 6: whale ledger (per-wallet position history, cost basis) and size-banded flow

/* Addresses that hold AI as machinery rather than as an owner. The pool manager
   holds every v4 pool's inventory, the vault holds the locked leg, the splitter
   passes fees through and the hook holds launch reserves. Counting any of them as
   "a holder" would put one address with tens of millions of AI in the top bucket
   and call it a whale. They are still in the supply reconciliation below. */
/* The platform fee wallet is machinery too: it forwards everything it receives in
   the same breath (balance measured at zero, 947 transfers in and 662 out), so it
   is a pipe, not a holder, and netting a swap's transfers would otherwise call it
   a buyer on every trade. */
/* The protocol's buyback contract (named as such in LONG's own Dune methodology,
   sender 0x6f02…0F77) holds several million AI and passes AI through on most
   launched-token swaps; a contract, not an owner. */
export const LONG_BUYBACK = "0x6f02324d20cc679d0e585290caa6b16bacbc0f77";
const MACHINERY = new Set([BURN_ADDRESS, POOL_MANAGER, LONG_HOOK, COMMUNITY_VAULT, FEE_SPLITTER, PLATFORM_FEE_RECIPIENT, LONG_BUYBACK]);

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
const TOP_HOLDERS_PUBLISH = 50;

/* The ledger follows wallets THROUGH the top, not wallets currently in it.
   Tracking only today's top 50 hides the event worth seeing: a holder that sells
   most of its position drops down the list, so the table loses the row at the
   moment it starts to matter. Measured on this token, the rank-4 wallet sold 25.8%
   of its stack in one transaction on 17 September; a few more like that and it
   leaves a top-50 view entirely. So membership is "was ever in the top 100 at any
   snapshot", and it is never revoked. */
const LEDGER_RANKS = 100;

/* Bands for "who is doing the selling", by what the wallet held BEFORE the trade.
   Size, not rank: rank needs a sort at every transaction and says less anyway,
   because rank 40 and rank 400 can hold within a rounding error of each other on a
   long tail like this one. The top band is drawn at 10M AI, which is roughly where
   this token's top fifty begins. */
const SIZE_BANDS = [
  { key: "mega",  label: "10M+ AI",      lo: 10e6, hi: Infinity },
  { key: "large", label: "1M - 10M",     lo: 1e6,  hi: 10e6 },
  { key: "mid",   label: "100k - 1M",    lo: 1e5,  hi: 1e6 },
  { key: "small", label: "10k - 100k",   lo: 1e4,  hi: 1e5 },
  { key: "retail", label: "under 10k",   lo: 0,    hi: 1e4 },
];
const FLOW_DAYS_KEEP = 120;
/* Position history is published one point per day. Snapshots are four-hourly and
   six times the rows buys nothing on a chart that spans months; the four-hourly
   detail stays in the state for the flow arithmetic. */
const LEDGER_DAILY = true;
/* How many rows carry that series. See the note where it is applied. */
const LEDGER_HISTORY_ROWS = 200;

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

  /* Machinery for THIS replay: the fixed protocol set plus contracts the account
     classifier has proved are not people -- v3 pools and routers holding other
     people's liquidity, which ranked as holders (one at #11 with 10.56M AI) and put
     1.64pp into the published top-100 share.

     The extra set is pinned in the state and only a replay from genesis adopts a
     new one. A set that grew mid-history would leave the early snapshots computed
     with a pool counted as a holder and the later ones without it, and the series
     would show a concentration drop that is nothing but a change of definition.
     Contracts discovered after the seed are badged on the page until the next
     rebuild picks them up. */
  const extraMachinery = (prev.extraMachinery ?? opts.extraMachinery ?? []).map((a) => a.toLowerCase());
  const machinery = new Set([...MACHINERY, ...extraMachinery]);
  const extraPools = new Set(extraMachinery);

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

  /* The whale ledger: who the big wallets are, what they have done with the
     position, and what it cost them.

     `tracked` is the membership set (see LEDGER_RANKS), `ledger` the position of
     each member at every snapshot, and `basis` the running cost of each member's
     stack.

     Cost is average-cost, which is the convention a reader will assume and the
     only one that survives wallets with hundreds of fills. Two rules keep it
     honest. A transaction that touched the pool manager is a TRADE and prices at
     the hour's close: a buy raises quantity and cost, a sale books realised profit
     against the average and leaves the average alone. A transaction that touched no
     pool is a MOVE, not a trade, and books nothing -- quantity and cost leave the
     sender pro rata and arrive at the receiver at the same average. Treating a move
     as a sale is the standard way these numbers go wrong: a wallet consolidating
     across two of its own addresses would otherwise print a realised gain it never
     made. */
  const tracked = new Set(prev.tracked || []);
  const ledger = new Map(Object.entries(prev.ledger || {}));
  const basis = new Map(Object.entries(prev.basis || {}).map(([a, v]) => [a, { ...v }]));
  /* Day -> per-band buy and sell totals. Wallet sets are rebuilt from the state's
     counts on resume rather than persisted: the count is what gets published and
     carrying fifty thousand addresses per day would dwarf the rest of the state. */
  const flowBySize = new Map(Object.entries(prev.flowBySize || {}).map(([d, bands]) =>
    [Number(d), bands.map((b) => ({ buy: b.buy, sell: b.sell, wallets: new Set(), resumedWallets: b.wallets || 0 }))]));
  const basisOf = (a) => {
    let s = basis.get(a);
    if (!s) { s = { qty: 0, cost: 0, realized: 0, bought: 0, sold: 0, firstBuyT: null, lastTradeT: null }; basis.set(a, s); }
    return s;
  };

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
  if (!prevHolders.size && prev.snaps?.length) {
    for (const [a, b] of balances) if (b > 0n && !machinery.has(a)) prevHolders.add(a);
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
      if (b <= 0n || machinery.has(a)) continue;
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
    /* Ledger membership, by selection rather than a second sort. `sizes` is already
       ordered, so the balance at rank LEDGER_RANKS is the cut, and one more pass over
       the balances names everyone at or above it. Ties can admit a few extra wallets,
       which costs nothing and beats an arbitrary tiebreak. Membership is additive:
       once a wallet has been this big it keeps its row however far it falls. */
    const cut = sizes.length >= LEDGER_RANKS ? sizes[LEDGER_RANKS - 1] : 0;
    for (const [a, b] of balances) {
      if (b <= 0n || machinery.has(a)) continue;
      if (Number(b / 10n ** 12n) / 1e6 >= cut) tracked.add(a);
    }
    /* One position row per tracked wallet per snapshot, including wallets that have
       gone to zero: a balance of nothing after a large balance is the whole story on
       an exit, and a missing row would read as "no data" instead. */
    for (const a of tracked) {
      const b = balances.get(a) || 0n;
      let arr = ledger.get(a);
      if (!arr) { arr = []; ledger.set(a, arr); }
      arr.push([t, +(Number(b / 10n ** 12n) / 1e6).toFixed(2)]);
    }
    /* The distribution metrics the literature actually uses, all computed from the
       sorted balances already in hand.

       GINI is the standard inequality measure, 0 when every wallet holds the same and
       1 when one wallet holds everything. Token holder sets sit high by nature because
       dust wallets are numerous, so the level matters less than the direction.

       NAKAMOTO is the count of wallets that together pass half the supply. It is the
       blunt question a reader wants answered: how many people would have to agree to
       move this market. Bigger is healthier.

       HHI is the competition regulators' concentration index, the sum of squared
       percentage shares. Above 2,500 a market is "highly concentrated" in antitrust
       terms, which is a useful anchor even though it was written for firms.

       Machinery is already out of the balances, so pools and the vault do not flatter
       or distort any of these. */
    const n = sizes.length;
    let gini = null, nakamoto = null, hhi = null, top1pct = null, medianAi = null;
    if (n > 1 && held > 0) {
      /* sizes are sorted descending; the Gini sum wants ascending rank j = n - i */
      let weighted = 0, sq = 0;
      for (let i = 0; i < n; i++) {
        weighted += (n - i) * sizes[i];
        const share = sizes[i] / held;
        sq += share * share;
      }
      gini = +((2 * weighted) / (n * held) - (n + 1) / n).toFixed(4);
      hhi = Math.round(sq * 10_000);
      let cum = 0;
      for (let i = 0; i < n; i++) { cum += sizes[i]; if (cum > held / 2) { nakamoto = i + 1; break; } }
      const onePct = Math.max(1, Math.ceil(n * 0.01));
      let s1 = 0;
      for (let i = 0; i < onePct; i++) s1 += sizes[i];
      top1pct = +(s1 / held).toFixed(4);
      medianAi = +sizes[n >> 1].toFixed(4);
    }
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
      gini, nakamoto, hhi, top1pct, medianAi,
      newHolders, exits,
      // wallets that netted AI in, or out, through a pool during the period
      buyers: periodBuyers.size, sellers: periodSellers.size,
    });
    periodBuyers = new Set(); periodSellers = new Set();
  };

  /* Actors, not addresses.

     A v4 trade passes through a router, so the transfer that touches the
     PoolManager names the router and the person is one hop away; measured, the
     busiest hour on AI/NVDA had 5,019 swaps from 18 "senders". Netting every
     transfer in a transaction per address dissolves the hops: routers net to zero,
     and the wallet whose balance actually changed is the trader -- a buyer if it
     netted AI in through a transaction that touched a pool, a seller if it netted
     AI out. Transfers arrive in log order, so a transaction's rows are contiguous
     and a transaction sits in one block, so netting never straddles a snapshot. The
     same netting names whale moves by the wallet rather than by a router hop. */
  let periodBuyers = new Set(prev.periodBuyers || []), periodSellers = new Set(prev.periodSellers || []);
  const txFresh = new Set();
  let txRows = [], txHash = null;
  const flushTx = () => {
    if (!txRows.length) return;
    const delta = new Map();
    let pool = false;
    for (const x of txRows) {
      if (x.from === POOL_MANAGER || x.to === POOL_MANAGER || extraPools.has(x.from) || extraPools.has(x.to)) pool = true;
      if (x.from !== BURN_ADDRESS) delta.set(x.from, (delta.get(x.from) || 0n) - x.value);
      if (x.to !== BURN_ADDRESS) delta.set(x.to, (delta.get(x.to) || 0n) + x.value);
    }
    const first = txRows[0];
    for (const [a, d] of delta) {
      if (d === 0n || machinery.has(a)) continue;
      if (pool) { if (d > 0n) periodBuyers.add(a); else periodSellers.add(a); }
      const mag = d < 0n ? -d : d;
      const ai = Number(mag / 10n ** 12n) / 1e6;
      /* The balance the wallet had BEFORE this transaction. flushTx runs when the
         NEXT transaction's first row arrives, so this one is already applied and the
         delta has to come back off. Getting this backwards would file a wallet that
         just sold its whole stack under "held nothing", which is the opposite of
         what the chart is for. */
      const heldBefore = Number(((balances.get(a) || 0n) - d) / 10n ** 12n) / 1e6;
      if (pool) {
        /* Where the day's flow came from, by how big the wallet already was. This is
           the direct test of "are the big holders distributing": it needs no rank, no
           labels and no attribution beyond the netting already done above. */
        const day = Math.floor(first.ts / 86400) * 86400;
        let row = flowBySize.get(day);
        if (!row) { row = SIZE_BANDS.map(() => ({ buy: 0, sell: 0, wallets: new Set() })); flowBySize.set(day, row); }
        const band = SIZE_BANDS.findIndex((b) => heldBefore >= b.lo && heldBefore < b.hi);
        if (band >= 0) {
          row[band][d > 0n ? "buy" : "sell"] += ai;
          row[band].wallets.add(a);
        }
      }
      if (tracked.has(a)) {
        const s = basisOf(a), px = priceAt(first.ts) ?? 0;
        s.lastTradeT = first.ts;
        if (!pool) {
          /* A move, not a trade. Quantity leaves at the average it came in at, so
             the average is untouched and nothing is realised. */
          if (d < 0n && s.qty > 0) { const take = Math.min(ai, s.qty); s.cost -= take * (s.cost / s.qty); s.qty -= take; }
          else if (d > 0n) { s.qty += ai; s.cost += ai * px; }
        } else if (d > 0n) {
          s.qty += ai; s.cost += ai * px; s.bought += ai;
          if (s.firstBuyT == null) s.firstBuyT = first.ts;
        } else {
          const avg = s.qty > 0 ? s.cost / s.qty : px;
          const take = Math.min(ai, s.qty);
          s.realized += take * (px - avg);
          s.cost -= take * avg; s.qty -= take; s.sold += ai;
        }
      }
      if (mag >= WHALE_MIN) {
        whales.push({
          t: first.ts, block: first.block,
          kind: pool ? (d > 0n ? "buy" : "sell") : (d > 0n ? "received" : "sent"),
          wallet: a, ai: Math.round(Number(mag / 10n ** 12n) / 1e6), tx: first.tx,
          fresh: d > 0n && txFresh.has(a),
        });
        if (whales.length > WHALE_KEEP * 2) whales.splice(0, whales.length - WHALE_KEEP);
      }
    }
    txRows = []; txFresh.clear();
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
      x.ts = ts;
      if (x.tx !== txHash) { flushTx(); txHash = x.tx; }
      const bucket = Math.floor(ts / STEP) * STEP;
      if (lastT == null) lastT = bucket;
      /* Emit the state as it stood at the END of every four-hour period this
         transfer steps past, before applying it. Quiet periods still get a row,
         carrying the same balances, so the series has no holes to misread. The
         previous transaction was netted above, so its actors land in their own
         period. */
      while (bucket > lastT) { snapshot(lastT + STEP); lastT += STEP; }

      if (x.from === BURN_ADDRESS) supply += x.value;
      else balances.set(x.from, (balances.get(x.from) || 0n) - x.value);
      if (x.to === BURN_ADDRESS) supply -= x.value;
      else {
        const before = balances.get(x.to) || 0n;
        balances.set(x.to, before + x.value);
        if (before <= 0n && x.value > 0n && !machinery.has(x.to)) {
          txFresh.add(x.to);
          if (!firstSeen.has(x.to)) firstSeen.set(x.to, ts);
        }
      }
      txRows.push(x);
    }
    flushTx();
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
    if (machinery.has(a)) continue;
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
    .filter(([a, b]) => b > 0n && !machinery.has(a))
    .sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0))
    .slice(0, TOP_HOLDERS_PUBLISH)
    .map(([a, b]) => ({
      address: a,
      ai: Math.round(Number(b / 10n ** 12n) / 1e6),
      since: firstSeen.get(a) ?? null,
    }));

  /* The whale ledger. One row per tracked wallet: where the position stands, how it
     has moved over the windows a reader actually asks about, what it cost, and what
     is still on the table.

     `peak` and `offPeak` are the pair that answer the distribution question without
     needing a window at all. A wallet 40% off its own high has distributed, whenever
     it happened; a wallet at its high has not, however busy its tape looks. */
  const nowT = snaps.length ? snaps[snaps.length - 1].t : null;
  const lastPrice = snaps.length ? snaps[snaps.length - 1].price : null;
  const at = (arr, t) => {
    /* the last reading at or before t, so a young wallet reports no change rather
       than a fabricated one against a zero it never held */
    let v = null;
    for (const [ts, bal] of arr) { if (ts > t) break; v = bal; }
    return v;
  };
  const whaleLedger = [...tracked].map((a) => {
    const hist = ledger.get(a) || [];
    /* The position AS OF THE LAST SNAPSHOT, not the live balance at the cursor.
       Those differ by whatever the wallet did in the part-hours since, and mixing
       them makes a row disagree with itself: a market maker showed a headline
       10,105,285 against a history ending at 10,380,621, and the accumulator
       contract showed a balance above its own peak. Every figure in the row now
       comes off the same instant, so the sparkline ends where the number says. */
    const cur = hist.length ? hist[hist.length - 1][1] : Number((balances.get(a) || 0n) / 10n ** 12n) / 1e6;
    const s = basis.get(a) || null;
    let peak = 0, peakT = null;
    for (const [ts, bal] of hist) if (bal > peak) { peak = bal; peakT = ts; }
    const avg = s && s.qty > 0 ? s.cost / s.qty : null;
    const daily = [];
    let lastDay = null;
    for (const [ts, bal] of hist) {
      const d = Math.floor(ts / 86400) * 86400;
      if (d === lastDay) daily[daily.length - 1] = [d, bal];
      else { daily.push([d, bal]); lastDay = d; }
    }
    return {
      address: a,
      ai: Math.round(cur),
      since: firstSeen.get(a) ?? null,
      d1: nowT == null ? null : Math.round(cur - (at(hist, nowT - 86400) ?? cur)),
      d7: nowT == null ? null : Math.round(cur - (at(hist, nowT - 7 * 86400) ?? cur)),
      d30: nowT == null ? null : Math.round(cur - (at(hist, nowT - 30 * 86400) ?? cur)),
      peak: Math.round(peak), peakT,
      offPeak: peak > 0 ? +((cur / peak) - 1).toFixed(4) : null,
      avgCost: avg == null ? null : +avg.toFixed(6),
      realizedUsd: s ? Math.round(s.realized) : null,
      unrealizedUsd: avg == null || lastPrice == null ? null : Math.round(cur * (lastPrice - avg)),
      boughtAi: s ? Math.round(s.bought) : null,
      soldAi: s ? Math.round(s.sold) : null,
      lastTradeT: s ? s.lastTradeT : null,
      history: LEDGER_DAILY ? daily : hist,
    };
  }).sort((x, y) => y.ai - x.ai);
  /* Membership never lapses, so the ledger accumulates: 836 wallets have been in the
     top 100 at some point across 415 snapshots. Every row keeps its summary, which is
     small, but only the largest carry a position series -- seventy points each across
     836 rows is most of a megabyte on a page people open on a phone. Ranked by the
     bigger of current and peak, so a wallet that has sold down keeps its chart. */
  const byPeak = [...whaleLedger].sort((x, y) => Math.max(y.ai, y.peak) - Math.max(x.ai, x.peak));
  const withHistory = new Set(byPeak.slice(0, LEDGER_HISTORY_ROWS).map((r) => r.address));
  for (const r of whaleLedger) if (!withHistory.has(r.address)) r.history = null;

  const flowRows = [...flowBySize.entries()].sort((a, b) => a[0] - b[0]).slice(-FLOW_DAYS_KEEP)
    .map(([t, bands]) => ({
      t,
      bands: bands.map((b) => ({ buy: Math.round(b.buy), sell: Math.round(b.sell), wallets: Math.max(b.wallets.size, b.resumedWallets || 0) })),
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
      periodBuyers: [...periodBuyers], periodSellers: [...periodSellers],   // the period still open at the cursor
      seedCursor: prev.seedCursor ?? null,   // which committed seed this state descends from
      extraMachinery,                         // pinned for the life of this replay
      tracked: [...tracked],
      ledger: Object.fromEntries(ledger),
      basis: Object.fromEntries(basis),
      flowBySize: Object.fromEntries([...flowBySize].map(([d, bands]) =>
        [d, bands.map((b) => ({ buy: +b.buy.toFixed(2), sell: +b.sell.toFixed(2), wallets: Math.max(b.wallets.size, b.resumedWallets || 0) }))])),
    },
    artifact: {
      complete, cursor,
      aiThresholds: AI_THRESHOLDS,
      topRanks: TOP_RANKS,
      whaleMinAi: WHALE_MIN_AI,
      buckets: HOLDER_BUCKETS.map(({ key, label, lo, hi }) => ({ key, label, lo, hi: hi === Infinity ? null : hi })),
      machineryExcluded: [...machinery],
      reconciliation: { residualAi: +residualAi.toFixed(6), negativeBalances: negative },
      snapshots: snaps,
      firstSeenFromGenesis,
      cohorts: cohortRows,
      topHolders,
      whaleLedger,
      sizeBands: SIZE_BANDS.map(({ key, label, lo, hi }) => ({ key, label, lo, hi: hi === Infinity ? null : hi })),
      flowBySize: flowRows,
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
