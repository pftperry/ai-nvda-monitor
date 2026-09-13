// Every address here was verified live against chain 4663 before being written down.
// See README "Verification log" for how each was established.

export const CHAIN_ID = 4663;

/* A dedicated endpoint, when one is configured, comes from the environment and
   never from this file: the URL carries the API key, and this repository and the
   site it builds are public. The chain's own endpoint stays as the fallback, so
   a provider outage degrades the refresh to slow rather than failing it. */
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

/* Read the secret forgivingly, and never let a bad one stop the indexer.
   The first real secret failed `new URL()` at import time, which killed every run
   before a single block was read. Pasted values arrive in a few shapes: the full
   URL, the URL wrapped in quotes or with stray whitespace, or just the Alchemy key.
   All of those are accepted. Anything else logs a warning -- without echoing the
   value, which is the key -- and the run continues on the public endpoint. */
function dedicatedEndpoint(raw) {
  if (!raw) return { url: null, problem: null };
  let v = String(raw).trim().replace(/^["']+|["']+$/g, "").trim();
  if (/^[A-Za-z0-9_-]{16,}$/.test(v)) v = `https://robinhood-mainnet.g.alchemy.com/v2/${v}`;   // a bare key
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http(s)");
    return { url: u.toString(), problem: null };
  } catch {
    return { url: null, problem: `RPC_URL is set but is not a usable URL or Alchemy key (${v.length} characters); using the public endpoint` };
  }
}
const dedicated = dedicatedEndpoint(process.env.RPC_URL);
if (dedicated.problem) console.log(process.env.GITHUB_ACTIONS ? `::warning::${dedicated.problem}` : `warning: ${dedicated.problem}`);
export const DEDICATED_RPC = !!dedicated.url;
export const RPCS = DEDICATED_RPC ? [dedicated.url, PUBLIC_RPC] : [PUBLIC_RPC];
/** Safe to publish: the host only, never the path, which is where a key lives. */
export const RPC_LABEL = new URL(RPCS[0]).host + (DEDICATED_RPC ? " (dedicated)" : " (public)");

/** Uniswap v4 singleton. All pool activity on the chain flows through this one address. */
export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

export const TOKENS = {
  AI:   { address: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18", symbol: "AI",   decimals: 18, genesisSupply: 1_000_000_000 },
  NVDA: { address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", symbol: "NVDA", decimals: 18 },
  // USDG is 6 decimals, NOT 18. Getting this wrong put every USDG-denominated
  // price out by a factor of 10^12 (AI showed as 2.7e-13 rather than ~0.27), and
  // because curated entries outrank the on-chain lookup the mistake overrode the
  // correct value silently. assertTokenMetadata() now checks these against the
  // chain on every run so a hardcoded constant can never quietly lie again.
  USDG: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG", decimals: 6 },
  WETH: { address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", symbol: "WETH", decimals: 18 },
  // v4 represents native ETH as the zero address. Without this it resolves to no
  // symbol and renders as "0x000000", which reads like an unnamed dust token
  // rather than the second-largest venue for AI.
  ETH:  { address: "0x0000000000000000000000000000000000000000", symbol: "ETH",  decimals: 18 },
};

export const AI = TOKENS.AI.address;
export const NVDA = TOKENS.NVDA.address;
export const USDG = TOKENS.USDG.address;

/**
 * The LONG launchpad hook. Holds the dynamic-fee logic for every LONG pool.
 * Hook permission bits decoded from the address itself (low 14 bits = 0x2544):
 *   BEFORE_INITIALIZE, AFTER_ADD_LIQUIDITY, AFTER_REMOVE_LIQUIDITY,
 *   AFTER_SWAP, AFTER_SWAP_RETURNS_DELTA
 * AFTER_SWAP_RETURNS_DELTA is the mechanism by which it skims the 0.70% fee.
 */
export const LONG_HOOK = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";

/* Receives hook fees, then splits them atomically in the same tx (holds no balance).

   The published mechanics (artificialinu.com/how-it-works) and the chain agree,
   once you account for something the page leaves out:

     buys  -> fee paid in NVDA: 80% to the community vault, 20% to the receiver
     sells -> fee paid in AI:   "50% burned / 50% locked"

   Measured on chain the AI side is burn : lock : receiver = 1 : 1 : 0.5, i.e.
   40 / 40 / 20. Both reconcile if the 20% receiver cut is taken first on BOTH
   sides and the page's "50/50" describes the split of what remains. The measured
   figures are therefore the complete picture; the page states the simplified one.

   Two consequences that matter for interpretation:
     - AI-denominated fees come from SELLS only, so fee ÷ rate gives sell-side
       notional, not total volume.
     - Vault assets are explicitly not redeemable by holders: "holders cannot
       redeem assets from the Vault". It is backing, not a claim. */
export const FEE_SPLITTER = "0x4f6c50a87bf234c45191f88ed4cbb9f021b7dc67";

/** The community vault: permanently-locked AI + the accumulating NVDA hard reserve. */
export const COMMUNITY_VAULT = "0xd14d2eeb9648f53fa153a218eeed908789c28630";

/** LONG platform-fee recipient. Receives half the burn leg's size (2:2:1 split). */
export const PLATFORM_FEE_RECIPIENT = "0x4a0cb7eef4b4dc31c75eac705e03463cfc3c5cb2";

export const BURN_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The flagship pool. Created at block 9721433 (2026-07-14). Dynamic fee resolving to 7000 pips. */
export const AI_NVDA_POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
/** Deepest AI/USDG venue, per Dexscreener cross-check. */
export const AI_USDG_POOL = "0x7aebd80541bfaaf23dbb6e99ce13d4d31c1a84c91414f971eadbff7db5f85995";

/** First block of AI's existence; nothing before this is worth scanning. */
export const GENESIS_BLOCK = 9_721_433;

/** v4 dynamic-fee sentinel. A pool with this fee defers its rate to the hook per swap. */
export const DYNAMIC_FEE_FLAG = 0x800000;

/** Measured: 0.1022 s/block. Used only to size scan chunks, never to date an event. */
export const BLOCKS_PER_DAY = 845_649;

export const LIMITS = {
  maxLogsPerQuery: 10_000,   // hard server cap; scanner subdivides the block range on breach
  maxTopicsPerQuery: 1_000,  // hard server cap; measured: 993 passes, 1002 is rejected
  defaultChunk: 1_000_000,
  // The public endpoint throttles hard, eth_getLogs hardest; a paid one does not.
  politeDelayMs: DEDICATED_RPC ? 5 : 120,
  logsDelayMs: DEDICATED_RPC ? 40 : 1_200,
  // Wide log scans are legitimately slow, but nothing may hang forever.
  requestTimeoutMs: 90_000,
};

/**
 * The anchors on the LONG platform, and what kind of thing each one is.
 *
 * Discovered rather than assumed: every LONG-hook pool was counted and the tokens
 * appearing in hundreds of them are the anchors, while 18,340 of 18,442 tokens
 * appear in three pools or fewer. That degree gap is unambiguous and the platform
 * shape falls straight out of it -- roughly forty real-world assets, three quote
 * assets, and eighteen thousand memecoins matched against them.
 *
 * The list is curated even so, because the distinction that matters is semantic and
 * the chain cannot supply it. Degree alone cannot tell a stock from a memecoin that
 * became popular: AI appears in 1,083 pools, more than AAPL and TSLA combined, and
 * it is a dog coin anchored to NVDA. So the classification is written down where it
 * can be argued with, and the indexer reports any high-degree token missing from it
 * rather than silently reclassifying the platform underneath us.
 *
 * What counts as a launch follows directly: a pool with exactly one RWA side and a
 * counterparty that is neither an RWA nor a quote asset. AI/NVDA is a launch and AI
 * is the launched token; AAPL/USDG is a listing, not a launch; BONER/HIMS and
 * MOO/MCD are launches; anything paired against AI is an AI bridge, which this
 * project already tracks elsewhere.
 */
export const LAUNCHPAD = {
  /* Quote assets. A token paired only with these has been listed, not launched. */
  quotes: new Set([
    "0x0000000000000000000000000000000000000000",   // native ETH
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168",   // USDG
  ]),
  /* WETH by symbol, because the wrapper is a quote asset and omitting it was not a
     rounding error: it is the counterparty in 70,594 pools, so every one of those
     was being read as a launch against an unrecognised anchor. The self-audit caught
     it on the first full run, which is the entire reason that audit exists. */
  quoteSymbols: new Set(["WETH", "ETH", "USDG"]),
  /* Symbols of the real-world assets tokens get anchored to: equities, ETFs,
     commodities, pre-IPO exposure and the leveraged wrappers of those. Matched by
     symbol because the addresses are numerous and the symbols are what the platform
     itself displays. */
  rwaSymbols: new Set([
    "NVDA", "SPCX", "GOOGL", "AAPL", "TSLA", "SPY", "GME", "META", "DJT", "MSFT",
    "SGOV", "AMC", "GLD", "MSTR", "AMZN", "HOOD", "QQQ", "PLTR", "HIMS", "F",
    "COIN", "SHOP", "SNOW", "TTWO", "RDDT", "USO", "SNDK", "PFE", "RBLX", "LULU",
    "MCD", "MU", "OPENAI", "ANTHROPIC",
    /* Added by the self-audit, which reported them as high-degree tokens absent from
       this list on the first full census. Every one is an equity or an ETF, and the
       omission was mine from reading a forty-row sample. Their pools were being
       dropped from the launch count until they appeared here. */
    "NFLX", "COST", "AMD", "USAR", "SLV", "INTC", "MRNA", "BB", "BA", "UPS",
  ]),
  /* Leveraged and pre-IPO wrappers: NVDAx3L, OPENAIx1L, ANTHROPICx1L and friends.
     Still real-world exposure, so still an anchor rather than a launch. */
  rwaSuffix: /x\d+[LS]$/i,
  /* Degree at which a token is treated as an anchor for reporting purposes. Only
     used to flag anchors missing from the list above, never to classify silently. */
  anchorDegree: 40,
};
