import { getLogsRange, padAddr } from "../rpc.mjs";
import { multicall } from "../tokens.mjs";
import { keccak256, selector } from "../keccak.mjs";
import { USDG, BLOCKS_PER_DAY } from "../config.mjs";

/* COMMUNITY VAULT LP FEES, BY STOCK.

   LONG's community vault LP upgrade (announced 1 Oct 2026) moves a pair's stock out
   of its community vault into a dedicated LP module, which holds a position in a
   USDG/stock pool. The first adopter, MOO, showed the shape on chain:
     - the vault emits one event per deployment, naming the module (topic1), the
       stock (topic2) and the amount (data): 0xfdae28f6...8e23. Scanning the chain
       for that event finds every vault that adopts, without a list;
     - the module holds its position directly in a Uniswap v3 pool (the pool's Mint
       names the module as owner), with no NFT.
   AI's own vault is a timelock and cannot emit that event; its moves are read by
   the vault watch instead, which values the same kind of position.

   Fees per position, all time: what the module has collected (Collect minus the
   principal its Burns released) plus what is unclaimed now (fee growth inside the
   range since the last update, plus tokens already owed). 24h: the change against
   a reading at least a day old; a module younger than a day counts everything. */

const STATE_V = 1;
const DEPLOY_EV = "0xfdae28f6f2d6a2a057913b515af72f792b0fb7f7086761f6623ad942616e8e23";
const V3 = {
  mint: keccak256("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  burn: keccak256("Burn(address,int24,int24,uint128,uint256,uint256)"),
  collect: keccak256("Collect(address,address,int24,int24,uint128,uint128)"),
};
const SEL = {
  balanceOf: selector("balanceOf(address)"),
  positions: selector("positions(bytes32)"), slot0: selector("slot0()"), token0: selector("token0()"), token1: selector("token1()"),
  fee: selector("fee()"), fgg0: selector("feeGrowthGlobal0X128()"), fgg1: selector("feeGrowthGlobal1X128()"), ticks: selector("ticks(int24)"),
};
const M128 = (1n << 128n) - 1n, M256 = (1n << 256n) - 1n;
const W = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const i24hex = (t) => BigInt.asUintN(24, BigInt(t)).toString(16).padStart(6, "0");
const word = (d, i) => BigInt("0x" + d.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const tAddr = (t) => "0x" + t.slice(26).toLowerCase();
const i24 = (t) => Number(BigInt.asIntN(24, BigInt(t)));
const feeInside = (tick, lo, hi, g, oLo, oHi) => {
  const below = tick >= lo ? oLo : (g - oLo) & M256, above = tick < hi ? oHi : (g - oHi) & M256;
  return (g - below - above) & M256;
};
const DAY = 86_400;

export async function indexVaultLp(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const deadline = opts.deadline || Infinity;
  const stocks = opts.stocks || new Map();
  const usdg = USDG.toLowerCase();
  const nowT = tm.at(latest) ?? Math.floor(Date.now() / 1000);
  const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const decOf = (a) => (a === usdg ? 6 : stocks.get(a)?.decimals ?? 18);
  /* a quote token that is neither USDG nor a priced stock (WETH, on ICOIN's AAPL
     position) is priced through the pool it sits in, against the stock beside it */
  const derived = new Map();
  const pxOf = (a) => (a === usdg ? 1 : stocks.get(a)?.priceUsd ?? derived.get(a) ?? null);
  const symOf = (a) => (a === usdg ? "USDG" : a === WETH ? "WETH" : stocks.get(a)?.symbol || a.slice(0, 8));

  /* first run starts three days back: MOO, the first adopter, deployed on 1 Oct */
  const S = opts.state?.v === STATE_V ? structuredClone(opts.state)
    : { v: STATE_V, cursor: latest - 3 * BLOCKS_PER_DAY, modules: {} };

  /* 1. deployments: every vault-to-module stock transfer event, chain-wide */
  if (S.cursor < latest && Date.now() < deadline) {
    const logs = await getLogsRange({ topics: [DEPLOY_EV] }, S.cursor + 1, latest, { chunk: 25_000, deadline });
    for (const l of logs) {
      const m = tAddr(l.topics[1]), stock = tAddr(l.topics[2]);
      const M = S.modules[m] || (S.modules[m] = { vault: l.address.toLowerCase(), stock, deployed: 0, firstBlock: parseInt(l.blockNumber, 16),
        cursor: parseInt(l.blockNumber, 16) - 1, positions: {}, collected: {}, burned: {}, hist: [] });
      M.deployed += Number(word(l.data, 0)) / 10 ** decOf(stock);
    }
    S.cursor = logs.reachedBlock;
  }

  /* 2. each module's v3 activity since its first deployment: positions it minted,
     principal it burned, everything it collected */
  for (const [m, M] of Object.entries(S.modules)) {
    if (M.cursor >= latest || Date.now() > deadline) continue;
    let reached = latest;
    for (const [k, t0] of [["mint", V3.mint], ["burn", V3.burn], ["collect", V3.collect]]) {
      const logs = await getLogsRange({ topics: [t0, padAddr(m)] }, M.cursor + 1, latest, { chunk: 25_000, deadline });
      for (const l of logs) {
        const pool = l.address.toLowerCase(), lo = i24(l.topics[2]), hi = i24(l.topics[3]);
        if (k === "mint") M.positions[`${pool}:${lo}:${hi}`] = { pool, lo, hi };
        /* Burn data: amount, amount0, amount1; Collect data: recipient, amount0, amount1 */
        const a0 = word(l.data, 1), a1 = word(l.data, 2);
        const bag = k === "burn" ? M.burned : k === "collect" ? M.collected : null;
        if (bag) { bag[pool] = bag[pool] || ["0", "0"]; bag[pool] = [(BigInt(bag[pool][0]) + a0).toString(), (BigInt(bag[pool][1]) + a1).toString()]; }
      }
      reached = Math.min(reached, logs.reachedBlock);
    }
    M.cursor = reached;
  }

  /* 3. value each module's positions and its fees */
  const rows = [];
  for (const [m, M] of Object.entries(S.modules)) {
    const pos = Object.values(M.positions);
    let usd = 0, feeAll = 0, inRange = null, range = null, rangeQuote = null, pair = null, holds = {};
    const feeRaw = {};   // pool -> [fees0, fees1] all time
    for (const p of pos) {
      const key = keccak256("0x" + m.slice(2) + i24hex(p.lo) + i24hex(p.hi));
      const r = await multicall([
        { to: p.pool, data: SEL.positions + key.slice(2) }, { to: p.pool, data: SEL.slot0 }, { to: p.pool, data: SEL.token0 }, { to: p.pool, data: SEL.token1 },
        { to: p.pool, data: SEL.fgg0 }, { to: p.pool, data: SEL.fgg1 }, { to: p.pool, data: SEL.ticks + W(p.lo) }, { to: p.pool, data: SEL.ticks + W(p.hi) },
      ]);
      if (r.some((x) => x == null)) continue;
      const [ps, s0, t0, t1, g0, g1, tl, tu] = r;
      const c0 = tAddr(t0), c1 = tAddr(t1);
      const L = word(ps, 0) & M128, tick = i24("0x" + W(word(s0, 1)));
      const sqrtP = Number(word(s0, 0)) / 2 ** 96, sa = Math.pow(1.0001, p.lo / 2), sb = Math.pow(1.0001, p.hi / 2);
      const Ln = Number(L);
      const a0 = sqrtP <= sa ? Ln * (1 / sa - 1 / sb) : sqrtP >= sb ? 0 : Ln * (1 / sqrtP - 1 / sb);
      const a1 = sqrtP <= sa ? 0 : sqrtP >= sb ? Ln * (sb - sa) : Ln * (sqrtP - sa);
      const in0 = feeInside(tick, p.lo, p.hi, BigInt(g0), word(tl, 2), word(tu, 2));
      const in1 = feeInside(tick, p.lo, p.hi, BigInt(g1), word(tl, 3), word(tu, 3));
      const un0 = (word(ps, 3) & M128) + ((((in0 - word(ps, 1)) & M256) * L) >> 128n);
      const un1 = (word(ps, 4) & M128) + ((((in1 - word(ps, 2)) & M256) * L) >> 128n);
      const fr = feeRaw[p.pool] || (feeRaw[p.pool] = { c0, c1, f0: 0n, f1: 0n });
      fr.f0 += un0; fr.f1 += un1;
      /* price the quote side through the pool when it has no price of its own */
      const p01 = sqrtP * sqrtP * 10 ** (decOf(c0) - decOf(c1));            // token1 per token0
      if (pxOf(c0) == null && pxOf(c1) != null) derived.set(c0, p01 * pxOf(c1));
      if (pxOf(c1) == null && pxOf(c0) != null && p01 > 0) derived.set(c1, pxOf(c0) / p01);
      if (L > 0n) {
        const u0 = a0 / 10 ** decOf(c0), u1 = a1 / 10 ** decOf(c1);
        holds[c0] = (holds[c0] || 0) + u0; holds[c1] = (holds[c1] || 0) + u1;
        usd += (pxOf(c0) ?? 0) * u0 + (pxOf(c1) ?? 0) * u1;
        inRange = tick >= p.lo && tick < p.hi;
        /* the range in dollars per share of the stock: the quote per stock at each
           bound, times the quote's dollar price (1 for USDG; today's for WETH) */
        const stockIs0 = c0 === M.stock || (c1 !== M.stock && c0 !== usdg);
        const quote = stockIs0 ? c1 : c0, qPx = pxOf(quote) ?? null;
        const px = (t) => Math.pow(1.0001, t) * 10 ** (decOf(c0) - decOf(c1));
        const inQuote = stockIs0 ? [px(p.lo), px(p.hi)] : [1 / px(p.hi), 1 / px(p.lo)];
        range = qPx != null ? inQuote.map((x) => x * qPx) : null;
        rangeQuote = { lo: inQuote[0], hi: inQuote[1], symbol: symOf(quote) };
        pair = `${symOf(stockIs0 ? c0 : c1)}/${symOf(quote)}`;
      }
    }
    const idleToks = [...new Set([M.stock, usdg, WETH, ...Object.values(feeRaw).flatMap((f) => [f.c0, f.c1])])];
    const ib = await multicall(idleToks.map((t) => ({ to: t, data: SEL.balanceOf + W(BigInt(m)) })));
    const idle = idleToks.map((t, i) => ({ token: t, symbol: symOf(t), units: ib[i] ? Number(BigInt(ib[i])) / 10 ** decOf(t) : 0 }))
      .filter((x) => x.units > 1e-9).map((x) => ({ ...x, usd: pxOf(x.token) == null ? null : x.units * pxOf(x.token) }));
    const idleUsd = idle.reduce((a, x) => a + (x.usd || 0), 0);
    /* collected minus principal released = fees already taken out */
    for (const [pool, c] of Object.entries(M.collected)) {
      const b = M.burned[pool] || ["0", "0"];
      const fr = feeRaw[pool]; if (!fr) continue;
      fr.f0 += BigInt(c[0]) - BigInt(b[0]); fr.f1 += BigInt(c[1]) - BigInt(b[1]);
    }
    const feeUnits = {};
    for (const fr of Object.values(feeRaw)) {
      feeUnits[fr.c0] = (feeUnits[fr.c0] || 0) + Number(fr.f0) / 10 ** decOf(fr.c0);
      feeUnits[fr.c1] = (feeUnits[fr.c1] || 0) + Number(fr.f1) / 10 ** decOf(fr.c1);
    }
    const valueUnits = (u) => Object.entries(u || {}).reduce((a, [t, n]) => a + (pxOf(t) ?? 0) * n, 0);
    feeAll = valueUnits(feeUnits);
    /* fee history in token units, at most one reading an hour, kept eight days:
       baselines a day and a week back, valued at today's prices so the difference is
       fees earned and never a price move. Older entries held dollars; they are dropped. */
    M.hist = (M.hist || []).filter((x) => x[1] && typeof x[1] === "object");
    if (!M.hist.length || nowT - M.hist.at(-1)[0] >= 3600) M.hist.push([nowT, feeUnits]); else M.hist[M.hist.length - 1] = [nowT, feeUnits];
    M.hist = M.hist.filter((x) => x[0] > nowT - 8 * DAY);
    const old = M.hist.filter((x) => x[0] <= nowT - DAY).map((x) => [x[0], valueUnits(x[1])]);
    const old7 = M.hist.filter((x) => x[0] <= nowT - 7 * DAY).map((x) => [x[0], valueUnits(x[1])]);
    const young = (tm.at(M.firstBlock) ?? nowT) > nowT - DAY;
    /* time in range, sampled once a run: a position listed above spot earns nothing
       until price reaches it, so its APR means little without this beside it */
    M.obs = M.obs || { n: 0, inRange: 0 };
    if (inRange != null) { M.obs.n++; if (inRange) M.obs.inRange++; }
    const ageDays = ((nowT - (tm.at(M.firstBlock) ?? nowT)) / DAY);
    const base = old.length ? old.at(-1)[1] : young ? 0 : valueUnits(M.hist[0][1]);
    rows.push({ vault: M.vault, module: m, stock: M.stock, stockSymbol: symOf(M.stock), deployedUnits: +M.deployed.toPrecision(8),
      pair, range, inRange, hasPosition: usd > 0, holdings: Object.entries(holds).map(([t, u]) => ({ token: t, symbol: symOf(t), units: +u.toPrecision(8) })),
      positionUsd: Math.round(usd), idle, idleUsd: Math.round(idleUsd), valueUsd: Math.round(usd + idleUsd), rangeQuote,
      deployedUsd: pxOf(M.stock) != null ? Math.round(M.deployed * pxOf(M.stock)) : null,
      feesAllUsd: Math.round(feeAll * 100) / 100, fees24hUsd: Math.max(0, Math.round((feeAll - base) * 100) / 100),
      /* a position younger than a week has earned everything inside the week */
      fees7dUsd: Math.max(0, Math.round((feeAll - (old7.length ? old7.at(-1)[1] : ageDays < 7 ? 0 : valueUnits(M.hist[0][1]))) * 100) / 100),
      since: tm.at(M.firstBlock) ?? null, ageDays: +ageDays.toFixed(2),
      /* fees so far over the position's value, annualised over its age; withheld until
         it is a day old, when a few hours of fees would annualise into noise */
      apr: usd > 0 && ageDays >= 1 ? +(feeAll / usd * 365 / ageDays).toFixed(4) : null,
      inRangeShare: M.obs.n >= 3 ? +(M.obs.inRange / M.obs.n).toFixed(3) : null, inRangeObs: M.obs.n });
  }
  log(`  vault LP: ${rows.length} vault(s) in the LP upgrade; $${rows.reduce((s, r) => s + r.positionUsd, 0).toLocaleString()} in positions, $${rows.reduce((s, r) => s + r.idleUsd, 0).toLocaleString()} idle, $${rows.reduce((s, r) => s + r.feesAllUsd, 0).toFixed(2)} fees all time`);
  return { state: S, rows };
}
