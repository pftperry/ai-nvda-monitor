import { RPCS, LIMITS } from "./config.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let callCount = 0;
export const rpcCalls = () => callCount;

let rpcIdx = 0;
const endpoint = () => RPCS[rpcIdx % RPCS.length];

class TooManyLogs extends Error {}
export { TooManyLogs };

/**
 * Single JSON-RPC call. Retries transient failures with backoff.
 * Throws TooManyLogs immediately so callers can subdivide instead of waiting.
 */
export async function rpc(method, params, tries = 8) {
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
      if (res.status === 429) { await sleep(1500 * (i + 1)); continue; }
      j = await res.json();
    } catch (e) {
      last = e; rpcIdx++; await sleep(800 * (i + 1)); continue;
    }
    if (j.error) {
      const msg = j.error.message || "";
      if (/exceeds limit/i.test(msg)) throw new TooManyLogs(msg);
      if (/timed out|too many|rate|capacity/i.test(msg) || String(j.error.code) === "429") {
        last = new Error(msg); await sleep(1200 * (i + 1)); continue;
      }
      throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    }
    if (LIMITS.politeDelayMs) await sleep(LIMITS.politeDelayMs);
    return j.result;
  }
  throw last || new Error(`${method}: retries exhausted`);
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
      if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      const j = await res.json();
      if (!Array.isArray(j)) break;
      const out = new Array(calls.length);
      let retryable = false;
      for (const r of j) {
        if (r.error && /timed out|too many|rate/i.test(r.error.message || "")) retryable = true;
        out[r.id] = r.error ? null : r.result;
      }
      if (retryable) { await sleep(1200 * (attempt + 1)); continue; }
      await sleep(LIMITS.politeDelayMs);
      return out;
    } catch { await sleep(800 * (attempt + 1)); }
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
  while (cursor <= to) {
    const end = Math.min(cursor + size - 1, to);
    try {
      const logs = await rpc("eth_getLogs", [{ ...filter, fromBlock: hexBlock(cursor), toBlock: hexBlock(end) }]);
      out.push(...logs);
      if (onProgress) onProgress(end, to, out.length);
      cursor = end + 1;
      // creep back up after a successful large read
      if (size < chunk) size = Math.min(chunk, size * 2);
    } catch (e) {
      if (!(e instanceof TooManyLogs) && !/timed out/i.test(e.message)) throw e;
      if (end === cursor) {
        // a single block exceeds the cap: unsplittable, take what we can
        throw new Error(`single block ${cursor} exceeds log cap`);
      }
      size = Math.max(1, Math.floor(size / 2));
    }
  }
  return out;
}

/** eth_getLogs where a topic position is an OR-list, split into server-safe groups. */
export async function getLogsByTopicSet(address, topic0, topic1Set, from, to, opts = {}) {
  const groupSize = opts.groupSize || 400;
  const out = [];
  const ids = [...topic1Set];
  for (let i = 0; i < ids.length; i += groupSize) {
    const group = ids.slice(i, i + groupSize);
    const logs = await getLogsRange({ address, topics: [topic0, group] }, from, to, opts);
    out.push(...logs);
  }
  return out;
}
