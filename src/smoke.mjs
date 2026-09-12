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
import { analyseRouting } from "./tasks/routing.mjs";
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
