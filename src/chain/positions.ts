/**
 * Open / list / close LP positions.
 *
 * Tick & price math is delegated to the Uniswap SDK (see pools.ts). Principal and fee
 * amounts are read via decreaseLiquidity/collect `staticCall` — i.e. the node simulates
 * the exact withdrawal, so /list shows what you'd actually receive, with zero local
 * liquidity→amount float math (the v1 precision bug).
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import { cfg, C } from "../config.js";
import { wallet, provider, overrides } from "./client.js";
import { NPM_ABI, FACTORY_ABI, POOL_ABI, ERC20_ABI } from "./abis.js";
import { tokenMeta } from "./tokens.js";
import { getPoolState, computeRange, mcapAtTick, widthInTicks, type PoolState } from "./pools.js";
import {
  quoteTokenToWeth,
  swapWethToTokenBest,
  swapTokenToWeth,
  tokenBalanceRaw,
  ensureNativeEth,
  defaultQuoteAddr,
} from "./swaps.js";
import { kyberEnabled, KYBER_NATIVE } from "./kyber.js";
import { swapBest } from "./router.js";
import {
  nativeUsd,
  natSym,
  chainId,
  fmtNat,
  parseNat,
  budgetForOpen,
  hasWrapped,
  isWrappedNative,
  isStableQuote,
  stableSym,
  stableAddr,
  stableDecimals,
  natWeiToStableRaw,
  usdToNatWei,
  nativeIsStableQuote,
} from "./currency.js";
import { appendLedger } from "./ledger.js";
import { nftMintTimestamp } from "./indexer.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";
import type { MintMode, OpenResult, PositionRow, CloseResult, RangePreview, PoolInfo, TokenMeta } from "../types.js";

const { CurrencyAmount } = sdkCore as any;
const log = logger("position");
const MAX_U128 = (1n << 128n) - 1n;
// The chain's dollar quote is USDG on Robinhood and the 6-dec USDC ERC-20 on Arc. Every "is this
// side the stable?" test goes through isStableQuote() (profile-driven, handles a chain with more
// than one dollar quote); only the DECIMALS are hoisted, because they appear in raw-amount maths.
const STABLE_DEC = stableDecimals();
// Below this a swap costs more gas than it moves, so we skip it. parseNat() keeps Robinhood at
// exactly the old parseEther("0.00002") = 2e13 wei — same decimals, same number.
const DUST_NAT_WEI = parseNat("0.00002");

// ── deposit basis persistence (data/positions.json) ──
const POS_FILE = dataPath("positions.json");
type DepositRecord = {
  depositWeth: string;
  ts: number;
  entryMcap?: number;
  mode?: MintMode;
  mintTs?: number;
  quote?: "eth" | "usd"; // "usd" = token/stable pair (LP-vs-HODL basis via dep0/dep1)
  dep0?: string; // deposited amount of pool token0 (raw) — stable pairs only
  dep1?: string; // deposited amount of pool token1 (raw) — stable pairs only
  nat?: string; // native symbol the basis is denominated in ("ETH" | "USDC"); absent = legacy = ETH
  chainId?: number; // chain the position lives on; absent = legacy = Robinhood
};

/**
 * `depositWeth` keeps its name (data/positions.json is written by the LIVE bot and is never
 * migrated); its VALUE is native wei, which on Arc is 18-dec USDC, not ether. NEW records carry
 * nat + chainId so a reader can tell. Old records have neither and are Robinhood/ETH by default.
 */
export function saveDeposit(tokenId: string, depositWethWei: bigint, extra: Partial<DepositRecord> = {}): void {
  const d = readJson<Record<string, DepositRecord>>(POS_FILE, {});
  d[String(tokenId)] = { depositWeth: depositWethWei.toString(), ts: Date.now(), nat: natSym(), chainId: chainId(), ...extra };
  writeJson(POS_FILE, d);
}
function loadDeposit(tokenId: string): DepositRecord | null {
  return readJson<Record<string, DepositRecord>>(POS_FILE, {})[String(tokenId)] ?? null;
}
function deleteDeposit(tokenId: string): void {
  const d = readJson<Record<string, DepositRecord>>(POS_FILE, {});
  delete d[String(tokenId)];
  writeJson(POS_FILE, d);
}

// ── mint deadline (10 min) ──
const deadline = () => Math.floor(Date.now() / 1000) + 600;

/** Non-wrapped-native token address + its meta for a pool state. */
async function tokenSide(st: PoolState) {
  const addr = st.wethIsToken0 ? st.token1 : st.token0;
  const meta = await tokenMeta(addr);
  return { addr, meta };
}

/** Extract minted tokenId from an NPM mint receipt (Transfer with 4 topics). */
function tokenIdFromReceipt(rc: ethers.TransactionReceipt): string | null {
  const npmL = C.positionManager.toLowerCase();
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() === npmL && lg.topics.length === 4) {
      return BigInt(lg.topics[3]!).toString();
    }
  }
  return null;
}

/**
 * Open an LP position.
 *   single  → single-sided WETH, range entirely on one side of price (rug-safe brake).
 *   inrange → straddle price; swaps ~half of WETH into token first (fees from second 1).
 */
export async function openPosition(
  _tokenAddr: string,
  poolAddr: string,
  amountEthStr: string,
  opts: { mode?: MintMode } = {},
): Promise<OpenResult> {
  const mode: MintMode = opts.mode === "inrange" ? "inrange" : "single";
  // A wrapped-native-paired v3 pool cannot exist without a WETH9 (Arc). Fail here with the real
  // reason instead of letting the zero address flow into getPool/approve.
  if (!hasWrapped()) throw new Error(`this chain has no wrapped native — ${natSym()} v3 pair is impossible, use a /${stableSym()} pool`);
  const w = wallet();
  const st = await getPoolState(poolAddr);
  if (!st.wethIsToken0 && !isWrappedNative(st.token1)) {
    throw new Error("this pool is not a WETH pair");
  }
  // GAS FLOOR (not a cap). A no-op on any chain that HAS a wrapped native — which is the only
  // kind of chain that can reach this WETH-paired path at all — so Robinhood sizing is unchanged.
  // Kept for uniformity: every open entry point funnels its size through the same floor.
  const amount = await budgetForOpen(parseNat(amountEthStr));
  const { addr: tokenReal, meta: tokMeta } = await tokenSide(st);
  const px = await nativeUsd().catch(() => 0);
  const wc = new ethers.Contract(C.weth, [...ERC20_ABI, "function deposit() payable"], w);

  // 1. wrap ETH → WETH if needed
  let wrapHash: string | undefined;
  const wbal: bigint = await wc.balanceOf!(w.address);
  if (wbal < amount && cfg.lp.autoWrap) {
    const wrapTx = await wc.deposit!({ value: amount - wbal, ...(await overrides()) });
    await wrapTx.wait();
    wrapHash = wrapTx.hash;
  }
  // 2. approve WETH to NPM
  if ((await wc.allowance!(w.address, C.positionManager)) < amount) {
    await (await wc.approve!(C.positionManager, ethers.MaxUint256, await overrides())).wait();
  }
  // use exact WETH balance (wrap can miss by 1 wei → STF)
  const realBal: bigint = await wc.balanceOf!(w.address);
  const depositAmt = realBal < amount ? realBal : amount;

  if (mode === "inrange") {
    return openInRange(st, poolAddr, tokenReal, tokMeta, depositAmt, px, wrapHash);
  }
  return openSingleSide(st, poolAddr, tokMeta, depositAmt, px, wrapHash);
}

async function openSingleSide(
  st: PoolState,
  poolAddr: string,
  tokMeta: { symbol: string; supplyUi: number },
  depositAmt: bigint,
  px: number,
  wrapHash: string | undefined,
): Promise<OpenResult> {
  const w = wallet();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const pc = new ethers.Contract(poolAddr, POOL_ABI, provider);

  let lastErr: unknown = null;
  // Buffer widens each retry: a volatile price can cross a single-sided range before the
  // tx lands, reverting the mint. Re-read the tick fresh each attempt.
  for (let attempt = 0, buf = cfg.lp.rangeBufferSpacings || 2; attempt < 3; attempt++, buf += 2) {
    const tickNow = Number((await pc.slot0!()).tick);
    const fresh = { ...st, tick: tickNow };
    const { tickLower, tickUpper } = computeRange(fresh, "single", buf);
    const params = {
      token0: st.token0,
      token1: st.token1,
      fee: st.fee,
      tickLower,
      tickUpper,
      amount0Desired: st.wethIsToken0 ? depositAmt : 0n,
      amount1Desired: st.wethIsToken0 ? 0n : depositAmt,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: w.address,
      deadline: deadline(),
    };
    try {
      const sim = await npm.mint!.staticCall(params);
      if (sim.liquidity === 0n) throw new Error("liquidity 0 — deposit too small");
      const tx = await npm.mint!(params, await overrides());
      const rc = await tx.wait();
      const tokenId = tokenIdFromReceipt(rc);
      const entryMcap = mcapAtTick(fresh, tickNow, px, tokMeta.supplyUi);
      if (tokenId) saveDeposit(tokenId, depositAmt, { entryMcap, mode: "single" });
      log.info(`open single #${tokenId} ${tokMeta.symbol} deposit=${fmtNat(depositAmt)} ${natSym()}`);
      return {
        tokenId,
        txHash: tx.hash,
        wrapHash,
        mode: "single",
        tickLower,
        tickUpper,
        tick: tickNow,
        entryMcap,
        depositEth: fmtNat(depositAmt),
        side: st.wethIsToken0
          ? "ETH waiting → buy token when MCAP drops"
          : "ETH waiting → buy token when MCAP rises",
        liquidity: sim.liquidity.toString(),
      };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(1500);
    }
  }
  throw new Error(`mint failed 3×: ${errShort(lastErr)}`);
}

async function openInRange(
  st: PoolState,
  poolAddr: string,
  tokenReal: string,
  tokMeta: { symbol: string; supplyUi: number },
  depositAmt: bigint,
  px: number,
  wrapHash: string | undefined,
): Promise<OpenResult> {
  const w = wallet();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const pc = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const tickNow = Number((await pc.slot0!()).tick);
  const fresh = { ...st, tick: tickNow };
  const { tickLower, tickUpper, swapFraction } = computeRange(fresh, "inrange");
  const erc = new ethers.Contract(tokenReal, ERC20_ABI, w);

  // REUSE token already in the wallet (bought on a prior failed attempt / leftover inventory)
  // so we never double-buy — value it in WETH and buy only the shortfall below.
  const tokenHave: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
  const haveWethValue: bigint =
    tokenHave > 0n
      ? (await quoteTokenToWeth(tokenReal, tokenHave).catch(() => ({ amountOut: 0n }))).amountOut
      : 0n;

  // WETH-value of token this straddling range wants (98% of the split so leftover stays WETH,
  // not stuck token). Buy ONLY the shortfall, and via the KyberSwap aggregator (best route across
  // every DEX/fee-tier/hook) — NOT the farmed fee tier, which would bleed price impact and land
  // the position lopsided ("input 0.01 → liq only half"). Cap at 90% so the WETH side pairs.
  const frac = swapFraction * 0.98;
  const targetTokenWeth = (depositAmt * BigInt(Math.round(frac * 1e6))) / 1_000_000n;
  let wethToSwap = targetTokenWeth > haveWethValue ? targetTokenWeth - haveWethValue : 0n;
  const maxSwap = (depositAmt * 9n) / 10n;
  if (wethToSwap > maxSwap) wethToSwap = maxSwap;

  let swapHash: string | undefined;
  if (wethToSwap >= DUST_NAT_WEI) {
    const sw = await swapWethToTokenBest(tokenReal, wethToSwap, st.fee);
    if (sw.amountOut <= 0n) throw new Error("swap WETH → token yielded no tokens (pool dry?)");
    swapHash = sw.tx;
  } else {
    wethToSwap = 0n; // enough token already on hand — LP straight from balance
  }

  // actual token balance now (reused inventory + anything just swapped)
  const tokenGot: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
  if (tokenGot <= 0n) throw new Error("token balance 0 — nothing to LP");

  if ((await erc.allowance!(w.address, C.positionManager)) < tokenGot) {
    await (await erc.approve!(C.positionManager, ethers.MaxUint256, await overrides())).wait();
  }
  const wethLeft = depositAmt - wethToSwap;
  const params = {
    token0: st.token0,
    token1: st.token1,
    fee: st.fee,
    tickLower,
    tickUpper,
    amount0Desired: st.wethIsToken0 ? wethLeft : tokenGot,
    amount1Desired: st.wethIsToken0 ? tokenGot : wethLeft,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: w.address,
    deadline: deadline(),
  };
  const sim = await npm.mint!.staticCall(params);
  if (sim.liquidity === 0n) throw new Error("liquidity 0 — deposit too small");
  const tx = await npm.mint!(params, await overrides());
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc);

  // honest cost basis = the position's ACTUAL value at mint: WETH side used + WETH-value of the
  // token side used (same Quoter). Counts reused inventory; ignores refunded excess.
  const wethUsed = (st.wethIsToken0 ? sim.amount0 : sim.amount1) as bigint;
  const tokenUsed = (st.wethIsToken0 ? sim.amount1 : sim.amount0) as bigint;
  const tokenUsedWeth: bigint =
    tokenUsed > 0n
      ? (await quoteTokenToWeth(tokenReal, tokenUsed).catch(() => ({ amountOut: 0n }))).amountOut
      : 0n;
  const costBasis = wethUsed + (tokenUsedWeth > 0n ? tokenUsedWeth : wethToSwap);
  const swappedPct = depositAmt > 0n ? Math.round((Number(wethToSwap) / Number(depositAmt)) * 100) : 0;
  const entryMcap = mcapAtTick(fresh, tickNow, px, tokMeta.supplyUi);
  if (tokenId) saveDeposit(tokenId, costBasis, { entryMcap, mode: "inrange" });
  log.info(`open inrange #${tokenId} ${tokMeta.symbol} swapped=${swappedPct}%${wethToSwap === 0n ? " (reuse balance)" : ""}`);
  return {
    tokenId,
    txHash: tx.hash,
    wrapHash,
    swapHash,
    mode: "inrange",
    tickLower,
    tickUpper,
    tick: tickNow,
    entryMcap,
    swappedPct,
    depositEth: fmtNat(costBasis),
    side: `IN RANGE — earning fees immediately (≈${swappedPct}% of capital converted to token)`,
    liquidity: sim.liquidity.toString(),
  };
}

// ══════════ v3 token/<stable quote> (no wrapped-native leg) ══════════
//
// This is the ONLY pool shape Arc can have (no WETH9 → nothing to native-pair with), and it is
// the same path Robinhood already runs for token/USDG. The stable's ADDRESS and DECIMALS come
// from the chain profile; everything below is otherwise the code that has been minting USDG
// positions in production.

/** Value fraction that belongs on the currency1 side of a straddling range [tl,tu] at `tick`. */
function valueFracC1(tick: number, tickLower: number, tickUpper: number): number {
  const sP = Math.pow(1.0001, tick / 2);
  const sA = Math.pow(1.0001, tickLower / 2);
  const sB = Math.pow(1.0001, tickUpper / 2);
  if (sP <= sA) return 1; // price ≤ lower → all value in token1
  if (sP >= sB) return 0; // price ≥ upper → all value in token0
  const a0 = (sB - sP) / (sP * sB); // token0 per unit L
  const a1in0 = (sP - sA) / (sP * sP); // token1 per unit L, expressed in token0 units
  const f = a1in0 / (a0 + a1in0);
  return Math.min(0.95, Math.max(0.05, f));
}

/**
 * USD value of `raw` units of one pool side, using the pool itself as the price oracle.
 * `px` is the USD price of ONE NATIVE unit (nativeUsd(), = 1 on a stable-native chain), so the
 * wrapped-native branch works unchanged on Robinhood and is simply unreachable on Arc.
 */
function currencyUsd(st: PoolState, isSide0: boolean, raw: bigint, px: number): number {
  if (raw <= 0n) return 0;
  const addr = isSide0 ? st.token0 : st.token1;
  const dec = isSide0 ? st.token0Sdk.decimals : st.token1Sdk.decimals;
  if (isStableQuote(addr)) return Number(ethers.formatUnits(raw, dec)); // stable ≈ $1
  if (isWrappedNative(addr)) return Number(ethers.formatUnits(raw, dec)) * px;
  try {
    const cur = isSide0 ? st.token0Sdk : st.token1Sdk;
    const other = isSide0 ? st.token1 : st.token0;
    const inOther = Number(st.sdkPool.priceOf(cur).quote(CurrencyAmount.fromRawAmount(cur, raw.toString())).toExact());
    if (isStableQuote(other)) return inOther;
    if (isWrappedNative(other)) return inOther * px;
  } catch {
    /* price out of range → 0 */
  }
  return 0;
}

/**
 * Open an in-range v3 position on a token/<stable> pool (no wrapped-native leg). Funds BOTH sides
 * from the native budget via the KyberSwap aggregator (→stable and →token, best route), then mints
 * both-sided through the v3 NPM. The NPM only pulls up to `amountDesired` and refunds the rest, so
 * passing the actual balances with amountMin=0 (staticCall-guarded) can never over-pull.
 */
export async function openV3StableInRange(pool: PoolInfo, amountEthStr: string): Promise<OpenResult> {
  // The token side still has to be BOUGHT from the budget, and that needs a router — but "router"
  // is no longer a synonym for "KyberSwap". This used to refuse whenever the aggregator was
  // unconfigured, which on a chain the aggregator does not serve at all (Arc, profile
  // data.router="uniswap") meant the in-range stable path could never run even though the chain
  // has a v3 SwapRouter02, a v4 PoolManager and a UniversalRouter deployed. chain/router.ts owns
  // that choice now; a venue that cannot route says so when the buy is attempted, by name.
  const w = wallet();
  const st = await getPoolState(pool.pool);
  const c0 = st.token0;
  const c1 = st.token1;
  if (!isStableQuote(c0) && !isStableQuote(c1)) throw new Error(`this pool is not a ${stableSym()} pair`);
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  // GAS FLOOR (not a cap): on a chain with no wrapped native, capital and gas are one balance,
  // so the size is clamped to (balance − reserve). With a wrapped native this is a no-op.
  const total = await budgetForOpen(parseNat(amountEthStr));

  // 1) fund the pay side.
  //    WITH a wrapped native: wrap the shortfall — both buys spend WETH, native stays for gas.
  //    WITHOUT one: the pay side is the stable ERC-20 and there is NO wrap that can produce it, so
  //    the only thing to do is check we actually hold enough BEFORE spending anything. That check
  //    is the whole point: on Arc it is still unverified whether the native 18-dec USDC balance and
  //    the 6-dec ERC-20 predeploy are one balance or two (see `npm run probe:arc`). If they are
  //    two, this open would otherwise buy the token side, fail to fund the stable side, and leave
  //    the wallet holding half a position. Failing here costs nothing and says which balance is short.
  let wrapHash: string | undefined;
  if (hasWrapped()) {
    const wc = new ethers.Contract(C.weth, [...ERC20_ABI, "function deposit() payable"], w);
    const wbal: bigint = await wc.balanceOf!(w.address);
    if (wbal < total && cfg.lp.autoWrap) {
      const wtx = await wc.deposit!({ value: total - wbal, ...(await overrides()) });
      await wtx.wait();
      wrapHash = wtx.hash;
    }
  } else {
    const need = natWeiToStableRaw(total);
    const have: bigint = await new ethers.Contract(stableAddr(), ERC20_ABI, provider).balanceOf!(w.address).catch(() => 0n);
    if (have < need) {
      throw new Error(
        `${stableSym()} ERC-20 balance ${ethers.formatUnits(have, STABLE_DEC)} < needed ${ethers.formatUnits(need, STABLE_DEC)} — ` +
          `on this chain LP capital is paid with ${stableSym()} ERC-20, not native balance.`,
      );
    }
  }

  const { tickLower, tickUpper } = computeRange(st, "inrange");
  const fracC1 = valueFracC1(st.tick, tickLower, tickUpper);
  const wethForC1 = (total * BigInt(Math.round(fracC1 * 1e6))) / 1_000_000n;
  const wethForC0 = total - wethForC1;

  const bal = async (a: string): Promise<bigint> =>
    new ethers.Contract(a, ERC20_ABI, provider).balanceOf!(w.address).catch(() => 0n);

  // 2) buy each side from the funding currency through chain/router.ts (aggregator where the chain
  //    has one, Uniswap v3/v4 otherwise). REUSE the stable already in the wallet — buy only the
  //    SHORTFALL on that side (swapping when you already hold it just burns fees). The token side is
  //    always bought; the NPM refunds any excess so the position still lands ≈ the deposit, which is
  //    what bounds the stable actually pulled even when the wallet holds much more.
  let swapHash: string | undefined;
  /**
   * The funding currency, and the reason this is two lines instead of one.
   *
   * WITH a wrapped native (Robinhood): pay in WETH, which the wrap above just topped up, and the
   * amounts are already native-wei — identical to what this function has always done.
   *
   * WITHOUT one (Arc): there is nothing to wrap and no native-paired v3 pool to wrap INTO, so the
   * pay side is the pool's own dollar, the 6-decimal stable ERC-20. The budget arrives in NATIVE
   * wei (18-dec), so it has to be rescaled — `natWeiToStableRaw` is that exact integer 1e12 step.
   * Handing the 18-dec number straight to a 6-dec ERC-20 would try to spend a trillion times the
   * intended size; this is THE decimal hazard of the chain, in the one place that spends money.
   */
  const payWith = hasWrapped() ? C.weth : stableAddr();
  const payAmount = (natWei: bigint): bigint => (hasWrapped() ? natWei : natWeiToStableRaw(natWei));
  const acquire = async (addr: string, natAmt: bigint): Promise<void> => {
    if (natAmt < DUST_NAT_WEI) return;
    const amountIn = payAmount(natAmt);
    if (amountIn <= 0n) return;
    const label = isStableQuote(addr) ? stableSym() : "token";
    // swapBest throws only when EVERY venue declined, and its message names each one's reason —
    // strictly more diagnosable than the old "failed to buy X via Kyber", which was also what you got
    // on a chain that has no Kyber to fail.
    const r = await swapBest(payWith, ethers.getAddress(addr), amountIn).catch((e: Error) => {
      throw new Error(`failed to buy ${label}: ${e.message.slice(0, 160)}`);
    });
    if (r.amountOut <= 0n) throw new Error(`failed to buy ${label} — empty route`);
    swapHash = r.tx;
  };
  const px = await nativeUsd().catch(() => 0);
  const usdgIsC0 = isStableQuote(c0);
  const usdgAddr = usdgIsC0 ? c0 : c1;
  const tokAddr = usdgIsC0 ? c1 : c0;
  const wethForUsdg = usdgIsC0 ? wethForC0 : wethForC1;
  const wethForTok = usdgIsC0 ? wethForC1 : wethForC0;
  // Value the stable already in the wallet in NATIVE units so we buy only the shortfall.
  // px = nativeUsd(), so on a stable-native chain this is the exact 1e12 rescale, not a quote.
  const heldUsdgWethWei = usdToNatWei(Number(ethers.formatUnits(await bal(usdgAddr), STABLE_DEC)), px);
  const buyUsdgWei = wethForUsdg > heldUsdgWethWei ? wethForUsdg - heldUsdgWethWei : 0n;
  await acquire(tokAddr, wethForTok);
  // 0 when we already hold enough stable — and on a chain where the native IS the stable (Arc)
  // there is nothing to swap in the first place: it's the same dollar at a different scale.
  if (!nativeIsStableQuote()) await acquire(usdgAddr, buyUsdgWei);

  const [bal0, bal1] = await Promise.all([bal(c0), bal(c1)]);
  if (bal0 <= 0n || bal1 <= 0n) throw new Error("one side has balance 0 after swap (pool dry?)");

  // 3) approve both sides to the NPM
  for (const [a, need] of [[c0, bal0], [c1, bal1]] as const) {
    const erc = new ethers.Contract(a, ERC20_ABI, w);
    if ((await erc.allowance!(w.address, C.positionManager)) < need) {
      await (await erc.approve!(C.positionManager, ethers.MaxUint256, await overrides())).wait();
    }
  }

  const params = {
    token0: c0,
    token1: c1,
    fee: st.fee,
    tickLower,
    tickUpper,
    amount0Desired: bal0,
    amount1Desired: bal1,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: w.address,
    deadline: deadline(),
  };
  const sim = await npm.mint!.staticCall(params);
  if (sim.liquidity === 0n) throw new Error("liquidity 0 — deposit too small");
  const tx = await npm.mint!(params, await overrides());
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc);

  const usdgIs0 = isStableQuote(c0);
  const [m0, m1] = await Promise.all([tokenMeta(c0), tokenMeta(c1)]);
  const tokSym = usdgIs0 ? m1.symbol : m0.symbol;
  if (tokenId) {
    // basis: native budget for display; dep0/dep1 (amounts actually used) for LP-vs-HODL at close
    saveDeposit(tokenId, total, {
      mode: "inrange",
      quote: "usd",
      dep0: (sim.amount0 as bigint).toString(),
      dep1: (sim.amount1 as bigint).toString(),
    });
  }
  log.info(`open v3 ${stableSym()} in-range #${tokenId} ${m0.symbol}/${m1.symbol} fee ${st.fee / 10000}% ${fmtNat(total)} ${natSym()}`);
  return {
    tokenId,
    txHash: tx.hash,
    wrapHash,
    swapHash,
    mode: "inrange",
    tickLower,
    tickUpper,
    tick: st.tick,
    entryMcap: 0,
    swappedPct: 100,
    depositEth: fmtNat(total), // the CLAMPED size, not the request — the card must show what landed
    side: `IN RANGE ${tokSym}/${stableSym()} — fee ${(st.fee / 10000).toFixed(2)}% earning immediately`,
    liquidity: sim.liquidity.toString(),
  };
}

/**
 * SINGLE-SIDE STABLE on a token/<stable> v3 pool: park ONLY the stable (no token), range on the
 * all-stable side so the position stays 100% stable until the token PUMPS into range (rug-safe).
 * stable=token0 → range ABOVE tick; stable=token1 → range BELOW. Funds the stable from the native
 * budget via Kyber — except where the native IS the stable (Arc), where there is nothing to buy.
 */
export async function openV3StableSingleSide(pool: PoolInfo, amountEthStr: string): Promise<OpenResult> {
  // Only needed when the stable must actually be BOUGHT. Where the native already is the stable
  // (Arc) the wallet balance is the funding, so an absent aggregator is not a blocker.
  // Structural check, not a config one: funding the stable side means SPENDING the native budget,
  // and without a wrapped native there is no ERC-20 form of the native to spend — unless the native
  // IS the stable (Arc), where the wallet already holds it and nothing needs buying at all. The
  // old test named KyberSwap, which made an unconfigured aggregator look like the same failure as
  // a chain that structurally cannot do this.
  if (!hasWrapped() && !nativeIsStableQuote()) {
    throw new Error(`chain without wrapped native & native is not ${stableSym()} — no way to buy ${stableSym()} side from native budget.`);
  }
  const w = wallet();
  const st = await getPoolState(pool.pool);
  const c0 = st.token0;
  const c1 = st.token1;
  const usdgIs0 = isStableQuote(c0);
  const usdgIs1 = isStableQuote(c1);
  if (!usdgIs0 && !usdgIs1) throw new Error(`this pool is not a ${stableSym()} pair`);
  const usdgAddr = usdgIs0 ? c0 : c1;
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  // GAS FLOOR (not a cap) — see openV3StableInRange.
  const total = await budgetForOpen(parseNat(amountEthStr));

  // REUSE the stable already in the wallet — buy only the SHORTFALL to reach `total` worth (swapping
  // when you already hold enough just burns fees), then cap to the target so a big pre-held balance
  // doesn't oversize the position. Only wrap the amount actually needed for the buy.
  const usdgC = new ethers.Contract(usdgAddr, ERC20_ABI, provider);
  const px = await nativeUsd().catch(() => 0);
  // Budget (native) → target stable amount, AT THE STABLE'S DECIMALS. px = nativeUsd(), so on a
  // stable-native chain this is the exact 18→6 rescale of the budget, not a price guess.
  const targetUsdgRaw = px > 0 ? BigInt(Math.floor(Number(fmtNat(total)) * px * 10 ** STABLE_DEC)) : 0n;
  const held0: bigint = await usdgC.balanceOf!(w.address).catch(() => 0n);
  const buyWethWei =
    targetUsdgRaw > 0n
      ? targetUsdgRaw > held0
        ? usdToNatWei(Number(ethers.formatUnits(targetUsdgRaw - held0, STABLE_DEC)), px)
        : 0n
      : total; // no price → fall back to buying the full budget
  let wrapHash: string | undefined;
  let swapHash: string | undefined;
  // Nothing to buy where the native IS the stable (Arc): the wallet already holds it, in the
  // other representation. Swapping there would route a dollar through a router to get a dollar.
  if (buyWethWei >= DUST_NAT_WEI && !nativeIsStableQuote()) {
    if (hasWrapped()) {
      const wc = new ethers.Contract(C.weth, [...ERC20_ABI, "function deposit() payable"], w);
      const wbal: bigint = await wc.balanceOf!(w.address);
      if (wbal < buyWethWei && cfg.lp.autoWrap) {
        const wtx = await wc.deposit!({ value: buyWethWei - wbal, ...(await overrides()) });
        await wtx.wait();
        wrapHash = wtx.hash;
      }
    }
    // Only reachable WITH a wrapped native (the guard at the top of this function), so the pay
    // side is WETH and the amount is native wei — no rescale, same call the live bot makes today.
    const r = await swapBest(C.weth, ethers.getAddress(usdgAddr), buyWethWei).catch((e: Error) => {
      throw new Error(`failed to buy ${stableSym()}: ${e.message.slice(0, 160)}`);
    });
    if (r.amountOut <= 0n) throw new Error(`failed to buy ${stableSym()} — empty route`);
    swapHash = r.tx;
  }
  const heldNow: bigint = await usdgC.balanceOf!(w.address).catch(() => 0n);
  // Price KNOWN → cap to target (reuse held stable). Price UNKNOWN (px=0) → deposit ONLY what this
  // open just bought (heldNow - held0), NEVER the whole held balance (that dumped pre-held USDG on
  // Robinhood once). On a stable-native chain px is the constant 1, so the KNOWN branch always runs.
  const bought = heldNow > held0 ? heldNow - held0 : 0n;
  const usdgBal = targetUsdgRaw > 0n ? (heldNow > targetUsdgRaw ? targetUsdgRaw : heldNow) : bought;
  if (usdgBal <= 0n) throw new Error(`${stableSym()} balance 0 (no ${stableSym()} in wallet & failed to buy)`);

  // fresh tick + single-side range on the all-stable side (buffer so a moving price doesn't cross it)
  const pc = new ethers.Contract(pool.pool, POOL_ABI, provider);
  const tickNow = Number((await pc.slot0!()).tick);
  const sp = st.spacing;
  const width = widthInTicks(sp);
  const buf = cfg.lp.rangeBufferSpacings || 2;
  let tickLower: number;
  let tickUpper: number;
  if (usdgIs0) {
    tickLower = (Math.floor(tickNow / sp) + buf) * sp; // range ABOVE → all token0 (the stable)
    tickUpper = tickLower + width;
  } else {
    tickUpper = (Math.floor(tickNow / sp) - buf + 1) * sp; // range BELOW → all token1 (the stable)
    tickLower = tickUpper - width;
  }

  const erc = new ethers.Contract(usdgAddr, ERC20_ABI, w);
  if ((await erc.allowance!(w.address, C.positionManager)) < usdgBal) {
    await (await erc.approve!(C.positionManager, ethers.MaxUint256, await overrides())).wait();
  }

  const params = {
    token0: c0,
    token1: c1,
    fee: st.fee,
    tickLower,
    tickUpper,
    amount0Desired: usdgIs0 ? usdgBal : 0n,
    amount1Desired: usdgIs0 ? 0n : usdgBal,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: w.address,
    deadline: deadline(),
  };
  const sim = await npm.mint!.staticCall(params);
  if (sim.liquidity === 0n) throw new Error("liquidity 0 — deposit too small for this range");
  const tx = await npm.mint!(params, await overrides());
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc);

  const [mm0, mm1] = await Promise.all([tokenMeta(c0), tokenMeta(c1)]);
  const tokSym = usdgIs0 ? mm1.symbol : mm0.symbol;
  if (tokenId) {
    saveDeposit(tokenId, total, { mode: "single", quote: "usd", dep0: (sim.amount0 as bigint).toString(), dep1: (sim.amount1 as bigint).toString() });
  }
  log.info(`open v3 ${stableSym()} single-side #${tokenId} ${tokSym}/${stableSym()} fee ${st.fee / 10000}% ${fmtNat(total)} ${natSym()}`);
  return {
    tokenId,
    txHash: tx.hash,
    wrapHash,
    swapHash,
    mode: "single",
    tickLower,
    tickUpper,
    tick: tickNow,
    entryMcap: 0,
    swappedPct: 0,
    depositEth: fmtNat(total), // the CLAMPED size, not the request
    side: `SINGLE-SIDE ${stableSym()} — park ${stableSym()}, buy ${tokSym} only when in range (rug-safe)`,
    liquidity: sim.liquidity.toString(),
  };
}

/** MCAP range preview for the confirm screen, before minting. */
export async function previewRange(
  _tokenAddr: string,
  poolAddr: string,
  mode: MintMode = "single",
): Promise<RangePreview> {
  const st = await getPoolState(poolAddr);
  const { addr: _addr, meta } = await tokenSide(st);
  const { tickLower, tickUpper, swapFraction } = computeRange(st, mode);
  const px = await nativeUsd().catch(() => 0);
  const mLo = mcapAtTick(st, tickLower, px, meta.supplyUi);
  const mHi = mcapAtTick(st, tickUpper, px, meta.supplyUi);
  return {
    mode,
    mcapNow: mcapAtTick(st, st.tick, px, meta.supplyUi),
    rangeMcapLow: Math.min(mLo, mHi),
    rangeMcapHigh: Math.max(mLo, mHi),
    tickLower,
    tickUpper,
    tick: st.tick,
    swapPct: mode === "inrange" ? Math.round(swapFraction * 0.98 * 100) : 0,
  };
}

/**
 * Original mint timestamp of a position NFT — for positions opened manually on the web UI
 * (no positions.json record). Cached in memory AND back into positions.json (mintTs).
 *
 * The lookup itself is chain/indexer.ts's: this used to be a hand-rolled copy of exactly the
 * Blockscout call the indexer makes, which meant the bot had two answers to "when was this NFT
 * minted" and only one of them knew what to do on a chain with no Blockscout. (The indexer's rpc
 * backend reads the 0x0-sender Transfer log instead, so an Arc position still gets a real age
 * instead of falling back to "unknown" and reading as freshly opened to the age guards.)
 */
const mintTsCache = new Map<string, number | null>();
export async function mintTimestamp(tokenId: string): Promise<number | null> {
  const key = String(tokenId);
  if (mintTsCache.has(key)) return mintTsCache.get(key)!;
  const cached = loadDeposit(key)?.mintTs;
  if (cached) {
    mintTsCache.set(key, cached);
    return cached;
  }
  const ts = await nftMintTimestamp(C.positionManager, key).catch(() => null);
  mintTsCache.set(key, ts);
  if (ts) {
    const d = readJson<Record<string, DepositRecord>>(POS_FILE, {});
    d[key] = { ...(d[key] ?? ({} as DepositRecord)), mintTs: ts };
    writeJson(POS_FILE, d);
  }
  return ts;
}

/**
 * Try every configured V3 factory (canonical + forks like Lunya on Arc) to find the pool
 * for a given token pair + fee. Returns ZeroAddress when no factory has a pool deployed.
 */
async function resolveV3Pool(token0: string, token1: string, fee: number): Promise<string> {
  const factories = [C.factory, ...C.extraV3Factories];
  for (const addr of factories) {
    const f = new ethers.Contract(addr, FACTORY_ABI, provider);
    const pool: string = await f.getPool!(token0, token1, fee).catch(() => ethers.ZeroAddress);
    if (pool !== ethers.ZeroAddress) return pool;
  }
  return ethers.ZeroAddress;
}

/** All open positions with live PnL, valued exactly as a close would settle. */
export async function listPositions(): Promise<PositionRow[]> {
  const w = wallet();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, provider);
  const npmW = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const n = Number(await npm.balanceOf!(w.address).catch(() => 0n));
  const px = await nativeUsd().catch(() => 0);
  const { mapLimit } = await import("./blockscout.js");

  // Process every NFT index in PARALLEL (was a sequential for-loop → ~8 RPC round-trips per
  // position, one at a time; with many closed NFTs it dominated /list latency). ethers batches
  // the concurrent JSON-RPC calls, so this collapses to a handful of HTTP requests.
  const idxs = Array.from({ length: n }, (_, i) => i);
  const rows = (
    await mapLimit(idxs, 8, async (i): Promise<PositionRow | null> => {
      try {
        const id: bigint = await npm.tokenOfOwnerByIndex!(w.address, i);
        const p = await npm.positions!(id);
        if (p.liquidity === 0n) return null;
      // Try all V3 factories (canonical + forks like Lunya) to resolve the pool address.
      const pool: string = await resolveV3Pool(p.token0, p.token1, Number(p.fee));
      if (pool === ethers.ZeroAddress) return null;
      const st = await getPoolState(pool);
      const tl = Number(p.tickLower);
      const tu = Number(p.tickUpper);
      const inRange = st.tick >= tl && st.tick < tu;
      const [m0, m1] = await Promise.all([tokenMeta(p.token0), tokenMeta(p.token1)]);
      // isWrappedNative() is false on a chain with no WETH9, so on Arc EVERY position takes the
      // stable-quote branch — which is correct: no native-paired v3 pool can exist there.
      const wethIs0 = isWrappedNative(p.token0);
      const wethIs1 = isWrappedNative(p.token1);
      // non-native pair (e.g. token/USDG): value via the pool oracle in a self-contained branch,
      // so the battle-tested wrapped-native path below stays byte-for-byte unchanged.
      if (!wethIs0 && !wethIs1) return await stableQuotePositionRow(id, p, st, tl, tu, inRange, m0, m1, px, npmW);
      const tokMeta = wethIs0 ? m1 : m0;

      // exact principal (decreaseLiquidity.staticCall) + fees (collect.staticCall)
      let pr0 = 0n, pr1 = 0n, fe0 = 0n, fe1 = 0n;
      try {
        const d = await npmW.decreaseLiquidity!.staticCall({
          tokenId: id,
          liquidity: p.liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline: deadline(),
        });
        pr0 = d[0];
        pr1 = d[1];
      } catch {
        /* position may not simulate; leave 0 */
      }
      try {
        const fr = await npmW.collect!.staticCall({
          tokenId: id,
          recipient: w.address,
          amount0Max: MAX_U128,
          amount1Max: MAX_U128,
        });
        fe0 = fr[0];
        fe1 = fr[1];
      } catch {
        /* leave 0 */
      }

      const wethRaw = wethIs0 ? pr0 + fe0 : pr1 + fe1;
      const tokRaw = wethIs0 ? pr1 + fe1 : pr0 + fe0;
      const feeTokRaw = wethIs0 ? fe1 : fe0;
      const wethEth = Number(fmtNat(wethRaw));
      let tokEth = 0;
      if (tokRaw > 0n) {
        tokEth = (await quoteTokenToWeth(wethIs0 ? p.token1 : p.token0, tokRaw).catch(() => ({ weth: 0 }))).weth;
      }
      const valEth = wethEth + tokEth;
      const feeEth =
        Number(fmtNat(wethIs0 ? fe0 : fe1)) +
        (tokRaw > 0n ? tokEth * (Number(feeTokRaw) / Number(tokRaw)) : 0);

      const dep = loadDeposit(id.toString());
      const depEth = dep ? Number(fmtNat(dep.depositWeth)) : null;
      const pnlEth = depEth != null ? valEth - depEth : null;
      const pnlPct = depEth ? (pnlEth! / depEth) * 100 : null;

      const mcapNow = mcapAtTick(st, st.tick, px, tokMeta.supplyUi);
      const mLo = mcapAtTick(st, tl, px, tokMeta.supplyUi);
      const mHi = mcapAtTick(st, tu, px, tokMeta.supplyUi);
      const openedAt = dep?.ts ?? (await mintTimestamp(id.toString()));

      return {
        tokenId: id.toString(),
        pool,
        tokenAddr: wethIs0 ? ethers.getAddress(p.token1) : ethers.getAddress(p.token0),
        token0: m0.symbol,
        token1: m1.symbol,
        tokenSym: tokMeta.symbol,
        fee: Number(p.fee),
        inRange,
        tick: st.tick,
        tickLower: tl,
        tickUpper: tu,
        valEth,
        feeEth,
        depEth,
        pnlEth,
        pnlPct,
        mcapNow,
        rangeMcapLow: Math.min(mLo, mHi),
        rangeMcapHigh: Math.max(mLo, mHi),
        entryMcap: dep?.entryMcap ?? null,
        openedAt,
        ageMs: openedAt ? Date.now() - openedAt : null,
        ageSource: dep?.ts ? "bot" : openedAt ? "onchain" : null,
        mode: dep?.mode ?? "single",
        nat: natSym(),
        chainId: chainId(),
      };
    } catch (e) {
      log.warn(`skip position index ${i}: ${errShort(e)}`); // no longer a silent skip
      return null;
    }
    })
  ).filter((r): r is PositionRow => r !== null);
  return rows;
}

/**
 * Value a token/<stable> v3 position (no wrapped-native leg) for /list. Principal + fees come from
 * the same decreaseLiquidity/collect staticCalls as the native path; each side is priced via the
 * pool oracle (stable ≈ $1, token priced in the stable by the pool). PnL is LP-vs-HODL: the
 * deposited amounts valued at the CURRENT price, so a token merely dropping in price isn't counted
 * as an LP loss. This is the ONLY row builder that runs on a chain without a wrapped native.
 */
async function stableQuotePositionRow(
  id: bigint,
  p: any,
  st: PoolState,
  tl: number,
  tu: number,
  inRange: boolean,
  m0: TokenMeta,
  m1: TokenMeta,
  px: number,
  npmW: ethers.Contract,
): Promise<PositionRow | null> {
  const usdgIs0 = isStableQuote(st.token0);
  const usdgIs1 = isStableQuote(st.token1);
  if (!usdgIs0 && !usdgIs1) return null; // neither side is the stable → unknown quote, skip safely

  let pr0 = 0n, pr1 = 0n, fe0 = 0n, fe1 = 0n;
  try {
    const d = await npmW.decreaseLiquidity!.staticCall({ tokenId: id, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: deadline() });
    pr0 = d[0];
    pr1 = d[1];
  } catch {
    /* leave 0 */
  }
  try {
    const fr = await npmW.collect!.staticCall({ tokenId: id, recipient: wallet().address, amount0Max: MAX_U128, amount1Max: MAX_U128 });
    fe0 = fr[0];
    fe1 = fr[1];
  } catch {
    /* leave 0 */
  }

  const valUsd = currencyUsd(st, true, pr0 + fe0, px) + currencyUsd(st, false, pr1 + fe1, px);
  const feeUsd = currencyUsd(st, true, fe0, px) + currencyUsd(st, false, fe1, px);
  const valEth = px ? valUsd / px : 0;
  const feeEth = px ? feeUsd / px : 0;

  const tokMeta = usdgIs0 ? m1 : m0;
  const tokenAddr = usdgIs0 ? st.token1 : st.token0;
  const tokIsSide0 = !usdgIs0;
  const oneTok = ethers.parseUnits("1", tokMeta.decimals);
  const mcapNow = currencyUsd(st, tokIsSide0, oneTok, px) * tokMeta.supplyUi;

  const dep = loadDeposit(id.toString());
  // LP-vs-HODL basis: deposited amounts valued at CURRENT price (isolates fees + IL)
  const basisUsd = dep?.dep0 && dep?.dep1 ? currencyUsd(st, true, BigInt(dep.dep0), px) + currencyUsd(st, false, BigInt(dep.dep1), px) : null;
  const depEth = basisUsd != null && px ? basisUsd / px : dep ? Number(fmtNat(dep.depositWeth)) : null;
  const pnlEth = depEth != null ? valEth - depEth : null;
  const pnlPct = depEth ? (pnlEth! / depEth) * 100 : null;
  const openedAt = dep?.ts ?? (await mintTimestamp(id.toString()));

  return {
    tokenId: id.toString(),
    pool: st.pool,
    tokenAddr: ethers.getAddress(tokenAddr),
    token0: m0.symbol,
    token1: m1.symbol,
    tokenSym: tokMeta.symbol,
    pair: `${tokMeta.symbol}/${stableSym()}`,
    quote: "usd",
    fee: st.fee,
    inRange,
    tick: st.tick,
    tickLower: tl,
    tickUpper: tu,
    valEth,
    feeEth,
    depEth,
    pnlEth,
    pnlPct,
    mcapNow,
    rangeMcapLow: 0,
    rangeMcapHigh: 0,
    entryMcap: dep?.entryMcap ?? null,
    openedAt,
    ageMs: openedAt ? Date.now() - openedAt : null,
    ageSource: dep?.ts ? "bot" : openedAt ? "onchain" : null,
    mode: dep?.mode ?? "inrange",
    nat: natSym(),
    chainId: chainId(),
  };
}

/**
 * Close: decreaseLiquidity → collect → burn → (optionally) swap token → ETH → top up gas.
 * Records a permanent ledger entry with ETH/USD locked at close time.
 */
export async function closePosition(
  tokenId: string,
  opts: { swapToken?: boolean } = {},
): Promise<CloseResult> {
  const swapToken = opts.swapToken !== false && cfg.lp.autoSwapOnClose !== false;
  const w = wallet();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const p = await npm.positions!(tokenId);
  const [m0, m1] = await Promise.all([tokenMeta(p.token0), tokenMeta(p.token1)]);
  const wethIs0 = isWrappedNative(p.token0);
  const wethIs1 = isWrappedNative(p.token1);
  // non-native pair (token/stable): dedicated close path (LP-vs-HODL PnL, USD-denominated).
  // On a chain with no wrapped native every close lands here.
  if (!wethIs0 && !wethIs1) return closeV3StablePosition(tokenId, opts);

  // exact principal + fee via staticCall (no float liquidity math)
  let pr0 = 0n, pr1 = 0n, fe0 = 0n, fe1 = 0n;
  if (p.liquidity > 0n) {
    try {
      const d = await npm.decreaseLiquidity!.staticCall({
        tokenId,
        liquidity: p.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: deadline(),
      });
      pr0 = d[0];
      pr1 = d[1];
    } catch {
      /* leave 0 */
    }
  }
  try {
    const fr = await npm.collect!.staticCall({
      tokenId,
      recipient: w.address,
      amount0Max: MAX_U128,
      amount1Max: MAX_U128,
    });
    fe0 = fr[0];
    fe1 = fr[1];
  } catch {
    /* leave 0 */
  }
  const wethOutRaw = wethIs0 ? pr0 + fe0 : pr1 + fe1;
  const feeWethRaw = wethIs0 ? fe0 : fe1;
  const recvWethEth = Number(fmtNat(wethOutRaw));
  const feeEthOnly = Number(fmtNat(feeWethRaw));

  const dep = loadDeposit(String(tokenId));
  const depEth = dep ? Number(fmtNat(dep.depositWeth)) : null;

  // ── execute ──
  let decreaseHash: string | null = null;
  if (p.liquidity > 0n) {
    const dtx = await npm.decreaseLiquidity!(
      { tokenId, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: deadline() },
      await overrides(),
    );
    await dtx.wait();
    decreaseHash = dtx.hash;
  }
  const ctx = await npm.collect!(
    { tokenId, recipient: w.address, amount0Max: MAX_U128, amount1Max: MAX_U128 },
    await overrides(),
  );
  await ctx.wait();
  let burnHash: string | null = null;
  try {
    const btx = await npm.burn!(tokenId, await overrides());
    await btx.wait();
    burnHash = btx.hash;
  } catch {
    /* dust position may block burn — non-fatal */
  }

  // ── auto-swap token → ETH (timeout so close can't hang) ──
  const tokenMint = wethIs0 ? p.token1 : p.token0;
  const tokDec = wethIs0 ? m1.decimals : m0.decimals;
  let swapHash: string | null = null;
  let swappedWeth = 0;
  let tokenStuck = 0;
  let tokenSellEth = 0;
  const raw = await tokenBalanceRaw(tokenMint).catch(() => 0n);
  if (raw > 0n) {
    tokenSellEth = (await quoteTokenToWeth(tokenMint, raw).catch(() => ({ weth: 0 }))).weth;
    if (swapToken) {
      try {
        const sw = await Promise.race([
          swapTokenToWeth(tokenMint, raw),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 60_000)),
        ]);
        swapHash = sw.tx;
        swappedWeth = Number(fmtNat(sw.amountOut));
      } catch {
        tokenStuck = Number(ethers.formatUnits(raw, tokDec));
      }
    } else {
      tokenStuck = Number(ethers.formatUnits(raw, tokDec));
    }
  }

  const realOutEth = recvWethEth + (swappedWeth > 0 ? swappedWeth : tokenSellEth);
  const pnlEthReal = depEth != null ? realOutEth - depEth : null;
  const pnlPctReal = depEth ? (pnlEthReal! / depEth) * 100 : null;

  deleteDeposit(String(tokenId));

  // Top-up = unwrap WETH → native so the NEXT tx has gas. There is nothing to unwrap on a chain
  // with no wrapped native (Arc), where the close proceeds are already the native currency —
  // calling it there would just hit the zero address. Guarded, not removed: on Robinhood this is
  // byte-for-byte the same call (same cfg.lp.nativeTargetEth, so a /set override still applies).
  let topUp = null;
  if (hasWrapped()) {
    try {
      topUp = await ensureNativeEth(cfg.lp.nativeTargetEth);
    } catch {
      /* non-blocking */
    }
  }

  const openedAt = dep?.ts ?? dep?.mintTs ?? null;
  const heldMs = openedAt ? Date.now() - openedAt : null;
  const tokSym = wethIs0 ? m1.symbol : m0.symbol;
  const pxClose = await nativeUsd().catch(() => 0);

  try {
    appendLedger({
      tokenId: String(tokenId),
      sym: tokSym,
      mode: dep?.mode ?? "single",
      openedAt,
      closedAt: Date.now(),
      heldMs,
      depEth: depEth ?? 0,
      outEth: realOutEth,
      feeEth: feeEthOnly,
      pnlEth: pnlEthReal,
      pnlPct: pnlPctReal,
      pnlUsd: pnlEthReal != null && pxClose ? pnlEthReal * pxClose : null,
      ethUsdAtClose: pxClose || null,
      entryMcap: dep?.entryMcap ?? null,
      tokenKept: !swapToken && tokenStuck > 0 ? tokenStuck : 0,
      tokenRug: swapToken && tokenStuck > 0 ? tokenStuck : 0,
    });
  } catch (e) {
    log.warn(`ledger append failed (close still succeeded): ${errShort(e)}`);
  }

  log.info(`close #${tokenId} ${tokSym} pnl=${pnlEthReal?.toFixed(6) ?? "?"} ${natSym()}`);
  return {
    heldMs,
    decreaseHash,
    collectHash: ctx.hash,
    burnHash,
    swapHash,
    topUp,
    wethSym: wethIs0 ? m0.symbol : m1.symbol,
    tokenSym: tokSym,
    recvWeth: recvWethEth,
    recvToken: raw > 0n ? Number(ethers.formatUnits(raw, tokDec)) : 0,
    swappedWeth,
    tokenStuck,
    valEth: realOutEth,
    depEth,
    pnlEth: pnlEthReal,
    pnlPct: pnlPctReal,
  };
}

/**
 * Close a token/<stable> v3 position (no wrapped-native leg). decreaseLiquidity → collect → burn
 * (generic), value both sides via the pool oracle (stable ≈ $1), then sell BOTH sides → native via
 * Kyber to realize + top up gas. PnL is LP-vs-HODL (deposited amounts valued at the CLOSE price),
 * so a token that only dropped in price isn't counted as an LP loss — matches the v4 stable path.
 */
export async function closeV3StablePosition(tokenId: string, opts: { swapToken?: boolean } = {}): Promise<CloseResult> {
  const swapToken = opts.swapToken !== false && cfg.lp.autoSwapOnClose !== false;
  const w = wallet();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const p = await npm.positions!(tokenId);
  const pool: string = await resolveV3Pool(p.token0, p.token1, Number(p.fee));
  const st = await getPoolState(pool);
  const [m0, m1] = await Promise.all([tokenMeta(p.token0), tokenMeta(p.token1)]);
  const usdgIs0 = isStableQuote(st.token0);
  const px = await nativeUsd().catch(() => 0);

  // principal + fees via staticCall (current price, before touching the pool)
  let pr0 = 0n, pr1 = 0n, fe0 = 0n, fe1 = 0n;
  if (p.liquidity > 0n) {
    try {
      const d = await npm.decreaseLiquidity!.staticCall({ tokenId, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: deadline() });
      pr0 = d[0];
      pr1 = d[1];
    } catch {
      /* leave 0 */
    }
  }
  try {
    const fr = await npm.collect!.staticCall({ tokenId, recipient: w.address, amount0Max: MAX_U128, amount1Max: MAX_U128 });
    fe0 = fr[0];
    fe1 = fr[1];
  } catch {
    /* leave 0 */
  }
  const outUsd = currencyUsd(st, true, pr0 + fe0, px) + currencyUsd(st, false, pr1 + fe1, px);
  const feeUsd = currencyUsd(st, true, fe0, px) + currencyUsd(st, false, fe1, px);
  const outEth = px ? outUsd / px : 0;
  const feeEthOnly = px ? feeUsd / px : 0;

  const dep = loadDeposit(String(tokenId));
  const basisUsd = dep?.dep0 && dep?.dep1 ? currencyUsd(st, true, BigInt(dep.dep0), px) + currencyUsd(st, false, BigInt(dep.dep1), px) : null;
  const basisEth = basisUsd != null && px ? basisUsd / px : dep ? Number(fmtNat(dep.depositWeth)) : null;

  // ── execute close ──
  let decreaseHash: string | null = null;
  if (p.liquidity > 0n) {
    const dtx = await npm.decreaseLiquidity!({ tokenId, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: deadline() }, await overrides());
    await dtx.wait();
    decreaseHash = dtx.hash;
  }
  const ctx = await npm.collect!({ tokenId, recipient: w.address, amount0Max: MAX_U128, amount1Max: MAX_U128 }, await overrides());
  await ctx.wait();
  let burnHash: string | null = null;
  try {
    const btx = await npm.burn!(tokenId, await overrides());
    await btx.wait();
    burnHash = btx.hash;
  } catch {
    /* dust position may block burn — non-fatal */
  }

  // ── sell BOTH sides → the native currency via Kyber (best route) so PnL realizes + gas tops up.
  //    Where the native IS the stable (Arc) the stable side is ALREADY the gas currency in its
  //    other representation, so only the volatile token needs selling. ──
  const usdg = usdgIs0 ? st.token0 : st.token1;
  const tokenMint = usdgIs0 ? st.token1 : st.token0;
  const tokDec = usdgIs0 ? m1.decimals : m0.decimals;
  const tokSym = usdgIs0 ? m1.symbol : m0.symbol;
  let swapHash: string | null = null;
  let tokenStuck = 0;
  if (swapToken) {
    const sides = nativeIsStableQuote() ? [tokenMint] : [tokenMint, usdg];
    for (const a of sides) {
      const raw = await tokenBalanceRaw(a).catch(() => 0n);
      if (raw <= 0n) continue;
      try {
        // Sell INTO the native currency where an aggregator can reach it (Robinhood: this is the
        // same kyberSwap(a, KYBER_NATIVE, raw) call, now with a Uniswap fallback behind it instead
        // of the token going straight to `tokenStuck` on one bad aggregator response). Where it
        // cannot (Arc), sell into the default quote — the 6-dec USDC ERC-20, which on that chain
        // IS the gas currency in its other representation, so the proceeds still top gas up.
        const sellTo = kyberEnabled() ? KYBER_NATIVE : defaultQuoteAddr();
        const k = await Promise.race([
          swapBest(a, sellTo, raw),
          new Promise<null>((res) => setTimeout(() => res(null), 60_000)),
        ]);
        if (k?.tx) swapHash = k.tx;
        else if (a === tokenMint) tokenStuck = Number(ethers.formatUnits(raw, tokDec));
      } catch {
        if (a === tokenMint) tokenStuck = Number(ethers.formatUnits(raw, tokDec));
      }
    }
  } else {
    const raw = await tokenBalanceRaw(tokenMint).catch(() => 0n);
    if (raw > 0n) tokenStuck = Number(ethers.formatUnits(raw, tokDec));
  }

  const pnlEth = basisEth != null && basisEth > 0 ? outEth - basisEth : null;
  const pnlPct = pnlEth != null && basisEth ? (pnlEth / basisEth) * 100 : null;

  deleteDeposit(String(tokenId));
  // Top-up = unwrap WETH → native so the NEXT tx has gas. There is nothing to unwrap on a chain
  // with no wrapped native (Arc), where the close proceeds are already the native currency —
  // calling it there would just hit the zero address. Guarded, not removed: on Robinhood this is
  // byte-for-byte the same call (same cfg.lp.nativeTargetEth, so a /set override still applies).
  let topUp = null;
  if (hasWrapped()) {
    try {
      topUp = await ensureNativeEth(cfg.lp.nativeTargetEth);
    } catch {
      /* non-blocking */
    }
  }

  const openedAt = dep?.ts ?? dep?.mintTs ?? null;
  const heldMs = openedAt ? Date.now() - openedAt : null;
  try {
    appendLedger({
      tokenId: String(tokenId),
      sym: tokSym,
      version: "v3",
      pair: `${tokSym}/${stableSym()}`,
      quote: "usd",
      mode: dep?.mode ?? "inrange",
      openedAt,
      closedAt: Date.now(),
      heldMs,
      depEth: basisEth ?? 0,
      outEth,
      feeEth: feeEthOnly,
      pnlEth,
      pnlPct,
      pnlUsd: pnlEth != null && px ? pnlEth * px : null,
      ethUsdAtClose: px || null,
      entryMcap: dep?.entryMcap ?? null,
      tokenKept: !swapToken && tokenStuck > 0 ? tokenStuck : 0,
      tokenRug: swapToken && tokenStuck > 0 ? tokenStuck : 0,
    });
  } catch (e) {
    log.warn(`ledger append failed (${stableSym()} close still succeeded): ${errShort(e)}`);
  }

  log.info(`close v3 ${stableSym()} #${tokenId} ${tokSym}/${stableSym()} pnl=${pnlEth?.toFixed(6) ?? "?"} ${natSym()}`);
  return {
    heldMs,
    decreaseHash,
    collectHash: ctx.hash,
    burnHash,
    swapHash,
    topUp,
    // handlers.ts keys its "is this a stable close?" card off wethSym === the stable symbol
    wethSym: stableSym(),
    tokenSym: tokSym,
    recvWeth: 0,
    recvToken: 0,
    swappedWeth: outEth,
    tokenStuck,
    valEth: outEth,
    depEth: basisEth,
    pnlEth,
    pnlPct,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function errShort(e: unknown): string {
  const m = (e as any)?.shortMessage || (e as Error)?.message || String(e);
  return String(m).slice(0, 120);
}

