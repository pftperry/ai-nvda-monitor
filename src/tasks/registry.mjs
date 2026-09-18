import { rpc, getLogsRange } from "../rpc.mjs";
import { multicall } from "../tokens.mjs";

/**
 * The tokenized-stock universe and its hourly dollar prices, on LONG's Dune
 * definitions (docs/dune/README.md).
 *
 * Three pieces, all cheap, all cursor-resumed:
 *
 * 1. THE REGISTRY (Dune query_8071980). Robinhood's token factory emits one event
 *    per listing carrying the token, its name and its symbol. That event IS the
 *    universe: no bytecode heuristics, no "tokens we happened to see trading".
 *    Names containing "Dollar" are dropped (stablecoins), and the rest are classed
 *    treasury / commodity / etf / stock by the same name patterns Dune uses. Rialto
 *    also deploys wrapped copies of these tokens; those are found from the creations
 *    of its deployer and matched back to the native listing by name.
 *
 * 2. THE FEEDS (Dune query_8076065). Every Chainlink aggregator on the chain is
 *    found by its AnswerUpdated topic, then asked for its own description(), which
 *    reads "Robinhood PLTR / USD" or "RHNVDA / USD". The ticker in that string is
 *    matched to a registry symbol. Dune reads the same string out of the contract's
 *    bytecode because Dune cannot make calls; a call is the same answer, cheaper and
 *    without a regex over compiled code. Discovery rather than a hard-coded list is
 *    the point: Robinhood keeps adding feeds, and a frozen list silently stops
 *    pricing the newest listings.
 *
 * 3. THE HOURLY PRICES (Dune query_8032188). A trade is worth what the stock was
 *    worth at the hour it happened, not what it is worth now. Each aggregator's
 *    AnswerUpdated answers are folded to the last answer of each UTC hour and
 *    forward-filled, because equity feeds stop updating outside market hours and go
 *    quiet all weekend. Only the updates are stored; the fill happens on read.
 */
const ANSWER_UPDATED = "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f";
const TOKEN_LISTED = "0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6";
export const TOKEN_FACTORY = "0x4783c67b63de2b358ac5951a7d41f47a38f3c046";
const DESCRIPTION = "0x7284e416";
const HOUR = 3600;

const addrOf = (hex) => "0x" + hex.slice(-40).toLowerCase();
/** ABI-decode a dynamic string at word `i` of `data` (offset word, then length, then bytes). */
function abiString(data, i) {
  try {
    const off = parseInt(data.slice(2 + 64 * i, 2 + 64 * (i + 1)), 16) * 2;
    const len = parseInt(data.slice(2 + off, 2 + off + 64), 16) * 2;
    return Buffer.from(data.slice(2 + off + 64, 2 + off + 64 + len), "hex").toString("utf8");
  } catch { return null; }
}
/** Dune's asset_class CASE, in the same order (the first match wins). */
export function assetClass(name) {
  if (/T-Bill|Treasury/.test(name)) return "treasury";
  if (/Silver|Gold|Oil Fund/.test(name)) return "commodity";
  if (/ETF|QQQ|Trust/.test(name) || /fund/i.test(name)) return "etf";
  return "stock";
}

/**
 * The listed-token registry. Returns { tokens: {addr: {symbol, name, assetClass,
 * issuer, block}}, cursor, partial }.
 */
export async function indexRegistry(latest, opts = {}) {
  const store = opts.store, log = opts.log || console.log;
  let R = store && store.get("rwaRegistry");
  if (!R || R.v !== 1) R = { v: 1, cursor: 0, tokens: {} };
  if (R.cursor < latest) {
    const r = await getLogsRange({ address: TOKEN_FACTORY, topics: [TOKEN_LISTED] }, R.cursor + 1, latest, {
      chunk: 20_000_000, deadline: opts.deadline,
      onLogs: (logs) => {
        for (const l of logs) {
          const name = abiString(l.data, 1), symbol = abiString(l.data, 2);
          if (!name || /Dollar/.test(name)) continue;            // Dune drops the stablecoins by name
          R.tokens[addrOf(l.data.slice(2, 66))] = { symbol, name, assetClass: assetClass(name), issuer: "robinhood", block: parseInt(l.blockNumber, 16) };
        }
      },
    });
    R.cursor = r.reachedBlock ?? latest;
    R.partial = !!r.truncated;
    if (store) store.set("rwaRegistry", R);
  }
  const n = Object.keys(R.tokens).length;
  const byClass = {};
  for (const t of Object.values(R.tokens)) byClass[t.assetClass] = (byClass[t.assetClass] || 0) + 1;
  log(`  registry: ${n} listed tokens (${Object.entries(byClass).map(([k, v]) => `${v} ${k}`).join(", ")})${R.partial ? ", still scanning" : ""}`);
  return R;
}

/**
 * Chainlink aggregators, discovered and matched to registry tokens by ticker.
 * Returns { feeds: {aggregator: {ticker, token, description}}, cursor, partial }.
 */
export async function indexFeeds(latest, registry, opts = {}) {
  const store = opts.store, log = opts.log || console.log;
  let F = store && store.get("rwaFeeds");
  if (!F || F.v !== 2) F = { v: 2, cursor: 0, feeds: {}, seen: {} };   // v2: the hyphen naming is matched too
  /* Discovery only needs to notice an aggregator once, so the scan keeps a cursor and
     looks for addresses it has not already resolved. */
  if (F.cursor < latest) {
    const fresh = new Set();
    const r = await getLogsRange({ topics: [ANSWER_UPDATED] }, F.cursor + 1, latest, {
      chunk: 2_000_000, deadline: opts.deadline,
      onLogs: (logs) => { for (const l of logs) { const a = l.address.toLowerCase(); if (!F.seen[a]) fresh.add(a); } },
    });
    F.cursor = r.reachedBlock ?? latest;
    F.partial = !!r.truncated;
    const list = [...fresh];
    if (list.length) {
      const desc = await multicall(list.map((a) => ({ to: a, data: DESCRIPTION })));
      const bySymbol = new Map(Object.entries(registry.tokens).map(([addr, t]) => [t.symbol, addr]));
      list.forEach((a, i) => {
        const d = desc[i] && desc[i] !== "0x" ? abiString(desc[i], 0) : null;
        F.seen[a] = 1;
        if (!d) return;
        /* Robinhood names its feeds three ways: "Robinhood PLTR / USD", "RHNVDA / USD"
           and "Robinhood DELL-USD". The hyphen form is worth accepting: it is how USAR,
           SGOV and DELL are written, and a slash-only match leaves them silently unpriced. */
        const m = /Robinhood\s+([A-Za-z0-9.]+)\s*[/-]\s*USD/.exec(d) || /^RH([A-Za-z0-9.]+)\s*[/-]\s*USD/.exec(d);
        const ticker = m?.[1];
        const token = ticker ? bySymbol.get(ticker) : null;
        if (token) F.feeds[a] = { ticker, token, description: d };
      });
    }
    if (store) store.set("rwaFeeds", F);
  }
  const priced = new Set(Object.values(F.feeds).map((f) => f.token));
  log(`  feeds: ${Object.keys(F.feeds).length} Chainlink aggregators map to ${priced.size} listed tokens, ${Object.keys(F.seen).length} aggregators seen in all`);
  return F;
}

/**
 * Hourly answers per aggregator, kept as updates only. Returns
 * { at: {aggregator: [[hour, price], ...]}, cursor, partial } and a `priceAt` reader.
 */
export async function indexHourlyPrices(latest, tm, feeds, opts = {}) {
  const store = opts.store, log = opts.log || console.log;
  const since = opts.since ?? Date.UTC(2026, 5, 1) / 1000;
  let P = store && store.get("rwaHourlyPx");
  if (!P || P.v !== 1) P = { v: 1, cursor: null, at: {} };
  const addrs = Object.keys(feeds.feeds);
  if (!addrs.length) return { ...P, priceAt: () => null };
  if (P.cursor == null) P.cursor = (tm.blockAt(since) ?? 1) - 1;
  if (P.cursor < latest) {
    /* One scan for every aggregator at once: the topic is shared and the address
       filter takes a list, so the whole feed set costs what one feed would. */
    const hours = {};
    const r = await getLogsRange({ address: addrs, topics: [ANSWER_UPDATED] }, P.cursor + 1, latest, {
      chunk: 4_000_000, deadline: opts.deadline,
      onLogs: (logs) => {
        for (const l of logs) {
          const t = tm.at(parseInt(l.blockNumber, 16)); if (t == null) continue;
          const h = Math.floor(t / HOUR) * HOUR, a = l.address.toLowerCase();
          const answer = Number(BigInt.asIntN(256, BigInt(l.topics[1]))) / 1e8;
          if (!(answer > 0)) continue;
          const blk = parseInt(l.blockNumber, 16);
          const key = a + ":" + h, prev = hours[key];
          if (!prev || blk >= prev[1]) hours[key] = [answer, blk];    // last answer of the hour wins
        }
      },
    });
    for (const [key, [price]] of Object.entries(hours)) {
      const i = key.lastIndexOf(":"), a = key.slice(0, i), h = Number(key.slice(i + 1));
      const arr = (P.at[a] ||= []);
      const last = arr.length ? arr[arr.length - 1] : null;
      if (last && last[0] === h) last[1] = price;
      else arr.push([h, price]);
    }
    for (const arr of Object.values(P.at)) arr.sort((x, y) => x[0] - y[0]);
    P.cursor = r.reachedBlock ?? latest;
    P.partial = !!r.truncated;
    if (store) store.set("rwaHourlyPx", P);
  }
  const updates = Object.values(P.at).reduce((s, a) => s + a.length, 0);
  log(`  hourly prices: ${updates.toLocaleString()} hourly answers across ${Object.keys(P.at).length} feeds${P.partial ? ", still scanning" : ""}`);
  return { ...P, priceAt: priceReader(P, feeds) };
}

/**
 * token, unix seconds -> USD at that hour, forward-filled from the last answer on or
 * before it. Returns null before a feed's first answer, which is what excludes a
 * token from the dashboard until it has a price.
 */
export function priceReader(P, feeds) {
  const byToken = new Map();
  for (const [agg, f] of Object.entries(feeds.feeds || {})) {
    const arr = P.at[agg]; if (!arr?.length) continue;
    const cur = byToken.get(f.token);
    if (!cur || arr.length > cur.length) byToken.set(f.token, arr);   // one feed per token: the busiest
  }
  return (token, t) => {
    const arr = byToken.get(token); if (!arr) return null;
    const h = Math.floor(t / HOUR) * HOUR;
    let lo = 0, hi = arr.length - 1, best = -1;
    if (arr[0][0] > h) return null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] <= h) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best < 0 ? null : arr[best][1];
  };
}
