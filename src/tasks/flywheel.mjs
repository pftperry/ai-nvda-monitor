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
   trading: a pool can sit on a fifth of the float while every trade routes
   somewhere cheaper. The flywheel only turns when vault-token trades go THROUGH an
   AI pool, because that is what makes someone buy AI. So for each vault token with
   an AI pool this finds every pool holding it, AI or not, and measures what share
   of the token's trading volume over the last seven days went through the AI pools.

   Volume, not swap counts. NVDAx3L turned out to sit in 2,682 pools, most of them
   launchpad tokens paired against it, and bots trading dust through those rack up
   counts that say nothing about where the size goes.

   Discovery is cursor-resumed from the block the token first moved, found by
   scanning its Transfer log forward: starting at the AI pool would miss an older
   venue such as the USDG pool opened when the vault launched. Activity fetches every
   pool's swaps in grouped OR-queries (960 pool ids per query), not one query per
   pool, which is what made the first version run out of time.

   An incomplete scan publishes NO share. The first version ran out of budget
   part-way through discovery, missed the AI pool, and reported "0.0% of swaps in AI
   pools" as though that were measured. A share is only computed when discovery
   reached the head and every activity group finished. */
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

const ROUTING_WINDOW = 7 * DAY;
const GROUP = 960;
const ROUTING_V = 2;

async function routingCensus(tokens, latest, tm, aiPoolIds, prev, opts) {
  const deadline = opts.deadline;
  const state = {};
  const out = {};
  const headT = tm.at(latest) ?? Math.floor(Date.now() / 1000);
  const winFrom = tm.blockAt(headT - ROUTING_WINDOW) ?? Math.max(0, latest - Math.round(ROUTING_WINDOW / 0.101));
  for (const [token] of tokens) {
    let P = prev?.[token];
    if (!P) {
      /* first sight: find where the token was born; if the budget runs out first,
         skip it this run rather than start from a guess that would be saved and
         never revisited */
      const born = await firstTransferBlock(token, opts.genesis ?? 0, latest, deadline);
      if (born == null) continue;
      P = { cursor: born - 1, pools: {} };
    }
    /* discovery */
    let discovered = true;
    if (P.cursor < latest) {
      let reached = latest;
      for (const slot of [2, 3]) {
        const topics = [TOPICS.INITIALIZE, null, null, null].slice(0, slot + 1);
        topics[slot] = pad(token);
        const r = await getLogsRange({ address: POOL_MANAGER, topics }, P.cursor + 1, latest, { chunk: 20_000_000, deadline });
        for (const l of r) P.pools[l.topics[1]] ||= { c0: topicAddr(l.topics[2]), c1: topicAddr(l.topics[3]) };
        if (r.truncated) { discovered = false; reached = Math.min(reached, r.reachedBlock ?? P.cursor); }
      }
      P.cursor = discovered ? latest : reached;
    }
    for (const [id, Q] of Object.entries(P.pools)) P.pools[id] = { c0: Q.c0, c1: Q.c1 };
    state[token] = P;
    if (!discovered) {
      out[token] = { complete: false, reason: "pool discovery did not reach the head this run", pools: Object.keys(P.pools).length };
      continue;
    }

    /* Activity, kept as per-day buckets with its own cursor. Re-reading a full week
       of swaps across every pool on every run would be tens of thousands of logs each
       time for NVDAx3L alone; resumed, a run reads only what is new. A pool found by
       discovery cannot have traded before it was created, and discovery reaches the
       head before activity runs, so a new pool has no swaps behind the cursor. */
    const ids = Object.keys(P.pools);
    const A = P.act || (P.act = { cursor: winFrom - 1, days: {} });
    if (A.cursor < winFrom - 1) A.cursor = winFrom - 1;       // a long gap: nothing older is needed
    let activityDone = true, scanReached = latest;
    if (A.cursor < latest) {
      for (let i = 0; i < ids.length; i += GROUP) {
        const group = ids.slice(i, i + GROUP);
        const r = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.SWAP, group] }, A.cursor + 1, latest, {
          chunk: 2_000_000, deadline,
          onLogs: (logs) => {
            for (const l of logs) {
              const id = l.topics[1], Q = P.pools[id];
              if (!Q) continue;
              const t = tm.at(parseInt(l.blockNumber, 16));
              if (t == null) continue;
              const sw = decodeSwap(l);
              const v = Math.abs(Number(Q.c0 === token ? sw.amount0 : sw.amount1)) / 1e18;
              const dk = Math.floor(t / DAY) * DAY;
              const day = A.days[dk] || (A.days[dk] = {});
              const cell = day[id] || (day[id] = [0, 0]);
              cell[0] += v; cell[1] += 1;
            }
          },
        });
        /* groups share one cursor, so a group that stopped short holds every group back
           to where it stopped; the others re-read that stretch next run, which is safe
           only because buckets are rebuilt from this run's cursor, so drop the partial */
        if (r.truncated) { activityDone = false; scanReached = Math.min(scanReached, r.reachedBlock ?? A.cursor); }
      }
    }
    if (!activityDone) {
      /* a partial pass would double-count when the stretch is re-read, so discard the
         buckets this run touched by restoring the cursor and clearing them */
      out[token] = { complete: false, reason: "the seven-day swap scan did not finish this run", pools: ids.length };
      P.act = null;                                    // rebuild the window cleanly next run
      continue;
    }
    A.cursor = latest;
    /* keep only the days that can still fall inside the window */
    const oldest = Math.floor((headT - ROUTING_WINDOW) / DAY) * DAY;
    for (const dk of Object.keys(A.days)) if (+dk < oldest) delete A.days[dk];

    const vol = new Map(), cnt = new Map();
    for (const [dk, day] of Object.entries(A.days)) {
      if (+dk < oldest) continue;
      for (const [id, [v, c]] of Object.entries(day)) { vol.set(id, (vol.get(id) || 0) + v); cnt.set(id, (cnt.get(id) || 0) + c); }
    }

    let total = 0, inAi = 0, swaps = 0, swapsAi = 0;
    const rows = [];
    for (const id of ids) {
      const v = vol.get(id) || 0, c = cnt.get(id) || 0;
      if (!c) continue;
      const Q = P.pools[id], isAi = aiPoolIds.has(id);
      total += v; swaps += c;
      if (isAi) { inAi += v; swapsAi += c; }
      rows.push({ poolId: id, other: Q.c0 === token ? Q.c1 : Q.c0, ai: isAi, volume7d: +v.toFixed(4), swaps7d: c });
    }
    rows.sort((a, b) => b.volume7d - a.volume7d);
    out[token] = {
      complete: true, windowDays: ROUTING_WINDOW / DAY,
      pools: ids.length, activePools: rows.length,
      volume7d: +total.toFixed(4), volume7dInAi: +inAi.toFixed(4),
      aiShareOfVolume7d: total > 0 ? +(inAi / total).toFixed(4) : null,
      swaps7d: swaps, swaps7dInAi: swapsAi,
      aiShareOfSwaps7d: swaps ? +(swapsAi / swaps).toFixed(4) : null,
      /* where the AI pools rank among the token's venues by volume, 1 = busiest */
      aiRank: rows.findIndex((r) => r.ai) + 1 || null,
      venues: rows.slice(0, 10),
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
  /* a pool can drop out of one run's selection and come back in the next (the fast
     path reuses a smaller pool set), so de-duplicate by id across whatever lists the
     caller passed rather than trusting any single one to be complete */
  const byId = new Map();
  for (const p of pools) if (p?.poolId && p.pairToken && vaultBy.has(p.pairToken.toLowerCase())) byId.set(p.poolId, p);
  const targets = [...byId.values()];
  if (!targets.length) { log("  flywheel: no AI pool is paired with a LongX vault token"); return null; }

  const prev = opts.state?.v === STATE_V ? opts.state : { v: STATE_V, pools: {} };
  /* carry forward every pool's accumulated state, including pools this run did not
     select, so a pool that briefly drops out does not rescan from its creation */
  const state = { v: STATE_V, pools: { ...(prev.pools || {}) } };
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
    let reservesAi = null, reservesPair = null, maxAi = null, riseToEdge = null;
    try {
      S.ladder = await poolTickLadder(p.poolId, latest, S.ladder, { deadline });
      const sqrt = Number(BigInt(S.lastSqrt || p.lastSqrtPriceX96 || "0")) / Q96;
      if (sqrt > 0) {
        const { a0, a1 } = ladderRawAmounts(S.ladder.net || {}, sqrt);
        reservesAi = (aiIs0 ? a0 : a1) / 1e18;
        reservesPair = (aiIs0 ? a1 : a0) / 10 ** pairDec;
        /* THE CEILING. Buy out every vault token and the price walks to the edge of
           the liquidity, where each position is 100% AI. That amount is fixed by the
           positions, not by the market: vault tokens appreciating makes arbitrage
           more likely to walk the price there but cannot move the edge. So this is the
           most AI the pool can ever hold, and only new liquidity raises it.

           Which edge: price is token1 per token0, and buying vault tokens pushes AI
           in. With AI as token0 that lowers the price, so the edge is below the lowest
           tick; with AI as token1 it raises it, so the edge is above the highest.

           riseToEdge is how far the vault token must climb, priced in AI, for the
           pool to get there. Measured on the first three seeded pools it was about 9x
           each, for a combined ceiling of 1,213,182 AI. */
        const ticks = Object.keys(S.ladder.net || {}).map(Number).sort((a, b) => a - b);
        if (ticks.length >= 2) {
          const edgeTick = aiIs0 ? ticks[0] : ticks[ticks.length - 1];
          const beyond = aiIs0 ? edgeTick - 1 : edgeTick + 1;
          const full = ladderRawAmounts(S.ladder.net, Math.pow(1.0001, beyond / 2));
          maxAi = (aiIs0 ? full.a0 : full.a1) / 1e18;
          const curTick = Math.floor(Math.log(sqrt * sqrt) / Math.log(1.0001));
          riseToEdge = Math.pow(1.0001, Math.abs(edgeTick - curTick));
        }
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
      maxAi: maxAi == null ? null : Math.round(maxAi),
      riseToEdge: riseToEdge == null ? null : +riseToEdge.toFixed(2),
    });
  }

  /* Routing: for each vault token paired with AI, where it trades at all. The census
     state is versioned on its own: the first version could save a discovery that had
     silently stopped short, and resuming from that would inherit the gap. A version
     change discards it and starts discovery again from each token's first transfer. */
  let routing = null;
  const prevRouting = prev.routingV === ROUTING_V ? prev.routing : null;
  state.routingV = ROUTING_V;
  try {
    const tokens = [...new Set(targets.map((p) => p.pairToken.toLowerCase()))].map((t) => [t]);
    const aiIds = new Set(targets.map((p) => p.poolId));
    const rc = await routingCensus(tokens, latest, tm, aiIds, prevRouting, { deadline, genesis: opts.genesis });
    /* a token skipped this run keeps whatever it had */
    state.routing = { ...(prevRouting || {}), ...rc.state };
    routing = Object.fromEntries(Object.entries(rc.out).map(([tok, r]) => [vaultBy.get(tok)?.symbol || tok, { token: tok, ...r }]));
  } catch (e) {
    log(`  flywheel: routing census skipped (${e.message})`);
    state.routing = prevRouting;
  }
  if (routing) {
    const parts = Object.entries(routing).map(([k, r]) => r.complete
      ? `${k} ${r.aiShareOfVolume7d == null ? "no volume" : (100 * r.aiShareOfVolume7d).toFixed(1) + "% of 7d volume in AI pools"} across ${r.activePools} active of ${r.pools}`
      : `${k} incomplete (${r.reason})`);
    log(`  flywheel routing: ${parts.join("; ")}`);
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
  /* the ceiling, recorded once per day at the last run of the day. It only moves
     when liquidity is added to or removed from the seeded pools, so a step in this
     series is the protocol changing the programme, not the market */
  const ceilingNow = Math.round(out.filter((r) => r.kind === "seeded").reduce((s, r) => s + (r.maxAi || 0), 0));
  const headDay = Math.floor((tm.at(latest) ?? Date.now() / 1000) / DAY) * DAY;
  state.ceilingDaily = { ...(prev.ceilingDaily || {}) };
  if (ceilingNow > 0) state.ceilingDaily[headDay] = ceilingNow;
  const ceilingDaily = Object.entries(state.ceilingDaily).map(([t, v]) => ({ t: +t, ceilingAi: v })).sort((a, b) => a.t - b.t);

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
    /* The hard ceiling of the current seed, in AI, and how much of it is filled.
       This replaces an earlier "capacity at today's prices" that valued the remaining
       vault tokens at market. That was wrong twice over: at today's prices almost
       nothing more is absorbed, because the pool is already arbitraged to market, and
       at the top of the ranges the seed takes in far more, because it sells the last
       vault tokens at the highest prices in its range. */
    ceilingAi: Math.round(seeded.reduce((s, r) => s + (r.maxAi || 0), 0)),
    ceilingUsdNow: aiUsd ? Math.round(seeded.reduce((s, r) => s + (r.maxAi || 0), 0) * aiUsd) : null,
    ceilingFilled: (() => {
      const c = seeded.reduce((s, r) => s + (r.maxAi || 0), 0), h = seeded.reduce((s, r) => s + (r.reservesAi || 0), 0);
      return c > 0 ? +(h / c).toFixed(4) : null;
    })(),
    /* the smallest move that would fill every seeded pool, since each fills at its own */
    riseToFill: seeded.length && seeded.every((r) => r.riseToEdge != null) ? Math.max(...seeded.map((r) => r.riseToEdge)) : null,
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
    `${totals.netAiUsdNow != null ? ` ($${totals.netAiUsdNow.toLocaleString()} now)` : ""}; ceiling ${totals.ceilingAi.toLocaleString()} AI, ${totals.ceilingFilled != null ? (100 * totals.ceilingFilled).toFixed(1) + "% filled" : "fill unknown"}; reserves ${totals.reservesAi.toLocaleString()} AI + $${totals.reservesPairUsd.toLocaleString()} vault tokens${partial ? " (partial)" : ""}`);

  return {
    state,
    artifact: {
      aiUsd, aiSupply, partial, pools: out.sort((a, b) => b.netAi - a.netAi), totals, daily, ceilingDaily, routing,
      method: "Every swap in every AI pool whose other token is a LongX vault token, from the pool's creation. The headline and the daily series cover only pools seeded single-sided with vault tokens, identified by holding the same AI that swappers paid in; two-sided trading venues and emptied pools are listed but not counted. Absorbed AI is the AI swappers paid into these pools minus the AI swappers took out; liquidity deposits and withdrawals are excluded because they are parked, not absorbed. The figure falls when vault tokens are sold back into the pools. It is not burned: the AI sits in withdrawable liquidity positions. Reserves are what the pools hold now, valued from their full position history at the live price, and include liquidity from any provider.",
    },
  };
}
