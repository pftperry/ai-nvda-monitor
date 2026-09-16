/**
 * The weekly retest of the Backing tab's two scores against what happened next, in
 * dollars, on the backfilled tape.
 *
 * Every published pair-day is scored the way the tab scores it (the tape score's
 * point rules are repeated here and must match web/app.js backingScore; standing is
 * the percentile profile within the sample) and set against the pair's dollar
 * price 7, 14 and 28 days later. Two samples are kept apart: the launch cohort
 * (selected on first-week activity, whatever became of it) and the tracked
 * survivors. Rank correlation, the up-rate of the top band against the base rate,
 * and, the part that makes this a test rather than a fit, the same figures on the
 * pair-days dated after the weights were set. One row is appended to the history
 * per ISO week, so the tab can show whether the score keeps working on weeks it
 * never saw.
 */
const DAY = 86400;
export const DESIGNED_AT = Date.UTC(2026, 8, 16) / 1000;   // 16 Sep 2026: the day the tape score's terms were fixed

/* Must mirror backingScore() in web/app.js. */
export function tapeScore(x) {
  let s = 50;
  if (x.swWk != null && x.swWk > 0.7) s += 20;
  if (x.dSw3 != null && x.dSw3 < -0.5) s -= 10;
  if (x.dU7 != null) { if (x.dU7 < -0.1) s -= 25; else if (x.dU7 >= 0 && x.dU7 <= 0.5) s += 15; }
  if (x.pr7 != null) { if (x.pr7 > 0 && x.pr7 <= 0.3) s += 10; else if (x.pr7 > 0.3) s -= 10; }
  if (x.backing != null && x.backing >= 0.05) s += 5;
  if (x.turnover != null && x.turnover >= 0.01 && x.turnover <= 0.5) s += 5;
  return Math.max(0, Math.min(100, s));
}
const fit = (t) => t == null ? null : t >= 0.01 && t <= 0.5 ? 1 : t < 0.01 ? t / 0.01 : t < 1 ? Math.max(0, (1 - t) / 0.5) : 0;
const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
function spearman(xs, ys) {
  const n = xs.length; if (n < 20) return null;
  const rx = rank(xs), ry = rank(ys), mu = (n - 1) / 2; let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - mu) * (ry[i] - mu); sxx += (rx[i] - mu) ** 2; syy += (ry[i] - mu) ** 2; }
  return sxx && syy ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : null;
}
const pct = (xs, v) => { let b = 0; for (const x of xs) if (x < v) b++; return b / Math.max(1, xs.length - 1); };

/* One row per traded pair-day with a dollar price: the tab's inputs and the forward dollar returns. */
export function pairDays(backfill) {
  const rows = [];
  for (const o of Object.values(backfill?.pools || {})) {
    const d = o.days.filter((x) => x.priceInStock > 0 && x.swaps > 0);
    for (let i = 7; i < d.length; i++) {
      const a = d[i]; if (!(a.priceUsd > 0)) continue;
      const fwd = (h) => { const z = d.find((z) => z.t >= a.t + h * DAY && z.t <= a.t + (h + 3) * DAY); return z && z.priceUsd > 0 ? Math.log(z.priceUsd / a.priceUsd) : null; };
      const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0), wk = d.slice(i - 6, i + 1), pwk = i >= 13 ? d.slice(i - 13, i - 6) : null;
      const x = { swWk: pwk && sum(pwk, "swaps") > 0 ? sum(wk, "swaps") / sum(pwk, "swaps") - 1 : null, dSw3: d[i - 3].swaps > 0 ? a.swaps / d[i - 3].swaps - 1 : null,
        dU7: d[i - 7].units > 0 && a.units > 0 ? a.units / d[i - 7].units - 1 : null, pr7: d[i - 7].priceUsd > 0 ? a.priceUsd / d[i - 7].priceUsd - 1 : null, backing: a.backing, turnover: a.turnover };
      rows.push({ t: a.t, cohort: !!o.cohort, share: a.share, backing: a.backing, turnover: a.turnover, swaps: a.swaps, units: a.units, tape: tapeScore(x), r7: fwd(7), r14: fwd(14), r28: fwd(28) });
    }
  }
  /* standing: percentile profile within each sample */
  for (const grp of [rows.filter((r) => r.cohort), rows.filter((r) => !r.cohort)]) {
    const c = (k) => grp.map((r) => r[k]).filter((v) => v != null);
    for (const r of grp) r.standing = Math.round(100 * (3 * pct(c("share"), r.share ?? 0) + 2 * pct(c("backing"), r.backing ?? 0) + 2 * (fit(r.turnover) ?? 0.5) + pct(c("swaps"), r.swaps) + pct(c("units"), r.units)) / 9);
  }
  return rows;
}

function evaluate(rows, score, topBand) {
  const out = {};
  for (const h of [7, 14, 28]) {
    const p = rows.filter((r) => r["r" + h] != null);
    if (!p.length) { out[h] = null; continue; }
    const top = p.filter((r) => r[score] >= topBand), rest = p.filter((r) => r[score] < topBand);
    const up = (g) => g.length ? +(g.filter((r) => r["r" + h] > 0).length / g.length).toFixed(3) : null;
    const med = (g) => { if (!g.length) return null; const v = g.map((r) => r["r" + h]).sort((a, b) => a - b); return +v[Math.floor(v.length / 2)].toFixed(3); };
    out[h] = { n: p.length, rho: spearman(p.map((r) => r[score]), p.map((r) => r["r" + h])), baseUp: up(p), topN: top.length, topUp: up(top), topMed: med(top), restUp: up(rest) };
  }
  return out;
}

/**
 * @param backfill  rwa.backing.backfill (with dollar prices)
 * @param opts      { prior: previous rwa.scoreTest, now }
 */
export function runScoreTest(backfill, opts = {}) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const rows = pairDays(backfill);
  const samples = { cohort: rows.filter((r) => r.cohort), survivors: rows.filter((r) => !r.cohort) };
  const scores = { tape: 75, standing: 70 };
  const block = (rs) => Object.fromEntries(Object.entries(scores).map(([s, band]) => [s, { band, ...evaluate(rs, s, band) }]));
  const all = Object.fromEntries(Object.entries(samples).map(([k, rs]) => [k, block(rs)]));
  const oosRows = rows.filter((r) => r.t >= DESIGNED_AT);
  const oos = { since: DESIGNED_AT, pairDays: oosRows.length, cohort: block(oosRows.filter((r) => r.cohort)), survivors: block(oosRows.filter((r) => !r.cohort)), all: block(oosRows) };
  /* one history row per ISO week: the headline figures at one week */
  const week = Math.floor((now - 4 * DAY) / (7 * DAY));   // weeks start Monday 00:00 UTC
  const head = (b) => b?.[7] ? { n: b[7].n, rho: b[7].rho, baseUp: b[7].baseUp, topUp: b[7].topUp, topN: b[7].topN } : null;
  const entry = { at: now, week, pairDays: rows.length, oosPairDays: oosRows.length,
    cohortTape: head(all.cohort.tape), cohortStanding: head(all.cohort.standing), survTape: head(all.survivors.tape), survStanding: head(all.survivors.standing), oosTape: head(oos.all.tape), oosStanding: head(oos.all.standing) };
  const history = (opts.prior?.history || []).filter((h) => h.week !== week).concat([entry]).sort((a, b) => a.week - b.week).slice(-52);
  return { at: now, designedAt: DESIGNED_AT, pairDays: rows.length, samples: { cohort: samples.cohort.length, survivors: samples.survivors.length }, bands: scores, all, oos, history,
    method: "every traded pair-day with a dollar price is scored as the tab scores it (tape score by its point rules, standing as the percentile profile within its sample) and set against the pair's dollar price 7, 14 and 28 days later; rank correlation, the top band's up-rate against the base rate; the out-of-sample block repeats this on pair-days dated after the terms were fixed; one history row per ISO week" };
}
