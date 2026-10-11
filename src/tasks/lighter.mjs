import { getLogsRange } from "../rpc.mjs";

/**
 * Inside the baskets: their positions on Lighter, and Lighter's AI perp market.
 *
 * A LongX basket's legs are perps on Lighter's Robinhood Chain deployment, held in
 * a Lighter account whose L1 address is the basket's own token contract (AINX is
 * account 42609, the one LONG's app reads). Lighter publishes every account's
 * positions and every market's open interest without authentication, so the legs,
 * the account's equity and the AI perp market are measured, not inferred. Note the
 * host: api.rh.lighter.xyz. The main Lighter API knows nothing of these accounts.
 *
 * On chain, each mint or redeem settles at a NAV the vault publishes itself:
 * RequestSettled(uint256 indexed requestId, uint256 amountOut, uint256 navPerToken),
 * navPerToken in USDG's six decimals. That is the "proven" NAV LONG's app shows;
 * account equity over share supply is the live estimate between settlements.
 */
const API = "https://api.rh.lighter.xyz/api/v1";
export const AI_MARKET = 45;
const REQUEST_SETTLED = "0x4f8c78abdea330bc084b3c3f1ceeba23d7278549cd04cfba2907cf7bb7a44035";
const KEEP_DAYS = 45;

async function get(path) {
  const r = await fetch(`${API}/${path}`, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`lighter ${path.split("?")[0]}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.code != null && j.code !== 0 && j.code !== 200) throw new Error(`lighter ${path.split("?")[0]}: ${j.message || j.code}`);
  return j;
}
const n = (x) => (x == null || x === "" ? null : Number(x));

export async function indexLighter(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const deadline = opts.deadline || Date.now() + 60_000;
  const baskets = opts.baskets || [];
  const S = opts.state?.v === 1 ? opts.state : { v: 1, accounts: {}, nav: {}, series: [] };
  const now = Math.floor(Date.now() / 1000);

  /* 1. Lighter's AI perp market. */
  let aiMarket = null;
  try {
    const m = (await get(`orderBookDetails?market_id=${AI_MARKET}`)).order_book_details?.[0];
    const fr = (await get("funding-rates").catch(() => null))?.funding_rates?.find((f) => f.market_id === AI_MARKET && f.exchange === "lighter");
    if (m) aiMarket = {
      marketId: AI_MARKET, symbol: m.symbol, mark: n(m.mark_price), index: n(m.index_price), last: n(m.last_trade_price),
      openInterest: n(m.open_interest), openInterestUsd: n(m.open_interest) * n(m.mark_price),
      volume24hUsd: n(m.daily_quote_token_volume), trades24h: n(m.daily_trades_count), change24hPct: n(m.daily_price_change),
      fundingRate: fr ? n(fr.rate) : null, listedAt: m.created_at ? Math.floor(Number(m.created_at) / 1000) : null,
    };
  } catch (e) { log(`  lighter: AI market unavailable (${e.message})`); }

  /* 2. Each basket's account and legs. */
  const rows = [];
  for (const b of baskets) {
    if (Date.now() > deadline) break;
    try {
      let idx = S.accounts[b.token];
      if (idx == null) {
        const j = await get(`accountsByL1Address?l1_address=${b.token}`);
        idx = j.sub_accounts?.[0]?.index ?? null;
        if (idx != null) S.accounts[b.token] = idx;
      }
      if (idx == null) continue;
      const a = (await get(`account?by=index&value=${idx}`)).accounts?.[0];
      if (!a) continue;
      const legs = (a.positions || []).filter((p) => n(p.position) !== 0).map((p) => ({
        marketId: p.market_id, symbol: p.symbol, side: p.sign === -1 ? "short" : "long",
        size: n(p.position), valueUsd: n(p.position_value), entry: n(p.avg_entry_price),
        upnlUsd: n(p.unrealized_pnl), fundingPaidUsd: n(p.total_funding_paid_out),
      }));
      const gross = legs.reduce((s, l) => s + Math.abs(l.valueUsd || 0), 0);
      for (const l of legs) l.weight = gross > 0 ? Math.abs(l.valueUsd) / gross : null;
      legs.sort((x, y) => (y.weight || 0) - (x.weight || 0));
      const equity = n(a.total_asset_value);

      /* the vault's own settlement NAV, from its events, resumed from a cursor */
      const N = (S.nav[b.token] ||= { cursor: null, last: null, settles: 0 });
      const from = N.cursor == null ? Math.max(0, latest - 60 * 845_649) : N.cursor + 1;
      if (from <= latest && Date.now() < deadline) {
        const r = await getLogsRange({ address: b.token, topics: [REQUEST_SETTLED] }, from, latest, { chunk: 10_000_000, deadline });
        for (const l of r) {
          const blk = parseInt(l.blockNumber, 16);
          N.settles++;
          N.last = { block: blk, t: tm.at(blk) ?? null, nav: Number(BigInt("0x" + l.data.slice(66, 130))) / 1e6 };
        }
        N.cursor = r.truncated ? (r.reachedBlock ?? N.cursor) : latest;
      }

      const supply = b.supply ?? null, liveNav = supply > 0 && equity != null ? equity / supply : null;
      const ai = legs.find((l) => l.marketId === AI_MARKET) || null;
      rows.push({
        token: b.token, symbol: b.symbol, account: idx,
        equityUsd: equity, collateralUsd: n(a.collateral), availableUsd: n(a.available_balance),
        grossUsd: gross, grossLeverage: equity > 0 ? gross / equity : null,
        netUsd: legs.reduce((s, l) => s + (l.side === "short" ? -1 : 1) * (l.valueUsd || 0), 0),
        upnlUsd: legs.reduce((s, l) => s + (l.upnlUsd || 0), 0),
        liveNav, provenNav: N.last?.nav ?? null, provenAt: N.last?.t ?? null, settles: N.settles,
        poolPrice: b.priceUsd ?? null, premium: b.priceUsd != null && liveNav ? b.priceUsd / liveNav - 1 : null,
        aiLeg: ai ? { size: ai.size, valueUsd: ai.valueUsd, weight: ai.weight, entry: ai.entry, shareOfOi: aiMarket?.openInterest ? ai.size / aiMarket.openInterest : null } : null,
        legs,
      });
    } catch (e) { log(`  lighter: ${b.symbol} unavailable (${e.message})`); }
  }

  /* 3. A thin history: at most one point an hour, kept for KEEP_DAYS. */
  const last = S.series.at(-1);
  if ((rows.length || aiMarket) && (!last || now - last.t >= 3300)) {
    S.series.push({
      t: now,
      ai: aiMarket ? { oi: aiMarket.openInterest, mark: aiMarket.mark, vol: aiMarket.volume24hUsd } : null,
      b: Object.fromEntries(rows.map((r) => [r.symbol, { eq: Math.round(r.equityUsd), nav: r.liveNav, lev: r.grossLeverage, ai: r.aiLeg?.size ?? 0 }])),
    });
  }
  S.series = S.series.filter((p) => p.t >= now - KEEP_DAYS * 86400);

  log(`  lighter: AI perp OI ${aiMarket ? Math.round(aiMarket.openInterest).toLocaleString() + " AI ($" + Math.round(aiMarket.openInterestUsd).toLocaleString() + "), 24h $" + Math.round(aiMarket.volume24hUsd || 0).toLocaleString() : "n/a"}; ${rows.map((r) => `${r.symbol} equity $${Math.round(r.equityUsd).toLocaleString()}, ${r.legs.length} legs, ${r.grossLeverage == null ? "n/a" : r.grossLeverage.toFixed(2) + "x"}, AI ${r.aiLeg ? Math.round(r.aiLeg.size).toLocaleString() : 0}`).join("; ") || "no basket accounts"}`);
  return {
    state: S,
    artifact: {
      updatedAt: now, aiMarket, accounts: rows, series: S.series,
      method: "Read from Lighter's public API for its Robinhood Chain deployment (api.rh.lighter.xyz): each basket's account, found by the basket token's address, with its open positions, and the AI perp market's open interest, 24-hour volume, mark and index prices. Weights are each leg's position value over the sum of all legs' absolute values; gross leverage is that sum over the account's equity. Live NAV is account equity over the basket's share supply; proven NAV is the navPerToken the vault publishes on chain in RequestSettled at each mint or redeem. Premium is the basket's on-chain pool price over live NAV.",
    },
  };
}
