/**
 * Uniswap v2 primitives. v2 pools are full-range constant-product (x*y=k) with a fixed 0.3% swap
 * fee; LP is a fungible ERC20 (the pair token). We drive add/remove at the pair level (mint/burn)
 * so no v2 Router address is required — the UniversalRouter routes v2 SWAPS but can't add/remove
 * liquidity.
 *
 * The bot's v2 support is WRAPPED-NATIVE-PAIRED ONLY (token/WETH): the zap, the ratio maths and
 * the close all assume a WETH side. A chain with no WETH9 (Arc) therefore has no v2 pair this
 * code can drive, and readV2Pool() returns null there rather than querying getPair(token, 0x0).
 */
import { ethers } from "ethers";
import { C } from "../../config.js";
import { provider } from "../client.js";
import { hasWrapped, isWrappedNative, natSym, fmtNat } from "../currency.js";

export const V2_FACTORY_ABI = ["function getPair(address,address) view returns (address)"] as const;

export const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function mint(address to) returns (uint256 liquidity)",
  "function burn(address to) returns (uint256 amount0, uint256 amount1)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
] as const;

export interface V2Pool {
  pair: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  wethIsToken0: boolean;
  wethReserve: bigint; // reserve of the wrapped-native side
  tokenReserve: bigint; // reserve of the token side
  wethInPool: number; // display (native-denominated depth of the wrapped-native side)
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function v2Factory(): ethers.Contract {
  if (!C.v2Factory) throw new Error("v2Factory belum diset di config.contracts");
  return new ethers.Contract(C.v2Factory, V2_FACTORY_ABI, provider);
}

export function pairContract(addr: string, runner: ethers.ContractRunner = provider): ethers.Contract {
  return new ethers.Contract(addr, V2_PAIR_ABI, runner);
}

/** The token/wrapped-native v2 pair address, or null if none exists (always null with no WETH9). */
export async function getPairAddress(token: string): Promise<string | null> {
  if (!hasWrapped()) return null; // nothing to pair against — see module header
  const a = await v2Factory().getPair!(ethers.getAddress(token), C.weth).catch(() => ZERO);
  return a && a !== ZERO ? (a as string) : null;
}

/** Why v2 is unavailable on this chain, for a user-facing message. */
export function v2UnsupportedReason(): string | null {
  return hasWrapped() ? null : `v2 di bot ini cuma pair wrapped-native; chain ini gak punya wrapped ${natSym()}`;
}

/** Read a token/WETH v2 pool state, or null if the pair doesn't exist / is empty. */
export async function readV2Pool(token: string): Promise<V2Pool | null> {
  const pair = await getPairAddress(token);
  if (!pair) return null;
  const c = pairContract(pair);
  const [reserves, t0, t1, ts] = await Promise.all([
    c.getReserves!(),
    c.token0!() as Promise<string>,
    c.token1!() as Promise<string>,
    c.totalSupply!() as Promise<bigint>,
  ]);
  const reserve0: bigint = reserves[0];
  const reserve1: bigint = reserves[1];
  const wethIsToken0 = isWrappedNative(t0);
  const wethReserve = wethIsToken0 ? reserve0 : reserve1;
  const tokenReserve = wethIsToken0 ? reserve1 : reserve0;
  if (wethReserve === 0n || tokenReserve === 0n) return null;
  return {
    pair,
    token0: t0,
    token1: t1,
    reserve0,
    reserve1,
    totalSupply: ts,
    wethIsToken0,
    wethReserve,
    tokenReserve,
    wethInPool: Number(fmtNat(wethReserve)),
  };
}

/** Uniswap v2 getAmountOut (0.3% fee). */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inWithFee = amountIn * 997n;
  return (inWithFee * reserveOut) / (reserveIn * 1000n + inWithFee);
}

/** Integer sqrt (Newton) for the zap formula. */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("sqrt of negative");
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Optimal amount of the input reserve token to swap when zapping a single asset into a v2
 * LP (accounts for the 0.3% fee). Given you hold `amountIn` of the asset whose reserve is
 * `reserveIn`, swap this much, then add the rest + what you receive.
 * s = (sqrt(rIn·(rIn·3988009 + amountIn·3988000)) − rIn·1997) / 1994
 */
export function zapSwapAmount(reserveIn: bigint, amountIn: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n) return 0n;
  const inner = reserveIn * (reserveIn * 3988009n + amountIn * 3988000n);
  const s = (isqrt(inner) - reserveIn * 1997n) / 1994n;
  return s < 0n ? 0n : s > amountIn ? amountIn : s;
}
