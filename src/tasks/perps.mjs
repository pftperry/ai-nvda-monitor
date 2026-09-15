import { rpc, rpcBatch, getLogsRange, padAddr } from "../rpc.mjs";
import { USDG, GENESIS_BLOCK } from "../config.mjs";
import { TOPICS, decodeTransfer, fmtUnits } from "../decode.mjs";
import { multicall, resolveTokens } from "../tokens.mjs";
import { stockPools } from "./rwa.mjs";

/**
 * LongX perps, measured from Robinhood Chain alone.
 *
 * LongX runs leveraged vaults (NVDA 3x Long, OPENAI 1x Long, ...) whose shares are
 * ERC-20s on this chain and whose positions live on Lighter. What the chain shows,
 * read from one deposit transaction on 15 Sep 2026:
 *   - a depositor sends USDG to the vault's share contract;
 *   - a keeper calls the vault, which mints shares (Transfer from the zero address)
 *     and forwards the USDG to one address, `LIGHTER_BRIDGE`, which emits its own
 *     deposit events; withdrawals come back the same way.
 * So USDG flowing from the vaults into that address, less what flows back, is the
 * USDG LongX has placed on Lighter; share supply times the share's on-chain price is
 * what depositors hold; mints and burns per day are deposit and withdrawal demand.
 * The vaults publish no NAV on-chain (Dune says the same), so shares are priced from
 * their spot pools like every other anchor here.
 *
 * Vaults are recognised, not listed: every counterparty of the bridge whose code
 * is the vaults' 291-byte proxy. A new vault appears on its first deposit.
 *
 * Dune's dashboard counts "Perps" (LONG pools anchored to vault shares) separately
 * from every stock number; this site does the same, and rwa.mjs takes the pool
 * catalogue built here to bucket those pools' volume apart from the stock volume.
 */
export const LIGHTER_BRIDGE = "0x94bab9693ba2f6358507effcbd372b0660afff9d";
/* Lighter's own plumbing on this chain: its router is the bridge's largest feeder
   (about $26M) and is neither a vault nor a mystery. */
export const KNOWN_INFRA = { "0x8062df5b3220ad1f528365650a3eb3e8c7b0dad1": "Lighter router" };
export const VAULT_CODE_PREFIX = "0x60806040819052635c60da";
const VAULT_CODE_BYTES = 291;
const ZERO_TOPIC = "0x" + "0".repeat(64);
const SUPPLY_SEL = "0x18160ddd", BALANCE_SEL = "0x70a08231";
const LONGX_ERA = Date.UTC(2026, 7, 20) / 1000;   // LongX perps launched 31 Aug 2026; start a little before

const clean = (s) => String(s || "").replace(/[^\x20-\x7e]/g, "").trim();

export async function indexPerps(latest, tm, opts = {}) {
  const store = opts.store, log = opts.log || console.log;
  const deadline = opts.deadline || Date.now() + 120_000;
  const timeLeft = () => Date.now() < deadline;
  const t0 = Date.now();
  const startBlock = Math.max(GENESIS_BLOCK, tm.blockAt(LONGX_ERA) ?? GENESIS_BLOCK);

  /* 1. USDG through the bridge, both directions, daily, with per-counterparty totals. */
  let B = store && store.get("perpsBridge");
  if (!B || B.v !== 1) B = { v: 1, cursor: startBlock - 1, days: {}, senders: {}, receivers: {}, code: {} };
  const bump = (d, dir, v) => { const r = (B.days[d] ||= { in: 0, out: 0, inTx: 0, outTx: 0 }); r[dir] += v; r[dir + "Tx"] += 1; };
  if (B.cursor + 1 <= latest && timeLeft()) {
    const from = B.cursor + 1, snap = JSON.stringify([B.days, B.senders, B.receivers]);
    const rIn = await getLogsRange({ address: USDG, topics: [TOPICS.TRANSFER, null, padAddr(LIGHTER_BRIDGE)] }, from, latest, { chunk: 600_000, deadline,
      onLogs: (ls) => { for (const l of ls) { const t = decodeTransfer(l), d = tm.dayBucket(t.block); if (d == null) continue; const v = fmtUnits(t.value, 6); bump(d, "in", v); B.senders[t.from] = (B.senders[t.from] || 0) + v; } } });
    const reach = rIn.reachedBlock ?? latest;
    let ok = reach >= from;
    if (ok) {
      const rOut = await getLogsRange({ address: USDG, topics: [TOPICS.TRANSFER, padAddr(LIGHTER_BRIDGE), null] }, from, reach, { chunk: 600_000, deadline: deadline + 60_000,
        onLogs: (ls) => { for (const l of ls) { const t = decodeTransfer(l), d = tm.dayBucket(t.block); if (d == null) continue; const v = fmtUnits(t.value, 6); bump(d, "out", v); B.receivers[t.to] = (B.receivers[t.to] || 0) + v; } } });
      ok = !rOut.truncated;
    }
    if (!ok) { [B.days, B.senders, B.receivers] = JSON.parse(snap); B.partial = true; }
    else { B.cursor = reach; B.partial = !!rIn.truncated; }
  }

  /* 2. Which counterparties are LongX vaults. The bridge is Lighter's deposit
        contract for the whole chain (about $80M in over three weeks, mostly from
        Lighter's own router and depositors' wallets), so LongX has to be recognised:
        the leveraged vaults' shared 291-byte proxy, or an ERC-20 whose name says
        "Long" or "Pre IPO" (the first generation: "OPENAI Pre IPO Token"). Checked
        once per address and remembered; a contract that is neither is listed as
        unattributed so a new product shows up for review rather than vanishing. */
  const cands = [...new Set([...Object.keys(B.senders), ...Object.keys(B.receivers)])];
  B.names ||= {};
  const str = (h) => { try { if (!h || h === "0x") return ""; if (h.length === 66) return Buffer.from(h.slice(2), "hex").toString(); const off = parseInt(h.slice(2, 66), 16) * 2, len = parseInt(h.slice(2 + off, 2 + off + 64), 16) * 2; return Buffer.from(h.slice(2 + off + 64, 2 + off + 64 + len), "hex").toString(); } catch { return ""; } };
  /* Thousands of depositors' wallets sit among the counterparties, so the code
     lookups go out as JSON-RPC batches (measured: one call each ate a whole
     300-second budget). A wallet is empty code or an EIP-7702 delegation
     (0xef0100 + address, 23 bytes); only real contracts get a name lookup. */
  const unknown = cands.filter((a) => B.code[a] === undefined);
  for (let i = 0; i < unknown.length && timeLeft(); i += 40) {
    const part = unknown.slice(i, i + 40);
    const codes = await rpcBatch(part.map((a) => ({ method: "eth_getCode", params: [a, "latest"] }))).catch(() => part.map(() => null));
    const contracts = [];
    part.forEach((a, k) => { const c = codes[k]; if (c == null) return; if (c === "0x" || c.startsWith("0xef0100")) B.code[a] = false; else contracts.push([a, c]); });
    if (!contracts.length) continue;
    const names = await multicall(contracts.flatMap(([a]) => [{ to: a, data: "0x06fdde03" }, { to: a, data: "0x95d89b41" }])).catch(() => contracts.flatMap(() => [null, null]));
    contracts.forEach(([a, c], k) => {
      const proxy = c.startsWith(VAULT_CODE_PREFIX) && (c.length - 2) / 2 === VAULT_CODE_BYTES;
      const name = clean(str(names[k * 2])), sym = clean(str(names[k * 2 + 1]));
      B.names[a] = { name, sym, bytes: (c.length - 2) / 2 };
      B.code[a] = KNOWN_INFRA[a] ? "infra" : proxy || /\b(long|pre ipo)\b/i.test(name) ? true : "contract";
    });
  }
  if (store) store.set("perpsBridge", B);
  const vaults = cands.filter((a) => B.code[a] === true && !KNOWN_INFRA[a]).sort();
  const unattributed = cands.filter((a) => B.code[a] === "contract" && !KNOWN_INFRA[a] && B.senders[a]).map((a) => ({ address: a, inUsd: Math.round(B.senders[a]), outUsd: Math.round(B.receivers[a] || 0), name: B.names[a]?.name || "", bytes: B.names[a]?.bytes })).sort((x, y) => y.inUsd - x.inUsd);
  const otherIn = unattributed.reduce((s, u) => s + u.inUsd, 0);
  const infra = cands.filter((a) => KNOWN_INFRA[a]).map((a) => ({ address: a, label: KNOWN_INFRA[a], inUsd: Math.round(B.senders[a] || 0), outUsd: Math.round(B.receivers[a] || 0) }));
  const unclassified = cands.filter((a) => B.code[a] === undefined).length;

  /* 3. Share supply, pending USDG, symbols. */
  const meta = vaults.length ? await resolveTokens(vaults, { log: () => {} }) : new Map();
  for (const a of vaults) { const m = meta.get(a) || { decimals: 18 }; if (!clean(m.symbol)) m.symbol = B.names[a]?.sym || a.slice(0, 8); m.name = B.names[a]?.name || ""; meta.set(a, m); }
  const calls = vaults.flatMap((a) => [{ to: a, data: SUPPLY_SEL }, { to: USDG, data: BALANCE_SEL + a.slice(2).padStart(64, "0") }]);
  const res = vaults.length ? await multicall(calls) : [];
  const num = (h, dec) => (h && h !== "0x" ? fmtUnits(BigInt(h), dec) : null);

  /* 4. Mints and burns per day, one address-list filter per direction. */
  let Sh = store && store.get("perpsShares");
  if (!Sh || Sh.v !== 1) Sh = { v: 1, cursor: startBlock - 1, days: {} };
  const known = new Set(Sh.known || []);
  const fresh = vaults.filter((a) => !known.has(a));
  if (vaults.length && timeLeft()) {
    const scan = async (addrs, from) => {
      const snap = JSON.stringify(Sh.days);
      const fold = (kind) => (ls) => { for (const l of ls) { const t = decodeTransfer(l), d = tm.dayBucket(t.block); if (d == null) continue; const tok = l.address.toLowerCase(), dec = meta.get(tok)?.decimals ?? 18; const r = ((Sh.days[d] ||= {})[tok] ||= { mint: 0, burn: 0 }); r[kind] += fmtUnits(t.value, dec); } };
      const m = await getLogsRange({ address: addrs, topics: [TOPICS.TRANSFER, ZERO_TOPIC] }, from, latest, { chunk: 600_000, deadline, onLogs: fold("mint") });
      const reach = m.reachedBlock ?? latest;
      let ok = reach >= from;
      if (ok) { const b = await getLogsRange({ address: addrs, topics: [TOPICS.TRANSFER, null, ZERO_TOPIC] }, from, reach, { chunk: 600_000, deadline: deadline + 60_000, onLogs: fold("burn") }); ok = !b.truncated; }
      if (!ok) { Sh.days = JSON.parse(snap); return null; }
      return { reach, partial: !!m.truncated };
    };
    if (fresh.length) { const r = await scan(fresh, startBlock); if (r && !r.partial) { for (const a of fresh) known.add(a); } if (r) Sh.freshReach = r.reach; }
    const old = vaults.filter((a) => known.has(a) && !fresh.includes(a));
    if (old.length && Sh.cursor + 1 <= latest) { const r = await scan(old, Sh.cursor + 1); if (r) { Sh.cursor = r.reach; Sh.partial = r.partial; } }
    if (fresh.length && known.size === vaults.length) Sh.cursor = Math.min(Sh.cursor > startBlock ? Sh.cursor : latest, Sh.freshReach ?? latest);
    Sh.known = [...known];
    if (store) store.set("perpsShares", Sh);
  }

  /* 5. Every v4 pool quoting a vault share, LONG-hooked or not (rwa.mjs uses this
        to keep perps volume apart from stock volume). */
  const poolState = (store && store.get("perpsPools")) || {};
  const pools = new Map();
  for (const a of vaults) {
    if (timeLeft()) poolState[a] = await stockPools(a, latest, poolState[a], { deadline });
    for (const p of poolState[a]?.pools || []) pools.set(p.id, { share: a, side: p.side, long: p.long, ai: p.ai });
  }
  if (store) store.set("perpsPools", poolState);

  /* 6. Publish. */
  const today = tm.dayBucket(latest), d1 = today - 86400;
  const price = (a) => opts.anchorUsd?.get(a) ?? null;
  const vaultRows = vaults.map((a, i) => {
    const dec = meta.get(a)?.decimals ?? 18, supply = num(res[i * 2], dec), pendingUsdg = num(res[i * 2 + 1], 6), px = price(a);
    const day = (d) => Sh.days[d]?.[a] || { mint: 0, burn: 0 };
    const mine = poolState[a]?.pools || [];
    return { token: a, symbol: clean(meta.get(a)?.symbol) || a.slice(0, 8), name: meta.get(a)?.name || "", decimals: dec, supply, priceUsd: px, valueUsd: px != null && supply != null ? supply * px : null,
      pendingUsdg, mint24h: day(d1).mint, burn24h: day(d1).burn, mintToday: day(today).mint, burnToday: day(today).burn,
      depositedUsd: B.senders[a] || 0, withdrawnUsd: B.receivers[a] || 0,
      pools: mine.length, longPools: mine.filter((p) => p.long).length, poolsPartial: !!poolState[a]?.partial };
  }).sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0));
  /* Daily series: the bridge buckets are chain-wide, so LongX's own daily flow is
     the vaults' mints and burns valued at today's share prices (a deposit mints
     shares for the USDG it brought), which is the LongX-only signal the chain gives
     per day; the chain-wide bridge flow rides along for scale. */
  const days = [...new Set([...Object.keys(B.days), ...Object.keys(Sh.days)])].map(Number).filter((d) => d < today).sort((a, b) => a - b);
  let cumBridge = 0, cumMint = 0;
  const daily = days.map((d) => { const r = B.days[d] || { in: 0, out: 0 }; cumBridge += r.in - r.out; const sh = Sh.days[d] || {}; let mintUsd = 0, burnUsd = 0; for (const [tok, m] of Object.entries(sh)) { const px = price(tok) || 0; mintUsd += m.mint * px; burnUsd += m.burn * px; } cumMint += mintUsd - burnUsd; return { t: d, bridgeInUsd: Math.round(r.in), bridgeOutUsd: Math.round(r.out), bridgeNetUsd: Math.round(cumBridge), mintUsd: Math.round(mintUsd), burnUsd: Math.round(burnUsd), netMintUsd: Math.round(cumMint) }; });
  const inAll = Object.values(B.days).reduce((s, r) => s + r.in, 0), outAll = Object.values(B.days).reduce((s, r) => s + r.out, 0);
  const out = {
    updatedAt: Math.floor(Date.now() / 1000), since: LONGX_ERA, bridge: LIGHTER_BRIDGE,
    /* `lighter` is LongX's slice of the bridge: vault deposits less vault withdrawals.
       `bridgeAll` is the whole chain's traffic through the same contract, for scale. */
    lighter: { depositedUsd: Math.round(vaults.reduce((s, a) => s + (B.senders[a] || 0), 0)), withdrawnUsd: Math.round(vaults.reduce((s, a) => s + (B.receivers[a] || 0), 0)),
      netUsd: Math.round(vaults.reduce((s, a) => s + (B.senders[a] || 0) - (B.receivers[a] || 0), 0)), unattributed: unattributed.slice(0, 5), unattributedUsd: Math.round(otherIn), infra, unclassified, cursor: B.cursor, partial: !!B.partial },
    bridgeAll: { depositedUsd: Math.round(inAll), withdrawnUsd: Math.round(outAll), netUsd: Math.round(inAll - outAll) },
    vaults: vaultRows,
    valueUsd: vaultRows.reduce((s, v) => s + (v.valueUsd || 0), 0), priced: vaultRows.filter((v) => v.priceUsd != null).length,
    pools: { all: pools.size, long: [...pools.values()].filter((p) => p.long).length },
    daily, sharesPartial: !!Sh.partial,
  };
  log(`  LongX perps: ${vaults.length} vault(s) [${vaultRows.map((v) => v.symbol).join(", ")}], USDG to Lighter $${out.lighter.depositedUsd.toLocaleString()} in / $${out.lighter.withdrawnUsd.toLocaleString()} out (net $${out.lighter.netUsd.toLocaleString()}${otherIn ? `, plus $${Math.round(otherIn).toLocaleString()} from ${unattributed.length} unattributed contract(s)` : ""}${unclassified ? `, ${unclassified} counterpart(ies) still unclassified` : ""}), shares worth $${Math.round(out.valueUsd).toLocaleString()} (${out.priced}/${vaults.length} priced), ${out.pools.long} LONG pools of ${out.pools.all} quoting a share, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { perps: out, pools };
}
