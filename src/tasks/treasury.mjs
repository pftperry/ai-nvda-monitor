import { AI, NVDA, USDG, TOKENS, PLATFORM_FEE_RECIPIENT, POOL_MANAGER, LONG_HOOK, FEE_SPLITTER, COMMUNITY_VAULT, BURN_ADDRESS, GENESIS_BLOCK } from "../config.mjs";
import { getLogsRange, padAddr, hexBlock, rpc } from "../rpc.mjs";
import { TOPICS, decodeTransfer, decodeModifyLiquidity, fmtUnits } from "../decode.mjs";
import { balanceOf, resolveTokens } from "../tokens.mjs";

/**
 * Where the money goes, and what is done with it.
 *
 * The first hop was already measured: the splitter's platform leg. Following it
 * found that the platform fee wallet is a pipe -- 947 transfers in, 662 out,
 * balance zero -- forwarding everything, mostly to one address. So this task keeps
 * ledgers for the fee wallet AND for the wallets it forwards to (found from the
 * data, not typed in) in AI, NVDA, USDG and WETH.
 *
 * What a wallet DID in a transaction is read by netting every Transfer in that
 * transaction for the wallet, across all tokens, plus the pool manager's
 * ModifyLiquidity events:
 *   - sent one token and received another  -> a swap (a sale of what it sent);
 *   - sent tokens alongside a positive ModifyLiquidity -> liquidity seeded, and
 *     the pool id says for which pair; negative -> liquidity withdrawn;
 *   - sent and received nothing back        -> moved;
 *   - received only                          -> received.
 * The router in the middle does not matter. The first version classified only
 * transfers that touched the pool manager directly, and so read 13.27M AI sold
 * through Robinhood Wallet's 0x Settler and 850 NVDA sold through Rainbow's
 * router as "moved elsewhere". One block of logs per transaction, cached forever.
 *
 * It also totals every transfer INTO the fee wallet across every token on the
 * chain, so the platform's take is stated across the whole launchpad.
 *
 * Slow path only; every ledger resumes from a cursor.
 */
const TRACK = {
  AI:   { address: AI,   dec: 18 },
  NVDA: { address: NVDA, dec: 18 },
  USDG: { address: USDG, dec: 6 },
  WETH: { address: TOKENS.WETH.address, dec: 18 },
};
/* Machinery, and the routers and bridges the treasury has been seen to use.
   Each was identified on the chain's Blockscout by verified contract name. */
export const NAMES = {
  [POOL_MANAGER]: "v4 pool manager", [LONG_HOOK]: "LONG hook", [FEE_SPLITTER]: "fee splitter",
  [COMMUNITY_VAULT]: "community vault", [BURN_ADDRESS]: "0x0", [PLATFORM_FEE_RECIPIENT]: "platform fee wallet",
  "0xe72688f7d25d7318b9a81f21edda640ca948c83b": "RobinHoodSettler (Robinhood Wallet swaps, 0x Settler)",
  "0x00000000009726632680fb29d3f7a9734e3010e2": "Rainbow router",
  "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f": "Relay router",
  "0x4cd00e387622c35bddb9b4c962c136462338bc31": "Relay depository (bridge out of the chain)",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
};
const BRIDGES = new Set(["0x4cd00e387622c35bddb9b4c962c136462338bc31"]);
const MACHINERY = new Set([POOL_MANAGER, LONG_HOOK, FEE_SPLITTER, COMMUNITY_VAULT, BURN_ADDRESS]);
const HOPS = 4;          // how many of the fee wallet's destinations to follow
const TOP_TOKENS = 40;   // platform-wide fee tokens to name and price
const WEEK = 7 * 86400;
const CLASS_VERSION = 2; // bump when the classification rule changes; cached kinds are discarded

const emptyLedger = () => ({ in: 0, out: 0, bySource: {}, byDest: {}, transfersIn: 0, transfersOut: 0, txs: [] });

async function extend(ledger, token, wallet, from, to, deadline) {
  const inn = await getLogsRange({ address: token.address, topics: [TOPICS.TRANSFER, null, padAddr(wallet)] }, from, to, { chunk: 8_000_000, deadline });
  const out = await getLogsRange({ address: token.address, topics: [TOPICS.TRANSFER, padAddr(wallet)] }, from, to, { chunk: 8_000_000, deadline });
  for (const l of inn) {
    const x = decodeTransfer(l); const v = fmtUnits(x.value, token.dec);
    ledger.in += v; ledger.transfersIn++;
    ledger.bySource[x.from] = (ledger.bySource[x.from] || 0) + v;
    ledger.txs.push({ tx: x.tx, block: x.block, dir: "in", v, cp: x.from });
  }
  for (const l of out) {
    const x = decodeTransfer(l); const v = fmtUnits(x.value, token.dec);
    ledger.out += v; ledger.transfersOut++;
    ledger.byDest[x.to] = (ledger.byDest[x.to] || 0) + v;
    ledger.txs.push({ tx: x.tx, block: x.block, dir: "out", v, cp: x.to });
  }
  const reached = Math.min(inn.reachedBlock ?? to, out.reachedBlock ?? to);
  return { reached, partial: !!(inn.truncated || out.truncated) };
}

/**
 * What `wallet` did in `tx`: its net position per token across every Transfer in
 * the transaction, and any liquidity change on the pool manager.
 */
async function classifyTx(tx, block, wallet, cache) {
  const key = `${tx}:${wallet}`;
  if (cache[key]) return cache[key];
  const [transfers, pm] = await Promise.all([
    rpc("eth_getLogs", [{ fromBlock: hexBlock(block), toBlock: hexBlock(block), topics: [TOPICS.TRANSFER] }]),
    rpc("eth_getLogs", [{ address: POOL_MANAGER, fromBlock: hexBlock(block), toBlock: hexBlock(block), topics: [[TOPICS.SWAP, TOPICS.MODIFY_LIQUIDITY]] }]),
  ]);
  const net = {};        // token -> bigint string
  const cps = new Set();  // direct counterparties of the wallet
  for (const l of transfers) {
    if (l.transactionHash !== tx || l.topics.length < 3) continue;
    const t = decodeTransfer(l);
    const tok = l.address.toLowerCase();
    if (t.from === wallet) { net[tok] = ((BigInt(net[tok] || "0")) - t.value).toString(); cps.add(t.to); }
    if (t.to === wallet) { net[tok] = ((BigInt(net[tok] || "0")) + t.value).toString(); cps.add(t.from); }
  }
  let lpDelta = 0n, poolId = null, swapped = false;
  for (const l of pm) {
    if (l.transactionHash !== tx) continue;
    if (l.topics[0] === TOPICS.MODIFY_LIQUIDITY) { const m = decodeModifyLiquidity(l); lpDelta += m.liquidityDelta; poolId = poolId || m.poolId; }
    else swapped = true;
  }
  const sent = Object.entries(net).filter(([, v]) => BigInt(v) < 0n).map(([t]) => t);
  const recv = Object.entries(net).filter(([, v]) => BigInt(v) > 0n).map(([t]) => t);
  let kind;
  if (lpDelta > 0n && sent.length) kind = "lp+";
  else if (lpDelta < 0n && recv.length) kind = "lp-";
  else if (sent.length && recv.length) kind = "swap";
  else if (sent.length) kind = "out";
  else if (recv.length) kind = "in";
  else kind = "none";
  const via = [...cps].find((c) => NAMES[c] && !MACHINERY.has(c)) || null;   // a named router or bridge, if one was the counterparty
  const bridged = [...cps].some((c) => BRIDGES.has(c));
  return (cache[key] = { kind, poolId, net, via, bridged, swapped });
}

export async function indexTreasury(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store;
  const deadline = opts.budgetSeconds ? Date.now() + opts.budgetSeconds * 1000 : undefined;
  let state = (store && store.get("treasury")) || null;
  if (!state || state.classVersion !== CLASS_VERSION) {
    // A changed rule means every cached kind is suspect; the ledgers themselves are fine.
    state = { ...(state || {}), cursor: GENESIS_BLOCK - 1, wallets: {}, fees: state?.fees || {}, feeCursor: state?.feeCursor ?? GENESIS_BLOCK - 1, txKinds: {}, classVersion: CLASS_VERSION };
  }
  const from = Math.max(GENESIS_BLOCK, state.cursor + 1);

  /* 1. The fee wallet's ledgers, then the wallets it forwards AI to. */
  const wallets = new Set([PLATFORM_FEE_RECIPIENT, ...Object.keys(state.wallets).filter((w) => w !== PLATFORM_FEE_RECIPIENT)]);
  let cursor = latest, partial = false;
  const walk = async (w) => {
    const W = (state.wallets[w] ||= {});
    for (const [sym, token] of Object.entries(TRACK)) {
      const L = (W[sym] ||= emptyLedger());
      const r = await extend(L, token, w, from, latest, deadline);
      cursor = Math.min(cursor, r.reached); if (r.partial) partial = true;
    }
  };
  await walk(PLATFORM_FEE_RECIPIENT);
  const feeAI = state.wallets[PLATFORM_FEE_RECIPIENT].AI;
  const hops = Object.entries(feeAI.byDest).filter(([a]) => !NAMES[a]).sort((a, b) => b[1] - a[1]).slice(0, HOPS).map(([a]) => a);
  for (const h of hops) wallets.add(h);
  for (const w of wallets) if (w !== PLATFORM_FEE_RECIPIENT) await walk(w);
  log(`  fee wallet forwards AI to ${hops.length} address(es); ledgers for ${wallets.size} wallets to block ${cursor.toLocaleString()}`);

  /* 2. Classify every transaction of the treasury wallets (not the fee wallet's
     own, which are forwards by construction), skipping ones whose counterparty is
     machinery: a fee arrival from the splitter needs no receipt. */
  let classified = 0, pending = 0;
  for (const w of wallets) {
    if (w === PLATFORM_FEE_RECIPIENT) continue;
    for (const L of Object.values(state.wallets[w])) {
      for (const p of L.txs) {
        if (MACHINERY.has(p.cp) && p.cp !== POOL_MANAGER) continue;
        if (state.txKinds[`${p.tx}:${w}`]) continue;
        if (deadline && Date.now() > deadline) { pending++; partial = true; continue; }
        await classifyTx(p.tx, p.block, w, state.txKinds); classified++;
      }
    }
  }
  log(`  classified ${classified} treasury transactions${pending ? `; ${pending} deferred to the next run` : ""}`);

  /* 3. Every token the fee wallet has ever received. */
  const feeFrom = Math.max(GENESIS_BLOCK, state.feeCursor + 1);
  const all = await getLogsRange({ topics: [TOPICS.TRANSFER, null, padAddr(PLATFORM_FEE_RECIPIENT)] }, feeFrom, latest, { chunk: 2_000_000, deadline });
  for (const l of all) {
    const tok = l.address.toLowerCase();
    const x = decodeTransfer(l);
    const f = (state.fees[tok] ||= { transfers: 0, raw: "0" });
    f.transfers++;
    f.raw = (BigInt(f.raw) + x.value).toString();
  }
  const feeCursor = all.truncated ? (all.reachedBlock ?? feeFrom - 1) : latest;
  log(`  platform-wide: ${Object.keys(state.fees).length} tokens have paid the fee wallet; +${all.length} transfers this run`);

  /* 4. Balances now; names and prices. */
  const tag = hexBlock(latest);
  const balances = {};
  for (const w of wallets) {
    balances[w] = {};
    for (const [sym, token] of Object.entries(TRACK)) {
      try { balances[w][sym] = fmtUnits(await balanceOf(token.address, w, tag), token.dec); } catch { balances[w][sym] = null; }
    }
  }
  const poolPairs = new Map();
  for (const p of store?.get("longCensus")?.pools || []) poolPairs.set(p.id, [p.c0, p.c1]);
  for (const p of store?.get("poolCatalogue")?.pools || []) poolPairs.set(p.poolId, [p.currency0, p.currency1]);
  const tokAddrs = new Set();
  for (const k of Object.values(state.txKinds)) { for (const c of poolPairs.get(k.poolId) || []) tokAddrs.add(c); for (const t of Object.keys(k.net || {})) tokAddrs.add(t); }
  const byCount = Object.entries(state.fees).sort((a, b) => b[1].transfers - a[1].transfers).slice(0, TOP_TOKENS);
  for (const [a] of byCount) tokAddrs.add(a);
  const meta = await resolveTokens([...tokAddrs], { log: () => {} });
  const sym = (a) => meta.get(a)?.symbol ?? a.slice(0, 8);
  const decOf = (a) => meta.get(a)?.decimals ?? 18;
  const pairName = (id) => { const c = poolPairs.get(id); return c ? `${sym(c[0])} / ${sym(c[1])}` : (id ? id.slice(0, 10) : "?"); };
  const price = opts.priceOf || (() => null);
  const byAddr = Object.fromEntries(Object.entries(TRACK).map(([s, t]) => [t.address.toLowerCase(), s]));

  /* 5. Uses per wallet per token from the classified transactions. Each
     transaction is counted once per wallet; the token's own net in that
     transaction decides which bucket it lands in. */
  const uses = (w) => {
    const u = {}; for (const s of Object.keys(TRACK)) u[s] = { sold: 0, bought: 0, lpAdded: 0, lpRemoved: 0, sentOn: 0, internal: 0, bridged: 0, received: 0, pools: {}, via: {} };
    const seen = new Set();
    for (const L of Object.values(state.wallets[w])) for (const p of L.txs) {
      if (seen.has(p.tx)) continue; seen.add(p.tx);
      const k = state.txKinds[`${p.tx}:${w}`];
      if (!k) continue;
      for (const [tok, raw] of Object.entries(k.net || {})) {
        const s = byAddr[tok]; if (!s) continue;
        const v = fmtUnits(BigInt(raw) < 0n ? -BigInt(raw) : BigInt(raw), TRACK[s].dec);
        const outFlow = BigInt(raw) < 0n;
        if (k.kind === "lp+" && outFlow) { u[s].lpAdded += v; const n = pairName(k.poolId); u[s].pools[n] = (u[s].pools[n] || 0) + v; }
        else if (k.kind === "lp-" && !outFlow) u[s].lpRemoved += v;
        else if (k.kind === "swap") { if (outFlow) { u[s].sold += v; const vn = k.via ? NAMES[k.via] : (k.swapped ? "v4 pools directly" : "unnamed counterparty"); u[s].via[vn] = (u[s].via[vn] || 0) + v; } else u[s].bought += v; }
        else if (k.kind === "out") { if (k.bridged) u[s].bridged += v; else if (wallets.has(p.cp)) u[s].internal += v; else u[s].sentOn += v; }
        else if (k.kind === "in") u[s].received += v;
      }
    }
    return u;
  };
  const weekly = new Map();
  for (const w of wallets) {
    if (w === PLATFORM_FEE_RECIPIENT) continue;
    const seen = new Set();
    for (const L of Object.values(state.wallets[w])) for (const p of L.txs) {
      if (seen.has(p.tx)) continue; seen.add(p.tx);
      const k = state.txKinds[`${p.tx}:${w}`]; if (!k) continue;
      const raw = k.net?.[AI.toLowerCase()]; if (!raw) continue;
      const v = fmtUnits(BigInt(raw) < 0n ? -BigInt(raw) : BigInt(raw), 18), outFlow = BigInt(raw) < 0n;
      const key = k.kind === "lp+" && outFlow ? "lpAdded" : k.kind === "lp-" && !outFlow ? "lpRemoved" : k.kind === "swap" ? (outFlow ? "sold" : "bought") : k.kind === "out" ? (k.bridged ? "bridged" : wallets.has(p.cp) ? null : "sentOn") : null;
      if (!key) continue;
      const t = Math.floor((tm.at(p.block) || 0) / WEEK) * WEEK; if (!t) continue;
      const r = weekly.get(t) || { t, sold: 0, bought: 0, lpAdded: 0, lpRemoved: 0, sentOn: 0, bridged: 0 };
      r[key] += v; weekly.set(t, r);
    }
  }

  const feeTokens = byCount.map(([a, f]) => {
    const dec = decOf(a);
    const amount = Number(BigInt(f.raw) / 10n ** BigInt(Math.max(0, dec - 6))) / 1e6;
    const p = price(a);
    return { token: a, symbol: sym(a), decimals: dec, transfers: f.transfers, amount: +amount.toPrecision(8), priceUsd: p, usd: p ? +(amount * p).toFixed(2) : null };
  }).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

  if (store) store.set("treasury", { ...state, cursor, feeCursor });

  const r4 = (x) => +Number(x).toFixed(4);
  const view = (w) => {
    const W = state.wallets[w] || {};
    const U = w === PLATFORM_FEE_RECIPIENT ? null : uses(w);
    const top = (m, n = 6) => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([a, v]) => ({ address: a, name: NAMES[a] || (wallets.has(a) ? "treasury wallet" : null), v: r4(v) }));
    return {
      address: w, name: NAMES[w] || "treasury wallet",
      ledgers: Object.fromEntries(Object.entries(W).map(([s, L]) => [s, {
        in: r4(L.in), out: r4(L.out), balance: balances[w]?.[s] ?? null,
        transfersIn: L.transfersIn, transfersOut: L.transfersOut,
        topSources: top(L.bySource), topDests: top(L.byDest),
        uses: U ? { ...Object.fromEntries(Object.entries(U[s]).map(([k, v]) => [k, typeof v === "number" ? r4(v) : Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, r4(vv)]))])) } : undefined,
      }])),
    };
  };
  return {
    updatedAt: Math.floor(Date.now() / 1000),
    cursor, partial, feeCursor, classVersion: CLASS_VERSION, unclassified: pending,
    names: NAMES,
    feeWallet: view(PLATFORM_FEE_RECIPIENT),
    treasuryWallets: [...wallets].filter((w) => w !== PLATFORM_FEE_RECIPIENT).map(view),
    weeklyAi: [...weekly.values()].sort((a, b) => a.t - b.t).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === "t" ? v : +v.toFixed(2)]))),
    platformFees: {
      tokens: feeTokens,
      tokenCount: Object.keys(state.fees).length,
      pricedUsd: +feeTokens.reduce((s, t) => s + (t.usd || 0), 0).toFixed(2),
      unpriced: feeTokens.filter((t) => t.usd == null).length,
      note: "sum of every transfer into the platform fee wallet, valued at CURRENT prices where a price exists; historic value at receipt is not computed",
    },
  };
}
