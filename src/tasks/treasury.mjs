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
  // Named by LONG's own Dune methodology as the protocol's ~1% buyback leg on launched-token swaps.
  "0x6f02324d20cc679d0e585290caa6b16bacbc0f77": "LONG buyback contract",
  "0xe72688f7d25d7318b9a81f21edda640ca948c83b": "RobinHoodSettler (Robinhood Wallet swaps, 0x Settler)",
  "0x1d4b86491ec211257cbedd77a4380a7494624eff": "RobinHoodSettler (Robinhood Wallet swaps, 0x Settler)",
  "0x00000000009726632680fb29d3f7a9734e3010e2": "Rainbow router",
  "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f": "Relay router",
  "0x4cd00e387622c35bddb9b4c962c136462338bc31": "Relay depository (bridge out of the chain)",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d": "Uniswap v3 pool",
  "0xd78480cafef722d75519e13b9f516e5704d0d659": "Uniswap v3 pool",
  "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca": "Uniswap v3 pool",
  "0x3bf2a8c1443446c11bf8bbdbbd27eda5941c2f8a": "Algebra pool",
};
/* Uniswap v3 and Algebra pools hold their own liquidity and emit their own events,
   unlike v4's singleton. The treasury has used both, so a transaction is also read
   for these signatures on any address. */
const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V3_MINT = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
const V3_BURN = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";
const ALGEBRA_SWAP = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
const ALGEBRA_MINT = V3_MINT;   // Algebra keeps Uniswap's Mint/Burn signatures
const BRIDGES = new Set(["0x4cd00e387622c35bddb9b4c962c136462338bc31"]);
/* Off-chain destinations identified by hand (public Solana RPC, 13 Sep 2026), kept
   as investigator's notes and labelled as such on the page. They are not measured
   by this task; they say what the measured recipients are. */
export const OFFCHAIN_NOTES = {
  "6Kbjdqz6tgYkfDdVXUUWcdTLWJskhcFBWx7zvEkXpCv8": "Solana wallet active since 25 Jul 2026 holding ~34 memecoin balances; forwards its USDC to 2Z3ZTA…",
  "3cHpU4duLFpN8L2MxjjYpwi5G3pMVh8NySkJub2mKj8Y": "Solana Squads multisig vault (active since Oct 2025); pays USDC out to 2Z3ZTA…",
  "683tpX79E9uWH8eaqa1Phfk3YGLSQFRu1yjxqYKheFDb": "Solana wallet active May–Jul 2026, before AI launched",
  "2Z3ZTALEr4MTh6k2tcU2ZQqWETtHVNrBjrfa8d9CRf7V": "Solana collector wallet (19 transactions): receives USDC from the two above and sends it on to GSFdsv…",
  "GSFdsvuANvVJ2MvX5kpt2optkQEYs4dE4mAjzpDDyQWE": "Solana address with exchange-scale activity (~46 transactions an hour): consistent with an exchange deposit address, the last hop visible on chain",
};
/* What kind of account each treasury wallet is. Read from the chain where the
   chain says it (Safe owners via getOwners()/getThreshold(), account code), and
   from the transfer pattern otherwise. Labels for the measured wallets, not
   measurements; no person is named. */
export const IDENTITIES = {
  "0x1890e719822bc704c4f117aa4109401c2bab6f79": { short: "personal FOMO trading wallet", who: "a personal trading wallet on the FOMO app, not an operations account",
    evidence: "receives the steady stream of small launchpad-token airdrops and social-app transfers a FOMO account gets (dozens a day); its 18.47M AI has not moved since 16 Jul 2026" },
  "0xa1627ad8a4e6ad23e1085c6872079a60f985007b": { short: "operator account", who: "the operator's main smart account (Alchemy Modular Account v2)",
    evidence: "receives the fee wallet's forwards; sole or co-owner of the three Safes below; the account that sells through Robinhood Wallet's Settler and Rainbow and bridges USDG to Solana" },
  "0xae346da9a51535e782d22cdf010a3ce0ba6140ca": { short: "operator Safe (2-of-2)", who: "Safe multisig owned by the operator account and a co-signer", evidence: "getOwners() = 0xa1627ad8…, 0x20481f27…; getThreshold() = 2" },
  "0xce6541c872a8b50fb7b285de52ad0d189ba89dcc": { short: "operator Safe (2-of-2)", who: "Safe multisig owned by the operator account and the same co-signer", evidence: "getOwners() = 0xa1627ad8…, 0x20481f27…; getThreshold() = 2; received 3,000,000 AI from the sibling Safe" },
  "0xf1a19597e8842c27bfed01475bec5e12aeeed69a": { short: "operator Safe (1-of-1)", who: "Safe owned by the operator account alone", evidence: "getOwners() = 0xa1627ad8…; getThreshold() = 1" },
  "0x20481f270ef6842c0938219c2a51fe13ec8435bf": { short: "Safe co-signer", who: "the second owner of both 2-of-2 operator Safes", evidence: "getOwners() on 0xae346da9… and 0xce6541c8…; paid 2.2M AI directly by the operator accounts" },
};
/* Accounts the chain itself proves are the operator's, which the hop-based
   discovery would otherwise leave as "outside wallets": Safes whose getOwners()
   returns the same owner set as the Safes already followed. */
const OPERATOR_ACCOUNTS = ["0xce6541c872a8b50fb7b285de52ad0d189ba89dcc"];
const MACHINERY = new Set([POOL_MANAGER, LONG_HOOK, FEE_SPLITTER, COMMUNITY_VAULT, BURN_ADDRESS]);
const HOPS = 4;          // how many of the fee wallet's destinations to follow
const HOP2 = 4;          // and how many of THEIR wallet-like destinations (the operator's other accounts)
const MAX_WALLETS = 12;
const TOP_TOKENS = 40;   // platform-wide fee tokens to name and price
const WEEK = 7 * 86400;
const CLASS_VERSION = 4; // bump when the classification rule changes; cached kinds are discarded
/* Relay's chain ids for the destinations seen so far; anything else shows its id. */
const CHAIN_NAMES = { 792703809: "Solana", 1: "Ethereum", 8453: "Base", 42161: "Arbitrum", 10: "Optimism", 137: "Polygon", 56: "BNB Chain", 43114: "Avalanche", 4663: "Robinhood Chain", 1329: "Sei", 2741: "Abstract", 33139: "ApeChain", 480: "World Chain", 57073: "Ink", 130: "Unichain", 1868: "Soneium", 34443: "Mode", 8333: "B3", 59144: "Linea", 534352: "Scroll", 81457: "Blast", 7777777: "Zora", 1135: "Lisk", 999: "HyperEVM", 5000: "Mantle", 100: "Gnosis", 324: "zkSync", 1101: "Polygon zkEVM", 728126428: "Tron", 8253038: "Bitcoin", 9286185: "Eclipse" };

/** Wallet-like: an EOA, an EIP-7702 delegated EOA (23 bytes), or a small proxy such as a Safe. Routers and settlers are far larger. */
async function walletLike(a) {
  try { const code = await rpc("eth_getCode", [a, "latest"]); return !code || code === "0x" || (code.length - 2) / 2 <= 200; } catch { return false; }
}

/**
 * Where a bridge deposit landed, from Relay's public request index: destination
 * chain, recipient, and the delivered amount. One lookup per deposit, cached.
 */
async function relayDestination(tx, cache) {
  if (cache[tx] && !cache[tx].unknown) return cache[tx];
  try {
    let r, j;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await fetch(`https://api.relay.link/requests/v2?hash=${tx}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (r.status !== 429) break;
      await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));   // the index rate-limits; a 429 is not "no such request"
    }
    if (!r.ok) return null;                                                 // not cached: try again next run
    j = await r.json();
    const q = (j.requests || [])[0];
    if (!q) return (cache[tx] = { unknown: true });
    const d = q.data || {};
    const chainId = d.outTxs?.[0]?.chainId ?? d.currencyOut?.currency?.chainId ?? null;
    return (cache[tx] = {
      status: q.status, chainId, chain: chainId != null ? (CHAIN_NAMES[chainId] || `chain ${chainId}`) : "unknown",
      recipient: q.recipient || null, outTx: d.outTxs?.[0]?.hash || null,
      outSymbol: d.currencyOut?.currency?.symbol || null, outAmount: d.currencyOut?.amountFormatted ? Number(d.currencyOut.amountFormatted) : null,
    });
  } catch { return null; }   // not cached: try again next run
}

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
  const [transfers, pm, v3] = await Promise.all([
    rpc("eth_getLogs", [{ fromBlock: hexBlock(block), toBlock: hexBlock(block), topics: [TOPICS.TRANSFER] }]),
    rpc("eth_getLogs", [{ address: POOL_MANAGER, fromBlock: hexBlock(block), toBlock: hexBlock(block), topics: [[TOPICS.SWAP, TOPICS.MODIFY_LIQUIDITY]] }]),
    rpc("eth_getLogs", [{ fromBlock: hexBlock(block), toBlock: hexBlock(block), topics: [[V3_SWAP, V3_MINT, V3_BURN, ALGEBRA_SWAP]] }]),
  ]);
  const net = {};        // token -> bigint string
  const cps = new Set();  // direct counterparties of the wallet
  const aiNet = new Map(); // every address's net AI in the transaction: who ended up with what the wallet let go of
  for (const l of transfers) {
    if (l.transactionHash !== tx || l.topics.length < 3) continue;
    const t = decodeTransfer(l);
    const tok = l.address.toLowerCase();
    if (t.from === wallet) { net[tok] = ((BigInt(net[tok] || "0")) - t.value).toString(); cps.add(t.to); }
    if (t.to === wallet) { net[tok] = ((BigInt(net[tok] || "0")) + t.value).toString(); cps.add(t.from); }
    if (tok === AI.toLowerCase()) {
      aiNet.set(t.from, (aiNet.get(t.from) || 0n) - t.value);
      aiNet.set(t.to, (aiNet.get(t.to) || 0n) + t.value);
    }
  }
  /* The address that ended the transaction holding the most AI it did not start
     with, other than the wallet itself and the pool manager: the buyer on the far
     side of a sale through a router, or the recipient of a hand-off. Pools take
     AI on a direct sale, and that is recorded as the pool manager. */
  let aiTo = null, aiToAmount = 0n;
  for (const [a, d] of aiNet) if (a !== wallet && a !== BURN_ADDRESS && d > aiToAmount) { aiTo = a; aiToAmount = d; }
  let lpDelta = 0n, poolId = null, swapped = false;
  for (const l of pm) {
    if (l.transactionHash !== tx) continue;
    if (l.topics[0] === TOPICS.MODIFY_LIQUIDITY) { const m = decodeModifyLiquidity(l); lpDelta += m.liquidityDelta; poolId = poolId || m.poolId; }
    else swapped = true;
  }
  /* v3 / Algebra: Mint adds liquidity, Burn removes it, Swap is a swap; the pool
     is the emitting contract, named as such. */
  for (const l of v3) {
    if (l.transactionHash !== tx) continue;
    if (l.topics[0] === V3_MINT) { lpDelta += 1n; poolId = poolId || `v3:${l.address.toLowerCase()}`; }
    else if (l.topics[0] === V3_BURN) { lpDelta -= 1n; poolId = poolId || `v3:${l.address.toLowerCase()}`; }
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
  return (cache[key] = { kind, poolId, net, via, bridged, swapped, aiTo, aiToAmount: aiToAmount.toString() });
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
  for (const a of OPERATOR_ACCOUNTS) wallets.add(a);
  for (const w of [...wallets]) if (w !== PLATFORM_FEE_RECIPIENT) await walk(w);
  /* Second tier: the largest AI destinations of those wallets that are themselves
     wallet-like (an EOA, a 7702 account, a Safe), which is how the operator's other
     accounts are found without anyone naming them. Routers are large contracts and
     are skipped; they are counterparties, not custody. */
  const second = new Map();
  for (const w of [...wallets]) {
    if (w === PLATFORM_FEE_RECIPIENT) continue;
    for (const [a, v] of Object.entries(state.wallets[w].AI?.byDest || {})) {
      if (NAMES[a] || MACHINERY.has(a) || wallets.has(a)) continue;
      second.set(a, (second.get(a) || 0) + v);
    }
  }
  state.walletLike ||= {};
  for (const [a] of [...second].sort((x, y) => y[1] - x[1])) {
    if (wallets.size >= MAX_WALLETS || [...wallets].length - 1 - hops.length >= HOP2) break;
    if (state.walletLike[a] == null) state.walletLike[a] = await walletLike(a);
    if (!state.walletLike[a]) continue;
    wallets.add(a);
    await walk(a);
  }
  log(`  fee wallet forwards AI to ${hops.length} address(es), and those to ${wallets.size - 1 - hops.length} more wallet-like account(s); ledgers for ${wallets.size} wallets to block ${cursor.toLocaleString()}`);

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

  /* 2b. Where every bridge deposit landed, from Relay's index. Earlier runs cached
     a rate-limited answer as "unknown"; those are retried until the index answers. */
  state.relay ||= {};
  let looked = 0;
  for (const w of wallets) for (const L of Object.values(state.wallets[w])) for (const p of L.txs) {
    if (p.dir !== "out" || !BRIDGES.has(p.cp) || (state.relay[p.tx] && !state.relay[p.tx].unknown)) continue;
    if (deadline && Date.now() > deadline) { partial = true; break; }
    await new Promise((res) => setTimeout(res, 250));   // stay under the index's rate limit
    if (await relayDestination(p.tx, state.relay)) looked++;
  }
  if (looked) log(`  resolved ${looked} bridge deposit(s) to their destination chain and recipient`);

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
  const pairName = (id) => {
    if (id && id.startsWith("v3:")) { const a = id.slice(3); return `${NAMES[a] || "v3-style pool"} ${a.slice(0, 8)}`; }
    const c = poolPairs.get(id); return c ? `${sym(c[0])} / ${sym(c[1])}` : (id ? id.slice(0, 10) : "?");
  };
  const price = opts.priceOf || (() => null);
  const byAddr = Object.fromEntries(Object.entries(TRACK).map(([s, t]) => [t.address.toLowerCase(), s]));

  /* 5. Uses per wallet per token from the classified transactions. Each
     transaction is counted once per wallet; the token's own net in that
     transaction decides which bucket it lands in. */
  const uses = (w) => {
    const u = {}; for (const s of Object.keys(TRACK)) u[s] = { sold: 0, bought: 0, lpAdded: 0, lpRemoved: 0, sentOn: 0, internal: 0, bridged: 0, received: 0, pools: {}, via: {}, wentTo: {}, sentOnTo: {}, bridgedTo: {} };
    const seen = new Set();
    const endLabel = (to) => to === POOL_MANAGER ? "v4 pools" : NAMES[to] ? NAMES[to] : wallets.has(to) ? `treasury wallet ${to}` : to;
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
        else if (k.kind === "out") {
          if (k.bridged) {
            u[s].bridged += v;
            const r = state.relay?.[p.tx];
            const dest = r && !r.unknown ? `${r.chain} · ${r.recipient || "?"}` : "destination not resolved";
            u[s].bridgedTo[dest] = (u[s].bridgedTo[dest] || 0) + v;
          } else if (wallets.has(p.cp)) u[s].internal += v;
          else {
            u[s].sentOn += v;
            /* A plain send is not a destination: a hand-off to a router that sold
               into a pool in the same transaction is a sale. Record where the AI
               ended up so the page can fold "moved elsewhere" into its end state. */
            if (s === "AI" && k.aiTo) { const l = endLabel(k.aiTo); u[s].sentOnTo[l] = (u[s].sentOnTo[l] || 0) + v; }
          }
        }
        else if (k.kind === "in") u[s].received += v;
        /* Who ended up with the AI, for anything that left: a sale's far side, or a
           hand-off's recipient. Named where the page can name it. */
        if (s === "AI" && outFlow && (k.kind === "swap" || k.kind === "out" || k.kind === "lp+") && k.aiTo) {
          const label = endLabel(k.aiTo);
          u[s].wentTo[label] = (u[s].wentTo[label] || 0) + v;
        }
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
      /* Same end-state rule as the per-wallet uses: a plain send whose AI ended in
         a pool or a router is a sale; one that ended in an outside wallet is paid
         out; only a send this page cannot place stays "sentOn". */
      const endOfSend = () => {
        const to = k.aiTo; if (!to) return "sentOn";
        if (to === POOL_MANAGER || /Uniswap v3|Algebra|Settler|router|Router|Permit2|hook/.test(NAMES[to] || "")) return "sold";
        if (wallets.has(to)) return null;
        return NAMES[to] ? "sentOn" : "paidOut";
      };
      const key = k.kind === "lp+" && outFlow ? "lpAdded" : k.kind === "lp-" && !outFlow ? "lpRemoved" : k.kind === "swap" ? (outFlow ? "sold" : "bought") : k.kind === "out" ? (k.bridged ? "bridged" : wallets.has(p.cp) ? null : endOfSend()) : null;
      if (!key) continue;
      const t = Math.floor((tm.at(p.block) || 0) / WEEK) * WEEK; if (!t) continue;
      const r = weekly.get(t) || { t, sold: 0, bought: 0, lpAdded: 0, lpRemoved: 0, sentOn: 0, paidOut: 0, bridged: 0 };
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

  /* Bridge destinations across every wallet, for the page's headline. */
  const bridgeSummary = {};
  for (const w of wallets) for (const L of Object.values(state.wallets[w])) for (const p of L.txs) {
    if (p.dir !== "out" || !BRIDGES.has(p.cp)) continue;
    const r = state.relay?.[p.tx];
    const key = r && !r.unknown ? `${r.chain}|${r.recipient || "?"}` : "unresolved|";
    const b = (bridgeSummary[key] ||= { chain: r && !r.unknown ? r.chain : "unresolved", recipient: r?.recipient || null, deposits: 0, byToken: {} });
    b.deposits++;
  }
  // token amounts per destination, keyed by ledger symbol
  for (const w of wallets) for (const [sym, L] of Object.entries(state.wallets[w])) for (const p of L.txs) {
    if (p.dir !== "out" || !BRIDGES.has(p.cp)) continue;
    const r = state.relay?.[p.tx];
    const key = r && !r.unknown ? `${r.chain}|${r.recipient || "?"}` : "unresolved|";
    const b = bridgeSummary[key]; if (!b) continue;
    b.byToken[sym] = (b.byToken[sym] || 0) + p.v;
  }

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
    notes: OFFCHAIN_NOTES,
    identities: IDENTITIES,
    bridges: Object.values(bridgeSummary).map((b) => ({ ...b, byToken: Object.fromEntries(Object.entries(b.byToken).map(([k, v]) => [k, r4(v)])) })).sort((a, b) => b.deposits - a.deposits),
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
