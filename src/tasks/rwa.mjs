import { rpc, getLogsRange, padAddr } from "../rpc.mjs";
import { POOL_MANAGER, COMMUNITY_VAULT, LONG_HOOK, LONG_BUYBACK, AI, USDG, NVDA, GENESIS_BLOCK, BLOCKS_PER_DAY } from "../config.mjs";
import { TOPICS, decodeTransfer, decodeInitialize, decodeSwap, decodeModifyLiquidity, fmtUnits } from "../decode.mjs";
import { multicall, resolveTokens } from "../tokens.mjs";
import { ladderRawAmounts } from "./depth.mjs";
import { TimeMap } from "../timemap.mjs";

/**
 * The real-world-asset ledger: how much of Robinhood Chain's tokenized stock
 * supply, and of its tokenized stock trading, the LONG ecosystem has captured.
 *
 * The thesis being measured is LONG's own: be the liquidity layer for tokenized
 * equities on this chain. Three measures follow from it. Share of supply -- of
 * every NVDA token that exists on Robinhood Chain, what fraction sits inside DEX
 * liquidity or the community vault. Share of trading -- of every swap on the chain
 * that touches a stock token, what fraction (by count and by dollars) goes through
 * a pool carrying the LONG hook. Coverage -- of every stock token that moved on the
 * chain in the last day, how many have a LONG market at all.
 *
 * Stock tokens are identified by bytecode, not by name. Robinhood's tokenized
 * equities are all beacon proxies of one template (283 bytes) pointing at one
 * beacon; NVDA, DELL, ORCL and SPCX match it, a memecoin calling itself HOOD does
 * not. They also emit one private event on every transfer, which no other contract
 * on the chain emits: scanning for it enumerates every stock token that moved.
 */
export const STOCK_BEACON = "e10b6f6b275de231345c20d14ab812db62151b00";
export const STOCK_CODE = { bytes: 283, head: "0x6080604052600a600c565b", beacon: STOCK_BEACON };
export const isStockCode = (code) => typeof code === "string" && (code.length - 2) / 2 === STOCK_CODE.bytes
  && code.startsWith(STOCK_CODE.head) && code.toLowerCase().includes(STOCK_BEACON);
/** The stock tokens' companion event, emitted beside every Transfer (measured: 30 of 30 emitters carry the stock bytecode). */
export const STOCK_EVENT = "0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802";

const MIN_DEGREE = 3;              // pools a token must anchor before it is worth a getCode call
const CATALOGUE_VERSION = 2;       // 2: entries carry the pool's initial sqrt price, the fallback valuation price for pools that never traded

/* LONG's own definition of its assets and pools, taken from the public SQL behind
   its Dune dashboard (queries 8032167 and 8032178, read 14 Sep 2026):
   - an asset is every LaunchCreated from the two TickerAirlockFactory deployments
     and the LongLaunchFactory (topic2 = asset, topic3 = numeraire);
   - a pool is a v4 Initialize with the LONG hook whose pair is (asset, numeraire),
     or, after Airlock.Migrate(asset, pool), the graduated v2/v3 pool at that address,
     which holds its own tokens and is read by balance. */
export const LAUNCH_FACTORIES = ["0x9c88f06b72fcd3cedbef3be7521ee5abd72d0845", "0x22e99278308b393ea1260859b181ad7e78f5eeed", "0x1eef016f22a943abc7dd11422edee9d235942104"];
export const LAUNCH_CREATED = "0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b";
export const AIRLOCK = "0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862";
export const AIRLOCK_MIGRATE = "0x2a05bb717043f3a794e94382bf63f2e275ecafc41be9b63c34f16d58da9822ca";
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();

/* Dune's price source (query 8032188): the Chainlink aggregators behind Robinhood's
   feed proxies, 8 decimals. Read live with latestAnswer(); pool prints remain the
   fallback for stocks without a feed. Same numbers as LONG's dashboard. */
export const CHAINLINK_FEEDS = {
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": "0xbb11a21267cfdb63d4935d99a499133dd1744acb", // AAPL
  "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc": "0xdad54b8ee51af258e5a6faa9a84a3300f4775f7d", // AMD
  "0x12f190a9f9d7d37a250758b26824b97ce941bf54": "0x93503dfc97157cdb8aadccaf70452621d598fdeb", // AMZN
  "0xad25ac6c84d497db898fa1e8387bf6af3532a1c4": "0xff5f85e4888782e66f1dd9cabadf4822fbeb1439", // BABA
  "0x6330d8c3178a418788df01a47479c0ce7ccf450b": "0x30398b0b0df82a009bb2d507bc7fe1dc6d3ca294", // COIN
  "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5": "0x901d8df245e48dfc82d6483fc45b5be6ddc5281a", // CRCL
  "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3": "0xd9c04b7353421fc4deb1614ed13fe10d90e586cc", // CRWV
  "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3": "0x11ed6d598ef565dda86fafe7e779303e7cc6b2bd", // GOOGL
  "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681": "0x95fb52f75aecbca8e12aa4403f840c8bc18cfbd4", // INTC
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35": "0xc190b6164b9e320a6400cdab0085a2e0e2b9738e", // META
  "0xe93237c50d904957cf27e7b1133b510c669c2e74": "0xc3b117f52cf17dd4369eaf5eaf7cf0e2f91b4e30", // MSFT
  "0xff080c8ce2e5feadaca0da81314ae59d232d4afd": "0xa088fad0a0a62693af068e2edb80b1578c8a9365", // MU
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": "0xc9d16e4f2569b9e3ea0468fd85844953713dc2a2", // NVDA
  "0xb0992820e760d836549ba69bc7598b4af75dee03": "0x4a9abc759e0b7b0ba98b5fd39c419a5d3e962aaf", // ORCL
  "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a": "0x315afd0f71d5407b99ad19ab001a67af40fbaaf4", // PLTR
  "0xb90a19ff0af67f7779aff50a882a9cff42446400": "0x7b2fdfcea772f093dd33b3acf8ee294b368f6c23", // SNDK
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": "0x5eaa223c585f40cdca2d119ea91b97c491245631", // SPCX
  "0x322f0929c4625ed5bad873c95208d54e1c003b2d": "0x7a6b81ba7fbcb90104d8c496158cf383cd7233b1", // TSLA
  "0xd917b029c761d264c6a312bbbcda868658ef86a6": "0x76ba75c6c362900b275d9d4d5c422f0275e85578", // USAR
  "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68": "0x25e996ce8b3529885d429241156e83e7b7744049", // QQQ
  "0x92fd66527192e3e61d4ddd13322aa222de86f9b5": "0x0e96b7708487f91baac09697593d3e8bf253f2d8", // SGOV
  "0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f": "0xcdf6f7043b3af6afa0caaace1230b355096b5386", // SLV
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c": "0x78bcb218fa04b9b3a278ebc865ed320bf8defbac", // SPY
  "0x47f93d52cbec7c6d2cfc080e154002370a60daea": "0xf795030a46ad6ca4b07bf5fb704dc36039118c9f", // ASML
  "0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd": "0xd6ed4e7d4aba1111eb42a349899b5c72ee1c9fef", // DELL
  "0x1b0e319c6a659f002271b69db8a7df2f911c153e": "0xf83cde62d1cd90de8d2bf3332b90c590985ad679", // GME
  "0xec262a75e413fafd0df80480274532c79d42da09": "0x55bd01f666c99e4590e084fdeff88041bb50ccd1", // MSTR
  "0x58ffe4a942d3885baa22d7520691f611ef09e7aa": "0x2b3a9a18998e9464760658233ab093e6aebf45d0", // TSM
};
const LATEST_ANSWER = "0x50d25bcd";
/* LONG's hook emits its own event on every swap in a LONG pool (Dune query 8032229 reads
   volume from it): topic1 sender, topic3 pool id, data words 3 and 4 amount0/amount1
   (user perspective). Filtering on the hook address yields only LONG swaps. */
export const HOOK_SWAP = "0x1d9f7b5e406d8c887155e1a78e070d2d41c5d0444dab8b21612f846835c27183";
/* Robinhood's own stock venue, counted by Dune in "all stock trading"; USDG-quoted. */
export const RIALTO = "0x4262efbd176f02824af27010bea218429c33c7e8";
/* Rialto's fill event (topic1 trader, topic2 token in, topic3 token out; data word 1
   amount in, word 4 amount out) and the two router addresses through which its
   pool-routed fills touch the pool manager (in via the first, out via the second;
   measured: every pool-manager leg of those routers sat in a Rialto transaction). */
export const RIALTO_FILL = "0x4b02af496e764b30261032ae2ad58e4f96e73563c59fe32f8401e76531c1a95e";
export const RIALTO_ROUTERS = new Set(["0x040234dfd2d32336e3cd9534fa1909adab002cea", "0x006102b16a04c20306a28b652745d3973d7d24fa"]);
const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const word = (data, i) => data.slice(2 + 64 * i, 2 + 64 * (i + 1));
const int256 = (h) => BigInt.asIntN(256, BigInt("0x" + h));
const abs = (v) => (v < 0n ? -v : v);

/** Every LONG launch (asset → numeraire) and every graduation (asset → v2/v3 pool), cursor-resumed. */
async function launchRegistry(latest, store, deadline) {
  const st = (store && store.get("rwaLaunches")) || { v: 1, cursor: GENESIS_BLOCK - 1, launches: {}, migrations: {} };
  const from = Math.max(GENESIS_BLOCK, st.cursor + 1);
  if (from <= latest) {
    let reached = latest, partial = false;
    for (const f of LAUNCH_FACTORIES) {
      const r = await getLogsRange({ address: f, topics: [LAUNCH_CREATED] }, from, latest, { chunk: 5_000_000, deadline,
        onLogs: (logs) => { for (const l of logs) st.launches[topicAddr(l.topics[2])] = { numeraire: topicAddr(l.topics[3]), factory: f, block: parseInt(l.blockNumber, 16) }; } });
      reached = Math.min(reached, r.reachedBlock ?? latest); if (r.truncated) partial = true;
    }
    const m = await getLogsRange({ address: AIRLOCK, topics: [AIRLOCK_MIGRATE] }, from, latest, { chunk: 25_000_000, deadline,
      onLogs: (logs) => { for (const l of logs) st.migrations[topicAddr(l.topics[1])] = { pool: topicAddr(l.topics[2]), block: parseInt(l.blockNumber, 16) }; } });
    reached = Math.min(reached, m.reachedBlock ?? latest); if (m.truncated) partial = true;
    st.cursor = reached; st.partial = partial;
    if (store) store.set("rwaLaunches", st);
  }
  return st;
}
const DAILY_TRACKED = [NVDA];      // tokens whose DEX inventory is rebuilt daily from transfers
const UNIVERSE_WINDOW = 9_000;     // blocks of the stock event scanned per run (~15 min); samples are unioned over a day
const SUPPLY_SEL = "0x18160ddd";
const BALANCE_SEL = "0x70a08231";
const EXCLUDE = new Set([AI, USDG, "0x0000000000000000000000000000000000000000"]);

/**
 * Daily inventory of one token inside the v4 PoolManager, from its Transfer logs.
 * Two filtered scans (to and from the manager), streamed chunk by chunk -- NVDA
 * alone has millions of them, and holding them all blew a 4 GB heap -- and
 * resumable from a cursor, so the first runs pay for the history in instalments
 * and every later run pays for a few hours.
 */
async function dexInventoryDaily(token, latest, tm, prior, opts) {
  const state = prior && prior.cursor ? { ...prior, byDay: { ...prior.byDay } } : { cursor: GENESIS_BLOCK - 1, byDay: {} };
  const from = Math.max(GENESIS_BLOCK, state.cursor + 1);
  if (from > latest) return state;
  const fold = (sign) => (logs) => {
    for (const l of logs) {
      const t = decodeTransfer(l);
      if (t.from === t.to) continue;                       // a manager-to-manager transfer is not inventory
      const d = tm.dayBucket(t.block); if (!d) continue;
      state.byDay[d] = (state.byDay[d] || 0) + sign * fmtUnits(t.value, opts.decimals ?? 18);
    }
  };
  /* The two scans must end at the same block or a day could hold inflows without
     its outflows. The first scan sets the reach; the second is bounded by it. */
  const inLogs = await getLogsRange({ address: token, topics: [TOPICS.TRANSFER, null, padAddr(POOL_MANAGER)] }, from, latest, { deadline: opts.deadline, onLogs: fold(1), chunk: 200_000 });
  const reach = inLogs.reachedBlock ?? latest;
  if (reach < from) { state.partial = true; return state; }
  const outLogs = await getLogsRange({ address: token, topics: [TOPICS.TRANSFER, padAddr(POOL_MANAGER), null] }, from, reach, { deadline: opts.deadline + 120_000, onLogs: fold(-1), chunk: 200_000 });
  if (outLogs.truncated) {
    /* Out-scan cut short: roll the days past its reach back out of the in-scan too
       by recomputing from the prior state. Simplest correct move: keep the prior
       cursor and byDay and try again next run with a fresh budget. */
    return prior && prior.cursor ? { ...prior, partial: true } : { cursor: GENESIS_BLOCK - 1, byDay: {}, partial: true };
  }
  state.cursor = reach;
  state.partial = !!inLogs.truncated;
  return state;
}

/**
 * Every v4 pool that quotes a given stock token, whatever hook it carries, with
 * which side the stock sits on. Initialize indexes both currencies, so this is two
 * filtered scans per token, append-only and resumed from a cursor.
 */
export async function stockPools(token, latest, prior, opts) {
  const state = prior && prior.cursor ? { cursor: prior.cursor, pools: [...prior.pools] } : { cursor: GENESIS_BLOCK - 1, pools: [] };
  const from = Math.max(GENESIS_BLOCK, state.cursor + 1);
  if (from > latest) return state;
  const asC0 = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, padAddr(token)] }, from, latest, { chunk: 25_000_000, deadline: opts.deadline });
  const asC1 = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.INITIALIZE, null, null, padAddr(token)] }, from, latest, { chunk: 25_000_000, deadline: opts.deadline });
  const reached = Math.min(asC0.reachedBlock ?? latest, asC1.reachedBlock ?? latest);
  const seen = new Set(state.pools.map((p) => p.id));
  for (const l of [...asC0, ...asC1]) {
    if (parseInt(l.blockNumber, 16) > reached) continue;
    const p = decodeInitialize(l);
    if (seen.has(p.poolId)) continue;
    seen.add(p.poolId);
    /* Kept small: NVDA alone quotes ten thousand pools. */
    state.pools.push({ id: p.poolId, long: p.hooks === LONG_HOOK, ai: p.currency0 === AI || p.currency1 === AI, side: p.currency0 === token ? 0 : 1, p0: p.sqrtPriceX96.toString() });
  }
  state.cursor = reached;
  state.partial = !!(asC0.truncated || asC1.truncated);
  state.v = CATALOGUE_VERSION;
  return state;
}

/**
 * Which stock tokens moved on the chain lately, from the stock tokens' own
 * transfer event across every address. One short window per run, unioned over
 * the trailing day in the store, so the universe the capture is measured against
 * is every stock token that is actually in use, not only the ones LONG lists.
 */
async function universeSample(latest, store, deadline) {
  const st = (store && store.get("rwaUniverse")) || { samples: [] };
  const from = Math.max(GENESIS_BLOCK, latest - UNIVERSE_WINDOW + 1);
  const counts = {};
  const logs = await getLogsRange({ topics: [STOCK_EVENT] }, from, latest, { chunk: 1_500, deadline, onLogs: (ls) => { for (const l of ls) counts[l.address] = (counts[l.address] || 0) + 1; } });
  const now = Math.floor(Date.now() / 1000);
  st.samples = [...st.samples.filter((s) => now - s.t < 86400), { t: now, from, to: logs.reachedBlock ?? latest, partial: !!logs.truncated, tokens: counts }];
  if (store) store.set("rwaUniverse", st);
  const union = {};
  let blocks = 0;
  for (const s of st.samples) { blocks += (s.to - s.from + 1); for (const [a, n] of Object.entries(s.tokens)) union[a] = (union[a] || 0) + n; }
  return { active: union, samples: st.samples.length, blocksSampled: blocks, partial: !!logs.truncated };
}

/**
 * @param latest   head block
 * @param tm       time map
 * @param opts     { store, pools (LONG census: {id,c0,c1,block}), symbols, decimals, anchorUsd (Map token→usd),
 *                   swaps ({ counts: Map poolId→n, volume: Map poolId→[bigint,bigint], blocks, total, truncated }),
 *                   prior (last rwa.json), deadline, log }
 */
export async function indexRwa(latest, tm, opts = {}) {
  const log = opts.log || console.log;
  const store = opts.store;
  const pools = opts.pools || [];
  const symbols = new Map(opts.symbols || []);
  const decimals = new Map(opts.decimals || []);
  const anchorUsd = new Map(opts.anchorUsd || []);
  const priceSource = {};
  const sym = (a) => symbols.get(a) || a.slice(0, 8);
  const timeLeft = () => !opts.deadline || Date.now() < opts.deadline;
  const secs = (t) => `${((Date.now() - t) / 1000).toFixed(0)}s`;

  /* 1. The universe: stock tokens that moved on the chain lately, plus anything
        that anchors a few LONG pools. Classified once by bytecode and remembered. */
  const t0 = Date.now();
  const uni = await universeSample(latest, store, Date.now() + 90_000);
  log(`  stock-event scan: ${Object.keys(uni.active).length} tokens active over ${uni.samples} sample(s), ${uni.blocksSampled.toLocaleString()} blocks, ${secs(t0)}`);
  const degree = new Map(), withAi = new Map();
  for (const p of pools) {
    for (const t of [p.c0, p.c1]) degree.set(t, (degree.get(t) || 0) + 1);
    if (p.c0 === AI) withAi.set(p.c1, (withAi.get(p.c1) || 0) + 1);
    if (p.c1 === AI) withAi.set(p.c0, (withAi.get(p.c0) || 0) + 1);
  }
  const codeCache = (store && store.get("rwaCode")) || {};
  const candidates = [...new Set([
    ...[...degree].filter(([a, n]) => n >= MIN_DEGREE).map(([a]) => a),
    ...Object.keys(uni.active),
  ])].filter((a) => !EXCLUDE.has(a));
  let looked = 0;
  for (const a of candidates) {
    if (codeCache[a] != null) continue;
    if (!timeLeft()) break;
    try { codeCache[a] = isStockCode(await rpc("eth_getCode", [a, "latest"])); looked++; } catch { /* left unknown; retried next run */ }
  }
  if (store) store.set("rwaCode", codeCache);
  const stocks = candidates.filter((a) => codeCache[a] === true);
  const unlisted = stocks.filter((a) => !(degree.get(a) > 0));
  if (unlisted.length) {
    const meta = await resolveTokens(unlisted.filter((a) => !symbols.has(a)), { log: () => {} });
    for (const [a, m] of meta) { if (m.symbol) symbols.set(a, m.symbol); if (m.decimals != null) decimals.set(a, m.decimals); }
  }
  log(`  ${candidates.length} candidate tokens, ${looked} newly classified, ${stocks.length} are Robinhood stock tokens by bytecode (${unlisted.length} with no LONG pool)`);

  /* 1b. Dollar prices from the Chainlink aggregators LONG's dashboard uses, where a
        stock has one; pool prints otherwise. One multicall. */
  const feedTokens = stocks.filter((a) => CHAINLINK_FEEDS[a]);
  if (feedTokens.length) {
    const ans = await multicall(feedTokens.map((a) => ({ to: CHAINLINK_FEEDS[a], data: LATEST_ANSWER })));
    feedTokens.forEach((a, i) => {
      if (!ans[i] || ans[i] === "0x") return;
      const v = Number(BigInt.asIntN(256, BigInt(ans[i]))) / 1e8;
      if (v > 0) { anchorUsd.set(a, v); priceSource[a] = "chainlink"; }
    });
  }
  for (const a of stocks) if (!priceSource[a] && anchorUsd.has(a)) priceSource[a] = "pool";
  log(`  prices: ${Object.values(priceSource).filter((s) => s === "chainlink").length} stocks from Chainlink feeds, ${Object.values(priceSource).filter((s) => s === "pool").length} from pool prints`);

  /* 2. Supply on chain, inventory in the pool manager, balance in the vault,
        through Multicall3 (four hundred separate calls tripped the throttle). */
  const t1 = Date.now();
  const calls = [];
  for (const a of stocks) {
    calls.push({ to: a, data: SUPPLY_SEL });
    calls.push({ to: a, data: BALANCE_SEL + POOL_MANAGER.slice(2).padStart(64, "0") });
    calls.push({ to: a, data: BALANCE_SEL + COMMUNITY_VAULT.slice(2).padStart(64, "0") });
  }
  const res = await multicall(calls);
  const num = (h, dec) => (h && h !== "0x" ? fmtUnits(BigInt(h), dec) : null);
  const dexRaw = (a) => { const i = stocks.indexOf(a); const h = res[i * 3 + 1]; return h && h !== "0x" ? BigInt(h) : 0n; };
  log(`  supply and inventory for ${stocks.length} tokens read in ${secs(t1)}`);

  /* 3. Every pool quoting each stock, LONG-hooked or not, for the trading share.
        Biggest inventory first, resumable per token. */
  const poolState = (store && store.get("rwaPools")) || {};
  const t2 = Date.now();
  let catalogued = 0;
  const byDex = [...stocks].sort((x, y) => (dexRaw(y) > dexRaw(x) ? 1 : dexRaw(y) < dexRaw(x) ? -1 : 0));
  for (const a of byDex) {
    if (!timeLeft()) break;
    const prior = poolState[a]?.v === CATALOGUE_VERSION ? poolState[a] : null;   // older entries lack p0; rebuild once
    poolState[a] = await stockPools(a, latest, prior, { deadline: opts.deadline });
    if (!poolState[a].partial) catalogued++;
  }
  if (store) store.set("rwaPools", poolState);
  const allStockPools = new Map();   // poolId → { long, ai, p0, stocks: [{token, side}] }
  for (const a of stocks) for (const p of poolState[a]?.pools || []) {
    const e = allStockPools.get(p.id) || { long: p.long, ai: p.ai, p0: p.p0, stocks: [] };
    e.stocks.push({ token: a, side: p.side }); allStockPools.set(p.id, e);
  }
  log(`  pool catalogue: ${allStockPools.size.toLocaleString()} pools quote a stock token (${catalogued} of ${stocks.length} tokens complete), ${secs(t2)}`);

  const tokens = [];
  stocks.forEach((a, i) => {
    const dec = decimals.get(a) ?? 18;
    const supply = num(res[i * 3], dec), inDex = num(res[i * 3 + 1], dec), inVault = num(res[i * 3 + 2], dec);
    if (!(supply > 0)) return;
    const usd = anchorUsd.get(a) ?? null;
    const mine = poolState[a]?.pools || [];
    tokens.push({
      token: a, symbol: sym(a), decimals: dec,
      listed: (degree.get(a) || 0) > 0,
      activeTransfers: uni.active[a] || 0,
      supply, inDex, inVault,
      share: (inDex + inVault) / supply, dexShare: inDex / supply, vaultShare: inVault / supply,
      priceUsd: usd, priceSource: priceSource[a] || null, supplyUsd: usd ? supply * usd : null, dexUsd: usd ? inDex * usd : null, vaultUsd: usd ? inVault * usd : null,
      longPools: degree.get(a) || 0, aiPools: withAi.get(a) || 0,
      poolsAll: mine.length, poolsLong: mine.filter((p) => p.long).length,
      poolsPartial: !poolState[a] || !!poolState[a].partial,
    });
  });
  tokens.sort((a, b) => (b.dexUsd ?? 0) - (a.dexUsd ?? 0) || b.longPools - a.longPools);

  /* 4. Trading share in the window: swaps whose pool holds a stock token, split by
        whether the pool carries the LONG hook. By count, and by the dollar value
        of the stock leg where the stock has a price. */
  /* LONG's own asset list and graduations (Dune's scope), used by the trading share
     and the pool inventory below. */
  const reg = await launchRegistry(latest, store, opts.deadline);
  const launched = new Set(Object.keys(reg.launches));
  const stockSet = new Set(stocks);
  let swapShare = null;
  if (allStockPools.size) {
    /* 4a. LONG's share of tokenized-stock trading over a rolling 24-hour window.
          One cursor-resumed stream instead of a fresh two-hour census each run: the
          manager's Swap tape (every venue; stock pools folded, others only counted),
          the hook's own swap event (LONG's numerator, buyback legs flagged) and
          Rialto's fill event (Robinhood's own venue, USDG side taken from the event
          itself) are read over the same hour-sized sub-ranges and committed together,
          into hourly buckets kept for thirty hours. A run reads only the blocks since
          the last one; the first pass starts a day back and states how many hours it
          managed. Stock legs valued at today's prices, as everywhere on this page. */
    const WINDOW_H = 24, KEEP_H = 30, STEP = Math.round(BLOCKS_PER_DAY / 24);
    let SW = store && store.get("rwaSwapHours");
    if (!SW || SW.v !== 1) SW = { v: 1, cursor: null, first: null, hours: {} };
    const hourOf = (b) => tm.hourBucket(b);
    const bucket = (h) => { const b = (SW.hours[h] ||= { chainSwaps: 0, stockSwaps: 0, longSwaps: 0, aiPaired: 0, usdAll: 0, usdLong: 0, hookSwaps: 0, buybackSwaps: 0, hookUsd: 0, hookUserUsd: 0, rialtoUsd: 0, rialtoFills: 0, perToken: {} }); for (const k of ["perpSwaps", "perpLongSwaps", "perpUsd", "perpLongUsd"]) b[k] ??= 0; b.perPool ??= {}; return b; };
    const stockUsd = (e, a0, a1) => { for (const { token, side } of e.stocks) { const px = anchorUsd.get(token); if (!px) continue; return fmtUnits(abs(side === 0 ? a0 : a1), decimals.get(token) ?? 18) * px; } return 0; };
    /* LongX vault-share pools (perps) are bucketed apart, never into the stock
       figures: Dune's convention, and the honest one. */
    const perpPools = opts.perpPools || new Map();
    const perpUsd = (p, a0, a1) => { const px = anchorUsd.get(p.share); return px ? fmtUnits(abs(p.side === 0 ? a0 : a1), decimals.get(p.share) ?? 18) * px : 0; };
    const foldSwaps = (logs) => {
      for (const l of logs) {
        const h = hourOf(parseInt(l.blockNumber, 16)); if (h == null) continue;
        const B = bucket(h); B.chainSwaps++;
        const pp = perpPools.get(l.topics[1]);
        if (pp) { const s = decodeSwap(l), usd = perpUsd(pp, s.amount0, s.amount1); B.perpSwaps++; B.perpUsd += usd; if (pp.long) { B.perpLongSwaps++; B.perpLongUsd += usd; } continue; }
        const e = allStockPools.get(l.topics[1]); if (!e) continue;
        B.stockSwaps++; if (e.long) B.longSwaps++; if (e.long && e.ai) B.aiPaired++;
        const s = decodeSwap(l), usd = stockUsd(e, s.amount0, s.amount1);
        B.usdAll += usd; if (e.long) B.usdLong += usd;
        for (const { token } of e.stocks) { const p = (B.perToken[token] ||= { all: 0, long: 0, usdAll: 0, usdLong: 0 }); p.all++; p.usdAll += usd; if (e.long) { p.long++; p.usdLong += usd; } }
      }
    };
    const foldHook = (logs) => {
      for (const l of logs) {
        const e = allStockPools.get(l.topics[3]); if (!e) continue;
        const h = hourOf(parseInt(l.blockNumber, 16)); if (h == null) continue;
        const B = bucket(h), usd = stockUsd(e, int256(word(l.data, 3)), int256(word(l.data, 4)));
        B.hookSwaps++; B.hookUsd += usd;
        if (topicAddr(l.topics[1]) === LONG_BUYBACK) B.buybackSwaps++; else { B.hookUserUsd += usd; B.perPool[l.topics[3]] = (B.perPool[l.topics[3]] || 0) + usd; }
      }
    };
    const foldRialto = (logs) => {
      for (const l of logs) {
        if (l.topics.length < 4) continue;
        const a = topicAddr(l.topics[2]), b = topicAddr(l.topics[3]);
        if (!stockSet.has(a) && !stockSet.has(b)) continue;
        const usdg = b === USDG ? word(l.data, 4) : a === USDG ? word(l.data, 1) : null; if (!usdg) continue;   // USDG-quoted fills, as Dune counts them
        const h = hourOf(parseInt(l.blockNumber, 16)); if (h == null) continue;
        const B = bucket(h); B.rialtoFills++; B.rialtoUsd += fmtUnits(BigInt("0x" + usdg), 6);
      }
    };
    const t4 = Date.now();
    if (SW.cursor == null) { SW.cursor = Math.max(GENESIS_BLOCK, latest - WINDOW_H * STEP) - 1; SW.first = SW.cursor + 1; }
    /* Per-pool buckets were added later than the window itself; hours folded before
       that carry none, so the backing table states how many hours its volume covers. */
    if (SW.perPoolFirst == null) SW.perPoolFirst = SW.cursor + 1;
    let truncated = false, lo = SW.cursor + 1;
    while (lo <= latest && timeLeft()) {
      const hi = Math.min(latest, lo + STEP - 1);
      const snap = JSON.stringify(SW.hours);
      const a = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.SWAP] }, lo, hi, { chunk: 20_000, deadline: opts.deadline, onLogs: foldSwaps });
      const reach = a.reachedBlock ?? hi;
      let ok = reach >= lo;
      if (ok) {
        const b = await getLogsRange({ address: LONG_HOOK, topics: [HOOK_SWAP] }, lo, reach, { chunk: 20_000, deadline: opts.deadline + 60_000, onLogs: foldHook });
        const c = await getLogsRange({ address: RIALTO, topics: [RIALTO_FILL] }, lo, reach, { chunk: 70_000, deadline: opts.deadline + 90_000, onLogs: foldRialto });
        ok = !b.truncated && !c.truncated;
      }
      if (!ok) { SW.hours = JSON.parse(snap); truncated = true; break; }
      SW.cursor = reach; lo = reach + 1;
      if (a.truncated) { truncated = true; break; }
    }
    /* The window: the twenty-four hours ending at the cursor's hour. Older buckets
       are pruned; a first pass that did not reach a full day says so. */
    const endHour = hourOf(SW.cursor), startHour = endHour - (WINDOW_H - 1) * 3600;
    for (const k of Object.keys(SW.hours)) if (Number(k) < endHour - KEEP_H * 3600) delete SW.hours[k];
    if (store) store.set("rwaSwapHours", SW);
    const firstHour = hourOf(SW.first);
    const hoursCovered = Math.max(0, Math.round((endHour - Math.max(startHour, firstHour)) / 3600) + 1);
    const inWin = Object.entries(SW.hours).map(([k, B]) => [Number(k), B]).filter(([h]) => h >= startHour && h <= endHour).sort((x, y) => x[0] - y[0]);
    const tot = { chainSwaps: 0, stockSwaps: 0, longSwaps: 0, aiPaired: 0, usdAll: 0, usdLong: 0, hookSwaps: 0, buybackSwaps: 0, hookUsd: 0, hookUserUsd: 0, rialtoUsd: 0, rialtoFills: 0, perpSwaps: 0, perpLongSwaps: 0, perpUsd: 0, perpLongUsd: 0 };
    const per = new Map(), perPool = new Map();
    for (const [, B] of inWin) {
      for (const k of Object.keys(tot)) tot[k] += B[k] || 0;
      for (const [token, p] of Object.entries(B.perToken || {})) { const r = per.get(token) || { all: 0, long: 0, usdAll: 0, usdLong: 0 }; r.all += p.all; r.long += p.long; r.usdAll += p.usdAll; r.usdLong += p.usdLong; per.set(token, r); }
      for (const [id, v] of Object.entries(B.perPool || {})) perPool.set(id, (perPool.get(id) || 0) + v);
    }
    const denominatorUsd = tot.usdAll + tot.rialtoUsd;
    swapShare = {
      rolling: true, windowHours: hoursCovered, windowTargetHours: WINDOW_H, windowFrom: Math.max(startHour, firstHour), windowTo: endHour, cursor: SW.cursor,
      catalogueComplete: catalogued === stocks.length,
      truncated, chainSwaps: tot.chainSwaps,
      stockSwaps: tot.stockSwaps, longSwaps: tot.longSwaps, aiPairedSwaps: tot.aiPaired, share: tot.stockSwaps > 0 ? tot.longSwaps / tot.stockSwaps : null,
      usdAll: Math.round(tot.usdAll), usdLong: Math.round(tot.usdLong), usdShare: tot.usdAll > 0 ? tot.usdLong / tot.usdAll : null,
      /* Dune-equivalent figures (no stock-quoted pool has graduated to v2/v3, so that leg is nil) */
      dune: {
        longUsd: Math.round(tot.hookUsd), longUserUsd: Math.round(tot.hookUserUsd), hookSwaps: tot.hookSwaps, buybackSwaps: tot.buybackSwaps, graduatedUsd: 0, graduatedSwaps: 0,
        rialtoUsd: Math.round(tot.rialtoUsd), rialtoTxs: tot.rialtoFills, denominatorUsd: Math.round(denominatorUsd),
        share: denominatorUsd > 0 ? tot.hookUsd / denominatorUsd : null,
      },
      perps: { swaps: tot.perpSwaps, longSwaps: tot.perpLongSwaps, usd: Math.round(tot.perpUsd), longUsd: Math.round(tot.perpLongUsd), pools: perpPools.size, longPools: [...perpPools.values()].filter((p) => p.long).length },
      hourly: inWin.map(([h, B]) => ({ t: h, usdAll: Math.round(B.usdAll), usdLong: Math.round(B.usdLong), hookUsd: Math.round(B.hookUsd), rialtoUsd: Math.round(B.rialtoUsd), stockSwaps: B.stockSwaps, longSwaps: B.longSwaps,
        share: B.usdAll + B.rialtoUsd > 0 ? B.hookUsd / (B.usdAll + B.rialtoUsd) : null })),
      perToken: [...per].map(([t, r]) => ({ token: t, symbol: sym(t), all: r.all, long: r.long, share: r.all ? r.long / r.all : null,
        usdAll: Math.round(r.usdAll), usdLong: Math.round(r.usdLong) })).sort((x, y) => y.usdAll - x.usdAll || y.all - x.all),
      /* User stock volume per LONG pool (the hook's event, buyback legs excluded), for the backing table. */
      perPool: Object.fromEntries([...perPool].sort((a, b) => b[1] - a[1]).slice(0, 400).map(([id, v]) => [id, Math.round(v)])),
      perPoolHours: Math.max(0, Math.min(hoursCovered, Math.round((endHour - Math.max(startHour, hourOf(SW.perPoolFirst) ?? startHour)) / 3600) + 1)),
    };
    log(`  stock trading, rolling ${hoursCovered}h of ${WINDOW_H}h${truncated ? " (resumes)" : ""}: ${tot.stockSwaps.toLocaleString()} stock-pool swaps of ${tot.chainSwaps.toLocaleString()} on chain, ${tot.longSwaps.toLocaleString()} through LONG pools (${tot.stockSwaps ? (100 * tot.longSwaps / tot.stockSwaps).toFixed(1) : "—"}% by count, ${tot.usdAll ? (100 * tot.usdLong / tot.usdAll).toFixed(1) : "—"}% by dollars); Dune method: LONG $${Math.round(tot.hookUsd).toLocaleString()} (${tot.hookSwaps} hook swaps, ${tot.buybackSwaps} buyback) of $${Math.round(denominatorUsd).toLocaleString()} incl. Rialto $${Math.round(tot.rialtoUsd).toLocaleString()} (${tot.rialtoFills} fills) → ${denominatorUsd ? (100 * tot.hookUsd / denominatorUsd).toFixed(1) : "—"}%, cursor ${SW.cursor.toLocaleString()}, ${secs(t4)}`);
  }

  /* 4b. Stock inventory inside LONG's own pools, for EVERY LONG stock pool.
        The pool manager's balance mixes every venue, and the singleton keeps no
        per-pool balance, so each pool's position ladder is rebuilt from the
        ModifyLiquidity tape. Not pool by pool -- forty thousand pools would be a
        hundred thousand queries -- but from ONE stream of every ModifyLiquidity
        the manager ever emitted, keeping only the pools in the stock catalogue,
        resumed from a cursor. The first pass is long (the hook re-adds liquidity
        on every swap in its compounding mode, so the tape is hundreds of
        thousands of events a day) and is allowed to span several runs; after it,
        a run reads a few hours. Each pool is valued at its last swap price seen
        by the census scans (kept as a map across runs), or at its initial price
        if it has never traded -- a pool that never traded holds no stock anyway,
        since launches seed the launched token alone. */
  let longTvl = null;
  const poolStock = [];   // every valued LONG pool's stock leg, for the backing table below
  if (allStockPools.size) {
    const t4 = Date.now();
    const longIds = new Set([...allStockPools].filter(([, e]) => e.long).map(([id]) => id));
    let LS = store && store.get("rwaLadderStream");
    if (!LS || LS.v !== 1) LS = { v: 1, cursor: GENESIS_BLOCK - 1, ladders: {}, lastSqrt: {}, events: 0 };
    /* Prices: the newest Swap per pool from this run's census window, layered over the map. */
    if (opts.swaps?.last) for (const [id, l] of opts.swaps.last) if (longIds.has(id)) LS.lastSqrt[id] = decodeSwap(l).sqrtPriceX96.toString();
    const from = LS.cursor + 1;
    let seen = 0;
    if (from <= latest && timeLeft()) {
      const r = await getLogsRange({ address: POOL_MANAGER, topics: [TOPICS.MODIFY_LIQUIDITY] }, from, latest, {
        chunk: 200_000, deadline: opts.deadline,
        onLogs: (logs) => {
          for (const l of logs) {
            const id = l.topics[1]; if (!longIds.has(id)) continue;
            const m = decodeModifyLiquidity(l);
            const lad = (LS.ladders[id] ||= {});
            lad[m.tickLower] = (BigInt(lad[m.tickLower] || 0) + m.liquidityDelta).toString();
            lad[m.tickUpper] = (BigInt(lad[m.tickUpper] || 0) - m.liquidityDelta).toString();
            seen++;
          }
        },
      });
      LS.cursor = r.reachedBlock ?? latest;
      LS.partial = !!r.truncated;
      LS.events += seen;
      /* Ticks that net to zero are closed positions; dropping them keeps the store small. */
      for (const [id, lad] of Object.entries(LS.ladders)) { for (const [t, v] of Object.entries(lad)) if (v === "0") delete lad[t]; if (!Object.keys(lad).length) delete LS.ladders[id]; }
    }
    if (store) store.set("rwaLadderStream", LS);

    const perToken = {};
    let usd = 0, valued = 0, unpriced = 0, withLiquidity = 0;
    for (const [id, lad] of Object.entries(LS.ladders)) {
      const e = allStockPools.get(id); if (!e) continue;
      withLiquidity++;
      const sq = LS.lastSqrt[id] ?? e.p0; if (!sq) { unpriced++; continue; }
      const sqrtP = Number(BigInt(sq)) / 2 ** 96; if (!(sqrtP > 0)) { unpriced++; continue; }
      const { a0, a1 } = ladderRawAmounts(lad, sqrtP);
      let counted = false;
      for (const { token, side } of e.stocks) {
        const amt = (side === 0 ? a0 : a1) / 10 ** (decimals.get(token) ?? 18);
        const px = anchorUsd.get(token); if (!px || !(amt > 0)) continue;
        usd += amt * px; perToken[sym(token)] = (perToken[sym(token)] || 0) + amt * px; counted = true;
        poolStock.push({ id, token, side, units: amt, usd: amt * px, sqrtP });
      }
      if (counted) valued++;
    }
    /* Graduated pools: assets migrated off v4 whose numeraire is a stock token. The
       v2/v3 pool holds its own tokens, so its balance IS its inventory. One multicall. */
    const grads = Object.entries(reg.migrations).map(([asset, m]) => ({ asset, pool: m.pool, numeraire: reg.launches[asset]?.numeraire })).filter((g) => g.numeraire && stockSet.has(g.numeraire));
    let graduatedUsd = 0, graduatedPools = 0;
    if (grads.length) {
      const res = await multicall(grads.map((g) => ({ to: g.numeraire, data: BALANCE_SEL + g.pool.slice(2).padStart(64, "0") })));
      grads.forEach((g, i) => {
        const amt = res[i] && res[i] !== "0x" ? fmtUnits(BigInt(res[i]), decimals.get(g.numeraire) ?? 18) : 0;
        const px = anchorUsd.get(g.numeraire); if (!px || !(amt > 0)) return;
        graduatedUsd += amt * px; perToken[sym(g.numeraire)] = (perToken[sym(g.numeraire)] || 0) + amt * px; graduatedPools++;
      });
    }
    const span = latest - GENESIS_BLOCK + 1;
    longTvl = {
      usd: Math.round(usd + graduatedUsd), v4Usd: Math.round(usd), graduatedUsd: Math.round(graduatedUsd),
      pools: valued, poolsWithLiquidity: withLiquidity, poolsUnpriced: unpriced, longStockPools: longIds.size,
      graduatedPools, graduatedCandidates: grads.length, launches: launched.size, migrations: Object.keys(reg.migrations).length, registryPartial: !!reg.partial,
      backfilledTo: LS.cursor, complete: !LS.partial && LS.cursor >= latest, backfillShare: Math.min(1, (LS.cursor - GENESIS_BLOCK + 1) / span),
      events: LS.events,
      perToken: Object.fromEntries(Object.entries(perToken).map(([k, v]) => [k, Math.round(v)]).sort((a, b) => b[1] - a[1])),
      method: "LONG's Dune definition: launches from the factories' LaunchCreated, v4 pools valued from their position ladders, graduated pools (Airlock.Migrate) by balance",
    };
    log(`  stock inventory in LONG pools: $${Math.round(usd).toLocaleString()} in v4 across ${valued} pools with stock (${withLiquidity} with liquidity of ${longIds.size}) + $${Math.round(graduatedUsd).toLocaleString()} in ${graduatedPools} graduated pools (${launched.size} launches, ${Object.keys(reg.migrations).length} migrations); ladder stream at block ${LS.cursor.toLocaleString()} (${(100 * longTvl.backfillShare).toFixed(1)}% of history${LS.partial ? ", resumes" : ""}), ${seen.toLocaleString()} events this run, ${secs(t4)}`);
  }

  /* 4b'. Stock backing per pair. For the LONG pools holding the most stock, the
        launched token behind each pool (from the census, which carries both
        currencies), that token's market cap (its own totalSupply at the pool's last
        price, in stock, times the stock's Chainlink price), the stock inside its pools,
        that stock as a share of the whole tokenized supply, and the last day's user
        volume through the pools. Everything here is already measured above; this
        joins it per pair so the pairs can be ranked by how much real stock stands
        behind each dollar of market cap. */
  let backing = null;
  if (longTvl && poolStock.length) {
    const t5 = Date.now();
    const census = new Map(pools.map((p) => [p.id, p]));
    const top = poolStock.sort((a, b) => b.usd - a.usd).slice(0, 80);
    const byAsset = new Map(); let unknown = 0;
    for (const p of top) {
      const c = census.get(p.id); if (!c) { unknown++; continue; }
      const asset = p.side === 0 ? c.c1 : c.c0;
      const r = byAsset.get(asset) || { asset, pools: [], stockUsd: 0 };
      r.pools.push(p); r.stockUsd += p.usd; byAsset.set(asset, r);
    }
    const assets = [...byAsset.keys()];
    const meta = assets.length ? await resolveTokens(assets) : new Map();
    const sup = assets.length ? await multicall(assets.map((a) => ({ to: a, data: SUPPLY_SEL }))) : [];
    const supplyOf = new Map(tokens.map((t) => [t.token, t.supply]));
    const rows = [];
    assets.forEach((a, i) => {
      const r = byAsset.get(a), m = meta.get(a), dec = m?.decimals ?? 18;
      const supply = sup[i] && sup[i] !== "0x" ? fmtUnits(BigInt(sup[i]), dec) : 0;
      const main = r.pools.sort((x, y) => y.usd - x.usd)[0];
      const sdec = decimals.get(main.token) ?? 18, px = anchorUsd.get(main.token);
      /* sqrtP squared is token1 per token0 in raw units; scale to whole units, then
         read the asset's price in the stock from whichever side it sits on. */
      const stockIs0 = main.side === 0;
      const p1per0 = main.sqrtP * main.sqrtP * 10 ** ((stockIs0 ? sdec : dec) - (stockIs0 ? dec : sdec));
      const assetInStock = stockIs0 ? (p1per0 > 0 ? 1 / p1per0 : 0) : p1per0;
      const priceUsd = px && assetInStock > 0 ? assetInStock * px : null;
      const mcapUsd = priceUsd && supply > 0 ? priceUsd * supply : null;
      const anchorUnits = r.pools.filter((q) => q.token === main.token).reduce((s, q) => s + q.units, 0);
      const stockSupply = supplyOf.get(main.token) || 0;
      rows.push({
        asset: a, symbol: m?.symbol || a.slice(0, 8), anchor: main.token, anchorSymbol: sym(main.token), pools: r.pools.length, poolId: main.id,
        stockUsd: Math.round(r.stockUsd), stockUnits: +anchorUnits.toFixed(4), stockShare: stockSupply > 0 ? anchorUnits / stockSupply : null,
        supply: +supply.toFixed(2), priceUsd, mcapUsd: mcapUsd == null ? null : Math.round(mcapUsd),
        backing: mcapUsd > 0 ? r.stockUsd / mcapUsd : null,
        vol24hUsd: Math.round(r.pools.reduce((s, q) => s + (swapShare?.perPool?.[q.id] || 0), 0)),
      });
    });
    rows.sort((a, b) => b.stockUsd - a.stockUsd);
    backing = { rows, poolsConsidered: top.length, poolsWithoutCensus: unknown, windowHours: swapShare?.perPoolHours ?? swapShare?.windowHours ?? null, at: Math.floor(Date.now() / 1000),
      method: "stock per pool from the position replay; asset price from the pool's last swap price times the stock's Chainlink price; market cap from the asset's own totalSupply; volume from the hook's swap event, buyback legs excluded" };
    log(`  backing per pair: ${rows.length} pair(s) from the ${top.length} LONG pools holding the most stock${unknown ? ` (${unknown} not in the census)` : ""}; top ${rows.slice(0, 3).map((r) => `${r.symbol}/${r.anchorSymbol} $${r.stockUsd.toLocaleString()} behind $${(r.mcapUsd || 0).toLocaleString()}`).join(", ")}, ${secs(t5)}`);
  }

  /* 4c. Two histories since the chain went live, for the growth charts.
        (a) Every tracked stock token's flow through the pool manager, from its own
            Transfer logs: the running net is the stock in DEX liquidity on every
            venue; the gross, less legs whose counterparty is the hook or the
            buyback contract (fee legs, not trades), is the stock leg of every DEX
            trade -- chain-wide DEX stock volume without scanning the Swap tape.
            Legs whose counterparty is Rialto's router are tagged: Rialto fills that
            route into the pool manager appear in both streams and are netted.
        (b) Rialto's own fill event (topic2 token in, topic3 token out; data word 1
            amount in, word 4 amount out; the venue that is not a DEX).
        (c) LONG's side from the hook's per-swap event: the stock amount is LONG's
            stock volume (Dune's definition; buyback legs flagged), and its running
            pool-perspective sum is Dune's "stock held in LONG pools".
        Per day, per stock, in stock units; valued at today's prices when published
        (stated on the page). Every identified stock token is covered. Streamed
        and cursor-resumed; the first pass wants a deep run. The shared timemap
        starts at AI genesis (14 Jul); the chain's first block is 30 Apr, so a
        pre-genesis anchor set is built once and kept with the state. */
  let series = null;
  if (allStockPools.size && timeLeft()) {
    const t5 = Date.now();
    let F = store && store.get("rwaFlow");
    if (!F || F.v !== 3) F = { v: 3, anchors: null, tokens: {}, hook: { cursor: GENESIS_BLOCK - 1, days: {} }, rialto: { cursor: -1, days: {} } };
    if (!F.anchors) { const early = new TimeMap([]); await early.build(0, GENESIS_BLOCK, 250_000); F.anchors = early.toJSON(); }
    const tmx = new TimeMap([...F.anchors, ...tm.toJSON()]);
    const dayOf = (b) => tmx.dayBucket(b);
    /* Every identified stock token, priced or not (an unpriced one contributes no
       dollars but keeps its cursor). Tokens are streamed in address batches that
       share one cursor, so the tail of small stocks costs almost nothing beyond the
       big ones; a token first seen later starts from block 0 in its own batch. */
    const universe = [...stocks];
    const tracked = new Set(universe);
    const px = (tok) => anchorUsd.get(tok) || 0;
    const addDay = (map, d, key, field, v) => { const row = (map[d] ||= {}); const cell = (row[key] ||= {}); cell[field] = (cell[field] || 0) + v; };
    const byCursor = new Map();
    for (const tok of universe) {
      const st = (F.tokens[tok] ||= { cursor: -1, days: {} });
      if (st.cursor + 1 > latest) continue;
      (byCursor.get(st.cursor) || byCursor.set(st.cursor, []).get(st.cursor)).push(tok);
    }
    const BATCH = 25;
    /* LONG's own side first: the hook's swap event and Rialto's fills are bounded
       streams (a few million and well under a million logs) and they are the
       numerator, so they must not wait behind the stock streams. */
    if (timeLeft()) {
      const H = F.hook, from = H.cursor + 1;
      if (from <= latest) {
        const r = await getLogsRange({ address: LONG_HOOK, topics: [HOOK_SWAP] }, from, latest, { chunk: 100_000, deadline: opts.deadline,
          onLogs: (logs) => {
            for (const l of logs) {
              const e = allStockPools.get(l.topics[3]); if (!e) continue;
              const d = dayOf(parseInt(l.blockNumber, 16)); if (d == null) continue;
              const { token, side } = e.stocks[0], dec = decimals.get(token) ?? 18;
              const amt = int256(word(l.data, side === 0 ? 3 : 4));
              const units = fmtUnits(abs(amt), dec);
              addDay(H.days, d, token, "vol", units);
              if (topicAddr(l.topics[1]) !== LONG_BUYBACK) addDay(H.days, d, token, "volUser", units);
              addDay(H.days, d, token, "delta", fmtUnits(amt, dec));   // raw sign; the pool perspective is settled below
            }
          } });
        H.cursor = r.reachedBlock ?? latest; H.partial = !!r.truncated;
      }
    }
    /* LongX perps volume since launch, from the same hook event, kept in its own
       stream so the stock figures above never include it (a share-anchored pool is
       not a stock pool; a swap in one is not stock volume). */
    const perpPools = opts.perpPools || new Map();
    if (perpPools.size && timeLeft()) {
      /* Perps began on 31 Aug 2026, so the replay starts a little before that rather
         than at genesis, and it gets a bounded slice of what is left (measured: run
         to the deadline, it starved every stock stream and the liquidity history
         fell back to "backfilling" on the live site). The stock streams below take
         the rest. */
      const eraBlock = Math.max(GENESIS_BLOCK, tmx.blockAt(Date.UTC(2026, 7, 25) / 1000) ?? GENESIS_BLOCK);
      const P = (F.perps ||= { cursor: eraBlock - 1, days: {} });
      if (P.cursor < eraBlock - 1) P.cursor = eraBlock - 1;
      const from = P.cursor + 1;
      const perpsDeadline = Math.min(opts.deadline || Infinity, Date.now() + Math.min(600_000, 0.4 * ((opts.deadline || Date.now() + 600_000) - Date.now())));
      if (from <= latest) {
        const r = await getLogsRange({ address: LONG_HOOK, topics: [HOOK_SWAP] }, from, latest, { chunk: 100_000, deadline: perpsDeadline,
          onLogs: (logs) => {
            for (const l of logs) {
              const p = perpPools.get(l.topics[3]); if (!p) continue;
              const d = dayOf(parseInt(l.blockNumber, 16)); if (d == null) continue;
              const units = fmtUnits(abs(int256(word(l.data, p.side === 0 ? 3 : 4))), decimals.get(p.share) ?? 18);
              addDay(P.days, d, p.share, "vol", units);
              if (topicAddr(l.topics[1]) !== LONG_BUYBACK) addDay(P.days, d, p.share, "volUser", units);
            }
          } });
        P.cursor = r.reachedBlock ?? latest; P.partial = !!r.truncated;
      }
    }
    if (timeLeft()) {
      const Rl = F.rialto, from = Rl.cursor + 1;
      if (from <= latest) {
        const r = await getLogsRange({ address: RIALTO, topics: [RIALTO_FILL] }, from, latest, { chunk: 100_000, deadline: opts.deadline,
          onLogs: (logs) => {
            for (const l of logs) {
              if (l.topics.length < 4) continue;
              const a = topicAddr(l.topics[2]), b = topicAddr(l.topics[3]);
              const stock = tracked.has(a) ? a : tracked.has(b) ? b : null; if (!stock) continue;
              const d = dayOf(parseInt(l.blockNumber, 16)); if (d == null) continue;
              addDay(Rl.days, d, stock, "vol", fmtUnits(BigInt("0x" + word(l.data, stock === a ? 1 : 4)), decimals.get(stock) ?? 18));
            }
          } });
        Rl.cursor = r.reachedBlock ?? latest; Rl.partial = !!r.truncated;
      }
    }
    /* The stock streams are the heavy part (every stock swap on the chain moves a
       stock leg through the manager: tens of millions of logs since April), so they
       run last, in lock-stepped sub-ranges that commit as they go -- an inbound leg
       and its outbound leg over the same blocks, cursor advanced after each pair,
       so a deadline loses at most one sub-range -- and each batch gets a fair slice
       of what is left so every stock advances each run rather than the first batch
       taking the whole budget (measured: one batch ate 2,400s and kept nothing). */
    /* Batches run four at a time (the RPC layer has no serialising queue and the
       provider takes parallel log queries), the heaviest stocks each on their own,
       so the NVDA-sized streams no longer wait behind or starve the small ones.
       Measured before this: one run finished 60 small stocks worth 1% of DEX value
       while the heavy batch, given a quarter of the time, barely moved. */
    const HEAVY = 6, WORKERS = 4;
    const batches = [];
    for (const [cursor, toks] of [...byCursor.entries()].sort((a, b) => b[0] - a[0])) {
      const ordered = toks.slice().sort((x, y) => (dexRaw(y) > dexRaw(x) ? 1 : dexRaw(y) < dexRaw(x) ? -1 : 0));
      const heavy = ordered.slice(0, HEAVY), rest = ordered.slice(HEAVY);
      for (const tok of heavy) batches.push({ cursor, batch: [tok] });
      for (let i = 0; i < rest.length; i += BATCH) batches.push({ cursor, batch: rest.slice(i, i + BATCH) });
    }
    const STEP = 1_500_000, flowDeadline = opts.deadline || Date.now() + 3_600_000;
    const runBatch = async ({ cursor, batch }) => {
      const sliceEnd = flowDeadline;
      const fold = (sign) => (logs) => {
        for (const l of logs) {
          const tok = l.address.toLowerCase(), st = F.tokens[tok]; if (!st) continue;
          const t = decodeTransfer(l); if (t.from === t.to) continue;
          const d = dayOf(t.block); if (d == null) continue;
          const v = fmtUnits(t.value, decimals.get(tok) ?? 18), cp = sign > 0 ? t.from : t.to;
          addDay(st.days, d, "x", "net", sign * v); addDay(st.days, d, "x", "gross", v);
          if (RIALTO_ROUTERS.has(cp)) addDay(st.days, d, "x", "rialto", v);
          else if (cp === LONG_BUYBACK || cp === LONG_HOOK) addDay(st.days, d, "x", "fee", v);
        }
      };
      let lo = cursor + 1, stopped = false;
      while (lo <= latest && Date.now() < sliceEnd) {
        const hi = Math.min(latest, lo + STEP - 1);
        const snapshot = Object.fromEntries(batch.map((tok) => [tok, JSON.stringify(F.tokens[tok].days)]));
        const rIn = await getLogsRange({ address: batch, topics: [TOPICS.TRANSFER, null, padAddr(POOL_MANAGER)] }, lo, hi, { deadline: sliceEnd, onLogs: fold(1), chunk: 200_000 });
        const reach = rIn.reachedBlock ?? hi;
        let ok = reach >= lo;
        if (ok) {
          const rOut = await getLogsRange({ address: batch, topics: [TOPICS.TRANSFER, padAddr(POOL_MANAGER), null] }, lo, reach, { deadline: sliceEnd + 90_000, onLogs: fold(-1), chunk: 200_000 });
          ok = !rOut.truncated;
        }
        if (!ok) { for (const tok of batch) F.tokens[tok].days = JSON.parse(snapshot[tok]); stopped = true; break; }
        for (const tok of batch) F.tokens[tok].cursor = reach;
        lo = reach + 1;
        if (rIn.truncated) { stopped = true; break; }
      }
      for (const tok of batch) F.tokens[tok].partial = stopped || F.tokens[tok].cursor < latest;
    };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(WORKERS, batches.length) }, async () => {
      while (next < batches.length && timeLeft()) await runBatch(batches[next++]);
    }));
    if (store) store.set("rwaFlow", F);

    /* Publish. Which sign of the hook's amount is the pool's gain is settled by the
       data: pools cannot hold negative stock, so the running sum across every
       tracked stock is positive under the right sign. */
    let rawSum = 0;
    for (const row of Object.values(F.hook.days)) for (const [tok, c] of Object.entries(row)) rawSum += (c.delta || 0) * px(tok);
    const poolSign = rawSum < 0 ? -1 : 1;
    const dayKeys = new Set();
    for (const st of Object.values(F.tokens)) for (const d of Object.keys(st.days)) dayKeys.add(Number(d));
    for (const d of Object.keys(F.hook.days)) dayKeys.add(Number(d));
    for (const d of Object.keys(F.rialto.days)) dayKeys.add(Number(d));
    const today = tm.dayBucket(latest);
    const days = [...dayKeys].filter((d) => d < today).sort((a, b) => a - b);   // complete days only
    /* Only stocks whose transfer stream has reached the head enter the per-day
       series (both sides, so numerator and denominator cover the same stocks); the
       coverage figure says how much of today's DEX stock value that is. LONG's
       all-stock volume is the exception: the hook stream is complete on its own. */
    const complete = (a) => F.tokens[a]?.cursor === latest && !F.tokens[a]?.partial;
    const covered = new Set(universe.filter(complete));
    const cumAll = {}, cumLong = {};
    const rows = days.map((d) => {
      let allInv = 0, dexVol = 0, feeLegs = 0, rialtoDex = 0, longInv = 0, longVol = 0, longUser = 0, longAllUser = 0, rialtoVol = 0;
      for (const [tok, st] of Object.entries(F.tokens)) {
        if (!covered.has(tok)) continue;
        const c = st.days[d]?.x; if (!c) continue;
        cumAll[tok] = (cumAll[tok] || 0) + c.net; dexVol += c.gross * px(tok); feeLegs += (c.fee || 0) * px(tok); rialtoDex += (c.rialto || 0) * px(tok);
      }
      for (const tok of Object.keys(cumAll)) allInv += Math.max(0, cumAll[tok]) * px(tok);
      for (const [tok, c] of Object.entries(F.hook.days[d] || {})) {
        cumLong[tok] = (cumLong[tok] || 0) + poolSign * (c.delta || 0);
        longAllUser += (c.volUser || 0) * px(tok);
        if (covered.has(tok)) { longVol += (c.vol || 0) * px(tok); longUser += (c.volUser || 0) * px(tok); }
      }
      for (const tok of Object.keys(cumLong)) if (covered.has(tok)) longInv += Math.max(0, cumLong[tok]) * px(tok);
      for (const [tok, c] of Object.entries(F.rialto.days[d] || {})) if (covered.has(tok)) rialtoVol += (c.vol || 0) * px(tok);
      const dexUser = Math.max(0, dexVol - feeLegs);                 // trades only: the hook's and buyback's fee legs are not volume
      const rialtoOnly = Math.max(0, rialtoVol - rialtoDex);         // fills Rialto settled itself, not the ones it routed into the pools
      /* Transfer-basis volume counts stock entering or leaving the manager. Under v4
         flash accounting a multi-hop route that hands a stock from one pool to the
         next inside the manager moves no token, so those legs are absent here while
         the hook's event still records them; the share is therefore an upper bound
         and is capped at one. */
      const R = (v) => Math.round(v);
      return { t: d, allInvUsd: R(allInv), longInvUsd: R(longInv), dexVolUsd: R(dexUser), rialtoVolUsd: R(rialtoOnly), allVolUsd: R(dexUser + rialtoOnly),
        longVolUsd: R(longUser), longGrossVolUsd: R(longVol), longAllVolUsd: R(longAllUser),
        shareDex: dexUser > 0 ? Math.min(1, longUser / dexUser) : null, shareAll: dexUser + rialtoOnly > 0 ? Math.min(1, longUser / (dexUser + rialtoOnly)) : null };
    });
    /* Perps volume since launch rides on its own stream (F.perps), keyed by share. */
    for (const r of rows) { let v = 0, u = 0; for (const [tok, c] of Object.entries(F.perps?.days?.[r.t] || {})) { v += (c.vol || 0) * px(tok); u += (c.volUser || 0) * px(tok); } r.perpVolUsd = Math.round(v); r.perpUserVolUsd = Math.round(u); }
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const last7 = rows.slice(-7);
    const coveredUsd = universe.filter(complete).reduce((s, a) => s + Number(dexRaw(a)) / 10 ** (decimals.get(a) ?? 18) * px(a), 0);
    const totalDexUsd = universe.reduce((s, a) => s + Number(dexRaw(a)) / 10 ** (decimals.get(a) ?? 18) * px(a), 0);
    /* Reconcile at the stream's own block: the balances read at the top of the run
       are at the head, which on a forty-minute deep run is thousands of trades later
       than the snapshot block the streams stop at, so every liquid stock disagreed
       in both directions. One archive multicall at `latest` compares like with like. */
    /* The drawn series stop at yesterday, but the balance at `latest` includes
       today's trading, so the running net for the comparison takes today's bucket
       too (measured: without it every liquid stock was off by a day's flow). */
    const cumFull = { ...cumAll };
    for (const [tok, st] of Object.entries(F.tokens)) { if (!covered.has(tok)) continue; const c = st.days[today]?.x; if (c) cumFull[tok] = (cumFull[tok] || 0) + c.net; }
    const recTokens = universe.filter((a) => px(a) > 0 && complete(a));
    const atLatest = recTokens.length ? await multicall(recTokens.map((a) => ({ to: a, data: BALANCE_SEL + POOL_MANAGER.slice(2).padStart(64, "0") })), { blockTag: "0x" + latest.toString(16) }).catch(() => null) : [];
    const reconcile = recTokens.map((a, i) => { const h = atLatest?.[i]; const bal = h && h !== "0x" ? Number(BigInt(h)) / 10 ** (decimals.get(a) ?? 18) : Number(dexRaw(a)) / 10 ** (decimals.get(a) ?? 18);
      return { symbol: sym(a), cumNet: Math.round((cumFull[a] || 0) * 1e4) / 1e4, onChain: Math.round(bal * 1e4) / 1e4, atBlock: h && h !== "0x" ? latest : "head", complete: true }; });
    series = {
      days: rows, stocks: universe.length, priced: universe.filter((a) => px(a) > 0).length, since: rows[0]?.t ?? null,
      coverage: totalDexUsd > 0 ? coveredUsd / totalDexUsd : null,   // share of today's DEX stock value whose stream has reached the head
      tokensPartial: universe.filter((a) => !complete(a)).map((a) => sym(a)),
      hookCursor: F.hook.cursor, hookPartial: !!F.hook.partial, rialtoCursor: F.rialto.cursor, rialtoPartial: !!F.rialto.partial, poolSign,
      reconcile, pricedAt: "today",
      totals: { dexVolUsd: sum("dexVolUsd"), rialtoVolUsd: sum("rialtoVolUsd"), allVolUsd: sum("allVolUsd"), longVolUsd: sum("longVolUsd"), longAllVolUsd: sum("longAllVolUsd"),
        shareDex: sum("dexVolUsd") > 0 ? Math.min(1, sum("longVolUsd") / sum("dexVolUsd")) : null, shareAll: sum("allVolUsd") > 0 ? Math.min(1, sum("longVolUsd") / sum("allVolUsd")) : null,
        shareDex7d: last7.reduce((s, r) => s + r.dexVolUsd, 0) > 0 ? Math.min(1, last7.reduce((s, r) => s + r.longVolUsd, 0) / last7.reduce((s, r) => s + r.dexVolUsd, 0)) : null,
        covered: covered.size, perpVolUsd: sum("perpVolUsd"), perpUserVolUsd: sum("perpUserVolUsd"), perpsPartial: !!F.perps?.partial, perpsSince: F.perps ? (rows.find((r) => r.perpVolUsd > 0)?.t ?? null) : null },
      note: "per-day series cover the stock tokens whose transfer stream has reached the head (coverage = their share of DEX stock value); LONG all-stock volume is complete on its own; LONG figures follow Dune's definition (hook swap event; buyback legs excluded from volume, included in held); transfer-basis volume shares are upper bounds (intra-manager hops move no token); all values at today's prices",
    };
    log(`  flow histories: ${rows.length} complete day(s) since ${rows[0] ? new Date(rows[0].t * 1000).toISOString().slice(0, 10) : "none"}, ${universe.length} stock tokens (streams at the head for ${series.coverage ? (100 * series.coverage).toFixed(0) : "?"}% of DEX stock value), hook at ${F.hook.cursor.toLocaleString()}${F.hook.partial ? " (resumes)" : ""}, Rialto at ${F.rialto.cursor.toLocaleString()}${F.rialto.partial ? " (resumes)" : ""}, ${series.tokensPartial.length} token stream(s) still catching up, pool sign ${poolSign}, ${secs(t5)}`);
  }

  /* 5. Totals over the priced set only: an unpriced token contributes no dollars,
        and mixing a token count with a dollar share would be meaningless. */
  const priced = tokens.filter((t) => t.priceUsd);
  const totals = {
    stocks: tokens.length, priced: priced.length, listed: tokens.filter((t) => t.listed).length,
    activeStocks: tokens.filter((t) => t.activeTransfers > 0).length,
    activeListed: tokens.filter((t) => t.activeTransfers > 0 && t.listed).length,
    supplyUsd: priced.reduce((s, t) => s + t.supplyUsd, 0),
    dexUsd: priced.reduce((s, t) => s + t.dexUsd, 0),
    vaultUsd: priced.reduce((s, t) => s + t.vaultUsd, 0),
    poolsAll: allStockPools.size,
    poolsLong: [...allStockPools.values()].filter((p) => p.long).length,
    cataloguePartial: tokens.some((t) => t.poolsPartial),
  };
  totals.share = totals.supplyUsd > 0 ? (totals.dexUsd + totals.vaultUsd) / totals.supplyUsd : null;
  totals.longUsd = longTvl ? longTvl.usd : null;
  totals.longShare = longTvl && totals.supplyUsd > 0 ? (longTvl.usd + totals.vaultUsd) / totals.supplyUsd : null;

  /* 6. Daily DEX inventory for the tracked stock, from transfers, so the trend
        exists from genesis rather than from today. Last, with whatever budget is
        left; it resumes. */
  const daily = {};
  const dexState = (store && store.get("rwaDex")) || {};
  for (const tok of DAILY_TRACKED) {
    if (!timeLeft()) { log(`  ${sym(tok)} DEX inventory: no budget left this run`); break; }
    const t3 = Date.now();
    const st = await dexInventoryDaily(tok, latest, tm, dexState[tok], { deadline: opts.deadline, decimals: decimals.get(tok) ?? 18 });
    dexState[tok] = st;
    let cum = 0;
    daily[tok] = Object.entries(st.byDay).map(([d, v]) => [Number(d), v]).sort((a, b) => a[0] - b[0])
      .map(([t, net]) => ({ t, net: +net.toFixed(4), cum: +(cum += net).toFixed(4) }));
    log(`  ${sym(tok)} DEX inventory: ${daily[tok].length} day(s) to block ${st.cursor.toLocaleString()}${st.partial ? " (budget; resumes next run)" : ""}, ${secs(t3)}`);
  }
  if (store) store.set("rwaDex", dexState);

  /* 7. History: one row per hour at most, 120 days deep. */
  const stamp = Math.floor(Date.now() / 1000);
  const hour = Math.floor(stamp / 3600) * 3600;
  const history = (opts.prior?.history || []).filter((h) => h.t !== hour).slice(-24 * 120);
  history.push({
    t: hour, share: totals.share, dexUsd: Math.round(totals.dexUsd), vaultUsd: Math.round(totals.vaultUsd), supplyUsd: Math.round(totals.supplyUsd),
    longUsd: totals.longUsd, longShare: totals.longShare,
    swapShare: swapShare?.share ?? null, usdShare: swapShare?.usdShare ?? null, duneShare: swapShare?.dune?.share ?? null, stockSwaps: swapShare?.stockSwaps ?? null, longSwaps: swapShare?.longSwaps ?? null,
    activeStocks: totals.activeStocks, activeListed: totals.activeListed,
    perToken: Object.fromEntries(tokens.map((t) => [t.symbol, [+t.supply.toFixed(2), +t.inDex.toFixed(2), +t.inVault.toFixed(2)]])),
  });
  history.sort((a, b) => a.t - b.t);

  return {
    updatedAt: stamp,
    classifier: { ...STOCK_CODE, event: STOCK_EVENT, note: "Robinhood tokenized-stock beacon proxy: same bytecode and beacon as NVDA; emits the stock transfer event" },
    minDegree: MIN_DEGREE,
    universe: { activeTokens: Object.keys(uni.active).length, samples: uni.samples, blocksSampled: uni.blocksSampled, partial: uni.partial },
    tokens, totals, swapShare, longTvl, backing, series, history,
    dailyTracked: Object.fromEntries(DAILY_TRACKED.map((t) => [t, sym(t)])),
    daily,
    dailyPartial: Object.fromEntries(DAILY_TRACKED.map((t) => [t, !!dexState[t]?.partial])),
  };
}
