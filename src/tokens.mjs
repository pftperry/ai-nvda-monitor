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

export async function erc20(address, what) {
  const [r] = await rpcBatch([{ method: "eth_call", params: [{ to: address, data: SEL[what] }, "latest"] }]);
  return r && r !== "0x" ? BigInt(r) : 0n;
}

export async function balanceOf(token, holder) {
  const data = "0x70a08231" + holder.slice(2).toLowerCase().padStart(64, "0");
  const [r] = await rpcBatch([{ method: "eth_call", params: [{ to: token, data }, "latest"] }]);
  return r && r !== "0x" ? BigInt(r) : 0n;
}
