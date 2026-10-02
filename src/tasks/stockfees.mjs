import { multicall } from "../tokens.mjs";
import { getLogsRange } from "../rpc.mjs";
import { keccak256, selector } from "../keccak.mjs";
import { LONG_HOOK, POOL_MANAGER, USDG, AI, BLOCKS_PER_DAY } from "../config.mjs";

/* TRADING FEES BY STOCK TOKEN, ALL TIME AND 24H.

   Where the numbers come from. LONG's hook is a verified Doppler contract
   (DopplerHookInitializer). Every time it collects the fees its own liquidity has
   earned in a pool it emits Collect(poolId, fees0, fees1) and adds them to a running
   total, getCumulatedFees0/1(poolId). So:
     - all time = that running total, read per pool;
     - 24h      = the sum of Collect events in the last 24 hours.
   Both are the protocol's own accounting, not a reconstruction. Both count fees
   when the hook collects them, which on an active pool is several times a day
   (AI/NVDA and MOO/MU each collected ten times in the 24h to 1 Oct 2026); fees
   accrued since a pool's last collect are not yet in either. Fees earned by outside
   LPs are never in them, so these are floors.

   (Two other routes were tried and rejected. Tracing the fee legs: the buyback
   contract forwards most legs as the launched token, and the hook's leg was 67-100%
   of the buyback's, not a fixed share. Differencing the counter over time: it moves
   only on a collect, so a short window reads zero while swaps pay 0.7%.)

   By stock: in a pool pairing a stock with anything else, the stock-side fees are
   that stock's, and the other side's fees are valued at the pool's current price
   and credited to the same stock. A pool of two stocks credits each side to its own
   stock. Values are at today's prices, so fees paid in a launched token that has
   since fallen count at what that token is worth now.

   Cost. 57,907 LONG pools have a stock side, most of them dead launches. Every pool's
   total is read once (Multicall3, resumable, busiest first); after that a run
   re-reads only the pools that collected since the last run, and every pool with
   fees once a day. */

const STATE_V = 3;   // 3: seven days of collects, for the fee APR
const COLLECT = keccak256("Collect(bytes32,uint256,uint256)");
const SEL = {
  f0: selector("getCumulatedFees0(bytes32)"),
  f1: selector("getCumulatedFees1(bytes32)"),
  extsload: selector("extsload(bytes32)"),
};
const W = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const slot0Of = (poolId) => "0x" + W(BigInt(keccak256("0x" + poolId.slice(2) + W(6))));
const DAY = 86_400, WEEK = 7 * DAY;

export async function indexStockFees(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const deadline = opts.deadline || Infinity;
  const stocks = opts.stocks || new Map();        // stock token -> { symbol, decimals, priceUsd }
  const aiUsd = opts.aiUsd ?? null;
  const nowT = tm.at(latest) ?? Math.floor(Date.now() / 1000);
  const usdg = USDG.toLowerCase(), ai = AI.toLowerCase();
  const decOf = (a) => (a === usdg ? 6 : stocks.get(a)?.decimals ?? 18);

  const S = opts.state?.v === STATE_V ? structuredClone(opts.state)
    : { v: STATE_V, pools: {}, lastFull: 0, colCursor: latest - Math.ceil(7.05 * BLOCKS_PER_DAY), colFrom: null, collects: [] };
  /* when the collect record starts: the APR annualises over what it actually covers */
  S.colFrom ??= tm.at(S.colCursor + 1) ?? nowT - 7.05 * DAY;

  /* the pools that matter here: LONG pools with a stock on at least one side */
  const pools = (opts.pools || []).map((p) => ({ id: p.id, c0: p.c0.toLowerCase(), c1: p.c1.toLowerCase() }))
    .filter((p) => stocks.has(p.c0) || stocks.has(p.c1));
  const byId = new Map(pools.map((p) => [p.id, p]));

  /* 1. Collect events since the last run: the 24h window, and which totals moved */
  const moved = new Set();
  if (S.colCursor < latest) {
    const logs = await getLogsRange({ address: LONG_HOOK, topics: [COLLECT] }, S.colCursor + 1, latest, { chunk: 9_000_000, deadline });
    for (const l of logs) {
      const id = l.topics[1];
      moved.add(id);
      S.collects.push([tm.at(parseInt(l.blockNumber, 16)) ?? nowT, id, BigInt("0x" + l.data.slice(2, 66)).toString(), BigInt("0x" + l.data.slice(66, 130)).toString()]);
    }
    S.colCursor = logs.reachedBlock;
  }
  S.collects = S.collects.filter((c) => c[0] > nowT - WEEK);
  const days7 = Math.min(7, (nowT - S.colFrom) / DAY);

  /* 2. which totals to read: pools that collected, never-read pools (those that
     collected first), and once a day every pool with fees */
  const fullDue = nowT - (S.lastFull || 0) > DAY;
  const queue = [], seen = new Set();
  const add = (p) => { if (p && !seen.has(p.id)) { seen.add(p.id); queue.push(p); } };
  for (const id of moved) add(byId.get(id));
  for (const p of pools) if (!S.pools[p.id]) add(p);
  if (fullDue) for (const p of pools) { const e = S.pools[p.id]; if (e && (e.f0 !== "0" || e.f1 !== "0")) add(p); }

  let read = 0, partialRun = false;
  const CHUNK = 300;                                // pools per pass; three calls each
  for (let i = 0; i < queue.length; i += CHUNK) {
    if (Date.now() > deadline) { partialRun = true; break; }
    const part = queue.slice(i, i + CHUNK);
    const res = await multicall(part.flatMap((p) => [
      { to: LONG_HOOK, data: SEL.f0 + p.id.slice(2) },
      { to: LONG_HOOK, data: SEL.f1 + p.id.slice(2) },
      { to: POOL_MANAGER, data: SEL.extsload + slot0Of(p.id).slice(2) },
    ]));
    part.forEach((p, j) => {
      const a = res[j * 3], b = res[j * 3 + 1], s = res[j * 3 + 2];
      if (a == null || b == null) return;
      const f0 = BigInt(a).toString(), f1 = BigInt(b).toString();
      S.pools[p.id] = f0 === "0" && f1 === "0" ? { f0, f1 }
        : { f0, f1, sq: s ? (BigInt(s) & ((1n << 160n) - 1n)).toString() : S.pools[p.id]?.sq ?? null };
      read++;
    });
  }
  if (fullDue && !partialRun) S.lastFull = nowT;

  /* 3. value and attribute */
  const d1Raw = new Map(), d7Raw = new Map();
  for (const [t, id, a, b] of S.collects) {
    for (const [m, keep] of [[d7Raw, true], [d1Raw, t > nowT - DAY]]) {
      if (!keep) continue;
      const v = m.get(id) || [0n, 0n];
      v[0] += BigInt(a); v[1] += BigInt(b); m.set(id, v);
    }
  }
  const byStock = new Map();
  const row = (a) => byStock.get(a) || byStock.set(a, { token: a, symbol: stocks.get(a)?.symbol || a.slice(0, 8), pools: 0, poolsWithFees: 0, poolsCollected24h: 0,
    all: { stockUnits: 0, stockUsd: 0, otherUsd: 0 }, d1: { stockUnits: 0, stockUsd: 0, otherUsd: 0 }, d7Usd: 0, unpricedOther: 0, top: [] }).get(a);
  let unread = 0;
  for (const p of pools) {
    const e = S.pools[p.id];
    for (const t of [p.c0, p.c1]) if (stocks.has(t)) row(t).pools++;
    if (!e) { unread++; continue; }
    if (e.f0 === "0" && e.f1 === "0") continue;
    const d1 = d1Raw.get(p.id) || [0n, 0n], d7 = d7Raw.get(p.id) || [0n, 0n];
    /* the price of token0 in token1, from the pool's current sqrt price */
    const sq = e.sq ? Number(BigInt(e.sq)) / 2 ** 96 : null;
    const p01 = sq ? sq * sq * 10 ** (decOf(p.c0) - decOf(p.c1)) : null;
    const usdOf = (tok, units, otherTok) => {
      if (tok === usdg) return units;
      if (tok === ai && aiUsd) return units * aiUsd;
      if (stocks.get(tok)?.priceUsd) return units * stocks.get(tok).priceUsd;
      /* a launched token: through the pool price into what it is paired with */
      const otherPx = otherTok === usdg ? 1 : otherTok === ai ? aiUsd : stocks.get(otherTok)?.priceUsd ?? null;
      if (p01 == null || !otherPx) return null;
      return units * (tok === p.c0 ? p01 : 1 / p01) * otherPx;
    };
    const stockSides = [p.c0, p.c1].filter((t) => stocks.has(t));
    let poolUsd = 0, poolUsd1 = 0;
    for (const [k, tok] of [p.c0, p.c1].entries()) {
      const other = k ? p.c0 : p.c1;
      const units = Number(BigInt(k ? e.f1 : e.f0)) / 10 ** decOf(tok), u1 = Number(d1[k]) / 10 ** decOf(tok), u7 = Number(d7[k]) / 10 ** decOf(tok);
      const isStock = stocks.has(tok);
      const R = row(isStock ? tok : stockSides[0]);
      if (isStock) { R.all.stockUnits += units; R.d1.stockUnits += u1; }
      const usdAll = usdOf(tok, units, other), usd1 = usdOf(tok, u1, other);
      R.d7Usd += usdOf(tok, u7, other) || 0;
      if (usdAll == null) { if (units > 0) R.unpricedOther++; continue; }
      if (isStock) { R.all.stockUsd += usdAll; R.d1.stockUsd += usd1 || 0; } else { R.all.otherUsd += usdAll; R.d1.otherUsd += usd1 || 0; }
      poolUsd += usdAll; poolUsd1 += usd1 || 0;
    }
    for (const t of stockSides) {
      const R = row(t);
      R.poolsWithFees++;
      if (d1[0] > 0n || d1[1] > 0n) R.poolsCollected24h++;
      R.top.push({ pool: p.id, other: t === p.c0 ? p.c1 : p.c0, usd: Math.round(poolUsd), d1Usd: Math.round(poolUsd1) });
    }
  }
  const out = [...byStock.values()].filter((R) => R.poolsWithFees > 0).map((R) => ({
    ...R,
    allUsd: Math.round(R.all.stockUsd + R.all.otherUsd), d1Usd: Math.round(R.d1.stockUsd + R.d1.otherUsd), d7Usd: Math.round(R.d7Usd),
    all: { stockUnits: +R.all.stockUnits.toPrecision(8), stockUsd: Math.round(R.all.stockUsd), otherUsd: Math.round(R.all.otherUsd) },
    d1: { stockUnits: +R.d1.stockUnits.toPrecision(8), stockUsd: Math.round(R.d1.stockUsd), otherUsd: Math.round(R.d1.otherUsd) },
    top: R.top.sort((a, b) => b.usd - a.usd).slice(0, 5),
  })).sort((a, b) => b.allUsd - a.allUsd);

  /* seven-day fees for the pools a caller names (AI's protocol-owned liquidity),
     valued the same way: AI at its price, anything else through the pool price */
  const poolFees7d = {};
  /* pools outside the stock set (AI/USDG, AI/launched) have no price on file yet */
  const needSq = (opts.aprPools || []).filter((q) => d7Raw.has(q.id) && !S.pools[q.id]?.sq);
  if (needSq.length) {
    const r = await multicall(needSq.map((q) => ({ to: POOL_MANAGER, data: SEL.extsload + slot0Of(q.id).slice(2) })));
    needSq.forEach((q, i) => { if (r[i]) S.pools[q.id] = { ...(S.pools[q.id] || { f0: "0", f1: "0" }), sq: (BigInt(r[i]) & ((1n << 160n) - 1n)).toString() }; });
  }
  for (const q of opts.aprPools || []) {
    const v = d7Raw.get(q.id); if (!v) { poolFees7d[q.id] = 0; continue; }
    const c0 = q.c0.toLowerCase(), c1 = q.c1.toLowerCase(), e = S.pools[q.id];
    const sq = e?.sq ? Number(BigInt(e.sq)) / 2 ** 96 : null, p01 = sq ? sq * sq * 10 ** (decOf(c0) - decOf(c1)) : null;
    const px = (t) => (t === usdg ? 1 : t === ai ? aiUsd : stocks.get(t)?.priceUsd ?? null);
    const val = (t, raw, other) => { const u = Number(raw) / 10 ** decOf(t); if (px(t)) return u * px(t); const o = px(other); return p01 && o ? u * (t === c0 ? p01 : 1 / p01) * o : 0; };
    poolFees7d[q.id] = Math.round(val(c0, v[0], c1) + val(c1, v[1], c0));
  }
  const tot = out.reduce((s, r) => ({ all: s.all + r.allUsd, d1: s.d1 + r.d1Usd }), { all: 0, d1: 0 });
  log(`  stock fees: ${read.toLocaleString()} pool total(s) read, ${unread.toLocaleString()} of ${pools.length.toLocaleString()} not yet read${partialRun ? " (budget)" : ""}; ${S.collects.length} collect(s) over ${days7.toFixed(1)}d; $${tot.all.toLocaleString()} all time, $${tot.d1.toLocaleString()} in 24h across ${out.length} stock(s)`);
  return {
    state: S,
    artifact: {
      stocks: out, totals: { allUsd: tot.all, d1Usd: tot.d1 }, poolsTotal: pools.length, poolsUnread: unread,
      collects24h: S.collects.filter((c) => c[0] > nowT - DAY).length, collects7d: S.collects.length, days7: +days7.toFixed(2),
      poolFees7d, complete: unread === 0, asOf: nowT,
      method: "From the LONG hook's own fee accounting (DopplerHookInitializer): all time is its running total of fees collected from its liquidity in each pool (getCumulatedFees0/1); 24h is the sum of its Collect events in the last 24 hours. Fees count when collected, several times a day on an active pool; outside LPs' fees are excluded, so both are floors. Each pool's stock-side fees are credited to that stock; the other side's are valued at the pool's current price and credited to the same stock. Values at today's prices.",
    },
  };
}
