import { POOL_MANAGER, LONG_HOOK, GENESIS_BLOCK, AI, USDG, LAUNCHPAD } from "../config.mjs";
import { getLogsRange, rpcBatch } from "../rpc.mjs";
import { TOPICS, decodeInitialize, decodeSwap, priceFromSqrt } from "../decode.mjs";

/**
 * A census of the LONG launchpad, discovered by HOOK rather than by AI.
 *
 * This exists because the first attempt measured the wrong population. The rest of
 * this site discovers pools by scanning Initialize filtered to those containing AI,
 * which is correct for its purpose and useless for this one: a launchpad token is
 * anchored to a real-world asset, not to AI. $MEME is paired with AMC and $BONER
 * with HIMS, so neither appears in an AI-filtered scan at all, and $BONER's AI pool
 * is a hookless bridge that fails a hook test. Measured over 51 hours: 7,406 pools
 * carried the LONG hook and only 711 of them were paired with AI, so the AI-centric
 * lens sees about a tenth of the platform.
 *
 * The hook address sits in each pool's own Initialize log, so filtering on it is a
 * census with no curation and nothing to cherry-pick. It is deliberately kept in
 * its own artifact behind its own cursor: understanding AI's value accretion is the
 * priority here, and this must never be able to slow that down or fail it.
 */

/**
 * Every LONG-hook pool, from an unfiltered Initialize scan.
 *
 * Unfiltered because the hook is in the log's DATA, not its topics, so it cannot be
 * filtered server-side -- every pool creation has to be read and sorted locally.
 * That is the expensive part and it is also append-only, so it resumes from a cursor
 * and a later run reads only what is new.
 */
export async function censusLongPools(latest, prior, opts = {}) {
  const log = opts.log || console.log;
  const from = prior?.cursor ? Math.max(GENESIS_BLOCK, prior.cursor + 1) : GENESIS_BLOCK;
  const pools = new Map();
  for (const p of prior?.pools || []) pools.set(p.id, p);
  /* The same pass also indexes every pool that pairs something with USDG, whatever
     its hook. Anchors are real-world assets -- NVDA, AMC, HIMS -- and each needs a
     dollar price before the tokens anchored to it can be valued; USDG is a dollar
     stablecoin, so its pools are the cheapest honest route to one. Collecting them
     here costs nothing because every Initialize log is already being read. */
  const usdg = new Map();
  for (const p of prior?.usdgPools || []) usdg.set(p.id, p);

  const logs = from > latest ? [] : await getLogsRange(
    { address: POOL_MANAGER, topics: [TOPICS.INITIALIZE] },
    from, latest, { chunk: opts.chunk ?? 300_000, deadline: opts.deadline });

  let seen = 0;
  for (const l of logs) {
    seen++;
    const p = decodeInitialize(l);
    if (p.currency0 === USDG || p.currency1 === USDG) {
      if (!usdg.has(p.poolId)) usdg.set(p.poolId, { id: p.poolId, c0: p.currency0, c1: p.currency1 });
    }
    if ((p.hooks || "").toLowerCase() !== LONG_HOOK.toLowerCase()) continue;
    if (pools.has(p.poolId)) continue;
    pools.set(p.poolId, {
      id: p.poolId, c0: p.currency0, c1: p.currency1,
      block: p.block, fee: p.fee,
    });
  }

  const cursor = logs.reachedBlock ?? latest;
  log(`  census: read ${seen.toLocaleString()} pool creations to block ${cursor.toLocaleString()}` +
      `${logs.truncated ? " (budget reached, resuming next run)" : ""}; ${pools.size.toLocaleString()} LONG pools known`);
  return { cursor, partial: !!logs.truncated, pools: [...pools.values()], usdgPools: [...usdg.values()] };
}

/**
 * Activity for every pool at once, from an unfiltered Swap scan over a short window.
 *
 * The alternative was a topic-set query over the LONG pool ids, which is how the AI
 * side ranks its five thousand pools -- but that caps at a thousand ids per query,
 * so a hundred thousand pools would mean a hundred grouped scans. Reading every swap
 * in a two-hour window and counting by pool id costs a handful of queries and ranks
 * the entire chain in one pass.
 */
export async function rankByActivity(latest, windowBlocks, opts = {}) {
  const counts = new Map();
  const last = new Map();
  const logs = await getLogsRange(
    { address: POOL_MANAGER, topics: [TOPICS.SWAP] },
    Math.max(GENESIS_BLOCK, latest - windowBlocks), latest,
    { chunk: opts.chunk ?? 20_000, deadline: opts.deadline });
  for (const l of logs) {
    const id = l.topics[1];
    counts.set(id, (counts.get(id) || 0) + 1);
    last.set(id, l);                       // most recent wins: the tape is in order
  }
  return { counts, last, swaps: logs.length, truncated: !!logs.truncated };
}

/**
 * Dollar price for every anchor, from its busiest USDG pool.
 *
 * One assumption, stated once: USDG holds its peg. Everything else follows from
 * pool prices, so a stock token gets a dollar value without an oracle and without
 * trusting any venue's own claim about itself. An anchor with no USDG pool simply
 * goes unpriced, and the tokens anchored to it are skipped rather than guessed.
 */
export function anchorPrices(usdgPools, rank, decimals) {
  const out = new Map([[USDG, 1]]);
  const best = new Map();
  for (const p of usdgPools) {
    const other = p.c0 === USDG ? p.c1 : p.c0;
    if (other === USDG) continue;
    const swaps = rank.counts.get(p.id) || 0;
    if (!swaps) continue;
    if (!best.has(other) || best.get(other).swaps < swaps) best.set(other, { p, swaps });
  }
  for (const [token, { p }] of best) {
    const l = rank.last.get(p.id);
    if (!l) continue;
    const sw = decodeSwap(l);
    const tokenIsC0 = p.c0 === token;
    const dT = decimals?.get(token) ?? 18, dU = decimals?.get(USDG) ?? 6;
    const raw = priceFromSqrt(sw.sqrtPriceX96, tokenIsC0 ? dT : dU, tokenIsC0 ? dU : dT);
    const usd = tokenIsC0 ? raw : (raw ? 1 / raw : 0);
    if (usd > 0 && isFinite(usd)) out.set(token, usd);
  }
  return out;
}


/**
 * Which LONG pools are launches, and what was launched in each.
 *
 * The platform's own definition, which is narrower than "has the LONG hook": a
 * launch is a token matched against a real-world asset. A tokenised equity paired
 * with USDG is a listing of that equity, not a launch of anything, and a memecoin
 * paired with AI is an AI bridge, which this project tracks separately. So a pool
 * qualifies only when exactly one side is an RWA and the other side is neither an
 * RWA nor a quote asset.
 *
 * Also reports any token that behaves like an anchor -- appearing in dozens of pools
 * -- but is absent from the curated RWA list. The platform adds underlyings, and a
 * new one would otherwise be silently reclassified as a launched memecoin, quietly
 * inflating exactly the count this exists to report.
 */
export function classifyLaunches(pools, symbols, log = console.log) {
  const isRwa = (addr) => {
    const s = symbols.get(addr);
    return !!s && (LAUNCHPAD.rwaSymbols.has(s.toUpperCase()) || LAUNCHPAD.rwaSuffix.test(s));
  };
  const isQuote = (addr) => LAUNCHPAD.quotes.has(addr);

  const degree = new Map();
  for (const p of pools) for (const t of [p.c0, p.c1]) degree.set(t, (degree.get(t) || 0) + 1);

  const launches = [];
  for (const p of pools) {
    const r0 = isRwa(p.c0), r1 = isRwa(p.c1);
    if (r0 === r1) continue;                       // neither anchored, or RWA against RWA
    const token = r0 ? p.c1 : p.c0;
    const anchor = r0 ? p.c0 : p.c1;
    if (isQuote(token)) continue;                  // an RWA listed against a quote asset
    launches.push({ ...p, token, anchor });
  }

  const unlisted = [...degree]
    .filter(([a, n]) => n >= LAUNCHPAD.anchorDegree && !isRwa(a) && !isQuote(a))
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => ({ token: a, symbol: symbols.get(a) || null, pools: n }));

  log(`  ${launches.length.toLocaleString()} launches of ${pools.length.toLocaleString()} LONG pools ` +
      `(the rest are listings against quotes, RWA-to-RWA, or bridges)`);
  if (unlisted.length) {
    log(`  ${unlisted.length} high-degree token(s) not in the RWA list: ` +
        unlisted.slice(0, 6).map((u) => `${u.symbol || u.token.slice(0, 8)} (${u.pools})`).join(", "));
  }
  return { launches, degree, unlisted };
}

const SUPPLY_SEL = "0x18160ddd";
const BUCKETS = [
  { key: "dust",  label: "under $100k",   lo: 0,    hi: 1e5 },
  { key: "small", label: "$100k - $1M",   lo: 1e5,  hi: 1e6 },
  { key: "mid",   label: "$1M - $10M",    lo: 1e6,  hi: 1e7 },
  { key: "large", label: "$10M - $100M",  lo: 1e7,  hi: 1e8 },
  { key: "mega",  label: "$100M and above", lo: 1e8, hi: Infinity },
];
export const RUNNER_FLOOR = 1e6;

/**
 * Market caps for the busiest launchpad tokens.
 *
 * Only the busiest: pricing needs a supply call per token, and there are tens of
 * thousands of them. Ranking first means the ones that could possibly be runners are
 * always priced, and the unpriced tail is by construction the part with no trading.
 *
 * Each token is valued against ITS OWN anchor, not against AI -- that is the whole
 * correction this file exists for. The anchor's dollar price comes from the caller,
 * which knows AI's price from the USDG pools and can price a stock token from any
 * pool that pairs it with something already valued.
 */
export async function priceLaunchpadTokens(pools, rank, anchorUsd, store, opts = {}) {
  const log = opts.log || console.log;
  const perRun = opts.perRun ?? 150;
  const byId = new Map(pools.map((p) => [p.id, p]));

  const ranked = [...rank.counts.entries()]
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.topN ?? 300);

  /* A token's own address is whichever side of the pool is not the anchor. Pools
     where neither side has a dollar price are skipped rather than guessed at. */
  const jobs = [];
  for (const [id, swaps] of ranked) {
    const p = byId.get(id);
    const a0 = anchorUsd.get(p.c0), a1 = anchorUsd.get(p.c1);
    if (a0 == null && a1 == null) continue;
    const anchorIsC0 = a0 != null;
    jobs.push({
      pool: p, swaps,
      token: anchorIsC0 ? p.c1 : p.c0,
      anchor: anchorIsC0 ? p.c0 : p.c1,
      anchorPrice: anchorIsC0 ? a0 : a1,
      tokenIsC0: !anchorIsC0,
    });
  }

  const cache = (store && store.get("lpSupply")) || {};
  const now = Math.floor(Date.now() / 1000);
  const stale = [...new Set(jobs.map((j) => j.token))]
    .filter((t) => !cache[t] || now - cache[t].at > 12 * 3600)
    .slice(0, perRun);
  for (let i = 0; i < stale.length; i += 20) {
    const g = stale.slice(i, i + 20);
    const res = await rpcBatch(g.map((t) => ({ method: "eth_call", params: [{ to: t, data: SUPPLY_SEL }, "latest"] })));
    res.forEach((r, k) => { if (r && r !== "0x") cache[g[k]] = { raw: BigInt(r).toString(), at: now }; });
  }
  if (store) store.set("lpSupply", cache);

  const rows = [];
  for (const j of jobs) {
    const s = cache[j.token];
    const swapLog = rank.last.get(j.pool.id);
    if (!s || !swapLog) continue;
    const dec = opts.decimals?.get(j.token) ?? 18;
    const anchorDec = opts.decimals?.get(j.anchor) ?? 18;
    const supply = Number(BigInt(s.raw)) / 10 ** dec;
    if (!(supply > 0)) continue;

    const sw = decodeSwap(swapLog);
    const d0 = j.tokenIsC0 ? dec : anchorDec;
    const d1 = j.tokenIsC0 ? anchorDec : dec;
    const raw = priceFromSqrt(sw.sqrtPriceX96, d0, d1);      // token1 per token0
    const anchorPerToken = j.tokenIsC0 ? raw : (raw ? 1 / raw : 0);
    if (!(anchorPerToken > 0)) continue;
    const tokenUsd = anchorPerToken * j.anchorPrice;
    const mcap = supply * tokenUsd;
    if (!isFinite(mcap) || mcap <= 0) continue;

    rows.push({
      token: j.token, anchor: j.anchor, poolId: j.pool.id,
      symbol: opts.symbols?.get(j.token) ?? null,
      anchorSymbol: opts.symbols?.get(j.anchor) ?? null,
      mcapUsd: Math.round(mcap), priceUsd: +tokenUsd.toPrecision(6),
      supply: +supply.toPrecision(6), swaps: j.swaps, createdBlock: j.pool.block,
    });
  }
  rows.sort((a, b) => b.mcapUsd - a.mcapUsd);
  log(`  priced ${rows.length} of ${jobs.length} ranked launchpad tokens; ` +
      `${rows.filter((r) => r.mcapUsd >= RUNNER_FLOOR).length} at or above $1M`);
  return rows;
}

/** Launch cadence and the size distribution, assembled for the Launchpad tab. */
export function summariseLaunchpad(pools, priced, dayOf, prior) {
  const byDay = new Map();
  for (const p of pools) {
    const d = dayOf(p.block);
    if (d) byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  let cum = 0;
  const launchesByDay = [...byDay.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, launched]) => ({ t, launched, cumulative: (cum += launched) }));

  const buckets = BUCKETS.map((b) => ({
    key: b.key, label: b.label, lo: b.lo, hi: b.hi === Infinity ? null : b.hi,
    count: priced.filter((r) => r.mcapUsd >= b.lo && r.mcapUsd < b.hi).length,
  }));

  const hour = Math.floor(Date.now() / 3600000) * 3600;
  const history = (prior?.history || []).filter((h) => h.t !== hour).slice(-24 * 120);
  history.push({
    t: hour, pools: pools.length, priced: priced.length,
    runners: priced.filter((r) => r.mcapUsd >= RUNNER_FLOOR).length,
    totalMcapUsd: Math.round(priced.reduce((s, r) => s + r.mcapUsd, 0)),
  });
  history.sort((a, b) => a.t - b.t);

  return {
    runnerFloor: RUNNER_FLOOR,
    poolsTotal: pools.length,
    aiPaired: pools.filter((p) => p.c0 === AI || p.c1 === AI).length,
    priced: priced.length,
    runners: priced.filter((r) => r.mcapUsd >= RUNNER_FLOOR).length,
    buckets, launchesByDay, history,
    top: priced.slice(0, 30),
  };
}
