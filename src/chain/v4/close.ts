/**
 * v4 close + fee-collect. Works for ANY pair (token/native, token/stable, token/token) by
 * reconstructing the Position from the REAL pool currencies — the earlier code forced the native
 * currency as currency0, which produced wrong calldata and reverted on non-native pools.
 *
 * Every "is this side native / wrapped / stable?" test goes through the profile, so on a chain
 * that forbids the 0x0 sentinel (Arc) the native branches are unreachable and a pool currency is
 * never read at the wrong decimals.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider, overrides, waitTx } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { isNativeCurrency } from "./poolkey.js";
import { loadV4Deposit, approveViaPermit2 } from "./mint.js";
import { listV4Positions } from "./list.js";
import {
  nativeUsd,
  natSym,
  natDecimals,
  fmtNat,
  isWrappedNative,
  isStableQuote,
  stableSym,
  nativeIsStableQuote,
  stableRawToNatWei,
} from "../currency.js";
import { kyberEnabled, KYBER_NATIVE } from "../kyber.js";
import { swapBest } from "../router.js";
import { defaultQuoteAddr } from "../swaps.js";
import { appendLedger } from "../ledger.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const { Ether, Token, CurrencyAmount, Percent } = sdkCore as any;
const { Pool, Position, V4PositionManager } = v4sdk as any;
const log = logger("v4close");
/** Native-side meta for a pool currency slot holding the 0x0 sentinel. */
const nativeMeta = () => ({ symbol: natSym(), decimals: natDecimals() });
/** "Already the native currency (or trivially convertible to it) — nothing to sweep." */
const isNativeEquivalent = (a: string): boolean =>
  isNativeCurrency(a) || isWrappedNative(a) || (nativeIsStableQuote() && isStableQuote(a));

const signed24 = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);

function sdkCurrency(addr: string, dec: number, sym: string): any {
  return isNativeCurrency(addr) ? Ether.onChain(cfg.chainId) : new Token(cfg.chainId, ethers.getAddress(addr), dec, sym);
}

/** Reconstruct the SDK Pool + Position for a tokenId from real on-chain currencies. */
async function loadPosition(tokenId: string) {
  const posm = new ethers.Contract(C.v4PositionManager!, V4_POSM_ABI, provider);
  const [pk, infoRaw] = await posm.getPoolAndPositionInfo!(tokenId);
  const liquidity: bigint = await posm.getPositionLiquidity!(tokenId);
  const info = BigInt(infoRaw);
  const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
  const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));
  const c0 = pk.currency0 as string;
  const c1 = pk.currency1 as string;
  const fee = Number(pk.fee);
  const tickSpacing = Number(pk.tickSpacing);
  const [m0, m1] = await Promise.all([
    isNativeCurrency(c0) ? Promise.resolve(nativeMeta()) : tokenMeta(c0).catch(() => ({ symbol: "?", decimals: 18 })),
    isNativeCurrency(c1) ? Promise.resolve(nativeMeta()) : tokenMeta(c1).catch(() => ({ symbol: "?", decimals: 18 })),
  ]);
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
  const poolId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [c0, c1, fee, tickSpacing, pk.hooks]),
  );
  const s0 = await sv.getSlot0!(poolId);
  const cur0 = sdkCurrency(c0, m0.decimals, m0.symbol);
  const cur1 = sdkCurrency(c1, m1.decimals, m1.symbol);
  const pool = new Pool(cur0, cur1, fee, tickSpacing, pk.hooks, s0.sqrtPriceX96.toString(), "0", Number(s0.tick));
  const position = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });
  return { pool, position, cur0, cur1, c0, c1, m0, m1, fee, tickLower, tickUpper };
}

async function simulateAndSend(calldata: string, value: string, label: string): Promise<string> {
  const w = wallet();
  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulasi ${label} v4 revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }
  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  await waitTx(tx, `v4-${label}`);
  return tx.hash;
}

export interface V4CloseResult {
  txHash: string;
  fee: number;
  recv0: number;
  sym0: string;
  recv1: number;
  sym1: string;
  depEth: number | null;
  pair: string;
  outEth: number; // realized value at close (NATIVE units)
  feeEth: number; // fees earned over the position's life (NATIVE units)
  pnlEth: number | null;
  pnlPct: number | null;
  forfeited: string | null; // symbol of a honeypot token forfeited to salvage the ETH side
  sweepHash?: string | null; // Kyber tx if proceeds were auto-swapped → the native currency
  sweptEth?: number; // native gained from sweeping token/stable proceeds back to native
}

export async function closeV4Position(tokenId: string, reason?: "TP" | "SL" | "OOR" | "VFADE" | "FVLOW" | "manual"): Promise<V4CloseResult> {
  const w = wallet();
  // Read the pool key + currencies directly (no SDK Pool). The SDK's removeCallParameters
  // throws "Invariant failed: PRICE_BOUNDS" on extreme-price pools (WOLVES/USDG) when it
  // applies slippage, and returns a null `value` for non-native pairs → "invalid BigNumberish".
  const posm = new ethers.Contract(C.v4PositionManager!, V4_POSM_ABI, provider);
  const [pk] = await posm.getPoolAndPositionInfo!(tokenId);
  const c0 = pk.currency0 as string;
  const c1 = pk.currency1 as string;
  const fee = Number(pk.fee);
  const [m0, m1] = await Promise.all([
    isNativeCurrency(c0) ? Promise.resolve(nativeMeta()) : tokenMeta(c0).catch(() => ({ symbol: "?", decimals: 18 })),
    isNativeCurrency(c1) ? Promise.resolve(nativeMeta()) : tokenMeta(c1).catch(() => ({ symbol: "?", decimals: 18 })),
  ]);

  // Snapshot the position's USD value + fees + pair BEFORE closing (needs the position live) so
  // we can write an accurate ledger entry. valueUsd at close = realized value; deposit is the
  // recorded ETH funding → PnL in ETH is exact (deposit was ETH-denominated, no historical price).
  let pre: { valueUsd: number; feeUsd: number; pair: string; sym: string } | null = null;
  try {
    const rows = await listV4Positions();
    const r = rows.find((x) => x.tokenId === String(tokenId));
    if (r) pre = { valueUsd: r.valueUsd, feeUsd: r.feeUsd, pair: r.pair, sym: r.sym };
  } catch {
    /* best-effort — ledger entry just won't have USD value */
  }

  // Manual full close: BURN_POSITION(0x03) removes ALL liquidity + accrued fees and burns the
  // NFT; TAKE_PAIR(0x11) sweeps both currencies to the wallet. amountMin=0 (we simulate first,
  // so a bad close never costs gas). Same action set the SDK emits for burnToken:true.
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const iface = new ethers.Interface(["function modifyLiquidities(bytes,uint256) payable"]);
  const dl = Math.floor(Date.now() / 1000 + 600);
  const burnParams = coder.encode(["uint256", "uint128", "uint128", "bytes"], [tokenId, 0, 0, "0x"]);
  const takeParams = coder.encode(["address", "address", "address"], [c0, c1, w.address]);
  const unlockData = coder.encode(["bytes", "bytes[]"], ["0x0311", [burnParams, takeParams]]);
  const calldata = iface.encodeFunctionData("modifyLiquidities", [unlockData, dl]);

  const [bal0Before, bal1Before] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);
  let txHash: string;
  let forfeited: string | null = null;
  try {
    txHash = await simulateAndSend(calldata, "0", "close");
  } catch (e) {
    // A honeypot/rug token can revert its own transfer() (the pool can't send it out), so a
    // normal close fails on CurrencyNotSettled. Recover the GOOD side (ETH/WETH/stable) and
    // FORFEIT the un-transferable token via CLEAR_OR_TAKE(0x13) — better to salvage the ETH.
    // "good" = a side worth salvaging: the native currency, its wrapper, or a dollar stable.
    const isGood = (a: string) => isNativeCurrency(a) || isWrappedNative(a) || isStableQuote(a);
    if (isGood(c0) === isGood(c1)) throw e; // nothing clearly salvageable → surface the real error
    const ct0 = coder.encode(["address", "uint256"], [c0, isGood(c0) ? 0n : ethers.MaxUint256]); // 0→take, MAX→clear
    const ct1 = coder.encode(["address", "uint256"], [c1, isGood(c1) ? 0n : ethers.MaxUint256]);
    const fcUnlock = coder.encode(["bytes", "bytes[]"], ["0x031313", [burnParams, ct0, ct1]]); // BURN + CLEAR_OR_TAKE ×2
    const fcCalldata = iface.encodeFunctionData("modifyLiquidities", [fcUnlock, dl]);
    txHash = await simulateAndSend(fcCalldata, "0", "force-close");
    forfeited = isGood(c0) ? m1.symbol : m0.symbol;
    log.warn(`force-close #${tokenId}: forfeited ${forfeited} (token blokir transfer/honeypot), ETH diselamatkan`);
  }
  const [bal0After, bal1After] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);

  const dep = loadV4Deposit(String(tokenId));
  const depEth = dep?.depositWei ? Number(fmtNat(dep.depositWei)) : null;
  const pair = pre?.pair ?? `${m0.symbol}/${m1.symbol}`;
  const px = await nativeUsd().catch(() => 0);
  const outEth = pre && px ? pre.valueUsd / px : 0;
  const feeEth = pre && px ? pre.feeUsd / px : 0;

  // BASIS for PnL. For ETH pairs the deposit was ETH-funded → realized PnL vs that ETH is exact.
  // For stable (non-native) pairs, funding the position swapped native→stable+token, so the recorded
  // native deposit is contaminated by the token's own price move. We instead measure LP-vs-HODL: value
  // the DEPOSITED token amounts at the CLOSE price, so a token that merely dropped in price isn't
  // counted as an LP loss — only fees + impermanent loss are. Keeps forward-close consistent with
  // the historical reconstruction (backfill.ts), which is why WOLVES/USDG shows fee-driven profit.
  let basisEth = depEth;
  const isUsdgPair = isStableQuote(c0) || isStableQuote(c1);
  if (isUsdgPair && dep?.dep0 && dep?.dep1 && px) {
    try {
      const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
      const poolId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint24", "int24", "address"],
          [c0, c1, fee, Number(pk.tickSpacing), pk.hooks],
        ),
      );
      const s0 = await sv.getSlot0!(poolId);
      const cur0 = sdkCurrency(c0, m0.decimals, m0.symbol);
      const cur1 = sdkCurrency(c1, m1.decimals, m1.symbol);
      const pool = new Pool(cur0, cur1, fee, Number(pk.tickSpacing), pk.hooks, s0.sqrtPriceX96.toString(), "0", Number(s0.tick));
      const valUsd = (addr: string, dec: number, sym: string, raw: bigint, cur: any, otherAddr: string, otherSym: string): number => {
        if (raw <= 0n) return 0;
        const a = addr.toLowerCase();
        const ui = Number(ethers.formatUnits(raw, dec));
        let v = 0;
        if (isNativeCurrency(a) || isWrappedNative(a)) v = ui * px;
        else if (isStableQuote(a) || /usd/i.test(sym)) v = ui;
        else {
          try {
            const inOther = Number(pool.priceOf(cur).quote(CurrencyAmount.fromRawAmount(cur, raw.toString())).toExact());
            if (isNativeCurrency(otherAddr) || isWrappedNative(otherAddr)) v = inOther * px;
            else if (isStableQuote(otherAddr) || /usd/i.test(otherSym)) v = inOther;
          } catch {
            /* price out of range → skip */
          }
        }
        // SANITY: clamp an exploded pool-price valuation (thin / extreme-tick) — same guard as list.ts
        // sideUsd; keeps basisEth sane so the ledger clamp below stays a backstop, not the primary catch.
        return Number.isFinite(v) && Math.abs(v) < 1e6 ? v : 0;
      };
      const hodlUsd =
        valUsd(c0, m0.decimals, m0.symbol, BigInt(dep.dep0), cur0, c1, m1.symbol) +
        valUsd(c1, m1.decimals, m1.symbol, BigInt(dep.dep1), cur1, c0, m0.symbol);
      if (hodlUsd > 0) basisEth = hodlUsd / px;
    } catch (e: any) {
      log.warn(`LP-vs-HODL basis failed #${tokenId}: ${e?.message ?? e} — falling back to ETH-funded basis`);
    }
  }
  // SANITY CLAMP: a farming position is funded ~0.003 ETH; even a moonshot closes at a few ETH. A
  // pool-price token valuation (Uniswap SDK priceOf) on a thin / extreme-tick token can blow up to
  // 1e50+ and poison the ledger + lifetime PnL (GME #462440 landed -$2.4e55, dwarfing every real
  // trade). If any leg is non-finite or absurd, record the close with UNKNOWN pnl + zeroed legs so a
  // single bad quote can't corrupt the aggregates.
  // ~$186k of ether on Robinhood; on a stable-native chain 100 native units is $100, which is a
  // TIGHTER (safer) clamp for a bot whose positions are a few dollars. Either way the point is the
  // same: no single farming position is anywhere near it, so past it means the quote exploded.
  const SANE_ETH = 100;
  const valuationBroken = [outEth, feeEth, basisEth ?? 0].some((v) => !Number.isFinite(v) || Math.abs(v) > SANE_ETH);
  if (valuationBroken) log.warn(`#${tokenId} ${pair}: valuasi rusak (out=${outEth} fee=${feeEth} basis=${basisEth}) → pnl direkam null, leg di-nol`);
  const ledgerOut = valuationBroken ? 0 : outEth;
  const ledgerFee = valuationBroken ? 0 : feeEth;
  const ledgerBasis = valuationBroken ? 0 : basisEth ?? 0;
  const pnlEth = !valuationBroken && basisEth != null && basisEth > 0 && pre ? outEth - basisEth : null;
  const pnlPct = pnlEth != null && basisEth ? (pnlEth / basisEth) * 100 : null;

  // record to the unified ledger (so /ledger shows v4 modal/PnL + counts it in stats)
  try {
    appendLedger({
      tokenId: String(tokenId),
      sym: pre?.sym ?? m0.symbol,
      version: "v4",
      pair,
      quote: isUsdgPair ? "usd" : "eth",
      mode: dep?.mode === "inrange" ? "inrange" : "single",
      openedAt: dep?.ts ?? null,
      closedAt: Date.now(),
      heldMs: dep?.ts ? Date.now() - dep.ts : null,
      depEth: ledgerBasis,
      outEth: ledgerOut,
      feeEth: ledgerFee,
      pnlEth,
      pnlPct,
      pnlUsd: pnlEth != null && px ? pnlEth * px : null,
      ethUsdAtClose: px || null,
      tokenKept: 0,
      tokenRug: 0,
      unsoldEth: 0,
      source: "bot",
      reason: reason ?? "manual",
    });
  } catch (e) {
    log.warn(`gagal tulis ledger v4 #${tokenId}: ${(e as Error).message.slice(0, 80)}`);
  }

  dropDeposit(tokenId);

  // ── sweep proceeds → the native currency (like the v3 stable close) so the wallet returns CLEAN:
  //    PnL realizes and native gas tops up, so auto-add never gets stuck holding the stable after a
  //    close. Swaps ALL non-native currency balances (the volatile token AND the stable) via router.ts.
  //    Gated by cfg.lp.autoSwapOnClose. The native currency, its wrapper — and, on a chain where
  //    the native IS the stable, the stable itself — are already native-equivalent, so skipped.
  let sweepHash: string | null = null;
  let sweptEth = 0;
  if (cfg.lp.autoSwapOnClose !== false) {
    // WHERE the proceeds are sold, same rule as the v3 stable close in positions.ts. This was
    // hard-wired to kyberSwap(), which returns null the instant the profile says the aggregator
    // doesn't serve the chain — so on Arc the volatile side was simply NEVER sold: a stop-loss
    // fired, the position was burnt, and the memecoin kept riding in the wallet. The stop did not
    // stop the loss. Selling into the default quote there (the 6-dec USDC ERC-20) still realizes
    // PnL and still tops gas up, because on that chain the quote IS the gas currency in its other
    // representation.
    const sellTo = kyberEnabled() ? KYBER_NATIVE : defaultQuoteAddr();
    // amountOut is denominated in whatever we sold INTO. Only a native-denominated output may be
    // read with fmtNat(): the stable is 6-dec, so it goes through the exact integer rescale first.
    // Feeding a 6-dec raw to an 18-dec formatter would under-report the realized proceeds — and
    // sweptEth feeds the close card + the ledger, so that is a lie about money, not a display bug.
    const outAsNat = (out: bigint): bigint =>
      !isStableQuote(sellTo) ? out : nativeIsStableQuote() ? stableRawToNatWei(out) : 0n;
    for (const [addr, dec] of [[c0, m0.decimals], [c1, m1.decimals]] as const) {
      if (isNativeEquivalent(addr)) continue;
      const raw = await rawBalOf(addr);
      if (raw <= 0n) continue;
      try {
        const k = await Promise.race([swapBest(addr, sellTo, raw), new Promise<null>((r) => setTimeout(() => r(null), 60_000))]);
        if (k?.tx) {
          sweepHash = k.tx;
          const gotNat = outAsNat(k.amountOut);
          sweptEth += Number(fmtNat(gotNat));
          log.info(`sweep v4 #${tokenId}: ${isStableQuote(addr) ? stableSym() : "token"} ${ethers.formatUnits(raw, dec)} → ${Number(fmtNat(gotNat)).toFixed(6)} ${natSym()}`);
        }
      } catch {
        /* leave the currency in the wallet if the swap fails (non-fatal) */
      }
    }
  }

  log.info(`close v4 #${tokenId} ${m0.symbol}/${m1.symbol}`);
  return {
    txHash,
    fee,
    recv0: Math.max(0, bal0After - bal0Before),
    sym0: m0.symbol,
    recv1: Math.max(0, bal1After - bal1Before),
    sym1: m1.symbol,
    depEth: basisEth,
    pair,
    outEth,
    feeEth,
    pnlEth,
    pnlPct,
    forfeited,
    sweepHash,
    sweptEth,
  };
}

export interface V4CollectResult {
  txHash: string;
  fee0: number;
  sym0: string;
  fee1: number;
  sym1: string;
}

/**
 * Collect accrued fees WITHOUT removing liquidity. The SDK's removeCallParameters rejects
 * 0% liquidity, so we manually encode the standard v4 collect: DECREASE_LIQUIDITY(0) which
 * settles fees into owed balances, then TAKE_PAIR to sweep them to the wallet.
 */
export async function collectV4Fees(tokenId: string): Promise<V4CollectResult> {
  const w = wallet();
  const { c0, c1, m0, m1 } = await loadPosition(tokenId);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actions = "0x0111"; // DECREASE_LIQUIDITY(0x01), TAKE_PAIR(0x11)
  const decParams = coder.encode(["uint256", "uint256", "uint128", "uint128", "bytes"], [tokenId, 0, 0, 0, "0x"]);
  const takeParams = coder.encode(["address", "address", "address"], [c0, c1, w.address]);
  const unlockData = coder.encode(["bytes", "bytes[]"], [actions, [decParams, takeParams]]);
  const iface = new ethers.Interface(["function modifyLiquidities(bytes,uint256) payable"]);
  const calldata = iface.encodeFunctionData("modifyLiquidities", [unlockData, Math.floor(Date.now() / 1000 + 600)]);

  const [b0, b1] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);
  const txHash = await simulateAndSend(calldata, "0", "collect");
  const [a0, a1] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);
  log.info(`collect v4 #${tokenId} ${m0.symbol}/${m1.symbol}`);
  return { txHash, fee0: Math.max(0, a0 - b0), sym0: m0.symbol, fee1: Math.max(0, a1 - b1), sym1: m1.symbol };
}

export interface V4CompoundResult {
  compounded: boolean;
  reason?: string;
  txHash?: string;
  add0?: number;
  sym0?: string;
  add1?: number;
  sym1?: string;
}

/**
 * #3 fee-compound: harvest an in-range position's accrued fees and add them straight back as
 * liquidity (no swap → no fee drag). Collects fees to the wallet, measures EXACTLY what was
 * collected (raw balance delta, so any pre-held stable parked in the wallet is NEVER redeposited),
 * then increases the same tokenId with those amounts. The ratio-mismatch remainder stays as dust
 * (tiny; swept on the eventual close). ERC20/ERC20 pairs only — a native leg needs a useNative
 * settle path, so native pairs are skipped (returns compounded:false with a reason).
 *
 * Deposit basis is intentionally UNCHANGED: the fees were already earned profit, so folding them
 * into liquidity doesn't raise the cost basis — they surface as PnL when the position finally closes.
 */
export async function compoundV4Position(tokenId: string): Promise<V4CompoundResult> {
  const { pool, c0, c1, m0, m1, tickLower, tickUpper } = await loadPosition(tokenId);
  if (isNativeCurrency(c0) || isNativeCurrency(c1)) {
    return { compounded: false, reason: `pair ${natSym()} native (compound cuma pair ERC20)` };
  }

  // 1) harvest — RAW deltas so pre-held balances (e.g. parked stable) are never folded in
  const [before0, before1] = await Promise.all([rawBalOf(c0), rawBalOf(c1)]);
  await collectV4Fees(tokenId);
  const [after0, after1] = await Promise.all([rawBalOf(c0), rawBalOf(c1)]);
  const fee0 = after0 > before0 ? after0 - before0 : 0n;
  const fee1 = after1 > before1 ? after1 - before1 : 0n;
  if (fee0 <= 0n && fee1 <= 0n) return { compounded: false, reason: "gak ada fee kekumpul" };

  // 2) build an INCREASE from EXACTLY the collected fees; scale to what we hold so the slippage-max
  //    settle can't overpull (same guard the open path uses). Binding side sets liquidity.
  const slip = new Percent(5, 100);
  const mk = (a0: bigint, a1: bigint) =>
    Position.fromAmounts({ pool, tickLower, tickUpper, amount0: a0.toString(), amount1: a1.toString(), useFullPrecision: true });
  let position = mk(fee0, fee1);
  try {
    const mx = position.mintAmountsWithSlippage(slip);
    const m0max = BigInt(mx.amount0.toString());
    const m1max = BigInt(mx.amount1.toString());
    let numer = 1_000_000n;
    if (m0max > fee0 && m0max > 0n) { const r = (fee0 * 1_000_000n) / m0max; if (r < numer) numer = r; }
    if (m1max > fee1 && m1max > 0n) { const r = (fee1 * 1_000_000n) / m1max; if (r < numer) numer = r; }
    if (numer < 1_000_000n) { const s = (x: bigint) => (((x * numer) / 1_000_000n) * 999n) / 1000n; position = mk(s(fee0), s(fee1)); }
  } catch {
    /* SDK lacks mintAmountsWithSlippage */
  }
  if (position.liquidity.toString() === "0") return { compounded: false, reason: "fee kekecilan/gak seimbang buat nambah liq" };

  // 3) approve both ERC20 via Permit2, then INCREASE_LIQUIDITY on the existing tokenId
  await approveViaPermit2(c0);
  await approveViaPermit2(c1);
  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    tokenId,
    slippageTolerance: slip,
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
  });
  const txHash = await simulateAndSend(calldata, value ?? "0", "compound");
  const add0 = Number(ethers.formatUnits(BigInt(position.amount0.quotient.toString()), m0.decimals));
  const add1 = Number(ethers.formatUnits(BigInt(position.amount1.quotient.toString()), m1.decimals));
  log.info(`compound v4 #${tokenId} ${m0.symbol}/${m1.symbol}: +${add0} ${m0.symbol} +${add1} ${m1.symbol}`);
  return { compounded: true, txHash, add0, sym0: m0.symbol, add1, sym1: m1.symbol };
}

async function balOf(addr: string, dec: number): Promise<number> {
  const w = wallet();
  if (isNativeCurrency(addr)) return Number(fmtNat(await provider.getBalance(w.address)));
  const erc = new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider);
  return Number(ethers.formatUnits(await erc.balanceOf!(w.address).catch(() => 0n), dec));
}

/** Raw ERC-20 balance (for sweeping proceeds → ETH after close). */
async function rawBalOf(addr: string): Promise<bigint> {
  const w = wallet();
  const erc = new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider);
  return erc.balanceOf!(w.address).catch(() => 0n);
}

function dropDeposit(tokenId: string): void {
  try {
    const d = readJson<Record<string, unknown>>(dataPath("v4-positions.json"), {});
    delete d[String(tokenId)];
    writeJson(dataPath("v4-positions.json"), d);
  } catch {
    /* */
  }
}
