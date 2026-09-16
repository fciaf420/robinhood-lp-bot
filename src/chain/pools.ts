/**
 * Pool discovery + state, and range math.
 *
 * All tick↔price conversions go through the Uniswap SDK (`Pool`, `tickToPrice`) so we
 * never hand-roll Math.pow(1.0001, tick) again — that was the source of the float
 * precision drift in the old build.
 */
import { ethers } from "ethers";
// @uniswap/v3-sdk ships CommonJS — under Node ESM its named exports aren't statically
// detected, so import the default and destructure the runtime values.
import v3 from "@uniswap/v3-sdk";
import type { Pool as PoolT } from "@uniswap/v3-sdk";
import type { Token } from "@uniswap/sdk-core";
const { Pool, tickToPrice, TickMath } = v3;
import { cfg, C } from "../config.js";
import { provider } from "./client.js";
import { FACTORY_ABI, POOL_ABI, ERC20_ABI } from "./abis.js";
import { sdkToken } from "./tokens.js";
import { stableAddr, stableDecimals, stableSym, hasWrapped, isWrappedNative } from "./currency.js";
import type { PoolInfo, MintMode } from "../types.js";

const LN_10001 = Math.log(1.0001);

/**
 * The chain's dollar quote asset — USDG on Robinhood, the 6-dec USDC ERC-20 predeploy on Arc.
 * Some tokens keep their v3 liquidity in token/stable, not token/WETH; on a chain with no
 * wrapped native (Arc) token/stable is the ONLY shape a pool can have.
 *
 * A module-level const is safe here: the profile is loaded (and validated) at import time, one per
 * process, and RH_CHAIN cannot change at runtime — so this address is fixed for the process's life
 * exactly like the hardcoded constant it replaced. Call stableAddr() instead where you want the
 * read to be obviously chain-derived at the call site.
 */
export const STABLE_QUOTE = stableAddr();
const STABLE_DECIMALS = stableDecimals();

/**
 * All WETH-paired pools for a token that actually have liquidity, ranked by depth.
 * Returns EMPTY on a chain with no wrapped native (Arc): a v3 pool can only hold ERC-20s, so
 * with no WETH9 there is nothing for a token to be native-paired WITH. Returning [] (instead of
 * querying the factory with the zero address) keeps every caller's "no pool → skip" branch.
 */
export async function findPools(tokenAddr: string): Promise<PoolInfo[]> {
  if (!hasWrapped()) return [];
  const token = ethers.getAddress(tokenAddr);
  const weth = ethers.getAddress(C.weth);
  const factories = [C.factory, ...C.extraV3Factories];
  const wc = new ethers.Contract(weth, ERC20_ABI, provider);
  const out: PoolInfo[] = [];
  const seen = new Set<string>(); // dedupe across factories

  for (const factoryAddr of factories) {
    const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
    for (const fee of cfg.lp.feeTiers) {
      const pool: string = await factory.getPool!(token, weth, fee).catch(() => ethers.ZeroAddress);
      if (pool === ethers.ZeroAddress) continue;
      const poolLower = pool.toLowerCase();
      if (seen.has(poolLower)) continue;
      seen.add(poolLower);
      const pc = new ethers.Contract(pool, POOL_ABI, provider);
      const [liq, t0] = await Promise.all([pc.liquidity!(), pc.token0!()]);
      if (liq === 0n) continue;
      const wbal: bigint = await wc.balanceOf!(pool).catch(() => 0n);
      out.push({
        pool,
        fee,
        liquidity: liq,
        token0: ethers.getAddress(t0),
        wethInPool: Number(ethers.formatEther(wbal)),
      });
    }
  }
  out.sort((a, b) => b.wethInPool - a.wethInPool);
  return out;
}

/**
 * All token/<stable> v3 pools with liquidity. The WETH-only `findPools` misses these — some
 * tokens (e.g. JACKET) keep their real v3 liquidity in a token/USDG pool, so without this the bot
 * shows "0 v3" for a token that actually has a live, deep v3 pool. On Arc this is the ONLY pool
 * shape that exists. Ranked by stable-side depth.
 */
export async function findStableQuotePools(tokenAddr: string): Promise<PoolInfo[]> {
  const token = ethers.getAddress(tokenAddr);
  const stable = ethers.getAddress(STABLE_QUOTE);
  if (token.toLowerCase() === stable.toLowerCase()) return [];
  const factories = [C.factory, ...C.extraV3Factories];
  const uc = new ethers.Contract(stable, ERC20_ABI, provider);
  const out: PoolInfo[] = [];
  const seen = new Set<string>(); // dedupe across factories
  for (const factoryAddr of factories) {
    const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
    for (const fee of cfg.lp.feeTiers) {
      const pool: string = await factory.getPool!(token, stable, fee).catch(() => ethers.ZeroAddress);
      if (pool === ethers.ZeroAddress) continue;
      const poolLower = pool.toLowerCase();
      if (seen.has(poolLower)) continue;
      seen.add(poolLower);
      const pc = new ethers.Contract(pool, POOL_ABI, provider);
      const [liq, t0] = await Promise.all([pc.liquidity!(), pc.token0!()]);
      if (liq === 0n) continue;
      const ubal: bigint = await uc.balanceOf!(pool).catch(() => 0n);
      out.push({
        pool,
        fee,
        liquidity: liq,
        token0: ethers.getAddress(t0),
        wethInPool: 0,
        quote: "usd",
        // field name kept (data files + telegram read it); the VALUE is the profile stable's
        // balance at the profile stable's decimals — 6 on both chains today, but read, not assumed.
        usdgInPool: Number(ethers.formatUnits(ubal, STABLE_DECIMALS)),
      });
    }
  }
  out.sort((a, b) => (b.usdgInPool ?? 0) - (a.usdgInPool ?? 0));
  return out;
}

/** Symbol of the chain's stable quote, for display ("USDG" | "USDC"). */
export function stableQuoteSym(): string {
  return stableSym();
}

/**
 * Quote-side depth of a pool, in whatever currency that pool is actually quoted in.
 *
 * This is NOT cosmetic: `wethInPool` is hardcoded to 0 for every row findStableQuotePools()
 * returns (the real depth lands in `usdgInPool`), so ranking on wethInPool alone made every
 * stable-quoted pool look bone dry. pickLpPool's `wethInPool > 0` filter then rejected all of
 * them, which on a chain where token/<stable> is the ONLY possible pool shape (Arc) meant auto-LP
 * reported "no pool found" for tokens with a deep, live v3 pool — the whole branch was dead.
 * Rows from findPools() carry no `quote`, so they still rank on wethInPool exactly as before.
 */
const quoteDepth = (p: PoolInfo): number => (p.quote === "usd" ? (p.usdgInPool ?? 0) : p.wethInPool);

/**
 * Choose which pool to LP into, honoring the fee focus (cfg.lp.minFeePpm / preferHighestFee).
 * Returns null when no pool meets the fee floor — auto-LP should then skip. Memecoin fee
 * income is thin at low tiers, so we prefer the highest eligible fee that still has depth.
 */
export function pickLpPool(pools: PoolInfo[]): PoolInfo | null {
  const eligible = pools.filter((p) => p.fee >= cfg.lp.minFeePpm && quoteDepth(p) > 0);
  if (!eligible.length) return null;
  eligible.sort((a, b) =>
    cfg.lp.preferHighestFee ? b.fee - a.fee || quoteDepth(b) - quoteDepth(a) : quoteDepth(b) - quoteDepth(a),
  );
  return eligible[0]!;
}

export interface PoolState {
  pool: string;
  sdkPool: PoolT;
  fee: number;
  tick: number;
  spacing: number;
  token0: string;
  token1: string;
  token0Sdk: Token;
  token1Sdk: Token;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  wethIsToken0: boolean;
}

/** Read a pool's live state and wrap it in an SDK `Pool`. */
export async function getPoolState(poolAddr: string): Promise<PoolState> {
  const pc = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const [slot0, spacing, token0, token1, fee, liquidity] = await Promise.all([
    pc.slot0!(),
    pc.tickSpacing!(),
    pc.token0!(),
    pc.token1!(),
    pc.fee!(),
    pc.liquidity!(),
  ]);
  const t0 = ethers.getAddress(token0);
  const t1 = ethers.getAddress(token1);
  const [token0Sdk, token1Sdk] = await Promise.all([sdkToken(t0), sdkToken(t1)]);
  const tick = Number(slot0.tick);
  const sdkPool = new Pool(
    token0Sdk,
    token1Sdk,
    Number(fee),
    slot0.sqrtPriceX96.toString(),
    liquidity.toString(),
    tick,
  );
  return {
    pool: poolAddr,
    sdkPool,
    fee: Number(fee),
    tick,
    spacing: Number(spacing),
    token0: t0,
    token1: t1,
    token0Sdk,
    token1Sdk,
    sqrtPriceX96: slot0.sqrtPriceX96,
    liquidity,
    // isWrappedNative() is FALSE on a chain with no WETH9, so this can never accidentally match
    // a zero-address currency (config.ts fills C.weth with 0x0 there). On a token/stable pool
    // neither side is wrapped native → false, and the stable branches below take over.
    wethIsToken0: isWrappedNative(t0),
  };
}

/**
 * MCAP (USD) of the non-quote token at a given tick. Uses SDK price math.
 * `natUsd` is the USD price of ONE NATIVE unit — pass nativeUsd(), not ethUsd(): on a chain whose
 * native currency is a dollar stable that is the constant 1, and a stale ether quote would scale
 * every market cap by ~4000×. (Parameter renamed only; the position is unchanged.)
 */
export function mcapAtTick(st: PoolState, tick: number, natUsd: number, supplyUi: number): number {
  const tokenSdk = st.wethIsToken0 ? st.token1Sdk : st.token0Sdk;
  const wethSdk = st.wethIsToken0 ? st.token0Sdk : st.token1Sdk;
  const clamped = Math.min(Math.max(tick, TickMath.MIN_TICK), TickMath.MAX_TICK);
  const priceInEth = Number(tickToPrice(tokenSdk, wethSdk, clamped).toSignificant(18));
  return priceInEth * natUsd * supplyUi;
}

/** Width of the range in ticks, from widthPct, snapped to the pool's spacing. */
export function widthInTicks(spacing: number): number {
  const raw = Math.log(1 + cfg.lp.widthPct / 100) / LN_10001;
  return Math.max(spacing, Math.round(raw / spacing) * spacing);
}

export interface ComputedRange {
  tickLower: number;
  tickUpper: number;
  swapFraction: number; // 0..1, only meaningful for inrange mode
}

/**
 * Ticks for a new position.
 *   single: range fully on ONE side of price (single-sided WETH), with a buffer so a
 *           moving price doesn't cross it before the tx lands.
 *   inrange: range straddles price → needs both tokens → we swap `swapFraction` of WETH.
 */
export function computeRange(st: PoolState, mode: MintMode, bufferSpacings = cfg.lp.rangeBufferSpacings): ComputedRange {
  const sp = st.spacing;
  const width = widthInTicks(sp);

  if (mode === "inrange") {
    const half = Math.max(sp, Math.round(width / 2 / sp) * sp);
    const anchor = Math.floor(st.tick / sp) * sp;
    const tickLower = anchor - half;
    const tickUpper = anchor + half;
    return { tickLower, tickUpper, swapFraction: swapFractionForRange(st, tickLower, tickUpper) };
  }

  let tickLower: number;
  let tickUpper: number;
  if (st.wethIsToken0) {
    tickLower = (Math.floor(st.tick / sp) + bufferSpacings) * sp;
    tickUpper = tickLower + width;
  } else {
    tickUpper = (Math.floor(st.tick / sp) - bufferSpacings + 1) * sp;
    tickLower = tickUpper - width;
  }
  return { tickLower, tickUpper, swapFraction: 0 };
}

/**
 * Fraction of WETH to swap into the token so a straddling range [tl,tu] fills fully.
 *   amount0 = L·(√B−√P)/(√P·√B)   amount1 = L·(√P−√A)
 * Denominate both in token0, take the counter-token share. Clamped to [0.02, 0.95].
 */
export function swapFractionForRange(st: PoolState, tickLower: number, tickUpper: number): number {
  const sP = Math.pow(1.0001, st.tick / 2);
  const sA = Math.pow(1.0001, tickLower / 2);
  const sB = Math.pow(1.0001, tickUpper / 2);
  if (sP <= sA) return st.wethIsToken0 ? 0 : 1;
  if (sP >= sB) return st.wethIsToken0 ? 1 : 0;
  const a0 = (sB - sP) / (sP * sB);
  const a1in0 = (sP - sA) / (sP * sP);
  const fracToken1 = a1in0 / (a0 + a1in0);
  const f = st.wethIsToken0 ? fracToken1 : 1 - fracToken1;
  return Math.min(0.95, Math.max(0.02, f));
}
