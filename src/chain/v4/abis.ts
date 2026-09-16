/** Uniswap v4 minimal ABIs (StateView reads, Quoter, PositionManager, PoolManager). */

export const STATEVIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getPositionInfo(bytes32 poolId, bytes32 positionId) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
] as const;

// V4Quoter uses a (PoolKey, zeroForOne, exactAmount, hookData) tuple.
export const V4QUOTER_ABI = [
  "function quoteExactInputSingle((( address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) returns (uint256 amountOut, uint256 gasEstimate)",
] as const;

// v4 PositionManager (read helpers used for listing/closing).
export const V4_POSM_ABI = [
  "function nextTokenId() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns (((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info))",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)",
  "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
] as const;

/**
 * Permit2 (canonical 0x0000…78BA3 on every chain). The v4 UniversalRouter NEVER pulls an ERC-20
 * with a plain allowance — it settles through Permit2, so an ERC-20 input needs TWO approvals:
 * token→Permit2 (a normal ERC-20 allowance) and Permit2→spender (this contract's own allowance).
 *
 * `allowance` is read, not assumed: a Permit2 grant carries a uint48 EXPIRATION, so re-approving
 * blindly costs a tx per swap while trusting a stale one reverts inside settle with an opaque
 * error. Reading it is the only way to tell those two apart.
 */
export const PERMIT2_ABI = [
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
] as const;

/** UniversalRouter entrypoint. `commands` 0x10 = V4_SWAP; the v4 action list lives in `inputs`. */
export const UNIVERSAL_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
] as const;
