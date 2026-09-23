/* The LongX flywheel: how much AI the vault-token pairs absorb.
 *
 * LongX seeded AI pools with its own vault tokens -- NVDAx3L, OPENAIx1L,
 * ANTHROPICx1L -- described at launch as roughly $200K, about 10% of LongX TVL.
 * Anyone who wants those tokens from these pools has to pay in AI, and that AI
 * stays in the pool. NVDAx3L moves about three times NVDA's daily move, so when
 * NVDA rises the pool's vault tokens are cheap against the market and arbitrage
 * buys them out with AI; the protocol framed the whole thing as a buyback that can
 * grow into a sink for millions of AI.
 *
 * WHAT IS MEASURED, AND WHAT IS NOT
 *
 * The sink is cumulative net AI paid INTO these pools BY SWAPPERS. Only swaps
 * count: AI deposited as liquidity is parked, not absorbed, and counting it would
 * credit the flywheel with whatever an LP happened to add.
 *
 * It runs both ways. When NVDA falls, arbitrage sells vault tokens back into the
 * pool and takes AI out, and the figure shrinks. A day can be negative.
 *
 * It is NOT burned. The AI sits in liquidity positions that can be withdrawn. It
 * is reported as absorbed, in AI and in dollars and as a share of supply, so a
 * claim of "millions" can be set against an actual number.
 *
 * Pools are chosen by construction rather than by list: any AI pool whose other
 * token is a LongX vault token. A new pairing is picked up the run it appears.
 *
 * Sign convention is the decoder's, verified against 484 consecutive swaps: the
 * swapper's delta is positive when the swapper receives, so AI entering the pool
 * is a negative AI delta and adds to the sink.
 */
import { getLogsRange } from "../rpc.mjs";
import { POOL_MANAGER } from "../config.mjs";
import { TOPICS, decodeSwap, fmtUnits } from "../decode.mjs";
import { poolTickLadder, ladderRawAmounts } from "./depth.mjs";

const Q96 = 2 ** 96;
const DAY = 86400;
const STATE_V = 1;

export async function indexFlywheel(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const deadline = opts.deadline;
  const pools = opts.pools || [];                     // the AI pool census
  const vaults = opts.vaults || [];                   // LongX vault tokens from the perps task
  const aiUsd = opts.aiUsd || null;
  const aiSupply = opts.aiSupply || null;
  const priceAt = opts.priceAt || (() => null);

  const vaultBy = new Map(vaults.map((v) => [v.token.toLowerCase(), v]));
  const targets = pools.filter((p) => p.pairToken && vaultBy.has(p.pairToken.toLowerCase()));
  if (!targets.length) { log("  flywheel: no AI pool is paired with a LongX vault token"); return null; }

  const prev = opts.state?.v === STATE_V ? opts.state : { v: STATE_V, pools: {} };
  const state = { v: STATE_V, pools: {} };
  let partial = false, swapsRead = 0;

  const out = [];
  for (const p of targets) {
    const S = prev.pools[p.poolId] || {
      cursor: Math.max(0, (p.createdBlock || 0) - 1),
      aiIn: 0, aiOut: 0, pairIn: 0, pairOut: 0, swaps: 0, daily: {}, lastSqrt: null, ladder: null,
    };
    const v = vaultBy.get(p.pairToken.toLowerCase());
    const pairDec = p.pairDecimals ?? v.decimals ?? 18;
    const aiIs0 = !!p.aiIsCurrency0;

    if (S.cursor < latest) {
      const r = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.SWAP, p.poolId] }, S.cursor + 1, latest, {
        chunk: 5_000_000, deadline,
        onLogs: (logs) => {
          for (const l of logs) {
            const s = decodeSwap(l);
            const aiD = fmtUnits(aiIs0 ? s.amount0 : s.amount1, 18);
            const prD = fmtUnits(aiIs0 ? s.amount1 : s.amount0, pairDec);
            /* swapper's view: negative is what the swapper paid into the pool */
            if (aiD < 0) S.aiIn += -aiD; else S.aiOut += aiD;
            if (prD < 0) S.pairIn += -prD; else S.pairOut += prD;
            S.swaps++; swapsRead++;
            const t = tm.at(parseInt(l.blockNumber, 16));
            if (t != null) {
              const d = Math.floor(t / DAY) * DAY;
              const row = S.daily[d] || (S.daily[d] = { aiIn: 0, aiOut: 0, usdIn: 0, usdOut: 0 });
              const px = priceAt(t);
              if (aiD < 0) { row.aiIn += -aiD; if (px) row.usdIn += -aiD * px; }
              else { row.aiOut += aiD; if (px) row.usdOut += aiD * px; }
            }
            S.lastSqrt = s.sqrtPriceX96.toString();
          }
        },
      });
      if (r.truncated) partial = true;
      S.cursor = r.truncated ? (r.reachedBlock ?? S.cursor) : latest;
    }

    /* What the pool holds now, from its full position history at its live price.
       Context, not the sink: reserves include whatever LPs deposited, the sink is
       only what swappers paid in. */
    let reservesAi = null, reservesPair = null;
    try {
      S.ladder = await poolTickLadder(p.poolId, latest, S.ladder, { deadline });
      const sqrt = Number(BigInt(S.lastSqrt || p.lastSqrtPriceX96 || "0")) / Q96;
      if (sqrt > 0) {
        const { a0, a1 } = ladderRawAmounts(S.ladder.net || {}, sqrt);
        reservesAi = (aiIs0 ? a0 : a1) / 1e18;
        reservesPair = (aiIs0 ? a1 : a0) / 10 ** pairDec;
      }
    } catch { /* reserves are context; a failed ladder must not cost the flow figures */ }

    state.pools[p.poolId] = S;
    out.push({
      poolId: p.poolId, pair: v.symbol, vault: v.token, fee: p.fee,
      createdBlock: p.createdBlock ?? null, swaps: S.swaps,
      aiIn: +S.aiIn.toFixed(2), aiOut: +S.aiOut.toFixed(2), netAi: +(S.aiIn - S.aiOut).toFixed(2),
      pairIn: +S.pairIn.toFixed(4), pairOut: +S.pairOut.toFixed(4), netPairOut: +(S.pairOut - S.pairIn).toFixed(4),
      pairPriceUsd: v.priceUsd ?? null,
      reservesAi: reservesAi == null ? null : +reservesAi.toFixed(2),
      reservesPair: reservesPair == null ? null : +reservesPair.toFixed(4),
      reservesUsd: reservesAi == null ? null : Math.round((reservesAi * (aiUsd || 0)) + (reservesPair * (v.priceUsd || 0))),
    });
  }

  /* one daily series across all flywheel pools, with a running total */
  const days = new Map();
  for (const S of Object.values(state.pools)) {
    for (const [d, r] of Object.entries(S.daily)) {
      const x = days.get(+d) || { aiIn: 0, aiOut: 0, usdIn: 0, usdOut: 0 };
      x.aiIn += r.aiIn; x.aiOut += r.aiOut; x.usdIn += r.usdIn; x.usdOut += r.usdOut;
      days.set(+d, x);
    }
  }
  let cum = 0, cumUsd = 0;
  const daily = [...days.entries()].sort((a, b) => a[0] - b[0]).map(([t, r]) => {
    cum += r.aiIn - r.aiOut; cumUsd += r.usdIn - r.usdOut;
    return { t, aiIn: Math.round(r.aiIn), aiOut: Math.round(r.aiOut), netAi: Math.round(r.aiIn - r.aiOut),
      netUsd: Math.round(r.usdIn - r.usdOut), cumAi: Math.round(cum), cumUsdAtTime: Math.round(cumUsd) };
  });

  const netAi = out.reduce((s, r) => s + r.netAi, 0);
  const totals = {
    pools: out.length,
    swaps: out.reduce((s, r) => s + r.swaps, 0),
    aiIn: Math.round(out.reduce((s, r) => s + r.aiIn, 0)),
    aiOut: Math.round(out.reduce((s, r) => s + r.aiOut, 0)),
    netAi: Math.round(netAi),
    netAiUsdNow: aiUsd ? Math.round(netAi * aiUsd) : null,
    /* dollars at the price on the day each AI went in, which is what it cost the
       buyers; the figure above re-marks it all at today's price */
    netAiUsdAtTime: daily.length ? daily.at(-1).cumUsdAtTime : null,
    pctOfSupply: aiSupply ? +(netAi / aiSupply).toFixed(6) : null,
    reservesAi: Math.round(out.reduce((s, r) => s + (r.reservesAi || 0), 0)),
    reservesPairUsd: Math.round(out.reduce((s, r) => s + (r.reservesPair || 0) * (r.pairPriceUsd || 0), 0)),
    last7dAi: Math.round(daily.slice(-7).reduce((s, r) => s + r.netAi, 0)),
    last30dAi: Math.round(daily.slice(-30).reduce((s, r) => s + r.netAi, 0)),
  };

  log(`  flywheel: ${out.length} AI/vault pool(s), ${swapsRead.toLocaleString()} new swap(s); net ${totals.netAi.toLocaleString()} AI absorbed` +
    `${totals.netAiUsdNow != null ? ` ($${totals.netAiUsdNow.toLocaleString()} now)` : ""}; reserves ${totals.reservesAi.toLocaleString()} AI + $${totals.reservesPairUsd.toLocaleString()} vault tokens${partial ? " (partial)" : ""}`);

  return {
    state,
    artifact: {
      aiUsd, aiSupply, partial, pools: out.sort((a, b) => b.netAi - a.netAi), totals, daily,
      method: "Every swap in every AI pool whose other token is a LongX vault token, from the pool's creation. Absorbed AI is the AI swappers paid into these pools minus the AI swappers took out; liquidity deposits and withdrawals are excluded because they are parked, not absorbed. The figure falls when vault tokens are sold back into the pools. It is not burned: the AI sits in withdrawable liquidity positions. Reserves are what the pools hold now, valued from their full position history at the live price, and include liquidity from any provider.",
    },
  };
}
