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
 *   - forwards most of the AI to an EOA that had never sent any out, keeping some,
 *   - and, on other pools, sends AI INTO pools: the AI fee leg sold for the stock or
 *     USDG side, which is then forwarded to a second EOA (the revenue wallet).
 * Which of those two behaviours dominates, and when it changed, is exactly what
 * the daily series below is for. The AI accumulator held 5.0M AI and the revenue
 * EOA $10.5M of USDG when found, against $1.3M ever received by the platform fee
 * wallet: this is where most of the money is.
 *
 * Each filter is streamed from Transfer logs into daily buckets and resumed from
 * ITS OWN cursor, so a run that finishes two scans and runs out of budget on the
 * third keeps exactly the work it did and never counts a day twice.
 */
const STATE_VERSION = 2;
const FILTERS = {
  aiToBuyback:      { filter: { address: AI, topics: [TOPICS.TRANSFER, null, padAddr(LONG_BUYBACK)] }, dec: 18 },
  aiFromBuyback:    { filter: { address: AI, topics: [TOPICS.TRANSFER, padAddr(LONG_BUYBACK), null] }, dec: 18, split: (t) => (t.to === LONG_AI_ACCUMULATOR ? "aiBuybackToAccum" : t.to === POOL_MANAGER ? "aiBuybackToPools" : "aiBuybackElsewhere") },
  aiAccumOut:       { filter: { address: AI, topics: [TOPICS.TRANSFER, padAddr(LONG_AI_ACCUMULATOR), null] }, dec: 18 },
  usdgToRevenue:    { filter: { address: USDG, topics: [TOPICS.TRANSFER, null, padAddr(LONG_REVENUE_WALLET)] }, dec: 6, split: (t) => (t.from === LONG_BUYBACK ? "usdgToRevenueFromBuyback" : "usdgToRevenueOther") },
  usdgRevenueOut:   { filter: { address: USDG, topics: [TOPICS.TRANSFER, padAddr(LONG_REVENUE_WALLET), null] }, dec: 6 },
  nvdaToRevenue:    { filter: { address: NVDA, topics: [TOPICS.TRANSFER, null, padAddr(LONG_REVENUE_WALLET)] }, dec: 18 },
};
const DAY_FIELDS = ["aiToBuyback", "aiBuybackToAccum", "aiBuybackToPools", "aiBuybackElsewhere", "aiAccumOut", "usdgToRevenueFromBuyback", "usdgToRevenueOther", "usdgRevenueOut", "nvdaToRevenue"];

export async function indexRevenue(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store;
  let state = store && store.get("revenue");
  if (!state || state.v !== STATE_VERSION) state = { v: STATE_VERSION, filters: {} };
  const t0 = Date.now();
  const notes = [];
  for (const [name, spec] of Object.entries(FILTERS)) {
    const st = (state.filters[name] ||= { cursor: GENESIS_BLOCK - 1, byDay: {} });
    const from = Math.max(GENESIS_BLOCK, st.cursor + 1);
    if (from > latest) continue;
    if (opts.deadline && Date.now() > opts.deadline) { notes.push(`${name} waits`); continue; }
    const byDay = st.byDay;
    const r = await getLogsRange(spec.filter, from, latest, {
      chunk: 400_000, deadline: opts.deadline,
      onLogs: (logs) => {
        for (const l of logs) {
          const t = decodeTransfer(l);
          const d = tm.dayBucket(t.block); if (!d) continue;
          const key = spec.split ? spec.split(t) : name;
          const row = (byDay[d] ||= {});
          row[key] = (row[key] || 0) + fmtUnits(t.value, spec.dec);
        }
      },
    });
    st.cursor = r.reachedBlock ?? latest;
    st.partial = !!r.truncated;
    notes.push(`${name} to ${st.cursor.toLocaleString()}${st.partial ? " (budget)" : ""}`);
  }
  if (store) store.set("revenue", state);
  const partial = Object.values(state.filters).some((s) => s.partial || s.cursor < latest);
  const cursor = Math.min(...Object.values(state.filters).map((s) => s.cursor));
  log(`  fee engine: ${notes.join(", ")} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

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

  /* Merge the per-filter day maps into one series. */
  const days = new Map();
  for (const st of Object.values(state.filters)) for (const [d, row] of Object.entries(st.byDay)) {
    const out = days.get(Number(d)) || { t: Number(d) };
    for (const [k, v] of Object.entries(row)) out[k] = (out[k] || 0) + v;
    days.set(Number(d), out);
  }
  const series = [...days.values()].sort((a, b) => a.t - b.t)
    .map((row) => ({ t: row.t, ...Object.fromEntries(DAY_FIELDS.map((k) => [k, +(row[k] || 0).toFixed(4)])) }));
  const sum = (k) => series.reduce((s, x) => s + (x[k] || 0), 0);
  const totals = Object.fromEntries(DAY_FIELDS.map((k) => [k, +sum(k).toFixed(2)]));
  totals.usdgToRevenue = +(totals.usdgToRevenueFromBuyback + totals.usdgToRevenueOther).toFixed(2);
  return {
    updatedAt: Math.floor(Date.now() / 1000),
    cursor, partial,
    filterCursors: Object.fromEntries(Object.entries(state.filters).map(([k, s]) => [k, { cursor: s.cursor, partial: !!s.partial }])),
    addresses: { buyback: LONG_BUYBACK, accumulator: LONG_AI_ACCUMULATOR, revenue: LONG_REVENUE_WALLET },
    fields: {
      aiToBuyback: "AI received by the buyback contract (fee legs in AI, and AI it bought by selling other fee legs)",
      aiBuybackToAccum: "AI the buyback contract forwarded to the accumulation EOA",
      aiBuybackToPools: "AI the buyback contract paid into pools: AI fee legs sold for the other side",
      aiBuybackElsewhere: "AI the buyback contract sent anywhere else",
      aiAccumOut: "AI sent out of the accumulation EOA (none as of 14 Sep 2026)",
      usdgToRevenueFromBuyback: "USDG into the revenue EOA from the buyback contract", usdgToRevenueOther: "USDG into the revenue EOA from any other sender",
      usdgRevenueOut: "USDG sent out of the revenue EOA", nvdaToRevenue: "NVDA received by the revenue EOA",
    },
    totals, balances, daily: series,
  };
}
