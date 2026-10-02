import { getLogsRange } from "../rpc.mjs";
import { multicall } from "../tokens.mjs";
import { keccak256, selector } from "../keccak.mjs";
import { POOL_MANAGER, USDG, AI } from "../config.mjs";

/* COMMUNITY VAULTS: WHAT EACH ONE EARNS, WHERE IT GOES, AND THE VAULT'S APR.

   How a community vault is paid, traced on chain 2 Oct 2026 (MOO):
     1. LONG's hook collects the fees its liquidity earned in the pair's pool and
        releases 95% of each collect to the pool's beneficiary (Release events).
     2. A pair that switched to "community mode" has a vault from LongFeeVaultFactory
        (0xbA85...319A) as that beneficiary. The factory's VaultDeployed event names
        the asset, the pool, the vault, the pair's original fee receiver and a mode.
     3. The vault splits what it receives by its mode, per side, as splitsFor(mode)
        reads: [asset to receiver, asset burned, asset locked, numeraire to receiver,
        numeraire kept, numeraire burned], in basis points. Mode 1 is 50/25/25 and
        50/50/0; mode 0 is 20/40/40 and 20/80/0. MOO is mode 1: of every distribute()
        its vault sent 50% to its original receiver 0xbcc8...588d (the wallet that
        took MOO's fees before the vault, and that deployed the vault), burned 25% of
        the MOO side and kept the rest, whoever called distribute().
   So the vault's own revenue is the locked share of the asset side, the kept share of
   the numeraire side, and (since the LP upgrade) its LP position's fees. Its APR is
   that, annualised over seven days, over what the vault holds.

   Fees per window come from the stock-fee step's Collect record, each collect spread
   over the time since the pool's previous one, times the 95% the hook releases. */

const FACTORY = "0xba85d8fad36c57f4890a0f3c414ed87a50b9319a";
const DEPLOYED = keccak256("VaultDeployed(address,bytes32,address,address,uint8)");
const RELEASE_SHARE = 0.95;
const SEL = {
  splits: selector("splitsFor(uint8)"), balanceOf: selector("balanceOf(address)"), symbol: selector("symbol()"),
  decimals: selector("decimals()"), extsload: selector("extsload(bytes32)"),
};
const W = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const slot0Of = (poolId) => "0x" + W(BigInt(keccak256("0x" + poolId.slice(2) + W(6))));
const DAY = 86_400, WEEK = 7 * DAY;
const STATE_V = 1;

export async function indexCommunityVaults(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const stocks = opts.stocks || new Map();
  const aiUsd = opts.aiUsd ?? null;
  const usdg = USDG.toLowerCase(), ai = AI.toLowerCase();
  const nowT = tm.at(latest) ?? Math.floor(Date.now() / 1000);
  const S = opts.state?.v === STATE_V ? structuredClone(opts.state) : { v: STATE_V, cursor: 0, vaults: {}, splits: {} };

  /* 1. every vault the factory has deployed */
  if (S.cursor < latest) {
    const logs = await getLogsRange({ address: FACTORY, topics: [DEPLOYED] }, S.cursor + 1, latest, { chunk: 9_000_000, deadline: opts.deadline });
    for (const l of logs) {
      const v = "0x" + l.data.slice(26, 66);
      S.vaults[v] = { vault: v, asset: "0x" + l.topics[1].slice(26), poolId: l.topics[2], receiver: "0x" + l.data.slice(90, 130),
        mode: parseInt(l.data.slice(130, 194), 16), block: parseInt(l.blockNumber, 16) };
    }
    S.cursor = logs.reachedBlock;
  }
  const vaults = Object.values(S.vaults);
  if (!vaults.length) return { state: S, rows: [] };

  /* 2. the split for each mode in use, read from the factory */
  const modes = [...new Set(vaults.map((v) => v.mode))].filter((m) => !S.splits[m]);
  if (modes.length) {
    const r = await multicall(modes.map((m) => ({ to: FACTORY, data: SEL.splits + W(m) })));
    modes.forEach((m, i) => { if (r[i]) S.splits[m] = r[i].slice(2).match(/.{64}/g).slice(0, 6).map((x) => Number(BigInt("0x" + x)) / 10_000); });
  }

  /* 3. each vault's pool: its two tokens (from the census), price, and the vault's own
     balances of both */
  const census = new Map((opts.pools || []).map((p) => [p.id, p]));
  const meta = new Map();
  const toks = [...new Set(vaults.flatMap((v) => { const p = census.get(v.poolId); return p ? [p.c0.toLowerCase(), p.c1.toLowerCase()] : []; }))];
  const tm1 = await multicall(toks.flatMap((t) => [{ to: t, data: SEL.symbol }, { to: t, data: SEL.decimals }]));
  toks.forEach((t, i) => {
    let sym = stocks.get(t)?.symbol || (t === usdg ? "USDG" : t === ai ? "AI" : null);
    try { if (!sym && tm1[i * 2]) { const h = tm1[i * 2]; const n = parseInt(h.slice(66, 130), 16); sym = Buffer.from(h.slice(130, 130 + n * 2), "hex").toString(); } } catch { /* unnamed */ }
    meta.set(t, { symbol: sym || t.slice(0, 8), decimals: tm1[i * 2 + 1] ? Number(BigInt(tm1[i * 2 + 1])) : 18 });
  });
  const calls = [];
  for (const v of vaults) {
    const p = census.get(v.poolId); if (!p) continue;
    calls.push({ to: POOL_MANAGER, data: SEL.extsload + slot0Of(v.poolId).slice(2) });
    calls.push({ to: p.c0, data: SEL.balanceOf + W(BigInt(v.vault)) });
    calls.push({ to: p.c1, data: SEL.balanceOf + W(BigInt(v.vault)) });
  }
  const res = await multicall(calls);

  /* collects per pool, spread across the window as the stock-fee step does */
  const byPool = new Map();
  for (const c of opts.collects || []) { if (!byPool.has(c[1])) byPool.set(c[1], []); byPool.get(c[1]).push(c); }
  const share = (c, from) => { const t = c[0], pt = c[4] ?? t; if (t <= from) return 0; if (pt >= t) return 1; return (t - Math.max(pt, from)) / (t - pt); };
  const lpBy = new Map((opts.lp || []).map((r) => [r.vault, r]));

  const rows = [];
  let k = 0;
  for (const v of vaults) {
    const p = census.get(v.poolId); if (!p) continue;
    const s0 = res[k++], b0 = res[k++], b1 = res[k++];
    const c0 = p.c0.toLowerCase(), c1 = p.c1.toLowerCase();
    const assetIs0 = c0 === v.asset.toLowerCase();
    const num = assetIs0 ? c1 : c0, asset = assetIs0 ? c0 : c1;
    const dA = meta.get(asset)?.decimals ?? 18, dN = meta.get(num)?.decimals ?? (num === usdg ? 6 : 18);
    const numPx = num === usdg ? 1 : num === ai ? aiUsd : stocks.get(num)?.priceUsd ?? null;
    const sq = s0 ? Number(BigInt(s0) & ((1n << 160n) - 1n)) / 2 ** 96 : null;
    const p01 = sq ? sq * sq * 10 ** (meta.get(c0)?.decimals ?? 18) / 10 ** (meta.get(c1)?.decimals ?? 18) : null;   // token1 per token0
    const assetInNum = p01 == null ? null : assetIs0 ? p01 : 1 / p01;
    const assetPx = assetInNum != null && numPx ? assetInNum * numPx : null;
    const sp = S.splits[v.mode] || null;
    /* gross released to the vault per window, by side */
    const win = (from) => {
      let a = 0, n = 0;
      for (const c of byPool.get(v.poolId) || []) {
        const w = share(c, from); if (!(w > 0)) continue;
        const f0 = Number(BigInt(c[2])), f1 = Number(BigInt(c[3]));
        a += (assetIs0 ? f0 : f1) * w * RELEASE_SHARE; n += (assetIs0 ? f1 : f0) * w * RELEASE_SHARE;
      }
      return { asset: a / 10 ** dA, num: n / 10 ** dN };
    };
    const split = (g) => {
      if (!sp) return null;
      const usd = (u, px) => (px == null ? null : u * px);
      const parts = {
        receiver: { asset: g.asset * sp[0], num: g.num * sp[3] },
        burned: { asset: g.asset * sp[1], num: g.num * sp[5] },
        vault: { asset: g.asset * sp[2], num: g.num * sp[4] },
      };
      for (const x of Object.values(parts)) x.usd = (usd(x.asset, assetPx) ?? 0) + (usd(x.num, numPx) ?? 0);
      return { gross: g, grossUsd: (usd(g.asset, assetPx) ?? 0) + (usd(g.num, numPx) ?? 0), ...parts };
    };
    const d7 = split(win(nowT - WEEK)), d1 = split(win(nowT - DAY));
    const balA = b0 != null || b1 != null ? Number(BigInt((assetIs0 ? b0 : b1) || "0x0")) / 10 ** dA : null;
    const balN = b0 != null || b1 != null ? Number(BigInt((assetIs0 ? b1 : b0) || "0x0")) / 10 ** dN : null;
    const lp = lpBy.get(v.vault) || null;
    const lpUsd = lp ? lp.positionUsd : 0;
    const holdUsd = (balA != null && assetPx != null ? balA * assetPx : 0) + (balN != null && numPx != null ? balN * numPx : 0) + lpUsd;
    const lp7 = lp?.fees7dUsd ?? lp?.feesAllUsd ?? 0;
    const days = Math.min(7, opts.days7 || 7);
    const vault7 = (d7?.vault.usd ?? 0) + lp7;
    rows.push({
      vault: v.vault, asset, assetSymbol: meta.get(asset)?.symbol, numeraire: num, numeraireSymbol: meta.get(num)?.symbol,
      poolId: v.poolId, receiver: v.receiver, mode: v.mode, splits: sp, since: tm.at(v.block) ?? null,
      assetPx, numPx,
      holdings: { asset: balA, numeraire: balN, lpUsd: Math.round(lpUsd), usd: Math.round(holdUsd) },
      d1, d7,
      lpFees7dUsd: lp7 ? Math.round(lp7 * 100) / 100 : 0,
      /* the vault's own revenue (its kept shares plus LP fees), annualised over the
         days the fee record covers, over what it holds */
      vaultRevenue7dUsd: Math.round(vault7 * 100) / 100,
      apr: holdUsd > 0 && days > 0 ? +(vault7 * 365 / days / holdUsd).toFixed(4) : null,
    });
  }
  rows.sort((a, b) => (b.d7?.grossUsd ?? 0) - (a.d7?.grossUsd ?? 0));
  const tot = rows.reduce((s, r) => s + (r.d7?.grossUsd ?? 0), 0);
  log(`  community vaults: ${rows.length} vault(s); $${Math.round(tot).toLocaleString()} released to them over 7 days; top ${rows.slice(0, 3).map((r) => `${r.assetSymbol} $${Math.round(r.d7?.grossUsd ?? 0).toLocaleString()}`).join(", ")}`);
  return { state: S, rows };
}
