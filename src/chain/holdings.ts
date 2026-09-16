/** Wallet-level helpers: balances and "sell every stuck token → the chain's quote asset". */
import { ethers } from "ethers";
import { C } from "../config.js";
import { wallet, provider } from "./client.js";
import { ERC20_ABI } from "./abis.js";
import { quoteTokenToQuote, swapTokenToQuote, defaultQuoteAddr } from "./swaps.js";
import { quoteBest } from "./router.js";
import { kyberRoute, kyberEnabled, KYBER_NATIVE } from "./kyber.js";
import { nativeUsd, natSym, fmtNat, hasWrapped, isWrappedNative, quoteSymbol, quoteDecimalsOf } from "./currency.js";
import { addressTokens } from "./indexer.js";
import { mapLimit } from "./blockscout.js";

/**
 * Field names frozen: `eth` is the NATIVE balance (18-dec USDC on Arc, not ether) and `weth` is
 * the wrapped-native balance, which is always "0" on a chain that has no wrapped native. Callers
 * outside chain/ do `Number(b.weth) + max(0, Number(b.eth) - reserve)`, which stays correct.
 */
export interface Balances {
  address: string;
  eth: string;
  weth: string;
}

/** One sellable ERC-20 holding, valued by its actual sell route → the default quote asset. */
export interface WalletToken {
  addr: string;
  symbol: string;
  decimals: number;
  raw: bigint;
  ethOut: number; // proceeds from selling ALL of it, see valueOf() for the units
  ui: number;
  usd: number;
}

/**
 * Decimals of whatever `defaultQuoteAddr()` resolves to. Both chains' answer is a profile quote
 * (WETH 18, the Arc USDC predeploy 6); 18 is the unreachable-fallback, not a guess.
 */
const quoteDec = (): number => quoteDecimalsOf(defaultQuoteAddr()) ?? 18;

/**
 * What selling `raw` of `addr` is worth, as a float, and in what unit.
 *
 * The unit is the DEFAULT QUOTE ASSET — WETH on Robinhood, the 6-dec USDC ERC-20 on Arc — and on
 * both chains that is 1:1 with the native currency (a wrapper, or the same dollar at another
 * scale), which is what keeps `ethOut` honest under its historical name and keeps `ethOut * px`
 * (px = nativeUsd()) a correct dollar figure on both.
 *
 * Kyber where the profile says the aggregator serves this chain: ONE HTTP call prices a multi-hop
 * route across every pool, and this runs over ~25 tokens for a picker the operator is waiting on.
 * Where it doesn't (Arc), the on-chain router answers instead — the alternative was the old
 * `if (!kyberEnabled()) return []`, which rendered a funded wallet as an empty token list.
 */
async function valueOf(addr: string, raw: bigint): Promise<number | null> {
  if (kyberEnabled()) {
    const route = await Promise.race([
      kyberRoute(addr, KYBER_NATIVE, raw),
      new Promise<null>((res) => setTimeout(() => res(null), 6000)),
    ]);
    // Kyber is quoted against its NATIVE sentinel, so this amount is in native wei.
    return route ? Number(fmtNat(BigInt(route.routeSummary.amountOut))) : null;
  }
  const r = await quoteBest(addr, defaultQuoteAddr(), raw).catch(() => null);
  if (!r || r.amountOut <= 0n) return null;
  return Number(ethers.formatUnits(r.amountOut, quoteDec()));
}

/**
 * ERC-20 holdings the wallet can ACTUALLY sell, richest first, dust dropped. Un-sellable junk (no
 * route anywhere) is filtered out, so the picker only ever offers swaps that can execute.
 *
 * The holdings themselves come from chain/indexer.ts, not from a Blockscout URL spelled out here:
 * that is the module that knows this chain has a REST indexer at all, and it distinguishes "the
 * wallet holds nothing" from "I could not ask" — a distinction this function used to lose, because
 * a throttled REST call read as `{items: []}` and rendered as an empty wallet.
 */
export async function walletTokens(minUsd = 0.1, cap = 25): Promise<WalletToken[]> {
  const w = wallet();
  const px = await nativeUsd().catch(() => 0);
  const held = await addressTokens(w.address).catch(() => null);
  if (!held) return []; // null = "this chain can't tell me" → say nothing rather than "empty"
  // isWrappedNative() is false where there is no WETH9, so nothing is excluded on Arc — and
  // crucially a zero-address entry can't be mistaken for "the wrapped native" there.
  const items = held.filter((t) => !isWrappedNative(t.address)).slice(0, cap);
  if (!items.length) return [];
  const rows = await mapLimit(items, 8, async (t): Promise<WalletToken | null> => {
    try {
      const ethOut = await valueOf(t.address, t.raw);
      if (ethOut === null) return null; // no sell route → hide (can't swap it anyway)
      const usd = ethOut * px;
      if (usd < minUsd) return null;
      return { addr: t.address, symbol: t.symbol, decimals: t.decimals, raw: t.raw, ui: Number(ethers.formatUnits(t.raw, t.decimals)), ethOut, usd };
    } catch {
      return null;
    }
  });
  return rows.filter((r): r is WalletToken => r !== null).sort((a, b) => b.usd - a.usd);
}

export async function balances(): Promise<Balances> {
  const w = wallet();
  const eth = await provider.getBalance(w.address);
  // No wrapped native → report native only. Skipping the read isn't just cosmetic: C.weth is the
  // ZERO ADDRESS on such a chain, so balanceOf() there is a call into nothing (reverts, or on some
  // nodes returns garbage that would be reported as spendable capital).
  let weth = 0n;
  if (hasWrapped()) {
    const wc = new ethers.Contract(C.weth, ERC20_ABI, provider);
    weth = await wc.balanceOf!(w.address).catch(() => 0n);
  }
  return {
    address: w.address,
    eth: fmtNat(eth),
    weth: fmtNat(weth),
  };
}

export interface SellAllResult {
  soldEth: number;
  soldUsd: number;
  sold: number;
  skipped: number;
  px: number;
  /** Symbol the proceeds are denominated in ("WETH" | "USDC") — for the operator-facing message. */
  quoteSym: string;
}

/**
 * Sell every non-wrapped-native ERC-20 holding → the default quote asset. Skips rug (pool dry)
 * and dust.
 *
 * Proceeds are WETH on Robinhood and the 6-dec USDC ERC-20 on Arc, which is why every amount here
 * is formatted at the QUOTE's width and never at the native's: reading a 6-decimal balance with
 * formatEther is the 1e12 bug, and it would under-report a $40 sale as $0.00000000004 — silently,
 * in the one number the operator uses to decide whether the sweep worked.
 *
 * This used to refuse outright without a wrapped native, because every leg was hard-wired to
 * token→WETH. It no longer is: chain/swaps.ts takes the quote asset as a parameter.
 */
export async function sellAllTokens(
  onProgress?: (msg: string) => void,
): Promise<SellAllResult> {
  const w = wallet();
  const quote = defaultQuoteAddr();
  const dec = quoteDec();
  const qSym = quoteSymbol(quote) ?? natSym();
  const px = await nativeUsd().catch(() => 0);
  let soldEth = 0;
  let sold = 0;
  let skipped = 0;
  const held = await addressTokens(w.address).catch(() => null);

  for (const t of held ?? []) {
    if (isWrappedNative(t.address)) continue;
    if (t.raw <= 0n) continue;
    const q = await quoteTokenToQuote(t.address, t.raw, quote).catch(() => ({ out: 0, fee: 0, amountOut: 0n }));
    if (q.out * px < 0.05) {
      skipped++;
      continue; // < $0.05 = rug/dust, not worth gas
    }
    try {
      const sw = await Promise.race([
        swapTokenToQuote(t.address, t.raw, quote, q.fee),
        timeout(60_000),
      ]);
      const out = Number(ethers.formatUnits(sw.amountOut, dec));
      soldEth += out;
      sold++;
      onProgress?.(`✅ ${t.symbol} → +${out.toFixed(6)} ${qSym} ($${(out * px).toFixed(2)})`);
    } catch {
      onProgress?.(`⚠️ ${t.symbol} failed ($${(q.out * px).toFixed(2)}) — skip`);
      skipped++;
    }
  }
  return { soldEth, soldUsd: soldEth * px, sold, skipped, px, quoteSym: qSym };
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
}
