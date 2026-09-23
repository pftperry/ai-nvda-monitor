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
const ZERO = "0x0000000000000000000000000000000000000000";
const pad = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();

/* Where each flywheel vault token actually trades.

   Holding a large share of a token's supply is not the same as capturing its
   trading: a pool can sit on 20% of the float while every trade routes somewhere
   cheaper. The flywheel only turns when vault-token trades go THROUGH an AI pool,
   because that is what makes someone buy AI. So for each vault token that has an AI
   pool, this finds every pool holding it -- AI or not, from the pool manager's
   Initialize log, the token on either side -- and reports what share of its pooled
   inventory and of its swaps sit in the AI pools.

   Cursor-resumed: the Initialize scan and each pool's swap count extend from where
   the last run stopped, so after the first run this is a handful of small queries. */
/* The block a token first moved. No pool can hold a token before it has been
   minted, so this is the true floor for finding every pool that holds it. Scanned
   forward in windows and stopped at the first hit, and only ever run once per token:
   the census cursor carries on from there. */
async function firstTransferBlock(token, from, latest, deadline) {
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const STEP = 4_000_000;
  for (let a = from; a <= latest; a += STEP) {
    if (deadline && Date.now() > deadline) return null;
    const b = Math.min(latest, a + STEP - 1);
    const r = await getLogsRange({ address: token, topics: [T] }, a, b, { chunk: STEP, deadline });
    if (r.length) return parseInt(r[0].blockNumber, 16);
  }
  return null;
}

async function routingCensus(tokens, latest, tm, aiPoolIds, prev, opts) {
  const deadline = opts.deadline;
  const state = {};
  const out = {};
  for (const [token] of tokens) {
    let P = prev?.[token];
    if (!P) {
      /* First sight of this token: find where it was born. If the budget runs out
         before that is known, skip the token for this run rather than start from a
         guess -- a guessed floor would be saved in the state and never revisited, so
         an older venue it missed would stay missing for good. */
      const born = await firstTransferBlock(token, opts.genesis ?? 0, latest, deadline);
      if (born == null) continue;
      P = { cursor: born - 1, pools: {}, floor: "first-transfer" };
    }
    if (P.cursor < latest) {
      let reached = latest, cut = false;
      for (const slot of [2, 3]) {
        const topics = [TOPICS.INITIALIZE, null, null, null].slice(0, slot + 1);
        topics[slot] = pad(token);
        const r = await getLogsRange({ address: POOL_MANAGER, topics }, P.cursor + 1, latest, { chunk: 20_000_000, deadline });
        for (const l of r) {
          const c0 = topicAddr(l.topics[2]), c1 = topicAddr(l.topics[3]);
          P.pools[l.topics[1]] ||= { c0, c1, cursor: parseInt(l.blockNumber, 16) - 1, swaps: 0, daily: {} };
        }
        if (r.truncated) { cut = true; reached = Math.min(reached, r.reachedBlock ?? P.cursor); }
      }
      P.cursor = cut ? reached : latest;
    }
    let pooled = 0, pooledAi = 0, swaps = 0, swapsAi = 0, wk = 0, wkAi = 0;
    const weekAgo = Math.floor((tm.at(latest) ?? Date.now() / 1000) / DAY) * DAY - 6 * DAY;
    const rows = [];
    for (const [id, Q] of Object.entries(P.pools)) {
      if (Q.cursor < latest) {
        const r = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.SWAP, id] }, Q.cursor + 1, latest, {
          chunk: 5_000_000, deadline,
          onLogs: (logs) => {
            for (const l of logs) {
              Q.swaps++;
              const t = tm.at(parseInt(l.blockNumber, 16));
              if (t != null) { const d = Math.floor(t / DAY) * DAY; Q.daily[d] = (Q.daily[d] || 0) + 1; }
              Q.lastSqrt = decodeSwap(l).sqrtPriceX96.toString();
            }
          },
        });
        Q.cursor = r.truncated ? (r.reachedBlock ?? Q.cursor) : latest;
      }
      /* inventory from the position history, at the pool's last traded price; a pool
         that has never traded has no price to value at and counts as holding none */
      let held = 0;
      if (Q.lastSqrt) {
        try {
          Q.ladder = await poolTickLadder(id, latest, Q.ladder, { deadline });
          const { a0, a1 } = ladderRawAmounts(Q.ladder.net || {}, Number(BigInt(Q.lastSqrt)) / Q96);
          held = (Q.c0 === token ? a0 : a1) / 1e18;
        } catch { held = 0; }
      }
      const isAi = aiPoolIds.has(id);
      const w = Object.entries(Q.daily).filter(([d]) => +d >= weekAgo).reduce((s, [, n]) => s + n, 0);
      pooled += held; swaps += Q.swaps; wk += w;
      if (isAi) { pooledAi += held; swapsAi += Q.swaps; wkAi += w; }
      rows.push({ poolId: id, other: Q.c0 === token ? Q.c1 : Q.c0, ai: isAi, held: +held.toFixed(4), swaps: Q.swaps, swaps7d: w });
    }
    state[token] = P;
    out[token] = {
      pools: rows.length,
      /* whether the census could see back to the token's birth, or only to just
         before its AI pool; the second can miss an older non-AI venue */
      coverage: P.floor || "first-transfer",
      pooled: +pooled.toFixed(4), pooledInAi: +pooledAi.toFixed(4),
      aiShareOfPooled: pooled > 0 ? +(pooledAi / pooled).toFixed(4) : null,
      swaps, swapsInAi: swapsAi, aiShareOfSwaps: swaps ? +(swapsAi / swaps).toFixed(4) : null,
      swaps7d: wk, swaps7dInAi: wkAi, aiShareOfSwaps7d: wk ? +(wkAi / wk).toFixed(4) : null,
      venues: rows.sort((a, b) => b.held - a.held).slice(0, 12),
    };
  }
  return { state, out };
}

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
    /* How the pool was stocked, read from what it holds.

       SEEDED: every AI in it arrived by swap -- the AI held matches the AI swappers
       paid in. That is what a single-sided seed of vault tokens looks like, and it is
       the flywheel proper. EMPTIED: the liquidity has been withdrawn, so whatever
       swappers paid in has left with it and is in nobody's sink. TWO-SIDED: AI came
       in by deposit as well as by swap, so this is an ordinary trading venue and its
       swap flow is drift, not absorption.

       Measured on the first run, these are not hypothetical: an emptied pool had
       taken in 4,075 AI and then released it, and two older trading pools with 23,000
       swaps between them had drifted +37K. Counting either as flywheel would have
       overstated it. */
    const netAiNow = S.aiIn - S.aiOut;
    const kind = reservesAi == null ? "unknown"
      : (reservesAi < 1 && (reservesPair ?? 0) < 1e-6) ? "emptied"
      : (netAiNow > 0 && Math.abs(reservesAi - netAiNow) <= Math.max(500, netAiNow * 0.05)) ? "seeded"
      : "two-sided";
    out.push({
      kind,
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

  /* Routing: for each vault token paired with AI, where does it trade at all. Started
     from the earliest AI pool on that token less a margin, since the perps task only
     knows vault tokens that exist and the pool manager's history before a token was
     minted cannot contain a pool for it. */
  let routing = null;
  try {
    const byToken = new Map();
    for (const p of targets) {
      const t = p.pairToken.toLowerCase();
      const b = Math.max(0, (p.createdBlock || 0) - 2_000_000);
      byToken.set(t, Math.min(byToken.get(t) ?? Infinity, b));
    }
    const aiIds = new Set(targets.map((p) => p.poolId));
    const rc = await routingCensus([...byToken], latest, tm, aiIds, prev.routing, { deadline, genesis: opts.genesis });
    state.routing = rc.state;
    routing = Object.fromEntries(Object.entries(rc.out).map(([tok, r]) => [vaultBy.get(tok)?.symbol || tok, { token: tok, ...r }]));
  } catch (e) {
    log(`  flywheel: routing census skipped (${e.message})`);
    state.routing = prev.routing;
  }

  /* The daily series is the flywheel alone: the seeded pools. Two-sided venues and
     emptied pools are kept out so the line shows absorption, not trading drift. */
  const seededIds = new Set(out.filter((r) => r.kind === "seeded").map((r) => r.poolId));
  const days = new Map();
  for (const [id, S] of Object.entries(state.pools)) {
    if (!seededIds.has(id)) continue;
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

  const seeded = out.filter((r) => r.kind === "seeded");
  const netAi = seeded.reduce((s, r) => s + r.netAi, 0);
  /* the seed is what the pool holds now plus what swappers took out of it */
  const seedOf = (r) => (r.reservesPair || 0) + (r.netPairOut || 0);
  const seedUsd = seeded.reduce((s, r) => s + seedOf(r) * (r.pairPriceUsd || 0), 0);
  const leftUsd = seeded.reduce((s, r) => s + (r.reservesPair || 0) * (r.pairPriceUsd || 0), 0);
  const allNet = out.reduce((s, r) => s + r.netAi, 0);
  const totals = {
    seededPools: seeded.length,
    seedUsd: Math.round(seedUsd), seedLeftUsd: Math.round(leftUsd),
    seedBoughtOut: seedUsd > 0 ? +(1 - leftUsd / seedUsd).toFixed(4) : null,
    heldAi: Math.round(seeded.reduce((s, r) => s + (r.reservesAi || 0), 0)),
    /* the ceiling on what this seed can still take in, at today's prices */
    capacityUsdNow: aiUsd ? Math.round(netAi * aiUsd + leftUsd) : null,
    allPairsNetAi: Math.round(allNet),
    pools: out.length,
    swaps: seeded.reduce((s, r) => s + r.swaps, 0),
    aiIn: Math.round(seeded.reduce((s, r) => s + r.aiIn, 0)),
    aiOut: Math.round(seeded.reduce((s, r) => s + r.aiOut, 0)),
    netAi: Math.round(netAi),
    netAiUsdNow: aiUsd ? Math.round(netAi * aiUsd) : null,
    /* dollars at the price on the day each AI went in, which is what it cost the
       buyers; the figure above re-marks it all at today's price */
    netAiUsdAtTime: daily.length ? daily.at(-1).cumUsdAtTime : null,
    pctOfSupply: aiSupply ? +(netAi / aiSupply).toFixed(6) : null,
    reservesAi: Math.round(seeded.reduce((s, r) => s + (r.reservesAi || 0), 0)),
    reservesPairUsd: Math.round(leftUsd),
    last7dAi: Math.round(daily.slice(-7).reduce((s, r) => s + r.netAi, 0)),
    last30dAi: Math.round(daily.slice(-30).reduce((s, r) => s + r.netAi, 0)),
  };

  log(`  flywheel: ${seeded.length} seeded of ${out.length} AI/vault pool(s), ${swapsRead.toLocaleString()} new swap(s); ${totals.netAi.toLocaleString()} AI absorbed by the seeded pools` +
    `${totals.netAiUsdNow != null ? ` ($${totals.netAiUsdNow.toLocaleString()} now)` : ""}; reserves ${totals.reservesAi.toLocaleString()} AI + $${totals.reservesPairUsd.toLocaleString()} vault tokens${partial ? " (partial)" : ""}`);

  return {
    state,
    artifact: {
      aiUsd, aiSupply, partial, pools: out.sort((a, b) => b.netAi - a.netAi), totals, daily, routing,
      method: "Every swap in every AI pool whose other token is a LongX vault token, from the pool's creation. The headline and the daily series cover only pools seeded single-sided with vault tokens, identified by holding the same AI that swappers paid in; two-sided trading venues and emptied pools are listed but not counted. Absorbed AI is the AI swappers paid into these pools minus the AI swappers took out; liquidity deposits and withdrawals are excluded because they are parked, not absorbed. The figure falls when vault tokens are sold back into the pools. It is not burned: the AI sits in withdrawable liquidity positions. Reserves are what the pools hold now, valued from their full position history at the live price, and include liquidity from any provider.",
    },
  };
}
