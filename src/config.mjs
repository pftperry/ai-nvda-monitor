// Every address here was verified live against chain 4663 before being written down.
// See README "Verification log" for how each was established.

export const CHAIN_ID = 4663;

export const RPCS = [
  "https://rpc.mainnet.chain.robinhood.com",
];

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
  politeDelayMs: 120,
  // eth_getLogs is the scarce resource here; it gets its own, much slower floor.
  logsDelayMs: 1_200,
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
  /* Symbols of the real-world assets tokens get anchored to: equities, ETFs,
     commodities, pre-IPO exposure and the leveraged wrappers of those. Matched by
     symbol because the addresses are numerous and the symbols are what the platform
     itself displays. */
  rwaSymbols: new Set([
    "NVDA", "SPCX", "GOOGL", "AAPL", "TSLA", "SPY", "GME", "META", "DJT", "MSFT",
    "SGOV", "AMC", "GLD", "MSTR", "AMZN", "HOOD", "QQQ", "PLTR", "HIMS", "F",
    "COIN", "SHOP", "SNOW", "TTWO", "RDDT", "USO", "SNDK", "PFE", "RBLX", "LULU",
    "MCD", "MU", "OPENAI", "ANTHROPIC",
  ]),
  /* Leveraged and pre-IPO wrappers: NVDAx3L, OPENAIx1L, ANTHROPICx1L and friends.
     Still real-world exposure, so still an anchor rather than a launch. */
  rwaSuffix: /x\d+[LS]$/i,
  /* Degree at which a token is treated as an anchor for reporting purposes. Only
     used to flag anchors missing from the list above, never to classify silently. */
  anchorDegree: 40,
};
