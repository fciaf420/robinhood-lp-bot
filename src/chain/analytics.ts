/**
 * Wallet-level lifetime PnL: net capital deposited vs. total current value.
 *
 * Capital in/out is derived from EOA/bridge transfers. v1 excluded EVERY contract
 * counterparty as "internal" — which wrongly dropped bridge/CEX funding (the way you
 * actually get ETH onto a fresh chain), inflating NET PnL. Here:
 *   • native transfers: only KNOWN LP-machinery contracts are excluded → bridge deposits
 *     (a contract counterparty) correctly count as capital in.
 *   • QUOTE-ASSET transfers: any contract counterparty is excluded (those are pools/router).
 *
 * "Quote asset" used to be spelled WETH. It is now defaultQuoteAddr(): the wrapped native where
 * one exists (Robinhood — literally C.weth, so every number below is what it was), the dollar
 * stable where none does (Arc, where capital arrives as USDC and there is nothing to wrap).
 * The `*Eth` field names are frozen because telegram/ renders them; on a chain whose native IS a
 * dollar they are dollars, and they stay mutually consistent because the quote asset and the
 * native currency are then the same asset (px = 1) — no unit ever gets mixed.
 *
 * WHAT HAPPENS WITHOUT AN INDEXER (Arc today): a native transfer emits no log, so capital flow is
 * not reconstructible from a node — `capKnown` goes false and capIn/capOut/pnl stay 0 rather than
 * being invented. A 0 deposit against a real balance would render as "everything is profit", which
 * is the single most misleading number this panel could show.
 */
import { ethers } from "ethers";
import { C } from "../config.js";
import { wallet, provider } from "./client.js";
import { quoteTokenToQuote, defaultQuoteAddr } from "./swaps.js";
import { nativeUsd, fmtNat, natSym, quoteDecimalsOf, stableSharesNativeBalance } from "./currency.js";
import { listPositions } from "./positions.js";
import { mapLimit } from "./blockscout.js";
import { txHistory, tokenTransfers, addressTokens, historyIsBounded, indexerNote } from "./indexer.js";
import { logger } from "../util/log.js";

const log = logger("analytics");

// LP machinery — a transfer to/from one of these is not capital moving in or out of the wallet.
// The zero address is filtered because C.weth IS 0x0 on a chain with no wrapped native, and 0x0 is
// not a counterparty: keeping it would silently classify mints/burns as "internal".
const INTERNAL = new Set(
  [C.positionManager, C.swapRouter02, C.factory, C.quoter, C.weth, ...C.extraV3Factories]
    .map((a) => (a || "").toLowerCase())
    .filter((a) => a && !/^0x0{40}$/.test(a)),
);

const codeCache = new Map<string, boolean>();
async function isContract(addr: string): Promise<boolean> {
  const a = addr.toLowerCase();
  if (codeCache.has(a)) return codeCache.get(a)!;
  let r = false;
  try {
    r = (await provider.getCode(a)) !== "0x";
  } catch {
    /* assume EOA */
  }
  codeCache.set(a, r);
  return r;
}

/** Decimals of a profile-known quote asset — read, never assumed (the 18-vs-6 hazard). Shared
 *  lookup in currency.ts; 18 is the fallback because every address reaching this file is one the
 *  profile named, so an `??` here is unreachable defence rather than a guess about a real token. */
function quoteDecimals(addr: string): number {
  return quoteDecimalsOf(addr) ?? 18;
}

export interface LifetimePnl {
  px: number;
  capIn: number;
  capOut: number;
  netCapEth: number;
  nativeEth: number;
  wethHeld: number;
  tokensUsd: number;
  graveyardCount: number;
  graveyard: string[];
  openLpEth: number;
  valueNowEth: number;
  pnlEth: number;
  pnlUsd: number;
  /** false = this chain cannot reconstruct capital flow → capIn/capOut/netCap/pnl are NOT figures. */
  capKnown: boolean;
  /** true = history is a bounded window (rpc indexer), so "lifetime" means "the window". */
  partial: boolean;
}

// Cache: /pnl scans thousands of txs on a reused wallet — don't re-run on every tap.
let cache: { v: LifetimePnl; at: number } | null = null;
const CACHE_MS = 120_000;

export async function lifetimePnl(force = false): Promise<LifetimePnl> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.v;
  const w = wallet();
  const W = w.address.toLowerCase();
  // The asset the bot funds positions with and sells back into. Robinhood: WETH (unchanged).
  const quoteAddr = defaultQuoteAddr();
  const quoteL = quoteAddr.toLowerCase();
  const quoteDec = quoteDecimals(quoteAddr);
  // nativeUsd(), not ethUsd(): on a chain whose native currency is a dollar stable this is the
  // constant 1 with no network call, instead of a stale ether quote scaling every figure ~4000×.
  const px = await nativeUsd().catch(() => 0);

  const [txl, tt] = await Promise.all([
    txHistory(w.address),
    tokenTransfers(w.address, quoteAddr),
  ]);

  // null = "can't know" (no indexer / backend failed) — NOT "no transfers". See chain/indexer.ts.
  const capKnown = txl !== null;
  if (!capKnown) indexerNote("txHistory", "capital flows (deposit/withdrawal) in /pnl cannot be calculated — LP realized figures from ledger remain accurate");

  let capIn = 0;
  let capOut = 0;
  // native transfers: bridge/CEX (contract) funding counts as capital
  for (const t of txl ?? []) {
    const v = Number(fmtNat(t.value));
    if (v <= 0) continue;
    const incoming = t.to === W;
    const other = (incoming ? t.from : t.to) ?? "";
    if (INTERNAL.has(other)) continue;
    if (incoming) capIn += v;
    else capOut += v;
  }
  // Quote-asset transfers: only EOA counterparties (pools/router are LP machinery).
  // Warm the isContract cache for all unique counterparties in PARALLEL first, so the
  // loop below hits cache instead of doing sequential getCode round-trips.
  // Lenient on `token`: the REST query is already narrowed to the quote contract, and some
  // Blockscout builds spell that field differently — dropping rows with an unread token address
  // would silently zero the deposit side of /pnl on the live chain.
  const quoteRows = (tt ?? []).filter((t) => t.value > 0n && (!t.token || t.token === quoteL));
  const uniqOthers = [
    ...new Set(quoteRows.map((t) => (t.to === W ? t.from : t.to)).filter((o) => !INTERNAL.has(o))),
  ];
  await Promise.all(uniqOthers.map((a) => isContract(a)));
  for (const t of quoteRows) {
    const v = Number(ethers.formatUnits(t.value, quoteDec));
    const incoming = t.to === W;
    const other = incoming ? t.from : t.to;
    if (INTERNAL.has(other)) continue;
    if (await isContract(other)) continue; // cached now
    if (incoming) capIn += v;
    else capOut += v;
  }
  const netCapEth = capKnown ? capIn - capOut : 0;

  // current value: native + quote asset + every token valued via real sell quote + open LP
  const tk = await addressTokens(w.address);
  if (tk === null) indexerNote("addressTokens", "wallet contents (stuck tokens) cannot be read — token value counted as 0");
  let quoteHeld = 0;
  let tokensEth = 0;
  let graveyardCount = 0;
  const graveyard: string[] = [];
  // Value held tokens with BOUNDED concurrency. The wallet accumulates dozens of dust tokens from
  // churned positions (50+ here); quoting them ALL at once — each hits 4 fee tiers — fired ~200
  // parallel RPC calls that saturated the RPC AND jammed the event loop, so even the per-quote
  // timeout couldn't fire → /pnl hung ~indefinitely. mapLimit(8) keeps the burst small; the 5s
  // per-quote timeout bounds each rug/honeypot (→ treated as unsellable).
  const valued = await mapLimit(tk ?? [], 8, async (it) => {
    const bal = Number(ethers.formatUnits(it.raw, it.decimals));
    // The quote asset is held, not sold — quoting it against itself has no pool and would read 0.
    if (it.address.toLowerCase() === quoteL) return { quote: bal, sellEth: 0, sym: it.symbol, isQuote: true };
    if (bal <= 0) return null;
    let sellEth = 0;
    try {
      const q = await Promise.race([
        quoteTokenToQuote(it.address, it.raw),
        new Promise<{ out: number }>((_, rej) => setTimeout(() => rej(new Error("quote timeout")), 5000)),
      ]);
      sellEth = q.out;
    } catch {
      /* rug / honeypot / timeout → unsellable */
    }
    return { quote: 0, sellEth, sym: it.symbol || "?", isQuote: false };
  });
  const graveSeen = new Set<string>();
  for (const r of valued) {
    if (!r) continue;
    if (r.isQuote) {
      quoteHeld = r.quote;
      continue;
    }
    tokensEth += r.sellEth;
    // "stuck" = can't be sold for even $1 (rug / no liquidity / honeypot). Dedupe by symbol
    // so two contracts sharing a ticker (e.g. HASH/HASH) count once.
    if (r.sellEth * (px || 0) < 1 && !graveSeen.has(r.sym)) {
      graveSeen.add(r.sym);
      graveyardCount++;
      if (graveyard.length < 12) graveyard.push(r.sym);
    }
  }
  const tokensUsd = tokensEth * px;
  const nativeEth = Number(fmtNat(await provider.getBalance(w.address)));

  let openLpEth = 0;
  try {
    for (const r of await listPositions()) openLpEth += (r.valEth || 0) + (r.feeEth || 0);
  } catch {
    /* leave 0 */
  }
  // On a chain where the stable quote IS the native token in another precision (Arc), `nativeEth`
  // and `quoteHeld` are the SAME dollars read twice — adding both double-counts the entire wallet,
  // and since capital-in is unchanged the whole balance surfaces as profit. Count it once.
  const quoteInWallet = stableSharesNativeBalance() ? 0 : quoteHeld;
  const valueNowEth = nativeEth + quoteInWallet + tokensEth + openLpEth;
  // Without capital flow there is no PnL — only a balance. Report 0 and let capKnown say why;
  // "value − 0" would render the entire wallet as profit.
  const pnlEth = capKnown ? valueNowEth - netCapEth : 0;

  const result: LifetimePnl = {
    px,
    capIn,
    capOut,
    netCapEth,
    nativeEth,
    wethHeld: quoteHeld, // field name frozen for telegram/; it is the QUOTE asset's balance
    tokensUsd,
    graveyardCount,
    graveyard,
    openLpEth,
    valueNowEth,
    pnlEth,
    pnlUsd: pnlEth * px,
    capKnown,
    partial: historyIsBounded(),
  };
  if (!capKnown) log.warn(`/pnl on this ${natSym()}-chain without indexer: capital flows not counted (capKnown=false), current value still accurate.`);
  cache = { v: result, at: Date.now() };
  return result;
}
