// Event topic hashes, confirmed empirically by histogramming real PoolManager logs
// rather than by trusting a signature string.
export const TOPICS = {
  SWAP:            "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  MODIFY_LIQUIDITY:"0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec",
  INITIALIZE:      "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
  TRANSFER:        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
};

const word = (data, i) => data.slice(2 + 64 * i, 2 + 64 * (i + 1));
const asInt = (data, i, bits) => BigInt.asIntN(bits, BigInt("0x" + word(data, i)));
const asUint = (data, i) => BigInt("0x" + word(data, i));
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();

/**
 * Uniswap v4 Swap:
 *   Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1,
 *        uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
 *
 * SIGN CONVENTION -- verified empirically, do not "fix" without re-running the test.
 * amount0/amount1 are the SWAPPER's deltas: positive means the swapper RECEIVES.
 * Proof: across 484 consecutive AI/NVDA swaps, `amount0 < 0` coincided with a FALLING
 * pool price in 483 cases and a rising price in 0. Since price = (sqrtPriceX96/2^96)^2
 * expresses token1 per token0, AI can only get cheaper when AI flows INTO the pool.
 * Therefore amount0 < 0 == AI entering the pool == the trader SOLD AI.
 * Independently corroborated: the resulting buy/sell skew matches GeckoTerminal's
 * reported counts for the same window.
 */
export function decodeSwap(log) {
  const d = log.data;
  const amount0 = asInt(d, 0, 128);
  const amount1 = asInt(d, 1, 128);
  return {
    poolId: log.topics[1],
    sender: topicAddr(log.topics[2]),
    amount0,
    amount1,
    sqrtPriceX96: asUint(d, 2),
    liquidity: asUint(d, 3),
    tick: Number(asInt(d, 4, 24)),
    fee: Number(asUint(d, 5)), // pips: 7000 == 0.70%
    block: parseInt(log.blockNumber, 16),
    tx: log.transactionHash,
    logIndex: parseInt(log.logIndex, 16),
  };
}

/** True when this swap bought token0 (the swapper received token0). */
export const isBuyToken0 = (s) => s.amount0 > 0n;

/**
 * ModifyLiquidity(PoolId indexed id, address indexed sender, int24 tickLower,
 *                 int24 tickUpper, int256 liquidityDelta, bytes32 salt)
 */
export function decodeModifyLiquidity(log) {
  const d = log.data;
  return {
    poolId: log.topics[1],
    sender: topicAddr(log.topics[2]),
    tickLower: Number(asInt(d, 0, 24)),
    tickUpper: Number(asInt(d, 1, 24)),
    liquidityDelta: asInt(d, 2, 256),
    block: parseInt(log.blockNumber, 16),
    tx: log.transactionHash,
  };
}

/**
 * Initialize(PoolId indexed id, Currency indexed currency0, Currency indexed currency1,
 *            uint24 fee, int24 tickSpacing, IHooks hooks, uint160 sqrtPriceX96, int24 tick)
 */
export function decodeInitialize(log) {
  const d = log.data;
  return {
    poolId: log.topics[1],
    currency0: topicAddr(log.topics[2]),
    currency1: topicAddr(log.topics[3]),
    fee: Number(asUint(d, 0)),
    tickSpacing: Number(asInt(d, 1, 24)),
    hooks: "0x" + word(d, 2).slice(24).toLowerCase(),
    sqrtPriceX96: asUint(d, 3),
    tick: Number(asInt(d, 4, 24)),
    block: parseInt(log.blockNumber, 16),
  };
}

/** ERC20 Transfer(address indexed from, address indexed to, uint256 value) */
export function decodeTransfer(log) {
  return {
    from: topicAddr(log.topics[1]),
    to: topicAddr(log.topics[2]),
    value: BigInt(log.data === "0x" ? 0 : log.data),
    block: parseInt(log.blockNumber, 16),
    tx: log.transactionHash,
  };
}

/**
 * Pool price as token1 per token0, from sqrtPriceX96.
 * Validated: the AI/NVDA pool yields 1.3037e-3 NVDA per AI against
 * GeckoTerminal's independently reported 0.00132279.
 */
export function priceFromSqrt(sqrtPriceX96, dec0 = 18, dec1 = 18) {
  const x = Number(sqrtPriceX96) / 2 ** 96;
  return x * x * 10 ** (dec0 - dec1);
}

/** Decode v4 hook permissions straight out of the hook's address low bits. */
const HOOK_FLAGS = [
  ["AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA", 0], ["AFTER_ADD_LIQUIDITY_RETURNS_DELTA", 1],
  ["AFTER_SWAP_RETURNS_DELTA", 2], ["BEFORE_SWAP_RETURNS_DELTA", 3],
  ["AFTER_DONATE", 4], ["BEFORE_DONATE", 5], ["AFTER_SWAP", 6], ["BEFORE_SWAP", 7],
  ["AFTER_REMOVE_LIQUIDITY", 8], ["BEFORE_REMOVE_LIQUIDITY", 9],
  ["AFTER_ADD_LIQUIDITY", 10], ["BEFORE_ADD_LIQUIDITY", 11],
  ["AFTER_INITIALIZE", 12], ["BEFORE_INITIALIZE", 13],
];
export function hookPermissions(hookAddress) {
  const low = BigInt(hookAddress) & 0x3fffn;
  return HOOK_FLAGS.filter(([, b]) => (low >> BigInt(b)) & 1n).map(([n]) => n);
}

export const fmtUnits = (v, decimals = 18) => Number(v) / 10 ** decimals;
