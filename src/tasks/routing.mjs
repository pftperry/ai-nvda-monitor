const r6 = (x) => (x === 0 ? 0 : +x.toPrecision(6));

/* How many recent complete days are checked for holes and repaired by widening
   the scan. Three is what a full run's window already covers, so a repair never
   costs more than a standard refresh. verify.mjs fails on a hole inside this
   horizon and only warns beyond it, since nothing would fix an older one. */
export const HOLE_HORIZON_DAYS = 3;
export const HOLE_RATIO = 0.2;   // routing volume below this share of flow's is a hole, not a quiet day

/**
 * A routing day whose volume disagrees with flow over the same day is a hole.
 *
 * Flow sums the AI leg of every swap on the indexed venues; routing sums per
 * transaction across every active venue. They measure overlapping populations, so
 * across a complete day they agree to within a small factor -- measured 0.85-0.95.
 * A day at a fifth of flow or less was rebuilt from a partial scan. Returns the
 * earliest such day among the last HOLE_HORIZON_DAYS complete days, or null, so the
 * caller can widen its scan to that day's start and rebuild it.
 */
export function routingHoleDay(perPool, prior, today) {
  if (!prior?.daily?.length || today == null) return null;
  const firstDay = prior.daily[0].t;
  const flowByDay = new Map();
  for (const p of perPool || []) {
    for (const h of p.hourly || []) {
      const d = Math.floor(h.t / 86400) * 86400;
      flowByDay.set(d, (flowByDay.get(d) || 0) + (h.aiBuy || 0) + (h.aiSell || 0));
    }
  }
  const byDay = new Map(prior.daily.map((d) => [d.t, d]));
  let earliest = null;
  for (let k = 1; k <= HOLE_HORIZON_DAYS; k++) {
    const t = today - k * 86400;
    if (t < firstDay) continue;                       // before the series began is not a hole
    const fv = flowByDay.get(t) || 0;
    if (fv < 1e6) continue;                            // a quiet day cannot be judged
    const r = byDay.get(t);
    const rv = r ? (r.direct || 0) + (r.cross || 0) : 0;
    if (rv < HOLE_RATIO * fv) earliest = t;
  }
  return earliest;
}

/**
 * Measured cross-routing intensity -- the real κ.
 *
 * The valuation writeup treats κ as "hardly measurable" and assigns it by assumption
 * (0.05 / 0.20 / 0.25 / 0.30, i.e. cross-routing flow of 4% / 23% / 34% / 40% of
 * direct volume). It is in fact directly observable: a BONER -> AI -> MEME rotation
 * emits two Swap logs under ONE transaction hash, one where the trader receives AI
 * and one where the trader spends it. AI is a pass-through hop exactly to the extent
 * those two legs overlap, so min(AI received, AI spent) within a tx is the routed
 * amount, and the remainder is genuine directional demand.
 */
export function analyseRouting(txIndex, pools, tm, opts = {}) {
  let directAI = 0, crossAI = 0;
  let nDirectTx = 0, nCrossTx = 0, nMultiTx = 0;
  const routes = new Map();       // "FROM>TO" -> routed AI
  const daily = new Map();        // day -> { direct, cross }
  const hubCounterparties = new Map();

  /* Routing is decomposable by transaction, and a transaction sits in exactly one
     block and therefore one day. That means the daily series can be merged across
     runs instead of recomputed: only days touched by the new scan change. Without
     this, κ required re-reading a multi-day window every run, which is what kept a
     refresh at tens of minutes and made a short schedule impossible. */
  /* Two ways to merge, and the difference is a bug that shipped.

     RESET (a full rescan): every day the scan reaches is dropped and rebuilt from
     the scan, so the scan must start on a day boundary or the first day is rebuilt
     from a fraction of itself. The caller aligns it.

     APPEND (a fast refresh): the scan covers only blocks after the stored cursor,
     so its transactions are strictly new and are ADDED to the stored days. The old
     code applied RESET to a three-hour scan, which rewrote the current day from its
     last three hours on every refresh -- measured, a complete day read 0.0M routed
     against 101M of flow -- and κ's own history, the scale the rating ranks it on,
     was mostly holes. A transaction sits in one block, so appending is exact. */
  const priorDaily = opts.priorDaily || [];
  const rescanFrom = opts.rescanFromDay ?? -Infinity;
  const additive = !!opts.additive;
  for (const d of priorDaily) {
    if (!additive && d.t >= rescanFrom) continue;
    daily.set(d.t, { t: d.t, direct: d.direct || 0, cross: d.cross || 0, crossTx: d.crossTx || 0, directTx: d.directTx || 0 });
  }
  /* The route and counterparty tables, and the scan's own counts, would otherwise
     describe fifteen minutes on an appending run. They carry forward and the new
     scan adds to them; a full rescan starts them over across its window. */
  if (additive && opts.prior) {
    for (const r of opts.prior.topRoutes || []) routes.set(r.route, (routes.get(r.route) || 0) + (r.ai || 0));
    for (const c of opts.prior.topCounterparties || []) {
      hubCounterparties.set(c.token || "unknown", { token: c.token || null, symbol: c.symbol || null, ai: c.ai || 0 });
    }
    const tx = opts.prior.transactions || {};
    nDirectTx += tx.direct || 0; nMultiTx += tx.multiLeg || 0; nCrossTx += tx.crossRouting || 0;
  }

  // Each value is a flat array: [block, poolIdx, aiAmount, poolIdx, aiAmount, ...]
  for (const [, flat] of txIndex) {
    const block = flat[0];
    const nLegs = (flat.length - 1) / 2;
    const day = tm.dayBucket(block);
    let row = daily.get(day);
    if (!row) daily.set(day, (row = { t: day, direct: 0, cross: 0, crossTx: 0, directTx: 0 }));

    if (nLegs === 1) {
      const v = Math.abs(flat[2]);
      directAI += v; nDirectTx++;
      row.direct += v; row.directTx++;
      /* Key by token address, not by symbol. Symbols are accident- and
         attacker-controlled on a permissionless chain: several pools here have a
         symbol() that reverts and all landed in one "?" row, and nothing stops two
         tokens sharing a ticker, which silently merged their volumes into one line. */
      const cp = pools[flat[1]];
      const key = cp?.pairToken || "unknown";
      /* Named cpRow, not row: `row` is the day bucket declared above with let, and a
         block-scoped const of the same name put it in TDZ for the whole branch --
         so `row.direct += v` two lines up threw ReferenceError and took the routing
         stage down with it. */
      const cpRow = hubCounterparties.get(key)
        || { token: cp?.pairToken || null, symbol: cp?.pairSymbol || null, ai: 0 };
      cpRow.ai += v;
      hubCounterparties.set(key, cpRow);
      continue;
    }

    nMultiTx++;
    let received = 0, spent = 0;
    const inLegs = [], outLegs = [];
    for (let k = 1; k < flat.length; k += 2) {
      const l = { p: flat[k], ai: flat[k + 1] };
      if (l.ai > 0) { received += l.ai; inLegs.push(l); }
      else { spent += -l.ai; outLegs.push(l); }
    }
    const passThrough = Math.min(received, spent);
    const residual = Math.abs(received - spent);

    if (passThrough > 0) {
      crossAI += passThrough; nCrossTx++;
      row.cross += passThrough; row.crossTx++;
      // attribute the route: AI came from the in-leg pool, went to the out-leg pool
      const src = inLegs.map((l) => pools[l.p]?.pairSymbol || "?").sort().join("+");
      const dst = outLegs.map((l) => pools[l.p]?.pairSymbol || "?").sort().join("+");
      const key = `${src}>${dst}`;
      routes.set(key, (routes.get(key) || 0) + passThrough);
    }
    if (residual > 0) { directAI += residual; row.direct += residual; }
  }

  const series = [...daily.values()].filter((d) => d.t).sort((a, b) => a.t - b.t)
    .map((d) => ({ ...d, direct: r6(d.direct), cross: r6(d.cross), ratio: d.direct > 0 ? +(d.cross / d.direct).toFixed(4) : 0 }));

  /* κ is taken from the merged daily series over a trailing window, not from this
     scan alone. Otherwise the headline would silently mean "κ over whatever range
     happened to be scanned", which changes run to run -- exactly the ambiguity
     that produced 37.7% on one window and 24.2% on another earlier today. */
  const windowDays = opts.windowDays || 3;
  const cutoff = series.length ? series[series.length - 1].t - windowDays * 86400 : 0;
  const win = series.filter((d) => d.t > cutoff);
  const winDirect = win.reduce((s, d) => s + d.direct, 0);
  const winCross = win.reduce((s, d) => s + d.cross, 0);

  // The writeup's κ × pair-mass products, for direct comparison.
  const scenarios = { bear: 0.04, base: 0.23, bull: 0.34, extraBull: 0.40 };
  const measured = winDirect > 0 ? winCross / winDirect : (directAI > 0 ? crossAI / directAI : 0);
  let regime = "below bear";
  for (const [k, v] of Object.entries(scenarios)) if (measured >= v) regime = k;

  return {
    measuredKappaRatio: +measured.toFixed(4),
    kappaWindowDays: windowDays,
    scanMode: additive ? "append" : "reset",
    scenarios,
    impliedRegime: regime,
    directAI: r6(winDirect || directAI),
    crossRoutedAI: r6(winCross || crossAI),
    // Counts describe this scan; the ratio above describes the trailing window.
    transactions: { direct: nDirectTx, multiLeg: nMultiTx, crossRouting: nCrossTx },
    topRoutes: [...routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([route, ai]) => ({ route, ai: r6(ai) })),
    topCounterparties: [...hubCounterparties.values()].sort((a, b) => b.ai - a.ai).slice(0, 25)
      .map((r) => ({ symbol: r.symbol, token: r.token, ai: r6(r.ai) })),
    daily: series,
  };
}
