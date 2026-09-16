/**
 * Uniswap v4 PoolKey math.
 *
 * On Robinhood Chain token pools pair with NATIVE ETH (currency 0x0), not WETH, and use vanilla
 * pools (hooks = 0x0) with the convention tickSpacing = fee / 50 (verified across the live
 * 0.3%/0.5%/3%/5%/10%/59% CASHCAT pools). poolId = keccak256(abi.encode(PoolKey)) — verified to
 * match DexScreener's poolId.
 *
 * NOT every chain allows the 0x0 native sentinel in a pool key. On Arc the native currency is
 * 18-dec USDC while the pool currency is the 6-dec ERC-20 predeploy, and Uniswap's own Arc
 * guidance is to REJECT 0x0 at API boundaries precisely because of that mismatch — a pool key
 * holding 0x0 there would be read with the wrong decimals by a factor of 1e12. So the profile
 * flag `venues.v4NativeCurrency` gates every native-currency pool key, and where it is false
 * every key is ERC-20/ERC-20 and every mint value is 0.
 */
import { ethers } from "ethers";
import { CHAIN } from "../profile.js";

/**
 * The zero address. It has TWO unrelated jobs in v4 and they must not be conflated:
 *   NATIVE   — the native-currency sentinel in a PoolKey currency slot (chain-gated, see below)
 *   NO_HOOKS — "this pool has no hook contract", true on every chain
 */
export const NATIVE = "0x0000000000000000000000000000000000000000";
export const NO_HOOKS = NATIVE;
const coder = ethers.AbiCoder.defaultAbiCoder();

/** May a PoolKey on this chain hold the native 0x0 sentinel? false on Arc. */
export function v4NativeCurrencyAllowed(): boolean {
  return CHAIN.venues.v4NativeCurrency;
}

/**
 * Is this pool-key currency the chain's native currency? ALWAYS false where the chain forbids the
 * sentinel, so the 18-vs-6 decimal branch simply cannot be taken on Arc: a stray 0x0 currency
 * there is treated as an unknown ERC-20 and the pool is skipped, instead of being valued as
 * 1e12× its real size.
 */
export function isNativeCurrency(addr: string): boolean {
  return v4NativeCurrencyAllowed() && !!addr && addr.toLowerCase() === NATIVE;
}

export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/** Robinhood launchers use tickSpacing = fee/50 (fee in hundredths of a bip). */
export function tickSpacingForFee(fee: number): number {
  return Math.max(1, Math.floor(fee / 50));
}

export function computePoolId(k: PoolKey): string {
  return ethers.keccak256(
    coder.encode(
      ["address", "address", "uint24", "int24", "address"],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

/** Sort two currencies by address (0x0 native, when allowed, therefore always sorts first). */
export function sortCurrencies(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/**
 * Vanilla PoolKey for a token paired with the NATIVE currency at a given fee.
 * Throws where the chain forbids the sentinel — building one there would produce a poolId that
 * addresses nothing, and any amount read against it would be off by the 18-vs-6 decimal factor.
 */
export function nativePoolKey(token: string, fee: number): PoolKey {
  if (!v4NativeCurrencyAllowed()) {
    throw new Error("chain ini nggak ngizinin currency native (0x0) di PoolKey v4 — pakai quote ERC-20.");
  }
  const t = ethers.getAddress(token);
  const [currency0, currency1] = sortCurrencies(NATIVE, t); // native (0x0) is currency0
  return { currency0, currency1, fee, tickSpacing: tickSpacingForFee(fee), hooks: NO_HOOKS };
}

/** Vanilla PoolKey for token paired with an ERC20 quote (WETH, USDG, USDC…) at a given fee. */
export function erc20PoolKey(token: string, quote: string, fee: number): PoolKey {
  const [currency0, currency1] = sortCurrencies(ethers.getAddress(token), ethers.getAddress(quote));
  return { currency0, currency1, fee, tickSpacing: tickSpacingForFee(fee), hooks: NO_HOOKS };
}

/** Fee tiers to probe. Ordered high→low so pickers can prefer high-fee (memecoin farming). */
export const V4_FEE_TIERS = [590000, 300000, 250000, 100000, 50000, 30000, 10000, 5000, 3000];
