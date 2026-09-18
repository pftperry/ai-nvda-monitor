import { getLogsRange } from "../rpc.mjs";

/**
 * The venues our market denominator was missing, and the one that changed underneath
 * it (docs/dune/README.md).
 *
 * Dune's denominator is `dex.trades`, which is every decoded DEX on the chain. Ours
 * read the Uniswap v4 PoolManager and nothing else, so two whole venue families were
 * invisible: a v2-style factory and a v3-style factory, the latter running a
 * USDG/NVDA pool at five basis points. This module catalogues their pools, keeps the
 * ones holding exactly one listed token (Dune excludes stock/stock rows), and folds
 * their swaps into the same hourly buckets the rest of the series uses.
 *
 * Rialto is the second half. Robinhood's own venue replaced its fill event on
 * 15 Sep 2026: the old topic stops dead at block 64,676,631 and a new one takes over,
 * which is why the site's two Rialto figures disagreed by a factor of forty-six. Both
 * are read here, the old one for history and the new one for everything since, so the
 * series does not have a hole where the venue changed its mind.
 */
const V2_FACTORY = "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f";
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
/** Rialto's venue events: the fill event it emitted until 15 Sep 2026, then its replacement. */
export const RIALTO_FILL_OLD = "0x4b02af496e764b30261032ae2ad58e4f96e73563c59fe32f8401e76531c1a95e";
export const RIALTO_FILL_NEW = "0x824a7dbfc9f746ced98e93f691f8e5c68d0a549b6999eeaa16192f903e39aa27";
export const RIALTO = "0x4262efbd176f02824af27010bea218429c33c7e8";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const HOUR = 3600;

const addrOf = (h) => "0x" + h.slice(-40).toLowerCase();
const word = (data, i) => data.slice(2 + 64 * i, 2 + 64 * (i + 1));
const uint = (h) => BigInt("0x" + h);
const int = (h) => BigInt.asIntN(256, BigInt("0x" + h));
const absBig = (v) => (v < 0n ? -v : v);

/**
 * Pools on the v2 and v3 factories that hold exactly one listed token.
 * Returns { pools: {addr: {kind, stock, other, stockIsToken0, block}}, cursors, partial }.
 */
export async function indexVenues(latest, registry, opts = {}) {
  const store = opts.store, log = opts.log || console.log;
  let V = store && store.get("rwaVenues");
  if (!V || V.v !== 1) V = { v: 1, pools: {}, cursors: {} };
  const listed = registry.tokens;
  for (const [kind, factory, topic] of [["v2", V2_FACTORY, PAIR_CREATED], ["v3", V3_FACTORY, POOL_CREATED]]) {
    const from = (V.cursors[kind] ?? 0) + 1;
    if (from > latest) continue;
    const r = await getLogsRange({ address: factory, topics: [topic] }, from, latest, {
      chunk: 4_000_000, deadline: opts.deadline,
      onLogs: (logs) => {
        for (const l of logs) {
          const t0 = addrOf(l.topics[1]), t1 = addrOf(l.topics[2]);
          const a = !!listed[t0], b = !!listed[t1];
          if (a === b) continue;                                  // exactly one listed side, as Dune requires
          /* Both factories put the pool address in the last word of the data. */
          const pool = addrOf(word(l.data, (l.data.length - 2) / 64 - 1));
          V.pools[pool] = { kind, stock: a ? t0 : t1, other: a ? t1 : t0, stockIsToken0: a, block: parseInt(l.blockNumber, 16) };
        }
      },
    });
    V.cursors[kind] = r.reachedBlock ?? latest;
    if (r.truncated) V.partial = true; else V.partial = false;
  }
  if (store) store.set("rwaVenues", V);
  const n = Object.values(V.pools);
  log(`  other venues: ${n.length} pools hold exactly one listed token (${n.filter((p) => p.kind === "v2").length} v2, ${n.filter((p) => p.kind === "v3").length} v3)${V.partial ? ", still scanning" : ""}`);
  return V;
}

/**
 * Swaps in those pools, folded per stock per UTC day into stock units. The stock leg
 * is what Dune measures, so the amounts taken are the listed token's side: for v2 the
 * in and out amounts of that side summed (only one is non-zero per trade), for v3 the
 * signed delta of that side.
 */
export async function indexVenueSwaps(latest, tm, venues, opts = {}) {
  const store = opts.store, log = opts.log || console.log;
  let S = store && store.get("rwaVenueSwaps");
  if (!S || S.v !== 1) S = { v: 1, cursor: null, days: {} };
  const pools = Object.keys(venues.pools);
  if (!pools.length) return S;
  if (S.cursor == null) S.cursor = Math.min(...Object.values(venues.pools).map((p) => p.block)) - 1;
  if (S.cursor >= latest) { log(`  other-venue swaps: at the head`); return S; }
  let folded = 0;
  /* One address-filtered scan over the whole pool set: the node takes an address list,
     and the two swap topics are OR'd in one filter. */
  const r = await getLogsRange({ address: pools, topics: [[V2_SWAP, V3_SWAP]] }, S.cursor + 1, latest, {
    chunk: 1_000_000, deadline: opts.deadline,
    onLogs: (logs) => {
      for (const l of logs) {
        const p = venues.pools[l.address.toLowerCase()]; if (!p) continue;
        const d = tm.dayBucket(parseInt(l.blockNumber, 16)); if (d == null) continue;
        let units;
        if (l.topics[0] === V2_SWAP) {
          /* v2 Swap(amount0In, amount1In, amount0Out, amount1Out): the stock side's
             in and out, one of which is zero. */
          const i = p.stockIsToken0 ? 0 : 1;
          units = uint(word(l.data, i)) + uint(word(l.data, i + 2));
        } else {
          /* v3 Swap(amount0, amount1, ...): pool-perspective signed deltas. */
          units = absBig(int(word(l.data, p.stockIsToken0 ? 0 : 1)));
        }
        if (units <= 0n) continue;
        const row = (S.days[d] ||= {});
        row[p.stock] = (row[p.stock] || 0) + Number(units) / 1e18;
        folded++;
      }
    },
  });
  S.cursor = r.reachedBlock ?? latest;
  S.partial = !!r.truncated;
  if (store) store.set("rwaVenueSwaps", S);
  log(`  other-venue swaps: ${folded.toLocaleString()} folded this run, ${Object.keys(S.days).length} days${S.partial ? ", resumes next run" : ", at the head"}`);
  return S;
}

/**
 * Rialto's own venue, across both of its event formats, folded per stock per UTC day
 * in USDG. The USDG leg is the amount in when the trader paid USDG and the amount out
 * when they received it; on a sell that figure is net of the venue's fee, about
 * 0.7% under the gross transfer Dune reads, which is stated on the page.
 */
export async function indexRialto(latest, tm, registry, opts = {}) {
  const store = opts.store, log = opts.log || console.log;
  let R = store && store.get("rwaRialto");
  if (!R || R.v !== 2) R = { v: 2, cursor: null, days: {} };     // v2: both event formats
  const listed = registry.tokens;
  if (R.cursor == null) R.cursor = (opts.from ?? 1) - 1;
  if (R.cursor >= latest) { log(`  Rialto: at the head`); return R; }
  let folded = 0, byFormat = { old: 0, new: 0 };
  const r = await getLogsRange({ address: RIALTO, topics: [[RIALTO_FILL_OLD, RIALTO_FILL_NEW]] }, R.cursor + 1, latest, {
    chunk: 2_000_000, deadline: opts.deadline,
    onLogs: (logs) => {
      for (const l of logs) {
        if (l.topics.length < 4) continue;
        const d = tm.dayBucket(parseInt(l.blockNumber, 16)); if (d == null) continue;
        const tin = addrOf(l.topics[2]), tout = addrOf(l.topics[3]);
        const stock = listed[tin] ? tin : listed[tout] ? tout : null;
        if (!stock) continue;
        /* Both formats carry amount-in at word 1 and amount-out at word 3; USDG is six
           decimals, so whichever side is USDG gives the dollar value directly. */
        const usd = tin === USDG ? Number(uint(word(l.data, 1))) / 1e6
                  : tout === USDG ? Number(uint(word(l.data, 3))) / 1e6 : null;
        if (!(usd > 0)) continue;
        const row = (R.days[d] ||= {});
        row[stock] = (row[stock] || 0) + usd;
        folded++;
        byFormat[l.topics[0] === RIALTO_FILL_NEW ? "new" : "old"]++;
      }
    },
  });
  R.cursor = r.reachedBlock ?? latest;
  R.partial = !!r.truncated;
  if (store) store.set("rwaRialto", R);
  log(`  Rialto: ${folded.toLocaleString()} fills folded this run (${byFormat.old.toLocaleString()} old format, ${byFormat.new.toLocaleString()} new)${R.partial ? ", resumes next run" : ", at the head"}`);
  return R;
}
