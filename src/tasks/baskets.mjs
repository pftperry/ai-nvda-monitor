import { getLogsRange, getLogsByTopicSet, padAddr } from "../rpc.mjs";
import { POOL_MANAGER, AI, LONG_HOOK } from "../config.mjs";
import { TOPICS, decodeSwap, fmtUnits } from "../decode.mjs";

/**
 * LongX baskets: vaults that hold several perp legs on Lighter at target weights
 * (LongX's baskets litepaper), minted and redeemed at NAV. On this chain a basket
 * is the same thing as a leveraged LongX vault: an ERC-20 share whose USDG goes to
 * the Lighter bridge. The perps task already finds every such vault; this one
 * picks out the baskets and follows what they do on LONG.
 *
 * Measured on 11 Oct 2026, the first one, AI Nexus (AINX, born 10 Oct), has no AI
 * pool at all. Its "pairing mode" is LONG launches quoted in AINX instead of AI:
 * 56 LONG pools in its first day and a half. So for AI holders the question is not
 * only "does a basket absorb AI" (the flywheel answers that if an AI/basket pool
 * ever appears) but "do new launches choose a basket over AI as their quote". Both
 * are counted here: every v4 pool on either side of a basket, its swaps per day,
 * and LONG launches per day by quote token, AI's alongside each basket's.
 *
 * Recognised by name, from the perps task's vault list: "Basket", "Nexus" or
 * "Index" in the name or symbol, and not a leveraged single-asset vault. A basket
 * named otherwise would sit in the perps table as a vault until the pattern learns
 * it; the alert below names every new one the first time it is seen.
 */
const STATE_V = 1;
const ERA = Date.UTC(2026, 9, 1) / 1000;   // the baskets litepaper; no basket predates it
const BASKET_NAME = /basket|nexus|index/i;
const LEVERED_NAME = /\d+(\.\d+)?x\s*(long|short)/i;
const KEEP_DAYS = 45;
/* LONG's launcher (an upgradeable proxy; every launch carries a signature from LONG's
   signer). LaunchCreated names the quote ("numeraire") in topic 3; LaunchAuthorized,
   in the same transaction, names the wallet that launched in topic 3. */
const LAUNCHER = "0x1eef016f22a943abc7dd11422edee9d235942104";
const LAUNCH_CREATED = "0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b";
const LAUNCH_AUTHORIZED = "0xed933ec5efa1edc15f5699c24539937af1e3211d763e48915f93db801564c4e7";
/* A wallet launching this many tokens in one UTC day is a script, not a person.
   Measured: four wallets made 101 to 139 of the 135 to 165 AI-quoted launches a day
   from 2 to 6 Oct (33 to 48 each) and all stopped within seconds of each other at
   19:01 UTC on 6 Oct; every other launcher made at most a few. Counting them made
   AI's share of launches look like it collapsed from 32% to 3% when what stopped
   was one operator's script. */
const BOT_PER_DAY = 15;

export const isBasket = (v) => {
  const s = `${v?.name || ""} ${v?.symbol || ""}`;
  return BASKET_NAME.test(s) && !LEVERED_NAME.test(s);
};

const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const addrOf = (topic) => "0x" + topic.slice(26).toLowerCase();

export async function indexBaskets(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const deadline = opts.deadline || Date.now() + 120_000;
  const vaults = opts.vaults || [];
  const baskets = vaults.filter(isBasket).map((v) => ({ ...v, token: v.token.toLowerCase() }));
  const eraBlock = tm.blockAt(ERA) ?? Math.max(0, latest - 30 * 845_649);

  let S = opts.state;
  if (!S || S.v !== STATE_V) S = { v: STATE_V, tokens: {}, days: {}, seen: [] };
  let partial = false;

  /* 1. Every v4 pool on either side of AI and of each basket, from the era on.
        Address-filtered Initialize logs with the token in one currency slot: two
        cheap queries per token per run. AI's pools are scanned only to count launches
        quoted in AI next to those quoted in a basket. */
  const watch = [AI.toLowerCase(), ...baskets.map((b) => b.token)];
  for (const token of watch) {
    const T = (S.tokens[token] ||= { cursor: eraBlock - 1, pools: {} });
    if (T.cursor >= latest) continue;
    let reached = latest;
    for (const slot of [2, 3]) {
      const topics = [TOPICS.INITIALIZE, null, null, null];
      topics[slot] = padAddr(token);
      const r = await getLogsRange({ address: POOL_MANAGER, topics }, T.cursor + 1, latest, { chunk: 10_000_000, deadline });
      for (const l of r) {
        const c0 = addrOf(l.topics[2]), c1 = addrOf(l.topics[3]);
        T.pools[l.topics[1]] ||= {
          other: c0 === token ? c1 : c0, tokenIs0: c0 === token,
          fee: parseInt(word(l.data, 0), 16), hook: "0x" + word(l.data, 2).slice(24),
          block: parseInt(l.blockNumber, 16),
        };
      }
      if (r.truncated) reached = Math.min(reached, r.reachedBlock ?? T.cursor);
    }
    if (reached < latest) partial = true;
    T.cursor = reached;
  }

  /* 2. Swaps through each basket's pools, per day, resumed from a cursor per basket.
        A pool cannot trade before it exists and discovery reached the head above,
        so a newly found pool has nothing behind the cursor. */
  for (const b of baskets) {
    const T = S.tokens[b.token];
    const ids = Object.keys(T.pools);
    if (!ids.length) continue;
    T.swapCursor ??= Math.min(...ids.map((id) => T.pools[id].block)) - 1;
    const to = Math.min(latest, T.cursor);
    if (T.swapCursor >= to || Date.now() > deadline) continue;
    const snap = JSON.stringify(S.days);
    const r = await getLogsByTopicSet(POOL_MANAGER, TOPICS.SWAP, ids, T.swapCursor + 1, to, { chunk: 100_000, deadline });
    for (const l of r) {
      const P = T.pools[l.topics[1]], d = tm.dayBucket(parseInt(l.blockNumber, 16));
      if (!P || d == null) continue;
      const s = decodeSwap(l), amt = Math.abs(fmtUnits(P.tokenIs0 ? s.amount0 : s.amount1, b.decimals ?? 18));
      const row = ((S.days[d] ||= {})[b.token] ||= { swaps: 0, vol: 0, longSwaps: 0, longVol: 0 });
      row.swaps++; row.vol += amt;
      if (P.hook === LONG_HOOK) { row.longSwaps++; row.longVol += amt; }
    }
    /* getLogsByTopicSet does not report how far a deadline let it get, so a scan
       cut short is not trusted: the days roll back and the cursor stays put. */
    if (Date.now() > deadline) { S.days = JSON.parse(snap); partial = true; continue; }
    T.swapCursor = to;
  }
  /* 2b. Launches through LONG's launcher, per day: quote token and launching wallet.
         About 700 launches a day, two events each, one address-filtered stream. */
  const Lc = (S.launch ||= { cursor: eraBlock - 1, days: {} });
  if (Lc.cursor < latest && Date.now() < deadline) {
    const snap = JSON.stringify(Lc.days);
    const created = new Map(), by = new Map();
    /* two single-topic scans, not one OR-list: the public endpoint caps an OR-list
       at 100,000 blocks a query and a single topic at ten million */
    const rc = await getLogsRange({ address: LAUNCHER, topics: [LAUNCH_CREATED] }, Lc.cursor + 1, latest, { chunk: 400_000, deadline,
      onLogs: (ls) => { for (const l of ls) created.set(l.transactionHash + l.topics[2], { quote: addrOf(l.topics[3]), block: parseInt(l.blockNumber, 16) }); } });
    const reach = rc.truncated ? rc.reachedBlock : latest;
    const ra = reach > Lc.cursor ? await getLogsRange({ address: LAUNCHER, topics: [LAUNCH_AUTHORIZED] }, Lc.cursor + 1, reach, { chunk: 400_000, deadline: deadline + 60_000,
      onLogs: (ls) => { for (const l of ls) by.set(l.transactionHash + l.topics[1], addrOf(l.topics[3])); } }) : { truncated: false };
    const r = { truncated: rc.truncated || ra.truncated, reachedBlock: ra.truncated ? null : reach };
    for (const [k, c] of created) {
      const d = tm.dayBucket(c.block); if (d == null) continue;
      const who = by.get(k) || "?";
      const D = (Lc.days[d] ||= { all: 0, wallets: {}, quotes: {} });
      D.all++; D.wallets[who] = (D.wallets[who] || 0) + 1;
      const Q = (D.quotes[c.quote] ||= {}); Q[who] = (Q[who] || 0) + 1;
    }
    /* keep only the quotes this page reads, so the state stays small */
    const keepQ = new Set(watch);
    for (const D of Object.values(Lc.days)) for (const q of Object.keys(D.quotes)) if (!keepQ.has(q)) delete D.quotes[q];
    if (r.truncated && r.reachedBlock == null) { Lc.days = JSON.parse(snap); partial = true; }
    else { Lc.cursor = r.truncated ? r.reachedBlock : latest; if (r.truncated) partial = true; }
  }

  const today = tm.dayBucket(latest);
  for (const d of Object.keys(Lc.days)) if (Number(d) < today - KEEP_DAYS * 86400) delete Lc.days[d];
  for (const d of Object.keys(S.days)) if (Number(d) < today - KEEP_DAYS * 86400) delete S.days[d];

  /* 3. Publish. */
  const d1 = today - 86400, wk = today - 7 * 86400;
  const launchesOf = (token) => Object.values(S.tokens[token]?.pools || {}).filter((p) => p.hook === LONG_HOOK);
  const dayOfBlock = (b) => tm.dayBucket(b);
  const rows = baskets.map((b) => {
    const T = S.tokens[b.token] || { pools: {} };
    const pools = Object.entries(T.pools);
    const sum = (from, to, k) => Object.entries(S.days).filter(([d]) => +d >= from && +d < to).reduce((s, [, r]) => s + (r[b.token]?.[k] || 0), 0);
    const px = b.priceUsd ?? null;
    const usd = (v) => (px == null ? null : Math.round(v * px));
    const launches = launchesOf(b.token);
    const aiPools = pools.filter(([, p]) => p.other === AI.toLowerCase()).map(([id, p]) => ({ poolId: id, fee: p.fee, hook: p.hook, createdBlock: p.block, aiIsCurrency0: !p.tokenIs0 }));
    const first = pools.reduce((m, [, p]) => Math.min(m, p.block), Infinity);
    return {
      token: b.token, symbol: b.symbol, name: b.name, priceUsd: px, supply: b.supply ?? null, valueUsd: b.valueUsd ?? null,
      depositedUsd: Math.round(b.depositedUsd || 0), withdrawnUsd: Math.round(b.withdrawnUsd || 0),
      mint24h: b.mint24h ?? 0, burn24h: b.burn24h ?? 0,
      firstPoolT: Number.isFinite(first) ? tm.at(first) ?? null : null,
      pools: pools.length, longPools: launches.length,
      launches7d: launches.filter((p) => dayOfBlock(p.block) >= wk).length,
      swaps24h: sum(d1, today, "swaps"), longSwaps24h: sum(d1, today, "longSwaps"),
      volume24hUsd: usd(sum(d1, today, "vol")), longVolume24hUsd: usd(sum(d1, today, "longVol")),
      swaps7d: sum(wk, today, "swaps"), volume7dUsd: usd(sum(wk, today, "vol")),
      aiPools,
    };
  }).sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0));

  /* LONG launches per complete day through the launcher, by quote: AI and each
     basket, each split into ordinary wallets and scripted ones (BOT_PER_DAY). */
  const days = [];
  for (let d = Math.max(tm.dayBucket(eraBlock) ?? today, today - 30 * 86400); d < today; d += 86400) days.push(d);
  const split = (D, token) => { let n = 0, bots = 0; for (const [w, c] of Object.entries(D?.quotes?.[token] || {})) { n += c; if ((D.wallets[w] || 0) >= BOT_PER_DAY) bots += c; } return { n, bots }; };
  const launchesByDay = days.filter((t) => Lc.days[t]).map((t) => {
    const D = Lc.days[t], a = split(D, AI.toLowerCase());
    const bots = Object.values(D.wallets).filter((c) => c >= BOT_PER_DAY).reduce((s, c) => s + c, 0);
    const bk = Object.fromEntries(rows.map((r) => [r.symbol, split(D, r.token)]));
    return { t, all: D.all, allBots: bots, ai: a.n, aiBots: a.bots, baskets: Object.fromEntries(Object.entries(bk).map(([k, v]) => [k, v.n])), basketBots: Object.values(bk).reduce((s, v) => s + v.bots, 0) };
  });
  const wkRows = launchesByDay.filter((d) => d.t >= wk);
  const ai7d = wkRows.reduce((s, d) => s + d.ai - d.aiBots, 0), basket7d = wkRows.reduce((s, d) => s + Object.values(d.baskets).reduce((a, n) => a + n, 0) - d.basketBots, 0);

  /* The alert: a basket seen for the first time is a new product on LONG and is
     worth a look before it is worth a chart. */
  const seen = new Set(S.seen || []);
  const fresh = rows.filter((r) => !seen.has(r.token));
  for (const r of fresh) {
    const msg = `New LongX basket: ${r.symbol} (${r.name}) ${r.token}, ${r.pools} pool(s), ${r.longPools} LONG launch(es) quoting it${r.aiPools.length ? `, ${r.aiPools.length} AI pool(s)` : ", no AI pool"}`;
    log("  " + msg);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=New LongX basket::${msg}`);
    seen.add(r.token);
  }
  S.seen = [...seen];

  log(`  baskets: ${rows.length} [${rows.map((r) => `${r.symbol} $${Math.round(r.valueUsd || 0).toLocaleString()}, ${r.longPools} launches, ${r.swaps24h} swaps 24h`).join("; ") || "none yet"}]; launches 7d by ordinary wallets quoted in AI ${ai7d}, in baskets ${basket7d}${partial ? " (partial)" : ""}`);
  return {
    state: S,
    artifact: {
      since: ERA, partial,
      baskets: rows,
      aiPairPools: rows.flatMap((r) => r.aiPools.map((p) => ({ ...p, pairToken: r.token, pairSymbol: r.symbol, pairDecimals: 18 }))),
      launches7d: { ai: ai7d, baskets: basket7d },
      launchesByDay,
      method: "Baskets are LongX vaults (ERC-20 shares whose USDG goes to the Lighter bridge, found by the perps scan) named as a basket, nexus or index and not as a leveraged single-asset vault. Value is share supply at the share's on-chain price; the legs themselves sit on Lighter and are not visible on this chain. Pools are every Uniswap v4 pool with the basket on either side since 1 Oct 2026; launches are those carrying LONG's hook. Swaps and volume are counted per complete UTC day on the basket's side, at today's share price. Launches by quote are read from LONG's launcher: each launch's quote token and the wallet that launched it. A wallet with " + BOT_PER_DAY + " or more launches in a UTC day is counted as scripted and shown apart; the AI-against-basket comparison uses the rest.",
    },
  };
}

