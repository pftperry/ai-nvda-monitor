import { rpcBatch, rpc } from "./rpc.mjs";
import { GENESIS_BLOCK } from "./config.mjs";

/**
 * Block -> wall-clock time.
 *
 * Swap logs on this chain carry blockTimestamp = 0x0, so timestamps must be
 * fetched separately. Fetching one per event is out of the question (hundreds of
 * thousands of events), so we sample anchor blocks and interpolate between them.
 * Block production is steady at ~0.1022 s/block, which keeps interpolation error
 * far below the one-hour buckets we aggregate into.
 */
export class TimeMap {
  constructor(anchors = []) {
    this.anchors = anchors.slice().sort((a, b) => a[0] - b[0]);
  }

  static fromJSON(j) { return new TimeMap(j || []); }
  toJSON() { return this.anchors; }

  /** Sample anchors every `step` blocks across [from, to], reusing what we have. */
  async build(from, to, step = 250_000) {
    const have = new Set(this.anchors.map((a) => a[0]));
    const want = [];
    for (let b = from; b <= to; b += step) if (!have.has(b)) want.push(b);
    if (!have.has(to)) want.push(to);

    const BATCH = 20;
    for (let i = 0; i < want.length; i += BATCH) {
      const group = want.slice(i, i + BATCH);
      const res = await rpcBatch(
        group.map((b) => ({ method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] }))
      );
      res.forEach((r, k) => {
        if (r && r.timestamp) this.anchors.push([group[k], parseInt(r.timestamp, 16)]);
      });
    }
    this.anchors.sort((a, b) => a[0] - b[0]);
    return this;
  }

  /** Unix seconds for a block, linearly interpolated between surrounding anchors. */
  at(block) {
    const a = this.anchors;
    if (!a.length) return null;
    if (block <= a[0][0]) return a[0][1];
    if (block >= a[a.length - 1][0]) {
      // extrapolate past the last anchor using the trailing observed rate
      const n = a.length;
      if (n < 2) return a[0][1];
      const [b1, t1] = a[n - 2], [b2, t2] = a[n - 1];
      const rate = (t2 - t1) / Math.max(1, b2 - b1);
      return Math.round(t2 + (block - b2) * rate);
    }
    let lo = 0, hi = a.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid][0] <= block) lo = mid; else hi = mid;
    }
    const [b1, t1] = a[lo], [b2, t2] = a[hi];
    if (b2 === b1) return t1;
    return Math.round(t1 + ((block - b1) * (t2 - t1)) / (b2 - b1));
  }

  hourBucket(block) { const t = this.at(block); return t === null ? null : Math.floor(t / 3600) * 3600; }
  dayBucket(block)  { const t = this.at(block); return t === null ? null : Math.floor(t / 86400) * 86400; }

  /**
   * The block at a wall-clock time: at() run backwards.
   *
   * Needed so a scan can start on a DAY boundary. The routing series is kept per
   * day and rebuilt for every day a rescan touches, so a scan that starts mid-day
   * rebuilds that day from a fraction of it -- measured, a complete day read 0.0M
   * routed against 101M of flow because a fast run had rewritten it from its last
   * three hours. Anchors are 250k blocks apart and production is steady, so the
   * interpolated block lands within seconds of the boundary, far inside a day.
   */
  blockAt(t) {
    const a = this.anchors;
    if (!a.length || t == null) return null;
    if (t <= a[0][1]) return a[0][0];
    const n = a.length;
    if (t >= a[n - 1][1]) {
      if (n < 2) return a[0][0];
      const [b1, t1] = a[n - 2], [b2, t2] = a[n - 1];
      const rate = (t2 - t1) / Math.max(1, b2 - b1);
      return Math.round(b2 + (t - t2) / Math.max(1e-9, rate));
    }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid][1] <= t) lo = mid; else hi = mid;
    }
    const [b1, t1] = a[lo], [b2, t2] = a[hi];
    if (t2 === t1) return b1;
    return Math.round(b1 + ((t - t1) * (b2 - b1)) / (t2 - t1));
  }
}

/**
 * Anchors live in web/data, not only in the build cache.
 *
 * Measured on CI: rebuilding them costs 44s and 206 sequential calls — the second
 * largest stage of a refresh, for data that never changes once sampled. They were
 * held only in the Actions cache, which misses on a cold key, is evicted, and is
 * not written at all when a run is cancelled. So in practice they were rebuilt
 * almost every run. Storing them beside the other artifacts makes them durable
 * and effectively free; the file is tiny (~200 pairs).
 */
export async function loadTimeMap(store, latest, io) {
  const stored = io?.read?.("anchors.json")?.anchors || store.get("timemap") || [];
  const tm = TimeMap.fromJSON(stored);
  const before = tm.toJSON().length;
  await tm.build(GENESIS_BLOCK, latest);
  const after = tm.toJSON().length;
  store.set("timemap", tm.toJSON());
  if (io?.write) io.write("anchors.json", { updatedAt: Math.floor(Date.now() / 1000), anchors: tm.toJSON() });
  console.log(`  ${after} anchors (${before} reused, ${after - before} fetched)`);
  return tm;
}
