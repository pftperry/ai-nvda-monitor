import { getLogsRange, padAddr } from "../rpc.mjs";
import { AI, NVDA, USDG, POOL_MANAGER, GENESIS_BLOCK, LONG_BUYBACK, LONG_AI_ACCUMULATOR, LONG_REVENUE_WALLET } from "../config.mjs";
import { TOPICS, decodeTransfer, fmtUnits } from "../decode.mjs";
import { multicall } from "../tokens.mjs";

/**
 * The platform's fee engine beyond the AI/NVDA splitter.
 *
 * The Treasury tab follows the platform fee wallet, which receives one leg of
 * the AI/NVDA hook fee. LONG's own Dune methodology names a second path: on
 * every swap in a LONG pool the hook hands a fee leg to a "buyback" contract.
 * Traced on chain (14 Sep 2026), that contract
 *   - receives the fee leg (AI on AI-paired pools; the launched token, the stock
 *     or USDG otherwise),
 *   - sells non-AI legs into the same pool for AI where the pool is AI-paired --
 *     949 such swaps across 132 pools in thirty-five minutes -- which is a
 *     mechanical AI purchase on every launched-token trade,
 *   - forwards ~95% of the AI to an EOA that had never sent any out, keeping ~5%,
 *   - forwards stock-paired legs as USDG and NVDA to a second EOA.
 * The AI accumulator held 5.0M AI and the revenue EOA $10.5M of USDG when found,
 * against $1.3M ever received by the platform fee wallet: this is where most of
 * the money is. Measured here as daily flows, streamed from Transfer logs and
 * resumed from a cursor, with live balances as the cross-check.
 */
const DAY_FIELDS = ["aiToBuyback", "aiBuybackToAccum", "aiBuybackToPools", "aiAccumOut", "usdgToRevenue", "usdgToRevenueFromBuyback", "usdgRevenueOut", "nvdaToRevenue"];

export async function indexRevenue(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store;
  const prev = (store && store.get("revenue")) || { cursor: GENESIS_BLOCK - 1, daily: {} };
  const daily = {};
  for (const [d, r] of Object.entries(prev.daily)) daily[d] = { ...r };
  const from = Math.max(GENESIS_BLOCK, prev.cursor + 1);
  const bump = (block, key, v) => {
    const d = tm.dayBucket(block); if (!d) return;
    const row = (daily[d] ||= Object.fromEntries(DAY_FIELDS.map((k) => [k, 0])));
    row[key] = (row[key] || 0) + v;
  };
  let reached = latest, partial = false;
  const scan = async (filter, dec, fold) => {
    if (from > latest) return;
    const r = await getLogsRange(filter, from, latest, { chunk: 400_000, deadline: opts.deadline, onLogs: (logs) => { for (const l of logs) fold(decodeTransfer(l), fmtUnits(decodeTransfer(l).value, dec)); } });
    reached = Math.min(reached, r.reachedBlock ?? latest);
    if (r.truncated) partial = true;
  };
  const t0 = Date.now();
  await scan({ address: AI, topics: [TOPICS.TRANSFER, null, padAddr(LONG_BUYBACK)] }, 18, (t, v) => bump(t.block, "aiToBuyback", v));
  await scan({ address: AI, topics: [TOPICS.TRANSFER, padAddr(LONG_BUYBACK), null] }, 18, (t, v) => {
    if (t.to === LONG_AI_ACCUMULATOR) bump(t.block, "aiBuybackToAccum", v);
    else if (t.to === POOL_MANAGER) bump(t.block, "aiBuybackToPools", v);
  });
  await scan({ address: AI, topics: [TOPICS.TRANSFER, padAddr(LONG_AI_ACCUMULATOR), null] }, 18, (t, v) => bump(t.block, "aiAccumOut", v));
  await scan({ address: USDG, topics: [TOPICS.TRANSFER, null, padAddr(LONG_REVENUE_WALLET)] }, 6, (t, v) => { bump(t.block, "usdgToRevenue", v); if (t.from === LONG_BUYBACK) bump(t.block, "usdgToRevenueFromBuyback", v); });
  await scan({ address: USDG, topics: [TOPICS.TRANSFER, padAddr(LONG_REVENUE_WALLET), null] }, 6, (t, v) => bump(t.block, "usdgRevenueOut", v));
  await scan({ address: NVDA, topics: [TOPICS.TRANSFER, null, padAddr(LONG_REVENUE_WALLET)] }, 18, (t, v) => bump(t.block, "nvdaToRevenue", v));

  /* If any scan was cut short, keep the earlier cursor for all of them: a day
     with inflows scanned and outflows not would misstate the balance walk. */
  const cursor = partial ? Math.min(reached, latest) : latest;
  if (store) store.set("revenue", { cursor: partial ? Math.max(prev.cursor, reached) : latest, daily });
  log(`  fee engine: scanned ${from.toLocaleString()}..${cursor.toLocaleString()} in ${((Date.now() - t0) / 1000).toFixed(0)}s${partial ? " (budget; resumes)" : ""}`);

  /* Live balances, one multicall. */
  const bal = (tok, who) => ({ to: tok, data: "0x70a08231" + who.slice(2).padStart(64, "0") });
  const r = await multicall([
    bal(AI, LONG_BUYBACK), bal(NVDA, LONG_BUYBACK), bal(USDG, LONG_BUYBACK),
    bal(AI, LONG_AI_ACCUMULATOR), bal(USDG, LONG_REVENUE_WALLET), bal(NVDA, LONG_REVENUE_WALLET), bal(AI, LONG_REVENUE_WALLET),
  ]);
  const n = (h, d) => (h && h !== "0x" ? fmtUnits(BigInt(h), d) : null);
  const balances = {
    buyback: { ai: n(r[0], 18), nvda: n(r[1], 18), usdg: n(r[2], 6) },
    accumulator: { ai: n(r[3], 18) },
    revenue: { usdg: n(r[4], 6), nvda: n(r[5], 18), ai: n(r[6], 18) },
  };

  const series = Object.entries(daily).map(([d, row]) => ({ t: Number(d), ...Object.fromEntries(DAY_FIELDS.map((k) => [k, +(row[k] || 0).toFixed(4)])) })).sort((a, b) => a.t - b.t);
  const sum = (k) => series.reduce((s, x) => s + (x[k] || 0), 0);
  const totals = Object.fromEntries(DAY_FIELDS.map((k) => [k, +sum(k).toFixed(2)]));
  return {
    updatedAt: Math.floor(Date.now() / 1000),
    cursor, partial,
    addresses: { buyback: LONG_BUYBACK, accumulator: LONG_AI_ACCUMULATOR, revenue: LONG_REVENUE_WALLET },
    fields: {
      aiToBuyback: "AI received by the buyback contract (fee legs in AI, and AI it bought by selling other fee legs)",
      aiBuybackToAccum: "AI the buyback contract forwarded to the accumulation EOA",
      aiBuybackToPools: "AI the buyback contract paid into pools (its own swaps' input side)",
      aiAccumOut: "AI sent out of the accumulation EOA (none as of 14 Sep 2026)",
      usdgToRevenue: "USDG received by the revenue EOA, any sender", usdgToRevenueFromBuyback: "of which from the buyback contract",
      usdgRevenueOut: "USDG sent out of the revenue EOA", nvdaToRevenue: "NVDA received by the revenue EOA",
    },
    totals, balances, daily: series,
  };
}
