/**
 * Offline smoke test: call the pure task logic with small inputs.
 *
 * `node --check` parses a file; it does not execute it, so it cannot see a
 * ReferenceError. That gap shipped a real outage: a block-scoped `const row` put
 * the outer `let row` into TDZ for one branch of analyseRouting, the parse was
 * clean, and every CI run then died inside the routing stage. Because the index
 * step is continue-on-error -- correctly, so a throttled RPC does not take the site
 * down -- the failure published the last good data instead of a red build, and the
 * site quietly fell four hours behind while every run reported "success".
 *
 * So: exercise the code paths that need no network before pushing. Seconds to run,
 * and it would have caught that immediately.
 */
import { analyseRouting, routingHoleDay } from "./tasks/routing.mjs";
import { walkBook, aiRatio, poolImpact, mergedImpact, IMPACT_SIZES } from "./tasks/depth.mjs";
import { isStockCode } from "./tasks/rwa.mjs";
import { encodeAggregate3, decodeAggregate3 } from "./tokens.mjs";
import { getLogsRange } from "./rpc.mjs";
import { TimeMap } from "./timemap.mjs";

let failures = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(` FAIL  ${name}\n         ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// Two anchors are enough for dayBucket to interpolate.
const tm = new TimeMap([[1000, 1_780_000_000], [2000, 1_780_000_100]]);
const pools = [
  { poolId: "0xaaa", pairToken: "0xtok1", pairSymbol: "TOK1" },
  { poolId: "0xbbb", pairToken: "0xtok2", pairSymbol: null },   // symbol() reverted
  { poolId: "0xccc", pairToken: "0xtok1", pairSymbol: "TOK1" }, // same token, 2nd venue
];

console.log("Module graph");

/* Every relative import in src/ must resolve to a file that exists.
   `node --check` parses a file without resolving anything it imports, so a deleted
   or renamed module leaves every syntax check passing and the program dead on
   startup. That happened three times in one day here -- most recently after a task
   file was replaced and its import left behind, which parsed clean and could not
   load. Checking the graph statically costs milliseconds and needs no network, no
   execution and no side effects, which is why it can sit in front of everything
   else. */
{
  const { readdirSync, readFileSync, existsSync } = await import("fs");
  const { join, dirname, resolve } = await import("path");
  const root = "src";
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".mjs")) files.push(f);
    }
  };
  walk(root);

  const broken = [];
  let edges = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"](\.[^'"]+)['"]/g)) {
      edges++;
      const target = resolve(dirname(f), m[1]);
      if (!existsSync(target)) broken.push(`${f} -> ${m[1]}`);
    }
    for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      edges++;
      const target = resolve(dirname(f), m[1]);
      if (!existsSync(target)) broken.push(`${f} -> ${m[1]} (dynamic)`);
    }
  }
  ok(`all ${edges} relative imports across ${files.length} modules resolve`, () => {
    assert(!broken.length, `missing:\n         ${broken.join("\n         ")}`);
  });

  /* Resolving imports is not parsing. An import line inserted above the indexer's
     shebang left every path resolvable and the file unparseable, and this check
     passed it -- CI would then have failed the index step on every run and quietly
     republished the last good data. So every module, the page script included, is
     also handed to the real parser. */
  const { execFileSync } = await import("child_process");
  const unparsed = [];
  for (const f of [...files, "web/app.js"]) {
    try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
    catch (e) { unparsed.push(`${f}: ${String(e.stderr || e.message).split("\n").find((l) => l.trim()) || "syntax error"}`); }
  }
  ok(`all ${files.length + 1} modules parse`, () => {
    assert(!unparsed.length, `unparseable:\n         ${unparsed.join("\n         ")}`);
  });
}

console.log("Routing");

ok("a single-leg tx counts as direct volume", () => {
  const tx = new Map([["0x1", [1500, 0, 100]]]);
  const r = analyseRouting(tx, pools, tm, {});
  assert(r.directAI === 100, `directAI ${r.directAI}`);
  assert(r.transactions.direct === 1, "one direct tx");
  assert(r.crossRoutedAI === 0, "no cross-routing");
});

ok("a pass-through tx counts the overlapping leg as routed", () => {
  // receives 100 AI on one pool, spends 90 on another: 90 routed, 10 directional
  const tx = new Map([["0x2", [1500, 0, 100, 1, -90]]]);
  const r = analyseRouting(tx, pools, tm, {});
  assert(r.crossRoutedAI === 90, `crossRoutedAI ${r.crossRoutedAI}`);
  assert(r.directAI === 10, `residual ${r.directAI}`);
});

ok("counterparties key on token address, not symbol", () => {
  const tx = new Map([
    ["0x1", [1500, 0, 60]],   // TOK1 via pool aaa
    ["0x2", [1500, 2, 40]],   // TOK1 via pool ccc -- same token, different venue
    ["0x3", [1500, 1, 25]],   // unnamed token
  ]);
  const r = analyseRouting(tx, pools, tm, {});
  const tok1 = r.topCounterparties.filter((c) => c.token === "0xtok1");
  assert(tok1.length === 1, `TOK1 should merge to one row, got ${tok1.length}`);
  assert(tok1[0].ai === 100, `TOK1 volume ${tok1[0].ai}`);
  const unnamed = r.topCounterparties.find((c) => c.token === "0xtok2");
  assert(unnamed && unnamed.symbol === null, "an unresolved symbol stays null, not \"?\"");
});

ok("prior days merge forward and only rescanned days recompute", () => {
  const day = Math.floor(1_780_000_000 / 86400) * 86400;
  const r = analyseRouting(new Map([["0x1", [1500, 0, 10]]]), pools, tm, {
    priorDaily: [{ t: day - 86400 * 3, direct: 500, cross: 50, crossTx: 1, directTx: 2 }],
    rescanFromDay: day,
  });
  assert(r.daily.length === 2, `expected prior + current day, got ${r.daily.length}`);
  assert(r.daily[0].direct === 500, "the older day carried forward untouched");
});

ok("an empty index does not throw or divide by zero", () => {
  const r = analyseRouting(new Map(), pools, tm, {});
  assert(r.measuredKappaRatio === 0, "κ is zero, not NaN");
  assert(Array.isArray(r.daily), "daily is still an array");
});

/* The fast path appends to the day it lands in instead of replacing it. This is
   the bug that hollowed out κ's history: a three-hour scan used to REPLACE the
   whole current day, so a complete day read 0.0M routed against 101M of flow. */
ok("an appending scan adds to the stored day rather than replacing it", () => {
  const day = Math.floor(1_780_000_000 / 86400) * 86400;
  const prior = {
    daily: [{ t: day, direct: 500, cross: 50, crossTx: 4, directTx: 9 }],
    topRoutes: [{ route: "TOK1>TOK1", ai: 30 }],
    topCounterparties: [{ symbol: "TOK1", token: "0xtok1", ai: 500 }],
    transactions: { direct: 9, multiLeg: 5, crossRouting: 4 },
  };
  const tx = new Map([["0x9", [1500, 0, 100]], ["0xa", [1500, 0, 100, 2, -90]]]);
  const r = analyseRouting(tx, pools, tm, { priorDaily: prior.daily, prior, additive: true, rescanFromDay: day });
  const row = r.daily.find((d) => d.t === day);
  assert(row, "the day is still there");
  assert(row.direct === 610, `direct should be 500 + 100 + 10 residual, got ${row.direct}`);
  assert(row.cross === 140, `cross should be 50 + 90, got ${row.cross}`);
  assert(row.directTx === 10 && row.crossTx === 5, `tx counts should add (${row.directTx}, ${row.crossTx})`);
  assert(r.transactions.direct === 10 && r.transactions.crossRouting === 5, "scan counts carry forward and add");
  const route = r.topRoutes.find((x) => x.route === "TOK1>TOK1");
  assert(route && route.ai === 120, `route volume should be 30 + 90, got ${route?.ai}`);
  assert(r.scanMode === "append", "the artifact says how it was merged");
});

ok("a resetting scan still replaces the days it covers", () => {
  const day = Math.floor(1_780_000_000 / 86400) * 86400;
  const r = analyseRouting(new Map([["0x9", [1500, 0, 100]]]), pools, tm, {
    priorDaily: [{ t: day, direct: 500, cross: 50, crossTx: 4, directTx: 9 }], rescanFromDay: day,
  });
  assert(r.daily.find((d) => d.t === day).direct === 100, "the day was rebuilt from the scan alone");
  assert(r.scanMode === "reset", "reset is the default");
});

ok("a routing day far below flow is reported as a hole, a quiet day is not", () => {
  const today = Math.floor(1_780_000_000 / 86400) * 86400;
  const d1 = today - 86400, d2 = today - 2 * 86400, d3 = today - 3 * 86400;
  const hourly = (t, v) => Array.from({ length: 24 }, (_, i) => ({ t: t + i * 3600, aiBuy: v / 48, aiSell: v / 48 }));
  const perPool = [{ hourly: [...hourly(d1, 90e6), ...hourly(d2, 100e6), ...hourly(d3, 5e5)] }];
  const prior = { daily: [{ t: d3, direct: 0, cross: 0 }, { t: d2, direct: 0, cross: 0 }, { t: d1, direct: 80e6, cross: 5e6 }] };
  assert(routingHoleDay(perPool, prior, today) === d2, "the hollow day two days back is the repair target");
  const shallow = { daily: [{ t: d2, direct: 35e6, cross: 3e6 }, { t: d1, direct: 80e6, cross: 5e6 }] };
  assert(routingHoleDay(perPool, shallow, today) === d2, "a day at a third of flow is a hole too, not a quiet day");
  assert(routingHoleDay(perPool, { daily: [{ t: d1, direct: 80e6, cross: 5e6 }] }, today) === null, "a healthy day is not a hole");
  assert(routingHoleDay(perPool, { daily: [{ t: d1, direct: 80e6, cross: 5e6 }, { t: today, direct: 1, cross: 0 }] }, today) === null, "today is never judged: it is still filling");
  assert(routingHoleDay(perPool, null, today) === null, "no prior series, nothing to repair");
});

console.log("Cost to trade");

/* One full-range position of liquidity L at price 1 (sqrt 1) in a pool where AI is
   token0. Selling x AI moves sqrt price to 1/(1 + x/L); the walk must land there. */
{
  const L = 1e24;
  const net = { "-887272": String(L), "887272": String(-L) };
  const pool = { lastSqrtPriceX96: (2n ** 96n).toString(), aiIsCurrency0: true, pairDecimals: 18 };
  ok("selling AI into one position lands on the closed form", () => {
    const r = walkBook(net, 1, true, "sell", { amountRaw: 0.1 * L });
    assert(r && !r.exhausted, "the book should absorb it");
    assert(Math.abs(r.sqrtEnd - 1 / 1.1) < 1e-9, `sqrt should be 1/1.1, got ${r.sqrtEnd}`);
    assert(Math.abs(aiRatio(r.sqrtEnd, 1, true) - 1 / 1.21) < 1e-9, "AI's price falls to 1/1.21");
    assert(Math.abs(r.used - 0.1 * L) < 1, "everything asked for was used");
  });
  ok("buying AI moves the price up and a target price stops the walk", () => {
    const r = walkBook(net, 1, true, "buy", { amountRaw: 0.1 * L });
    assert(r.sqrtEnd > 1 && Math.abs(r.sqrtEnd - 1 / 0.9) < 1e-9, `sqrt should be 1/0.9, got ${r.sqrtEnd}`);
    const t = walkBook(net, 1, true, "sell", { targetSqrt: 0.5 });
    assert(Math.abs(t.sqrtEnd - 0.5) < 1e-12 && Math.abs(t.used - L) < 1, `stops at the target having sold L, got ${t.used}`);
  });
  /* aiUsd = 1 makes $1M exactly L raw of AI: selling it halves the sqrt price, so
     AI's price falls 75%; $100K is a tenth of L and costs 17.4%. Big enough to see,
     small enough that no size runs the book dry. */
  ok("impact grows with size and the merged walk agrees with a single venue", () => {
    const one = poolImpact(pool, { net }, 1);
    assert(Math.abs(one.sell[3].pct - 0.75) < 1e-4, `$1M should cost 75%, got ${one.sell[3].pct}`);
    assert(Math.abs(one.sell[0].pct - (1 - 1 / 1.21)) < 1e-4, `$100K should cost 17.4%, got ${one.sell[0].pct}`);
    assert(one.sell.every((x, i) => i === 0 || x.pct >= one.sell[i - 1].pct), "sell impact is monotonic in size");
    assert(one.buy.every((x, i) => i === 0 || x.pct >= one.buy[i - 1].pct), "buy impact is monotonic in size");
    const m = mergedImpact([{ pool, ladder: { net } }], 1);
    for (let i = 0; i < IMPACT_SIZES.length; i++) assert(Math.abs(m.sell[i].pct - one.sell[i].pct) < 1e-3, `merged sell ${i}: ${m.sell[i].pct} vs ${one.sell[i].pct}`);
    const two = mergedImpact([{ pool, ladder: { net } }, { pool, ladder: { net } }], 1);
    assert(two.sell[3].pct < one.sell[3].pct, "two venues absorb a sale with less impact than one");
    assert(Math.abs(two.sell[3].pct - (1 - 1 / 1.5 ** 2)) < 1e-3, `two venues splitting $1M each sell L/2: ${two.sell[3].pct}`);
  });
  ok("when AI is token1 the same sale moves its price the same way", () => {
    const p1 = { ...pool, aiIsCurrency0: false };
    const r = walkBook(net, 1, false, "sell", { amountRaw: 0.1 * L });
    assert(r.sqrtEnd > 1, "selling token1 raises token1-per-token0");
    assert(aiRatio(r.sqrtEnd, 1, false) < 1, "but AI's own price still falls");
    const i = poolImpact(p1, { net }, 1);
    assert(Math.abs(i.sell[0].pct - (1 - 1 / 1.21)) < 1e-4, `same 17.4% from the other side, got ${i.sell[0].pct}`);
  });
  ok("an empty or exhausted book is reported, not guessed", () => {
    assert(walkBook({}, 1, true, "sell", { amountRaw: 1 }) === null, "no ticks, no answer");
    /* A full-range position is never exhausted (price can go to zero), so a
       bounded one: 1% either side of spot holds about L/200 of each token. */
    const bounded = { "-100": String(L), "100": String(-L) };
    const r = walkBook(bounded, 1, true, "sell", { amountRaw: L });
    assert(r.exhausted, "more than the band holds runs it dry");
    const i = poolImpact(pool, { net: bounded }, 1);
    assert(i.sell[3].pct === 1, "and the impact reads as the whole book");
  });
}

console.log("\nMulticall encoding");
ok("aggregate3 calldata has the ABI shape and its result decodes back to per-call bytes", () => {
  const calls = [
    { to: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", data: "0x18160ddd" },
    { to: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", data: "0x70a08231" + "8366a39cc670b4001a1121b8f6a443a643e40951".padStart(64, "0") },
  ];
  const enc = encodeAggregate3(calls);
  assert(enc.startsWith("0x82ad56cb"), "aggregate3 selector");
  const w = (i) => enc.slice(10 + i * 64, 10 + (i + 1) * 64);
  assert(BigInt("0x" + w(0)) === 32n && BigInt("0x" + w(1)) === 2n, "array offset and length");
  assert(BigInt("0x" + w(2)) === 64n, "first tuple starts after two head words");
  // first tuple: target, allowFailure, bytes offset 0x60, length 4, data
  assert(w(4).endsWith("d0601ce157db5bdc3162bbac2a2c8af5320d9eec") && BigInt("0x" + w(5)) === 1n && BigInt("0x" + w(6)) === 0x60n && BigInt("0x" + w(7)) === 4n, "tuple layout");
  assert((enc.length - 10) % 64 === 0, "whole words");
  /* A hand-built return: two (bool success, bytes returnData) tuples, the second failed. */
  const W = (h) => h.replace(/^0x/, "").padStart(64, "0");
  const t1 = W("1") + W("40") + W("20") + W("714b276e02211902549");
  const t2 = W("0") + W("40") + W("0");
  const ret = "0x" + W("20") + W("2") + W("40") + W((64 + t1.length / 2).toString(16)) + t1 + t2;
  const dec = decodeAggregate3(ret, 2);
  assert(BigInt(dec[0]) === 0x714b276e02211902549n, `first result decodes, got ${dec[0]}`);
  assert(dec[1] === null, "a failed sub-call is null, not garbage");
  let threw = false; try { decodeAggregate3(ret, 3); } catch { threw = true; }
  assert(threw, "a count mismatch is an error");
});

console.log("\nStock-token classifier");
ok("Robinhood's proxy bytecode is recognised by length and prefix, nothing else", () => {
  const good = "0x6080604052600a600c565b" + "00".repeat(283 - 11);
  assert(isStockCode(good), "the template matches");
  assert(!isStockCode(good + "00"), "one byte longer is a different contract");
  assert(!isStockCode("0x6080604052366100135761" + "00".repeat(283 - 11)), "same length, different prefix");
  assert(!isStockCode(null) && !isStockCode("0x"), "no code is not a stock");
});

console.log("\nTime map");

ok("blockAt inverts at() on anchors and between them", () => {
  const map = new TimeMap([[1000, 1_780_000_000], [2000, 1_780_000_100], [4000, 1_780_000_300]]);
  assert(map.blockAt(1_780_000_000) === 1000, "first anchor");
  assert(map.blockAt(1_780_000_100) === 2000, "second anchor");
  assert(map.blockAt(1_780_000_050) === 1500, `midpoint should be 1500, got ${map.blockAt(1_780_000_050)}`);
  assert(map.blockAt(1_780_000_200) === 3000, `across a different rate, got ${map.blockAt(1_780_000_200)}`);
  assert(map.blockAt(1_780_000_400) === 5000, `extrapolates past the last anchor, got ${map.blockAt(1_780_000_400)}`);
  assert(map.at(map.blockAt(1_780_000_137)) === 1_780_000_137, "round trip lands on the same second");
});

console.log("\nScan deadline");

/* Testable without a network because an expired deadline must short-circuit before
   the first request. That is the whole point of it: the bridge step's budget used
   to be checked only between tokens, so one token's discovery ran forty-five
   minutes inside a single call. If this ever stops short-circuiting, that returns. */
{
  const t0 = Date.now();
  let r = null, threw = null;
  try { r = await getLogsRange({ address: "0x0", topics: [] }, 1000, 50_000_000, { deadline: Date.now() - 1 }); }
  catch (e) { threw = e.message; }
  const elapsed = Date.now() - t0;
  ok("an expired deadline returns before any request", () => {
    assert(!threw, `threw: ${threw}`);
    assert(elapsed < 500, `took ${elapsed}ms — it made a network call`);
    assert(r.length === 0, `returned ${r.length} logs`);
  });
  ok("an interrupted scan reports where it stopped", () => {
    assert(!threw, `threw: ${threw}`);
    assert(r.truncated === true, "truncated flag not set");
    assert(r.reachedBlock === 999, `reachedBlock ${r.reachedBlock}, expected the block before the start`);
  });
}

console.log(`\n${failures ? failures + " FAILED" : "all smoke tests passed"}`);
process.exit(failures ? 1 : 0);
