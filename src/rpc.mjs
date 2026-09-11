import { RPCS, LIMITS } from "./config.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let callCount = 0;
export const rpcCalls = () => callCount;

let rpcIdx = 0;
const endpoint = () => RPCS[rpcIdx % RPCS.length];

class TooManyLogs extends Error {}
export { TooManyLogs };

/* Adaptive pacing. The endpoint throttles a datacenter IP far harder than a
   residential one -- the same scan that runs clean locally gets rate-limited on a
   CI runner -- so the client slows itself down when it sees pushback and speeds
   back up when it stops. A fixed delay cannot serve both environments. */
let paceMs = LIMITS.politeDelayMs;
const PACE_MAX = 4000;
const slowDown = () => { paceMs = Math.min(PACE_MAX, Math.max(200, Math.round(paceMs * 1.8))); };
const speedUp = () => { paceMs = Math.max(LIMITS.politeDelayMs, Math.round(paceMs * 0.97)); };
export const pace = () => paceMs;

const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);

/**
 * Single JSON-RPC call. Retries transient failures with capped exponential
 * backoff. Throws TooManyLogs immediately so callers can subdivide rather than
 * wait out a condition that will never resolve on its own.
 */
export async function rpc(method, params, tries = 12) {
  let last;
  for (let i = 0; i < tries; i++) {
    callCount++;
    let j;
    try {
      const res = await fetch(endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: callCount, method, params }),
      });
      if (res.status === 429 || res.status === 503 || res.status === 502) {
        slowDown();
        const ra = Number(res.headers.get("retry-after"));
        last = new Error(`HTTP ${res.status}`);
        await sleep(jitter(ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** i)));
        continue;
      }
      const text = await res.text();
      try { j = JSON.parse(text); }
      catch {
        // an HTML error page or a truncated body: transient, worth retrying
        last = new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
        slowDown();
        await sleep(jitter(Math.min(30000, 1000 * 2 ** i)));
        continue;
      }
    } catch (e) {
      last = e; rpcIdx++; slowDown();
      await sleep(jitter(Math.min(30000, 1000 * 2 ** i)));
      continue;
    }
    if (j.error) {
      const msg = j.error.message || "";
      if (/exceeds limit/i.test(msg)) throw new TooManyLogs(msg);
      if (/timed out|too many|rate|capacity|busy/i.test(msg) || String(j.error.code) === "429") {
        last = new Error(msg); slowDown();
        await sleep(jitter(Math.min(30000, 1000 * 2 ** i)));
        continue;
      }
      throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    }
    speedUp();
    if (paceMs) await sleep(paceMs);
    return j.result;
  }
  // Surfacing the underlying cause matters: "retries exhausted" alone is unactionable.
  throw new Error(`${method}: gave up after ${tries} attempts — last error: ${last ? last.message : "unknown"}`);
}

/** Batched JSON-RPC. Falls back to sequential calls if the node rejects batching. */
export async function rpcBatch(calls) {
  if (!calls.length) return [];
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));
  for (let attempt = 0; attempt < 5; attempt++) {
    callCount++;
    try {
      const res = await fetch(endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        slowDown();
        await sleep(jitter(Math.min(30000, 1000 * 2 ** attempt)));
        continue;
      }
      const j = await res.json();
      if (!Array.isArray(j)) break;
      const out = new Array(calls.length);
      let retryable = false;
      for (const r of j) {
        if (r.error && /timed out|too many|rate/i.test(r.error.message || "")) retryable = true;
        out[r.id] = r.error ? null : r.result;
      }
      if (retryable) { slowDown(); await sleep(jitter(Math.min(30000, 1000 * 2 ** attempt))); continue; }
      speedUp();
      await sleep(paceMs);
      return out;
    } catch { slowDown(); await sleep(jitter(Math.min(20000, 1000 * 2 ** attempt))); }
  }
  const out = [];
  for (const c of calls) { try { out.push(await rpc(c.method, c.params)); } catch { out.push(null); } }
  return out;
}

export const hexBlock = (n) => "0x" + Number(n).toString(16);
export const padAddr = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");

export async function blockNumber() {
  return parseInt(await rpc("eth_blockNumber", []), 16);
}

/**
 * eth_getLogs over an arbitrary block range.
 *
 * The node enforces a hard 10,000-log cap and times out on wide ranges, so a
 * fixed chunk size cannot work: activity is wildly uneven across AI's history.
 * This halves any chunk that breaches either limit and retries, which adapts
 * the scan granularity to local log density automatically.
 */
export async function getLogsRange(filter, from, to, opts = {}) {
  const chunk = opts.chunk || LIMITS.defaultChunk;
  const onProgress = opts.onProgress;
  const out = [];
  let cursor = from;
  let size = chunk;

  /* The growth policy matters more than it looks. Doubling after every success
     makes the scan fail on roughly every other iteration, and a failure is not
     cheap: the node scans the whole range before reporting that it exceeded the
     cap, so an eager retry loop spends most of its wall clock on queries that
     return nothing. Instead: remember the smallest size known to fail, stay well
     clear of it, and only grow after several consecutive successes. */
  let minBad = Infinity;
  let wins = 0;

  while (cursor <= to) {
    const end = Math.min(cursor + size - 1, to);
    try {
      const logs = await rpc("eth_getLogs", [{ ...filter, fromBlock: hexBlock(cursor), toBlock: hexBlock(end) }]);
      out.push(...logs);
      if (onProgress) onProgress(end, to, out.length);
      cursor = end + 1;
      wins++;
      if (wins >= 4 && size < chunk) {
        const grown = Math.floor(size * 1.4);
        if (grown < minBad * 0.7) { size = Math.min(chunk, grown); wins = 0; }
      }
    } catch (e) {
      if (!(e instanceof TooManyLogs) && !/timed out/i.test(e.message)) throw e;
      if (end === cursor) throw new Error(`single block ${cursor} exceeds the log cap`);
      minBad = Math.min(minBad, size);
      size = Math.max(1, Math.floor(size / 2));
      wins = 0;
    }
  }
  return out;
}

/** eth_getLogs where a topic position is an OR-list, split into server-safe groups. */
export async function getLogsByTopicSet(address, topic0, topic1Set, from, to, opts = {}) {
  /* Use the LARGEST OR-list the node accepts, not the smallest.
     This is counter-intuitive and I had it backwards: shrinking groups looks like
     it produces "lighter" queries, but the node scans the whole block range once
     per query no matter how many topics are OR'd together. Cost therefore tracks
     (groups x range), not (ids), so halving the group size doubles the total work.
     Measured: 150 ids over one range took 1344ms, 900 ids over the same range took
     1563ms -- a 6x bigger id set for 16% more time.
     The node rejects more than 1000 topics with "exceed max topics" (993 passes,
     1002 fails), so 960 leaves headroom. The 10,000-log cap is handled by
     subdividing the block RANGE in getLogsRange, which is the axis that actually
     costs something. */
  const groupSize = opts.groupSize ?? 960;
  const out = [];
  const ids = [...topic1Set];
  for (let i = 0; i < ids.length; i += groupSize) {
    const group = ids.slice(i, i + groupSize);
    const logs = await getLogsRange({ address, topics: [topic0, group] }, from, to, opts);
    out.push(...logs);
  }
  return out;
}
