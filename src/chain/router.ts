/**
 * ONE swap interface for the whole bot — quote here, execute here, and let the chain profile
 * decide WHICH venue actually runs.
 *
 * Why this exists: every "buy the token side before minting" path was hard-wired to the KyberSwap
 * aggregator with a single-pool v3 swap bolted on as a rescue. That is fine on Robinhood, where
 * Kyber indexes the chain. It is not a strategy on Arc, where the aggregator does not (yet) serve
 * the chain at all — but Uniswap does: v3 SwapRouter02 + Quoter, a UniversalRouter, a v4
 * PoolManager/Quoter, all deployed (see chains/arc.json). So the venue became a profile field
 * (`data.router`) and this module is the thing that reads it.
 *
 * Selection, and it is a FALLBACK CHAIN, never a single choice:
 *   data.router = "kyber"   (Robinhood) → kyber first, uniswap behind it   ← today's behaviour
 *   data.router = "uniswap" (Arc)       → uniswap first, kyber behind it IF the profile says the
 *                                         aggregator serves this chain (it doesn't, until
 *                                         `RH_CHAIN=arc npm run probe:arc` proves otherwise)
 * A failing venue is logged and skipped, never fatal. That includes a Kyber SECURITY-gate failure:
 * the gates reject the aggregator's calldata, and the correct response to "this calldata looks
 * wrong" is to go route the swap on-chain ourselves — not to abort an open half-way through.
 *
 * "uniswap" is itself a best-of: every cfg.lp.feeTiers v3 tier through the v3 Quoter, AND every
 * discovered v4 pool for the pair through the v4 Quoter, then execute on whichever quoted higher
 * (v3 → SwapRouter02.exactInputSingle, v4 → UniversalRouter V4_SWAP).
 *
 * NATIVE CURRENCY: this router deals in pool currencies. The native sentinel (0x0, or Kyber's
 * 0xEeee…) is accepted and forwarded to Kyber/v4, but the v3 leg REFUSES it — a v3 pool holds
 * ERC-20s, and on a chain with no wrapped native (Arc) there is no v3 route for native at all.
 * That is not a limitation, it is the chain: every Arc pool is token/USDC-ERC20, and native USDC
 * is 18-dec while the pool's USDC is 6-dec. Callers hold the ERC-20 quote, not the native one.
 */
import { ethers } from "ethers";
import { C, cfg } from "../config.js";
import { CHAIN } from "./profile.js";
import { wallet, provider, overrides } from "./client.js";
import { ERC20_ABI, QUOTER_ABI, ROUTER_ABI } from "./abis.js";
import { kyberSwap, kyberRoute, kyberEnabled, kyberPreferred, KYBER_NATIVE, BroadcastedSwapError, isBroadcasted } from "./kyber.js";
import { quoteV4, swapV4Single } from "./v4/swap.js";
import { discoverV4Pools, discoverV4StablePools, type V4Pool } from "./v4/discover.js";
import { NATIVE, v4NativeCurrencyAllowed } from "./v4/poolkey.js";
import { isStableQuote } from "./currency.js";
import { logger } from "../util/log.js";

const log = logger("router");

/** The concrete place a swap happened. "kyber" = aggregator, "v3"/"v4" = Uniswap on-chain. */
export type SwapVenue = "kyber" | "v3" | "v4";

export interface RouteQuote {
  amountOut: bigint;
  venue: SwapVenue;
  /** v3 fee tier, or the v4 pool's LP fee. 0 when nothing routed. */
  fee: number;
  /** v4 only — the exact pool to execute against. */
  poolKey?: V4Pool["poolKey"];
  /** v4 only — direction within that pool (the input may be currency1, not currency0). */
  zeroForOne?: boolean;
}

export interface SwapExecution {
  tx: string;
  amountOut: bigint;
  venue: SwapVenue;
}

export interface SwapOpts {
  /**
   * Fee tier to fall back to when NOTHING quotes. It is deliberately NOT used to narrow the
   * quote: buying on the exact tier you are about to farm (usually a thin, high-fee pool) bleeds
   * price impact and lands the position lopsided — the whole reason swapWethToTokenBest existed.
   */
  feeHint?: number;
  /** Force a single venue and disable the fallback chain. Used by tests/diagnostics, not by LP. */
  venue?: SwapVenue;
}

/** How many discovered v4 pools to price per pair. Deepest-first; more is RPC load, not alpha. */
const V4_QUOTE_FANOUT = 6;
/** Last-resort v3 tier when no tier quotes and the caller gave no hint (the historical default). */
const FALLBACK_FEE = 10000;

// ══════════════════════════ address helpers ══════════════════════════

/** Both native sentinels: v4's 0x0 and Kyber's 0xEeee…. Neither is an ERC-20. */
export function isNativeSide(addr: string): boolean {
  const a = (addr || "").toLowerCase();
  return a === NATIVE || a === KYBER_NATIVE.toLowerCase();
}
/** Canonical lowercase form for comparisons — both native sentinels collapse onto 0x0. */
function norm(addr: string): string {
  return isNativeSide(addr) ? NATIVE : (addr || "").toLowerCase();
}

// ══════════════════════════ quoting ══════════════════════════

/**
 * Best v3 quote: every tier in cfg.lp.feeTiers, deepest wins. Deliberately NOT narrowable to a
 * single tier — that is what swaps.ts's quoteQuoteToToken(feeHint) is for, and it exists there
 * because the caller then executes on exactly that tier, where a min-out taken from a DIFFERENT
 * pool would revert the swap it was meant to protect. Anything routed through this module is
 * free to land on whichever pool is deepest, which is the entire point of best-execution.
 */
async function quoteV3(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<RouteQuote | null> {
  if (!CHAIN.venues.v3) return null;
  // a v3 pool holds two ERC-20s; the native sentinel addresses nothing there
  if (isNativeSide(tokenIn) || isNativeSide(tokenOut)) return null;
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, wallet());
  let best: RouteQuote | null = null;
  for (const fee of cfg.lp.feeTiers) {
    try {
      const r = await q.quoteExactInputSingle!.staticCall({
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const out = r[0] as bigint;
      if (out > (best?.amountOut ?? 0n)) best = { amountOut: out, venue: "v3", fee };
    } catch {
      /* pool for this fee tier doesn't exist */
    }
  }
  return best;
}

/**
 * Discovered v4 pools that hold BOTH sides.
 *
 * Discovery is indexed by token + quote CLASS (native-paired vs dollar-paired), so we pick the
 * right index from whichever side is the quote and then filter down to the exact pair — the
 * stable index matches "any usd-class quote", which on a multi-stable profile is wider than asked.
 */
async function v4PoolsFor(a: string, b: string): Promise<V4Pool[]> {
  let pools: V4Pool[] = [];
  if (isNativeSide(a) || isNativeSide(b)) {
    if (!v4NativeCurrencyAllowed()) return []; // Arc: no pool key may hold 0x0
    pools = await discoverV4Pools(isNativeSide(a) ? b : a);
  } else if (isStableQuote(a) || isStableQuote(b)) {
    pools = await discoverV4StablePools(isStableQuote(a) ? b : a);
  } else {
    return []; // token/token: no discovery index, and the bot never LPs one
  }
  const wantA = norm(a);
  const wantB = norm(b);
  return pools.filter((p) => {
    const pair = new Set([p.poolKey.currency0.toLowerCase(), p.poolKey.currency1.toLowerCase()]);
    return pair.has(wantA) && pair.has(wantB);
  });
}

/** Best quote across the pair's live v4 pools (deepest V4_QUOTE_FANOUT only). */
async function quoteV4Best(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<RouteQuote | null> {
  if (!CHAIN.venues.v4 || !C.v4Quoter || !C.universalRouter) return null;
  const pools = await v4PoolsFor(tokenIn, tokenOut).catch(() => [] as V4Pool[]);
  if (!pools.length) return null;
  const deepest = [...pools].sort((x, y) => (y.liquidity > x.liquidity ? 1 : y.liquidity < x.liquidity ? -1 : 0)).slice(0, V4_QUOTE_FANOUT);
  const inL = norm(tokenIn);
  const priced = await Promise.all(
    deepest.map(async (p) => {
      // the input is NOT always currency0 — on a token/stable pool it depends on address order
      const zeroForOne = p.poolKey.currency0.toLowerCase() === inL;
      const out = await quoteV4(p.poolKey, zeroForOne, amountIn).catch(() => 0n);
      return { out, p, zeroForOne };
    }),
  );
  let best: RouteQuote | null = null;
  for (const { out, p, zeroForOne } of priced) {
    if (out > (best?.amountOut ?? 0n)) best = { amountOut: out, venue: "v4", fee: p.fee, poolKey: p.poolKey, zeroForOne };
  }
  return best;
}

/**
 * Best of the Uniswap venues. v3 and v4 are priced in parallel; a failing leg is just absent.
 * Takes `only` (a venue pin) rather than the full SwapOpts on purpose: SwapOpts carries feeHint,
 * and nothing routed through this module may let "prefer this tier" become "price ONLY this tier"
 * — that would quietly collapse best-execution back into the single-pool buy that lands an LP
 * lopsided. Narrowing to one tier is a separate, explicit call in swaps.ts.
 */
async function quoteUniswap(tokenIn: string, tokenOut: string, amountIn: bigint, only?: SwapVenue): Promise<RouteQuote | null> {
  const legs: Array<Promise<RouteQuote | null>> = [];
  if (only !== "v4") legs.push(quoteV3(tokenIn, tokenOut, amountIn).catch(() => null));
  if (only !== "v3") legs.push(quoteV4Best(tokenIn, tokenOut, amountIn).catch(() => null));
  let best: RouteQuote | null = null;
  for (const r of await Promise.all(legs)) {
    if (r && r.amountOut > (best?.amountOut ?? 0n)) best = r;
  }
  return best;
}

/** Aggregator quote (HTTP). Null when it can't route — never throws out of here. */
async function quoteKyber(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<RouteQuote | null> {
  if (!kyberEnabled()) return null;
  const r = await kyberRoute(kyberAddr(tokenIn), kyberAddr(tokenOut), amountIn).catch(() => null);
  const out = r ? BigInt(r.routeSummary?.amountOut ?? "0") : 0n;
  return out > 0n ? { amountOut: out, venue: "kyber", fee: 0 } : null;
}

/** Kyber addresses native with its own sentinel, not 0x0. */
function kyberAddr(addr: string): string {
  return isNativeSide(addr) ? KYBER_NATIVE : ethers.getAddress(addr);
}

const NO_ROUTE: RouteQuote = { amountOut: 0n, venue: "v3", fee: 0 };

/**
 * Best obtainable quote for tokenIn → tokenOut, across whatever venues this chain has.
 * Returns amountOut 0n when NOTHING routes — the bot's long-standing "no liquidity = rug" signal,
 * so callers keep treating it as data rather than as an error.
 */
export async function quoteBest(tokenIn: string, tokenOut: string, amountIn: bigint, opts: SwapOpts = {}): Promise<RouteQuote> {
  if (amountIn <= 0n) return NO_ROUTE;
  if (opts.venue === "kyber") return (await quoteKyber(tokenIn, tokenOut, amountIn)) ?? NO_ROUTE;
  const [uni, kyb] = await Promise.all([
    quoteUniswap(tokenIn, tokenOut, amountIn, opts.venue).catch(() => null),
    opts.venue ? Promise.resolve(null) : quoteKyber(tokenIn, tokenOut, amountIn).catch(() => null),
  ]);
  if (uni && kyb) return kyb.amountOut > uni.amountOut ? kyb : uni;
  return uni ?? kyb ?? NO_ROUTE;
}

// ══════════════════════════ execution ══════════════════════════

/** Slippage floor. Same formula, same cfg.lp.slippagePct, on every venue — never widened. */
function minOutWithSlippage(amountOut: bigint): bigint {
  const bps = BigInt(Math.round((cfg.lp.slippagePct || 5) * 100)); // e.g. 5% → 500 bps
  return (amountOut * (10_000n - bps)) / 10_000n;
}

/**
 * Single-hop v3 swap through SwapRouter02. Output is measured as a balance DELTA rather than
 * trusted from the quote, so the caller's book matches what actually arrived.
 */
async function swapV3Single(tokenIn: string, tokenOut: string, amountIn: bigint, fee: number, quoted: bigint): Promise<SwapExecution> {
  const w = wallet();
  const erc = new ethers.Contract(tokenIn, ERC20_ABI, w);
  if ((await erc.allowance!(w.address, C.swapRouter02)) < amountIn) {
    await (await erc.approve!(C.swapRouter02, ethers.MaxUint256, await overrides())).wait();
  }
  const params = {
    tokenIn,
    tokenOut,
    fee,
    recipient: w.address,
    amountIn,
    amountOutMinimum: minOutWithSlippage(quoted), // ← slippage floor, never 0
    sqrtPriceLimitX96: 0n,
  };
  const router = new ethers.Contract(C.swapRouter02, ROUTER_ABI, w);
  // simulate first: a swap that would revert (dry pool, min-out miss, transfer-tax token) costs an
  // eth_call instead of a failed tx — on Arc a failed tx is burnt USDC, not burnt ether.
  await router.exactInputSingle!.staticCall(params);
  const out = new ethers.Contract(tokenOut, ERC20_ABI, provider);
  const before: bigint = await out.balanceOf!(w.address).catch(() => 0n);
  const tx = await router.exactInputSingle!(params, await overrides());
  await tx.wait();
  const after: bigint = await out.balanceOf!(w.address).catch(() => 0n);
  return { tx: tx.hash, amountOut: after > before ? after - before : 0n, venue: "v3" };
}

/** Quote across Uniswap, then execute on whichever venue won. Null = nothing routed (no tx sent). */
async function swapUniswap(tokenIn: string, tokenOut: string, amountIn: bigint, opts: SwapOpts): Promise<SwapExecution | null> {
  // feeHint is an execution fallback, NOT a quote filter — see SwapOpts.feeHint.
  const best = await quoteUniswap(tokenIn, tokenOut, amountIn, opts.venue);
  if (best?.venue === "v4" && best.poolKey && best.zeroForOne !== undefined) {
    const r = await swapV4Single(best.poolKey, best.zeroForOne, amountIn, { quoted: best.amountOut });
    return { tx: r.tx, amountOut: r.amountOut, venue: "v4" };
  }
  if (opts.venue === "v4") return null; // v4 forced but no v4 pool quoted
  if (isNativeSide(tokenIn) || isNativeSide(tokenOut)) return null; // v3 can't hold native
  if (!best) {
    // Nothing quoted. Historically the v3 leg still fired at fee 10000 with amountOutMinimum 0 —
    // an unprotected swap into a pool the Quoter said was empty, i.e. a free sandwich on the way
    // to a revert. Refuse instead; the caller's fallback chain (or its try/catch) handles it.
    return null;
  }
  const fee = best.fee || opts.feeHint || FALLBACK_FEE;
  return swapV3Single(tokenIn, tokenOut, amountIn, fee, best.amountOut);
}

/**
 * Aggregator execution. All four security gates live in kyberSwap and are untouched.
 *
 * The return/throw split is the double-spend guard, so read it before simplifying it:
 *   null  → the aggregator declined BEFORE committing anything (disabled, no route, no build).
 *           Nothing was spent, so swapBest is free to try the next venue.
 *   throw → tagged BroadcastedSwapError, i.e. the tx is already on chain. swapBest must NOT retry.
 */
async function swapKyber(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<SwapExecution | null> {
  if (!kyberEnabled()) return null;
  const k = await kyberSwap(kyberAddr(tokenIn), kyberAddr(tokenOut), amountIn);
  if (!k) return null;
  if (k.amountOut > 0n) return { tx: k.tx, amountOut: k.amountOut, venue: "kyber" };
  // The tx CONFIRMED (kyberSwap only gets here after waitTx returned) but the output balance delta
  // read 0 — a flaky balanceOf, or a sell whose proceeds didn't cover the gas it burned. `amountIn`
  // is spent either way, so falling through to Uniswap here would buy/sell a SECOND time out of the
  // same budget. Surface it; the LP paths all catch.
  throw new BroadcastedSwapError(`kyber ${k.tx} already confirmed but amountOut 0 — input already spent`, k.tx);
}

/** The fallback chain for this chain, in order. */
function venueOrder(force?: SwapVenue): Array<"kyber" | "uniswap"> {
  if (force === "kyber") return ["kyber"];
  if (force) return ["uniswap"];
  if (kyberPreferred()) return ["kyber", "uniswap"];
  // uniswap-first chains keep the aggregator as a LAST resort where it exists at all — on Arc
  // kyberEnabled() is false today, so this is just ["uniswap"] until the probe says otherwise.
  return kyberEnabled() ? ["uniswap", "kyber"] : ["uniswap"];
}

/**
 * Swap tokenIn → tokenOut with the best execution this chain can give, trying each venue in turn.
 *
 * FIRST-WINS, not best-of — and that is deliberate, not an oversight. quoteBest compares venues
 * because a quote is free; an execution is not. Kyber's route is already a multi-hop search across
 * every DEX/tier/hook on the chain, so "try Kyber, fall back to Uniswap" is what the live bot does
 * today and re-quoting both before every buy would double the latency of every open for a
 * comparison that Kyber has usually already made. Pass `opts.venue` to pin one.
 *
 * Throws when EVERY venue declined (nothing routed / every attempt failed) — a caller that treats a
 * dry pool as data should catch, the LP paths already do. It ALSO throws immediately, without
 * trying the remaining venues, when a venue fails after broadcasting: retrying a swap whose first
 * attempt may still be in the mempool would double-spend the input. Kyber carries that tag itself
 * (kyber.ts BroadcastedSwapError) because it is the only venue that can fail on a post-send
 * TIMEOUT; the Uniswap legs await a receipt with no timeout, so what they throw is a reverted tx,
 * which spent gas but not the input and is therefore genuinely safe to retry elsewhere.
 */
export async function swapBest(tokenIn: string, tokenOut: string, amountIn: bigint, opts: SwapOpts = {}): Promise<SwapExecution> {
  if (amountIn <= 0n) return { tx: "", amountOut: 0n, venue: "v3" };
  const reasons: string[] = [];
  for (const venue of venueOrder(opts.venue)) {
    try {
      const r = venue === "kyber" ? await swapKyber(tokenIn, tokenOut, amountIn) : await swapUniswap(tokenIn, tokenOut, amountIn, opts);
      if (r && r.amountOut > 0n) {
        log.info(`swap via ${r.venue} → ${r.amountOut}`);
        return r;
      }
      reasons.push(`${venue}: no route`);
    } catch (e) {
      // A venue that failed AFTER committing its input on chain is NEVER retried. This is the one
      // case where "try the next venue" is not a rescue but a double-spend: kyberSwap broadcasts,
      // waitTx's 75s hard timeout fires on an RPC flap, and the "fallback" hands the SAME amountIn
      // to Uniswap — so a /lp open funded from one budget buys twice. The paths that route through
      // here (positions.ts v3 stable open/single-side) had NO fallback before this module existed,
      // so aborting is also what they used to do. See kyber.ts BroadcastedSwapError.
      if (isBroadcasted(e)) throw e;
      // Everything below is a PRE-broadcast decline, including a Kyber security-gate rejection.
      // Falling through to the on-chain venue is the SAFE response to suspicious aggregator
      // calldata — we route it ourselves instead.
      const msg = (e as Error).message.slice(0, 120);
      reasons.push(`${venue}: ${msg}`);
      log.warn(`${venue} failed (${msg}) → trying next venue`);
    }
  }
  throw new Error(`swap failed on all venues — ${reasons.join(" · ")}`);
}
