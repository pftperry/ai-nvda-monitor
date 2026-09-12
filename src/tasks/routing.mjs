const r6 = (x) => (x === 0 ? 0 : +x.toPrecision(6));

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
  const priorDaily = opts.priorDaily || [];
  const rescanFrom = opts.rescanFromDay ?? -Infinity;
  for (const d of priorDaily) {
    // Days the new scan covers are recomputed; older ones carry forward untouched.
    if (d.t >= rescanFrom) continue;
    daily.set(d.t, { t: d.t, direct: d.direct || 0, cross: d.cross || 0, crossTx: d.crossTx || 0, directTx: d.directTx || 0 });
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
      const row = hubCounterparties.get(key)
        || { token: cp?.pairToken || null, symbol: cp?.pairSymbol || null, ai: 0 };
      row.ai += v;
      hubCounterparties.set(key, row);
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
