import { rpc, getLogsRange, padAddr } from "../rpc.mjs";
import { POOL_MANAGER, COMMUNITY_VAULT, LONG_HOOK, AI, USDG, NVDA, GENESIS_BLOCK } from "../config.mjs";
import { TOPICS, decodeTransfer, decodeInitialize, decodeSwap, decodeModifyLiquidity, fmtUnits } from "../decode.mjs";
import { multicall, resolveTokens } from "../tokens.mjs";
import { ladderRawAmounts } from "./depth.mjs";

/**
 * The real-world-asset ledger: how much of Robinhood Chain's tokenized stock
 * supply, and of its tokenized stock trading, the LONG ecosystem has captured.
 *
 * The thesis being measured is LONG's own: be the liquidity layer for tokenized
 * equities on this chain. Three measures follow from it. Share of supply -- of
 * every NVDA token that exists on Robinhood Chain, what fraction sits inside DEX
 * liquidity or the community vault. Share of trading -- of every swap on the chain
 * that touches a stock token, what fraction (by count and by dollars) goes through
 * a pool carrying the LONG hook. Coverage -- of every stock token that moved on the
 * chain in the last day, how many have a LONG market at all.
 *
 * Stock tokens are identified by bytecode, not by name. Robinhood's tokenized
 * equities are all beacon proxies of one template (283 bytes) pointing at one
 * beacon; NVDA, DELL, ORCL and SPCX match it, a memecoin calling itself HOOD does
 * not. They also emit one private event on every transfer, which no other contract
 * on the chain emits: scanning for it enumerates every stock token that moved.
 */
export const STOCK_BEACON = "e10b6f6b275de231345c20d14ab812db62151b00";
export const STOCK_CODE = { bytes: 283, head: "0x6080604052600a600c565b", beacon: STOCK_BEACON };
export const isStockCode = (code) => typeof code === "string" && (code.length - 2) / 2 === STOCK_CODE.bytes
  && code.startsWith(STOCK_CODE.head) && code.toLowerCase().includes(STOCK_BEACON);
/** The stock tokens' companion event, emitted beside every Transfer (measured: 30 of 30 emitters carry the stock bytecode). */
export const STOCK_EVENT = "0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802";

const MIN_DEGREE = 3;              // pools a token must anchor before it is worth a getCode call
const CATALOGUE_VERSION = 2;       // 2: entries carry the pool's initial sqrt price, the fallback valuation price for pools that never traded
const DAILY_TRACKED = [NVDA];      // tokens whose DEX inventory is rebuilt daily from transfers
const UNIVERSE_WINDOW = 9_000;     // blocks of the stock event scanned per run (~15 min); samples are unioned over a day
const SUPPLY_SEL = "0x18160ddd";
const BALANCE_SEL = "0x70a08231";
const EXCLUDE = new Set([AI, USDG, "0x0000000000000000000000000000000000000000"]);

/**
 * Daily inventory of one token inside the v4 PoolManager, from its Transfer logs.
 * Two filtered scans (to and from the manager), streamed chunk by chunk -- NVDA
 * alone has millions of them, and holding them all blew a 4 GB heap -- and
 * resumable from a cursor, so the first runs pay for the history in instalments
 * and every later run pays for a few hours.
 */
async function dexInventoryDaily(token, latest, tm, prior, opts) {
  const state = prior && prior.cursor ? { ...prior, byDay: { ...prior.byDay } } : { cursor: GENESIS_BLOCK - 1, byDay: {} };
  const from = Math.max(GENESIS_BLOCK, state.cursor + 1);
  if (from > latest) return state;
  const fold = (sign) => (logs) => {
    for (const l of logs) {
      const t = decodeTransfer(l);
      if (t.from === t.to) continue;                       // a manager-to-manager transfer is not inventory
      const d = tm.dayBucket(t.block); if (!d) continue;
      state.byDay[d] = (state.byDay[d] || 0) + sign * fmtUnits(t.value, opts.decimals ?? 18);
    }
  };
  /* The two scans must end at the same block or a day could hold inflows without
     its outflows. The first scan sets the reach; the second is bounded by it. */
  const inLogs = await getLogsRange({ address: token, topics: [TOPICS.TRANSFER, null, padAddr(POOL_MANAGER)] }, from, latest, { deadline: opts.deadline, onLogs: fold(1), chunk: 200_000 });
  const reach = inLogs.reachedBlock ?? latest;
  if (reach < from) { state.partial = true; return state; }
  const outLogs = await getLogsRange({ address: token, topics: [TOPICS.TRANSFER, padAddr(POOL_MANAGER), null] }, from, reach, { deadline: opts.deadline + 120_000, onLogs: fold(-1), chunk: 200_000 });
  if (outLogs.truncated) {
    /* Out-scan cut short: roll the days past its reach back out of the in-scan too
       by recomputing from the prior state. Simplest correct move: keep the prior
       cursor and byDay and try again next run with a fresh budget. */
    return prior && prior.cursor ? { ...prior, partial: true } : { cursor: GENESIS_BLOCK - 1, byDay: {}, partial: true };
  }
  state.cursor = reach;
  state.partial = !!inLogs.truncated;
  return state;
}

/**
 * Every v4 pool that quotes a given stock token, whatever hook it carries, with
 * which side the stock sits on. Initialize indexes both currencies, so this is two
 * filtered scans per token, append-only and resumed from a cursor.
 */
async function stockPools(token, latest, prior, opts) {
  const state = prior && prior.cursor ? { cursor: prior.cursor, pools: [...prior.pools] } : { cursor: GENESIS_BLOCK - 1, pools: [] };
  const from = Math.max(GENESIS_BLOCK, state.cursor + 1);
  if (from > latest) return state;
  const asC0 = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, padAddr(token)] }, from, latest, { chunk: 25_000_000, deadline: opts.deadline });
  const asC1 = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, null, padAddr(token)] }, from, latest, { chunk: 25_000_000, deadline: opts.deadline });
  const reached = Math.min(asC0.reachedBlock ?? latest, asC1.reachedBlock ?? latest);
  const seen = new Set(state.pools.map((p) => p.id));
  for (const l of [...asC0, ...asC1]) {
    if (parseInt(l.blockNumber, 16) > reached) continue;
    const p = decodeInitialize(l);
    if (seen.has(p.poolId)) continue;
    seen.add(p.poolId);
    /* Kept small: NVDA alone quotes ten thousand pools. */
    state.pools.push({ id: p.poolId, long: p.hooks === LONG_HOOK, ai: p.currency0 === AI || p.currency1 === AI, side: p.currency0 === token ? 0 : 1, p0: p.sqrtPriceX96.toString() });
  }
  state.cursor = reached;
  state.partial = !!(asC0.truncated || asC1.truncated);
  state.v = CATALOGUE_VERSION;
  return state;
}

/**
 * Which stock tokens moved on the chain lately, from the stock tokens' own
 * transfer event across every address. One short window per run, unioned over
 * the trailing day in the store, so the universe the capture is measured against
 * is every stock token that is actually in use, not only the ones LONG lists.
 */
async function universeSample(latest, store, deadline) {
  const st = (store && store.get("rwaUniverse")) || { samples: [] };
  const from = Math.max(GENESIS_BLOCK, latest - UNIVERSE_WINDOW + 1);
  const counts = {};
  const logs = await getLogsRange({ topics: [STOCK_EVENT] }, from, latest, { chunk: 1_500, deadline, onLogs: (ls) => { for (const l of ls) counts[l.address] = (counts[l.address] || 0) + 1; } });
  const now = Math.floor(Date.now() / 1000);
  st.samples = [...st.samples.filter((s) => now - s.t < 86400), { t: now, from, to: logs.reachedBlock ?? latest, partial: !!logs.truncated, tokens: counts }];
  if (store) store.set("rwaUniverse", st);
  const union = {};
  let blocks = 0;
  for (const s of st.samples) { blocks += (s.to - s.from + 1); for (const [a, n] of Object.entries(s.tokens)) union[a] = (union[a] || 0) + n; }
  return { active: union, samples: st.samples.length, blocksSampled: blocks, partial: !!logs.truncated };
}

/**
 * @param latest   head block
 * @param tm       time map
 * @param opts     { store, pools (LONG census: {id,c0,c1,block}), symbols, decimals, anchorUsd (Map token→usd),
 *                   swaps ({ counts: Map poolId→n, volume: Map poolId→[bigint,bigint], blocks, total, truncated }),
 *                   prior (last rwa.json), deadline, log }
 */
export async function indexRwa(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store;
  const pools = opts.pools || [];
  const symbols = new Map(opts.symbols || []);
  const decimals = new Map(opts.decimals || []);
  const anchorUsd = opts.anchorUsd || new Map();
  const sym = (a) => symbols.get(a) || a.slice(0, 8);
  const timeLeft = () => !opts.deadline || Date.now() < opts.deadline;
  const secs = (t) => `${((Date.now() - t) / 1000).toFixed(0)}s`;

  /* 1. The universe: stock tokens that moved on the chain lately, plus anything
        that anchors a few LONG pools. Classified once by bytecode and remembered. */
  const t0 = Date.now();
  const uni = await universeSample(latest, store, Date.now() + 90_000);
  log(`  stock-event scan: ${Object.keys(uni.active).length} tokens active over ${uni.samples} sample(s), ${uni.blocksSampled.toLocaleString()} blocks, ${secs(t0)}`);
  const degree = new Map(), withAi = new Map();
  for (const p of pools) {
    for (const t of [p.c0, p.c1]) degree.set(t, (degree.get(t) || 0) + 1);
    if (p.c0 === AI) withAi.set(p.c1, (withAi.get(p.c1) || 0) + 1);
    if (p.c1 === AI) withAi.set(p.c0, (withAi.get(p.c0) || 0) + 1);
  }
  const codeCache = (store && store.get("rwaCode")) || {};
  const candidates = [...new Set([
    ...[...degree].filter(([a, n]) => n >= MIN_DEGREE).map(([a]) => a),
    ...Object.keys(uni.active),
  ])].filter((a) => !EXCLUDE.has(a));
  let looked = 0;
  for (const a of candidates) {
    if (codeCache[a] != null) continue;
    if (!timeLeft()) break;
    try { codeCache[a] = isStockCode(await rpc("eth_getCode", [a, "latest"])); looked++; } catch { /* left unknown; retried next run */ }
  }
  if (store) store.set("rwaCode", codeCache);
  const stocks = candidates.filter((a) => codeCache[a] === true);
  const unlisted = stocks.filter((a) => !(degree.get(a) > 0));
  if (unlisted.length) {
    const meta = await resolveTokens(unlisted.filter((a) => !symbols.has(a)), { log: () => {} });
    for (const [a, m] of meta) { if (m.symbol) symbols.set(a, m.symbol); if (m.decimals != null) decimals.set(a, m.decimals); }
  }
  log(`  ${candidates.length} candidate tokens, ${looked} newly classified, ${stocks.length} are Robinhood stock tokens by bytecode (${unlisted.length} with no LONG pool)`);

  /* 2. Supply on chain, inventory in the pool manager, balance in the vault,
        through Multicall3 (four hundred separate calls tripped the throttle). */
  const t1 = Date.now();
  const calls = [];
  for (const a of stocks) {
    calls.push({ to: a, data: SUPPLY_SEL });
    calls.push({ to: a, data: BALANCE_SEL + POOL_MANAGER.slice(2).padStart(64, "0") });
    calls.push({ to: a, data: BALANCE_SEL + COMMUNITY_VAULT.slice(2).padStart(64, "0") });
  }
  const res = await multicall(calls);
  const num = (h, dec) => (h && h !== "0x" ? fmtUnits(BigInt(h), dec) : null);
  const dexRaw = (a) => { const i = stocks.indexOf(a); const h = res[i * 3 + 1]; return h && h !== "0x" ? BigInt(h) : 0n; };
  log(`  supply and inventory for ${stocks.length} tokens read in ${secs(t1)}`);

  /* 3. Every pool quoting each stock, LONG-hooked or not, for the trading share.
        Biggest inventory first, resumable per token. */
  const poolState = (store && store.get("rwaPools")) || {};
  const t2 = Date.now();
  let catalogued = 0;
  const byDex = [...stocks].sort((x, y) => (dexRaw(y) > dexRaw(x) ? 1 : dexRaw(y) < dexRaw(x) ? -1 : 0));
  for (const a of byDex) {
    if (!timeLeft()) break;
    const prior = poolState[a]?.v === CATALOGUE_VERSION ? poolState[a] : null;   // older entries lack p0; rebuild once
    poolState[a] = await stockPools(a, latest, prior, { deadline: opts.deadline });
    if (!poolState[a].partial) catalogued++;
  }
  if (store) store.set("rwaPools", poolState);
  const allStockPools = new Map();   // poolId → { long, ai, p0, stocks: [{token, side}] }
  for (const a of stocks) for (const p of poolState[a]?.pools || []) {
    const e = allStockPools.get(p.id) || { long: p.long, ai: p.ai, p0: p.p0, stocks: [] };
    e.stocks.push({ token: a, side: p.side }); allStockPools.set(p.id, e);
  }
  log(`  pool catalogue: ${allStockPools.size.toLocaleString()} pools quote a stock token (${catalogued} of ${stocks.length} tokens complete), ${secs(t2)}`);

  const tokens = [];
  stocks.forEach((a, i) => {
    const dec = decimals.get(a) ?? 18;
    const supply = num(res[i * 3], dec), inDex = num(res[i * 3 + 1], dec), inVault = num(res[i * 3 + 2], dec);
    if (!(supply > 0)) return;
    const usd = anchorUsd.get(a) ?? null;
    const mine = poolState[a]?.pools || [];
    tokens.push({
      token: a, symbol: sym(a), decimals: dec,
      listed: (degree.get(a) || 0) > 0,
      activeTransfers: uni.active[a] || 0,
      supply, inDex, inVault,
      share: (inDex + inVault) / supply, dexShare: inDex / supply, vaultShare: inVault / supply,
      priceUsd: usd, supplyUsd: usd ? supply * usd : null, dexUsd: usd ? inDex * usd : null, vaultUsd: usd ? inVault * usd : null,
      longPools: degree.get(a) || 0, aiPools: withAi.get(a) || 0,
      poolsAll: mine.length, poolsLong: mine.filter((p) => p.long).length,
      poolsPartial: !poolState[a] || !!poolState[a].partial,
    });
  });
  tokens.sort((a, b) => (b.dexUsd ?? 0) - (a.dexUsd ?? 0) || b.longPools - a.longPools);

  /* 4. Trading share in the window: swaps whose pool holds a stock token, split by
        whether the pool carries the LONG hook. By count, and by the dollar value
        of the stock leg where the stock has a price. */
  let swapShare = null;
  if (opts.swaps?.counts && allStockPools.size) {
    const per = new Map();   // token → { all, long, usdAll, usdLong }
    let all = 0, long = 0, aiPaired = 0, usdAll = 0, usdLong = 0;
    for (const [id, n] of opts.swaps.counts) {
      const e = allStockPools.get(id); if (!e) continue;
      all += n; if (e.long) long += n;
      if (e.long && e.ai) aiPaired += n;
      const vol = opts.swaps.volume?.get(id);
      /* Dollar value of the pool's stock leg, from the first priced stock on it. */
      let usd = 0;
      for (const { token, side } of e.stocks) {
        const px = anchorUsd.get(token); if (!px || !vol) continue;
        usd = fmtUnits(vol[side], decimals.get(token) ?? 18) * px; break;
      }
      usdAll += usd; if (e.long) usdLong += usd;
      for (const { token } of e.stocks) {
        const r = per.get(token) || { all: 0, long: 0, usdAll: 0, usdLong: 0 };
        r.all += n; r.usdAll += usd; if (e.long) { r.long += n; r.usdLong += usd; } per.set(token, r);
      }
    }
    swapShare = {
      windowBlocks: opts.swaps.blocks, windowHours: +((opts.swaps.blocks / 845_649) * 24).toFixed(1),
      catalogueComplete: catalogued === stocks.length,
      truncated: !!opts.swaps.truncated, chainSwaps: opts.swaps.total ?? null,
      stockSwaps: all, longSwaps: long, aiPairedSwaps: aiPaired, share: all > 0 ? long / all : null,
      usdAll: Math.round(usdAll), usdLong: Math.round(usdLong), usdShare: usdAll > 0 ? usdLong / usdAll : null,
      perToken: [...per].map(([t, r]) => ({ token: t, symbol: sym(t), all: r.all, long: r.long, share: r.all ? r.long / r.all : null,
        usdAll: Math.round(r.usdAll), usdLong: Math.round(r.usdLong) })).sort((x, y) => y.usdAll - x.usdAll || y.all - x.all),
    };
    log(`  stock-token swaps in window: ${all.toLocaleString()}, ${long.toLocaleString()} through LONG pools (${all ? (100 * long / all).toFixed(1) : "—"}% by count, ${usdAll ? (100 * usdLong / usdAll).toFixed(1) : "—"}% by dollars)`);
  }

  /* 4b. Stock inventory inside LONG's own pools, for EVERY LONG stock pool.
        The pool manager's balance mixes every venue, and the singleton keeps no
        per-pool balance, so each pool's position ladder is rebuilt from the
        ModifyLiquidity tape. Not pool by pool -- forty thousand pools would be a
        hundred thousand queries -- but from ONE stream of every ModifyLiquidity
        the manager ever emitted, keeping only the pools in the stock catalogue,
        resumed from a cursor. The first pass is long (the hook re-adds liquidity
        on every swap in its compounding mode, so the tape is hundreds of
        thousands of events a day) and is allowed to span several runs; after it,
        a run reads a few hours. Each pool is valued at its last swap price seen
        by the census scans (kept as a map across runs), or at its initial price
        if it has never traded -- a pool that never traded holds no stock anyway,
        since launches seed the launched token alone. */
  let longTvl = null;
  if (allStockPools.size) {
    const t4 = Date.now();
    const longIds = new Set([...allStockPools].filter(([, e]) => e.long).map(([id]) => id));
    let LS = store && store.get("rwaLadderStream");
    if (!LS || LS.v !== 1) LS = { v: 1, cursor: GENESIS_BLOCK - 1, ladders: {}, lastSqrt: {}, events: 0 };
    /* Prices: the newest Swap per pool from this run's census window, layered over the map. */
    if (opts.swaps?.last) for (const [id, l] of opts.swaps.last) if (longIds.has(id)) LS.lastSqrt[id] = decodeSwap(l).sqrtPriceX96.toString();
    const from = LS.cursor + 1;
    let seen = 0;
    if (from <= latest && timeLeft()) {
      const r = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.MODIFY_LIQUIDITY] }, from, latest, {
        chunk: 200_000, deadline: opts.deadline,
        onLogs: (logs) => {
          for (const l of logs) {
            const id = l.topics[1]; if (!longIds.has(id)) continue;
            const m = decodeModifyLiquidity(l);
            const lad = (LS.ladders[id] ||= {});
            lad[m.tickLower] = (BigInt(lad[m.tickLower] || 0) + m.liquidityDelta).toString();
            lad[m.tickUpper] = (BigInt(lad[m.tickUpper] || 0) - m.liquidityDelta).toString();
            seen++;
          }
        },
      });
      LS.cursor = r.reachedBlock ?? latest;
      LS.partial = !!r.truncated;
      LS.events += seen;
      /* Ticks that net to zero are closed positions; dropping them keeps the store small. */
      for (const [id, lad] of Object.entries(LS.ladders)) { for (const [t, v] of Object.entries(lad)) if (v === "0") delete lad[t]; if (!Object.keys(lad).length) delete LS.ladders[id]; }
    }
    if (store) store.set("rwaLadderStream", LS);

    const perToken = {};
    let usd = 0, valued = 0, unpriced = 0, withLiquidity = 0;
    for (const [id, lad] of Object.entries(LS.ladders)) {
      const e = allStockPools.get(id); if (!e) continue;
      withLiquidity++;
      const sq = LS.lastSqrt[id] ?? e.p0; if (!sq) { unpriced++; continue; }
      const sqrtP = Number(BigInt(sq)) / 2 ** 96; if (!(sqrtP > 0)) { unpriced++; continue; }
      const { a0, a1 } = ladderRawAmounts(lad, sqrtP);
      let counted = false;
      for (const { token, side } of e.stocks) {
        const amt = (side === 0 ? a0 : a1) / 10 ** (decimals.get(token) ?? 18);
        const px = anchorUsd.get(token); if (!px || !(amt > 0)) continue;
        usd += amt * px; perToken[sym(token)] = (perToken[sym(token)] || 0) + amt * px; counted = true;
      }
      if (counted) valued++;
    }
    const span = latest - GENESIS_BLOCK + 1;
    longTvl = {
      usd: Math.round(usd),
      pools: valued, poolsWithLiquidity: withLiquidity, poolsUnpriced: unpriced, longStockPools: longIds.size,
      backfilledTo: LS.cursor, complete: !LS.partial && LS.cursor >= latest, backfillShare: Math.min(1, (LS.cursor - GENESIS_BLOCK + 1) / span),
      events: LS.events,
      perToken: Object.fromEntries(Object.entries(perToken).map(([k, v]) => [k, Math.round(v)]).sort((a, b) => b[1] - a[1])),
    };
    log(`  stock inventory in LONG pools: $${Math.round(usd).toLocaleString()} across ${valued} pools with stock (${withLiquidity} with liquidity of ${longIds.size} LONG stock pools); ladder stream at block ${LS.cursor.toLocaleString()} (${(100 * longTvl.backfillShare).toFixed(1)}% of history${LS.partial ? ", resumes" : ""}), ${seen.toLocaleString()} events this run, ${secs(t4)}`);
  }

  /* 5. Totals over the priced set only: an unpriced token contributes no dollars,
        and mixing a token count with a dollar share would be meaningless. */
  const priced = tokens.filter((t) => t.priceUsd);
  const totals = {
    stocks: tokens.length, priced: priced.length, listed: tokens.filter((t) => t.listed).length,
    activeStocks: tokens.filter((t) => t.activeTransfers > 0).length,
    activeListed: tokens.filter((t) => t.activeTransfers > 0 && t.listed).length,
    supplyUsd: priced.reduce((s, t) => s + t.supplyUsd, 0),
    dexUsd: priced.reduce((s, t) => s + t.dexUsd, 0),
    vaultUsd: priced.reduce((s, t) => s + t.vaultUsd, 0),
    poolsAll: allStockPools.size,
    poolsLong: [...allStockPools.values()].filter((p) => p.long).length,
    cataloguePartial: tokens.some((t) => t.poolsPartial),
  };
  totals.share = totals.supplyUsd > 0 ? (totals.dexUsd + totals.vaultUsd) / totals.supplyUsd : null;
  totals.longUsd = longTvl ? longTvl.usd : null;
  totals.longShare = longTvl && totals.supplyUsd > 0 ? (longTvl.usd + totals.vaultUsd) / totals.supplyUsd : null;

  /* 6. Daily DEX inventory for the tracked stock, from transfers, so the trend
        exists from genesis rather than from today. Last, with whatever budget is
        left; it resumes. */
  const daily = {};
  const dexState = (store && store.get("rwaDex")) || {};
  for (const tok of DAILY_TRACKED) {
    if (!timeLeft()) { log(`  ${sym(tok)} DEX inventory: no budget left this run`); break; }
    const t3 = Date.now();
    const st = await dexInventoryDaily(tok, latest, tm, dexState[tok], { deadline: opts.deadline, decimals: decimals.get(tok) ?? 18 });
    dexState[tok] = st;
    let cum = 0;
    daily[tok] = Object.entries(st.byDay).map(([d, v]) => [Number(d), v]).sort((a, b) => a[0] - b[0])
      .map(([t, net]) => ({ t, net: +net.toFixed(4), cum: +(cum += net).toFixed(4) }));
    log(`  ${sym(tok)} DEX inventory: ${daily[tok].length} day(s) to block ${st.cursor.toLocaleString()}${st.partial ? " (budget; resumes next run)" : ""}, ${secs(t3)}`);
  }
  if (store) store.set("rwaDex", dexState);

  /* 7. History: one row per hour at most, 120 days deep. */
  const stamp = Math.floor(Date.now() / 1000);
  const hour = Math.floor(stamp / 3600) * 3600;
  const history = (opts.prior?.history || []).filter((h) => h.t !== hour).slice(-24 * 120);
  history.push({
    t: hour, share: totals.share, dexUsd: Math.round(totals.dexUsd), vaultUsd: Math.round(totals.vaultUsd), supplyUsd: Math.round(totals.supplyUsd),
    longUsd: totals.longUsd, longShare: totals.longShare,
    swapShare: swapShare?.share ?? null, usdShare: swapShare?.usdShare ?? null, stockSwaps: swapShare?.stockSwaps ?? null, longSwaps: swapShare?.longSwaps ?? null,
    activeStocks: totals.activeStocks, activeListed: totals.activeListed,
    perToken: Object.fromEntries(tokens.map((t) => [t.symbol, [+t.supply.toFixed(2), +t.inDex.toFixed(2), +t.inVault.toFixed(2)]])),
  });
  history.sort((a, b) => a.t - b.t);

  return {
    updatedAt: stamp,
    classifier: { ...STOCK_CODE, event: STOCK_EVENT, note: "Robinhood tokenized-stock beacon proxy: same bytecode and beacon as NVDA; emits the stock transfer event" },
    minDegree: MIN_DEGREE,
    universe: { activeTokens: Object.keys(uni.active).length, samples: uni.samples, blocksSampled: uni.blocksSampled, partial: uni.partial },
    tokens, totals, swapShare, longTvl, history,
    dailyTracked: Object.fromEntries(DAILY_TRACKED.map((t) => [t, sym(t)])),
    daily,
    dailyPartial: Object.fromEntries(DAILY_TRACKED.map((t) => [t, !!dexState[t]?.partial])),
  };
}
