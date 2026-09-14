import { rpc, getLogsRange, padAddr } from "../rpc.mjs";
import { POOL_MANAGER, COMMUNITY_VAULT, LONG_HOOK, AI, USDG, NVDA, GENESIS_BLOCK } from "../config.mjs";
import { TOPICS, decodeTransfer, decodeInitialize, fmtUnits } from "../decode.mjs";
import { multicall } from "../tokens.mjs";

/**
 * The real-world-asset ledger: how much of Robinhood Chain's tokenized stock
 * supply, and of its tokenized stock trading, the LONG ecosystem has captured.
 *
 * The thesis being measured is LONG's own: be the liquidity layer for tokenized
 * equities on this chain. Two measures follow from it. Share of supply -- of every
 * NVDA token that exists on Robinhood Chain, what fraction sits inside DEX
 * liquidity or the community vault. Share of trading -- of every swap on the chain
 * that touches a stock token, what fraction goes through a pool carrying the LONG
 * hook. Neither can be manufactured by a price move.
 *
 * Stock tokens are identified by bytecode, not by name. Robinhood's tokenized
 * equities are all deployed from one proxy template (283 bytes, identical prefix);
 * NVDA, DELL, ORCL and SPCX match it, a memecoin calling itself HOOD does not.
 * Names are attacker-controlled on a launchpad; bytecode is not.
 */
export const STOCK_CODE = { bytes: 283, head: "0x6080604052600a600c565b" };
export const isStockCode = (code) => typeof code === "string" && (code.length - 2) / 2 === STOCK_CODE.bytes && code.startsWith(STOCK_CODE.head);

const MIN_DEGREE = 3;              // pools a token must anchor before it is worth a getCode call
const DAILY_TRACKED = [NVDA];      // tokens whose DEX inventory is rebuilt daily from transfers
const SUPPLY_SEL = "0x18160ddd";
const BALANCE_SEL = "0x70a08231";
const EXCLUDE = new Set([AI, USDG, "0x0000000000000000000000000000000000000000"]);

/**
 * Daily inventory of one token inside the v4 PoolManager, from its Transfer logs.
 * Two filtered scans (to and from the manager), resumable from a cursor, so the
 * first run pays for the history and every later run pays for a few hours.
 */
async function dexInventoryDaily(token, latest, tm, prior, opts) {
  const state = prior && prior.cursor ? { ...prior, byDay: { ...prior.byDay } } : { cursor: GENESIS_BLOCK - 1, byDay: {} };
  const from = Math.max(GENESIS_BLOCK, state.cursor + 1);
  if (from > latest) return state;
  const inLogs = await getLogsRange({ address: token, topics: [TOPICS.TRANSFER, null, padAddr(POOL_MANAGER)] }, from, latest, { deadline: opts.deadline });
  const outLogs = await getLogsRange({ address: token, topics: [TOPICS.TRANSFER, padAddr(POOL_MANAGER), null] }, from, latest, { deadline: opts.deadline });
  const reached = Math.min(inLogs.reachedBlock ?? latest, outLogs.reachedBlock ?? latest);
  for (const [logs, sign] of [[inLogs, 1], [outLogs, -1]]) {
    for (const l of logs) {
      const b = parseInt(l.blockNumber, 16); if (b > reached) continue;
      const t = decodeTransfer(l);
      if (t.from === t.to) continue;                       // a manager-to-manager transfer is not inventory
      const d = tm.dayBucket(b); if (!d) continue;
      state.byDay[d] = (state.byDay[d] || 0) + sign * fmtUnits(t.value, opts.decimals ?? 18);
    }
  }
  state.cursor = reached;
  state.partial = !!(inLogs.truncated || outLogs.truncated);
  return state;
}

/**
 * Every v4 pool that quotes a given stock token, whatever hook it carries.
 * Initialize indexes both currencies, so this is two filtered scans per token,
 * append-only and resumed from a cursor. It is what lets "swaps that touch LONG
 * liquidity" be a share of ALL stock-token swaps rather than of the ones we knew.
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
    /* Kept small: NVDA alone quotes ten thousand pools. Whether the pool is LONG's
       and whether AI is on the other side are the only two facts the share needs. */
    state.pools.push({ id: p.poolId, long: p.hooks === LONG_HOOK, ai: p.currency0 === AI || p.currency1 === AI });
  }
  state.cursor = reached;
  state.partial = !!(asC0.truncated || asC1.truncated);
  return state;
}

/**
 * @param latest   head block
 * @param tm       time map
 * @param opts     { store, pools (LONG census: {id,c0,c1,block}), symbols, decimals, anchorUsd (Map token→usd),
 *                   swaps ({ counts: Map poolId→n, blocks, truncated } from a Swap scan), prior (last rwa.json),
 *                   deadline, log }
 */
export async function indexRwa(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store;
  const pools = opts.pools || [];
  const symbols = opts.symbols || new Map();
  const decimals = opts.decimals || new Map();
  const anchorUsd = opts.anchorUsd || new Map();
  const sym = (a) => symbols.get(a) || a.slice(0, 8);

  /* 1. Candidates: anything that anchors a few LONG pools. Classified once by
        bytecode and remembered, so a run only pays getCode for new tokens. */
  const degree = new Map(), withAi = new Map();
  for (const p of pools) {
    for (const t of [p.c0, p.c1]) degree.set(t, (degree.get(t) || 0) + 1);
    if (p.c0 === AI) withAi.set(p.c1, (withAi.get(p.c1) || 0) + 1);
    if (p.c1 === AI) withAi.set(p.c0, (withAi.get(p.c0) || 0) + 1);
  }
  const codeCache = (store && store.get("rwaCode")) || {};
  const candidates = [...degree].filter(([a, n]) => n >= MIN_DEGREE && !EXCLUDE.has(a)).map(([a]) => a);
  let looked = 0;
  for (const a of candidates) {
    if (codeCache[a] != null) continue;
    if (opts.deadline && Date.now() > opts.deadline) break;
    try { codeCache[a] = isStockCode(await rpc("eth_getCode", [a, "latest"])); looked++; } catch { /* left unknown; retried next run */ }
  }
  if (store) store.set("rwaCode", codeCache);
  const stocks = candidates.filter((a) => codeCache[a] === true);
  log(`  ${candidates.length} anchor tokens, ${looked} newly classified, ${stocks.length} are Robinhood stock tokens by bytecode`);

  /* 2. Supply on chain, inventory in the pool manager, balance in the vault.
        Through Multicall3: four hundred separate eth_calls tripped the provider's
        throttle and took seven minutes; three aggregate calls take seconds. */
  const t0 = Date.now();
  const calls = [];
  for (const a of stocks) {
    calls.push({ to: a, data: SUPPLY_SEL });
    calls.push({ to: a, data: BALANCE_SEL + POOL_MANAGER.slice(2).padStart(64, "0") });
    calls.push({ to: a, data: BALANCE_SEL + COMMUNITY_VAULT.slice(2).padStart(64, "0") });
  }
  const res = await multicall(calls);
  const num = (h, dec) => (h && h !== "0x" ? fmtUnits(BigInt(h), dec) : null);
  log(`  supply and inventory for ${stocks.length} tokens read in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /* 3. Daily DEX inventory for the tracked stock, from transfers, so the trend
        exists from genesis rather than from today. Before the pool catalogue,
        because one series that reaches genesis is worth more than a catalogue
        that half-finished. */
  const daily = {};
  const dexState = (store && store.get("rwaDex")) || {};
  for (const tok of DAILY_TRACKED) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const t1 = Date.now();
    const st = await dexInventoryDaily(tok, latest, tm, dexState[tok], { deadline: opts.deadline, decimals: decimals.get(tok) ?? 18 });
    dexState[tok] = st;
    let cum = 0;
    daily[tok] = Object.entries(st.byDay).map(([d, v]) => [Number(d), v]).sort((a, b) => a[0] - b[0])
      .map(([t, net]) => ({ t, net: +net.toFixed(4), cum: +(cum += net).toFixed(4) }));
    log(`  ${sym(tok)} DEX inventory: ${daily[tok].length} day(s) to block ${st.cursor.toLocaleString()}${st.partial ? " (budget; resumes next run)" : ""}, ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  }
  if (store) store.set("rwaDex", dexState);

  /* 4. Every pool quoting each stock, LONG-hooked or not, for the trading share.
        Resumable per token; a run that runs out of budget finishes the rest next time. */
  const poolState = (store && store.get("rwaPools")) || {};
  const allStockPools = new Map();   // poolId → { long, ai, stocks }
  let catalogued = 0;
  const t2 = Date.now();
  /* Biggest first, so a run that cannot finish the list has covered the tokens
     that carry the trading. */
  const byDex = [...stocks].sort((x, y) => (res[stocks.indexOf(y) * 3 + 1] ? Number(BigInt(res[stocks.indexOf(y) * 3 + 1])) : 0) - (res[stocks.indexOf(x) * 3 + 1] ? Number(BigInt(res[stocks.indexOf(x) * 3 + 1])) : 0));
  for (const a of byDex) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    poolState[a] = await stockPools(a, latest, poolState[a], { deadline: opts.deadline });
    if (!poolState[a].partial) catalogued++;
  }
  log(`  pool catalogue took ${((Date.now() - t2) / 1000).toFixed(0)}s`);
  for (const a of stocks) for (const p of poolState[a]?.pools || []) {
    const e = allStockPools.get(p.id) || { long: p.long, ai: p.ai, stocks: new Set() };
    e.stocks.add(a); allStockPools.set(p.id, e);
  }
  if (store) store.set("rwaPools", poolState);
  log(`  pool catalogue: ${allStockPools.size.toLocaleString()} pools quote a stock token (${catalogued} of ${stocks.length} tokens scanned this run)`);

  const tokens = [];
  stocks.forEach((a, i) => {
    const dec = decimals.get(a) ?? 18;
    const supply = num(res[i * 3], dec), inDex = num(res[i * 3 + 1], dec), inVault = num(res[i * 3 + 2], dec);
    if (!(supply > 0)) return;
    const usd = anchorUsd.get(a) ?? null;
    const mine = poolState[a]?.pools || [];
    tokens.push({
      token: a, symbol: sym(a), decimals: dec,
      supply, inDex, inVault,
      share: (inDex + inVault) / supply, dexShare: inDex / supply, vaultShare: inVault / supply,
      priceUsd: usd, supplyUsd: usd ? supply * usd : null, dexUsd: usd ? inDex * usd : null, vaultUsd: usd ? inVault * usd : null,
      longPools: degree.get(a) || 0, aiPools: withAi.get(a) || 0,
      poolsAll: mine.length, poolsLong: mine.filter((p) => p.long).length,
      poolsPartial: !poolState[a] || !!poolState[a].partial,
    });
  });
  tokens.sort((a, b) => (b.dexUsd ?? 0) - (a.dexUsd ?? 0) || b.longPools - a.longPools);

  /* 4. Trading share: swaps in the window that touched a stock token, split by
        whether the pool carries the LONG hook. Counts, not volume, because a
        count needs no price and cannot be inflated by one whale. */
  let swapShare = null;
  if (opts.swaps?.counts && allStockPools.size) {
    const per = new Map();   // token → { all, long }
    let all = 0, long = 0, aiPaired = 0;
    for (const [id, n] of opts.swaps.counts) {
      const e = allStockPools.get(id); if (!e) continue;
      all += n; if (e.long) long += n;
      if (e.long && e.ai) aiPaired += n;
      for (const t of e.stocks) { const r = per.get(t) || { all: 0, long: 0 }; r.all += n; if (e.long) r.long += n; per.set(t, r); }
    }
    swapShare = {
      windowBlocks: opts.swaps.blocks, windowHours: +((opts.swaps.blocks / 845_649) * 24).toFixed(1),
      catalogueComplete: catalogued === stocks.length && stocks.every((a) => !poolState[a]?.partial),
      truncated: !!opts.swaps.truncated, chainSwaps: opts.swaps.total ?? null,
      stockSwaps: all, longSwaps: long, aiPairedSwaps: aiPaired, share: all > 0 ? long / all : null,
      perToken: [...per].map(([t, r]) => ({ token: t, symbol: sym(t), all: r.all, long: r.long, share: r.all ? r.long / r.all : null })).sort((x, y) => y.all - x.all),
    };
    log(`  stock-token swaps in window: ${all.toLocaleString()}, ${long.toLocaleString()} through LONG pools (${all ? (100 * long / all).toFixed(1) : "—"}%)`);
  }

  /* 5. Totals over the priced set only: an unpriced token contributes no dollars,
        and mixing a token count with a dollar share would be meaningless. */
  const priced = tokens.filter((t) => t.priceUsd);
  const totals = {
    stocks: tokens.length, priced: priced.length,
    supplyUsd: priced.reduce((s, t) => s + t.supplyUsd, 0),
    dexUsd: priced.reduce((s, t) => s + t.dexUsd, 0),
    vaultUsd: priced.reduce((s, t) => s + t.vaultUsd, 0),
    // Distinct pools: a pool quoting two stocks against each other counts once.
    poolsAll: allStockPools.size,
    poolsLong: [...allStockPools.values()].filter((p) => p.long).length,
    cataloguePartial: tokens.some((t) => t.poolsPartial),
  };
  totals.share = totals.supplyUsd > 0 ? (totals.dexUsd + totals.vaultUsd) / totals.supplyUsd : null;

  /* 6. History: one row per hour at most, 120 days deep. */
  const stamp = Math.floor(Date.now() / 1000);
  const hour = Math.floor(stamp / 3600) * 3600;
  const history = (opts.prior?.history || []).filter((h) => h.t !== hour).slice(-24 * 120);
  history.push({
    t: hour, share: totals.share, dexUsd: Math.round(totals.dexUsd), vaultUsd: Math.round(totals.vaultUsd), supplyUsd: Math.round(totals.supplyUsd),
    swapShare: swapShare?.share ?? null, stockSwaps: swapShare?.stockSwaps ?? null, longSwaps: swapShare?.longSwaps ?? null,
    perToken: Object.fromEntries(tokens.map((t) => [t.symbol, [+t.supply.toFixed(2), +t.inDex.toFixed(2), +t.inVault.toFixed(2)]])),
  });
  history.sort((a, b) => a.t - b.t);

  return {
    updatedAt: stamp,
    classifier: { ...STOCK_CODE, note: "Robinhood tokenized-stock proxy: same bytecode length and prefix as NVDA" },
    minDegree: MIN_DEGREE,
    tokens, totals, swapShare, history,
    dailyTracked: Object.fromEntries(DAILY_TRACKED.map((t) => [t, sym(t)])),
    daily,
    dailyPartial: Object.fromEntries(DAILY_TRACKED.map((t) => [t, !!dexState[t]?.partial])),
  };
}
