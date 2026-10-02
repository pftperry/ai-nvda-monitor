import { rpc, rpcBatch, getLogsRange, padAddr } from "../rpc.mjs";
import { keccak256, selector } from "../keccak.mjs";
import { COMMUNITY_VAULT, POOL_MANAGER, USDG, AI, BLOCKS_PER_DAY } from "../config.mjs";
import { TOPICS } from "../decode.mjs";

/* THE COMMUNITY VAULT'S CONTROLS, AND ANY LIQUIDITY IT OWNS.

   The vault is an OpenZeppelin TimelockController (verified on Blockscout). Nothing
   leaves it except through an operation that is first scheduled on chain, waits out
   the minimum delay, and is then executed. As deployed (block 21,001,035): a 48-hour
   delay, one proposer and canceller (0xFD73...0F64), execution open to anyone once
   an operation is ready, and the deployer's admin role renounced so the timelock
   administers itself. So every move of the vault's assets is visible here at least
   two days before it can happen. This step reads that queue.

   On 1 Oct 2026 LONG announced that community vaults will move their stock into
   USDG/STOCK pools as liquidity. A position is not a token balance, so the moment
   that happens a balance-only read shows the vault's NVDA vanishing. The second half
   of this step values whatever positions the vault (or a contract it hands assets
   to) comes to own, Uniswap v4 or v3, at the current pool price, with unclaimed fees
   counted separately. Collected fees land in the vault as ordinary balances and are
   already counted there, so nothing is counted twice. */

const VAULT = COMMUNITY_VAULT.toLowerCase();
const VAULT_DEPLOY_BLOCK = 21_001_035;
export const V4_POSITION_MANAGER = "0x58daec3116aae6d93017baaea7749052e8a04fa7";   // "Uniswap v4 Positions NFT"
const STATE_V = 1;

const EV = {
  scheduled: keccak256("CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)"),
  executed: keccak256("CallExecuted(bytes32,uint256,address,uint256,bytes)"),
  cancelled: keccak256("Cancelled(bytes32)"),
  salt: keccak256("CallSalt(bytes32,bytes32)"),
  minDelay: keccak256("MinDelayChange(uint256,uint256)"),
  granted: keccak256("RoleGranted(bytes32,address,address)"),
  revoked: keccak256("RoleRevoked(bytes32,address,address)"),
};
const ROLE = {
  [keccak256("PROPOSER_ROLE")]: "proposer",
  [keccak256("EXECUTOR_ROLE")]: "executor",
  [keccak256("CANCELLER_ROLE")]: "canceller",
  ["0x" + "0".repeat(64)]: "admin",
};

/* functions an operation is likely to call, named so the page can say what a queued
   move does rather than show calldata */
const FN = Object.fromEntries([
  "transfer(address,uint256)", "approve(address,uint256)", "transferFrom(address,address,uint256)",
  "approve(address,address,uint160,uint48)",                                   // Permit2
  "modifyLiquidities(bytes,uint256)", "multicall(bytes[])",                    // v4 PositionManager
  "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",   // v3 NPM
  "increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))",
  "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))",
  "collect((uint256,address,uint128,uint128))",
  "safeTransferFrom(address,address,uint256)",
  "grantRole(bytes32,address)", "revokeRole(bytes32,address)", "renounceRole(bytes32,address)",
  "updateDelay(uint256)",
  "schedule(address,uint256,bytes,bytes32,bytes32,uint256)", "cancel(bytes32)",
].map((s) => [selector(s), s]));
/* v4-periphery action codes, for reading a modifyLiquidities plan */
const V4_ACTION = { 0x00: "increase liquidity", 0x01: "decrease liquidity", 0x02: "mint position", 0x03: "burn position",
  0x04: "increase from deltas", 0x05: "mint from deltas", 0x0b: "settle", 0x0c: "settle all", 0x0d: "settle pair",
  0x0e: "take", 0x0f: "take all", 0x10: "take portion", 0x11: "take pair", 0x12: "close currency", 0x13: "clear or take", 0x14: "sweep" };

const word = (hex, i) => hex.slice(2 + 64 * i, 2 + 64 * (i + 1));
const wAddr = (hex, i) => "0x" + word(hex, i).slice(24).toLowerCase();
const wUint = (hex, i) => BigInt("0x" + (word(hex, i) || "0"));
const wInt = (hex, i, bits) => BigInt.asIntN(bits, wUint(hex, i));
const w32 = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const i24hex = (t) => BigInt.asUintN(24, BigInt(t)).toString(16).padStart(6, "0");
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();
/* dynamic bytes inside ABI data: the word at `i` is an offset to [length][bytes] */
function dynBytes(hex, i) {
  const off = Number(wUint(hex, i)) * 2;
  const len = Number(BigInt("0x" + hex.slice(2 + off, 2 + off + 64))) * 2;
  return "0x" + hex.slice(2 + off + 64, 2 + off + 64 + len);
}

const call = (to, data, from) => ({ method: "eth_call", params: [from ? { to, data, from } : { to, data }, "latest"] });
const SEL = {
  extsload: selector("extsload(bytes32)"),
  posInfo: selector("getPoolAndPositionInfo(uint256)"),
  ownerOf: selector("ownerOf(uint256)"),
  balanceOf: selector("balanceOf(address)"),
  v3positions: selector("positions(uint256)"),
  v3factory: selector("factory()"),
  getPool: selector("getPool(address,address,uint24)"),
  slot0: selector("slot0()"),
  collect: selector("collect((uint256,address,uint128,uint128))"),
  minDelay: selector("getMinDelay()"),
  hasRole: selector("hasRole(bytes32,address)"),
};

const Q128 = 1n << 128n, M128 = Q128 - 1n, M160 = (1n << 160n) - 1n, M256 = (1n << 256n) - 1n;
const tickToSqrt = (t) => Math.pow(1.0001, t / 2);
function amountsFor(L, sqrtA, sqrtB, sqrtP) {
  if (sqrtP <= sqrtA) return { a0: L * (1 / sqrtA - 1 / sqrtB), a1: 0 };
  if (sqrtP >= sqrtB) return { a0: 0, a1: L * (sqrtB - sqrtA) };
  return { a0: L * (1 / sqrtP - 1 / sqrtB), a1: L * (sqrtP - sqrtA) };
}
/* fee growth inside a range, as the pool computes it (wrapping arithmetic) */
function feeInside(tick, lo, hi, global, outLo, outHi) {
  const below = tick >= lo ? outLo : (global - outLo) & M256;
  const above = tick < hi ? outHi : (global - outHi) & M256;
  return (global - below - above) & M256;
}

/* v4 state behind PoolManager.extsload. Layout checked against this chain: the LONG
   hook's AI/NVDA position read this way matched the ModifyLiquidity replay to the wei. */
const POOLS_SLOT = 6n;
const v4State = (poolId) => BigInt(keccak256("0x" + poolId.slice(2) + w32(POOLS_SLOT)));
const slotHex = (n) => "0x" + w32(n);
async function readV4Position({ poolId, owner, tickLower, tickUpper, salt }) {
  const S = v4State(poolId);
  const posKey = keccak256("0x" + owner.slice(2).toLowerCase() + i24hex(tickLower) + i24hex(tickUpper) + salt.slice(2).padStart(64, "0"));
  const P = BigInt(keccak256(posKey + w32(S + 6n)));
  const tick = (t) => BigInt(keccak256("0x" + w32(BigInt(t)) + w32(S + 4n)));
  const TL = tick(tickLower), TU = tick(tickUpper);
  const slots = [S, S + 1n, S + 2n, P, P + 1n, P + 2n, TL + 1n, TL + 2n, TU + 1n, TU + 2n];
  const r = await rpcBatch(slots.map((s) => call(POOL_MANAGER, SEL.extsload + w32(s))));
  if (r.some((x) => x == null)) return null;
  const v = r.map((x) => BigInt(x));
  const sqrtPX96 = v[0] & M160, curTick = Number(BigInt.asIntN(24, (v[0] >> 160n) & 0xffffffn));
  const L = v[3] & M128;
  const in0 = feeInside(curTick, tickLower, tickUpper, v[1], v[6], v[8]);
  const in1 = feeInside(curTick, tickLower, tickUpper, v[2], v[7], v[9]);
  return { sqrtPX96, curTick, L,
    fees0: (((in0 - v[4]) & M256) * L) >> 128n,
    fees1: (((in1 - v[5]) & M256) * L) >> 128n };
}

export async function indexVaultWatch(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const deadline = opts.deadline || Infinity;
  const tokens = opts.tokens || new Map();            // address -> { symbol, decimals, priceUsd }
  const priceOf = (a) => (a === USDG.toLowerCase() ? 1 : tokens.get(a)?.priceUsd ?? null);
  const symOf = (a) => (a === "0x0000000000000000000000000000000000000000" ? "ETH" : a === USDG.toLowerCase() ? "USDG" : a === AI.toLowerCase() ? "AI" : tokens.get(a)?.symbol || a.slice(0, 8) + "…");
  const decOf = (a) => (a === USDG.toLowerCase() ? 6 : tokens.get(a)?.decimals ?? 18);
  const at = (b) => tm.at(b) ?? null;

  const prev = opts.state?.v === STATE_V ? opts.state : null;
  const S = prev ? structuredClone(prev) : { v: STATE_V, cursor: VAULT_DEPLOY_BLOCK - 1, ops: {}, roles: {}, minDelay: null,
    nftCursor: latest - 3 * BLOCKS_PER_DAY, nfts: {}, v4Cursor: VAULT_DEPLOY_BLOCK - 1, direct: {}, modules: [] };

  /* 1. The timelock's own events, every one since deployment, behind a cursor. */
  if (S.cursor < latest) {
    const logs = await getLogsRange({ address: VAULT }, S.cursor + 1, latest, { chunk: 9_000_000, deadline });
    for (const l of logs) {
      const k = l.topics[0], b = parseInt(l.blockNumber, 16), t = at(b);
      if (k === EV.scheduled) {
        const id = l.topics[1], index = Number(BigInt(l.topics[2]));
        const op = S.ops[id] || (S.ops[id] = { id, calls: [] });
        op.scheduledBlock = b; op.scheduledT = t; op.scheduledTx = l.transactionHash;
        op.delay = Number(wUint(l.data, 4)); op.readyT = t == null ? null : t + op.delay;
        op.predecessor = "0x" + word(l.data, 3);
        op.calls[index] = { index, target: wAddr(l.data, 0), value: wUint(l.data, 1).toString(), data: dynBytes(l.data, 2) };
      } else if (k === EV.executed) {
        const op = S.ops[l.topics[1]] || (S.ops[l.topics[1]] = { id: l.topics[1], calls: [] });
        op.executedBlock = b; op.executedT = t; op.executedTx = l.transactionHash;
        const index = Number(BigInt(l.topics[2]));
        if (!op.calls[index]) op.calls[index] = { index, target: wAddr(l.data, 0), value: wUint(l.data, 1).toString(), data: dynBytes(l.data, 2) };
      } else if (k === EV.cancelled) {
        const op = S.ops[l.topics[1]] || (S.ops[l.topics[1]] = { id: l.topics[1], calls: [] });
        op.cancelledBlock = b; op.cancelledT = t; op.cancelledTx = l.transactionHash;
      } else if (k === EV.minDelay) {
        S.minDelay = Number(wUint(l.data, 1));
      } else if (k === EV.granted || k === EV.revoked) {
        const role = ROLE[l.topics[1]] || l.topics[1];
        const acct = topicAddr(l.topics[2]);
        S.roles[role] = S.roles[role] || {};
        if (k === EV.granted) S.roles[role][acct] = b; else delete S.roles[role][acct];
      }
    }
    S.cursor = logs.reachedBlock;
  }
  /* the delay as the contract reports it now, which is what binds */
  const [md] = await rpcBatch([call(VAULT, SEL.minDelay)]);
  if (md) S.minDelay = Number(BigInt(md));

  /* 2. What each operation does, in words. Addresses an operation sends the vault's
     tokens to, or lets spend them, become watched owners: a position minted by an
     LP module on the vault's behalf belongs on the vault's books. */
  const modules = new Set(S.modules);
  const describe = (c) => {
    const sel = c.data.slice(0, 10), sig = FN[sel] || null;
    const args = "0x" + c.data.slice(10);
    const tok = tokens.has(c.target) || c.target === USDG.toLowerCase() || c.target === AI.toLowerCase();
    const amt = (a, raw) => `${(Number(raw) / 10 ** decOf(a)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${symOf(a)}`;
    let text = sig ? `${sig.split("(")[0]} on ${tok ? symOf(c.target) : c.target}` : `call ${sel} on ${c.target}`;
    let flows = [];
    if (sig === "transfer(address,uint256)" && tok) {
      const to = wAddr(args, 0); text = `send ${amt(c.target, wUint(args, 1))} to ${to}`; flows.push({ token: c.target, to, raw: wUint(args, 1).toString() }); modules.add(to);
    } else if (sig === "approve(address,uint256)" && tok) {
      const sp = wAddr(args, 0); const raw = wUint(args, 1);
      text = `allow ${sp} to spend ${raw === M256 ? "all" : amt(c.target, raw)} of the vault's ${symOf(c.target)}`; modules.add(sp);
    } else if (sig === "modifyLiquidities(bytes,uint256)") {
      try {
        const unlock = dynBytes(args, 0);
        const actions = dynBytes(unlock, 0).slice(2).match(/../g) || [];
        text = `Uniswap v4 position change: ${actions.map((h) => V4_ACTION[parseInt(h, 16)] || `action 0x${h}`).join(", ")}`;
      } catch { text = "Uniswap v4 position change"; }
    } else if (sig && /^(grantRole|revokeRole|renounceRole)/.test(sig)) {
      text = `${sig.split("(")[0]} ${ROLE["0x" + word(args, 0)] || "role"} for ${wAddr(args, 1)}`;
    } else if (sig === "updateDelay(uint256)") {
      text = `change the delay to ${(Number(wUint(args, 0)) / 3600).toFixed(1)} hours`;
    }
    return { ...c, fn: sig, text, flows };
  };
  const nowT = at(latest) ?? Math.floor(Date.now() / 1000);
  const ops = Object.values(S.ops).map((op) => {
    const calls = (op.calls || []).filter(Boolean).map(describe);
    const status = op.cancelledT ? "cancelled" : op.executedT ? "executed" : op.readyT != null && nowT >= op.readyT ? "ready" : "pending";
    return { ...op, calls, status };
  }).sort((a, b) => (b.scheduledT || b.executedT || 0) - (a.scheduledT || a.executedT || 0));
  for (const m of [VAULT, POOL_MANAGER.toLowerCase(), V4_POSITION_MANAGER, AI.toLowerCase(), USDG.toLowerCase()]) modules.delete(m);
  for (const a of tokens.keys()) modules.delete(a);
  S.modules = [...modules];
  /* extraOwners and seedNfts exist for testing the valuation against someone else's
     live position; the indexer never passes them */
  const owners = [VAULT, ...S.modules, ...(opts.extraOwners || []).map((a) => a.toLowerCase())];
  for (const n of opts.seedNfts || []) S.nfts[`${n.contract}:${n.id}`] = { ...n, firstBlock: null };

  /* 3. Position NFTs reaching any watched owner, ERC721 Transfers only (four topics).
     The scan starts three days before this step existed: the vault had executed no
     operation by then, so it cannot have put its own assets into a position earlier,
     and the v4 manager's balanceOf below cross-checks that nothing was missed. */
  if (S.nftCursor < latest && Date.now() < deadline) {
    let reached = latest;
    for (const o of owners) {
      const logs = await getLogsRange({ topics: [TOPICS.TRANSFER, null, padAddr(o)] }, S.nftCursor + 1, latest, { chunk: 25_000, deadline });
      for (const l of logs) if (l.topics.length === 4) {
        const id = BigInt(l.topics[3]).toString();
        S.nfts[`${l.address.toLowerCase()}:${id}`] = { contract: l.address.toLowerCase(), id, firstBlock: parseInt(l.blockNumber, 16) };
      }
      reached = Math.min(reached, logs.reachedBlock);
      if (logs.truncated) break;
    }
    S.nftCursor = reached;
  }
  /* 4. Positions a watched owner holds in the pool manager directly, not through the
     NFT manager (an LP module might). The vault itself cannot: a timelock has no
     unlock callback. */
  if (S.v4Cursor < latest && Date.now() < deadline) {
    let reached = latest;
    for (const o of owners) {
      const logs = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.MODIFY_LIQUIDITY, null, padAddr(o)] }, S.v4Cursor + 1, latest, { chunk: 9_000_000, deadline });
      for (const l of logs) {
        const d = l.data, lo = Number(wInt(d, 0, 24)), hi = Number(wInt(d, 1, 24)), salt = "0x" + word(d, 3);
        S.direct[`${l.topics[1]}:${o}:${lo}:${hi}:${salt}`] = { poolId: l.topics[1], owner: o, tickLower: lo, tickUpper: hi, salt };
      }
      reached = Math.min(reached, logs.reachedBlock);
      if (logs.truncated) break;
    }
    S.v4Cursor = reached;
  }

  /* 5. Value every position at the current pool price. */
  const positions = [];
  const val = (a, raw) => { const units = Number(raw) / 10 ** decOf(a); const px = priceOf(a); return { token: a, symbol: symOf(a), units, usd: px == null ? null : units * px }; };
  const range = (lo, hi, d0, d1, stockIs0) => {
    /* price bounds in USDG per stock (or token1 per token0 when neither is USDG) */
    const p = (t) => Math.pow(1.0001, t) * 10 ** (d0 - d1);
    const [a, b] = [p(lo), p(hi)];
    return stockIs0 ? [a, b] : [1 / b, 1 / a];
  };
  for (const n of Object.values(S.nfts)) {
    const [own] = await rpcBatch([call(n.contract, SEL.ownerOf + w32(n.id))]);
    const owner = own ? "0x" + own.slice(26).toLowerCase() : null;
    if (!owner || !owners.includes(owner)) continue;
    if (n.contract === V4_POSITION_MANAGER) {
      const [info] = await rpcBatch([call(n.contract, SEL.posInfo + w32(n.id))]);
      if (!info || info.length < 2 + 64 * 6) continue;
      const c0 = wAddr(info, 0), c1 = wAddr(info, 1);
      const poolId = keccak256("0x" + info.slice(2, 2 + 64 * 5));
      const packed = wUint(info, 5);
      const tickLower = Number(BigInt.asIntN(24, (packed >> 8n) & 0xffffffn)), tickUpper = Number(BigInt.asIntN(24, (packed >> 32n) & 0xffffffn));
      const st = await readV4Position({ poolId, owner: V4_POSITION_MANAGER, tickLower, tickUpper, salt: "0x" + w32(n.id) });
      if (!st || st.L === 0n) continue;
      positions.push(build("v4", { ref: `v4 #${n.id}`, nft: n.id, owner, poolId, fee: Number(wUint(info, 2)), c0, c1, tickLower, tickUpper, ...st }));
    } else {
      /* anything else answering the v3 manager's positions() */
      const [p] = await rpcBatch([call(n.contract, SEL.v3positions + w32(n.id))]);
      if (!p || p.length < 2 + 64 * 12) continue;
      const c0 = wAddr(p, 2), c1 = wAddr(p, 3), fee = Number(wUint(p, 4));
      const tickLower = Number(wInt(p, 5, 24)), tickUpper = Number(wInt(p, 6, 24)), L = wUint(p, 7) & M128;
      if (L === 0n) continue;
      const [fac] = await rpcBatch([call(n.contract, SEL.v3factory)]);
      const [pool] = fac ? await rpcBatch([call("0x" + fac.slice(26), SEL.getPool + w32(BigInt(c0)) + w32(BigInt(c1)) + w32(fee))]) : [null];
      const poolAddr = pool ? "0x" + pool.slice(26) : null;
      const [s0] = poolAddr ? await rpcBatch([call(poolAddr, SEL.slot0)]) : [null];
      if (!s0) continue;
      /* unclaimed fees, exactly: simulate the owner collecting everything */
      const [col] = await rpcBatch([call(n.contract, SEL.collect + w32(n.id) + w32(BigInt(owner)) + w32(M128) + w32(M128), owner)]);
      positions.push(build("v3", { ref: `v3 #${n.id}`, nft: n.id, owner, pool: poolAddr, fee, c0, c1, tickLower, tickUpper, L,
        sqrtPX96: wUint(s0, 0), curTick: Number(wInt(s0, 1, 24)),
        fees0: col ? wUint(col, 0) : 0n, fees1: col ? wUint(col, 1) : 0n }));
    }
  }
  for (const d of Object.values(S.direct)) {
    const st = await readV4Position(d);
    if (!st || st.L === 0n) continue;
    const key = opts.poolKeys?.get?.(d.poolId) || null;
    positions.push(build("v4", { ref: `v4 direct`, owner: d.owner, poolId: d.poolId, c0: key?.c0 || null, c1: key?.c1 || null, tickLower: d.tickLower, tickUpper: d.tickUpper, ...st }));
  }
  function build(kind, p) {
    const sqrtP = Number(p.sqrtPX96) / 2 ** 96;
    const { a0, a1 } = amountsFor(Number(p.L), tickToSqrt(p.tickLower), tickToSqrt(p.tickUpper), sqrtP);
    const c0 = p.c0?.toLowerCase(), c1 = p.c1?.toLowerCase();
    const hold = c0 && c1 ? [val(c0, a0), val(c1, a1)] : [];
    const fees = c0 && c1 ? [val(c0, p.fees0), val(c1, p.fees1)] : [];
    const usdOf = (xs) => xs.length && xs.every((x) => x.usd != null) ? xs.reduce((s, x) => s + x.usd, 0) : null;
    const stockIs0 = c1 === USDG.toLowerCase();
    return {
      kind, ref: p.ref, nft: p.nft ?? null, owner: p.owner, pool: p.pool || p.poolId, fee: p.fee ?? null,
      pair: c0 && c1 ? `${symOf(stockIs0 ? c0 : c1)}/${symOf(stockIs0 ? c1 : c0)}` : "unknown pool",
      tickLower: p.tickLower, tickUpper: p.tickUpper, tick: p.curTick, inRange: p.curTick >= p.tickLower && p.curTick < p.tickUpper,
      priceRange: c0 && c1 ? range(p.tickLower, p.tickUpper, decOf(c0), decOf(c1), stockIs0 || c0 !== USDG.toLowerCase()) : null,
      liquidity: p.L.toString(), holdings: hold, usd: usdOf(hold), fees, feesUsd: usdOf(fees),
    };
  }

  /* 6. The v4 manager's own count of NFTs the vault holds, against what was found. */
  const [bal] = await rpcBatch([call(V4_POSITION_MANAGER, SEL.balanceOf + w32(BigInt(VAULT)))]);
  const v4NftsHeld = bal ? Number(BigInt(bal)) : null;
  const v4NftsFound = positions.filter((p) => p.kind === "v4" && p.nft && p.owner === VAULT).length;

  /* Only positions the vault itself owns go into its totals. A module an operation
     hands tokens to may serve other pairs' vaults too, so everything it holds is not
     necessarily AI's; its positions are listed, flagged, and left out of the total
     rather than risk overstating the vault. */
  for (const p of positions) p.viaModule = p.owner !== VAULT;
  const own = positions.filter((p) => !p.viaModule);
  const byToken = new Map();
  for (const p of own) for (const h of [...p.holdings, ...p.fees]) {
    const e = byToken.get(h.token) || { token: h.token, symbol: h.symbol, units: 0, usd: 0, priced: true };
    e.units += h.units; if (h.usd == null) e.priced = false; else e.usd += h.usd;
    byToken.set(h.token, e);
  }
  const lpUsd = own.reduce((s, p) => s + (p.usd || 0), 0), feesUsd = own.reduce((s, p) => s + (p.feesUsd || 0), 0);
  const moduleUsd = positions.filter((p) => p.viaModule).reduce((s, p) => s + (p.usd || 0) + (p.feesUsd || 0), 0);
  const role = (r) => Object.keys(S.roles[r] || {});
  const pending = ops.filter((o) => o.status === "pending" || o.status === "ready");
  log(`  vault: timelock delay ${S.minDelay == null ? "?" : (S.minDelay / 3600).toFixed(0) + "h"}, ${ops.length} operation(s) ever scheduled, ${pending.length} pending; ${positions.length} LP position(s) worth $${Math.round(lpUsd).toLocaleString()} + $${Math.round(feesUsd).toLocaleString()} unclaimed fees; v4 NFTs held ${v4NftsHeld ?? "?"}, found ${v4NftsFound}`);
  return {
    state: S,
    artifact: {
      address: VAULT, cursor: S.cursor,
      timelock: {
        kind: "OpenZeppelin TimelockController", deployBlock: VAULT_DEPLOY_BLOCK,
        minDelay: S.minDelay, proposers: role("proposer"), cancellers: role("canceller"), executors: role("executor"), admins: role("admin"),
        openExecution: role("executor").includes("0x0000000000000000000000000000000000000000"),
        selfAdministered: role("admin").length === 1 && role("admin")[0] === VAULT,
      },
      ops: ops.slice(0, 50), opsEver: ops.length, executedEver: ops.filter((o) => o.status === "executed").length, pending: pending.length,
      topics: { scheduled: EV.scheduled, executed: EV.executed, cancelled: EV.cancelled },
      lp: { positions, usd: Math.round(lpUsd * 100) / 100, feesUsd: Math.round(feesUsd * 100) / 100, moduleUsd: Math.round(moduleUsd * 100) / 100,
        byToken: [...byToken.values()].map((e) => ({ ...e, units: +e.units.toPrecision(10), usd: e.priced ? Math.round(e.usd * 100) / 100 : null })),
        v4NftsHeld, v4NftsFound, watchedOwners: owners },
      method: "The Community Vault is an OpenZeppelin TimelockController: every move of its assets is first scheduled on chain, waits out the minimum delay, then executes. Every CallScheduled, CallExecuted and Cancelled event since deployment is read and each call decoded. Liquidity positions held by the vault, or by a contract an operation sends its tokens to, are valued at the current pool price from the pool's own state (Uniswap v4 via PoolManager.extsload, v3 from the pool and the position manager); unclaimed fees are computed from the pool's fee growth (v4) or by simulating a collect (v3) and shown separately. Collected fees arrive as ordinary vault balances and are counted there.",
    },
  };
}

/* Fold LP holdings into a reserve list of { token, units, ... }: stock sitting in a
   position is still the vault's stock. Returns the AI held in positions separately,
   since the page counts the vault's AI on its own line. */
export function lpUnitsByToken(lp) {
  const m = new Map();
  for (const e of lp?.byToken || []) m.set(e.token, (m.get(e.token) || 0) + e.units);
  return m;
}
