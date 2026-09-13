/**
 * An hourly panel of every rating input, beside price.
 *
 * Written for a specific purpose: to study, over the coming weeks, which of these
 * actually relate to price and how they should be weighted. That study needs one
 * tidy panel rather than a reconstruction across five artifacts with different
 * shapes and different retention.
 *
 * It records the INPUTS, not the score. The score is a weighted sum, and the whole
 * question the study exists to answer is what those weights should be -- so storing
 * the output would bake in today's guess and make the exercise circular. With the
 * inputs kept, any weighting can be evaluated after the fact, including ones nobody
 * has thought of yet.
 *
 * Most of this is also derivable retroactively from the existing artifacts, and
 * deliberately so: price and flow go back 60 days, fees 47. What is NOT recoverable
 * is cross-routing before the routing series began, depth before today, and organic
 * bridge share at any past moment at all -- that one has never had a time series,
 * which is why a rotating measurement of it can be shown but never trended.
 */
import { AI_NVDA_POOL } from "../config.mjs";

const DAY = 86400;

const trailing = (rows, n, pick, off = 0) => {
  const end = rows.length - off;
  return rows.slice(Math.max(0, end - n), end).reduce((s, r) => s + (pick(r) || 0), 0);
};

/** Whole days only: a part-formed day drags every rate toward zero. */
const completeDays = (rows, now) => {
  const today = Math.floor(now / DAY) * DAY;
  return (rows || []).filter((r) => r.t < today);
};

export function snapshotKpis({ flow, burns, routing, bridges, depth, holders, prices, rwa, now, prior }) {
  const hour = Math.floor(now / 3600) * 3600;

  // Price: the busiest AI/USDG venue, the same anchor the page treats as canonical.
  const usdg = (flow.pools || []).filter((p) => p.pairSymbol === "USDG")
    .sort((a, b) => (b.totalSwaps || 0) - (a.totalSwaps || 0))[0];
  const aiUsd = usdg?.hourly?.filter((h) => h.close > 0).at(-1)?.close ?? null;

  // Fees, and the week-on-week change the rating scores.
  const bDaily = completeDays(burns?.daily, now);
  const fee7 = trailing(bDaily, 7, (d) => (d.burnAI || 0) + (d.lockAI || 0) + (d.platformAI || 0));
  const fee7p = trailing(bDaily, 7, (d) => (d.burnAI || 0) + (d.lockAI || 0) + (d.platformAI || 0), 7);
  const feeAnnual = (fee7 / 7) * 365;
  const feeTrend = fee7p > 0 ? fee7 / fee7p - 1 : null;

  /* Leakage and capture, over days where BOTH kinds of venue traded. A day with only
     one kind gives a ratio of 1 or 0 by construction, and mixing those into a series
     that will later be correlated against price would manufacture a signal out of
     the indexed set having grown. */
  const perDay = new Map();
  for (const p of flow.pools || []) {
    const isMain = p.poolId.toLowerCase() === AI_NVDA_POOL.toLowerCase();
    for (const h of p.hourly || []) {
      const v = (h.aiBuy || 0) + (h.aiSell || 0);
      if (!(v > 0)) continue;
      const d = Math.floor(h.t / DAY) * DAY;
      const row = perDay.get(d) || { t: d, hooked: 0, hookless: 0, main: 0, total: 0, kinds: new Set() };
      if (p.isLongHook) { row.hooked += v; row.kinds.add("h"); } else { row.hookless += v; row.kinds.add("n"); }
      if (isMain) row.main += v;
      row.total += v;
      perDay.set(d, row);
    }
  }
  const days = [...perDay.values()].filter((r) => r.t < Math.floor(now / DAY) * DAY).sort((a, b) => a.t - b.t);
  const last = days.at(-1);
  const leak = last && last.kinds.size > 1 ? last.hookless / Math.max(1e-9, last.total) : null;
  // Fee capture: the tolled pool's share, on days where it had competition at all.
  const capture = last && last.kinds.size > 1 ? last.main / Math.max(1e-9, last.total) : null;

  // Net flow over the last seven complete days, from the buy/sell split.
  const flowDays = new Map();
  for (const p of flow.pools || []) {
    for (const h of p.hourly || []) {
      const d = Math.floor(h.t / DAY) * DAY;
      const r = flowDays.get(d) || { t: d, net: 0 };
      r.net += (h.aiBuy || 0) - (h.aiSell || 0);
      flowDays.set(d, r);
    }
  }
  const fd = [...flowDays.values()].filter((r) => r.t < Math.floor(now / DAY) * DAY).sort((a, b) => a.t - b.t);
  const net7 = trailing(fd, 7, (r) => r.net);

  /* A value only counts as this hour's reading if its artifact was written
     recently. Bridges refresh on the slow path, and when that path stopped firing
     for a day this panel stamped the same 1.37% onto every hourly row -- which a
     correlation study reads as a quiet, perfectly stable series rather than as no
     data. Past eight hours the field is recorded as missing. */
  const FRESH = 8 * 3600;
  const fresh = (a) => !!a && now - (a.updatedAt || 0) <= FRESH;
  const org = fresh(bridges) ? bridges.byKind?.organic : null;

  /* Holder breadth and concentration, from the latest replay snapshot, and the
     churn behind them over the last complete day (six four-hour rows). These are
     the demand-side inputs the rating now reads, so the study needs them too. */
  const snaps = (holders?.snapshots || []).filter((s) => s.holders > 0);
  const hs = snaps.at(-1) || null;
  const dayRows = snaps.slice(-6);
  /* Wallets that net-bought per day, from the replay's per-transaction netting.
     The flow index's per-hour "buyers" are v4 Swap senders, which are routers. */
  const buyers = new Map();
  for (const s of snaps) {
    if (s.buyers == null) continue;
    const d = Math.floor((s.t - 1) / DAY) * DAY;
    const r = buyers.get(d) || { n: 0, rows: 0 };
    r.n += s.buyers; r.rows++;
    buyers.set(d, r);
  }
  const bd = [...buyers.entries()].filter(([t, r]) => r.rows === 6 && t < Math.floor(now / DAY) * DAY).sort((a, b) => a[0] - b[0]);
  const buyers7 = bd.slice(-7).reduce((s, [, r]) => s + r.n, 0) / Math.max(1, Math.min(7, bd.length));

  /* Dollar volume over the last complete day, priced hour by hour from the busiest
     USDG venue, so a price move inside the day is not averaged away. */
  const closeByHour = new Map((usdg?.hourly || []).filter((h) => h.close > 0).map((h) => [h.t, h.close]));
  let volUsd = 0;
  const lastDay = Math.floor(now / DAY) * DAY - DAY;
  for (const p of flow.pools || []) {
    for (const h of p.hourly || []) {
      if (h.t < lastDay || h.t >= lastDay + DAY) continue;
      const px = closeByHour.get(h.t) ?? aiUsd;
      if (px) volUsd += ((h.aiBuy || 0) + (h.aiSell || 0)) * px;
    }
  }

  const row = {
    t: hour,
    aiUsd,
    feeAnnual: feeAnnual || null,
    feeTrend,
    leak,
    capture,
    kappa: routing?.measuredKappaRatio ?? null,
    nvdaPerDay: bDaily.length ? trailing(bDaily, 7, (d) => d.nvdaIn) / 7 : null,
    removedPerDay: bDaily.length ? trailing(bDaily, 7, (d) => (d.burnAI || 0) + (d.lockAI || 0)) / 7 : null,
    supplyRemoved: burns ? (burns.burned + (burns.vault?.aiBalance || 0)) / burns.genesisSupply : null,
    net7,
    organicShare: org ? (org.weightedShare ?? org.medianShare ?? null) : null,
    depthImbalance: depth?.imbalanceUsd ?? null,
    depthBid: depth?.bidUsd ?? null,
    depthAsk: depth?.askUsd ?? null,
    // The band a trade actually reaches; the +/-50% figures above are dominated by
    // out-of-range liquidity and read bid-heavy when the near book is level.
    nearBid: depth?.near?.[0]?.bidUsd ?? null,
    nearAsk: depth?.near?.[0]?.askUsd ?? null,
    holders: hs?.holders ?? null,
    holders100k: hs?.aboveAi?.[1] ?? null,
    top10Share: hs?.top?.[0] ?? null,
    top100Share: hs?.top?.[2] ?? null,
    newHolders24h: dayRows.length === 6 && dayRows.every((s) => s.newHolders != null) ? dayRows.reduce((s, x) => s + x.newHolders, 0) : null,
    exits24h: dayRows.length === 6 && dayRows.every((s) => s.exits != null) ? dayRows.reduce((s, x) => s + x.exits, 0) : null,
    buyers7d: bd.length ? Math.round(buyers7) : null,
    volumeUsd24h: volUsd ? Math.round(volUsd) : null,
    nvdaUsd: fresh(prices) ? (prices.nvdaUsd ?? null) : null,
    /* The platform view: stock supply and stock trading captured, liquidity size
       and the protocol's share of it, and what a $1M sale would move the price. */
    stockShare: fresh(rwa) ? (rwa.totals?.share ?? null) : null,
    stockSwapShare: fresh(rwa) ? (rwa.swapShare?.share ?? null) : null,
    stockDexUsd: fresh(rwa) ? (rwa.totals?.dexUsd ?? null) : null,
    tvlUsd: depth?.tvlUsd != null ? Math.round(depth.tvlUsd) : null,
    hookTvlUsd: depth?.hookTvlUsd ?? null,
    sell1m: depth?.impact?.sell?.find((x) => x.usd === 1e6)?.pct ?? null,
    buy1m: depth?.impact?.buy?.find((x) => x.usd === 1e6)?.pct ?? null,
  };

  /* Every field's window, written beside the data.
     The study this panel exists for is a correlation exercise, and correlating two
     series whose windows differ is how you get a confident wrong answer -- this
     project's single largest bug class was a denominator nobody had written down.
     Note that leak is a one-day figure while the site's fee-capture card uses a
     seven-day aggregate, so `capture` here will not match the page; both are
     defensible, they are simply not the same measurement. */
  const defs = {
    aiUsd: "spot, busiest AI/USDG venue, last hourly close",
    feeAnnual: "AI/yr, trailing 7 complete days annualised, all three splitter legs",
    feeTrend: "fee run-rate this 7 complete days vs the prior 7, as a fraction",
    leak: "hookless share of AI volume, LAST COMPLETE DAY, days with both venue kinds only",
    capture: "AI/NVDA share of AI volume, LAST COMPLETE DAY (the site's card uses a 7-day aggregate, so it differs)",
    kappa: "cross-routed vs direct AI, trailing window set by the routing task",
    nvdaPerDay: "NVDA into the vault, trailing 7 complete days, per day",
    removedPerDay: "AI burned + locked, trailing 7 complete days, per day",
    supplyRemoved: "(burned + vault balance) / genesis supply, cumulative",
    net7: "net AI bought minus sold, trailing 7 complete days, all indexed pools",
    organicShare: "flow-weighted AI-pair share of organic bridges; null when bridges.json is over 8h old",
    depthImbalance: "USD bids minus asks within +/-50% of spot, all indexed venues",
    depthBid: "USD of quote below spot", depthAsk: "USD of AI above spot",
    nearBid: "USD of quote within 2% below spot", nearAsk: "USD of AI within 2% above spot",
    holders: "addresses with a non-zero AI balance at the last four-hour snapshot, machinery excluded",
    holders100k: "addresses holding at least 100,000 AI at that snapshot (price-neutral breadth)",
    top10Share: "share of holder-owned AI held by the 10 largest wallets", top100Share: "same, 100 largest",
    newHolders24h: "addresses funded from zero over the last six snapshots (24h)", exits24h: "addresses emptied to zero over the same window",
    buyers7d: "wallets that net-bought AI through a pool per day (netted per transaction, summed over six 4h periods), trailing 7 complete days average",
    volumeUsd24h: "AI volume on indexed venues over the last complete day, priced hour by hour in USDG",
    nvdaUsd: "NVDA in dollars from its busiest USDG venue; null when prices.json is over 8h old",
    stockShare: "(DEX inventory + vault) / on-chain supply of Robinhood stock tokens, dollar-weighted over priced tokens; null when rwa.json is over 8h old",
    stockSwapShare: "share of the last day's swaps touching a stock token that went through a LONG-hook pool",
    stockDexUsd: "USD of stock tokens held by the v4 pool manager, all venues",
    tvlUsd: "USD value of every resting position in AI's indexed venues at spot",
    hookTvlUsd: "the part of tvlUsd held by the LONG hook's own positions",
    sell1m: "AI price move from a $1M sale routed across all indexed venues, as a fraction (1 = book exhausted)",
    buy1m: "same, for a $1M purchase",
  };

  /* One-time repair of rows already written during the stall: bridges.json was
     last written 2026-09-12 14:15 UTC and next written 2026-09-13 16:15, so any
     row stamped more than eight hours into that gap carried a stale reading.
     Idempotent, and a no-op once those rows age out of the retained window. */
  const STALL_FROM = 1789222528 + FRESH, STALL_TO = 1789316138;
  const history = (prior?.rows || []).filter((r) => r.t !== hour).slice(-24 * 120)
    .map((r) => (r.t > STALL_FROM && r.t < STALL_TO && r.organicShare != null ? { ...r, organicShare: null } : r));
  history.push(row);
  history.sort((a, b) => a.t - b.t);
  return { updatedAt: now, defs, rows: history };
}
