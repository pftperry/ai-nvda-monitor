import fs from "node:fs";
import path from "node:path";
import { rpcBatch } from "./rpc.mjs";
import { TOKENS } from "./config.mjs";

const SEL = { symbol: "0x95d89b41", name: "0x06fdde03", decimals: "0x313ce567", totalSupply: "0x18160ddd" };

function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null;
  const b = hex.slice(2);
  try {
    // standard dynamic string: offset, length, bytes
    const len = parseInt(b.slice(64, 128), 16);
    if (Number.isFinite(len) && len > 0 && len <= 256) {
      const s = Buffer.from(b.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/\0+$/, "");
      if (s) return s;
    }
  } catch { /* fall through */ }
  // some tokens return a bytes32 symbol instead
  const s = Buffer.from(b.slice(0, 64), "hex").toString("utf8").replace(/\0+/g, "").trim();
  return s || null;
}

const known = new Map(Object.values(TOKENS).map((t) => [t.address.toLowerCase(), t]));

/* Symbol and decimals are immutable, so paying for them once is enough.
   Re-resolving every run meant hundreds of eth_calls for data that cannot have
   changed -- the largest avoidable cost in a repeat run, and it grows with every
   new pool the launchpad creates. */
const CACHE_FILE = path.join(path.resolve(import.meta.dirname, ".."), ".cache", "tokens.json");
let cache = null;
const loadCache = () => (cache ??= (() => {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
})());
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch { /* a cold cache is survivable; failing the run over it is not */ }
}

/** Resolve symbol/decimals for many tokens, hitting the chain only for new ones. */
export async function resolveTokens(addresses, opts = {}) {
  const log = opts.log || (() => {});
  const c = loadCache();
  const out = new Map();
  const todo = [];
  for (const a0 of addresses) {
    const a = a0.toLowerCase();
    if (out.has(a)) continue;
    // Curated entries win over the cache: the cache may hold a value learned
    // before a name was known (native ETH resolved to "0x000000" until the zero
    // address was added), and a stale cache must not outrank a corrected one.
    const k = known.get(a);
    if (k) { out.set(a, { address: a, symbol: k.symbol, decimals: k.decimals }); continue; }
    if (c[a]) { out.set(a, { address: a, ...c[a] }); continue; }
    todo.push(a);
  }
  if (todo.length) log(`  resolving ${todo.length} new token(s), ${out.size} from cache`);

  const BATCH = 30;
  for (let i = 0; i < todo.length; i += BATCH) {
    const group = todo.slice(i, i + BATCH);
    const calls = [];
    for (const a of group) {
      calls.push({ method: "eth_call", params: [{ to: a, data: SEL.symbol }, "latest"] });
      calls.push({ method: "eth_call", params: [{ to: a, data: SEL.decimals }, "latest"] });
    }
    const res = await rpcBatch(calls);
    group.forEach((a, k) => {
      const sym = decodeAbiString(res[k * 2]);
      const decHex = res[k * 2 + 1];
      let decimals = 18;
      if (decHex && decHex !== "0x") { const d = Number(BigInt(decHex)); if (d >= 0 && d <= 36) decimals = d; }
      const meta = { symbol: sym || a.slice(0, 8), decimals };
      out.set(a, { address: a, ...meta });
      c[a] = meta;
    });
    // Persist as we go: a long resolve that dies partway should not lose its work.
    saveCache();
    if (log !== undefined && todo.length > BATCH) {
      log(`    ${Math.min(i + BATCH, todo.length)}/${todo.length} tokens resolved`);
    }
  }
  return out;
}

/**
 * Check every curated token's decimals against the chain.
 *
 * Curated entries outrank both the cache and the on-chain lookup, which makes a
 * wrong constant invisible: USDG was hardcoded at 18 when it is 6, and the only
 * symptom was a price 10^12 too small in a corner of the UI. Four eth_calls per
 * run is a trivial price for making that class of error impossible.
 */
export async function assertTokenMetadata(log = console.log) {
  const bad = [];
  for (const t of Object.values(TOKENS)) {
    if (t.address === "0x0000000000000000000000000000000000000000") continue;  // native ETH has no contract
    const [res] = await rpcBatch([{ method: "eth_call", params: [{ to: t.address, data: SEL.decimals }, "latest"] }]);
    if (!res || res === "0x") { log(`  warn: ${t.symbol} decimals unreadable; keeping configured ${t.decimals}`); continue; }
    const onChain = Number(BigInt(res));
    if (onChain !== t.decimals) bad.push(`${t.symbol} configured ${t.decimals} but chain says ${onChain}`);
  }
  if (bad.length) throw new Error(`token metadata is wrong: ${bad.join("; ")}`);
  log(`  token metadata verified against chain (${Object.keys(TOKENS).length} entries)`);
}

/* blockTag defaults to the head. Pass a block number to read state as of that block,
   which needs an archive-capable endpoint; the public node answers "metadata is not
   found" for anything but the head. */
export async function erc20(address, what, blockTag = "latest") {
  const [r] = await rpcBatch([{ method: "eth_call", params: [{ to: address, data: SEL[what] }, blockTag] }]);
  return r && r !== "0x" ? BigInt(r) : 0n;
}

export async function balanceOf(token, holder, blockTag = "latest") {
  const data = "0x70a08231" + holder.slice(2).toLowerCase().padStart(64, "0");
  const [r] = await rpcBatch([{ method: "eth_call", params: [{ to: token, data }, blockTag] }]);
  return r && r !== "0x" ? BigInt(r) : 0n;
}

/**
 * Many reads in one request through Multicall3 (deployed at its canonical address
 * on Robinhood Chain, 3,808 bytes, checked 14 Sep 2026).
 *
 * The provider's limiter counts JSON-RPC sub-requests, so batching at the transport
 * bought nothing (see rpcBatch). Multicall batches INSIDE the EVM: one eth_call,
 * one unit of rate budget, up to a few hundred reads. Failed sub-calls come back
 * as null rather than failing the batch (allowFailure = true).
 */
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const W = (h) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const hex = (n) => n.toString(16);

export function encodeAggregate3(calls) {
  const tuples = calls.map((c) => {
    const d = c.data.replace(/^0x/, "");
    const padded = d.padEnd(Math.ceil(d.length / 64) * 64, "0");
    return W(c.to) + W("0") + W("60") + W(hex(d.length / 2)) + padded;   // target, allowFailure=false→ we pass true below
  }).map((t) => t.slice(0, 64) + W("1") + t.slice(128));                   // allowFailure = true
  let off = calls.length * 32;
  const heads = tuples.map((t) => { const h = W(hex(off)); off += t.length / 2; return h; });
  return "0x82ad56cb" + W("20") + W(hex(calls.length)) + heads.join("") + tuples.join("");
}

export function decodeAggregate3(ret, n) {
  const d = ret.replace(/^0x/, "");
  const word = (i) => d.slice(i * 64, i * 64 + 64);
  const base = Number(BigInt("0x" + word(0))) / 32;               // offset to the array, in words
  const len = Number(BigInt("0x" + word(base)));
  if (len !== n) throw new Error(`multicall returned ${len} results for ${n} calls`);
  const out = [];
  for (let k = 0; k < len; k++) {
    const tup = base + 1 + Number(BigInt("0x" + word(base + 1 + k))) / 32;
    const success = BigInt("0x" + word(tup)) === 1n;
    const bytesAt = tup + Number(BigInt("0x" + word(tup + 1))) / 32;
    const blen = Number(BigInt("0x" + word(bytesAt)));
    const bytes = d.slice((bytesAt + 1) * 64, (bytesAt + 1) * 64 + blen * 2);
    out.push(success && blen > 0 ? "0x" + bytes : null);
  }
  return out;
}

export async function multicall(calls, { chunk = 150, blockTag = "latest" } = {}) {
  const out = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const part = calls.slice(i, i + chunk);
    const [r] = await rpcBatch([{ method: "eth_call", params: [{ to: MULTICALL3, data: encodeAggregate3(part) }, blockTag] }]);
    if (!r || r === "0x") { out.push(...part.map(() => null)); continue; }
    out.push(...decodeAggregate3(r, part.length));
  }
  return out;
}
