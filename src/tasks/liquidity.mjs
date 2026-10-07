import { getLogsRange } from "../rpc.mjs";
import { multicall } from "../tokens.mjs";
import { keccak256, selector } from "../keccak.mjs";
import { LONG_HOOK, NVDA, USDG, AI, BLOCKS_PER_DAY } from "../config.mjs";

/* LIQUIDITY: HOW LONG PAIRS' FEES ARE MADE AND WHERE THEY GO, AND WHERE NVDA'S
   DEX LIQUIDITY SITS.

   The fee path, read from the hook's own records (2-7 Oct 2026):
     0. Every swap also pays LONG 1% of what it takes out: the hook sends that leg to
        LONG's buyback contract, which forwards 95% to LONG's revenue wallet (AI legs
        are sold into the pool for NVDA first). Measured on single-pool swaps, traders
        received exactly 1.00% less than the pool paid out; the revenue wallet's NVDA
        intake ran 0.97-1.03% of AI/NVDA's daily volume. A second 1% leg to the hook
        is taken and returned in the same swap and costs nothing. So a trader in
        AI/NVDA pays about 1.7%: 0.7% to liquidity, 1% to LONG.
     1. Traders pay the pool's LP fee (AI/NVDA: 0.7%, the Swap event's fee field).
        LONG's hook owns nearly all the liquidity, so it earns nearly all of it, and
        collects it a few times a day (Collect(poolId, fees0, fees1)). Over 25 Sep -
        2 Oct it collected 87% of 0.7% of everything traded into AI/NVDA, on both
        sides: its share of the liquidity less what was still uncollected.
     2. Each collect is split between the pool's beneficiaries, fixed at launch in
        the hook's Lock event: 95% to the pair's beneficiary and 5% to 0xedea...eda8,
        the same 5% recipient in every LONG pool.
     3. AI/NVDA's 95% beneficiary was AI's original receiver, 0x4a0c...cb2, until it
        was pointed at AI's fee splitter, which burns 40% of the AI side, locks 40% in
        the Community Vault and pays 20% to 0x4a0c; of the NVDA side 80% to the vault
        and 20% to 0x4a0c. The burns ledger already records the splitter's transfers
        exactly, day by day, so this step joins them to the collects above.
   Community vault pairs follow the same path with their vault as the 95%
   beneficiary (see communityvaults.mjs).

   Watched pools keep a daily fee series built from Collect events, each spread over
   the time since that pool's previous collect, from a 45-day backfill onward. */

const STATE_V = 1;
const COLLECT = keccak256("Collect(bytes32,uint256,uint256)");
const LOCK = keccak256("Lock(address,(address,uint96)[])");
const DAY = 86_400;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const W = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const SEL = { getPool: selector("getPool(address,address,uint24)"), balanceOf: selector("balanceOf(address)"), slot0: selector("slot0()") };

export async function indexLiquidity(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const deadline = opts.deadline || Infinity;
  const nowT = tm.at(latest) ?? Math.floor(Date.now() / 1000);
  const dayOf = (t) => Math.floor(t / DAY) * DAY;
  const S = opts.state?.v === STATE_V ? structuredClone(opts.state)
    : { v: STATE_V, colCursor: latest - 45 * BLOCKS_PER_DAY, lastCol: {}, daily: {}, shares: {}, snaps: [] };
  const watch = new Map((opts.watch || []).map((w) => [w.id, w]));

  /* 1. hook collects for the watched pools, spread into daily buckets */
  if (S.colCursor < latest && Date.now() < deadline) {
    const logs = await getLogsRange({ address: LONG_HOOK, topics: [COLLECT] }, S.colCursor + 1, latest, { chunk: 9_000_000, deadline });
    for (const l of logs) {
      const id = l.topics[1]; if (!watch.has(id)) continue;
      const t = tm.at(parseInt(l.blockNumber, 16)) ?? nowT;
      const f0 = Number(BigInt("0x" + l.data.slice(2, 66))), f1 = Number(BigInt("0x" + l.data.slice(66, 130)));
      /* the first collect seen for a pool has no predecessor: one day, which only
         affects the oldest day of the backfill */
      const pt = Math.min(S.lastCol[id] ?? t - DAY, t);
      S.lastCol[id] = t;
      const D = (S.daily[id] ||= {});
      if (t <= pt) { const d = dayOf(t); D[d] = D[d] || [0, 0]; D[d][0] += f0; D[d][1] += f1; continue; }
      for (let s = pt; s < t;) {
        const e = Math.min(t, dayOf(s) + DAY), w = (e - s) / (t - pt), d = dayOf(s);
        D[d] = D[d] || [0, 0]; D[d][0] += f0 * w; D[d][1] += f1 * w; s = e;
      }
    }
    S.colCursor = logs.reachedBlock;
  }
  for (const D of Object.values(S.daily)) for (const d of Object.keys(D)) if (+d < nowT - 60 * DAY) delete D[d];

  /* 2. each watched pool's beneficiary shares, from its Lock event at creation */
  for (const w of watch.values()) {
    if (S.shares[w.id] || !w.block || Date.now() > deadline) continue;
    const logs = await getLogsRange({ address: LONG_HOOK, topics: [LOCK] }, w.block, w.block + 5, { chunk: 10, deadline });
    const l = logs.find((x) => x.topics[1].slice(26).toLowerCase() === (w.asset || "").slice(2).toLowerCase()) || null;
    if (!l) continue;
    const d = l.data.slice(2).match(/.{64}/g), n = Number(BigInt("0x" + d[1]));
    S.shares[w.id] = [...Array(n)].map((_, i) => ({ to: "0x" + d[2 + i * 2].slice(24), share: Number(BigInt("0x" + d[3 + i * 2])) / 1e18 }));
  }

  /* 3. NVDA's Uniswap v3 pools, by what they hold, for the leaderboard */
  const nv = NVDA.toLowerCase();
  const v3 = [];
  for (const [other, sym] of [[USDG.toLowerCase(), "USDG"], [WETH, "WETH"]]) for (const fee of [100, 500, 3000, 10000]) {
    const [a, b] = nv < other ? [nv, other] : [other, nv];
    v3.push({ other, sym, fee, a, b });
  }
  const pr = await multicall(v3.map((p) => ({ to: V3_FACTORY, data: SEL.getPool + W(BigInt(p.a)) + W(BigInt(p.b)) + W(p.fee) })));
  v3.forEach((p, i) => { p.pool = pr[i] ? "0x" + pr[i].slice(26) : null; });
  const live = v3.filter((p) => p.pool && !/^0x0+$/.test(p.pool));
  const bal = await multicall(live.flatMap((p) => [{ to: nv, data: SEL.balanceOf + W(BigInt(p.pool)) }, { to: p.other, data: SEL.balanceOf + W(BigInt(p.pool)) }]));
  const nvPx = opts.nvdaUsd ?? null;
  const pools = live.map((p, i) => {
    const units = bal[i * 2] ? Number(BigInt(bal[i * 2])) / 1e18 : 0;
    const other = bal[i * 2 + 1] ? Number(BigInt(bal[i * 2 + 1])) / (p.sym === "USDG" ? 1e6 : 1e18) : 0;
    return { label: `NVDA/${p.sym} v3 ${(p.fee / 1e4).toFixed(2)}%`, venue: "Uniswap v3", pool: p.pool, nvda: units, other, otherSym: p.sym,
      tvlUsd: nvPx ? (p.sym === "USDG" ? units * nvPx + other : null) : null };
  }).filter((p) => p.nvda >= 1);
  /* LONG pairs on NVDA from the stock census (the pool's own NVDA, valued from its
     ladder), and the NVDA in every other v4 pool, which is not yet measured pool by
     pool: the pool manager's balance less what LONG pools hold */
  for (const r of opts.longNvdaPairs || []) pools.push({ label: `${r.symbol}/NVDA`, venue: "Uniswap v4 (LONG)", pool: r.poolId, nvda: r.stockUnits, tvlUsd: null, long: true });
  pools.sort((a, b) => b.nvda - a.nvda);
  const longNvda = opts.longNvdaUnits ?? null, pmNvda = opts.pmNvdaUnits ?? null;
  const v3Nvda = pools.filter((p) => p.venue === "Uniswap v3").reduce((s, p) => s + p.nvda, 0);
  const aiRow = pools.find((p) => p.label === "AI/NVDA");
  const next = pools.find((p) => p !== aiRow);
  const snap = { t: nowT, ai: aiRow?.nvda ?? null, next: next?.nvda ?? null, nextLabel: next?.label ?? null, v3: Math.round(v3Nvda), longAll: longNvda, pm: pmNvda };
  if (!S.snaps.length || dayOf(S.snaps.at(-1).t) !== dayOf(nowT)) S.snaps.push(snap); else S.snaps[S.snaps.length - 1] = snap;
  S.snaps = S.snaps.slice(-120);

  /* 4. AI/NVDA's fee engine, day by day: what traders paid (volume x the pool's
     fee), what LONG's liquidity collected, LONG's 5%, and where AI's 95% went (the
     splitter's own transfers, from the burns ledger) */
  const aiPool = [...watch.values()].find((w) => w.label === "AI/NVDA");
  const D = aiPool ? S.daily[aiPool.id] || {} : {};
  const aiIs0 = aiPool ? aiPool.c0.toLowerCase() === AI.toLowerCase() : true;
  const burnsByDay = new Map((opts.burnsDaily || []).map((r) => [r.t, r]));
  const revByDay = new Map((opts.revenueDaily || []).map((r) => [r.t, r]));
  const LONG_SWAP_FEE = 0.01;
  const volByDay = opts.aiNvdaVolByDay || new Map();
  const pxAI = opts.aiUsdAt || (() => null), pxNV = opts.nvdaUsdAt || (() => null);
  const share95 = (S.shares[aiPool?.id]?.[0]?.share) ?? 0.95;
  const days = [...new Set([...Object.keys(D).map(Number), ...burnsByDay.keys()])].filter((d) => d >= dayOf(nowT) - 30 * DAY).sort((a, b) => a - b);
  const engine = days.map((d) => {
    const c = D[d] || [0, 0];
    const aiC = (aiIs0 ? c[0] : c[1]) / 1e18, nvC = (aiIs0 ? c[1] : c[0]) / 1e18;
    const a = pxAI(d + DAY - 1), n = pxNV(d);
    const b = burnsByDay.get(d) || {};
    const v = volByDay.get(d) || null;
    const rv = revByDay.get(d) || null;
    const usd = (ai, nvda) => (a == null || n == null ? null : ai * a + nvda * n);
    return {
      t: d, aiPx: a, nvdaPx: n,
      volumeUsd: v?.usd ?? null, feeRate: v?.feePips != null ? v.feePips / 1e6 : null,
      /* what traders paid: the LP fee plus LONG's 1% */
      lpFeeUsd: v?.usd != null && v?.feePips != null ? v.usd * v.feePips / 1e6 : null,
      paidUsd: v?.usd != null && v?.feePips != null ? v.usd * (v.feePips / 1e6 + LONG_SWAP_FEE) : null,
      /* LONG's 1% swap fee on AI/NVDA, and as a cross-check the NVDA its revenue wallet
         actually received that day from the buyback contract (every NVDA pair; AI/NVDA
         is nearly all of it) */
      longSwap: { usd: v?.usd != null ? v.usd * LONG_SWAP_FEE : null, revenueNvda: rv?.nvdaToRevenue ?? null,
        revenueUsd: rv?.nvdaToRevenue != null && n != null ? rv.nvdaToRevenue * n : null },
      collected: { ai: aiC, nvda: nvC, usd: usd(aiC, nvC) },
      longCut: { ai: aiC * (1 - share95), nvda: nvC * (1 - share95), usd: usd(aiC * (1 - share95), nvC * (1 - share95)) },
      burned: { ai: b.burnAI || 0, usd: a == null ? null : (b.burnAI || 0) * a },
      vault: { ai: b.lockAI || 0, nvda: b.nvdaIn || 0, usd: usd(b.lockAI || 0, b.nvdaIn || 0) },
      receiver: { ai: b.platformAI || 0, nvda: (b.nvdaIn || 0) / 4, usd: usd(b.platformAI || 0, (b.nvdaIn || 0) / 4) },
    };
  });

  /* 5. every other watched pool's daily fees (community vault pairs), valued at
     today's prices, for before-and-after comparisons around an LP deployment */
  const pairs = [...watch.values()].filter((w) => w !== aiPool).map((w) => {
    const Dp = S.daily[w.id] || {};
    const series = Object.keys(Dp).map(Number).filter((d) => d >= dayOf(nowT) - 30 * DAY).sort((a, b) => a - b)
      .map((d) => ({ t: d, usd: Math.round(((Dp[d][0] / 10 ** (w.dec0 ?? 18)) * (w.px0 ?? 0) + (Dp[d][1] / 10 ** (w.dec1 ?? 18)) * (w.px1 ?? 0)) * 100) / 100 }));
    return { poolId: w.id, label: w.label, vault: w.vault || null, lpSince: w.lpSince || null, shares: S.shares[w.id] || null, daily: series };
  }).filter((p) => p.daily.length);

  const e7 = engine.slice(-7);
  const sum = (k) => e7.reduce((s, r) => s + (r[k]?.usd ?? r[k] ?? 0), 0);
  log(`  liquidity: AI/NVDA holds ${aiRow ? Math.round(aiRow.nvda).toLocaleString() : "?"} NVDA, next ${next ? next.label + " " + Math.round(next.nvda).toLocaleString() : "?"}; 7d AI/NVDA fees collected $${Math.round(sum("collected")).toLocaleString()}, burned $${Math.round(sum("burned")).toLocaleString()}; ${pairs.length} vault pair series`);
  return {
    state: S,
    artifact: {
      nvdaPools: pools.slice(0, 12), nvdaV3Total: Math.round(v3Nvda), nvdaLongTotal: longNvda, nvdaPoolManager: pmNvda,
      nvdaHistory: S.snaps, aiEngine: engine, aiShares: S.shares[aiPool?.id] || null, pairs,
      method: "Fees from the LONG hook's Collect events, each spread over the time since that pool's previous collect; beneficiary shares from the hook's Lock event at each pool's creation; AI's splitter outputs from the burns ledger's own transfer records; volume from the AI/NVDA swap tape at the pool's fee. NVDA pool holdings: Uniswap v3 pools by balance, LONG v4 pairs from their position ladders; NVDA in other v4 pools is the pool manager's balance less LONG's and is not yet split by pool.",
    },
  };
}
