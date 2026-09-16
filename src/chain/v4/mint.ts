/**
 * v4 LP open — single-sided native currency (rug-safe, no Permit2, no token needed) and the
 * token/<stable> two-ERC-20 paths.
 *
 * Verified by staticCall simulation on chain 4663: single-sided native means a range ABOVE the
 * current tick (native = currency0, not yet converted to token). The @uniswap/v4-sdk generates
 * the modifyLiquidities calldata + native value; we simulate every mint with eth_call BEFORE
 * broadcasting, so a mint that would revert never costs gas.
 *
 * CHAIN-CONDITIONAL: the native-currency paths only exist where the profile allows the 0x0
 * sentinel in a pool key (venues.v4NativeCurrency). On Arc it does not — native USDC is 18-dec
 * while the pool currency is the 6-dec ERC-20 predeploy — so there every pool key is
 * ERC-20/ERC-20, every mint value is 0, and only the <stable> paths below run.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider, overrides, waitTx } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { discoverV4Pools, pickV4Pool, type V4Pool } from "./discover.js";
import { swapEthToTokenV4, quoteV4 } from "./swap.js";
import { kyberSwap, kyberEnabled, KYBER_NATIVE } from "../kyber.js";
import { swapBest } from "../router.js";
import { defaultQuoteAddr } from "../swaps.js";
import { computePoolId, isNativeCurrency, v4NativeCurrencyAllowed, type PoolKey } from "./poolkey.js";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { mapLimit } from "../blockscout.js";
import { WETH_ABI } from "../abis.js";
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
  stableAddr,
  stableSym,
  stableDecimals,
  usdToNatWei,
  nativeIsStableQuote,
  natWeiToStableRaw,
  stableRawToNatWei,
} from "../currency.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const { Ether, Token, Percent, CurrencyAmount } = sdkCore as any;
const { Pool, Position, V4PositionManager } = v4sdk as any;
const log = logger("v4mint");
const POS_FILE = dataPath("v4-positions.json");
// Permit2: profile-pinned where the chain pins it, canonical CREATE2 otherwise — resolved in
// config.ts so this file and v4/swap.ts cannot disagree about which Permit2 is real.
const PERMIT2 = C.permit2;
const STABLE_DEC = stableDecimals();
// Below this a swap costs more gas than it moves. parseNat() keeps Robinhood at exactly the old
// parseEther("0.00002") = 2e13 wei.
const DUST_NAT_WEI = parseNat("0.00002");

export interface V4OpenResult {
  tokenId: string | null;
  txHash: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  depositEth: string;
  poolId: string;
}

/**
 * `depositWei` keeps its name (data/v4-positions.json is written by the LIVE bot and is never
 * migrated); its VALUE is native wei, which is 18-dec USDC on Arc, not ether. NEW records carry
 * nat + chainId; old ones have neither and are Robinhood/ETH by definition.
 */
type V4Dep = {
  depositWei: string; ts: number; poolId: string; fee: number; tickLower: number; tickUpper: number;
  mode: string; dep0?: string; dep1?: string; nat?: string; chainId?: number;
};

export function saveV4Deposit(tokenId: string, rec: V4Dep): void {
  const d = readJson<Record<string, V4Dep>>(POS_FILE, {});
  d[tokenId] = { nat: natSym(), chainId: chainId(), ...rec };
  writeJson(POS_FILE, d);
}
export function loadV4Deposit(tokenId: string): V4Dep | null {
  return readJson<Record<string, V4Dep>>(POS_FILE, {})[tokenId] ?? null;
}

const NATIVE_GAS_BUFFER = parseNat("0.0003"); // keep some native for tx gas

/**
 * v4 native mints settle the native side as NATIVE (not wrapped). If the wallet is mostly WETH
 * (common — v3 wraps, closes unwrap-partially), the mint's native `value` exceeds the native
 * balance and the sim reverts with empty data ("missing revert data"). Unwrap the shortfall
 * WETH → native first so native covers the deposit + gas.
 *
 * The check is a GUARD and stays on every chain; only the UNWRAP is conditional. Without a
 * wrapped native (Arc) there is nothing to unwrap FROM, so a shortfall is fatal here rather than
 * half-way through the mint — and the caller has already clamped its size to the native balance
 * minus the gas reserve, so a shortfall means the wallet genuinely can't fund the position.
 */
async function ensureNativeBalance(needWei: bigint): Promise<void> {
  const w = wallet();
  const bal = await provider.getBalance(w.address);
  if (bal >= needWei) return;
  const short = needWei - bal;
  if (!hasWrapped()) {
    throw new Error(
      `${natSym()} native insufficient for v4 mint: need ${fmtNat(needWei)}, have ${fmtNat(bal)} — this chain has no wrapped native to unwrap.`,
    );
  }
  const weth = new ethers.Contract(C.weth, WETH_ABI, w);
  const wbal: bigint = await weth.balanceOf!(w.address).catch(() => 0n);
  if (wbal < short) {
    throw new Error(
      `${natSym()} native insufficient for v4 mint: need ${fmtNat(needWei)}, have ${fmtNat(bal)} native + ${fmtNat(wbal)} wrapped`,
    );
  }
  log.info(`unwrap ${fmtNat(short)} wrapped → ${natSym()} native (v4 needs native)`);
  await waitTx(await weth.withdraw!(short, await overrides()), "v4-unwrap");
}

/**
 * SDK Pool for a NATIVE-paired v4 pool. Only ever called from the native paths, which are
 * themselves gated on v4NativeCurrencyAllowed() — the assert is the backstop that keeps an
 * Ether.onChain() currency (18 dec, "ETH") from being built on a chain where the pool's real
 * currency is a 6-dec ERC-20.
 */
function buildSdkPool(token: string, decimals: number, symbol: string, pool: V4Pool) {
  requireNativeV4();
  const eth = Ether.onChain(cfg.chainId);
  const tok = new Token(cfg.chainId, ethers.getAddress(token), decimals, symbol);
  return new Pool(
    eth,
    tok,
    pool.fee,
    pool.tickSpacing,
    pool.poolKey.hooks,
    pool.sqrtPriceX96.toString(),
    pool.liquidity.toString(),
    pool.tick,
  );
}

/**
 * Refuse a native-currency v4 operation on a chain whose profile forbids the 0x0 sentinel.
 * The message names the alternative so the caller (or the operator) knows what to do instead.
 */
function requireNativeV4(): void {
  if (!v4NativeCurrencyAllowed()) {
    throw new Error(`v4 pool with ${natSym()} native pair not available on this chain (currency 0x0 rejected) — use /${stableSym()} pool`);
  }
}

/**
 * Open a single-sided native-currency v4 position at the highest-fee pool with liquidity
 * (or a specific fee tier). Simulates before broadcasting.
 */
export async function openV4SingleSide(
  token: string,
  amountEthStr: string,
  opts: { fee?: number; widthSpacings?: number } = {},
): Promise<V4OpenResult> {
  requireNativeV4();
  const w = wallet();
  const pools = await discoverV4Pools(token);
  const pool = opts.fee ? pools.find((p) => p.fee === opts.fee) ?? null : pickV4Pool(pools);
  if (!pool) throw new Error(`no v4/${natSym()} pool with liquidity`);

  const meta = await tokenMeta(token);
  const sdkPool = buildSdkPool(token, meta.decimals, meta.symbol, pool);

  // single-sided native → range ABOVE current tick (native not yet sold into token)
  const sp = pool.tickSpacing;
  const width = Math.max(1, opts.widthSpacings ?? Math.round((cfg.lp.widthPct / 100) / (Math.pow(1.0001, sp) - 1)));
  const tickLower = Math.ceil(pool.tick / sp) * sp + sp;
  const tickUpper = tickLower + width * sp;
  // GAS FLOOR (not a cap): no-op where the LP budget is funded from a separate wrapped balance.
  const amountWei = await budgetForOpen(parseNat(amountEthStr));
  // single-side parks NATIVE — unwrap wrapped if native is short
  await ensureNativeBalance(amountWei + NATIVE_GAS_BUFFER);

  const position = Position.fromAmount0({
    pool: sdkPool,
    tickLower,
    tickUpper,
    amount0: amountWei.toString(),
    useFullPrecision: true,
  });
  if (position.liquidity.toString() === "0") throw new Error("liquidity 0 — deposit too small for this range");

  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    recipient: w.address,
    slippageTolerance: new Percent(Math.round((cfg.lp.slippagePct || 5)), 100),
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
    useNative: Ether.onChain(cfg.chainId),
  });

  // SIMULATE before spending gas
  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulation mint v4 revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }

  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  const rc = await waitTx(tx, "v4-mint");
  const tokenId = tokenIdFromReceipt(rc!);
  if (tokenId) {
    saveV4Deposit(tokenId, {
      depositWei: amountWei.toString(),
      ts: Date.now(),
      poolId: pool.poolId,
      fee: pool.fee,
      tickLower,
      tickUpper,
      mode: "single",
    });
  }
  log.info(`open v4 #${tokenId} ${meta.symbol} fee ${pool.fee / 10000}% ${fmtNat(amountWei)} ${natSym()}`);
  return { tokenId, txHash: tx.hash, fee: pool.fee, tickLower, tickUpper, depositEth: fmtNat(amountWei), poolId: pool.poolId };
}

/**
 * Open an IN-RANGE native-ETH v4 position (farming: earns fees immediately). Swaps part of
 * the ETH → token via the UniversalRouter, approves the token through Permit2, then mints a
 * range straddling the current price. Simulates before broadcasting.
 */
/**
 * After a two-sided v4 mint, sell any UN-DEPOSITED leftover back to native ETH. v4 (unlike the v3 NPM)
 * does NOT refund the excess side, so a both-sided add always leaves a bit of one currency in the
 * wallet ("always some leftover"). Sweep it → ETH so nothing accumulates + token exposure drops. Best-effort;
 * skips the native currency / its wrapper and sub-$0.30 stable dust (gas > value).
 */
async function sweepLeftoverToEth(sides: Array<{ addr: string; dec: number }>): Promise<string | undefined> {
  const w = wallet();
  // WHERE the leftover is sold. It used to bail out entirely when the aggregator was unconfigured,
  // which on a chain the aggregator does not serve (Arc) meant leftovers were never swept at all —
  // they just accumulated in the wallet after every both-sided add. Same shape as the v3 stable
  // close in positions.ts: sell into the native currency where an aggregator can reach it, into the
  // default quote otherwise (on Arc the 6-dec USDC ERC-20, which IS the gas currency in its other
  // representation, so the proceeds still land where gas is paid from).
  const sellTo = kyberEnabled() ? KYBER_NATIVE : defaultQuoteAddr();
  // amountOut comes back in whatever we sold INTO. Only a native-denominated output may be read
  // with fmtNat(): the stable is 6-dec, so it goes through the exact integer rescale first —
  // formatting a 6-dec raw at 18 dec under-reports by 1e12, the chain's signature hazard.
  const outAsNat = (out: bigint): bigint =>
    !isStableQuote(sellTo) ? out : nativeIsStableQuote() ? stableRawToNatWei(out) : 0n;
  // $0.30 of the stable, at the stable's own decimals (300_000 at 6 dec — the previous literal).
  const stableDust = BigInt(Math.round(0.3 * 10 ** STABLE_DEC));
  let hash: string | undefined;
  for (const { addr, dec } of sides) {
    // already native-equivalent (the 0x0 sentinel, the wrapper, or — on Arc — the stable IS the
    // native currency in its ERC-20 representation, so sweeping it would be a round trip)
    if (isNativeCurrency(addr) || isWrappedNative(addr)) continue;
    if (nativeIsStableQuote() && isStableQuote(addr)) continue;
    const erc = new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider);
    const raw: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
    if (raw <= 0n) continue;
    if (isStableQuote(addr) && raw < stableDust) continue; // skip <$0.30 stable dust
    try {
      const k = await swapBest(addr, sellTo, raw);
      if (k.tx) {
        hash = k.tx;
        log.info(`sweep leftover ${ethers.formatUnits(raw, dec)} ${isStableQuote(addr) ? stableSym() : "token"} → ${fmtNat(outAsNat(k.amountOut))} ${natSym()}`);
      }
    } catch {
      /* best-effort — leave it in the wallet if the swap fails */
    }
  }
  return hash;
}

export async function openV4InRange(
  token: string,
  amountEthStr: string,
  opts: { fee?: number; widthSpacings?: number } = {},
): Promise<V4OpenResult & { swapHash?: string; swappedPct: number }> {
  requireNativeV4();
  const w = wallet();
  const pools = await discoverV4Pools(token);
  const pool = opts.fee ? pools.find((p) => p.fee === opts.fee) ?? null : pickV4Pool(pools);
  if (!pool) throw new Error(`no v4/${natSym()} pool with liquidity`);
  const meta = await tokenMeta(token);
  const sp = pool.tickSpacing;

  // symmetric range straddling current tick
  const halfSpacings = Math.max(1, Math.round((opts.widthSpacings ?? 8) / 2));
  const anchor = Math.floor(pool.tick / sp) * sp;
  let tickLower = anchor - halfSpacings * sp;
  let tickUpper = anchor + halfSpacings * sp;

  // GAS FLOOR (not a cap) — no-op where a wrapped native funds the budget.
  const total = await budgetForOpen(parseNat(amountEthStr));
  // v4 needs NATIVE for both the swap and the mint value — unwrap wrapped if native is short
  await ensureNativeBalance(total + NATIVE_GAS_BUFFER);
  let sdkPool = buildSdkPool(token, meta.decimals, meta.symbol, { ...pool });
  // Exact sentinel test, chain-gated. The old prefix match ("0x000000000000000000"…) would also
  // have matched any vanity address with 18 leading zero nibbles.
  const isC0Native = isNativeCurrency(pool.poolKey.currency0);
  const tokCur = isC0Native ? sdkPool.currency1 : sdkPool.currency0;
  const priceTokenInEth = (raw: bigint): bigint => {
    if (raw <= 0n) return 0n;
    try {
      return BigInt(sdkPool.priceOf(tokCur).quote(CurrencyAmount.fromRawAmount(tokCur, raw.toString())).quotient.toString());
    } catch {
      return 0n;
    }
  };

  const erc = new ethers.Contract(
    token,
    [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
    ],
    w,
  );

  // REUSE token we already hold (e.g. bought on a prior failed attempt) — don't re-buy.
  const tokenHave: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
  const haveEthValue = priceTokenInEth(tokenHave);

  // token value (in ETH) this range wants; swap ONLY the shortfall (0 if we already hold enough)
  const frac = Math.min(0.9, Math.max(0.05, swapFractionV4(pool.tick, tickLower, tickUpper) * 0.98));
  const targetTokenEth = (total * BigInt(Math.round(frac * 1e6))) / 1_000_000n;
  let ethToSwap = targetTokenEth > haveEthValue ? targetTokenEth - haveEthValue : 0n;
  const maxSwap = (total * 9n) / 10n;
  if (ethToSwap > maxSwap) ethToSwap = maxSwap;

  // 1) buy the token shortfall with the BEST execution. Route via the KyberSwap aggregator
  //    (auto multi-hop across every DEX/fee-tier/hook → lowest fee + price impact). Buying on
  //    the high-fee pool you're farming would bleed fee + slippage = instant loss. Falls back
  //    to a direct v4 swap on the deepest single pool if the aggregator can't route.
  let swapHash: string | undefined;
  let swappedPct = 0;
  if (ethToSwap >= DUST_NAT_WEI) {
    let out = 0n;
    if (kyberEnabled()) {
      const k = await kyberSwap(KYBER_NATIVE, ethers.getAddress(token), ethToSwap).catch((e) => {
        log.warn(`kyber failed (${(e as Error).message.slice(0, 80)}) → fallback v4 direct`);
        return null;
      });
      if (k && k.amountOut > 0n) {
        swapHash = k.tx;
        out = k.amountOut;
        log.info(`bought ${meta.symbol} via KyberSwap (best route) → ${out}`);
      }
    }
    if (out <= 0n) {
      const via = (await bestSwapPool(pools, ethToSwap)) ?? pool;
      const sw = await swapEthToTokenV4(via.poolKey, ethToSwap);
      if (sw.amountOut <= 0n) throw new Error("swap ETH→token failed (pool dry?)");
      swapHash = sw.tx;
    }
    swappedPct = Math.round((Number(ethToSwap) / Number(total)) * 100);
  } else {
    ethToSwap = 0n; // enough token on hand — LP straight from balance
  }

  // 2) actual token balance now (existing + any swapped)
  const tokenBal: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
  if (tokenBal <= 0n) throw new Error("token balance 0 — nothing to LP");

  // 3) approve token via Permit2 (ERC20 → Permit2, Permit2 → PositionManager)
  if ((await erc.allowance!(w.address, PERMIT2)) < tokenBal) {
    await waitTx(await erc.approve!(PERMIT2, ethers.MaxUint256, await overrides()), "v4-approve-permit2");
  }
  const permit2 = new ethers.Contract(PERMIT2, ["function approve(address token,address spender,uint160 amount,uint48 expiration)"], w);
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  await waitTx(await permit2.approve!(token, C.v4PositionManager!, (1n << 160n) - 1n, exp, await overrides()), "v4-permit2");

  // RE-READ fresh pool state after the swap (it moved the price) and re-anchor the range on the live
  // tick. Building against the stale pre-swap price forced a big slippage buffer that left ~15% of
  // both sides unspent ("always some leftover"). Fresh state → amounts match → a tiny 1% buffer suffices.
  try {
    const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
    const s0 = await sv.getSlot0!(pool.poolId);
    const liveLiq: bigint = await sv.getLiquidity!(pool.poolId).catch(() => pool.liquidity);
    sdkPool = buildSdkPool(token, meta.decimals, meta.symbol, { ...pool, sqrtPriceX96: BigInt(s0.sqrtPriceX96), tick: Number(s0.tick), liquidity: BigInt(liveLiq) });
    const liveAnchor = Math.floor(Number(s0.tick) / sp) * sp;
    tickLower = liveAnchor - halfSpacings * sp;
    tickUpper = liveAnchor + halfSpacings * sp;
  } catch {
    /* keep discovery-time state on read failure */
  }

  // 4) build both-sided position from ACTUAL balances, scaled so the slippage-max settle stays
  //    WITHIN what we hold. The old bug: position built from the swap's exact output, then
  //    addCallParameters' slippage tried to pull MORE token than balance → Permit2 reverted
  //    with empty data ("missing revert data").
  const ethLeft = total - ethToSwap;
  const slip = new Percent(1, 100); // tight — fresh pool state above makes a big buffer unnecessary
  const mkPosition = (e: bigint, t: bigint) =>
    Position.fromAmounts({
      pool: sdkPool,
      tickLower,
      tickUpper,
      amount0: (isC0Native ? e : t).toString(),
      amount1: (isC0Native ? t : e).toString(),
      useFullPrecision: true,
    });
  let position = mkPosition(ethLeft, tokenBal);
  try {
    const maxAmts = position.mintAmountsWithSlippage(slip);
    const have0 = isC0Native ? ethLeft : tokenBal;
    const have1 = isC0Native ? tokenBal : ethLeft;
    const m0 = BigInt(maxAmts.amount0.toString());
    const m1 = BigInt(maxAmts.amount1.toString());
    let numer = 1_000_000n;
    if (m0 > have0 && m0 > 0n) { const r = (have0 * 1_000_000n) / m0; if (r < numer) numer = r; }
    if (m1 > have1 && m1 > 0n) { const r = (have1 * 1_000_000n) / m1; if (r < numer) numer = r; }
    if (numer < 1_000_000n) {
      const scale = (x: bigint) => (((x * numer) / 1_000_000n) * 999n) / 1000n; // +0.1% safety
      position = mkPosition(scale(ethLeft), scale(tokenBal));
    }
  } catch {
    /* SDK without mintAmountsWithSlippage — fall through with the raw position */
  }
  if (position.liquidity.toString() === "0") throw new Error("liquidity 0 — deposit too small");

  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    recipient: w.address,
    slippageTolerance: slip,
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
    useNative: Ether.onChain(cfg.chainId),
  });

  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulation mint v4 in-range revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }
  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  const rc = await waitTx(tx, "v4-mint");
  const tokenId = tokenIdFromReceipt(rc!);
  // deposit basis = the position's actual value at mint (native side + token side valued in ETH),
  // so reused inventory is counted honestly in PnL
  const a0 = BigInt(position.amount0.quotient.toString());
  const a1 = BigInt(position.amount1.quotient.toString());
  const depWei = (isC0Native ? a0 : a1) + priceTokenInEth(isC0Native ? a1 : a0);
  if (tokenId) {
    saveV4Deposit(tokenId, { depositWei: (depWei > 0n ? depWei : total).toString(), ts: Date.now(), poolId: pool.poolId, fee: pool.fee, tickLower, tickUpper, mode: "inrange" });
  }
  // sweep leftover token → ETH (native side excess is already ETH; v4 doesn't refund the excess side)
  await sweepLeftoverToEth([{ addr: token, dec: meta.decimals }]).catch(() => undefined);
  log.info(`open v4 IN-RANGE #${tokenId} ${meta.symbol} fee ${pool.fee / 10000}% swap ${swappedPct}%${ethToSwap === 0n ? " (reuse balance)" : ""}`);
  return {
    tokenId,
    txHash: tx.hash,
    swapHash,
    swappedPct,
    fee: pool.fee,
    tickLower,
    tickUpper,
    depositEth: fmtNat(total), // the CLAMPED size, not the request
    poolId: pool.poolId,
  };
}

/**
 * For a DUAL-SIDE (in-range) v4 position, the ETH amount that exactly balances the token the
 * wallet already holds — so both sides fill with no swap and minimal leftover. Returns 0 if it
 * can't be computed (pool degenerate / no token). Used to suggest the "type ETH" amount.
 */
export function balancedEthForHeldToken(token: string, meta: { decimals: number; symbol: string }, pool: V4Pool, tokenRaw: bigint): number {
  if (tokenRaw <= 0n) return 0;
  if (pool.quote === "usd") return 0; // only native-paired pools have a native-balancing amount
  if (!v4NativeCurrencyAllowed()) return 0; // no native-paired pools on this chain at all
  try {
    const eth = Ether.onChain(cfg.chainId);
    const tok = new Token(cfg.chainId, ethers.getAddress(token), meta.decimals, meta.symbol);
    const sdkPool = new Pool(eth, tok, pool.fee, pool.tickSpacing, pool.poolKey.hooks, pool.sqrtPriceX96.toString(), pool.liquidity.toString(), pool.tick);
    const sp = pool.tickSpacing;
    const half = Math.max(1, Math.round(8 / 2));
    const anchor = Math.floor(pool.tick / sp) * sp;
    const tickLower = anchor - half * sp;
    const tickUpper = anchor + half * sp;
    const frac = Math.min(0.9, Math.max(0.05, swapFractionV4(pool.tick, tickLower, tickUpper) * 0.98));
    if (frac <= 0 || frac >= 1) return 0;
    const tokEthWei = BigInt(sdkPool.priceOf(sdkPool.currency1).quote(CurrencyAmount.fromRawAmount(sdkPool.currency1, tokenRaw.toString())).quotient.toString());
    const tokEth = Number(fmtNat(tokEthWei));
    return tokEth * ((1 - frac) / frac); // the native side that pairs with the held token
  } catch {
    return 0;
  }
}

/** Approve an ERC20 for the v4 PositionManager via Permit2 (ERC20→Permit2, Permit2→POSM). */
export async function approveViaPermit2(tokenAddr: string): Promise<void> {
  const w = wallet();
  const erc = new ethers.Contract(tokenAddr, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], w);
  if ((await erc.allowance!(w.address, PERMIT2)) < (1n << 200n)) {
    await waitTx(await erc.approve!(PERMIT2, ethers.MaxUint256, await overrides()), "v4-approve-permit2");
  }
  const permit2 = new ethers.Contract(PERMIT2, ["function approve(address token,address spender,uint160 amount,uint48 expiration)"], w);
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  await waitTx(await permit2.approve!(tokenAddr, C.v4PositionManager!, (1n << 160n) - 1n, exp, await overrides()), "v4-permit2");
}

/**
 * Open an in-range v4 position on a token/<stable> pool (no native leg — both currencies are
 * ERC-20, so the mint value is 0 and both sides settle through Permit2). Funds BOTH sides from
 * the budget through chain/router.ts (the aggregator where the chain has one, Uniswap v3/v4
 * otherwise), approves both via Permit2, then mints both-sided. amountEthStr = native budget.
 *
 * This is the ONLY v4 open path that runs on a chain without native-currency pool keys (Arc),
 * and it is the same code that has been running token/USDG in production on Robinhood.
 */
export async function openV4StableInRange(
  pool: V4Pool,
  amountEthStr: string,
  opts?: { increaseTokenId?: string; range?: { tickLower: number; tickUpper: number }; widthSpacings?: number },
): Promise<V4OpenResult & { swapHash?: string; swappedPct: number }> {
  const w = wallet();
  // GAS FLOOR (not a cap) — see currency.ts reserveForGas(). No-op on a chain with a wrapper.
  const total = await budgetForOpen(parseNat(amountEthStr));
  await ensureNativeBalance(total + NATIVE_GAS_BUFFER);

  const c0 = pool.poolKey.currency0;
  const c1 = pool.poolKey.currency1;
  const [m0, m1] = await Promise.all([tokenMeta(c0), tokenMeta(c1)]);
  const cur0 = new Token(cfg.chainId, ethers.getAddress(c0), m0.decimals, m0.symbol);
  const cur1 = new Token(cfg.chainId, ethers.getAddress(c1), m1.decimals, m1.symbol);

  // Split the ETH budget by the value fraction at the DISCOVERY tick — just to decide how much of
  // each side to buy. The position itself is built from FRESH state below.
  const sp = pool.tickSpacing;
  // range half-width in tick-spacings — volatility-adaptive when the caller passes widthSpacings
  // (wider for volatile tokens → stays in range longer → earns fees → hits TP instead of churning OOR).
  const half = Math.max(1, Math.round((opts?.widthSpacings ?? 8) / 2));
  const anchor0 = Math.floor(pool.tick / sp) * sp;
  const fracC1 = Math.min(0.95, Math.max(0.05, swapFractionV4(pool.tick, anchor0 - half * sp, anchor0 + half * sp)));
  const ethForC1 = (total * BigInt(Math.round(fracC1 * 1e6))) / 1_000_000n;
  const ethForC0 = total - ethForC1;

  const bal = async (a: string): Promise<bigint> =>
    new ethers.Contract(a, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf!(w.address).catch(() => 0n);

  // acquire each side from the budget through chain/router.ts — the v4 twin of what
  // positions.ts:openV3StableInRange already does. It used to call kyberSwap() directly, which
  // returns null the moment the profile says the aggregator doesn't serve the chain
  // (data.kyberChain = null), so on Arc EVERY in-range v4 open — manual /lp, auto-open, REBALANCE
  // and the whole "+ Add" top-up via increaseV4Position — threw "failed to buy … via Kyber" before
  // sending anything. "Router" is no longer a synonym for "KyberSwap"; router.ts picks the venue.
  let swapHash: string | undefined;
  /**
   * What pays for the buy, and why it is not simply C.weth like the v3 sibling.
   *
   * WITH a wrapped native (Robinhood): this path funds from NATIVE — ensureNativeBalance() above
   * has just unwrapped enough wrapper into native to cover `total`, so there may be no wrapper
   * balance left to spend. Paying with the native sentinel keeps the aggregator call byte-for-byte
   * the one the live bot makes today; router.ts simply puts Uniswap behind it instead of throwing.
   *
   * WITHOUT one (Arc): native is an 18-dec representation of the SAME dollar the pool quotes in
   * 6 dec, and there is no native-currency pool key on that chain at all — so the pay side is the
   * stable ERC-20 and the budget must go through the exact 1e12 integer step. Handing the 18-dec
   * number to a 6-dec ERC-20 would try to spend a trillion times the intended size; that rescale
   * is THE decimal hazard of the chain, in the one place that spends money.
   */
  const payWith = hasWrapped() ? KYBER_NATIVE : stableAddr();
  const payAmount = (natWei: bigint): bigint => (hasWrapped() ? natWei : natWeiToStableRaw(natWei));
  const acquire = async (addr: string, ethAmt: bigint) => {
    if (ethAmt < DUST_NAT_WEI) return;
    const amountIn = payAmount(ethAmt);
    if (amountIn <= 0n) return;
    const label = isStableQuote(addr) ? stableSym() : "token";
    // swapBest throws only when EVERY venue declined, and its message names each venue's reason —
    // strictly more diagnosable than "failed to buy X via Kyber", which was also what you got on a
    // chain that has no Kyber to fail in the first place.
    const r = await swapBest(payWith, ethers.getAddress(addr), amountIn).catch((e: Error) => {
      throw new Error(`failed to buy ${label}: ${e.message.slice(0, 160)}`);
    });
    if (r.amountOut <= 0n) throw new Error(`failed to buy ${label} — empty route`);
    swapHash = r.tx;
  };
  // REUSE the stable already in the wallet: buy only the SHORTFALL on the stable side (it values
  // trivially at stableUi / nativeUsd()). Swapping when you already hold enough just burns fees. The
  // shortfall (not "skip entirely") keeps the position full-size — the old skip-if-held bug starved it.
  const px = await nativeUsd().catch(() => 0);
  const usdgIsC0 = isStableQuote(c0);
  const usdgAddr = usdgIsC0 ? c0 : c1;
  const tokAddr = usdgIsC0 ? c1 : c0;
  const ethForUsdg = usdgIsC0 ? ethForC0 : ethForC1;
  const ethForTok = usdgIsC0 ? ethForC1 : ethForC0;
  // Held stable valued in NATIVE units. px = nativeUsd() and the stable's OWN decimals are used,
  // so on a stable-native chain this is the exact 1e12 rescale rather than a price lookup.
  const heldUsdgEthWei = usdToNatWei(Number(ethers.formatUnits(await bal(usdgAddr), STABLE_DEC)), px);
  const buyUsdgWei = ethForUsdg > heldUsdgEthWei ? ethForUsdg - heldUsdgEthWei : 0n;
  await acquire(tokAddr, ethForTok);
  // 0 if we already hold enough stable → no swap. And where the native IS the stable (Arc) there
  // is nothing to buy at all: it's the same dollar in the other representation.
  if (!nativeIsStableQuote()) await acquire(usdgAddr, buyUsdgWei);

  const [bal0, bal1] = await Promise.all([bal(c0), bal(c1)]);
  if (bal0 <= 0n || bal1 <= 0n) throw new Error(`balance ${m0.symbol}/${m1.symbol} 0 after swap`);

  await approveViaPermit2(c0);
  await approveViaPermit2(c1);

  // RE-READ the pool AFTER the buys (they move the price, especially the thin token side) and
  // re-anchor the range on the FRESH tick. Building against the stale discovery price forced a big
  // slippage buffer → ~15% of BOTH sides left unspent ("always some leftover"). Fresh state centres the
  // range on the current price, so the amounts match and a tiny 1% buffer suffices.
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
  let liveSqrt = pool.sqrtPriceX96;
  let liveTick = pool.tick;
  let liveLiq = pool.liquidity;
  try {
    const s0 = await sv.getSlot0!(pool.poolId);
    liveSqrt = BigInt(s0.sqrtPriceX96);
    liveTick = Number(s0.tick);
    liveLiq = await sv.getLiquidity!(pool.poolId).catch(() => pool.liquidity);
  } catch {
    /* keep discovery-time state on a read failure */
  }
  const livePool = new Pool(cur0, cur1, pool.fee, pool.tickSpacing, pool.poolKey.hooks, liveSqrt.toString(), liveLiq.toString(), liveTick);
  // INCREASE mode: reuse the EXISTING position's range (must match the NFT exactly). Open mode: fresh anchor.
  const anchor = Math.floor(liveTick / sp) * sp;
  const tickLower = opts?.range ? opts.range.tickLower : anchor - half * sp;
  const tickUpper = opts?.range ? opts.range.tickUpper : anchor + half * sp;

  // Tight 1% buffer — safe now that state is fresh (re-read → mint is milliseconds); staticCall guards.
  // INCREASE on an existing (often volatile / high-fee, e.g. 10%) pool: the price can move between
  // build and settle, so give the settle more headroom (5% vs 1% for a fresh open) → far fewer
  // "reverted" retries. Slightly more leftover (swept → ETH), but the top-up lands instead of failing.
  const slip = new Percent(opts?.increaseTokenId ? 5 : 1, 100);
  const mk = (a0: bigint, a1: bigint) => Position.fromAmounts({ pool: livePool, tickLower, tickUpper, amount0: a0.toString(), amount1: a1.toString(), useFullPrecision: true });
  let position = mk(bal0, bal1);
  try {
    const mx = position.mintAmountsWithSlippage(slip);
    const m0max = BigInt(mx.amount0.toString());
    const m1max = BigInt(mx.amount1.toString());
    let numer = 1_000_000n;
    if (m0max > bal0 && m0max > 0n) { const r = (bal0 * 1_000_000n) / m0max; if (r < numer) numer = r; }
    if (m1max > bal1 && m1max > 0n) { const r = (bal1 * 1_000_000n) / m1max; if (r < numer) numer = r; }
    if (numer < 1_000_000n) { const s = (x: bigint) => (((x * numer) / 1_000_000n) * 999n) / 1000n; position = mk(s(bal0), s(bal1)); }
  } catch {
    /* SDK lacks mintAmountsWithSlippage */
  }
  if (position.liquidity.toString() === "0") throw new Error("liquidity 0 — deposit too small");

  // INCREASE mode → target the existing NFT (SDK emits INCREASE_LIQUIDITY). Open mode → mint to recipient.
  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    ...(opts?.increaseTokenId ? { tokenId: opts.increaseTokenId } : { recipient: w.address }),
    slippageTolerance: slip,
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
    // NO useNative — both sides are ERC20 (token + stable), settled via Permit2 (see the value assert)
  });
  // Both currencies are ERC-20 here, so the SDK must NOT have asked for a native value. Sending
  // one would move native currency into a mint that never settles it — on Arc that is real money
  // at 18 decimals. Cheap assert, loud failure, no chance of a silent loss.
  if (BigInt(value ?? 0) !== 0n) throw new Error(`mint v4 ${stableSym()} requested native value ${value} — both pool currencies are ERC-20, must be 0`);
  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulation ${opts?.increaseTokenId ? "increase" : "mint"} v4 ${stableSym()} revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }
  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  const rc = await waitTx(tx, "v4-mint");
  const tokenId = opts?.increaseTokenId ?? tokenIdFromReceipt(rc!);
  if (tokenId) {
    // record DEPOSITED amounts (LP-vs-HODL basis). On INCREASE, ADD to the existing record so the
    // basis grows by exactly what we topped up (PnL stays honest across top-ups).
    const add0 = BigInt(position.amount0.quotient.toString());
    const add1 = BigInt(position.amount1.quotient.toString());
    const prev = opts?.increaseTokenId ? loadV4Deposit(tokenId) : null;
    saveV4Deposit(tokenId, {
      depositWei: ((prev?.depositWei ? BigInt(prev.depositWei) : 0n) + total).toString(),
      ts: prev?.ts ?? Date.now(),
      poolId: pool.poolId,
      fee: pool.fee,
      tickLower,
      tickUpper,
      mode: "inrange",
      dep0: ((prev?.dep0 ? BigInt(prev.dep0) : 0n) + add0).toString(),
      dep1: ((prev?.dep1 ? BigInt(prev.dep1) : 0n) + add1).toString(),
    });
  }
  // sweep the un-deposited leftover (token AND/OR stable) → native so there's no leftover (v4 doesn't refund)
  await sweepLeftoverToEth([{ addr: c0, dec: m0.decimals }, { addr: c1, dec: m1.decimals }]).catch(() => undefined);
  log.info(`${opts?.increaseTokenId ? "increase" : "open"} v4 ${stableSym()} in-range #${tokenId} ${m0.symbol}/${m1.symbol} fee ${pool.fee / 10000}% ${opts?.increaseTokenId ? "+" : ""}${fmtNat(total)} ${natSym()}`);
  return { tokenId, txHash: tx.hash, swapHash, swappedPct: 100, fee: pool.fee, tickLower, tickUpper, depositEth: fmtNat(total), poolId: pool.poolId };
}

/**
 * Add liquidity to an EXISTING v4 position (INCREASE, not a new NFT). Reconstructs the pool + range
 * from the tokenId, then reuses the in-range open path (fund both sides by the range split, reuse
 * held stable, sweep leftover → native) but targets the existing tokenId → SDK emits INCREASE_LIQUIDITY.
 * Stable pairs only for now (all the bot's positions are stable-quoted); native pairs throw a
 * clear message.
 */
export async function increaseV4Position(tokenId: string, amountEthStr: string): Promise<V4OpenResult & { swapHash?: string; swappedPct: number }> {
  const posm = new ethers.Contract(C.v4PositionManager!, V4_POSM_ABI, provider);
  const [pk, infoRaw] = await posm.getPoolAndPositionInfo!(tokenId);
  const info = BigInt(infoRaw);
  const s24 = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);
  const tickLower = s24(Number((info >> 8n) & 0xffffffn));
  const tickUpper = s24(Number((info >> 32n) & 0xffffffn));
  const poolKey: PoolKey = {
    currency0: String(pk.currency0),
    currency1: String(pk.currency1),
    fee: Number(pk.fee),
    tickSpacing: Number(pk.tickSpacing),
    hooks: String(pk.hooks),
  };
  const usdgIs = isStableQuote(poolKey.currency0) || isStableQuote(poolKey.currency1);
  if (!usdgIs) throw new Error(`increase pair ${natSym()} not yet supported — currently only ${stableSym()} pairs (close & reopen for native pair).`);
  const poolId = computePoolId(poolKey);
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
  const s0 = await sv.getSlot0!(poolId);
  if (!(s0.sqrtPriceX96 > 0n)) throw new Error("pool state for this position could not be read");
  const liquidity: bigint = await sv.getLiquidity!(poolId).catch(() => 0n);
  const pool: V4Pool = {
    poolKey,
    poolId,
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    sqrtPriceX96: BigInt(s0.sqrtPriceX96),
    tick: Number(s0.tick),
    liquidity,
    lpFee: poolKey.fee,
    quote: "usd",
  };
  return openV4StableInRange(pool, amountEthStr, { increaseTokenId: tokenId, range: { tickLower, tickUpper } });
}

/**
 * SINGLE-SIDE STABLE on a token/<stable> v4 pool: park ONLY the stable (no token), range on the
 * side that keeps the position 100% stable until the token PUMPS into range (rug-safe — if the
 * token dumps you keep your stable). stable=currency0 → range ABOVE tick (fromAmount0);
 * stable=currency1 → range BELOW tick (fromAmount1). Funds the stable side from the native budget
 * via Kyber — except where the native IS the stable (Arc), where the wallet already holds it.
 */
export async function openV4StableSingleSide(pool: V4Pool, amountEthStr: string): Promise<V4OpenResult & { swapHash?: string }> {
  // Only needed when the stable has to be BOUGHT; where the native already is the stable the
  // wallet balance IS the funding and an absent aggregator is not a blocker.
  if (!kyberEnabled() && !nativeIsStableQuote()) throw new Error(`KyberSwap not configured — buying ${stableSym()} requires an aggregator.`);
  const w = wallet();
  const c0 = pool.poolKey.currency0;
  const c1 = pool.poolKey.currency1;
  const usdgIs0 = isStableQuote(c0);
  const usdgIs1 = isStableQuote(c1);
  if (!usdgIs0 && !usdgIs1) throw new Error(`this pool is not a ${stableSym()} pair`);
  const usdgAddr = usdgIs0 ? c0 : c1;
  const [m0, m1] = await Promise.all([tokenMeta(c0), tokenMeta(c1)]);
  // GAS FLOOR (not a cap) — see currency.ts reserveForGas().
  const total = await budgetForOpen(parseNat(amountEthStr));
  const usdgC = new ethers.Contract(usdgAddr, ["function balanceOf(address) view returns (uint256)"], provider);

  // 1) fund the stable side — REUSE what's already in the wallet, buy only the shortfall to reach
  //    `total` worth, and cap the position to that target so a big held balance can't over-deploy.
  const px = await nativeUsd().catch(() => 0);
  // Target stable amount AT THE STABLE'S DECIMALS. px = nativeUsd(), so on a stable-native chain
  // this is the exact 18→6 rescale of the budget, not a price guess.
  const targetUsdgRaw = px > 0 ? BigInt(Math.floor(Number(fmtNat(total)) * px * 10 ** STABLE_DEC)) : 0n;
  const held0: bigint = await usdgC.balanceOf!(w.address).catch(() => 0n);
  const buyWei =
    targetUsdgRaw > 0n
      ? targetUsdgRaw > held0
        ? usdToNatWei(Number(ethers.formatUnits(targetUsdgRaw - held0, STABLE_DEC)), px)
        : 0n
      : total; // no native price → fall back to buying the full budget
  let swapHash: string | undefined;
  if (buyWei >= DUST_NAT_WEI && !nativeIsStableQuote()) {
    await ensureNativeBalance(buyWei + NATIVE_GAS_BUFFER);
    const k = await kyberSwap(KYBER_NATIVE, ethers.getAddress(usdgAddr), buyWei);
    if (!k || k.amountOut <= 0n) throw new Error(`failed to buy ${stableSym()} via Kyber`);
    swapHash = k.tx;
  }
  const heldNow: bigint = await usdgC.balanceOf!(w.address).catch(() => 0n);
  // Size the position: price KNOWN → cap to target (reuse held stable). Price UNKNOWN (px=0, e.g. the
  // ETH/USD API was down) → deposit ONLY what this open just bought (heldNow - held0), NEVER the whole
  // held balance — that's the bug that dumped ~$4 of pre-held USDG into a $2 position. On a chain whose
  // native IS a dollar stable px is the constant 1, so the KNOWN branch always runs.
  const bought = heldNow > held0 ? heldNow - held0 : 0n;
  const usdgBal = targetUsdgRaw > 0n ? (heldNow > targetUsdgRaw ? targetUsdgRaw : heldNow) : bought;
  if (usdgBal <= 0n) throw new Error(`${stableSym()} balance 0 (no ${stableSym()} in wallet & failed to buy)`);

  // 2) fresh pool state + a single-side range on the all-stable side
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
  let liveSqrt = pool.sqrtPriceX96;
  let liveTick = pool.tick;
  let liveLiq = pool.liquidity;
  try {
    const s0 = await sv.getSlot0!(pool.poolId);
    liveSqrt = BigInt(s0.sqrtPriceX96);
    liveTick = Number(s0.tick);
    liveLiq = await sv.getLiquidity!(pool.poolId).catch(() => pool.liquidity);
  } catch {
    /* keep discovery-time state */
  }
  const cur0 = new Token(cfg.chainId, ethers.getAddress(c0), m0.decimals, m0.symbol);
  const cur1 = new Token(cfg.chainId, ethers.getAddress(c1), m1.decimals, m1.symbol);
  const livePool = new Pool(cur0, cur1, pool.fee, pool.tickSpacing, pool.poolKey.hooks, liveSqrt.toString(), liveLiq.toString(), liveTick);
  const sp = pool.tickSpacing;
  const width = Math.max(1, Math.round(cfg.lp.widthPct / 100 / (Math.pow(1.0001, sp) - 1)));

  let tickLower: number;
  let tickUpper: number;
  let position: any;
  if (usdgIs0) {
    // all currency0 (stable) → range strictly ABOVE current tick
    tickLower = Math.ceil(liveTick / sp) * sp + sp;
    tickUpper = tickLower + width * sp;
    position = Position.fromAmount0({ pool: livePool, tickLower, tickUpper, amount0: usdgBal.toString(), useFullPrecision: true });
  } else {
    // all currency1 (stable) → range strictly BELOW current tick
    tickUpper = Math.floor(liveTick / sp) * sp - sp;
    tickLower = tickUpper - width * sp;
    position = Position.fromAmount1({ pool: livePool, tickLower, tickUpper, amount1: usdgBal.toString(), useFullPrecision: true });
  }
  if (position.liquidity.toString() === "0") throw new Error("liquidity 0 — deposit too small for this range");

  // 3) approve the stable via Permit2 + mint (both settle as ERC20, no useNative)
  await approveViaPermit2(usdgAddr);
  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    recipient: w.address,
    slippageTolerance: new Percent(1, 100),
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
  });
  // Same guard as the in-range stable path: an ERC-20/ERC-20 mint must never carry native value.
  if (BigInt(value ?? 0) !== 0n) throw new Error(`single-side ${stableSym()} requested native value ${value} — must be 0`);
  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulation single-side ${stableSym()} revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }
  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  const rc = await waitTx(tx, "v4-mint");
  const tokenId = tokenIdFromReceipt(rc!);
  if (tokenId) {
    saveV4Deposit(tokenId, {
      depositWei: total.toString(),
      ts: Date.now(),
      poolId: pool.poolId,
      fee: pool.fee,
      tickLower,
      tickUpper,
      mode: "single",
      dep0: position.amount0.quotient.toString(),
      dep1: position.amount1.quotient.toString(),
    });
  }
  log.info(`open v4 ${stableSym()} single-side #${tokenId} ${m0.symbol}/${m1.symbol} fee ${pool.fee / 10000}% ${fmtNat(total)} ${natSym()}`);
  return { tokenId, txHash: tx.hash, swapHash, fee: pool.fee, tickLower, tickUpper, depositEth: fmtNat(total), poolId: pool.poolId };
}

/**
 * Pick the pool that BUYS the token cheapest for `ethIn` — quote the ETH→token swap across all
 * of the token's native-ETH pools and take the one returning the most token (this captures BOTH
 * the fee tier AND the pool depth / price impact). Avoids buying on the thin high-fee pool the
 * user chose to farm, which would bleed fee + slippage before the position even opens.
 */
async function bestSwapPool(pools: V4Pool[], ethIn: bigint): Promise<V4Pool | null> {
  const cands = pools.filter((p) => p.quote === "eth" && p.liquidity > 0n && isNativeCurrency(p.poolKey.currency0));
  if (!cands.length) return null;
  const quotes = await mapLimit(cands, 6, async (p) => {
    const out = await quoteV4(p.poolKey, true, ethIn).catch(() => 0n); // ETH(c0)→token(c1)
    return { p, out };
  });
  const best = quotes.filter((q) => q.out > 0n).sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0))[0];
  return best?.p ?? null;
}

/** Fraction of the native side (currency0) to swap into token so a straddling range fills. */
function swapFractionV4(tick: number, tickLower: number, tickUpper: number): number {
  const sP = Math.pow(1.0001, tick / 2);
  const sA = Math.pow(1.0001, tickLower / 2);
  const sB = Math.pow(1.0001, tickUpper / 2);
  if (sP <= sA) return 0;
  if (sP >= sB) return 1;
  const a0 = (sB - sP) / (sP * sB); // currency0 (ETH) per L
  const a1in0 = (sP - sA) / (sP * sP); // currency1 (token) per L, valued in currency0
  return a1in0 / (a0 + a1in0);
}

/** ERC721 Transfer(0x0 → recipient) → minted tokenId. */
function tokenIdFromReceipt(rc: ethers.TransactionReceipt): string | null {
  const posm = C.v4PositionManager!.toLowerCase();
  const ZERO = "0x" + "0".repeat(64);
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() === posm && lg.topics.length === 4 && lg.topics[1] === ZERO) {
      return BigInt(lg.topics[3]!).toString();
    }
  }
  return null;
}
