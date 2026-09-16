import { POOL_MANAGER, LONG_HOOK, GENESIS_BLOCK, LONG_GENESIS_BLOCK, AI, USDG, LAUNCHPAD } from "../config.mjs";
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
  const from = prior?.cursor ? Math.max(LONG_GENESIS_BLOCK, prior.cursor + 1) : LONG_GENESIS_BLOCK;
  const pools = new Map();
  for (const p of prior?.pools || []) pools.set(p.id, p);
  /* A census that began at AI's genesis owes one pass over LONG's earlier weeks
     (about nine thousand pools were created before AI existed). Read once, then
     remembered as `pre`. */
  const preRange = prior?.cursor && !prior.pre ? [LONG_GENESIS_BLOCK, GENESIS_BLOCK - 1] : null;
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
  const pre = preRange ? await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.INITIALIZE] }, preRange[0], preRange[1], { chunk: 500_000, deadline: opts.deadline }) : null;
  const preDone = !preRange || !pre.truncated;
  if (pre) log(`  census: pre-genesis pass read ${pre.length.toLocaleString()} pool creations from LONG's first block${pre.truncated ? " (budget reached, resumes next run)" : ""}`);

  let seen = 0;
  for (const l of [...(pre || []), ...logs]) {
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
  /* Only the USDG pools that can price an ANCHOR are worth keeping. Every token on
     the platform eventually gets a USDG pool, so retaining all of them meant 145,798
     records against 130,044 LONG pools and a 52 MB cache -- for a lookup that needs
     about forty entries. An anchor is a token many pools are matched against, so the
     degree count already computed here is the filter. The rest are recomputed from
     the tape if the definition ever changes, which is the right trade for a cache. */
  const degree = new Map();
  for (const p of pools.values()) for (const t of [p.c0, p.c1]) degree.set(t, (degree.get(t) || 0) + 1);
  const keptUsdg = [...usdg.values()].filter((u) => {
    const other = u.c0 === USDG ? u.c1 : u.c0;
    return (degree.get(other) || 0) >= 20;
  });
  log(`  keeping ${keptUsdg.length} USDG pools that can price an anchor, of ${usdg.size} seen`);

  return { cursor, partial: !!logs.truncated, pre: prior?.pre ? true : preDone, pools: [...pools.values()], usdgPools: keptUsdg };
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
  const volume = new Map();              // poolId → [|amount0| sum, |amount1| sum] as bigint, raw units
  const logs = await getLogsRange(
    { address: POOL_MANAGER, topics: [TOPICS.SWAP] },
    Math.max(GENESIS_BLOCK, latest - windowBlocks), latest,
    { chunk: opts.chunk ?? 20_000, deadline: opts.deadline });
  const abs = (v) => (v < 0n ? -v : v);
  for (const l of logs) {
    const id = l.topics[1];
    counts.set(id, (counts.get(id) || 0) + 1);
    last.set(id, l);                       // most recent wins: the tape is in order
    /* Gross notional per side, so a caller who knows which side is the stock can
       value the window's stock trading without a second scan. */
    const s = decodeSwap(l);
    const v = volume.get(id) || [0n, 0n];
    v[0] += abs(s.amount0); v[1] += abs(s.amount1);
    volume.set(id, v);
  }
  return { counts, last, volume, swaps: logs.length, truncated: !!logs.truncated };
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
  const isQuote = (addr) => {
    if (LAUNCHPAD.quotes.has(addr)) return true;
    const sym = symbols.get(addr);
    return !!sym && LAUNCHPAD.quoteSymbols.has(sym.toUpperCase());
  };

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
    /* AI is excluded from the missing-anchor report by name. It genuinely behaves
       like an anchor -- 5,533 pools quote themselves in it, which is the hub thesis
       in one number -- but it is a launched token, not a real-world asset, so it
       will never belong on the RWA list and reporting it every run as a gap would
       train the reader to skip the whole line. */
    .filter(([a, n]) => n >= LAUNCHPAD.anchorDegree && !isRwa(a) && !isQuote(a) && a !== AI)
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
  /* Use the classification, do not re-derive it.
     This originally picked the anchor as whichever side had a dollar price, falling
     back to currency0 when both did -- and both usually do, because a token that
     trades gets a USDG pool eventually. So the sides were assigned by address
     ordering, and the output read "MU anchored to MOO", "HIMS anchored to BONER",
     "AAPL anchored to INU": the memecoin treated as the real-world asset and the
     stock priced as though it were the launch. classifyLaunches already decided
     this correctly from the RWA list, so the only correct move is to carry its
     answer through rather than guess at it a second time. */
  const jobs = [];
  for (const [id, swaps] of ranked) {
    const p = byId.get(id);
    if (!p.token || !p.anchor) continue;          // unclassified pools are not launches
    const anchorPrice = anchorUsd.get(p.anchor);
    if (anchorPrice == null) continue;            // no dollar price for the anchor: skip, never guess
    jobs.push({ pool: p, swaps, token: p.token, anchor: p.anchor, anchorPrice, tokenIsC0: p.c0 === p.token });
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

    /* What is actually standing behind the price, within 10% of spot. The swap log
       already carries active liquidity and the sqrt price, so this costs nothing
       extra -- and without it a market cap on a launchpad is close to meaningless.
       A token with four thousand dollars of liquidity can print a thirty million
       dollar cap, because one small buy against a thin book revalues the whole
       supply. Understates when liquidity sits in a tighter band than 10%, so read
       it as an order of magnitude, which is all the question needs. */
    const L = Number(sw.liquidity || 0);
    const sqrtP = Number(sw.sqrtPriceX96) / 2 ** 96;
    let backing = null;
    if (L > 0 && sqrtP > 0) {
      const a1 = L * sqrtP * (Math.sqrt(1.1) - 1);
      const a0 = (L / sqrtP) * (1 - Math.sqrt(0.9));
      const usd0 = (a0 / 10 ** d0) * (j.tokenIsC0 ? tokenUsd : j.anchorPrice);
      const usd1 = (a1 / 10 ** d1) * (j.tokenIsC0 ? j.anchorPrice : tokenUsd);
      const v = usd0 + usd1;
      backing = isFinite(v) && v >= 0 ? Math.round(v) : null;
    }

    rows.push({
      token: j.token, anchor: j.anchor, poolId: j.pool.id,
      backingUsd: backing,
      capToBacking: backing > 0 ? +(mcap / backing).toFixed(1) : null,
      symbol: opts.symbols?.get(j.token) ?? null,
      anchorSymbol: opts.symbols?.get(j.anchor) ?? null,
      mcapUsd: Math.round(mcap), priceUsd: +tokenUsd.toPrecision(6),
      supply: +supply.toPrecision(6), swaps: j.swaps, createdBlock: j.pool.block,
    });
  }
  rows.sort((a, b) => b.mcapUsd - a.mcapUsd);
  const bigRows = rows.filter((r) => r.mcapUsd >= RUNNER_FLOOR);
  log(`  priced ${rows.length} of ${jobs.length} ranked launchpad tokens; ${bigRows.length} at or above $1M, median cap/backing ${ratioStats(bigRows).median ?? "n/a"}x`);
  return rows;
}

/**
 * Cap-to-backing across a cohort, described by the cohort.
 *
 * This used to be a count of tokens "backed within 20x". Twenty was borrowed from
 * nowhere, and on this platform nothing clears it: ratios across tokens above $1M run
 * from roughly 60x to 1,200x, so the count was a constant zero presented as a
 * measurement -- and the card led with it, which is why the page appeared to say no
 * token was above a million when twenty were. Backing is also a floor rather than a
 * total: it reads active liquidity within 10% of spot in the single busiest pool, so
 * a token trading across several pools is understated and its ratio overstated. A
 * comparison against a fixed constant survives neither fact. A median and a multiple
 * of it do, and they move when the platform moves.
 */
export function ratioStats(rows) {
  const xs = rows.map((r) => r.capToBacking).filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return { median: null, thinThreshold: null, thin: 0, n: 0 };
  const m = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  const median = +m.toFixed(1);
  const thinThreshold = +(median * 3).toFixed(1);
  return { median, thinThreshold, thin: xs.filter((x) => x >= thinThreshold).length, n: xs.length };
}
/**
 * How often AI is chosen as a side of a new pool, day by day.
 *
 * The anchor ranking says AI is the platform’s third most-used base pair with
 * 5,552 pools behind it. That is a stock, and a stock accumulated over sixty days
 * cannot fall -- it will read "third" for months after adoption stops. The flow is
 * the part that can turn, and it has: AI took 32% of new pools on 5 September and
 * 1.3% on the 9th. A reader looking only at the rank would have seen nothing.
 *
 * Deliberately defined on address identity alone -- AI is one of the two currencies
 * -- rather than on the launch classifier. The classifier depends on the
 * real-world-asset symbol list, which is known to be short, so every count derived
 * from it is a floor. Both terms of this ratio come from the census itself, so it
 * inherits none of that undercount.
 */
export function anchorFlowByDay(pools, dayOf) {
  const byDay = new Map();
  for (const p of pools) {
    const d = dayOf(p.block);
    if (d === null || d === undefined) continue;
    let r = byDay.get(d);
    if (!r) byDay.set(d, (r = { t: d, all: 0, ai: 0 }));
    r.all++;
    if (p.c0 === AI || p.c1 === AI) r.ai++;
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t)
    .map((r) => ({ ...r, share: r.all ? +(r.ai / r.all).toFixed(6) : 0 }));
}
/** Launch cadence and the size distribution, assembled for the Launchpad tab. */
export function summariseLaunchpad(pools, priced, dayOf, prior, allPools = null, swapsByPool = null) {
  /* Cadence, and how much of it survived.

     A launch count on its own is a statement about the mint, not the ecosystem:
     a platform can print three thousand tokens a day and produce nothing that
     trades. The obvious companion is the cohort’s average market cap, and that
     is not honestly available -- pricing a token costs two calls so only the 300
     most active are priced, which leaves most days with one or two of them and
     one $295M outlier able to make a single July day outrank every other. What IS
     available for every launch is whether its pool traded in the ranking window,
     because that scan is unfiltered. So the second dimension is liveness measured
     over the whole population rather than value estimated from a biased sample.

     The window is two hours, which is a strict test and deliberately so: it asks
     whether the token is trading now, not whether it ever did. */
  const byDay = new Map();
  for (const p of pools) {
    const d = dayOf(p.block);
    if (!d) continue;
    let r = byDay.get(d);
    if (!r) byDay.set(d, (r = { launched: 0, active: 0 }));
    r.launched++;
    if (swapsByPool && (swapsByPool.get(p.id) || 0) > 0) r.active++;
  }
  let cum = 0;
  const launchesByDay = [...byDay.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, r]) => ({
      t, launched: r.launched,
      active: swapsByPool ? r.active : null,
      dormant: swapsByPool ? r.launched - r.active : null,
      cumulative: (cum += r.launched),
    }));

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

  const runnerRows = priced.filter((r) => r.mcapUsd >= RUNNER_FLOOR);
  const stats = ratioStats(runnerRows);

  /* Prices of the platform's biggest tokens, kept as a series so AI can be read
     against its own cohort: is it leading the platform or lagging it. Only the
     top twenty by cap plus AI itself, at most one row every three hours (the
     census runs on the slow path), forty-five days deep -- small enough to ship
     in this artifact, long enough for a 7-day comparison. Every price here is a
     pool print, so the same thin-book caveat as the caps applies. */
  const stamp = Math.floor(Date.now() / 1000);
  const tracked = priced.slice(0, 20);
  const aiRow = priced.find((r) => r.token === AI);
  if (aiRow && !tracked.includes(aiRow)) tracked.push(aiRow);
  const snap = {};
  for (const r of tracked) if (r.priceUsd > 0) snap[r.token] = +r.priceUsd.toPrecision(5);
  const priorPh = (prior?.priceHistory || []).filter((h) => stamp - h.t < 45 * 86400);
  const lastPh = priorPh.at(-1);
  const priceHistory = lastPh && stamp - lastPh.t < 2.5 * 3600 ? priorPh : [...priorPh, { t: stamp, p: snap }];
  const priceSymbols = { ...(prior?.priceSymbols || {}) };
  for (const r of tracked) if (r.symbol) priceSymbols[r.token] = r.symbol;

  return {
    priceHistory, priceSymbols,
    runnerFloor: RUNNER_FLOOR,
    poolsTotal: pools.length,
    aiPaired: pools.filter((p) => p.c0 === AI || p.c1 === AI).length,
    priced: priced.length,
    runners: runnerRows.length,
    capToBackingMedian: stats.median,
    thinThreshold: stats.thinThreshold,
    thinRunners: stats.thin,
    ratioMeasured: stats.n,
    anchorFlow: allPools ? anchorFlowByDay(allPools, dayOf) : (prior?.anchorFlow || []),
    activeMeasured: !!swapsByPool,
    activeWindowHours: 2,
    buckets, launchesByDay, history,
    top: priced.slice(0, 30),
  };
}
