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
export function analyseRouting(txIndex, pools, tm) {
  let directAI = 0, crossAI = 0;
  let nDirectTx = 0, nCrossTx = 0, nMultiTx = 0;
  const routes = new Map();       // "FROM>TO" -> routed AI
  const daily = new Map();        // day -> { direct, cross }
  const hubCounterparties = new Map();

  // Each value is a flat array: [block, poolIdx, ai, pair, poolIdx, ai, pair, ...]
  for (const [, flat] of txIndex) {
    const block = flat[0];
    const nLegs = (flat.length - 1) / 3;
    const day = tm.dayBucket(block);
    let row = daily.get(day);
    if (!row) daily.set(day, (row = { t: day, direct: 0, cross: 0, crossTx: 0, directTx: 0 }));

    if (nLegs === 1) {
      const v = Math.abs(flat[2]);
      directAI += v; nDirectTx++;
      row.direct += v; row.directTx++;
      const sym = pools[flat[1]]?.pairSymbol || "?";
      hubCounterparties.set(sym, (hubCounterparties.get(sym) || 0) + v);
      continue;
    }

    nMultiTx++;
    let received = 0, spent = 0;
    const inLegs = [], outLegs = [];
    for (let k = 1; k < flat.length; k += 3) {
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

  // The writeup's κ × pair-mass products, for direct comparison.
  const scenarios = { bear: 0.04, base: 0.23, bull: 0.34, extraBull: 0.40 };
  const measured = directAI > 0 ? crossAI / directAI : 0;
  let regime = "below bear";
  for (const [k, v] of Object.entries(scenarios)) if (measured >= v) regime = k;

  return {
    measuredKappaRatio: +measured.toFixed(4),
    scenarios,
    impliedRegime: regime,
    directAI: r6(directAI),
    crossRoutedAI: r6(crossAI),
    transactions: { direct: nDirectTx, multiLeg: nMultiTx, crossRouting: nCrossTx },
    topRoutes: [...routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([route, ai]) => ({ route, ai: r6(ai) })),
    topCounterparties: [...hubCounterparties.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([symbol, ai]) => ({ symbol, ai: r6(ai) })),
    daily: series,
  };
}
