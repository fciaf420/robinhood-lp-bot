/**
 * Quotes + swaps, expressed against a QUOTE ASSET rather than against WETH.
 *
 * Every swap carries slippage protection derived from a Quoter — including quote→token (the old
 * build sent amountOutMinimum: 0, i.e. a free sandwich on a thin chain). We don't use the
 * smart-order-router: neither chain has a subgraph, so we route single-hop through each fee tier
 * and take the best quote.
 *
 * WHY THE "quote asset" RESHAPE: this file used to say WETH everywhere, because on Robinhood the
 * native currency wraps and every pool pairs against that wrapper. Arc has no WETH9 at all — the
 * native currency IS USDC and pool currencies are the 6-decimal USDC ERC-20 predeploy — so
 * `C.weth` there is the ZERO ADDRESS and a token→WETH swap would fire approvals at 0x0. So the
 * quote side became a PARAMETER:
 *
 *     quoteTokenToQuote / swapTokenToQuote     sell token → any quote asset
 *     quoteQuoteToToken / swapQuoteToTokenBest buy  token ← any quote asset
 *
 * and the historical WETH-named functions are thin wrappers that pass defaultQuoteAddr() —
 * the wrapped native where one exists (Robinhood: literally C.weth, so those call sites are
 * bit-for-bit what they were), the dollar stable where one does not (Arc). Files that still call
 * the old names keep compiling and keep behaving.
 *
 * Venue choice is NOT made here — see chain/router.ts. This module owns the v3-tier quoting that
 * the display/PnL paths depend on (cheap, no HTTP, no aggregator) and hands anything that needs
 * best-execution to the router.
 */
import { ethers } from "ethers";
import { cfg, C } from "../config.js";
import { wallet, provider, overrides } from "./client.js";
import { ERC20_ABI, WETH_ABI, QUOTER_ABI, ROUTER_ABI } from "./abis.js";
import { swapBest, quoteBest, type SwapVenue } from "./router.js";
import { hasWrapped, stableAddr, natSym, fmtNat, parseNat, quoteSymbol, quoteDecimalsOf } from "./currency.js";
import { tokenMeta } from "./tokens.js";
import { logger } from "../util/log.js";
import type { TopUp } from "../types.js";

const log = logger("swap");

/** Raw token balance (BigInt) of the bot wallet. */
export async function tokenBalanceRaw(tokenAddr: string): Promise<bigint> {
  try {
    return await new ethers.Contract(tokenAddr, ERC20_ABI, provider).balanceOf!(wallet().address);
  } catch {
    return 0n;
  }
}

/**
 * The quote asset the WETH-named wrappers use.
 *   Robinhood → C.weth (the wrapped native) — identical to the old hardcoded constant.
 *   Arc       → the 6-dec USDC ERC-20 predeploy, because there is nothing to wrap and EVERY Arc
 *               pool is token/USDC-ERC20. Never the native 18-dec representation: that is a gas
 *               balance, not a pool currency, and mixing the two is the 1e12 hazard.
 */
export function defaultQuoteAddr(): string {
  return hasWrapped() ? C.weth : stableAddr();
}

/**
 * Decimals of a quote asset. A profile-known quote answers without an RPC read — which matters
 * because this feeds the float in every `{ out }` figure and a wrong width here is the 1e12 bug.
 */
async function quoteDecimals(addr: string): Promise<number> {
  const known = quoteDecimalsOf(addr);
  if (known !== null) return known;
  // Only reached for a quote asset the profile doesn't name (a caller passing an arbitrary token
  // as the "quote" side), so paying for one RPC read beats assuming a width.
  return (await tokenMeta(addr).catch(() => ({ decimals: 18 }))).decimals;
}

export interface Quote {
  /**
   * Amount out as a FLOAT in the quote asset's own units.
   * Named `weth` for history: ~6 call sites across analytics/ledger/holdings/positions read it and
   * those files are owned by other stages. On Robinhood with the default quote it is exactly the
   * WETH figure it always was; on any other quote it is that quote's units. Prefer `out`.
   */
  weth: number;
  /** Same number, honestly named. */
  out: number;
  fee: number;
  amountOut: bigint;
}

const NO_QUOTE: Quote = { weth: 0, out: 0, fee: 0, amountOut: 0n };

/**
 * Best token→quote price across all v3 fee tiers. { out: 0 } means no liquidity (rug).
 *
 * v3 ONLY, on purpose: this is the hot path behind /list, /pnl, the ledger and every "is this
 * token still worth anything" check, and it must stay a handful of eth_calls with no HTTP and no
 * aggregator round-trip. Best-execution lives in swapTokenToQuote / the router.
 */
export async function quoteTokenToQuote(tokenAddr: string, amountRaw: bigint, quoteAddr?: string): Promise<Quote> {
  if (amountRaw <= 0n) return NO_QUOTE;
  const quote = quoteAddr ?? defaultQuoteAddr();
  const dec = await quoteDecimals(quote);
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, wallet());
  let best: Quote = NO_QUOTE;
  for (const fee of cfg.lp.feeTiers) {
    try {
      const r = await q.quoteExactInputSingle!.staticCall({
        tokenIn: tokenAddr,
        tokenOut: quote,
        amountIn: amountRaw,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const amountOut = r[0] as bigint;
      const out = Number(ethers.formatUnits(amountOut, dec));
      if (out > best.out) best = { weth: out, out, fee, amountOut };
    } catch {
      /* pool for this fee tier doesn't exist */
    }
  }
  return best;
}

/**
 * WETH-named wrapper over quoteTokenToQuote, kept because its callers (the WETH-paired v3
 * open/close in positions.ts, the ledger's leftover valuation) are exactly the paths that only
 * exist on a chain WITH a wrapped native — where defaultQuoteAddr() IS C.weth, so the name is
 * accurate and the numbers are bit-for-bit what they were. Not deprecated, just narrower.
 */
export async function quoteTokenToWeth(tokenAddr: string, amountRaw: bigint): Promise<Quote> {
  return quoteTokenToQuote(tokenAddr, amountRaw);
}

/**
 * Best quote→token price. `feeHint` restricts the quote to ONE tier, and that is load-bearing:
 * swapQuoteToToken executes on exactly the tier it was given, so a min-out derived from a deeper
 * pool would revert the very swap it is supposed to protect.
 */
export async function quoteQuoteToToken(
  tokenAddr: string,
  quoteRaw: bigint,
  feeHint?: number,
  quoteAddr?: string,
): Promise<{ amountOut: bigint; fee: number }> {
  const quote = quoteAddr ?? defaultQuoteAddr();
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, wallet());
  const tiers = feeHint ? [feeHint] : cfg.lp.feeTiers;
  let best = { amountOut: 0n, fee: feeHint ?? 0 };
  for (const fee of tiers) {
    try {
      const r = await q.quoteExactInputSingle!.staticCall({
        tokenIn: quote,
        tokenOut: tokenAddr,
        amountIn: quoteRaw,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const out = r[0] as bigint;
      if (out > best.amountOut) best = { amountOut: out, fee };
    } catch {
      /* no pool this tier */
    }
  }
  return best;
}

function minOutWithSlippage(amountOut: bigint): bigint {
  const bps = BigInt(Math.round((cfg.lp.slippagePct || 5) * 100)); // e.g. 5% → 500 bps
  return (amountOut * (10_000n - bps)) / 10_000n;
}

export interface SwapResult {
  tx: string;
  amountOut: bigint;
  /** Which venue actually executed. Absent on the direct v3 paths that never consult the router. */
  venue?: SwapVenue;
}

/**
 * Sell token → quote asset with slippage protection.
 *
 * Direct single-hop v3 while v3 has the liquidity (unchanged from the WETH-era code, so every
 * Robinhood close still sells exactly the way it does today). When NO tier quotes, it hands the
 * sell to the router instead of doing what the old code did — fire at fee 10000 with
 * amountOutMinimum 0, an unprotected swap into a pool the Quoter just said was empty. On Arc that
 * fallback is how a token with only v4 liquidity gets sold at all.
 */
export async function swapTokenToQuote(
  tokenAddr: string,
  amountRaw: bigint,
  quoteAddr?: string,
  feeHint?: number,
): Promise<SwapResult> {
  if (amountRaw <= 0n) return { tx: "", amountOut: 0n };
  const quote = quoteAddr ?? defaultQuoteAddr();
  const q = await quoteTokenToQuote(tokenAddr, amountRaw, quote);
  if (q.amountOut <= 0n) {
    log.warn(`v3 nggak punya rute ${tokenAddr} → ${quoteSymbol(quote) ?? "quote"} — lempar ke router`);
    return swapBest(tokenAddr, quote, amountRaw, { feeHint });
  }
  const w = wallet();
  const erc = new ethers.Contract(tokenAddr, ERC20_ABI, w);
  if ((await erc.allowance!(w.address, C.swapRouter02)) < amountRaw) {
    await (await erc.approve!(C.swapRouter02, ethers.MaxUint256, await overrides())).wait();
  }
  // PRE-EXISTING QUIRK, preserved on purpose: feeHint overrides the tier the quote came from, so a
  // caller that hints a tier OTHER than the deepest one gets a min-out priced on a different pool.
  // Every live caller either passes no hint or passes the fee this same quote just returned
  // (holdings.sellAllTokens does exactly that), so in practice fee === q.fee. Left as-is because
  // "fix" here means changing the min-out on the live close path.
  const fee = feeHint || q.fee;
  const params = {
    tokenIn: tokenAddr,
    tokenOut: quote,
    fee,
    recipient: w.address,
    amountIn: amountRaw,
    amountOutMinimum: minOutWithSlippage(q.amountOut),
    sqrtPriceLimitX96: 0n,
  };
  const router = new ethers.Contract(C.swapRouter02, ROUTER_ABI, w);
  // simulate before sending: a revert costs an eth_call instead of a burnt tx (on Arc gas is USDC,
  // so a failed send is a direct dollar loss, not a few gwei of ether).
  await router.exactInputSingle!.staticCall(params);
  const tx = await router.exactInputSingle!(params, await overrides());
  const rc = await tx.wait();
  return { tx: tx.hash, amountOut: extractQuoteOut(rc, w.address, quote) ?? q.amountOut, venue: "v3" };
}

/** WETH-named wrapper over swapTokenToQuote — see quoteTokenToWeth above. */
export async function swapTokenToWeth(tokenAddr: string, amountRaw: bigint, feeHint?: number): Promise<SwapResult> {
  return swapTokenToQuote(tokenAddr, amountRaw, defaultQuoteAddr(), feeHint);
}

/**
 * Buy token with a quote asset on ONE named fee tier. Used where the caller genuinely wants that
 * exact pool; everything else should use swapQuoteToTokenBest.
 */
export async function swapQuoteToToken(
  tokenAddr: string,
  quoteRaw: bigint,
  fee: number,
  quoteAddr?: string,
): Promise<SwapResult> {
  const w = wallet();
  const quote = quoteAddr ?? defaultQuoteAddr();
  // WETH_ABI is a superset of ERC20_ABI; using it keeps the wrapped-native call shape identical.
  const qc = new ethers.Contract(quote, WETH_ABI, w);
  if ((await qc.allowance!(w.address, C.swapRouter02)) < quoteRaw) {
    await (await qc.approve!(C.swapRouter02, ethers.MaxUint256, await overrides())).wait();
  }
  const quoted = await quoteQuoteToToken(tokenAddr, quoteRaw, fee, quote);
  // A 0 quote on the ONE tier we were told to use means no floor at all — an unprotected buy, the
  // exact hole this file was written to close. Refuse rather than send; the caller asked for a
  // specific pool, and if the Quoter cannot price that pool there is nothing to protect the swap
  // with. (swapQuoteToTokenBest has no such problem: it searches, so it always has a real quote.)
  if (quoted.amountOut <= 0n) {
    throw new Error(`nggak ada quote ${quoteSymbol(quote) ?? "quote"}→token di fee ${fee} — swap tanpa floor slippage ditolak.`);
  }
  const params = {
    tokenIn: quote,
    tokenOut: tokenAddr,
    fee,
    recipient: w.address,
    amountIn: quoteRaw,
    amountOutMinimum: minOutWithSlippage(quoted.amountOut), // ← slippage floor, no longer 0
    sqrtPriceLimitX96: 0n,
  };
  const erc = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
  const before: bigint = await erc.balanceOf!(w.address);
  const router = new ethers.Contract(C.swapRouter02, ROUTER_ABI, w);
  await router.exactInputSingle!.staticCall(params);
  const tx = await router.exactInputSingle!(params, await overrides());
  await tx.wait();
  const after: bigint = await erc.balanceOf!(w.address);
  return { tx: tx.hash, amountOut: after - before, venue: "v3" };
}

/**
 * Buy `tokenAddr` with `quoteAddr` using the BEST execution this chain offers — the aggregator
 * where the profile says it exists, Uniswap v3/v4 otherwise, with automatic fallback between them
 * (chain/router.ts owns the order).
 *
 * Why best-route and not "just buy on the tier I'm about to farm": that tier is usually a thin,
 * high-fee pool, so buying there bleeds fee + price impact and leaves the in-range LP lopsided —
 * you deposit 0.01 and land ~half. Best-route execution keeps the token side's value ≈ the quote
 * spent, so the position fills fully. Every venue spends EXACTLY `amountRaw` (Kyber gate #3, and
 * exactInputSingle by construction), so the caller's "quote left" math holds.
 */
export async function swapQuoteToTokenBest(
  quoteAddr: string,
  tokenAddr: string,
  amountRaw: bigint,
  feeHint?: number,
): Promise<SwapResult> {
  if (amountRaw <= 0n) return { tx: "", amountOut: 0n };
  return swapBest(quoteAddr, ethers.getAddress(tokenAddr), amountRaw, { feeHint });
}

/** WETH-named wrapper over swapQuoteToTokenBest — see quoteTokenToWeth above. */
export async function swapWethToTokenBest(tokenAddr: string, wethRaw: bigint, feeHint?: number): Promise<SwapResult> {
  return swapQuoteToTokenBest(defaultQuoteAddr(), tokenAddr, wethRaw, feeHint);
}

/** Re-exported so callers can price a swap without importing the router directly. */
export { quoteBest, swapBest };

/**
 * Sum of `quoteAddr` Transfer events into `to` in a receipt (the real swap output).
 *
 * Returns null — never 0 — when the quote address can't appear in a log (no wrapped native → the
 * zero address), so the caller falls back to the Quoter figure instead of booking a zero.
 */
function extractQuoteOut(rc: ethers.TransactionReceipt | null, to: string, quoteAddr: string): bigint | null {
  if (!rc || !quoteAddr) return null;
  const qL = quoteAddr.toLowerCase();
  if (qL === ethers.ZeroAddress) return null;
  const toTopic = "0x" + to.toLowerCase().slice(2).padStart(64, "0");
  let sum = 0n;
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() !== qL) continue;
    if (lg.topics.length === 3 && lg.topics[2]?.toLowerCase() === toTopic) sum += BigInt(lg.data);
  }
  return sum > 0n ? sum : null;
}

/**
 * Keep the native balance at >= target by unwrapping the wrapped native. Called after close so gas
 * is always available for the next tx. All math in wei (BigInt) — going through float can round a
 * few wei above the real balance → withdraw reverts "burn amount exceeds balance".
 *
 * NO-OP ON A CHAIN WITHOUT A WRAPPED NATIVE (Arc): there is nothing to unwrap, and `C.weth` there
 * is the zero address, so without this guard the top-up would call withdraw() on 0x0 after every
 * close. Arc's equivalent protection is the gas reserve in currency.ts — a FLOOR on every position
 * size, held back before the open rather than topped up after the close.
 */
export async function ensureNativeEth(targetEth?: number): Promise<TopUp | null> {
  if (!hasWrapped()) return null;
  // No local 0.015 fallback: LpSchema already defaults nativeTargetEth to 0.015, so a second copy
  // of that number here was an ether-shaped literal in a chain-generic file, unreachable and one
  // careless edit away from disagreeing with the schema about what the top-up target is.
  const target = Number(targetEth ?? cfg.lp.nativeTargetEth);
  if (!(target > 0)) return null;
  const w = wallet();
  const targetWei = parseNat(String(target));
  const nativeWei = await provider.getBalance(w.address);
  if (nativeWei >= targetWei) return null;
  const wc = new ethers.Contract(C.weth, WETH_ABI, w);
  const wbalWei: bigint = await wc.balanceOf!(w.address);
  if (wbalWei <= 0n) return null;
  const needWei = targetWei - nativeWei;
  const amtWei = needWei < wbalWei ? needWei : wbalWei;
  if (amtWei < 10_000_000_000_000n) return null; // < 0.00001: not worth the gas
  const tx = await wc.withdraw!(amtWei, await overrides());
  await tx.wait();
  const f = (v: bigint) => Number(fmtNat(v));
  log.info(`top-up gas: unwrap ${f(amtWei)} → ${natSym()} native`);
  return {
    unwrapped: f(amtWei),
    tx: tx.hash,
    nativeBefore: f(nativeWei),
    nativeAfter: f(nativeWei + amtWei),
  };
}
