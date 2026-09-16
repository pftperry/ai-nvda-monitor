import { getLogsRange, padAddr } from "../rpc.mjs";
import { NVDA, GENESIS_BLOCK } from "../config.mjs";
import { TOPICS, decodeTransfer, fmtUnits } from "../decode.mjs";
import { TimeMap } from "../timemap.mjs";

/**
 * Tokenized NVDA supply, day by day, from the token's own mints and burns.
 *
 * Robinhood issues a stock token by minting it (an ERC-20 Transfer from the zero
 * address) and redeems it by burning (a Transfer to the zero address); every mint or
 * redemption is matched by a real stock order on their side. So the cumulative
 * mints less burns is the token's supply on any day, which the live totalSupply
 * confirms (verify compares the two). The series answers a claim the LONG founder
 * makes often, that demand routed through LONG's NVDA pairs has forced the
 * tokenized supply to grow: it shows minting per day before and after LONG's launch
 * and the supply multiple since that day, measured rather than asserted.
 *
 * One cursor-resumed stream per direction, from the chain's first block (NVDA
 * predates LONG), bucketed with the same pre-genesis anchors the flow histories use.
 */
const ZERO_TOPIC = "0x" + "0".repeat(64);
const DAY = 86400;

export async function indexStockSupply(latest, tm, opts = {}) {
  const store = opts.store, log = opts.log || console.log;
  const deadline = opts.deadline || Date.now() + 120_000;
  const token = (opts.token || NVDA).toLowerCase(), decimals = opts.decimals ?? 18, symbol = opts.symbol || "NVDA";
  const t0 = Date.now();

  let S = store && store.get("stockSupply");
  if (!S || S.v !== 1 || S.token !== token) S = { v: 1, token, cursor: -1, days: {}, anchors: null };
  if (!S.anchors) {
    const flow = store && store.get("rwaFlow");
    if (flow?.anchors) S.anchors = flow.anchors;
    else { const early = new TimeMap([]); await early.build(0, GENESIS_BLOCK, 250_000); S.anchors = early.toJSON(); }
  }
  const tmx = new TimeMap([...S.anchors, ...tm.toJSON()]);
  /* The chain's first blocks carry timestamps from long before it went live (the
     anchors read 2004–2023 for a handful of test mints of one NVDA or less), so
     anything the map places before April 2026 is kept out of the daily series. */
  const CHAIN_LIVE = Date.UTC(2026, 3, 1) / 1000;
  const dayOf = (b) => { const d = tmx.dayBucket(b); return d != null && d >= CHAIN_LIVE ? d : null; };

  /* Both directions over the same block range, committed together or not at all. */
  if (S.cursor + 1 <= latest && Date.now() < deadline) {
    const from = S.cursor + 1, snap = JSON.stringify(S.days);
    const add = (dir) => (ls) => { for (const l of ls) { const t = decodeTransfer(l), d = dayOf(t.block); if (d == null) continue; const r = (S.days[d] ||= { minted: 0, burned: 0, mints: 0, burns: 0 }); r[dir] += fmtUnits(t.value, decimals); r[dir === "minted" ? "mints" : "burns"] += 1; } };
    const rM = await getLogsRange({ address: token, topics: [TOPICS.TRANSFER, ZERO_TOPIC] }, from, latest, { chunk: 2_000_000, deadline, onLogs: add("minted") });
    const reach = rM.reachedBlock ?? latest;
    let ok = reach >= from;
    if (ok) {
      const rB = await getLogsRange({ address: token, topics: [TOPICS.TRANSFER, null, ZERO_TOPIC] }, from, reach, { chunk: 2_000_000, deadline: deadline + 60_000, onLogs: add("burned") });
      ok = !rB.truncated;
    }
    if (!ok) { S.days = JSON.parse(snap); S.partial = true; }
    else { S.cursor = reach; S.partial = !!rM.truncated; }
  }
  if (store) store.set("stockSupply", S);

  /* Publish: complete UTC days with the running supply; today apart. */
  const todayStart = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const have = Object.keys(S.days).map(Number).sort((a, b) => a - b);
  /* Every calendar day from the first mint to today, zeros included, so weekends
     (when Robinhood pauses issuance) appear as empty days rather than gaps. */
  const keys = [];
  if (have.length) for (let t = have[0]; t <= Math.max(have.at(-1), todayStart); t += DAY) keys.push(t);
  const price = opts.priceUsd || null;
  let cum = 0;
  const days = [], launchDay = dayOf(GENESIS_BLOCK);
  let launchSupply = null, today = null;
  for (const t of keys) {
    const r = S.days[t] || { minted: 0, burned: 0, mints: 0, burns: 0 };
    if (t === launchDay) launchSupply = cum;
    cum += r.minted - r.burned;
    const row = { t, minted: +r.minted.toFixed(4), burned: +r.burned.toFixed(4), net: +(r.minted - r.burned).toFixed(4), mints: r.mints, burns: r.burns, supply: +cum.toFixed(4),
      mintedUsd: price ? Math.round(r.minted * price) : null, burnedUsd: price ? Math.round(r.burned * price) : null, netUsd: price ? Math.round((r.minted - r.burned) * price) : null };
    if (t >= todayStart) today = row; else days.push(row);
  }
  if (launchSupply == null && launchDay != null && keys.length && keys[0] > launchDay) launchSupply = 0;
  const last = days.at(-1) || null;
  const week = days.filter((r) => last && r.t > last.t - 7 * DAY);
  const out = {
    token, symbol, decimals, since: keys[0] ?? null, cursor: S.cursor, partial: !!S.partial, priceUsd: price,
    days, today,
    launch: launchDay != null ? { t: launchDay, supply: launchSupply == null ? null : +launchSupply.toFixed(4) } : null,
    now: { supply: last ? last.supply : null, onChain: opts.onChain ?? null, t: last ? last.t : null },
    multiple: last && launchSupply > 0 ? +(last.supply / launchSupply).toFixed(2) : null,
    week: { minted: +week.reduce((s, r) => s + r.minted, 0).toFixed(4), burned: +week.reduce((s, r) => s + r.burned, 0).toFixed(4),
      mintedUsd: price ? Math.round(week.reduce((s, r) => s + r.minted, 0) * price) : null, netUsd: price ? Math.round(week.reduce((s, r) => s + r.net, 0) * price) : null, days: week.length },
    secs: Math.round((Date.now() - t0) / 1000),
  };
  log(`  ${symbol} supply: ${days.length} complete day(s), ${out.now.supply?.toLocaleString?.() ?? "—"} rebuilt vs ${opts.onChain?.toLocaleString?.() ?? "—"} on chain, ${out.multiple ?? "—"}× since launch${S.partial ? " (stream partial)" : ""} in ${out.secs}s`);
  return out;
}
