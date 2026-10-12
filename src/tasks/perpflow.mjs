import { getLogsRange, padAddr, rpc } from "../rpc.mjs";
import { AI } from "../config.mjs";
import { TOPICS } from "../decode.mjs";
import { AI_MARKET } from "./lighter.mjs";

/**
 * Lighter's AI perp and the chain: who takes the other side, and whether it shows
 * up in AI's own pools.
 *
 * A perp trade moves no AI by itself. What links the two venues is whoever sits on
 * the other side and hedges. Measured on 11 Oct 2026, over the 2.4 days after AINX
 * opened its AI leg:
 *   - Lighter's liquidity pool (LLP, account 281474976710654, no L1 wallet) was
 *     the largest short, 189K AI. It does not trade on this chain.
 *   - Account 21809, owned by wallet 0x446c...8862, was short 79K AI and sold
 *     AINX about 94K of it. The same wallet holds about 528K AI on chain and moved
 *     1.57M AI in and 1.08M out through Uniswap's routers over those days. In 14 of
 *     the 15 hours where both legs were over 3K AI, its on-chain AI flow and its
 *     perp flow went opposite ways: a hedger, buying spot as it sells perps and
 *     selling spot as it buys them back.
 * So the perp reaches AI's pools through that wallet, and this task follows it:
 * every AI perp trade on Lighter, per account per hour; the hedger's AI transfers
 * on chain, per hour; and positions, prices and funding, hourly, so whether any of
 * it leads the on-chain price can be tested once there is enough history.
 */
const API = "https://api.rh.lighter.xyz/api/v1";
export const HEDGER = { account: 21809, wallet: "0x446c759feb1da102cce53ce114aaf91451778862", label: "Lighter AI perp hedger" };
export const LLP_ACCOUNT = 281474976710654;
const HOUR = 3600, KEEP_HOURS = 24 * 45, FIRST_DAYS = 7, MAX_PAGES = 120, SIGNAL = 3000;

async function get(path) {
  const r = await fetch(`${API}/${path}`, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`lighter ${path.split("?")[0]}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.code != null && j.code !== 0 && j.code !== 200) throw new Error(`lighter ${path.split("?")[0]}: ${j.message || j.code}`);
  return j;
}
const n = (x) => (x == null || x === "" ? null : Number(x));
const hourOf = (t) => Math.floor(t / HOUR) * HOUR;

export async function indexPerpFlow(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const deadline = opts.deadline || Date.now() + 60_000;
  const now = Math.floor(Date.now() / 1000);
  const S = opts.state?.v === 1 ? opts.state : { v: 1, lastTradeId: null, perp: {}, chain: { cursor: null, h: {} }, wallets: {}, snaps: [] };
  const baskets = new Map((opts.basketAccounts || []).map((a) => [String(a.account), a.symbol]));

  /* 1. Every AI perp trade since the last run, newest first, folded into hourly
        per-account nets (a buyer +size, a seller -size) and hourly volume. */
  const stopAt = now - FIRST_DAYS * 86400;
  let cursor = null, newest = null, pages = 0, read = 0, done = false;
  const fresh = [];
  while (!done && pages < MAX_PAGES && Date.now() < deadline) {
    const j = await get(`trades?market_id=${AI_MARKET}&limit=100&sort_by=timestamp${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    const tr = j.trades || [];
    pages++;
    for (const t of tr) {
      const id = Number(t.trade_id), ts = Math.floor(Number(t.timestamp) / 1000);
      if (S.lastTradeId != null && id <= S.lastTradeId) { done = true; break; }
      if (ts < stopAt) { done = true; break; }
      newest = Math.max(newest ?? 0, id);
      fresh.push(t);
    }
    cursor = j.next_cursor;
    if (!cursor || !tr.length) done = true;
  }
  /* only advance the cursor when the walk reached what was already folded in, so a
     run cut short by its budget re-reads rather than leaving a hole */
  if (done) {
    for (const t of fresh) {
      const h = hourOf(Math.floor(Number(t.timestamp) / 1000)), size = n(t.size), px = n(t.price);
      const H = (S.perp[h] ||= { vol: 0, usd: 0, n: 0, acct: {} });
      H.vol += size; H.usd += size * px; H.n++;
      H.acct[t.bid_account_id] = (H.acct[t.bid_account_id] || 0) + size;
      H.acct[t.ask_account_id] = (H.acct[t.ask_account_id] || 0) - size;
      read++;
    }
    if (newest != null) S.lastTradeId = Math.max(S.lastTradeId ?? 0, newest);
  }

  /* 2. The hedger's AI on chain: every AI transfer into or out of its wallet,
        hourly. Swaps settle to the wallet, so this is its spot buying and selling
        (plus any plain transfer, which the hour's size makes plain). */
  const C = S.chain;
  if (C.cursor == null) C.cursor = (tm.blockAt(stopAt) ?? latest - FIRST_DAYS * 845_649) - 1;
  if (C.cursor < latest && Date.now() < deadline) {
    const snap = JSON.stringify(C.h);
    let reach = latest;
    for (const [topics, sign] of [[[TOPICS.TRANSFER, null, padAddr(HEDGER.wallet)], 1], [[TOPICS.TRANSFER, padAddr(HEDGER.wallet)], -1]]) {
      const r = await getLogsRange({ address: AI, topics }, C.cursor + 1, reach, { chunk: 1_000_000, deadline: deadline + 30_000,
        onLogs: (ls) => { for (const l of ls) { const t = tm.at(parseInt(l.blockNumber, 16)); if (t == null) continue; const h = hourOf(t); C.h[h] = (C.h[h] || 0) + sign * Number(BigInt(l.data)) / 1e18; } } });
      if (r.truncated) { C.h = JSON.parse(snap); reach = null; break; }
    }
    if (reach != null) C.cursor = reach;
  }

  /* 3. Positions now: the hedger's and the LLP's AI perp, the hedger's AI on chain. */
  const pos = async (idx) => {
    const a = (await get(`account?by=index&value=${idx}`)).accounts?.[0];
    const p = (a?.positions || []).find((x) => x.market_id === AI_MARKET);
    return { l1: a?.l1_address?.toLowerCase() || null, type: a?.account_type ?? null, equityUsd: n(a?.total_asset_value), ai: p ? (p.sign === -1 ? -1 : 1) * n(p.position) : 0, entry: p ? n(p.avg_entry_price) : null, upnlUsd: p ? n(p.unrealized_pnl) : null };
  };
  const [hedger, llp] = await Promise.all([pos(HEDGER.account).catch(() => null), pos(LLP_ACCOUNT).catch(() => null)]);
  const balHex = await rpc("eth_call", [{ to: AI, data: "0x70a08231" + HEDGER.wallet.slice(2).padStart(64, "0") }, "latest"]).catch(() => null);
  const hedgerChainAi = balHex && balHex !== "0x" ? Number(BigInt(balHex)) / 1e18 : null;

  /* 4. Who trades the perp, by volume over seven days, with each account's owner. */
  const wkH = hourOf(now) - 7 * 24 * HOUR;
  const vol7 = {};
  for (const [h, H] of Object.entries(S.perp)) if (+h >= wkH) for (const [a, v] of Object.entries(H.acct)) { const V = (vol7[a] ||= { net: 0 }); V.net += v; }
  const gross7 = {};
  for (const [h, H] of Object.entries(S.perp)) if (+h >= wkH) for (const [a, v] of Object.entries(H.acct)) gross7[a] = (gross7[a] || 0) + Math.abs(v);
  const topIds = Object.entries(gross7).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([a]) => a);
  for (const a of topIds) if (S.wallets[a] === undefined && Date.now() < deadline) {
    try { const p = await pos(a); S.wallets[a] = { l1: p.l1 && !/^0x0+$/.test(p.l1) ? p.l1 : null, type: p.type }; } catch { /* next run */ }
  }
  const labelOf = (a) => String(a) === String(LLP_ACCOUNT) ? "Lighter liquidity pool (LLP)" : String(a) === String(HEDGER.account) ? HEDGER.label : baskets.get(String(a)) ? `${baskets.get(String(a))} basket` : null;
  const traders = topIds.map((a) => ({ account: Number(a), label: labelOf(a), wallet: S.wallets[a]?.l1 ?? null, gross7d: Math.round(gross7[a]), net7d: Math.round(vol7[a].net) }));

  /* 5. Hourly rows for the chart and the hedge test. */
  const hours = [...new Set([...Object.keys(S.perp), ...Object.keys(C.h)])].map(Number).filter((h) => h >= hourOf(now) - KEEP_HOURS * HOUR).sort((a, b) => a - b);
  const bIds = [...baskets.keys()];
  const rows = hours.map((h) => {
    const A = S.perp[h]?.acct || {};
    const bsum = bIds.reduce((s, id) => s + (A[id] || 0), 0);
    return { t: h, chain: Math.round(C.h[h] || 0), perp: Math.round(A[HEDGER.account] || 0), llp: Math.round(A[LLP_ACCOUNT] || 0), baskets: Math.round(bsum), vol: Math.round(S.perp[h]?.vol || 0), usd: Math.round(S.perp[h]?.usd || 0) };
  });
  const test = (rs) => {
    const both = rs.filter((r) => Math.abs(r.chain) >= SIGNAL && Math.abs(r.perp) >= SIGNAL);
    const opp = both.filter((r) => Math.sign(r.chain) !== Math.sign(r.perp)).length;
    return { hours: rs.length, both: both.length, opposite: opp, share: both.length ? opp / both.length : null };
  };
  const last7 = rows.filter((r) => r.t >= wkH);
  const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0);
  const d1 = rows.filter((r) => r.t >= hourOf(now) - 24 * HOUR);

  /* 6. The signal log, one point an hour: everything a lead-lag test needs. */
  const M = opts.aiMarket || null;
  const lastSnap = S.snaps.at(-1);
  if (!lastSnap || now - lastSnap.t >= 3300) S.snaps.push({
    t: now, spot: opts.aiUsd ?? null, mark: M?.mark ?? null, index: M?.index ?? null, funding: M?.fundingRate ?? null, oi: M?.openInterest ?? null,
    hedgerPerp: hedger?.ai ?? null, hedgerChain: hedgerChainAi, llp: llp?.ai ?? null,
  });
  S.snaps = S.snaps.filter((p) => p.t >= now - KEEP_HOURS * HOUR);
  for (const h of Object.keys(S.perp)) if (+h < hourOf(now) - KEEP_HOURS * HOUR) delete S.perp[h];
  for (const h of Object.keys(C.h)) if (+h < hourOf(now) - KEEP_HOURS * HOUR) delete C.h[h];

  const out = {
    updatedAt: now,
    hedger: { ...HEDGER, perpAi: hedger?.ai ?? null, perpEntry: hedger?.entry ?? null, perpUpnlUsd: hedger?.upnlUsd ?? null, equityUsd: hedger?.equityUsd ?? null, chainAi: hedgerChainAi,
      chain24h: sum(d1, "chain"), perp24h: sum(d1, "perp"), chain7d: sum(last7, "chain"), perp7d: sum(last7, "perp") },
    llp: { account: LLP_ACCOUNT, perpAi: llp?.ai ?? null, equityUsd: llp?.equityUsd ?? null },
    test7d: test(last7), testAll: test(rows),
    traders, hours: rows.slice(-24 * 14), snaps: S.snaps,
    method: "Every trade in Lighter's AI perp (market 45 on api.rh.lighter.xyz), folded into hourly nets per account: a buyer adds the size, a seller subtracts it. The hedger is account 21809, owned by wallet 0x446c...8862, which trades AI on this chain as well; its on-chain flow is every AI transfer into or out of that wallet per hour. A hedging hour is one where both legs are at least 3,000 AI and point opposite ways. Positions are read from Lighter each run, the hedger's on-chain balance from AI's balanceOf. The hourly signal log (spot, mark, index, funding, open interest and the positions) is kept so a lead-lag test can be run once there are weeks of it.",
  };
  log(`  perp flow: ${read} new AI perp trade(s); hedger perp ${hedger?.ai != null ? Math.round(hedger.ai).toLocaleString() : "?"} AI, on chain ${hedgerChainAi != null ? Math.round(hedgerChainAi).toLocaleString() : "?"} AI; LLP ${llp?.ai != null ? Math.round(llp.ai).toLocaleString() : "?"} AI; hedging hours 7d ${out.test7d.opposite}/${out.test7d.both}`);
  return { state: S, artifact: out };
}
