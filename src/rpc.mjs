import { RPCS, LIMITS } from "./config.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let callCount = 0;
export const rpcCalls = () => callCount;

let rpcIdx = 0;
const endpoint = () => RPCS[rpcIdx % RPCS.length];

class TooManyLogs extends Error {}
export { TooManyLogs };

/* Pacing is PER METHOD, because the limiter plainly is.
   Measured on a quiet connection: eth_call and eth_blockNumber sustain ~17/s with
   no throttling at all, while eth_getLogs allows only one or two before returning
   Too Many Requests, and stays degraded for a long while after heavy use. Pacing
   them together means either crawling through cheap calls or hammering expensive
   ones; neither is right. Log scans therefore carry their own, much slower floor
   and their own budget, and cheap calls are not punished for their cost. */
const isExpensive = (method) => method === "eth_getLogs";
let paceMs = LIMITS.politeDelayMs;
let logsPaceMs = LIMITS.logsDelayMs;
const PACE_MAX = 2000;
const LOGS_PACE_MAX = 8000;
const slowDown = (method) => {
  if (isExpensive(method)) logsPaceMs = Math.min(LOGS_PACE_MAX, Math.max(500, Math.round(logsPaceMs * 1.5)));
  else paceMs = Math.min(PACE_MAX, Math.max(200, Math.round(paceMs * 1.4)));
};
// Recover promptly: at 0.97 per success a spiked pace needed a hundred clean calls
// to return to normal, so one stumble taxed the rest of the run.
const speedUp = (method) => {
  if (isExpensive(method)) logsPaceMs = Math.max(LIMITS.logsDelayMs, Math.round(logsPaceMs * 0.85));
  else paceMs = Math.max(LIMITS.politeDelayMs, Math.round(paceMs * 0.8));
};
export const pace = () => ({ calls: paceMs, logs: logsPaceMs });

const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);

/* Backoff has to be bounded, and shared.
   Heavy scans push this endpoint into a short penalty window where it answers
   everything with 429 for a while. Per-call exponential backoff is exactly the
   wrong response: with 12 tries escalating to 30s, ONE call could burn 211
   seconds, and a few hundred queued calls then never finish. Worse, each call
   rediscovers the penalty independently.
   Instead the penalty is treated as a process-wide condition: after a few
   consecutive rate-limited responses the client pauses once, long enough for the
   window to drain, and everyone benefits. Per-call backoff stays short. */
const BACKOFF_BASE_MS = 400;
const BACKOFF_MAX_MS = 5_000;
const COOLDOWN_MS = 15_000;
const COOLDOWN_AFTER = 3;
let consecutiveLimited = 0;
let cooldownUntil = 0;

const backoff = (attempt) => jitter(Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt));

async function noteRateLimited(method) {
  slowDown(method);
  consecutiveLimited++;
  if (consecutiveLimited >= COOLDOWN_AFTER && Date.now() > cooldownUntil) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    console.warn(`  endpoint is rate limiting; pausing ${COOLDOWN_MS / 1000}s to let the window drain`);
    await sleep(COOLDOWN_MS);
    consecutiveLimited = 0;
  }
}
const noteOk = (method) => { consecutiveLimited = 0; speedUp(method); };

/**
 * Single JSON-RPC call. Retries transient failures with capped exponential
 * backoff. Throws TooManyLogs immediately so callers can subdivide rather than
 * wait out a condition that will never resolve on its own.
 */
export async function rpc(method, params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    // Respect a cooldown another call may have started.
    if (cooldownUntil > Date.now()) await sleep(cooldownUntil - Date.now());
    callCount++;
    let j;
    try {
      /* A timeout is not optional. fetch() waits forever by default, so one stalled
         socket silently hangs the entire indexer -- observed as a process pinned at
         6.8 CPU-seconds and flat memory for fifteen minutes, which looks identical
         to slow progress until you watch the counters. Retrying a hung request
         costs one request; not retrying costs the run. */
      const res = await fetch(endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: callCount, method, params }),
        signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
      });
      if (res.status === 429 || res.status === 503 || res.status === 502) {
        last = new Error(`HTTP ${res.status}`);
        await noteRateLimited(method);
        const ra = Number(res.headers.get("retry-after"));
        await sleep(ra > 0 ? Math.min(30_000, ra * 1000) : backoff(i));
        continue;
      }
      const text = await res.text();
      try { j = JSON.parse(text); }
      catch {
        // an HTML error page or a truncated body: transient, worth retrying
        last = new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
        slowDown(method);
        await sleep(backoff(i));
        continue;
      }
    } catch (e) {
      last = e; rpcIdx++; slowDown(method);
      await sleep(backoff(i));
      continue;
    }
    if (j.error) {
      const msg = j.error.message || "";
      if (/exceeds limit/i.test(msg)) throw new TooManyLogs(msg);
      if (/timed out|too many|rate|capacity|busy/i.test(msg) || String(j.error.code) === "429") {
        last = new Error(msg);
        await noteRateLimited(method);
        await sleep(backoff(i));
        continue;
      }
      throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    }
    noteOk(method);
    const wait = isExpensive(method) ? logsPaceMs : paceMs;
    if (wait) await sleep(wait);
    return j.result;
  }
  // Surfacing the underlying cause matters: "retries exhausted" alone is unactionable.
  throw new Error(`${method}: gave up after ${tries} attempts — last error: ${last ? last.message : "unknown"}`);
}

/**
 * Run many calls, one at a time. Despite the name this deliberately does NOT send
 * a JSON-RPC batch.
 *
 * The rate limiter here counts each SUB-REQUEST, not each HTTP request. A 60-call
 * batch therefore spends sixty requests of budget in a single shot: the batch
 * itself comes back 429, and -- the expensive part -- every ordinary call that
 * follows is throttled until the window drains. That one behaviour explains what
 * looked for hours like an unreliable endpoint. Measured: 39 individual eth_calls
 * finish in 2.3s (17/s), while the identical work attempted as batches stalls for
 * minutes behind repeated cooldowns.
 *
 * Batching buys nothing against a limiter that counts this way, so we don't. The
 * name stays because callers only ever wanted "resolve these N things"; how that
 * is transported is this module's business.
 */
export async function rpcBatch(calls) {
  if (!calls.length) return [];
  const out = [];
  for (const c of calls) {
    try { out.push(await rpc(c.method, c.params)); } catch { out.push(null); }
  }
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
      for (const l of logs) out.push(l);   // not push(...logs): spreading 10k args risks the stack
      if (onProgress) onProgress(end, to, out.length);
      cursor = end + 1;
      wins++;
      /* Grow on a success streak, and let the failure memory DECAY as we advance.
         Log density here is wildly uneven -- AI's early history is nearly empty
         while recent blocks are dense -- so a size that breached the cap in a busy
         region says nothing about a quiet one. Treating minBad as a permanent
         ceiling pins the scan to tiny chunks for the remaining tens of millions of
         sparse blocks, which is what made a 51-chunk scan take hundreds of queries.
         An occasional re-probe costs one wasted scan and buys back far more. */
      if (wins >= 3 && size < chunk) {
        size = Math.min(chunk, Math.floor(size * 1.6));
        minBad = minBad === Infinity ? Infinity : Math.floor(minBad * 1.5);
        wins = 0;
      }
    } catch (e) {
      if (!(e instanceof TooManyLogs) && !/timed out/i.test(e.message)) throw e;
      if (end === cursor) throw new Error(`single block ${cursor} exceeds the log cap`);
      minBad = Math.min(minBad, size);
      size = Math.max(1, Math.floor(size / 2));
      wins = 0;
      /* A server-side timeout is different from a log-cap breach: the node did real
         work and gave up, and it answers the next few requests with 429 regardless
         of how patient the client is. Pausing briefly lets that clear instead of
         spending retries into a penalty window. */
      if (/timed out/i.test(e.message)) await sleep(2000);
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
    for (const l of logs) out.push(l);
  }
  return out;
}
