import { rpc, getLogsRange, padAddr } from "../rpc.mjs";
import { POOL_MANAGER, COMMUNITY_VAULT, LONG_HOOK, AI, USDG, NVDA, GENESIS_BLOCK } from "../config.mjs";
import { TOPICS, decodeTransfer, decodeInitialize, decodeSwap, decodeModifyLiquidity, fmtUnits } from "../decode.mjs";
import { multicall, resolveTokens } from "../tokens.mjs";
import { ladderRawAmounts } from "./depth.mjs";

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
async function stockPools(token, latest, prior, opts) {
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
  if (opts.swaps?.counts && allStockPools.size) {
    const per = new Map();   // token → { all, long, usdAll, usdLong }
    let all = 0, long = 0, aiPaired = 0, usdAll = 0, usdLong = 0;
    for (const [id, n] of opts.swaps.counts) {
      const e = allStockPools.get(id); if (!e) continue;
      all += n; if (e.long) long += n;
      if (e.long && e.ai) aiPaired += n;
      const vol = opts.swaps.volume?.get(id);
      /* Dollar value of the pool's stock leg, from the first priced stock on it. */
      let usd = 0;
      for (const { token, side } of e.stocks) {
        const px = anchorUsd.get(token); if (!px || !vol) continue;
        usd = fmtUnits(vol[side], decimals.get(token) ?? 18) * px; break;
      }
      usdAll += usd; if (e.long) usdLong += usd;
      for (const { token } of e.stocks) {
        const r = per.get(token) || { all: 0, long: 0, usdAll: 0, usdLong: 0 };
        r.all += n; r.usdAll += usd; if (e.long) { r.long += n; r.usdLong += usd; } per.set(token, r);
      }
    }
    /* Dune's definition of LONG volume, alongside: the hook's own swap event (LONG v4
       pools only, sender = buyback contract flagged), plus graduated v2/v3 pools'
       own Swap events; and Dune's denominator, which adds Robinhood's Rialto venue
       (USDG-quoted) to the DEX's stock trading. All in the same census window. */
    const winFrom = Math.max(GENESIS_BLOCK, latest - opts.swaps.blocks + 1);
    let hookUsd = 0, hookUserUsd = 0, hookSwaps = 0, hookBuybackSwaps = 0, gradUsd = 0, gradSwaps = 0, rialtoUsd = 0;
    const rialtoTxs = new Set();
    if (timeLeft()) {
      const hl = await getLogsRange({ address: LONG_HOOK, topics: [HOOK_SWAP] }, winFrom, latest, { chunk: 20_000, deadline: opts.deadline });
      for (const l of hl) {
        const e = allStockPools.get(l.topics[3]); if (!e) continue;
        const a0 = int256(word(l.data, 3)), a1 = int256(word(l.data, 4));
        let usd = 0;
        for (const { token, side } of e.stocks) { const px = anchorUsd.get(token); if (!px) continue; usd = fmtUnits(abs(side === 0 ? a0 : a1), decimals.get(token) ?? 18) * px; break; }
        hookSwaps++; hookUsd += usd;
        if (topicAddr(l.topics[1]) === LONG_BUYBACK) hookBuybackSwaps++; else hookUserUsd += usd;
      }
      const gradPools = Object.entries(reg.migrations).map(([asset, m]) => ({ asset, pool: m.pool, numeraire: reg.launches[asset]?.numeraire })).filter((g) => g.numeraire && stockSet.has(g.numeraire));
      for (let i = 0; i < gradPools.length && timeLeft(); i += 200) {
        const part = gradPools.slice(i, i + 200);
        const byPool = new Map(part.map((g) => [g.pool, g]));
        const gl = await getLogsRange({ address: part.map((g) => g.pool), topics: [[V3_SWAP, V2_SWAP]] }, winFrom, latest, { chunk: 70_000, deadline: opts.deadline });
        for (const l of gl) {
          const g = byPool.get(l.address.toLowerCase()); if (!g) continue;
          const numIs0 = g.numeraire < g.asset;   // v4/v2/v3 all order currencies by address
          const dec = decimals.get(g.numeraire) ?? 18, px = anchorUsd.get(g.numeraire); if (!px) continue;
          let amt;
          if (l.topics[0] === V3_SWAP) amt = abs(int256(word(l.data, numIs0 ? 0 : 1)));
          else amt = BigInt("0x" + word(l.data, numIs0 ? 0 : 1)) + BigInt("0x" + word(l.data, numIs0 ? 2 : 3));   // amountIn + amountOut on the numeraire side
          gradSwaps++; gradUsd += fmtUnits(amt, dec) * px;
        }
      }
      if (timeLeft()) {
        for (const topics of [[TOPICS.TRANSFER, padAddr(RIALTO), null], [TOPICS.TRANSFER, null, padAddr(RIALTO)]]) {
          const rl = await getLogsRange({ address: USDG, topics }, winFrom, latest, { chunk: 70_000, deadline: opts.deadline });
          for (const l of rl) { if (rialtoTxs.has(l.transactionHash)) continue; rialtoTxs.add(l.transactionHash); rialtoUsd += fmtUnits(BigInt(l.data), 6); }
        }
      }
    }
    const longUsd = hookUsd + gradUsd;
    const denominatorUsd = usdAll + gradUsd + rialtoUsd;
    swapShare = {
      windowBlocks: opts.swaps.blocks, windowHours: +((opts.swaps.blocks / 845_649) * 24).toFixed(1),
      catalogueComplete: catalogued === stocks.length,
      truncated: !!opts.swaps.truncated, chainSwaps: opts.swaps.total ?? null,
      stockSwaps: all, longSwaps: long, aiPairedSwaps: aiPaired, share: all > 0 ? long / all : null,
      usdAll: Math.round(usdAll), usdLong: Math.round(usdLong), usdShare: usdAll > 0 ? usdLong / usdAll : null,
      /* Dune-equivalent figures */
      dune: {
        longUsd: Math.round(longUsd), longUserUsd: Math.round(hookUserUsd + gradUsd), hookSwaps, buybackSwaps: hookBuybackSwaps, graduatedUsd: Math.round(gradUsd), graduatedSwaps: gradSwaps,
        rialtoUsd: Math.round(rialtoUsd), rialtoTxs: rialtoTxs.size, denominatorUsd: Math.round(denominatorUsd),
        share: denominatorUsd > 0 ? longUsd / denominatorUsd : null,
      },
      perToken: [...per].map(([t, r]) => ({ token: t, symbol: sym(t), all: r.all, long: r.long, share: r.all ? r.long / r.all : null,
        usdAll: Math.round(r.usdAll), usdLong: Math.round(r.usdLong) })).sort((x, y) => y.usdAll - x.usdAll || y.all - x.all),
    };
    log(`  stock-token swaps in window: ${all.toLocaleString()}, ${long.toLocaleString()} through LONG pools (${all ? (100 * long / all).toFixed(1) : "—"}% by count, ${usdAll ? (100 * usdLong / usdAll).toFixed(1) : "—"}% by dollars); Dune method: LONG $${Math.round(longUsd).toLocaleString()} (${hookSwaps} hook swaps, ${hookBuybackSwaps} buyback, ${gradSwaps} graduated) of $${Math.round(denominatorUsd).toLocaleString()} incl. Rialto $${Math.round(rialtoUsd).toLocaleString()} → ${denominatorUsd ? (100 * longUsd / denominatorUsd).toFixed(1) : "—"}%`);
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
    tokens, totals, swapShare, longTvl, history,
    dailyTracked: Object.fromEntries(DAILY_TRACKED.map((t) => [t, sym(t)])),
    daily,
    dailyPartial: Object.fromEntries(DAILY_TRACKED.map((t) => [t, !!dexState[t]?.partial])),
  };
}
