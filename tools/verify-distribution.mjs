/* An independent check of every holder-distribution figure the site publishes.
 *
 * This deliberately shares nothing with the holders task but the RPC client and
 * the address constants. It does not read that task's resume state, its running
 * balance map, or any of its intermediate output. It replays AI's own Transfer
 * log from the token's first block, folds it into balances itself, and recomputes
 * each published figure from those balances. A bug in the indexer therefore cannot
 * reproduce itself here and pass.
 *
 * Why the extra machinery:
 *
 * A partial replay is the dangerous failure. It produces counts that are the right
 * order of magnitude, sit in a plausible-looking table, and are wrong. Two earlier
 * attempts at this ran out of wall clock, reported 22,489 wallets against a
 * published 49,912, and looked like a real discrepancy rather than an unfinished
 * scan. So: every segment must reach the end of its range, and if any does not,
 * this prints nothing but the shortfall and exits non-zero.
 *
 * Folding balances is commutative: an address's balance is the sum of its deltas
 * and the order they arrive in does not change the total. So the block range is
 * cut into segments that scan concurrently and merge at the end. That is exact,
 * not an approximation, and it is the difference between finishing and not.
 *
 * Comparison is against the LAST PUBLISHED SNAPSHOT, at its own timestamp, not
 * against the chain head. Snapshots are taken every four hours; measuring at head
 * and comparing against a snapshot up to four hours old would manufacture a
 * difference out of nothing.
 */
import fs from "node:fs";
import { rpc, getLogsRange } from "../src/rpc.mjs";
import { AI, GENESIS_BLOCK, RPC_LABEL } from "../src/config.mjs";
import { HOLDER_BUCKETS, AI_THRESHOLDS, TOP_RANKS } from "../src/tasks/holders.mjs";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const addr = (t) => "0x" + t.slice(26).toLowerCase();
const WORKERS = Number(process.env.VERIFY_WORKERS || 6);
const BUDGET_MS = Number(process.env.VERIFY_BUDGET_MIN || 90) * 60_000;

const pub = JSON.parse(fs.readFileSync("web/data/holders.json", "utf8"));
const S = pub.snapshots.at(-1);
/* the excluded set travels with the artifact, so the comparison uses the same
   definition of "not a wallet" that the published number used */
const MACHINERY = new Set(pub.machineryExcluded.map((a) => a.toLowerCase()));

const tsOf = async (b) => parseInt((await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false])).timestamp, 16);
/* Bisect for the last block at or before a timestamp. A fixed blocks-per-day
   constant is close but not exact, and close on a 0.1s chain is thousands of
   blocks, which is thousands of transfers on either side of a cutoff. */
async function blockAt(target, lo, hi) {
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((await tsOf(mid)) <= target) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const head = parseInt(await rpc("eth_blockNumber", []), 16);
const bT = await blockAt(S.t, GENESIS_BLOCK, head);
const b4 = await blockAt(S.t - 4 * 3600, GENESIS_BLOCK, bT);
const b24 = await blockAt(S.t - 24 * 3600, GENESIS_BLOCK, bT);
console.log("endpoint " + RPC_LABEL);
console.log("snapshot " + new Date(S.t * 1000).toISOString() + " -> block " + bT.toLocaleString() + " (head " + head.toLocaleString() + ")");
console.log("cutoffs: 4h back " + b4.toLocaleString() + ", 24h back " + b24.toLocaleString());

const span = bT - GENESIS_BLOCK + 1;
const seg = Math.ceil(span / WORKERS);
const ranges = [];
for (let i = 0; i < WORKERS; i++) {
  const from = GENESIS_BLOCK + i * seg, to = Math.min(bT, GENESIS_BLOCK + (i + 1) * seg - 1);
  if (from <= to) ranges.push([from, to]);
}
console.log(ranges.length + " segments of ~" + seg.toLocaleString() + " blocks, budget " + (BUDGET_MS / 60000) + " min");

const deadline = Date.now() + BUDGET_MS;
const t0 = Date.now();
let done = 0;
const parts = await Promise.all(ranges.map(async ([from, to], i) => {
  /* three delta maps per segment: balances as of the snapshot, as of four hours
     before it, and as of twenty-four hours before it. One pass, three cutoffs. */
  const at = new Map(), p4 = new Map(), p24 = new Map();
  let n = 0;
  const bump = (m, a, v) => { if (a === ZERO) return; m.set(a, (m.get(a) || 0n) + v); };
  const apply = (m, f, t, v) => { bump(m, f, -v); bump(m, t, v); };
  const r = await getLogsRange({ address: AI, topics: [TRANSFER] }, from, to, {
    chunk: 400_000, deadline,
    onLogs: (batch) => {
      for (const l of batch) {
        const b = parseInt(l.blockNumber, 16);
        const f = addr(l.topics[1]), t = addr(l.topics[2]), v = BigInt(l.data);
        apply(at, f, t, v);
        if (b <= b4) apply(p4, f, t, v);
        if (b <= b24) apply(p24, f, t, v);
        n++;
      }
    },
  });
  const reached = r.reachedBlock ?? to;
  done++;
  console.log("  segment " + (i + 1) + "/" + ranges.length + ": " + n.toLocaleString() + " transfers, reached " +
    reached.toLocaleString() + " of " + to.toLocaleString() + (r.truncated ? "  TRUNCATED" : "") + "  (" + done + " complete)");
  return { ok: !r.truncated && reached >= to, at, p4, p24, n };
}));

const short = parts.filter((p) => !p.ok).length;
if (short) {
  console.log("\nINCOMPLETE: " + short + " of " + parts.length + " segments did not reach the end of their range.");
  console.log("No figures reported. Raise VERIFY_BUDGET_MIN or VERIFY_WORKERS and run again.");
  process.exit(2);
}
const merge = (k) => {
  const m = new Map();
  for (const p of parts) for (const [a, v] of p[k]) m.set(a, (m.get(a) || 0n) + v);
  return m;
};
const total = parts.reduce((s, p) => s + p.n, 0);
console.log("\nreplayed " + total.toLocaleString() + " transfers in " + ((Date.now() - t0) / 1000).toFixed(0) + "s\n");

/* a holder is a non-machinery address with a positive balance; everything below
   is derived from this list and nothing else */
const wallets = (m) => [...m.entries()].filter(([a, v]) => v > 0n && !MACHINERY.has(a));
const now = wallets(merge("at"));
const sizes = now.map(([, v]) => Number(v / 10n ** 12n) / 1e6).sort((a, b) => b - a);
const held = sizes.reduce((s, v) => s + v, 0);
const px = S.price;
const share = (k) => sizes.slice(0, k).reduce((s, v) => s + v, 0) / held;
let cum = 0, nakamoto = 0;
for (const v of sizes) { cum += v; nakamoto++; if (cum > held / 2) break; }
const setOf = (m) => new Set(wallets(m).map(([a]) => a));
const nowSet = new Set(now.map(([a]) => a));
const flow = (m) => {
  const then = setOf(m);
  let arrived = 0, exited = 0;
  for (const a of nowSet) if (!then.has(a)) arrived++;
  for (const a of then) if (!nowSet.has(a)) exited++;
  return { arrived, exited, net: arrived - exited };
};
const f4 = flow(merge("p4")), f24 = flow(merge("p24"));

let bad = 0;
const fNum = (v) => Math.round(v).toLocaleString();
const fPct = (v) => (100 * v).toFixed(2) + "%";
const row = (label, mine, theirs, fmt = fNum, tol = 0.02) => {
  const ok = theirs == null ? null : Math.abs(mine - theirs) <= Math.max(2, Math.abs(theirs) * tol);
  if (ok === false) bad++;
  console.log("  " + label.padEnd(34) + "chain " + String(fmt(mine)).padStart(12) +
    "   published " + String(theirs == null ? "-" : fmt(theirs)).padStart(12) +
    "   " + (ok == null ? "n/a" : ok ? "MATCH" : "DIFF"));
};

console.log("VERIFICATION, snapshot " + new Date(S.t * 1000).toISOString());
row("Wallets holding AI", now.length, S.holders);
HOLDER_BUCKETS.forEach((b, i) => {
  const hi = b.hi === null || b.hi === undefined ? Infinity : b.hi;
  row("  " + b.label, sizes.filter((v) => v * px >= b.lo && v * px < hi).length, S.buckets ? S.buckets[i] : null);
});
AI_THRESHOLDS.forEach((n, i) => row("Wallets over " + n.toLocaleString() + " AI", sizes.filter((v) => v >= n).length, S.aboveAi ? S.aboveAi[i] : null));
TOP_RANKS.forEach((k, i) => row("Top " + k + " share", share(k), S.top ? S.top[i] : null, fPct));
row("Wallets to reach 50% (Nakamoto)", nakamoto, S.nakamoto == null ? null : S.nakamoto);
row("AI held by wallets", held, S.heldAi, (v) => Math.round(v).toLocaleString(), 0.005);
row("Wallets arrived, 4h", f4.arrived, S.newHolders, fNum, 0.05);
row("Wallets exited, 4h", f4.exited, S.exits, fNum, 0.05);
console.log("  Net wallets, 24h                  chain " + String(fNum(f24.net)).padStart(12) +
  "   (arrived " + fNum(f24.arrived) + ", exited " + fNum(f24.exited) + ")");

console.log("\n" + (bad ? bad + " figure(s) disagree with the published artifact." : "Every compared figure agrees with the published artifact."));
process.exit(bad ? 1 : 0);
