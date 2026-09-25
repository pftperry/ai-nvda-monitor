/* LONG 500: stock-token fees from new stock-paired pools, into the AI reserve.
 *
 * The upgrade routes a slice of each new stock-paired pool's fees through a module
 * that anyone can trigger. One trigger, for one pool, does all of it: collects the
 * pool's fees through the LONG hook, sends half of the stock slice to the AI
 * Community Vault, spends the other half buying back the pool's paired token, and
 * burns the paired token it collected plus everything it bought.
 *
 * Found on chain rather than assumed. The vault receives from several places, and
 * two of them are traps:
 *   - three contracts with identical 11,293-byte code were sending the vault RSTOCK,
 *     OUTLAW and TUCK. They are memecoins, airdropped in one transaction to a list of
 *     the largest AI holders that happens to include the vault. Marketing, not fees.
 *   - the old fee splitter still sends AI and NVDA from the AI/NVDA pool, which is
 *     where almost all of the vault's stock came from.
 * The module is the 163-byte proxy at LONG500_MODULE (implementation at the EIP-1967
 * slot), and its own event is the record used here: one log per trigger, carrying
 * every amount, so nothing has to be inferred from transfers.
 *
 * Event 0x2ae758d6, decoded against one trigger's transfers:
 *   topic1 caller   topic2 paired token   topic3 pool id
 *   data0 stock token     data1 paired-token fees   data2 stock fees collected
 *   data3 stock to vault  data4 stock spent on buyback
 *   data5 paired bought   data6 paired burned (= data1 + data5)
 *
 * Dollar values use today's stock prices for what reached the vault, and for burns
 * the paired token's price in stock implied by that trigger's own buyback
 * (stock spent / paired bought), converted at today's stock price.
 */
import { rpc, getLogsRange } from "../rpc.mjs";

export const LONG500_MODULE = "0x80b4039a3851a6a369a5e63eaa4365b611dbe5d6";
const TRIGGER = "0x2ae758d637377505a78ed94a6eec59540aa25a87fb2664a5dd8b0acfeb369413";
/* before the first trigger (block 71,907,135), so nothing is missed */
const START_BLOCK = 71_800_000;
const DAY = 86400;
const STATE_V = 1;
const RECENT = 40;

const word = (d, i) => BigInt("0x" + d.slice(2 + i * 64, 2 + (i + 1) * 64));
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();

function decodeString(h) {
  try {
    if (!h || h === "0x") return null;
    if (h.length === 66) return Buffer.from(h.slice(2), "hex").toString().replace(/\0+$/, "") || null;
    const off = parseInt(h.slice(2, 66), 16) * 2, len = parseInt(h.slice(2 + off, 2 + off + 64), 16) * 2;
    return Buffer.from(h.slice(2 + off + 64, 2 + off + 64 + len), "hex").toString() || null;
  } catch { return null; }
}

async function tokenMeta(a, cache) {
  if (cache[a]) return cache[a];
  const call = (data) => rpc("eth_call", [{ to: a, data }, "latest"]).catch(() => null);
  const [s, d] = await Promise.all([call("0x95d89b41"), call("0x313ce567")]);
  const m = { symbol: decodeString(s) || a.slice(0, 8), decimals: d && d !== "0x" ? parseInt(d, 16) : 18 };
  cache[a] = m;
  return m;
}

function totalsFirstDay(T) {
  const ts = T.map((x) => x.t).filter((t) => t != null);
  return ts.length ? Math.floor(Math.min(...ts) / DAY) * DAY : null;
}

export async function indexLong500(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const prev = opts.state?.v === STATE_V ? opts.state : { v: STATE_V, cursor: START_BLOCK - 1, triggers: [], meta: {}, reserveDaily: {} };
  const S = { ...prev, triggers: [...(prev.triggers || [])], meta: { ...(prev.meta || {}) }, reserveDaily: { ...(prev.reserveDaily || {}) } };
  const stockUsd = opts.stockPrices || new Map();          // token -> USD, from the stock census
  let added = 0, partial = false;

  if (S.cursor < latest) {
    const r = await getLogsRange({ address: LONG500_MODULE, topics: [TRIGGER] }, S.cursor + 1, latest, {
      chunk: 2_000_000, deadline: opts.deadline,
    });
    for (const l of r) {
      const stock = topicAddr("0x" + l.data.slice(2, 66));
      const paired = topicAddr(l.topics[2]);
      const [sm, pm] = await Promise.all([tokenMeta(stock, S.meta), tokenMeta(paired, S.meta)]);
      const sd = 10 ** sm.decimals, pd = 10 ** pm.decimals;
      const block = parseInt(l.blockNumber, 16);
      S.triggers.push({
        t: tm.at(block) ?? null, block, tx: l.transactionHash,
        caller: topicAddr(l.topics[1]), paired, pool: l.topics[3], stock,
        pairedFee: Number(word(l.data, 1)) / pd,
        stockFee: Number(word(l.data, 2)) / sd,
        stockToVault: Number(word(l.data, 3)) / sd,
        stockToBuyback: Number(word(l.data, 4)) / sd,
        pairedBought: Number(word(l.data, 5)) / pd,
        pairedBurned: Number(word(l.data, 6)) / pd,
      });
      added++;
    }
    partial = !!r.truncated;
    S.cursor = r.truncated ? (r.reachedBlock ?? S.cursor) : latest;
  }

  /* aggregate */
  const T = S.triggers;
  const pxOf = (tok) => stockUsd.get(tok) ?? null;
  const byPool = new Map(), byStock = new Map(), byDay = new Map(), callers = new Set();
  let toVaultUsd = 0, buybackUsd = 0, burnedUsd = 0, unpricedTriggers = 0;
  for (const x of T) {
    callers.add(x.caller);
    const px = pxOf(x.stock);
    const pairedPxStock = x.pairedBought > 0 ? x.stockToBuyback / x.pairedBought : null;
    const vUsd = px == null ? null : x.stockToVault * px;
    const bUsd = px == null ? null : x.stockToBuyback * px;
    const burnUsd = px == null || pairedPxStock == null ? null : x.pairedBurned * pairedPxStock * px;
    if (px == null) unpricedTriggers++;
    toVaultUsd += vUsd || 0; buybackUsd += bUsd || 0; burnedUsd += burnUsd || 0;

    const P = byPool.get(x.pool) || { pool: x.pool, paired: x.paired, stock: x.stock, triggers: 0, stockToVault: 0, stockToBuyback: 0, pairedBurned: 0, burnedUsd: 0, toVaultUsd: 0, first: x.t, last: x.t };
    P.triggers++; P.stockToVault += x.stockToVault; P.stockToBuyback += x.stockToBuyback; P.pairedBurned += x.pairedBurned;
    P.burnedUsd += burnUsd || 0; P.toVaultUsd += vUsd || 0; P.last = Math.max(P.last ?? 0, x.t ?? 0);
    byPool.set(x.pool, P);

    const K = byStock.get(x.stock) || { stock: x.stock, units: 0, usd: 0, pools: new Set(), triggers: 0 };
    K.units += x.stockToVault; K.usd += vUsd || 0; K.pools.add(x.pool); K.triggers++;
    byStock.set(x.stock, K);

    if (x.t != null) {
      const d = Math.floor(x.t / DAY) * DAY;
      const D = byDay.get(d) || { t: d, triggers: 0, toVaultUsd: 0, burnedUsd: 0, buybackUsd: 0 };
      D.triggers++; D.toVaultUsd += vUsd || 0; D.burnedUsd += burnUsd || 0; D.buybackUsd += bUsd || 0;
      byDay.set(d, D);
    }
  }
  const sym = (a) => S.meta[a]?.symbol || a.slice(0, 8);

  /* the last 24 hours, by trigger time against the head */
  const headT = tm.at(latest) ?? Math.floor(Date.now() / 1000);
  const day = T.filter((x) => x.t != null && x.t > headT - DAY);
  const last24h = { triggers: day.length, pools: new Set(day.map((x) => x.pool)).size, toVaultUsd: 0, buybackUsd: 0, burnedUsd: 0 };
  for (const x of day) {
    const px = pxOf(x.stock), pp = x.pairedBought > 0 ? x.stockToBuyback / x.pairedBought : null;
    if (px != null) { last24h.toVaultUsd += x.stockToVault * px; last24h.buybackUsd += x.stockToBuyback * px; if (pp != null) last24h.burnedUsd += x.pairedBurned * pp * px; }
  }
  for (const k of ["toVaultUsd", "buybackUsd", "burnedUsd"]) last24h[k] = Math.round(last24h[k] * 100) / 100;

  /* Share of each paired token's supply burned. The module burns through the token's
     own burn, which lowers totalSupply, so the supply before these burns is today's
     supply plus what was burned; measured against that, the share is not flattered by
     the shrinking denominator. Read fresh each run, since supply moves. */
  const supplyNow = {};
  await Promise.all([...byPool.values()].map(async (P) => {
    const r = await rpc("eth_call", [{ to: P.paired, data: "0x18160ddd" }, "latest"]).catch(() => null);
    if (r && r !== "0x") supplyNow[P.paired] = Number(BigInt(r)) / 10 ** (S.meta[P.paired]?.decimals ?? 18);
  }));

  /* The reserve as it stands, split by where it came from. The stock census reads the
     vault's balance of every stock token; what LONG 500 sent is known exactly from its
     events; the difference is everything else -- overwhelmingly NVDA from the old fee
     splitter, plus a few round-number transfers. Without this split the old NVDA pile
     would be read as the programme's work. */
  const long500Units = new Map([...byStock].map(([a, k]) => [a, k.units]));
  const holdings = (opts.vaultStocks || []).filter((h) => h.units > 0);
  for (const [a, u] of long500Units) if (!holdings.some((h) => h.token === a)) holdings.push({ token: a, symbol: sym(a), units: u, priceUsd: pxOf(a) });
  const reserve = holdings.map((h) => {
    const l5 = Math.min(long500Units.get(h.token) || 0, Math.max(h.units, long500Units.get(h.token) || 0));
    const px = h.priceUsd ?? pxOf(h.token);
    return { token: h.token, symbol: h.symbol || sym(h.token), units: +h.units.toPrecision(8), usd: px == null ? null : Math.round(h.units * px * 100) / 100,
      long500Units: +l5.toPrecision(8), long500Usd: px == null ? null : Math.round(l5 * px * 100) / 100 };
  }).sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const stockTotal = reserve.reduce((s, r) => s + (r.usd || 0), 0);
  const shares = reserve.map((r) => (stockTotal > 0 ? (r.usd || 0) / stockTotal : 0));
  const hhi = Math.round(shares.reduce((s, x) => s + x * x, 0) * 10_000);
  const aiUnits = opts.vaultAi ?? null, aiUsd = opts.aiUsd ?? null;

  /* one reserve reading per day, the last of the day, so its diversity can be watched */
  const headDay = Math.floor((tm.at(latest) ?? Date.now() / 1000) / DAY) * DAY;
  if (reserve.length) S.reserveDaily[headDay] = {
    stocks: reserve.filter((r) => r.units > 0).length, stockUsd: Math.round(stockTotal),
    top1: shares.length ? +Math.max(...shares).toFixed(4) : null, hhi,
    long500Usd: Math.round(toVaultUsd), aiUnits: aiUnits == null ? null : Math.round(aiUnits),
  };

  /* VAULT NAV, and where its movement comes from.

     The vault is mostly AI by value -- about 8.7M AI against a few hundred thousand
     dollars of stock -- so its dollar NAV moves mainly with AI's own price. That makes
     a headline NAV change partly circular: AI rising lifts the NAV that is meant to be
     a reason for AI to rise. So the change is split into its sources, and the page
     shows the split beside the total.

     History is rebuilt from the burn ledger rather than waiting for snapshots to
     accumulate: each day's vault AI is the cumulative AI locked by the fee split,
     each day's NVDA the cumulative NVDA it received, priced at that day's AI close and
     NVDA close. AI and NVDA are over 99% of the vault, so the rebuilt line is AI plus
     NVDA; today's full NAV, every stock included, is given separately. */
  const priceAt = opts.priceAt || (() => null);
  const nvdaClose = new Map((opts.nvdaCloses || []).map(([t, v]) => [Math.floor(t / DAY) * DAY, v]));
  const closeOn = (d) => { for (let k = 0; k < 5; k++) { const v = nvdaClose.get(d - k * DAY); if (v) return v; } return null; };
  let nvdaCum = 0;
  const navDaily = [];
  for (const r of (opts.burnsDaily || [])) {
    nvdaCum += r.nvdaIn || 0;
    const aiPx = priceAt(r.t + DAY - 1), nPx = closeOn(r.t);
    const ai = r.cumLockAI ?? null;
    if (ai == null || aiPx == null) continue;
    navDaily.push({ t: r.t, aiUnits: Math.round(ai), nvdaUnits: +nvdaCum.toFixed(4), aiPx, nvdaPx: nPx,
      aiUsd: Math.round(ai * aiPx), nvdaUsd: nPx == null ? null : Math.round(nvdaCum * nPx),
      navUsd: Math.round(ai * aiPx + (nPx == null ? 0 : nvdaCum * nPx)) });
  }
  /* Since LONG 500 went live: the day of the first trigger is the baseline, and the
     change to today is attributed. New AI locked is valued at today's price; the AI
     price effect is the baseline's AI re-priced; the same for NVDA; other stock is
     what LONG 500 and the other inflows added. Terms sum to the change. */
  let sinceLaunch = null;
  const launchDay = totalsFirstDay(T);
  if (launchDay != null && navDaily.length) {
    const base = navDaily.filter((r) => r.t <= launchDay).at(-1) || navDaily[0];
    const now = navDaily.at(-1);
    const aiNewUnits = now.aiUnits - base.aiUnits, nvNewUnits = now.nvdaUnits - base.nvdaUnits;
    const parts = {
      aiPrice: Math.round(base.aiUnits * (now.aiPx - base.aiPx)),
      aiAdded: Math.round(aiNewUnits * now.aiPx),
      nvdaPrice: now.nvdaPx != null && base.nvdaPx != null ? Math.round(base.nvdaUnits * (now.nvdaPx - base.nvdaPx)) : 0,
      nvdaAdded: now.nvdaPx != null ? Math.round(nvNewUnits * now.nvdaPx) : 0,
    };
    sinceLaunch = { baseT: base.t, baseNavUsd: base.navUsd, nowNavUsd: now.navUsd,
      change: base.navUsd > 0 ? +(now.navUsd / base.navUsd - 1).toFixed(4) : null, parts };
  }
  const navNowUsd = (aiUnits != null && aiUsd ? aiUnits * aiUsd : 0) + stockTotal;

  /* PROGRESS, hourly and cumulative. The programme is days old, so a daily series
     would be a single dot; an hourly one shows it filling from the first trigger.
     Each row carries running totals -- stock to the vault, spent on buybacks, paired
     tokens burned, and distinct pools, stocks and callers -- so the chart is the
     programme's whole history at every point. Hours with no trigger are omitted; the
     running totals simply carry across them. */
  const HOUR = 3600;
  const hourMap = new Map();
  const seenPools = new Set(), seenStocks = new Set(), seenCallers = new Set();
  for (const x of [...T].sort((a, b) => (a.t ?? 0) - (b.t ?? 0))) {
    if (x.t == null) continue;
    const h = Math.floor(x.t / HOUR) * HOUR;
    const px = pxOf(x.stock), pp = x.pairedBought > 0 ? x.stockToBuyback / x.pairedBought : null;
    const H = hourMap.get(h) || { t: h, triggers: 0, toVaultUsd: 0, buybackUsd: 0, burnedUsd: 0 };
    H.triggers++;
    if (px != null) { H.toVaultUsd += x.stockToVault * px; H.buybackUsd += x.stockToBuyback * px; if (pp != null) H.burnedUsd += x.pairedBurned * pp * px; }
    seenPools.add(x.pool); seenStocks.add(x.stock); seenCallers.add(x.caller);
    H.pools = seenPools.size; H.stocks = seenStocks.size; H.callers = seenCallers.size;
    hourMap.set(h, H);
  }
  let cT = 0, cV = 0, cB = 0, cBu = 0;
  const progress = [...hourMap.values()].sort((a, b) => a.t - b.t).map((H) => {
    cT += H.triggers; cV += H.toVaultUsd; cB += H.burnedUsd; cBu += H.buybackUsd;
    return { t: H.t, triggers: cT, toVaultUsd: +cV.toFixed(4), burnedUsd: +cB.toFixed(4), buybackUsd: +cBu.toFixed(4),
      pools: H.pools, stocks: H.stocks, callers: H.callers };
  });

  /* VAULT INFLOWS BY SOURCE. LONG 500 pays into the same Community Vault as the
     original fee split -- one contract, 0xd14d...8630 -- so separating the two is a
     matter of source, not address. The original split's daily AI and NVDA come from
     the fee ledger, priced at that day's close; LONG 500's from its own events. */
  const bySource = [];
  const l5Day = new Map([...byDay.values()].map((d) => [d.t, d.toVaultUsd]));
  for (const r of (opts.burnsDaily || []).slice(-60)) {
    const aiPx = priceAt(r.t + DAY - 1), nPx = closeOn(r.t);
    const orig = (aiPx == null ? 0 : (r.lockAI || 0) * aiPx) + (nPx == null ? 0 : (r.nvdaIn || 0) * nPx);
    bySource.push({ t: r.t, originalUsd: Math.round(orig * 100) / 100, long500Usd: Math.round((l5Day.get(r.t) || 0) * 100) / 100 });
  }
  for (const [t, v] of l5Day) if (!bySource.some((r) => r.t === t)) bySource.push({ t, originalUsd: 0, long500Usd: Math.round(v * 100) / 100 });
  bySource.sort((a, b) => a.t - b.t);

  const universe = opts.universe ?? null;
  const pools = [...byPool.values()].map((P) => ({
    ...P, pairedSymbol: sym(P.paired), stockSymbol: sym(P.stock),
    burnedPctOfSupply: supplyNow[P.paired] > 0 ? +(P.pairedBurned / (supplyNow[P.paired] + P.pairedBurned)).toFixed(8) : null,
    stockToVault: +P.stockToVault.toPrecision(8), stockToBuyback: +P.stockToBuyback.toPrecision(8), pairedBurned: +P.pairedBurned.toPrecision(8),
    burnedUsd: Math.round(P.burnedUsd * 100) / 100, toVaultUsd: Math.round(P.toVaultUsd * 100) / 100,
  })).sort((a, b) => b.toVaultUsd - a.toVaultUsd || b.triggers - a.triggers);

  const totals = {
    triggers: T.length, pools: byPool.size, callers: callers.size,
    stocksContributing: byStock.size,
    toVaultUsd: Math.round(toVaultUsd * 100) / 100,
    buybackUsd: Math.round(buybackUsd * 100) / 100,
    burnedUsd: Math.round(burnedUsd * 100) / 100,
    unpricedTriggers,
    last24h,
    firstT: T.length ? Math.min(...T.map((x) => x.t ?? Infinity)) : null,
    lastT: T.length ? Math.max(...T.map((x) => x.t ?? 0)) : null,
  };
  log(`  long500: ${added} new trigger(s), ${totals.triggers} in all across ${totals.pools} pool(s) and ${totals.stocksContributing} stock(s); $${totals.toVaultUsd} to the vault, $${totals.burnedUsd} burned; reserve ${reserve.length} stock(s), $${Math.round(stockTotal).toLocaleString()}, top holding ${shares.length ? (100 * Math.max(...shares)).toFixed(1) : "-"}%${partial ? " (partial)" : ""}`);

  return {
    state: S,
    artifact: {
      /* the block this artifact is complete to, and each token's symbol and decimals,
         so the page can read newer triggers straight from the chain and decode them
         the same way between index runs */
      module: LONG500_MODULE, cursor: S.cursor, meta: S.meta, partial, totals,
      reserve: { stocks: reserve, stockUsd: Math.round(stockTotal), hhi, top1: shares.length ? +Math.max(...shares).toFixed(4) : null,
        stocksHeld: reserve.filter((r) => r.units > 0).length, universe, aiUnits, aiUsdValue: aiUnits != null && aiUsd ? Math.round(aiUnits * aiUsd) : null },
      nav: { nowUsd: Math.round(navNowUsd), sinceLaunch, daily: navDaily.slice(-120) },
      vaultAddress: "0xd14d2eeb9648f53fa153a218eeed908789c28630",
      progress: progress.slice(-24 * 120),
      bySource,
      pools,
      byStock: [...byStock.values()].map((k) => ({ stock: k.stock, symbol: sym(k.stock), units: +k.units.toPrecision(8), usd: Math.round(k.usd * 100) / 100, pools: k.pools.size, triggers: k.triggers })).sort((a, b) => b.usd - a.usd),
      daily: [...byDay.values()].sort((a, b) => a.t - b.t).map((d) => ({ ...d, toVaultUsd: Math.round(d.toVaultUsd * 100) / 100, burnedUsd: Math.round(d.burnedUsd * 100) / 100, buybackUsd: Math.round(d.buybackUsd * 100) / 100 })),
      reserveDaily: Object.entries(S.reserveDaily).map(([t, v]) => ({ t: +t, ...v })).sort((a, b) => a.t - b.t),
      recent: T.slice(-RECENT).reverse().map((x) => ({ ...x, pairedSymbol: sym(x.paired), stockSymbol: sym(x.stock) })),
      method: "Every trigger of the LONG 500 module, from its own event: stock fees collected, the half sent to the AI Community Vault, the half spent buying back the pool's paired token, and the paired token burned. Stock reaching the vault is valued at today's stock price; burns at the paired token's price implied by each trigger's own buyback, converted at today's stock price. The reserve is the vault's balance of every stock token, split into what LONG 500 sent and everything else, most of which is NVDA from the original fee splitter. Tokens airdropped to the vault that are not stock tokens are excluded.",
    },
  };
}
