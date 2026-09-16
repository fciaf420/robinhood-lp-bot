/**
 * Native currency + quote-asset layer — the ONE place that knows what "Ξ" actually is.
 *
 * Why this exists: the bot was written when "native = ETH" and "stable quote = USDG" were
 * facts of the universe, so `ethUsd()`, `formatEther()` and the hardcoded USDG address are
 * sprayed across ~50 call sites. On Arc NONE of that holds:
 *
 *   - the native gas currency IS USDC (stable → its USD price is the constant 1, not a feed)
 *   - there is NO wrapped native (no WETH9) → no wrap/unwrap, no native-paired v3 pool
 *   - USDC has TWO representations: native (18 dec, gas + msg.value) and the ERC-20 predeploy
 *     0x3600…0000 (6 dec). The scale factor is exactly 1e12 and mixing them up is the single
 *     biggest money hazard on that chain, which is why NOTHING here takes "decimals" on faith:
 *     native amounts go through nat().decimals, pool-currency amounts through the quote's.
 *   - LP capital and gas are the SAME balance, so a size must leave the gas reserve behind or
 *     the bot can open a position it cannot afford to close.
 *
 * Everything here is derived from the chain profile, so on Robinhood every function returns
 * exactly what the old hardcoded constant returned (18 decimals, ethUsd(), USDG, 0.015 Ξ).
 */
import { ethers } from "ethers";
import {
  CHAIN,
  nativeCurrency,
  quoteAssets,
  stableQuote,
  hasWrappedNative,
  type NativeSpec,
  type QuoteAsset,
} from "./profile.js";
import { wallet, provider } from "./client.js";
import { ethUsd } from "./price.js";

// ══════════════════════════ native ══════════════════════════

/** The native (gas) currency descriptor: ETH on Robinhood, 18-dec USDC on Arc. */
export function nat(): NativeSpec {
  return nativeCurrency();
}

/** Display symbol for the native currency — "ETH" | "USDC". */
export function natSym(): string {
  return nat().symbol;
}

export function natDecimals(): number {
  return nat().decimals;
}

/**
 * formatUnits/parseUnits at the NATIVE decimals.
 *
 * NOTE FOR FUTURE READERS: this is 18 on BOTH chains today (Arc's native USDC is an 18-dec
 * representation of the 6-dec ERC-20), so these are a CLARITY RENAME of formatEther/parseEther,
 * not a maths change. Do not "simplify" them back to formatEther: the point is that every
 * native amount now reads its width from the profile, so adding a chain whose native is not
 * 18-dec is a JSON edit instead of a hunt through 50 call sites.
 */
export function fmtNat(wei: ethers.BigNumberish): string {
  return ethers.formatUnits(wei, natDecimals());
}
export function parseNat(amount: string): bigint {
  return ethers.parseUnits(amount, natDecimals());
}

/**
 * USD price of ONE native unit.
 *   - native not stable (Robinhood)  → ethUsd(), same cache/sources as before.
 *   - native stable (Arc)            → exactly 1, with NO network call. A price feed that
 *                                      returns 0 on failure would zero every valuation on a
 *                                      chain where the answer is known a priori.
 *
 * Every LP / PnL / sizing path must call THIS, not ethUsd(). ethUsd() stays exported from
 * price.ts for things that are genuinely about ether.
 */
export async function nativeUsd(): Promise<number> {
  return nat().stable ? 1 : ethUsd();
}

// ══════════════════════════ gas reserve (a FLOOR, never a cap) ══════════════════════════

/** Native units held back for gas, as a plain number (profile `native.gasReserve`). */
export function gasReserveNat(): number {
  return nat().gasReserve;
}

/**
 * A JS number as a plain decimal string safe for parseUnits.
 *
 * NOT toFixed(): (0.015).toFixed(18) is "0.014999999999999999", which parsed to a gas reserve one
 * wei short of the configured value — a float artefact leaking into on-chain money maths, which is
 * exactly the class of bug this module exists to stop. String(n) gives the shortest round-trip
 * decimal ("0.015"), and only falls back to toFixed for exponential-notation numbers.
 * Excess fraction digits beyond the currency's width are truncated, as parseUnits requires.
 */
export function decimalString(n: number, dec: number): string {
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(Math.min(dec, 20));
  const [int, frac = ""] = s.split(".");
  return frac.length > dec ? (dec > 0 ? `${int}.${frac.slice(0, dec)}` : String(int)) : s;
}

/**
 * A config number (a position size, a target) as a string parseNat() will accept.
 *
 * Exported because radar/autolp.ts grew its own copy of this while this file was being written,
 * and two float→decimal-string helpers in a bot that parses both results into wei is precisely
 * how the two drift apart. One implementation, one rounding rule.
 */
export function natAmountStr(n: number): string {
  return decimalString(n, natDecimals());
}

/** The gas reserve in native wei. */
export function gasReserveWei(): bigint {
  const r = gasReserveNat();
  if (!(r > 0)) return 0n;
  return parseNat(natAmountStr(r));
}

/**
 * `budgetWei` minus the gas reserve, floored at 0.
 *
 * READ THIS BEFORE CHANGING IT: this is the ONE sizing floor in the bot and it is NOT a size
 * cap. The operator has explicitly refused imposed caps — the deposit is the only limit. What
 * this prevents is the opposite failure: on a chain where gas and LP capital are the same
 * balance (Arc — native USDC pays gas AND is the quote asset), deploying 100% of the balance
 * leaves nothing to pay for the CLOSE, i.e. a position you physically cannot exit. So it holds
 * back a fixed reserve and lets everything above it through.
 */
export function reserveForGas(budgetWei: bigint): bigint {
  const r = gasReserveWei();
  return budgetWei > r ? budgetWei - r : 0n;
}

/** Native balance of the bot wallet (or any address) in wei. */
export async function nativeBalanceWei(addr?: string): Promise<bigint> {
  return provider.getBalance(addr ?? wallet().address);
}

/**
 * Clamp a requested position size to what the wallet can actually spend.
 *
 * Chain WITH a wrapped native (Robinhood): the LP budget is funded from WETH, which is a
 * SEPARATE balance from the native gas float, so the request passes through UNTOUCHED — the
 * live bot's sizing is bit-for-bit what it was. Chain WITHOUT one (Arc): native is the only
 * balance there is, so the size is clamped to (balance − gasReserve) and a request that leaves
 * nothing for gas fails loudly here instead of half-way through a multi-tx open.
 */
export async function budgetForOpen(wantWei: bigint): Promise<bigint> {
  if (hasWrappedNative()) return wantWei;
  const bal = await nativeBalanceWei();
  const spendable = reserveForGas(bal);
  if (spendable <= 0n) {
    throw new Error(
      `saldo ${natSym()} ${fmtNat(bal)} <= cadangan gas ${gasReserveNat()} — nggak ada modal yang aman dipakai (nanti gak bisa nutup posisi).`,
    );
  }
  if (wantWei <= spendable) return wantWei;
  return spendable;
}

// ══════════════════════════ wrapped native ══════════════════════════

/** Wrapped-native address, or null when the chain has none (Arc). */
export function wrappedNativeAddr(): string | null {
  return nat().wrapped;
}

/** false on Arc → every wrap/unwrap step, WETH balance read and WETH-paired lookup is skipped. */
export function hasWrapped(): boolean {
  return hasWrappedNative();
}

/**
 * Is `addr` the wrapped native? ALWAYS false when the chain has no wrapped native.
 *
 * This matters: config.ts fills `C.weth` with the ZERO ADDRESS on Arc (so the type stays a
 * string), and the zero address is ALSO the v4 native-currency sentinel — so a bare
 * `addr === C.weth.toLowerCase()` silently starts matching 0x0 pool currencies there. Comparing
 * through this function can't make that mistake.
 */
export function isWrappedNative(addr: string): boolean {
  const w = wrappedNativeAddr();
  return !!w && !!addr && addr.toLowerCase() === w.toLowerCase();
}

// ══════════════════════════ quote assets ══════════════════════════

/** The dollar quote asset: USDG (6 dec) on Robinhood, the USDC ERC-20 predeploy (6 dec) on Arc. */
export function stableAsset(): QuoteAsset {
  return stableQuote();
}
export function stableAddr(): string {
  return stableAsset().address;
}
export function stableDecimals(): number {
  return stableAsset().decimals;
}
export function stableSym(): string {
  return stableAsset().symbol;
}
/** UI/raw conversion at the STABLE's decimals — never at the native's. */
export function fmtStable(raw: ethers.BigNumberish): string {
  return ethers.formatUnits(raw, stableDecimals());
}
export function parseStable(amount: string): bigint {
  return ethers.parseUnits(amount, stableDecimals());
}

/** Every dollar quote in the profile, lowercased — the "is this side a stable?" set. */
export function stableAddresses(): Set<string> {
  return new Set(quoteAssets().filter((q) => q.class === "usd").map((q) => q.address.toLowerCase()));
}

export function isStableQuote(addr: string): boolean {
  return !!addr && stableAddresses().has(addr.toLowerCase());
}

/**
 * The profile row for a quote asset, or null when the address isn't one of ours.
 *
 * THE one lookup. Five call sites had grown their own `quoteAssets().find(...)`, each with a
 * different fallback for the unknown case — 18 in analytics, stableDecimals() in volume, an RPC
 * tokenMeta() read in swaps, 18 again in the scanner. Five answers to one question, each silently
 * wrong for the others' inputs, in exactly the raw→float arithmetic where a 12-decimal slip turns
 * a $30 swap into $30M. The LOOKUP is shared here; the FALLBACK stays each caller's explicit
 * decision, because "I don't recognise this address" means something different in each of them.
 */
export function quoteAssetOf(addr: string): QuoteAsset | null {
  const a = (addr || "").toLowerCase();
  return quoteAssets().find((q) => q.address.toLowerCase() === a) ?? null;
}

/** Symbol of a known quote asset (so a pool side can be labelled without an RPC read). */
export function quoteSymbol(addr: string): string | null {
  return quoteAssetOf(addr)?.symbol ?? null;
}

/** Decimals of a profile-known quote asset — null, never a defaulted 18. See quoteAssetOf(). */
export function quoteDecimalsOf(addr: string): number | null {
  return quoteAssetOf(addr)?.decimals ?? null;
}

// ══════════════════════════ native ↔ stable ══════════════════════════

/**
 * true when the native currency and the stable quote are the SAME underlying asset in two
 * representations — Arc: native USDC (18 dec, gas) vs the 6-dec ERC-20 predeploy.
 *
 * Callers use this to skip the "buy the stable side from the native budget" swap: there is
 * nothing to swap, it's the same dollar at a different scale. False on Robinhood (ETH ≠ USDG),
 * so the Kyber-funded USDG path is untouched.
 */
export function nativeIsStableQuote(): boolean {
  const n = nat();
  return n.stable && n.symbol.toLowerCase() === stableSym().toLowerCase();
}

/**
 * true when the stable quote's ERC-20 balance and eth_getBalance are ONE balance seen at two
 * precisions (Arc: 18-dec native USDC / 6-dec predeploy, factor 1e12), rather than two separate
 * pots (Robinhood: native ETH and WETH).
 *
 * Anything that SUMS a wallet must consult this or it double-counts the entire balance — on Arc
 * that renders the whole wallet as profit in /pnl. Anything that SIZES from a balance can use
 * either representation when this is true, which is why budgetForOpen may clamp a stable-funded
 * open against the native balance.
 *
 * profile.native.erc20Parity is what makes it true, and `npm run probe:arc` is what verifies the
 * claim on-chain (balanceOf × 1e12 === getBalance). Default false under-counts; it never
 * over-spends.
 */
export function stableSharesNativeBalance(): boolean {
  return nativeIsStableQuote() && nat().erc20Parity === true;
}

/**
 * Exact integer rescale between the native and the stable representation of the SAME asset.
 * Only meaningful when nativeIsStableQuote(); on Arc that factor is exactly 1e12. Integer maths
 * on purpose — routing this through a float would be the 18-vs-6 bug the whole file exists to
 * prevent. Native→stable truncates (never hands out more stable than the native backs).
 */
export function natWeiToStableRaw(wei: bigint): bigint {
  const d = natDecimals() - stableDecimals();
  if (d === 0) return wei;
  return d > 0 ? wei / 10n ** BigInt(d) : wei * 10n ** BigInt(-d);
}
export function stableRawToNatWei(raw: bigint): bigint {
  const d = natDecimals() - stableDecimals();
  if (d === 0) return raw;
  return d > 0 ? raw * 10n ** BigInt(d) : raw / 10n ** BigInt(-d);
}

// ══════════════════════════ USD ↔ native ══════════════════════════

/**
 * USD amount → native wei at price `px` (use nativeUsd() for px). Returns 0n when the price is
 * unknown, which is what every call site already treated as "don't size from this".
 * The 9-decimal rounding matches the previous `parseEther((usd / px).toFixed(9))` exactly.
 */
export function usdToNatWei(usd: number, px: number): bigint {
  if (!(px > 0) || !(usd > 0) || !Number.isFinite(usd)) return 0n;
  return parseNat((usd / px).toFixed(Math.min(9, natDecimals())));
}

/** Native wei → USD at price `px`. */
export function natWeiToUsd(wei: bigint, px: number): number {
  return Number(fmtNat(wei)) * px;
}

// ══════════════════════════ v4 ══════════════════════════

/**
 * May a v4 pool key hold the native 0x0 sentinel on this chain? false on Arc: native USDC is
 * 18-dec while the pool currency is the 6-dec ERC-20, and Uniswap's own Arc guidance is to
 * reject 0x0 at API boundaries because of exactly that mismatch. When false, every v4 pool key
 * is ERC-20/ERC-20 and every mint value is 0.
 */
export function v4UsesNativeCurrency(): boolean {
  return CHAIN.venues.v4NativeCurrency;
}

/** Chain id — handy for stamping new ledger/position records. */
export function chainId(): number {
  return CHAIN.chainId;
}
