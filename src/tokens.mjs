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

/** Resolve symbol/decimals for many tokens using batched eth_call. */
export async function resolveTokens(addresses) {
  const out = new Map();
  const todo = [];
  for (const a0 of addresses) {
    const a = a0.toLowerCase();
    if (out.has(a)) continue;
    const k = known.get(a);
    if (k) out.set(a, { address: a, symbol: k.symbol, decimals: k.decimals });
    else todo.push(a);
  }
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
      out.set(a, { address: a, symbol: sym || a.slice(0, 8), decimals });
    });
  }
  return out;
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
