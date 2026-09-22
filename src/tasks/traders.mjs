import { getLogsRange } from "../rpc.mjs";
import { AI, POOL_MANAGER, LONG_HOOK, LONG_BUYBACK, COMMUNITY_VAULT, BURN_ADDRESS, PLATFORM_FEE_RECIPIENT } from "../config.mjs";
import { TOPICS, decodeTransfer, fmtUnits } from "../decode.mjs";

/**
 * Who is actually buying and selling AI, and how concentrated that is.
 *
 * The swap event names a sender, but on this chain that is almost always a router,
 * so counting senders tells you which aggregator is busy rather than who traded. The
 * transfer tape answers it without a single extra request: inside one transaction,
 * net every address's AI movement. Routers and pools come out at roughly zero
 * because whatever they take in they pass straight on; the wallet that actually sold
 * is the one left deeply negative, and the buyer the one left positive. The 17 Sep
 * sell is the worked example: six transfer hops through two routers, one wallet at
 * minus 6.1M AI.
 *
 * Only transactions that touch a pool count, so wallet-to-wallet moves and bridge
 * traffic stay out of the trading figures. Balances and ranks are joined from the
 * holders task so "one of the top twenty-five is selling" is a fact on the page
 * rather than an inference.
 */
const DAY = 86400;

export async function indexTraders(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const aiUsd = opts.aiUsd || 0;
  const windowSecs = opts.windowSecs ?? DAY;
  /* Several windows off ONE scan. The panel looked frozen and was not: a trailing
     day barely moves between refreshes, because a wallet that sold twenty hours ago
     still tops the list at every one of the four refreshes an hour. The fix is a
     shorter window, not a faster refresh, and the shorter ones are free -- the scan
     already reads the whole day and every transaction already carries its own
     timestamp, so the extra windows cost arithmetic and no requests. */
  const windowSet = opts.windows ?? [3600, 6 * 3600, DAY];
  const spanSecs = Math.max(windowSecs, ...windowSet);
  const winLabel = (secs) => (secs >= DAY ? `${Math.round(secs / DAY)}d` : `${Math.round(secs / 3600)}h`);
  const minAi = opts.minAi ?? 5_000;
  const keep = opts.keep ?? 20;
  const topHolders = opts.topHolders || [];
  if (!(aiUsd > 0)) { log(`  traders: no AI price, skipped`); return null; }

  /* Pools and protocol machinery: their per-transaction net is an artefact of the
     trade, not a position, so they are never reported as traders. Any address that
     holds a LONG pool's AI counts here too. */
  const machinery = new Set([POOL_MANAGER, LONG_HOOK, LONG_BUYBACK, COMMUNITY_VAULT, BURN_ADDRESS, PLATFORM_FEE_RECIPIENT,
    "0x0000000000000000000000000000000000000000"].map((a) => a.toLowerCase()));
  for (const a of opts.extraMachinery || []) machinery.add(a.toLowerCase());

  const nowT = tm.at(latest) ?? Math.floor(Date.now() / 1000);
  const since = nowT - windowSecs;
  const scanSince = nowT - spanSecs;
  const from = tm.blockAt(scanSince) ?? Math.max(1, latest - Math.round(spanSecs / 0.5));

  /* One scan of AI's own transfer tape over the window, grouped by transaction. */
  const perTx = new Map();
  let logsSeen = 0;
  const r = await getLogsRange({ address: AI, topics: [TOPICS.TRANSFER] }, from, latest, {
    chunk: 120_000, deadline: opts.deadline,
    onLogs: (logsIn) => {
      for (const l of logsIn) {
        const t = decodeTransfer(l);
        if (t.from === t.to) continue;
        const ts = tm.at(t.block); if (ts == null || ts < scanSince) continue;
        const v = Number(fmtUnits(t.value, 18));
        if (!(v > 0)) continue;
        logsSeen++;
        const T = perTx.get(l.transactionHash) || { t: ts, net: new Map(), touchedPool: false };
        T.t = Math.min(T.t, ts);
        if (machinery.has(t.from) || machinery.has(t.to)) T.touchedPool = true;
        T.net.set(t.from, (T.net.get(t.from) || 0) - v);
        T.net.set(t.to, (T.net.get(t.to) || 0) + v);
        perTx.set(l.transactionHash, T);
      }
    },
  });

  const rank = new Map(topHolders.map((h, i) => [h.address.toLowerCase(), { rank: i + 1, balance: h.ai }]));

  /* Per transaction, the deepest negative wallet sold and the deepest positive
     bought; everything in between is plumbing. Run once per window over the same
     scanned transactions, keeping only those inside the cutoff. */
  const summarise = (secs) => {
    const cut = nowT - secs;
    const acct = new Map();
    const bump = (addr, field, v, tx) => {
      const a = acct.get(addr) || { address: addr, soldAi: 0, boughtAi: 0, sellTx: 0, buyTx: 0, lastT: 0 };
      a[field] += v;
      if (field === "soldAi") a.sellTx++; else a.buyTx++;
      a.lastT = Math.max(a.lastT, tx);
      acct.set(addr, a);
    };
    let trades = 0, seen = 0;
    for (const T of perTx.values()) {
      if (T.t < cut) continue;
      seen++;
      if (!T.touchedPool) continue;                       // not a trade: a plain transfer
      let seller = null, buyer = null;
      for (const [addr, v] of T.net) {
        if (machinery.has(addr)) continue;
        if (Math.abs(v) < 1e-9) continue;                 // a router that passed it straight through
        if (v < 0 && (!seller || v < seller[1])) seller = [addr, v];
        if (v > 0 && (!buyer || v > buyer[1])) buyer = [addr, v];
      }
      if (seller && -seller[1] >= minAi) { bump(seller[0], "soldAi", -seller[1], T.t); trades++; }
      if (buyer && buyer[1] >= minAi) { bump(buyer[0], "boughtAi", buyer[1], T.t); trades++; }
    }
    const rows = [...acct.values()].map((a) => {
      const h = rank.get(a.address);
      return { ...a, netAi: +(a.boughtAi - a.soldAi).toFixed(3), soldAi: +a.soldAi.toFixed(3), boughtAi: +a.boughtAi.toFixed(3),
        soldUsd: Math.round(a.soldAi * aiUsd), boughtUsd: Math.round(a.boughtAi * aiUsd),
        holderRank: h?.rank ?? null, balance: h ? +h.balance.toFixed(0) : null,
        sharePctOfBalance: h?.balance > 0 ? +(a.soldAi / h.balance).toFixed(4) : null };
    });
    const sellers = rows.filter((r) => r.soldAi > 0).sort((a, b) => b.soldAi - a.soldAi);
    const buyers = rows.filter((r) => r.boughtAi > 0).sort((a, b) => b.boughtAi - a.boughtAi);
    const totalSold = sellers.reduce((s, r) => s + r.soldAi, 0);
    const totalBought = buyers.reduce((s, r) => s + r.boughtAi, 0);
    const share = (arr, n, total, key) => total > 0 ? +(arr.slice(0, n).reduce((s, r) => s + r[key], 0) / total).toFixed(4) : null;
    const holderSellers = sellers.filter((r) => r.holderRank != null);
    return {
      since: cut, windowSecs: secs, label: winLabel(secs), aiUsd,
      transfersSeen: logsSeen, txInWindow: seen, tradesAttributed: trades,
      totalSoldAi: +totalSold.toFixed(3), totalBoughtAi: +totalBought.toFixed(3),
      totalSoldUsd: Math.round(totalSold * aiUsd), totalBoughtUsd: Math.round(totalBought * aiUsd),
      concentration: {
        sellTop1: share(sellers, 1, totalSold, "soldAi"), sellTop5: share(sellers, 5, totalSold, "soldAi"), sellTop10: share(sellers, 10, totalSold, "soldAi"),
        buyTop1: share(buyers, 1, totalBought, "boughtAi"), buyTop5: share(buyers, 5, totalBought, "boughtAi"), buyTop10: share(buyers, 10, totalBought, "boughtAi"),
        sellers: sellers.length, buyers: buyers.length,
      },
      topSellers: sellers.slice(0, keep), topBuyers: buyers.slice(0, keep),
      holderSellers: holderSellers.slice(0, keep),
    };
  };

  const windows = {};
  for (const secs of [...new Set([...windowSet, windowSecs])].sort((a, b) => a - b)) windows[winLabel(secs)] = summarise(secs);
  const main = windows[winLabel(windowSecs)];
  /* The day stays at the top level so anything reading this artifact keeps working;
     the shorter windows sit beside it under `windows`. */
  const out = {
    ...main,
    partial: !!r.truncated,
    windows,
    method: "every AI transfer over the window grouped by transaction; inside a transaction each address's AI is netted, so routers and pools cancel to nothing and the wallet left most negative is the seller, most positive the buyer. Only transactions touching a pool or protocol contract count as trades. Ranks and balances are joined from the holders task. One scan covers the widest window and the shorter ones are cut from the same transactions.",
  };
  log(`  traders: ${Object.entries(windows).map(([k, w]) => `${k} ${w.concentration.sellers} selling / ${w.concentration.buyers} buying`).join(", ")}; over ${minAi.toLocaleString()} AI; ${winLabel(windowSecs)} top seller ${out.concentration.sellTop1 != null ? (100 * out.concentration.sellTop1).toFixed(0) + "%" : "—"} of sold volume${main.holderSellers.length ? `; ${main.holderSellers.length} ranked holder(s) sold` : ""}`);
  return out;
}
