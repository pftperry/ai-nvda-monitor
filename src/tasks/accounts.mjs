/* Which of these addresses is a person, and which is plumbing.
 *
 * "Has code" is the obvious test and it is WRONG on this chain. Measured on the
 * addresses the site displays: 116 accounts, 70 of them with code, and 56 of those
 * were EIP-7702 delegated EOAs -- ordinary user wallets that have been upgraded to
 * smart accounts, which is what FOMO's Privy wallets are. Excluding "anything with
 * code" would have deleted @Natan_benish, @m0f0, @SolSwizzle and seventeen other
 * verified humans while leaving the actual problem in place.
 *
 * A 7702 account is recognisable without guessing: its code is exactly the 23-byte
 * delegation indicator, 0xef0100 followed by the 20-byte implementation address.
 * That is a marker the protocol defines, not a heuristic.
 *
 * What is left after that is genuinely a contract. On the same sample only three
 * were: two 22,142-byte pools (one already carried a "Uniswap v3 pool" label and
 * was showing up as top buyer AND top seller in every window, which is what a pool
 * looks like from the outside) and one minimal proxy.
 *
 * Results are cached in the resume store. A contract's code never changes, and a
 * delegation can be revoked but rarely is, so entries are re-checked weekly rather
 * than every run.
 */
import { rpcBatch } from "../rpc.mjs";

const RECHECK_SECS = 7 * 86400;
const BATCH = 40;
/* EIP-7702: code is 0xef0100 || address, so 23 bytes, 48 hex characters with 0x */
const DELEGATION_PREFIX = "0xef0100";
const DELEGATION_LEN = 48;

export const EOA = "eoa";               // no code at all
export const SMART = "smart";           // an EOA that delegated under EIP-7702
export const CONTRACT = "contract";     // a pool, router, proxy or anything else

/** A person controls an EOA whether or not they have upgraded it. */
export const isPerson = (kind) => kind === EOA || kind === SMART;

export async function classifyAccounts(addresses, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store;
  const now = Math.floor(Date.now() / 1000);
  const cached = store?.get("accountKinds") || {};
  const out = new Map();

  const want = [];
  for (const raw of addresses) {
    if (!raw) continue;
    const a = raw.toLowerCase();
    if (out.has(a)) continue;
    const hit = cached[a];
    if (hit && now - (hit.t || 0) < RECHECK_SECS) { out.set(a, hit.kind); continue; }
    out.set(a, null);
    want.push(a);
  }

  let checked = 0;
  for (let i = 0; i < want.length; i += BATCH) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const group = want.slice(i, i + BATCH);
    let res;
    try {
      res = await rpcBatch(group.map((a) => ({ method: "eth_getCode", params: [a, "latest"] })));
    } catch (e) {
      /* an unknown account is treated as a person, because the cost of wrongly
         hiding a real trader is higher than the cost of showing a pool one run
         longer, and the next run will settle it */
      continue;
    }
    group.forEach((a, j) => {
      const code = res[j];
      const kind = !code || code === "0x" ? EOA
        : (code.startsWith(DELEGATION_PREFIX) && code.length === DELEGATION_LEN) ? SMART
        : CONTRACT;
      out.set(a, kind);
      cached[a] = { kind, t: now };
      checked++;
    });
  }
  /* anything the budget did not reach keeps whatever the cache knew, or counts as a
     person until a later run says otherwise */
  for (const [a, v] of out) if (v == null) out.set(a, cached[a]?.kind || EOA);

  if (store) store.set("accountKinds", cached);
  const tally = { eoa: 0, smart: 0, contract: 0 };
  for (const k of out.values()) tally[k]++;
  log(`  accounts: ${out.size} classified (${checked} freshly), ${tally.eoa} EOA, ${tally.smart} EIP-7702 smart wallet, ${tally.contract} contract`);
  return out;
}
