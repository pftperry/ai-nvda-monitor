import { AI, NVDA, USDG, TOKENS, PLATFORM_FEE_RECIPIENT, POOL_MANAGER, LONG_HOOK, FEE_SPLITTER, COMMUNITY_VAULT, BURN_ADDRESS, GENESIS_BLOCK } from "../config.mjs";
import { getLogsRange, padAddr, hexBlock, rpc } from "../rpc.mjs";
import { TOPICS, decodeTransfer, decodeSwap, decodeModifyLiquidity, fmtUnits } from "../decode.mjs";
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
 * A transfer to the pool manager is not one thing. It is a SALE if the same
 * transaction carries a Swap, and LIQUIDITY SEEDED if it carries a ModifyLiquidity
 * with a positive delta -- and the pool id in that event says for which pair. A
 * transfer from the pool manager is a buy or liquidity withdrawn on the same test.
 * So every pool-touching transaction of a tracked wallet is classified from the
 * pool manager's own logs for that block: one query per transaction, cached
 * forever in the resume state. That is what lets the page say whether the
 * protocol is dumping its fees, holding them, buying AI back, or seeding pools
 * for other launches -- the difference between an overhang and a flywheel.
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
const NAMES = {
  [POOL_MANAGER]: "v4 pool manager", [LONG_HOOK]: "LONG hook", [FEE_SPLITTER]: "fee splitter",
  [COMMUNITY_VAULT]: "community vault", [BURN_ADDRESS]: "0x0", [PLATFORM_FEE_RECIPIENT]: "platform fee wallet",
};
const HOPS = 4;          // how many of the fee wallet's destinations to follow
const TOP_TOKENS = 40;   // platform-wide fee tokens to name and price
const WEEK = 7 * 86400;

const emptyLedger = () => ({ in: 0, out: 0, bySource: {}, byDest: {}, transfersIn: 0, transfersOut: 0, poolTxs: [], otherOut: [] });

async function extend(ledger, token, wallet, from, to, deadline) {
  const inn = await getLogsRange({ address: token.address, topics: [TOPICS.TRANSFER, null, padAddr(wallet)] }, from, to, { chunk: 8_000_000, deadline });
  const out = await getLogsRange({ address: token.address, topics: [TOPICS.TRANSFER, padAddr(wallet)] }, from, to, { chunk: 8_000_000, deadline });
  for (const l of inn) {
    const x = decodeTransfer(l); const v = fmtUnits(x.value, token.dec);
    ledger.in += v; ledger.transfersIn++;
    ledger.bySource[x.from] = (ledger.bySource[x.from] || 0) + v;
    if (x.from === POOL_MANAGER) ledger.poolTxs.push({ tx: x.tx, block: x.block, dir: "in", v });
  }
  for (const l of out) {
    const x = decodeTransfer(l); const v = fmtUnits(x.value, token.dec);
    ledger.out += v; ledger.transfersOut++;
    ledger.byDest[x.to] = (ledger.byDest[x.to] || 0) + v;
    if (x.to === POOL_MANAGER) ledger.poolTxs.push({ tx: x.tx, block: x.block, dir: "out", v });
    else ledger.otherOut.push({ to: x.to, block: x.block, v });
  }
  const reached = Math.min(inn.reachedBlock ?? to, out.reachedBlock ?? to);
  return { reached, partial: !!(inn.truncated || out.truncated) };
}

/** What the pool manager did in a transaction: liquidity added, removed, or a swap; and in which pool. */
async function classifyTx(tx, block, cache) {
  if (cache[tx]) return cache[tx];
  const logs = await rpc("eth_getLogs", [{ address: POOL_MANAGER, fromBlock: hexBlock(block), toBlock: hexBlock(block), topics: [[TOPICS.SWAP, TOPICS.MODIFY_LIQUIDITY]] }]);
  let kind = "other", poolId = null, lpDelta = 0n;
  for (const l of logs) {
    if (l.transactionHash !== tx) continue;
    if (l.topics[0] === TOPICS.MODIFY_LIQUIDITY) {
      const m = decodeModifyLiquidity(l);
      lpDelta += m.liquidityDelta; poolId = poolId || m.poolId;
    } else if (l.topics[0] === TOPICS.SWAP && kind === "other") {
      kind = "swap"; poolId = poolId || decodeSwap(l).poolId;
    }
  }
  if (lpDelta > 0n) kind = "lp+"; else if (lpDelta < 0n) kind = "lp-";
  return (cache[tx] = { kind, poolId });
}

export async function indexTreasury(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store;
  const deadline = opts.budgetSeconds ? Date.now() + opts.budgetSeconds * 1000 : undefined;
  const state = (store && store.get("treasury")) || { cursor: GENESIS_BLOCK - 1, wallets: {}, fees: {}, feeCursor: GENESIS_BLOCK - 1, txKinds: {} };
  state.txKinds ||= {};
  const from = Math.max(GENESIS_BLOCK, state.cursor + 1);

  /* 1. The fee wallet's ledgers, then the wallets it forwards AI to. The hop list
     is derived from the ledger every run, so a new treasury address shows up on
     its own; a wallet once followed keeps its ledger. */
  const wallets = new Set([PLATFORM_FEE_RECIPIENT, ...Object.keys(state.wallets).filter((w) => w !== PLATFORM_FEE_RECIPIENT)]);
  let cursor = latest, partial = false;
  const walk = async (w) => {
    const W = (state.wallets[w] ||= {});
    for (const [sym, token] of Object.entries(TRACK)) {
      const L = (W[sym] ||= emptyLedger());
      L.poolTxs ||= []; L.otherOut ||= [];
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

  /* 2. Classify every pool-touching transaction of the tracked wallets. */
  let classified = 0;
  for (const w of wallets) for (const L of Object.values(state.wallets[w])) {
    for (const p of L.poolTxs) {
      if (state.txKinds[p.tx]) continue;
      if (deadline && Date.now() > deadline) { partial = true; break; }
      await classifyTx(p.tx, p.block, state.txKinds); classified++;
    }
  }
  if (classified) log(`  classified ${classified} pool transactions (swap / liquidity added / liquidity removed)`);

  /* 3. Every token the fee wallet has ever received: the platform's take across
     the whole launchpad. No address filter, so every ERC-20 on the chain that paid
     the wallet is in the sum. */
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

  /* 4. Balances now; names for pools and fee tokens; prices where they exist. */
  const tag = hexBlock(latest);
  const balances = {};
  for (const w of wallets) {
    balances[w] = {};
    for (const [sym, token] of Object.entries(TRACK)) {
      try { balances[w][sym] = fmtUnits(await balanceOf(token.address, w, tag), token.dec); } catch { balances[w][sym] = null; }
    }
  }
  const poolPairs = new Map();   // poolId -> [c0, c1]
  for (const p of store?.get("longCensus")?.pools || []) poolPairs.set(p.id, [p.c0, p.c1]);
  for (const p of store?.get("poolCatalogue")?.pools || []) poolPairs.set(p.poolId, [p.currency0, p.currency1]);
  const poolIds = new Set(Object.values(state.txKinds).map((k) => k.poolId).filter(Boolean));
  const tokAddrs = new Set();
  for (const id of poolIds) for (const c of poolPairs.get(id) || []) tokAddrs.add(c);
  const byCount = Object.entries(state.fees).sort((a, b) => b[1].transfers - a[1].transfers).slice(0, TOP_TOKENS);
  for (const [a] of byCount) tokAddrs.add(a);
  const meta = await resolveTokens([...tokAddrs], { log: () => {} });
  const sym = (a) => meta.get(a)?.symbol ?? a.slice(0, 8);
  const pairName = (id) => { const c = poolPairs.get(id); return c ? `${sym(c[0])} / ${sym(c[1])}` : (id ? id.slice(0, 10) : "?"); };
  const price = opts.priceOf || (() => null);

  /* 5. Uses per wallet per token, from the classified transactions. */
  const uses = (L, w) => {
    const u = { sold: 0, bought: 0, lpAdded: 0, lpRemoved: 0, sentOn: 0, internal: 0, pools: {} };
    for (const p of L.poolTxs) {
      const k = state.txKinds[p.tx]?.kind || "other";
      if (p.dir === "out") {
        if (k === "lp+") { u.lpAdded += p.v; const n = pairName(state.txKinds[p.tx].poolId); u.pools[n] = (u.pools[n] || 0) + p.v; }
        else u.sold += p.v;
      } else {
        if (k === "lp-") u.lpRemoved += p.v; else u.bought += p.v;
      }
    }
    for (const o of L.otherOut) {
      if (NAMES[o.to]) continue;
      if (wallets.has(o.to)) u.internal += o.v; else u.sentOn += o.v;
    }
    return u;
  };
  /* Weekly series of what the treasury wallets did with AI, for the chart. */
  const weekly = new Map();
  const bump = (block, key, v) => {
    const t = Math.floor((tm.at(block) || 0) / WEEK) * WEEK;
    if (!t) return;
    const r = weekly.get(t) || { t, sold: 0, bought: 0, lpAdded: 0, lpRemoved: 0, sentOn: 0 };
    r[key] += v; weekly.set(t, r);
  };
  for (const w of wallets) {
    if (w === PLATFORM_FEE_RECIPIENT) continue;
    const L = state.wallets[w]?.AI; if (!L) continue;
    for (const p of L.poolTxs) {
      const k = state.txKinds[p.tx]?.kind || "other";
      bump(p.block, p.dir === "out" ? (k === "lp+" ? "lpAdded" : "sold") : (k === "lp-" ? "lpRemoved" : "bought"), p.v);
    }
    for (const o of L.otherOut) if (!NAMES[o.to] && !wallets.has(o.to)) bump(o.block, "sentOn", o.v);
  }

  const feeTokens = byCount.map(([a, f]) => {
    const dec = meta.get(a)?.decimals ?? 18;
    const amount = Number(BigInt(f.raw) / 10n ** BigInt(Math.max(0, dec - 6))) / 1e6;
    const p = price(a);
    return { token: a, symbol: sym(a), decimals: dec, transfers: f.transfers, amount: +amount.toPrecision(8), priceUsd: p, usd: p ? +(amount * p).toFixed(2) : null };
  }).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

  if (store) store.set("treasury", { ...state, cursor, feeCursor });

  const view = (w) => {
    const W = state.wallets[w] || {};
    const top = (m, n = 5) => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([a, v]) => ({ address: a, name: NAMES[a] || (wallets.has(a) ? "treasury wallet" : null), v: +v.toFixed(4) }));
    return {
      address: w, name: NAMES[w] || "treasury wallet",
      ledgers: Object.fromEntries(Object.entries(W).map(([s, L]) => {
        const u = uses(L, w);
        return [s, {
          in: +L.in.toFixed(4), out: +L.out.toFixed(4), balance: balances[w]?.[s] ?? null,
          transfersIn: L.transfersIn, transfersOut: L.transfersOut,
          topSources: top(L.bySource), topDests: top(L.byDest),
          uses: { sold: +u.sold.toFixed(4), bought: +u.bought.toFixed(4), lpAdded: +u.lpAdded.toFixed(4), lpRemoved: +u.lpRemoved.toFixed(4), sentOn: +u.sentOn.toFixed(4), internal: +u.internal.toFixed(4),
            pools: Object.fromEntries(Object.entries(u.pools).map(([k, v]) => [k, +v.toFixed(4)])) },
        }];
      })),
    };
  };
  return {
    updatedAt: Math.floor(Date.now() / 1000),
    cursor, partial, feeCursor,
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
