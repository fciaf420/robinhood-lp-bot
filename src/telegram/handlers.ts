/** Command + callback handlers. Each renders through tg.send/edit (owner chat only). */
import { cfg, env, persist } from "../config.js";
import { tokenMeta } from "../chain/tokens.js";
import { findPools, findStableQuotePools, STABLE_QUOTE } from "../chain/pools.js";
import { dexPairs, type DexPair } from "../chain/dexscreener.js";
import { discoverV4Pools, type V4Pool } from "../chain/v4/discover.js";
import { type V2Pool } from "../chain/v2/pair.js";
import { previewRange, openPosition, openV3StableInRange, openV3StableSingleSide, listPositions, closePosition } from "../chain/positions.js";
import { readLedger, ledgerSummary, backfillLedger } from "../chain/ledger.js";
import { lifetimePnl } from "../chain/analytics.js";
import { balances, sellAllTokens, walletTokens, type WalletToken } from "../chain/holdings.js";
import { tokenBalanceRaw } from "../chain/swaps.js";
import { nativeUsd, fmtNat, fmtStable, gasReserveNat, hasWrapped, stableDecimals } from "../chain/currency.js";
import { CHAIN } from "../chain/profile.js";
import { sequencerEnabled } from "../chain/sequencer.js";
import { topVolumeNow, wcfg, usingOwnWatchRpc } from "../watch/scanner.js";
import { startWatch, stopWatch, restartWatch, isWatchOn } from "./watchLoop.js";
import { startFeed, stopFeed, feedStatus } from "./feedLoop.js";
import { autoLpStatus } from "../radar/autolp.js";
import { send, sendMenu, edit, explorerTx, sendPhoto, downloadTgFile } from "./tg.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { ethers } from "ethers";
import {
  esc, pre, padR, padL, sg, money, tokenEmoji,
  CHAIN_NAME, NAT_SYM, NAT_TAG, NAT_IS_USD, STABLE_SYM, WRAP_SYM, ROUTER_LABEL,
} from "./format.js";
import { fmtMcap, fmtAge } from "../util/format.js";
import { logger } from "../util/log.js";
import type { PoolInfo, TokenMeta, MintMode } from "../types.js";

const log = logger("handlers");

/** Unified candidate pool across Uniswap versions (v2 + v3 + v4). */
interface UPool {
  version: "v2" | "v3" | "v4";
  fee: number;
  liqLabel: string; // display, e.g. "USDG · liq $18k · vol $127k" (quote symbol from the profile)
  asset: string; // quote side symbol (WRAP_SYM / STABLE_SYM / NAT_SYM) — for the "TOKEN/asset" name
  tvl: number; // effective liquidity (USD) = max(on-chain estimate, DexScreener liq)
  vol: number; // 24h volume (USD) from DexScreener — the high-fee-farming signal
  v2?: V2Pool;
  v3?: PoolInfo;
  v4?: V4Pool;
}

const Q96 = 1n << 96n;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * The pool shapes this chain can actually have, for the "no pool found" message. On Robinhood that
 * is "v3 WETH, v3 USDG, v4 ETH, v4 USDG"; on Arc there is no wrapped native and no 0x0-sentinel v4
 * pool, so it honestly reads "v3 USDC, v4 USDC" rather than naming venues that cannot exist there.
 */
const venueList = (): string => {
  const v: string[] = [];
  if (hasWrapped()) v.push(`v3 ${WRAP_SYM}`);
  v.push(`v3 ${STABLE_SYM}`);
  if (CHAIN.venues.v4NativeCurrency) v.push(`v4 ${NAT_SYM}`);
  if (CHAIN.venues.v4) v.push(`v4 ${STABLE_SYM}`);
  return v.join(", ");
};

/**
 * Render an auto-LP cap. 0 means UNLIMITED (radar/autolp.ts `capOff`), which the operator asked for
 * explicitly — the deposit is the only limit. Printing the raw 0 read as "nothing can open".
 */
const capTxt = (n: number, unit: string): string => `${n > 0 ? n : "∞"}${unit}`;

/** Compact USD: $523 · $2.1k · $150k. */
const fmtUsdShort = (n: number): string =>
  n >= 1000 ? `$${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `$${Math.max(0, n).toFixed(0)}`;

/**
 * Total pool liquidity (USD) ≈ 2× the quote-side virtual reserve at the current price. For v3/v2
 * the quote side is the pool's REAL balance; for v4 (singleton PoolManager, no per-pool balance)
 * it's derived from the active liquidity L and sqrtPrice. A rough figure — enough to filter dust
 * (a scam 99% pool has near-zero L) and rank real pools.
 *
 * DECIMALS: the stable legs are scaled by the PROFILE's stable width, never a literal 6. The
 * native-sentinel legs stay 18-dec via fmtNat and are unreachable on a chain that forbids 0x0 in a
 * pool key (Arc), which is exactly what stops an 18-vs-6 mis-scale showing up as a 1e12 TVL.
 */
function v4TvlUsd(p: V4Pool, px: number): number {
  const L = p.liquidity;
  const sp = p.sqrtPriceX96;
  if (L <= 0n || sp <= 0n) return 0;
  const c0 = p.poolKey.currency0.toLowerCase();
  const c1 = p.poolKey.currency1.toLowerCase();
  const stableL = STABLE_QUOTE.toLowerCase();
  const sd = stableDecimals();
  // amount0 = L·2^96/sqrtP (currency0 raw) ; amount1 = L·sqrtP/2^96 (currency1 raw)
  if (c0 === ZERO_ADDR) return 2 * Number(fmtNat((L * Q96) / sp)) * px; // native = currency0
  if (c1 === ZERO_ADDR) return 2 * Number(fmtNat((L * sp) / Q96)) * px; // native = currency1
  if (c1 === stableL) return 2 * Number(ethers.formatUnits((L * sp) / Q96, sd)); // stable = currency1
  if (c0 === stableL) return 2 * Number(ethers.formatUnits((L * Q96) / sp, sd)); // stable = currency0
  return 0;
}
interface Pending {
  token: string;
  meta: TokenMeta;
  pools: UPool[];
  chosen?: UPool;
  awaitingAmount?: boolean;
  ethAmt?: string;
  heldTokenUi?: number; // token already in wallet (reused for dual-side)
  balancedEth?: number; // ETH that balances the held token for a dual-side mint
}
let pending: Pending | null = null;
// "➕ Add" flow — top up an EXISTING position (increase liquidity, not a new NFT)
let pendingAdd: { tokenId: string; version: "v3" | "v4" } | null = null;

/**
 * Native units held back for gas. Comes from the PROFILE (`native.gasReserve`), it is NOT a size
 * cap — it is a FLOOR, and on a chain where gas and LP capital are the same balance (Arc: native
 * USDC pays gas AND is the quote asset) it is the only thing that keeps a position closable.
 *
 * It used to be a hardcoded 0.0004, sized for ETH gas on Robinhood. On Arc that is four
 * ten-thousandths of a DOLLAR against a balance that is simultaneously the whole LP budget — the
 * bot would happily deploy 99.99% of the wallet and then be unable to pay for the close.
 */
const gasReserve = (): number => gasReserveNat();
const usableEth = (b: { weth: string; eth: string }): number =>
  Number(b.weth) + Math.max(0, Number(b.eth) - gasReserve());

/**
 * "Saldo bisa di-LP" line. On a chain with a wrapped native the budget is WETH + (native − reserve)
 * and BOTH are worth showing; without one (Arc) there is no WETH balance at all, so printing
 * "WETH 0.0000" next to the real number is just noise that invites the wrong conclusion.
 */
const balanceLine = (b: { weth: string; eth: string }): string =>
  hasWrapped()
    ? `Saldo bisa di-LP: <b>${usableEth(b).toFixed(5)} ${NAT_SYM}</b>  <i>(${WRAP_SYM} ${Number(b.weth).toFixed(4)} + ${NAT_SYM} ${Number(b.eth).toFixed(4)})</i>`
    : `Saldo bisa di-LP: <b>${usableEth(b).toFixed(5)} ${NAT_SYM}</b>  <i>(saldo ${Number(b.eth).toFixed(4)} − cadangan gas ${gasReserve()})</i>`;

/**
 * A computed NATIVE amount → a parseUnits-safe decimal string. A raw JS float such as
 * 0.00005454831971162516 has 20 significant decimals and makes ethers.parseUnits throw
 * "too many decimals for format"; 9 decimals is ample precision for an LP amount.
 * Returns null for non-finite / non-positive / sub-gwei dust so callers can reject it.
 */
const toEthStr = (n: number): string | null => {
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = n.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return s === "0" || s === "" ? null : s;
};

// ══════════ open flow ══════════

export async function onCA(addr: string): Promise<void> {
  await send(`🔎 <b>Cari pool v3 + v4</b> di ${esc(CHAIN_NAME)}\n<code>${addr}</code>`);
  let meta: TokenMeta;
  const all: UPool[] = [];
  // Hard-cap each read so one slow/unresponsive source (a stalled RPC, Blockscout getLogs "suka
  // lama", or a price API) can't hang the whole "Cari pool" — after `ms` we use the fallback. The
  // underlying promise keeps running, so nothing bad gets cached on our side.
  let timedOut = false; // a source hit its cap → the "no pool" result may be a false negative (RPC slow)
  const to = <T>(p: Promise<T>, ms: number, fb: T): Promise<T> =>
    Promise.race([p, new Promise<T>((r) => setTimeout(() => { timedOut = true; r(fb); }, ms))]);
  try {
    // tokenMeta drives token decimals for LP math, so we can't proceed on a guess. It was previously
    // awaited UNGUARDED here — a stalled RPC read froze the flow right after the "Cari pool" message
    // (ethers only aborts an RPC after minutes). Cap it; on timeout, bail with a retry hint.
    const m = await to(tokenMeta(addr).catch(() => null), 8000, null);
    if (!m) {
      await send(`⌛ RPC lambat — metadata token belum kebaca. Paste ulang sebentar lagi.`);
      return;
    }
    meta = m;
    const { discoverV4StablePools } = await import("../chain/v4/discover.js");
    // native price + DexScreener 24h volume + v3 (wrapped) + v3 (stable) + v4 (native) + v4 (stable),
    // all in parallel. On a chain with no wrapped native the wrapped/native legs come back EMPTY on
    // their own (findPools quotes against the zero address; discoverV4Pools refuses the 0x0 sentinel),
    // so no branch is needed here — Arc simply lands on the token/stable rows.
    // v2 dropped — fee 0.30% only, not part of the high-fee farming strategy (and it was a slow leg).
    const [px, dex, v3, v3usd, v4, v4usd] = await Promise.all([
      to(nativeUsd().catch(() => 0), 8000, 0),
      to(dexPairs(addr, Date.now()).catch(() => new Map<string, DexPair>()), 8000, new Map<string, DexPair>()),
      to(findPools(addr).catch(() => [] as PoolInfo[]), 8000, [] as PoolInfo[]),
      to(findStableQuotePools(addr).catch(() => [] as PoolInfo[]), 8000, [] as PoolInfo[]),
      // v4 = the focus. RPC getLogs (cache-first, usually <1s); give a COLD full-range scan generous
      // room to finish so pools aren't missed ("tidak terdeteksi semua") by a premature timeout.
      to(discoverV4Pools(addr).catch(() => [] as V4Pool[]), 22000, [] as V4Pool[]),
      to(discoverV4StablePools(addr).catch(() => [] as V4Pool[]), 22000, [] as V4Pool[]),
    ]);
    log.info(`Cari pool ${meta.symbol}: v3 ${v3.length + v3usd.length} · v4 ${v4.length + v4usd.length} · dex ${dex.size}${timedOut ? " · ⚠️TIMEOUT" : ""}`);
    // Enrich each pool with DexScreener 24h VOLUME (matched by pool address for v2/v3, by poolId for
    // v4). v4 standing TVL isn't readable behind a singleton PoolManager (getLiquidity is a
    // dust snapshot, DexScreener reads $0), so VOLUME is the real high-fee-farming signal.
    const mk = (version: UPool["version"], fee: number, asset: string, est: number, key: string, extra: Partial<UPool>) => {
      const d = dex.get(key.toLowerCase());
      const liq = d && d.liqUsd > 0 ? d.liqUsd : est; // DexScreener liq accurate for v2/v3; on-chain estimate for v4
      const vol = d?.vol24h ?? 0;
      const label = vol > 0 ? `${asset} · liq ${fmtUsdShort(liq)} · vol ${fmtUsdShort(vol)}` : `${asset} · liq ${fmtUsdShort(liq)}`;
      all.push({ version, fee, asset, tvl: Math.max(est, d?.liqUsd ?? 0), vol, liqLabel: label, ...extra });
    };
    for (const p of v3) mk("v3", p.fee, WRAP_SYM, 2 * p.wethInPool * px, p.pool, { v3: p });
    for (const p of v3usd) mk("v3", p.fee, STABLE_SYM, 2 * (p.usdgInPool ?? 0), p.pool, { v3: p });
    // NO `liquidity > 0` gate: v4 active-L is a JIT snapshot that flips to 0 between blocks, which
    // would drop a live, high-volume pool at random. The liq/vol filter below decides instead — a
    // pool with real 24h VOLUME stays even when its standing liquidity momentarily reads 0.
    for (const p of v4) mk("v4", p.fee, NAT_SYM, v4TvlUsd(p, px), p.poolId, { v4: p });
    for (const p of v4usd) mk("v4", p.fee, STABLE_SYM, v4TvlUsd(p, px), p.poolId, { v4: p });
  } catch (e) {
    await send(`❌ Gagal baca token/pool: ${short(e, 80)}`);
    return;
  }
  if (!all.length) {
    await send(
      timedOut
        ? `⌛ RPC lambat — pool ${esc(meta.symbol)} belum kebaca semua. Paste ulang sebentar lagi (percobaan ke-2 lebih cepet — hasilnya di-cache).`
        : `⚠️ Tidak ada pool ${esc(meta.symbol)} (${esc(venueList())}). Belum bisa LP.`,
    );
    return;
  }
  // Keep pools with real activity: standing liq ≥ min OR 24h volume ≥ min. High-fee farming lives on
  // TURNOVER, not standing TVL, so a low-liq pool with volume stays. Highest fee first, then most
  // volume. If nothing passes, show the 3 most-active anyway (with a warning) so the user isn't stuck.
  const min = cfg.lp.minPoolTvlUsd;
  const active = (p: UPool) => Math.max(p.tvl, p.vol);
  // v4 liq/vol read unreliably ($0) behind a singleton PoolManager, so DON'T hide v4 by the
  // liq/vol floor — that dropped real pools ("tidak terdeteksi semua"). Show EVERY v4 pool; the dust
  // filter applies only to v3 (reliable metrics). Busiest (most 24h vol) first, then highest fee.
  const MAX_SHOW = 14;
  let pools = all
    .filter((p) => p.version === "v4" || p.tvl >= min || p.vol >= min)
    .sort((a, b) => b.vol - a.vol || b.fee - a.fee)
    .slice(0, MAX_SHOW);
  let note = "";
  if (!pools.length) {
    pools = [...all].sort((a, b) => active(b) - active(a)).slice(0, 3);
    note = `\n⚠️ Semua pool < ${fmtUsdShort(min)} liq &amp; vol — nampilin 3 teraktif (tipis, hati-hati).`;
  }
  const dropped = all.length - pools.length;
  pending = { token: addr, meta, pools };
  // ── airy 2-line blocks (a blank line between pools = breathing room; full pair names, no truncation).
  //    HTML collapses leading spaces so the 💰 line sits flush-left, but the blank line keeps each pool
  //    a clear visual block. APR hard-capped (micro-pools give absurd %). 🔥 = has real 24h volume. ──
  const fmtFee = (f: number) => (f % 10000 === 0 ? `${f / 10000}%` : `${(f / 10000).toFixed(2)}%`);
  const aprStr = (p: UPool): string => {
    if (p.tvl <= 0 || p.vol <= 0) return "n/a";
    const a = ((p.vol * (p.fee / 1e6) * 365) / p.tvl) * 100;
    return a > 999 ? ">999%" : `${a.toFixed(0)}%`;
  };
  const realVol = cfg.scan.minVolUsd || 2000;
  const body = pools
    .map((p, i) => {
      const hot = p.vol >= realVol ? "🔥 " : "";
      const liq = p.tvl > 0 ? fmtUsdShort(p.tvl) : "n/a";
      const vol = p.vol > 0 ? fmtUsdShort(p.vol) : "n/a";
      return (
        `${hot}<b>${i + 1}. ${esc(meta.symbol)}/${p.asset}</b> · ${p.version} · <b>${fmtFee(p.fee)}</b>\n` +
        `💰 TVL ${liq}  ·  📊 24h ${vol}  ·  📈 APR ${aprStr(p)}`
      );
    })
    .join("\n\n");
  // number buttons (5/row) — pick by the list number
  const numBtns: object[][] = [];
  for (let i = 0; i < pools.length; i += 5) {
    numBtns.push(pools.slice(i, i + 5).map((_, j) => ({ text: `${i + j + 1}`, callback_data: `pool:${i + j}` })));
  }
  const dropLine = dropped > 0 && !note ? ` · +${dropped} disembunyiin` : "";
  await send(
    `🦄 <b>Pool ${esc(meta.symbol)}</b>  ·  ${pools.length} pool  ·  urut volume${dropLine}${note}\n\n` +
      `${body}\n\n` +
      `<i>🔥 = ada volume nyata (worth) · n/a = belum ke-index (sepi/baru).\nPilih nomer di bawah 👇</i>`,
    { reply_markup: { inline_keyboard: numBtns } },
  );
}

export async function onPick(idx: number, mid: number): Promise<void> {
  if (!pending) return;
  const p = pending.pools[idx];
  if (!p) return;
  pending.chosen = p;
  pending.awaitingAmount = true;
  const isUsdPool = p.v4?.quote === "usd" || p.v3?.quote === "usd";
  const [b, tokRaw, usdgRaw] = await Promise.all([
    balances().catch(() => null),
    tokenBalanceRaw(pending.token).catch(() => 0n),
    isUsdPool ? tokenBalanceRaw(STABLE_QUOTE).catch(() => 0n) : Promise.resolve(0n),
  ]);
  // token already in the wallet (e.g. bought on a prior attempt) — in-range LP reuses it, no re-buy
  const tokUi = tokRaw > 0n ? Number(tokRaw) / 10 ** pending.meta.decimals : 0;
  pending.heldTokenUi = tokUi;
  // Stable already in the wallet → offer a one-tap single-side that funds ENTIRELY from it (no
  // native input, no native→stable swap). This is the "kalo udah ada USDG, gak usah input 0.001 buat
  // swap" flow, and it reads USDC on Arc from the same code path.
  // fmtStable(), not formatUnits(_, 6): the width is the profile's, not a literal.
  const usdgUi = Number(fmtStable(usdgRaw));

  // for a v4 dual-side (in-range) mint, compute the ETH that BALANCES the held token so the
  // two sides fill evenly (no swap, minimal leftover) — this is the "hitungan sama" the user wants
  // native-paired v4 only: a "held-token-balancing" native amount is meaningless on a stable pool
  // (both sides are funded from native via the router), and computing it there mis-reads the pool
  // price → garbage.
  let balanced = 0;
  if (tokUi > 0 && p.version === "v4" && p.v4 && p.v4.quote !== "usd") {
    try {
      const { balancedEthForHeldToken } = await import("../chain/v4/mint.js");
      balanced = balancedEthForHeldToken(pending.token, pending.meta, p.v4, tokRaw);
    } catch {
      /* suggestion is best-effort */
    }
  }
  pending.balancedEth = balanced;

  const reuseLine =
    tokUi > 0 && (p.version === "v4" || p.version === "v2")
      ? `♻️ <b>${tokUi.toPrecision(4)} ${esc(pending.meta.symbol)}</b> udah di wallet — bakal <b>dipake ulang</b> (nggak beli lagi).`
      : "";
  const balLine = balanced > 0 ? `⚖️ Buat <b>dual-side seimbang</b> sama token itu: pasang <b>~${balanced.toFixed(5)} ${NAT_SYM}</b>.` : "";
  const showUsdgBtn = isUsdPool && usdgUi >= 1;
  const usdgLine = showUsdgBtn
    ? `💵 <b>$${usdgUi.toFixed(2)} ${STABLE_SYM}</b> udah di wallet — tap tombol buat <b>single-side tanpa swap / tanpa input</b>.`
    : "";
  const kbRows: { text: string; callback_data: string }[][] = [];
  if (balanced > 0) kbRows.push([{ text: `⚖️ Dual-side seimbang (~${balanced.toFixed(4)}${NAT_TAG})`, callback_data: "ballp" }]);
  // callback_data "usdgw" is a FROZEN wire value — see bot.ts. Only the label is chain-aware.
  if (showUsdgBtn) kbRows.push([{ text: `💵 Single-side pakai ${STABLE_SYM} wallet ($${usdgUi.toFixed(2)})`, callback_data: "usdgw" }]);
  const extra = kbRows.length ? { reply_markup: { inline_keyboard: kbRows } } : {};
  await edit(
    mid,
    [
      `<b>${esc(pending.meta.symbol)}</b> · <b>${p.version.toUpperCase()}</b> fee ${(p.fee / 10000).toFixed(2)}% dipilih.`,
      b ? balanceLine(b) : "",
      reuseLine,
      balLine,
      usdgLine,
      ``,
      `💬 <b>Ketik jumlah ${NAT_SYM}</b> yang mau di-LP (contoh: <code>0.005</code>)${kbRows.length ? " — atau tap tombol di bawah." : ""}`,
    ]
      .filter(Boolean)
      .join("\n"),
    extra,
  );
}

/** One-tap: dual-side v4 mint with the NATIVE amount that balances the held token. */
export async function onBalancedLp(mid: number): Promise<void> {
  if (!pending?.chosen?.v4 || !pending.balancedEth) return;
  const amt = toEthStr(pending.balancedEth);
  const b = await balances().catch(() => null);
  if (!amt || (b && Number(amt) > usableEth(b) + 1e-9)) {
    pending.awaitingAmount = true;
    await send(
      `⚠️ Nilai dual-side seimbang (${pending.balancedEth}) nggak valid / lebih gede dari saldo (${b ? usableEth(b).toFixed(5) : "?"} ${NAT_SYM}). Ketik jumlah ${NAT_SYM} manual aja (contoh: <code>0.005</code>).`,
    );
    return;
  }
  pending.ethAmt = amt;
  pending.awaitingAmount = false;
  await onMintV4(mid, "inrange");
}

/**
 * One-tap: open SINGLE-SIDE on the STABLE quote, funded ENTIRELY from the stable already in the
 * wallet — no native amount to type, no native→stable swap. Sizes the position to the full held
 * stable by passing its native-equivalent as the budget; the mint fn computes
 * target = amount×nativeUsd and reuses the held stable (buys nothing). Only native for gas is
 * needed. This is the "udah ada USDG → gak usah input 0.001 buat swap" flow.
 *
 * ONE code path, two chains: the stable is USDG on Robinhood and the 6-dec USDC predeploy on Arc,
 * both read from the profile — the copy below says whichever this chain actually uses.
 */
export async function onUseWalletStable(mid: number): Promise<void> {
  if (!pending?.chosen) return;
  const isUsd = pending.chosen.v4?.quote === "usd" || pending.chosen.v3?.quote === "usd";
  if (!isUsd) {
    await send(`Pool ini bukan pair ${STABLE_SYM} — pakai input ${NAT_SYM} biasa.`);
    return;
  }
  const [usdgRaw, b, px] = await Promise.all([
    tokenBalanceRaw(STABLE_QUOTE).catch(() => 0n),
    balances().catch(() => null),
    nativeUsd().catch(() => 0),
  ]);
  const usdgUi = Number(fmtStable(usdgRaw));
  if (usdgUi < 1) {
    await send(`${STABLE_SYM} di wallet cuma $${usdgUi.toFixed(2)} — kurang buat single-side. Input ${NAT_SYM} manual aja.`);
    return;
  }
  if (b && Number(b.eth) < gasReserve()) {
    await send(`⚠️ ${NAT_SYM} native ${Number(b.eth).toFixed(5)} &lt; cadangan gas ${gasReserve()} — mint tetep butuh gas. Isi dikit ${NAT_SYM} native dulu.`);
    return;
  }
  if (!(px > 0)) {
    await send(`⚠️ Harga ${NAT_SYM}/USD lagi gak kebaca — coba lagi bentar (butuh buat sizing ${STABLE_SYM}).`);
    return;
  }
  // USD → native-equivalent budget so the mint fn's target ≈ held stable → reuse buys nothing (no
  // swap). On a chain where the native IS the stable (Arc) px is exactly 1, so this is a no-op
  // rescale rather than a price conversion.
  pending.ethAmt = toEthStr(usdgUi / px) ?? String(usdgUi / px);
  pending.awaitingAmount = false;
  const feePct = (pending.chosen.fee / 10000).toFixed(2);
  await edit(mid, `⏳ <b>Single-side ${STABLE_SYM} pakai $${usdgUi.toFixed(2)} dari wallet…</b> (no swap · fee ${feePct}%)`);
  if (pending.chosen.version === "v4") return onMintV4(mid, "v4us");
  return onMintV3Stable(mid, true);
}

export async function onAmount(text: string): Promise<void> {
  if (!pending?.awaitingAmount || !pending.chosen) return;
  const eth = parseFloat(text);
  if (!(eth > 0)) {
    await send(`Masukin angka ${NAT_SYM} yang bener, contoh: 0.005`);
    return;
  }
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(
      `⚠️ Kegedean. Yang bisa di-LP cuma ${usableEth(b).toFixed(5)} ${NAT_SYM} (${hasWrapped() ? `${WRAP_SYM} ${Number(b.weth).toFixed(4)} + ${NAT_SYM} ${Number(b.eth).toFixed(4)}, ` : ""}sisain gas). Ketik lebih kecil.`,
    );
    return;
  }
  if (b && Number(b.eth) < gasReserve()) {
    // Without a wrapped native there is nothing to unwrap — the only fix is a deposit, so don't
    // suggest a step that can't be taken on this chain.
    await send(
      `⚠️ ${NAT_SYM} native cuma ${Number(b.eth).toFixed(5)} — kurang buat gas (butuh min ${gasReserve()}). Isi sedikit ${NAT_SYM} native${hasWrapped() ? `, ATAU unwrap dikit ${WRAP_SYM} → ${NAT_SYM}` : ""}.`,
    );
    return;
  }
  pending.ethAmt = toEthStr(eth) ?? String(eth);
  pending.awaitingAmount = false;

  // ── v2 pool → zap (full-range, always both-sided) ──
  if (pending.chosen.version === "v2") {
    await send(
      [
        `<b>Konfirmasi LP · Uniswap v2</b>`,
        `${esc(pending.meta.symbol)} · fee <b>0.30%</b> · deposit <b>${eth} ${NAT_SYM}</b> · full-range`,
        ``,
        `🎯 v2 selalu <b>both-sided 50/50</b>: bot swap ~separuh ${NAT_SYM} → ${esc(pending.meta.symbol)}, sisanya jadi pasangan LP. <b>Fee jalan LANGSUNG.</b>`,
        `⚠️ Langsung pegang token (rug = rugi ~separuh). Nggak ada single-side di v2.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 LP v2 (zap ${eth}${NAT_TAG})`, callback_data: "mint:v2" }],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      },
    );
    return;
  }

  // ── v4 pool → single-side / in-range (farming) ──
  if (pending.chosen.version === "v4") {
    const feePct = (pending.chosen.fee / 10000).toFixed(2);
    const isUsd = pending.chosen.v4?.quote === "usd";
    if (isUsd) {
      await send(
        [
          `<b>Konfirmasi LP · Uniswap v4 · ${STABLE_SYM}</b> 🦄`,
          `${esc(pending.meta.symbol)}/${STABLE_SYM} · fee <b>${feePct}%</b> · deposit <b>${eth} ${NAT_SYM}</b>`,
          ``,
          `🎯 <b>In-range (farming)</b> — beli ${STABLE_SYM} + ${esc(pending.meta.symbol)} dari ${NAT_SYM} (${ROUTER_LABEL}), mint both-sided. <b>Fee ${feePct}% jalan LANGSUNG.</b> Langsung pegang token (rug = rugi).`,
          ``,
          `🛡 <b>Single-side ${STABLE_SYM}</b> — parkir <b>${STABLE_SYM} doang (0 token)</b>, range di sisi ${STABLE_SYM}. Fee cuma pas ${esc(pending.meta.symbol)} <b>PUMP</b> masuk range. Rug-safe: kalo token dump, ${STABLE_SYM} lo utuh.`,
        ].join("\n"),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: `🎯 In-range ${feePct}% (${eth}${NAT_TAG})`, callback_data: "mint:v4r" }],
              [{ text: `🛡 Single-side ${STABLE_SYM} ${feePct}%`, callback_data: "mint:v4us" }],
              [{ text: "❌ Cancel", callback_data: "cancel" }],
            ],
          },
        },
      );
      return;
    }
    await send(
      [
        `<b>Konfirmasi mint · Uniswap v4</b> 🦄`,
        `${esc(pending.meta.symbol)} · fee <b>${feePct}%</b> · deposit <b>${eth} ${NAT_SYM}</b> · pair native ${NAT_SYM}`,
        ``,
        `🎯 <b>In-range (farming)</b> — beli token via rute terbaik (${ROUTER_LABEL}), mint di sekitar harga. <b>Fee ${feePct}% jalan LANGSUNG.</b> Tapi langsung pegang token (rug = rugi ~separuh).`,
        ``,
        `🛡 <b>Single-side ${NAT_SYM}</b> — parkir ${NAT_SYM}, range di atas harga. Fee cuma pas harga NAIK masuk range. Aman dari rug.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 In-range farming ${feePct}%`, callback_data: "mint:v4r" }],
            [{ text: `🛡 Single-side ${NAT_SYM} ${feePct}%`, callback_data: "mint:v4" }],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      },
    );
    return;
  }

  // ── v3 token/stable pool → in-range (farming) or single-side stable ──
  if (pending.chosen.v3?.quote === "usd") {
    const feePct = (pending.chosen.fee / 10000).toFixed(2);
    await send(
      [
        `<b>Konfirmasi LP · Uniswap v3 · ${STABLE_SYM}</b>`,
        `${esc(pending.meta.symbol)}/${STABLE_SYM} · fee <b>${feePct}%</b> · deposit <b>${eth} ${NAT_SYM}</b>`,
        ``,
        `🎯 <b>In-range (farming)</b> — beli ${STABLE_SYM} + ${esc(pending.meta.symbol)} dari ${NAT_SYM} (${ROUTER_LABEL}), mint both-sided. <b>Fee ${feePct}% jalan LANGSUNG.</b> Langsung pegang token (rug = rugi).`,
        ``,
        `🛡 <b>Single-side ${STABLE_SYM}</b> — parkir <b>${STABLE_SYM} doang (0 token)</b>, range di sisi ${STABLE_SYM}. Fee cuma pas ${esc(pending.meta.symbol)} <b>PUMP</b> masuk range. Rug-safe: kalo token dump, ${STABLE_SYM} lo utuh.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 In-range ${feePct}% (${eth}${NAT_TAG})`, callback_data: "mint:v3u" }],
            [{ text: `🛡 Single-side ${STABLE_SYM} ${feePct}%`, callback_data: "mint:v3us" }],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      },
    );
    return;
  }

  // ── v3 pool → single / in-range ──
  const v3pool = pending.chosen.v3!.pool;
  const [pS, pI] = await Promise.all([
    previewRange(pending.token, v3pool, "single").catch(() => null),
    previewRange(pending.token, v3pool, "inrange").catch(() => null),
  ]);
  const rng = (p: typeof pS): string => (p ? `${fmtMcap(p.rangeMcapLow)} → ${fmtMcap(p.rangeMcapHigh)}` : "?");
  await send(
    [
      `<b>Konfirmasi mint · Uniswap v3</b>`,
      `${esc(pending.meta.symbol)} · fee ${(pending.chosen.fee / 10000).toFixed(2)}% · deposit <b>${eth} ${NAT_SYM}</b> · width ${cfg.lp.widthPct}%`,
      pS ? `📊 MCAP now: <b>${fmtMcap(pS.mcapNow)}</b>` : "",
      ``,
      `🛡 <b>Single-side ${NAT_SYM}</b> — range ${rng(pS)}`,
      `   0% token. Fee jalan cuma kalau MCAP masuk range. Aman dari rug.`,
      ``,
      `🎯 <b>In-range</b> — range ${rng(pI)}`,
      `   swap ~<b>${pI?.swapPct ?? "?"}%</b> modal → ${esc(pending.meta.symbol)} duluan. Fee LANGSUNG jalan,`,
      `   tapi lu langsung pegang token (rug = rugi ${pI?.swapPct ?? "?"}% instan).`,
    ]
      .filter(Boolean)
      .join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: `🎯 In-range (swap ~${pI?.swapPct ?? "?"}%)`, callback_data: "mint:inrange" }],
          [{ text: `🛡 Single-side ${NAT_SYM}`, callback_data: "mint:single" }],
          [{ text: "❌ Cancel", callback_data: "cancel" }],
        ],
      },
    },
  );
}

export async function onMint(mid: number, action = "single"): Promise<void> {
  invalidateListCache();
  if (!pending?.chosen || !pending.ethAmt) return;
  if (pending.chosen.version === "v2") return onMintV2(mid);
  if (pending.chosen.version === "v4") return onMintV4(mid, action);
  if (pending.chosen.v3?.quote === "usd") return onMintV3Stable(mid, action === "v3us");

  const mode: MintMode = action === "inrange" ? "inrange" : "single";
  const inR = mode === "inrange";
  await edit(
    mid,
    `⏳ <b>Minting v3 ${pending.ethAmt} ${NAT_SYM}…</b> ${inR ? "(wrap → swap → approve → mint)" : "(wrap → approve → mint)"}`,
  );
  try {
    const r = await openPosition(pending.token, pending.chosen.v3!.pool, pending.ethAmt, { mode });
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)} #${r.tokenId ?? "?"}</b> [v3] ${inR ? "🎯 IN-RANGE" : "🛡 single-side"}`,
        r.wrapHash ? `wrap: <a href="${explorerTx(r.wrapHash)}">tx</a>` : "",
        r.swapHash ? `swap ${r.swappedPct}% → ${esc(sym)}: <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
        `range tick ${r.tickLower}..${r.tickUpper}`,
        `📊 entry MCAP ${fmtMcap(r.entryMcap)} · ${r.side}`,
        `deposit ~${Number(r.depositEth).toFixed(5)}${NAT_TAG}`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ Mint gagal: ${short(e, 160)}`);
  }
}

/** Mint a token/stable v3 position — both-sided in-range, or single-side stable (park stable only). */
async function onMintV3Stable(mid: number, single = false): Promise<void> {
  invalidateListCache();
  if (!pending?.chosen?.v3 || !pending.ethAmt) return;
  const feePct = (pending.chosen.fee / 10000).toFixed(2);
  await edit(mid, `⏳ <b>Minting v3 ${STABLE_SYM} ${pending.ethAmt} ${NAT_SYM}…</b> ${single ? `(${ROUTER_LABEL} → ${STABLE_SYM} → single-side)` : `(${ROUTER_LABEL} → ${STABLE_SYM}+token → mint both-sided)`}`);
  try {
    const r = single ? await openV3StableSingleSide(pending.chosen.v3, pending.ethAmt) : await openV3StableInRange(pending.chosen.v3, pending.ethAmt);
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)}/${STABLE_SYM} #${r.tokenId ?? "?"}</b> [v3] ${single ? `🛡 SINGLE-SIDE ${STABLE_SYM}` : "🎯 IN-RANGE (farming)"}`,
        r.wrapHash ? `wrap: <a href="${explorerTx(r.wrapHash)}">tx</a>` : "",
        r.swapHash ? `beli ${STABLE_SYM} (${ROUTER_LABEL}): <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
        `pool fee <b>${feePct}%</b> · range tick ${r.tickLower}..${r.tickUpper}`,
        `deposit ${r.depositEth}${NAT_TAG} · ${esc(r.side)}`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ Mint gagal: ${short(e, 160)}`);
  }
}

async function onMintV4(mid: number, action: string): Promise<void> {
  invalidateListCache();
  if (!pending?.chosen?.v4 || !pending.ethAmt) return;
  const fee = pending.chosen.v4.fee;
  const isUsd = pending.chosen.v4.quote === "usd";
  const v4pool = pending.chosen.v4;
  const usdgSingle = isUsd && action === "v4us";
  const inR = isUsd ? !usdgSingle : action === "v4r" || action === "inrange"; // native: v4r/inrange = farming
  await edit(mid, `⏳ <b>Minting v4 ${pending.ethAmt} ${NAT_SYM}…</b> ${usdgSingle ? `(${ROUTER_LABEL} → ${STABLE_SYM} → single-side)` : isUsd ? `(${ROUTER_LABEL} → ${STABLE_SYM}+token → mint)` : inR ? "(swap → Permit2 → mint in-range)" : "(simulasi → mint single-side)"}`);
  try {
    const { openV4SingleSide, openV4InRange, openV4StableInRange, openV4StableSingleSide } = await import("../chain/v4/mint.js");
    const r = usdgSingle
      ? await openV4StableSingleSide(v4pool, pending.ethAmt)
      : isUsd
        ? await openV4StableInRange(v4pool, pending.ethAmt)
        : inR
          ? await openV4InRange(pending.token, pending.ethAmt, { fee })
          : await openV4SingleSide(pending.token, pending.ethAmt, { fee });
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)} #${r.tokenId ?? "?"}</b> [v4] 🦄 ${inR ? "🎯 IN-RANGE (farming)" : "single-side"}`,
        inR && (r as any).swapHash ? `swap ${(r as any).swappedPct}% → ${esc(sym)}: <a href="${explorerTx((r as any).swapHash)}">tx</a>` : "",
        `pool fee <b>${(r.fee / 10000).toFixed(2)}%</b> · range tick ${r.tickLower}..${r.tickUpper}`,
        `deposit ${r.depositEth}${NAT_TAG}`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `Tutup: <code>/v4close ${r.tokenId}</code>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ v4 mint gagal: ${short(e, 160)}`);
  }
}

async function onMintV2(mid: number): Promise<void> {
  if (!pending?.chosen?.v2 || !pending.ethAmt) return;
  await edit(mid, `⏳ <b>LP v2 ${pending.ethAmt} ${NAT_SYM}…</b> (wrap → swap ~50% → add liquidity)`);
  try {
    const { openV2 } = await import("../chain/v2/mint.js");
    const r = await openV2(pending.token, pending.ethAmt);
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)}</b> [v2] 🎯 full-range LP`,
        r.wrapHash ? `wrap: <a href="${explorerTx(r.wrapHash)}">tx</a>` : "",
        r.swapHash ? `swap ~50% → ${esc(sym)}: <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
        `pool fee <b>0.30%</b> · deposit ${r.depositEth}${NAT_TAG}`,
        `add-LP: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `pair <code>${r.pair}</code>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ v2 LP gagal: ${short(e, 160)}`);
  }
}

// ══════════ /list ══════════

// cache the assembled /list payload so re-opening or spamming isn't a fresh multi-second on-chain
// scan each time. Refresh (force) bypasses it; any close/mint invalidates it.
let listCache: { head: string; body: string; btns: object[]; at: number } | null = null;
export function invalidateListCache(): void {
  listCache = null;
}
const LIST_TTL_MS = 20_000;

export async function onList(mid: number | null = null, force = false): Promise<void> {
  if (!force && listCache && Date.now() - listCache.at < LIST_TTL_MS) {
    const c = listCache;
    const km = { reply_markup: { inline_keyboard: c.btns } };
    await (mid ? edit(mid, c.head + "\n" + c.body, km) : send(c.head + "\n" + c.body, km));
    return;
  }
  if (!mid) {
    const m = await send("⏳ Memuat posisi…");
    mid = m?.result?.message_id ?? null;
  }
  const out = (txt: string, extra?: Record<string, unknown>) => (mid ? edit(mid, txt, extra) : send(txt, extra));
  const { listV4Positions } = await import("../chain/v4/list.js");
  // v3 + v4 in parallel (v2 dropped — fee 0.30% only, not part of the high-fee farming strategy)
  // v4 served from the ≤90s background snapshot (manage loop keeps it warm) so /list prints instantly
  // instead of racing the RPC against the hunt scan. 🔄 Refresh (force) recomputes fresh.
  const _t0 = Date.now();
  const [v3t, v4t] = [{ ms: 0 }, { ms: 0 }];
  const [rowsRes, v4rows] = await Promise.all([
    (async () => { const s = Date.now(); const r = await listPositions().then((r) => ({ ok: true as const, r })).catch((e) => ({ ok: false as const, e })); v3t.ms = Date.now() - s; return r; })(),
    (async () => { const s = Date.now(); const r = await listV4Positions(force ? 0 : 90_000).catch(() => [] as Awaited<ReturnType<typeof listV4Positions>>); v4t.ms = Date.now() - s; return r; })(),
  ]);
  const _px0 = Date.now();
  log.info(`/list timing: v3 ${v3t.ms}ms · v4 ${v4t.ms}ms (${v4rows.length}pos, force=${force}) · data-total ${_px0 - _t0}ms`);
  if (!rowsRes.ok) {
    await out(`❌ ${short(rowsRes.e, 80)}`);
    return;
  }
  const rows = rowsRes.r;
  const refreshBtn = [{ text: "🔄 Refresh", callback_data: "refresh" }];
  if (!rows.length && !v4rows.length) {
    await out("Tidak ada posisi LP terbuka (v3/v4).", { reply_markup: { inline_keyboard: [refreshBtn] } });
    return;
  }
  const px = await nativeUsd().catch(() => 0);
  const usd = (e: number) => (px ? `$${(e * px).toFixed(2)}` : "?");
  let totEth = 0, totPnl = 0, totFee = 0, totDep = 0;

  const T: string[] = [];
  rows.forEach((r, i) => {
    totEth += r.valEth || 0;
    totFee += r.feeEth || 0;
    totDep += r.depEth || 0;
    if (r.pnlEth != null) totPnl += r.pnlEth;
    const hrs = r.ageMs ? r.ageMs / 3_600_000 : 0;
    const rate = hrs > 0.05 && r.feeEth ? `${usd(r.feeEth / hrs)}/jam` : "—";
    const tag = `${r.inRange ? "🟢 IN RANGE" : "🔴 OUT OF RANGE"}${r.mode === "inrange" ? " · 🎯" : ""}`;
    if (i) T.push("");
    T.push(`${tokenEmoji(r.tokenSym)} ${r.pair ?? `${r.tokenSym}/${WRAP_SYM}`}  ·  fee ${(r.fee / 10000).toFixed(2)}%  ·  #${r.tokenId}`);
    T.push(`   ${tag}`);
    T.push("   " + "─".repeat(34));
    T.push(`   ${padR("modal", 7)} ${padL(r.depEth != null ? r.depEth.toFixed(6) + NAT_TAG : "—", 11)}  ${padL(r.depEth != null ? usd(r.depEth) : "—", 9)}`);
    T.push(`   ${padR("nilai", 7)} ${padL(r.valEth.toFixed(6) + NAT_TAG, 11)}  ${padL(usd(r.valEth), 9)}`);
    T.push(`   ${padR("fee", 7)} ${padL(r.feeEth.toFixed(6) + NAT_TAG, 11)}  ${padL(usd(r.feeEth), 9)}`);
    T.push(`   ${padR("umur", 7)} ${padL(fmtAge(r.ageMs) + (r.ageSource === "onchain" ? " ⛓" : ""), 11)}  ${rate}`);
    T.push(`   ${padR("MCAP", 7)} ${padL(fmtMcap(r.mcapNow), 11)}  ${r.entryMcap ? "entry " + fmtMcap(r.entryMcap) : "—"}`);
    if (r.rangeMcapHigh > 0) T.push(`   ${padR("range", 7)} ${fmtMcap(r.rangeMcapLow)} → ${fmtMcap(r.rangeMcapHigh)}`);
    if (r.pnlEth != null) {
      T.push(`   ${padR("PnL", 7)} ${padL(sg(r.pnlEth, 6) + NAT_TAG, 11)}  ${padL((r.pnlEth >= 0 ? "+" : "-") + "$" + Math.abs(r.pnlEth * px).toFixed(2), 9)}  ${sg(r.pnlPct ?? 0, 1)}%`);
    } else {
      T.push(`   ${padR("PnL", 7)} — (deposit tak tercatat)`);
    }
  });

  const dupe: Record<string, number> = {};
  rows.forEach((r) => (dupe[r.tokenSym] = (dupe[r.tokenSym] || 0) + 1));
  const btns: object[] = [refreshBtn];
  rows.forEach((r) => {
    const p =
      r.pnlEth != null
        ? ` ${r.pnlEth >= 0 ? "🟩" : "🟥"} ${r.pnlEth >= 0 ? "+" : "-"}$${Math.abs(r.pnlEth * px).toFixed(2)} · ${sg(r.pnlPct ?? 0, 1)}%`
        : "";
    const id = dupe[r.tokenSym]! > 1 ? ` #${r.tokenId}` : "";
    btns.push([{ text: `Close ${r.tokenSym}${id}${p}`, callback_data: `close:${r.tokenId}` }]);
  });
  if (rows.length > 1) btns.push([{ text: `🗑🗑 CLOSE ALL (${rows.length} posisi)`, callback_data: "closeall" }]);

  // ── v4 positions block ──
  const T4: string[] = [];
  if (v4rows.length) {
    T4.push(`🦄 UNISWAP v4 · ${v4rows.length} posisi`);
    T4.push("─".repeat(37));
    v4rows.forEach((r, i) => {
      const vEth = px ? r.valueUsd / px : 0;
      const fEth = px ? r.feeUsd / px : 0;
      totEth += vEth;
      totFee += fEth;
      if (r.depEth != null) {
        totDep += r.depEth;
        totPnl += vEth - r.depEth;
      }
      if (i) T4.push("");
      T4.push(`${tokenEmoji(r.sym)} ${r.pair}  ·  fee ${(r.fee / 10000).toFixed(2)}%  ·  #${r.tokenId}`);
      T4.push(`   ${r.inRange ? "🟢 IN RANGE" : "🔴 OUT OF RANGE"}${r.ethPaired ? "" : ` · non-${NAT_SYM} pair`}`);
      T4.push(`   ${padR("nilai", 7)} $${r.valueUsd.toFixed(2)}`);
      T4.push(`   ${padR("isi", 7)} ${r.amount0} ${r.sym0} + ${r.amount1} ${r.sym1}`);
      T4.push(`   ${padR("fee", 7)} $${r.feeUsd.toFixed(2)} earned`);
      if (r.depEth != null) T4.push(`   ${padR("modal", 7)} ${r.depEth.toFixed(6)}${NAT_TAG} (${usd(r.depEth)})`);
      T4.push(`   ${padR("umur", 7)} ${fmtAge(r.ageMs)}`);
    });
    const dupe4: Record<string, number> = {};
    v4rows.forEach((r) => (dupe4[r.sym] = (dupe4[r.sym] || 0) + 1));
    for (const r of v4rows) {
      const idTag = dupe4[r.sym]! > 1 ? ` #${r.tokenId}` : "";
      const row: object[] = [];
      // only offer Claim when there's fee worth claiming
      if (r.feeUsd > 0.01) row.push({ text: `💰 Claim`, callback_data: `v4f:${r.tokenId}` });
      row.push({ text: `➕ Add`, callback_data: `add4:${r.tokenId}` });
      row.push({ text: `Close ${r.sym}${idTag}`, callback_data: `v4c:${r.tokenId}` });
      btns.push(row);
    }
  }

  // ── unified TOTAL (v3 + v4), always LAST ──
  const totalCount = rows.length + v4rows.length;
  const S: string[] = [];
  if (totalCount > 1) {
    S.push(`TOTAL ${totalCount} posisi  ·  v3 ${rows.length} · v4 ${v4rows.length}`);
    S.push("─".repeat(37));
    S.push(`${padR("modal", 7)} ${padL(totDep.toFixed(6) + NAT_TAG, 11)}  ${padL(usd(totDep), 9)}`);
    S.push(`${padR("nilai", 7)} ${padL(totEth.toFixed(6) + NAT_TAG, 11)}  ${padL(usd(totEth), 9)}`);
    S.push(`${padR("fee", 7)} ${padL(totFee.toFixed(6) + NAT_TAG, 11)}  ${padL(usd(totFee), 9)}`);
    S.push(`${padR("PnL", 7)} ${padL(sg(totPnl, 6) + NAT_TAG, 11)}  ${padL((totPnl >= 0 ? "+" : "-") + "$" + Math.abs(totPnl * px).toFixed(2), 9)}`);
  }

  const jam = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  // The chain name is in the header on purpose: /list is the screen the operator acts on, and two
  // bots in two chats render identical-looking position lists. A rate badge is only meaningful when
  // the native currency ISN'T a dollar — "· USDC $1" would be noise.
  const head = `📋 <b>Posisi LP</b> · ${esc(CHAIN_NAME)}${px && !NAT_IS_USD ? ` · ${NAT_SYM} $${px.toFixed(0)}` : ""} · <i>${jam}</i>`;
  const body =
    (rows.length ? pre(T.join("\n")) : "") +
    (T4.length ? pre(T4.join("\n")) : "") +
    (S.length ? pre(S.join("\n")) : "");
  listCache = { head, body, btns, at: Date.now() };
  await out(head + "\n" + body, { reply_markup: { inline_keyboard: btns } });
}

// ══════════ /ledger ══════════

const LEDGER_PER_PAGE = 5;
// cache the slow on-chain v4 "closed positions" scan so paginating (Next/Back) is instant
let ledgerHistCache: { v4hist: Awaited<ReturnType<typeof import("../chain/v4/list.js")["listClosedV4Positions"]>>; at: number } | null = null;
export async function onLedger(page = 0, mid: number | null = null): Promise<void> {
  const out = (txt: string, extra?: Record<string, unknown>) => (mid ? edit(mid, txt, extra) : send(txt, extra));
  const { listClosedV4Positions } = await import("../chain/v4/list.js");
  const allEntries = readLedger(); // unified: v3 + v4 + v2 (forward-tracked closes) — cheap (file)
  const entryIds = new Set(allEntries.map((e) => e.tokenId));
  // v4 historical scan (on-chain, per-NFT → slow) is CACHED so Next/Back doesn't refetch each page
  let v4hist: Awaited<ReturnType<typeof listClosedV4Positions>>;
  if (ledgerHistCache && Date.now() - ledgerHistCache.at < 45_000) {
    v4hist = ledgerHistCache.v4hist.filter((c) => !entryIds.has(c.tokenId));
  } else {
    const v4closedRaw = await listClosedV4Positions().catch(() => [] as Awaited<ReturnType<typeof listClosedV4Positions>>);
    ledgerHistCache = { v4hist: v4closedRaw, at: Date.now() };
    v4hist = v4closedRaw.filter((c) => !entryIds.has(c.tokenId));
  }
  const sum = ledgerSummary();

  if (!allEntries.length && !v4hist.length) {
    await out("⏳ <b>Ledger kosong — rebuild dari on-chain…</b>");
    try {
      await backfillLedger();
    } catch (e) {
      await out(`❌ Rebuild gagal: ${short(e, 90)}`);
      return;
    }
    if (!readLedger().length) {
      await out("📒 Belum ada posisi LP yang pernah ditutup.\n<i>Keisi otomatis tiap lu close posisi.</i>");
      return;
    }
    return onLedger(page, mid);
  }

  // unified closed list, RECENT FIRST (v3 + v4 + v2 entries interleaved by close time;
  // v4 positions closed before tracking shown last with PnL unavailable)
  type LedRow = { e?: (typeof allEntries)[number]; v4h?: (typeof v4hist)[number]; ts: number };
  const combined: LedRow[] = [
    ...allEntries.map((e) => ({ e, ts: e.closedAt ?? 0 })),
    ...v4hist.map((c) => ({ v4h: c, ts: c.closedAt ?? 0 })),
  ].sort((a, b) => b.ts - a.ts);
  const pages = Math.max(1, Math.ceil(combined.length / LEDGER_PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = combined.slice(page * LEDGER_PER_PAGE, page * LEDGER_PER_PAGE + LEDGER_PER_PAGE);
  const px = await nativeUsd().catch(() => 0);
  const when = (ts: number | null) =>
    ts ? new Date(ts).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "?";
  const verTag = (v?: string) => (v === "v4" ? "v4 🦄" : v === "v2" ? "v2 💧" : "v3");

  const T: string[] = [];
  slice.forEach((row, i) => {
    const n = page * LEDGER_PER_PAGE + i + 1;
    if (i) T.push("");
    if (row.e) {
      const e = row.e;
      const name = e.pair ?? `${e.sym}/${WRAP_SYM}`; // v3 has no pair field → always token/wrapped-native
      const win = e.pnlEth == null ? "⬜" : e.pnlEth >= 0 ? "🟩" : "🟥";
      T.push(`${win} ${tokenEmoji(e.sym)} ${name} · ${verTag(e.version)}${e.mode === "inrange" ? " 🎯" : ""}   ${n}/${combined.length}`);
      T.push(`   ${when(e.closedAt)} · hold ${fmtAge(e.heldMs)}`);
      if (e.quote === "usd") {
        // stable-quoted pools → show USD (the natural unit); the native amount is secondary
        const at = e.ethUsdAtClose || px || 0;
        const $ = (eth: number) => "$" + (eth * at).toFixed(2);
        T.push(`   modal ${$(e.depEth ?? 0)} → balik ${$(e.outEth ?? 0)}`);
        if (e.pnlEth != null) T.push(`   PnL ${e.pnlUsd != null ? money(e.pnlUsd) : $(e.pnlEth)}  (${sg(e.pnlEth, 5)}${NAT_TAG})  ${sg(e.pnlPct ?? 0, 1)}%`);
        else T.push(`   PnL — (modal tak tercatat)`);
      } else {
        T.push(`   modal ${(e.depEth ?? 0).toFixed(5)}${NAT_TAG} → balik ${(e.outEth ?? 0).toFixed(5)}${NAT_TAG}`);
        if (e.pnlEth != null) T.push(`   PnL ${sg(e.pnlEth, 5)}${NAT_TAG}  ${e.pnlUsd != null ? money(e.pnlUsd) : "—"}  ${sg(e.pnlPct ?? 0, 1)}%`);
        else T.push(`   PnL — (modal tak tercatat)`);
      }
      if ((e.unsoldEth ?? 0) > 0) T.push(`   🪙 nyangkut ~${(e.unsoldEth ?? 0).toFixed(5)}${NAT_TAG} (blm dijual)`);
    } else if (row.v4h) {
      const c = row.v4h;
      T.push(`⬜ ${tokenEmoji(c.pair)} ${c.pair} · v4 🦄   ${n}/${combined.length}`);
      T.push(`   ${when(c.closedAt)} · #${c.tokenId} · fee ${(c.fee / 10000).toFixed(2)}%`);
      T.push(`   PnL — (histori sblm tracking${c.depEth != null ? `, modal ${c.depEth.toFixed(5)}${NAT_TAG}` : ""})`);
    }
  });

  const nV3 = allEntries.filter((e) => (e.version ?? "v3") === "v3").length;
  const nV4 = allEntries.filter((e) => e.version === "v4").length + v4hist.length;
  const nV2 = allEntries.filter((e) => e.version === "v2").length;
  const net = sum.pnlEth + sum.unsoldEth;
  const S: string[] = [];
  S.push(`${combined.length} DITUTUP · ${nV3} v3 · ${nV4} v4${nV2 ? ` · ${nV2} v2` : ""}`);
  S.push("─".repeat(34));
  S.push(`${padR("menang", 9)} ${sum.wins}W / ${sum.losses}L · ${sum.winRate.toFixed(0)}%`);
  S.push(`${padR("modal", 9)} ${sum.depEth.toFixed(5)}${NAT_TAG} · fee ${sum.feeEth.toFixed(5)}${NAT_TAG}`);
  S.push(`${padR("REALIZED", 9)} ${sg(sum.pnlEth, 5)}${NAT_TAG} · ${money(sum.pnlUsd)}`);
  if (sum.unsoldEth > 0) S.push(`${padR("nyangkut", 9)} +${sum.unsoldEth.toFixed(5)}${NAT_TAG} · +$${(sum.unsoldEth * px).toFixed(2)}`);
  S.push(`${padR("NET", 9)} ${sg(net, 5)}${NAT_TAG} · ${money(net * px)}`);

  const nav: object[] = [];
  if (page > 0) nav.push({ text: "◀️ Back", callback_data: `lg:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: `lg:${page}` });
  if (page < pages - 1) nav.push({ text: "Next ▶️", callback_data: `lg:${page + 1}` });

  const head = `📒 <b>Ledger LP</b> · ${combined.length} posisi ditutup`;
  const foot = v4hist.length
    ? `<i>Stats gabung v3+v4+v2. ${v4hist.length} posisi v4 LAMA blm direkonstruksi — tap 🔄 Rebuild.</i>`
    : "";
  // 📸 card button per closed position on this page (positions with recorded PnL)
  const cardBtns: object[] = [];
  slice.forEach((row) => {
    if (row.e && row.e.pnlEth != null) {
      const e = row.e;
      const p = e.pnlEth! >= 0 ? "🟩" : "🟥";
      cardBtns.push([{ text: `📸 ${tokenEmoji(e.sym)} ${e.pair ?? `${e.sym}/${WRAP_SYM}`} ${p}`, callback_data: `cardp:${e.tokenId}` }]);
    }
  });
  await out(head + "\n" + pre(T.join("\n")) + pre(S.join("\n")) + foot, {
    reply_markup: {
      inline_keyboard: [
        nav,
        ...cardBtns,
        [{ text: "📸 Kartu portfolio", callback_data: "card" }, { text: "🔄 Rebuild on-chain", callback_data: "lgrb" }],
      ],
    },
  });
}

export async function onLedgerRebuild(mid: number): Promise<void> {
  ledgerHistCache = null; // force a fresh on-chain scan
  try {
    const prog = (msg: string) => void edit(mid, `⏳ <b>Rebuild ledger dari on-chain</b>\n<i>${esc(msg)}</i>`).catch(() => {});
    const r = await backfillLedger(prog);
    // v4 positions closed before tracking → reconstruct realized PnL from archive (historical price)
    const { backfillLedgerV4 } = await import("../chain/v4/backfill.js");
    const r4 = await backfillLedgerV4(prog).catch(() => ({ rebuilt: 0 }));
    await edit(mid, `✅ Rebuild selesai — v3: ${r.rebuilt} · v4: ${r4.rebuilt} direkonstruksi dari on-chain.`);
    await onLedger(0);
  } catch (e) {
    await edit(mid, `❌ Rebuild gagal: ${short(e, 100)}`);
  }
}

// ══════════ /scan (manual) ══════════

// ══════════ /screen (GMGN 24h thesis screen) ══════════

export async function onScreen(arg?: string): Promise<void> {
  // /screen IS the GMGN screener — there is no on-chain substitute for its tax/holder/honeypot
  // fields. Refusing up front beats a "GMGN nggak balikin data" that reads like a transient outage.
  const { gmgnSupported } = await import("../radar/gmgn.js");
  if (!gmgnSupported()) {
    await send(
      `🧪 <b>GMGN nggak nyover ${esc(CHAIN_NAME)}</b> — gate honeypot/tax/top-10/rug nggak bisa dievaluasi di sini.\n` +
        `Pakai <code>/hunt now</code> (kandidat on-chain: pool baru + lonjakan volume). Skor maksimalnya lebih rendah, emang disengaja — yang nggak kecek nggak dikasih poin.`,
    );
    return;
  }
  const useLlm = arg !== "fast" && !!env.openrouterKey;
  const m = await send(`🧪 <b>Screening GMGN 24h…</b> <i>(mcap&gt;$500k · vol&gt;$1M · no flap${useLlm ? " · +thesis LLM" : ""})</i>`);
  const mid = m?.result?.message_id;
  try {
    const { screenTokens } = await import("../radar/screen.js");
    const { results, scanned, excludedFlap, excludedUnsafe } = await screenTokens({ llm: useLlm });
    if (!scanned) {
      await edit(mid, "🧪 GMGN nggak balikin data trending (CLI belum aktif / rate-limit). Coba lagi.");
      return;
    }
    if (!results.length) {
      await edit(mid, `🧪 Nggak ada token lolos filter.\n<i>scan ${scanned} · buang ${excludedFlap} flap · ${excludedUnsafe} unsafe</i>`);
      return;
    }
    const kindTag = (k: string) => (k === "util" ? "🛠 util" : k === "meme" ? "🐸 meme" : "❓ unclear");
    const commTag = (c: string) => (c === "clear" ? "🟢 komun jelas" : c === "thin" ? "🟡 komun tipis" : "🔴 komun sus");
    const T: string[] = [];
    results.forEach((r, i) => {
      const t = r.token;
      if (i) T.push("");
      T.push(`${i + 1}. ${tokenEmoji(t.symbol)} ${t.symbol}  ·  ${kindTag(r.kind)}  ·  skor ${r.score}${r.verdict ? " · " + r.verdict.toUpperCase() : ""}`);
      T.push(`   ${commTag(r.community)} · FOMO ${r.fomo}`);
      T.push(`   mcap ${fmtMcap(t.marketCap)} · vol ${fmtMcap(t.volume)} · liq ${fmtMcap(t.liquidity)}`);
      const turn = t.liquidity > 0 ? (t.volume / t.liquidity).toFixed(0) + "×" : "?";
      T.push(`   turn ${turn} · 24h ${sg(t.change24hPct, 0)}% · smart ${t.smartWallets} · KOL ${t.kolWallets} · hold ${t.holders}`);
      if (r.thesis) T.push(`   💡 ${r.thesis}`);
      if (r.flags.length) T.push(`   🚩 ${r.flags.join(" · ")}`);
    });
    const head = `🧪 <b>Screen GMGN 24h</b> — ${results.length} kandidat\n<i>scan ${scanned} · buang ${excludedFlap} flap · ${excludedUnsafe} unsafe</i>`;
    // LP shortcut buttons for the top 6
    const btns = results.slice(0, 6).map((r) => [
      { text: `${tokenEmoji(r.token.symbol)} LP ${r.token.symbol} (${r.score})`, callback_data: `ca:${r.token.address}` },
    ]);
    btns.push([{ text: "🔄 Refresh", callback_data: "screen" }]);
    await edit(mid, head + "\n" + pre(T.join("\n")), { reply_markup: { inline_keyboard: btns } });
  } catch (e) {
    await edit(mid, `❌ Screen gagal: ${short(e, 120)}`);
  }
}

export async function onScan(): Promise<void> {
  const { scanOnce } = await import("../watch/scanner.js");
  const m = await send("🔍 Scan volume…");
  const mid = m?.result?.message_id;
  try {
    const hits = await scanOnce((msg) => {
      if (mid) void edit(mid, `🔍 <i>${esc(msg)}</i>`).catch(() => {});
    });
    const { handleSpike } = await import("./pipeline.js");
    if (!hits.length) {
      await edit(mid, "🔍 Nggak ada token yang lolos filter barusan.\n<i>(butuh 2 scan buat ngukur kenaikan — coba lagi bentar)</i>");
      return;
    }
    await edit(mid, `🔍 <b>${hits.length} token</b> lolos:`);
    for (const h of hits) await handleSpike(h);
  } catch (e) {
    await edit(mid, `❌ Scan gagal: ${short(e, 90)}`);
  }
}

// ══════════ /watch ══════════

export async function onWatch(arg?: string): Promise<void> {
  const w = wcfg();
  if (arg === "on") {
    cfg.watch.enabled = true;
    persist();
    startWatch();
    await send("👁 Watch <b>ON</b>.");
    return;
  }
  if (arg === "off") {
    cfg.watch.enabled = false;
    persist();
    stopWatch();
    await send("👁 Watch <b>OFF</b>.");
    return;
  }
  const T = [
    `${padR("status", 12)} ${isWatchOn() ? "ON" : "OFF"}`,
    `${padR("scan tiap", 12)} ${w.intervalSec}s`,
    `${padR("vol 5m min", 12)} $${(w.minVol5m / 1000).toFixed(0)}k`,
    `${padR("naik min", 12)} ${w.riseFactor}× vs scan sebelumnya`,
    `${padR("vol 1h min", 12)} $${(w.minVol1h / 1000).toFixed(0)}k`,
    `${padR("likuid min", 12)} $${(w.minLiqUsd / 1000).toFixed(0)}k`,
    `${padR("tax maks", 12)} ${w.maxTaxPct}%`,
    `${padR("cooldown", 12)} ${w.cooldownMin} menit/token`,
    `${padR("RPC", 12)} ${usingOwnWatchRpc ? "terpisah (khusus scan)" : "numpang RPC LP"}`,
  ];
  const top = await topVolumeNow(3).catch(() => []);
  if (top.length) {
    T.push("");
    T.push("VOL 5m TERTINGGI SEKARANG");
    for (const t of top) {
      const pass = t.vol5m >= w.minVol5m;
      T.push(`  ${pass ? "✓" : " "} ${padR(t.symbol.slice(0, 10), 11)} $${(t.vol5m / 1000).toFixed(0)}k`);
    }
    const gap = w.minVol5m / Math.max(top[0]!.vol5m, 1);
    T.push(gap > 1 ? `  → ambang ${gap.toFixed(1)}× di atas puncak: SEPI` : `  → ada yang lewat ambang`);
  }
  await send(
    `👁 <b>Volume Watch</b>${pre(T.join("\n"))}<code>/watch on</code> · <code>/watch off</code> · <code>/scan</code> (cek sekarang)\nUbah: <code>/set vol5m 200000</code> · <code>/set rise 2</code> · <code>/set liq 100000</code>`,
  );
}

// ══════════ /feed (real-time sequencer monitor) ══════════

export async function onFeed(arg?: string): Promise<void> {
  // The feed monitor subscribes to the SEQUENCER stream. A validator L1 (Arc) has no such endpoint,
  // so say that instead of flipping cfg.feed.enabled on and leaving a monitor that can never start.
  if (arg === "on" && !sequencerEnabled()) {
    await send(
      `📡 Feed monitor butuh sequencer — <b>${esc(CHAIN_NAME)}</b> nggak punya (validator L1, finality langsung).\n` +
        `Pakai <code>/watch</code> (scanner volume) + <code>/hunt</code> buat deteksi token baru di chain ini.`,
    );
    return;
  }
  if (arg === "on") {
    cfg.feed.enabled = true;
    persist();
    await startFeed();
    await send("📡 Feed monitor <b>ON</b> — deteksi token baru + posisi out-of-range real-time.");
    return;
  }
  if (arg === "off") {
    cfg.feed.enabled = false;
    persist();
    stopFeed();
    await send("📡 Feed monitor <b>OFF</b>.");
    return;
  }
  const s = feedStatus();
  const f = cfg.feed;
  const r = cfg.radar;
  const T = [
    `${padR("status", 16)} ${s.on ? "ON" : "OFF"}`,
    `${padR("new-token alert", 16)} ${f.newToken ? "on" : "off"}`,
    `${padR("position monitor", 16)} ${f.positionMonitor ? "on" : "off"}`,
    `${padR("auto-close OOR", 16)} ${f.autoCloseOutOfRange ? "⚠️ ON" : "off"}`,
    `${padR(`min ${WRAP_SYM} seed`, 16)} ${f.newTokenMinWethSeed}${NAT_TAG}`,
    ``,
    `${padR("radar LLM", 16)} ${r.enabled ? (env.openrouterKey ? "on" : "on (no key!)") : "off"}`,
    `${padR("radar model", 16)} ${env.openrouterModel}`,
    `${padR("radar GMGN", 16)} ${r.useGmgn ? "on" : "off"}`,
    `${padR("fast-submit", 16)} ${!sequencerEnabled() ? `n/a (${CHAIN_NAME} gak punya sequencer)` : env.fastSubmit ? "ON → sequencer" : "off (via RPC)"}`,
    ``,
    `${padR("token dikenal", 16)} ${s.seen}`,
    `${padR("posisi dipantau", 16)} ${s.positions}`,
    `${padR("token baru", 16)} ${s.newTokens}`,
    `${padR("alert range", 16)} ${s.rangeAlerts}`,
  ];
  await send(
    `📡 <b>Sequencer Feed Monitor</b>${pre(T.join("\n"))}` +
      `<code>/feed on</code> · <code>/feed off</code>\n` +
      `Toggle: <code>/set newtoken 1</code> · <code>/set posmon 1</code> · <code>/set autoclose 0</code>\n` +
      `Radar: <code>/set radar 1</code> · <code>/set gmgn 1</code>\n` +
      (sequencerEnabled()
        ? `<i>⚠️ Lokal (Telkomsel) butuh RH_FEED_IP=172.66.147.70. fast-submit: RH_FAST_SUBMIT=1. radar: RH_OPENROUTER_KEY.</i>`
        : `<i>⚠️ ${esc(CHAIN_NAME)} nggak punya sequencer → feed &amp; fast-submit MATI di sini. radar: RH_OPENROUTER_KEY.</i>`),
  );
}

// ══════════ /v4 (detect v4 pools) ══════════

export async function onV4(ca?: string): Promise<void> {
  // The v4 pairing this chain actually has: native on Robinhood, the stable everywhere a 0x0 pool
  // key is forbidden (Arc). Probing the native path there would always come back empty.
  const v4Quote = CHAIN.venues.v4NativeCurrency ? NAT_SYM : STABLE_SYM;
  if (!ca || !/^0x[a-fA-F0-9]{40}$/.test(ca)) {
    await send(`Format: <code>/v4 0x…</code> (CA token) — liat pool v4/${v4Quote} + fee + likuiditas.`);
    return;
  }
  const m = await send(`🔎 Cek pool v4 <code>${ca}</code>…`);
  const mid = m?.result?.message_id;
  try {
    const { discoverV4Pools, discoverV4StablePools, pickV4Pool } = await import("../chain/v4/discover.js");
    const meta = await tokenMeta(ca).catch(() => null);
    const pools = CHAIN.venues.v4NativeCurrency ? await discoverV4Pools(ca) : await discoverV4StablePools(ca);
    if (!pools.length) {
      await edit(mid, `Nggak ada pool v4/${v4Quote} buat ${meta?.symbol ?? "token"} ini.`);
      return;
    }
    const T = pools
      .sort((a, b) => b.fee - a.fee)
      .map((p) => `  ${padR((p.fee / 10000).toFixed(2) + "%", 7)} ${p.liquidity > 0n ? "✅ ada likuiditas" : "— kosong"}  tick ${p.tick}`);
    const pick = pickV4Pool(pools);
    await edit(
      mid,
      `🦄 <b>Pool v4/${v4Quote} · ${esc(meta?.symbol ?? "?")}</b>${pre(T.join("\n"))}` +
        (pick ? `Target LP (fee tertinggi + likuid): <b>${(pick.fee / 10000).toFixed(2)}%</b>\n` : "") +
        `<i>Mint/close v4 = Fase 2 (lagi dibangun). Sekarang deteksi doang.</i>`,
    );
  } catch (e) {
    await edit(mid, `❌ ${short(e, 90)}`);
  }
}

// ══════════ /v4lp /v4close (v4 LP execution — single-side ETH) ══════════

export async function onV4Lp(text: string): Promise<void> {
  const [, ca, ethStr] = text.split(/\s+/);
  if (!ca || !/^0x[a-fA-F0-9]{40}$/.test(ca) || !ethStr || !(parseFloat(ethStr) > 0)) {
    await send(`Format: <code>/v4lp 0x… 0.001</code> — buka LP v4 single-side ${NAT_SYM} di pool fee-tertinggi.`);
    return;
  }
  const eth = parseFloat(ethStr);
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(`⚠️ Kegedean. Bisa di-LP cuma ${usableEth(b).toFixed(5)} ${NAT_SYM}.`);
    return;
  }
  const m = await send(`⏳ <b>Mint v4 ${eth} ${NAT_SYM}…</b> (discover pool → simulasi → mint native ${NAT_SYM})`);
  const mid = m?.result?.message_id;
  try {
    const { openV4SingleSide } = await import("../chain/v4/mint.js");
    const r = await openV4SingleSide(ca, String(eth));
    await edit(
      mid,
      [
        `✅ <b>v4 LP dibuka</b> #${r.tokenId ?? "?"} 🦄`,
        `pool fee <b>${(r.fee / 10000).toFixed(2)}%</b> · single-side ${NAT_SYM}`,
        `range tick ${r.tickLower}..${r.tickUpper} · deposit ${r.depositEth}${NAT_TAG}`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `Tutup: <code>/v4close ${r.tokenId}</code>`,
      ].join("\n"),
    );
  } catch (e) {
    await edit(mid, `❌ v4 mint gagal: ${short(e, 160)}`);
  }
}

export async function onV4Close(text: string): Promise<void> {
  invalidateListCache();
  const [, tokenId] = text.split(/\s+/);
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    await send("Format: <code>/v4close &lt;tokenId&gt;</code>");
    return;
  }
  const m = await send(`⏳ Closing v4 #${tokenId}…`);
  const mid = m?.result?.message_id;
  try {
    const { closeV4Position } = await import("../chain/v4/close.js");
    const r = await closeV4Position(tokenId);
    await edit(
      mid,
      [
        `✅ <b>v4 #${tokenId} closed</b> · pool fee ${(r.fee / 10000).toFixed(2)}%`,
        `Balik: ${r.recv0 > 0 ? `${r.recv0.toFixed(6)} ${r.sym0}` : ""}${r.recv0 > 0 && r.recv1 > 0 ? " + " : ""}${r.recv1 > 0 ? `${r.recv1.toFixed(6)} ${r.sym1}` : ""}`,
        r.feeEth > 0 ? `🧲 fee earned: <b>${r.feeEth.toFixed(6)}${NAT_TAG}</b>` : "",
        r.sweptEth && r.sweptEth > 0
          ? `💱 proceeds → <b>+${r.sweptEth.toFixed(6)}${NAT_TAG}</b> (auto-swap ke ${NAT_SYM})${r.sweepHash ? ` · <a href="${explorerTx(r.sweepHash)}">tx</a>` : ""}`
          : "",
        r.forfeited ? `⚠️ <b>${esc(r.forfeited)}</b> nggak bisa ditarik (honeypot/rug) — direlakan, ${NAT_SYM} diselamatkan.` : "",
        `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    // "is this a stable-quoted close?" — matched against the PROFILE's stable symbol, not a literal
    // "usdg", so an Arc close (TOKEN/USDC) is still rendered in dollars rather than as a native pair.
    const stableRe = new RegExp(`\\b${STABLE_SYM}\\b|usd`, "i");
    const nativeRe = new RegExp(`\\b${NAT_SYM}\\b|\\b${WRAP_SYM}\\b`, "i");
    const v4quote = stableRe.test(r.pair) && (NAT_IS_USD || !nativeRe.test(r.pair)) ? ("usd" as const) : ("eth" as const);
    await sendCloseCard({ name: r.pair, version: "v4", quote: v4quote, depEth: r.depEth, outEth: r.outEth, feeEth: r.feeEth, pnlEth: r.pnlEth, pnlPct: r.pnlPct });
  } catch (e) {
    await edit(mid, `❌ v4 close gagal: ${short(e, 160)}`);
  }
}

export async function onV4Collect(tokenId: string): Promise<void> {
  const m = await send(`⏳ Claim fee v4 #${tokenId}…`);
  const mid = m?.result?.message_id;
  try {
    const { collectV4Fees } = await import("../chain/v4/close.js");
    const r = await collectV4Fees(tokenId);
    const got = [r.fee0 > 0 ? `${r.fee0.toFixed(6)} ${r.sym0}` : "", r.fee1 > 0 ? `${r.fee1.toFixed(6)} ${r.sym1}` : ""].filter(Boolean).join(" + ");
    await edit(
      mid,
      [
        `✅ <b>Fee di-claim · v4 #${tokenId}</b>`,
        got ? `Dapet: ${got}` : `Nggak ada fee buat di-claim.`,
        `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ].join("\n"),
    );
  } catch (e) {
    await edit(mid, `❌ Claim fee gagal: ${short(e, 160)}`);
  }
}

export async function onV2Close(pair: string): Promise<void> {
  invalidateListCache();
  if (!/^0x[0-9a-fA-F]{40}$/.test(pair)) {
    await send("Format: <code>/v2close &lt;pairAddress&gt;</code>");
    return;
  }
  const m = await send(`⏳ Closing v2 ${pair.slice(0, 10)}…`);
  const mid = m?.result?.message_id;
  try {
    const { closeV2Position } = await import("../chain/v2/close.js");
    const r = await closeV2Position(pair);
    await edit(
      mid,
      [
        `✅ <b>v2 ${esc(r.sym)}/${WRAP_SYM} closed</b>`,
        `Balik: <b>${r.recvEth.toFixed(6)} ${NAT_SYM}</b>${r.soldToken ? " (token dijual balik)" : r.recvToken > 0 ? ` + ${r.recvToken.toPrecision(6)} ${esc(r.sym)}` : ""}`,
        r.pnlEth != null ? `PnL: ${r.pnlEth >= 0 ? "🟩 +" : "🟥 "}${r.pnlEth.toFixed(6)}${NAT_TAG}` : "",
        `burn: <a href="${explorerTx(r.txHash)}">tx</a>${r.swapHash ? ` · sell: <a href="${explorerTx(r.swapHash)}">tx</a>` : ""}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    await sendCloseCard({ name: `${r.sym}/${WRAP_SYM}`, version: "v2", depEth: r.depEth, outEth: r.recvEth, pnlEth: r.pnlEth });
  } catch (e) {
    await edit(mid, `❌ v2 close gagal: ${short(e, 160)}`);
  }
}

// ══════════ /auto (autonomous LP) ══════════

export async function onAuto(arg = ""): Promise<void> {
  const a = cfg.autoLp;
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const cmd = (parts[0] ?? "").toLowerCase();
  const { startManage, stopManage } = await import("../radar/automanage.js");

  if (cmd === "on") {
    a.enabled = true;
    persist();
    startManage();
    const armed = a.tpPct > 0 || a.slPct > 0 || a.closeOor;
    await send(
      [
        `🤖 <b>AUTO ON</b> ⚠️ (add + close, pakai dana real)`,
        `• <b>Auto-add</b>: buka posisi kalau kandidat lolos radar + gate (source ${a.sources.join("/")}, ${a.requireAction}≥${a.minScore}, ${a.sizeEth}${NAT_TAG} ${a.mode}).`,
        `• <b>Auto-close</b>: ${armed ? `TP ${a.tpPct > 0 ? "+" + a.tpPct + "%" : "off"} · SL ${a.slPct > 0 ? "-" + a.slPct + "%" : "off"} · OOR ${a.closeOor ? "on" : "off"} (cek tiap ${a.manageSec}s)` : "belum di-set — pakai <code>/auto tp 100</code> · <code>/auto sl 50</code> · <code>/auto oor on</code>"}`,
        ``,
        `Matiin: <code>/auto off</code>`,
      ].join("\n"),
    );
    return;
  }
  if (cmd === "off") {
    a.enabled = false;
    persist();
    stopManage();
    await send("🤖 <b>AUTO OFF</b>. Balik ke manual (notif + tombol). Threshold TP/SL/OOR tetep kesimpen.");
    return;
  }
  if (cmd === "tp" || cmd === "sl") {
    const v = parseFloat(parts[1] ?? "");
    if (!(v >= 0)) {
      await send(`Format: <code>/auto ${cmd} ${cmd === "tp" ? "100" : "50"}</code> (persen, 0 = off)`);
      return;
    }
    if (cmd === "tp") a.tpPct = v;
    else a.slPct = v;
    persist();
    await send(
      cmd === "tp"
        ? `🎯 Take-profit: ${v > 0 ? `posisi auto-close pas profit <b>≥ +${v}%</b>` : "OFF"}.${v > 0 && !a.enabled ? " (nyalain: /auto on)" : ""}`
        : `🛑 Stop-loss: ${v > 0 ? `posisi auto-close pas rugi <b>≤ -${v}%</b>` : "OFF"}.${v > 0 && !a.enabled ? " (nyalain: /auto on)" : ""}`,
    );
    return;
  }
  if (cmd === "oor") {
    a.closeOor = /^(on|1|true|yes)$/i.test(parts[1] ?? "");
    persist();
    await send(`🚪 Auto-close out-of-range: <b>${a.closeOor ? "ON" : "OFF"}</b>.${a.closeOor && !a.enabled ? " (nyalain: /auto on)" : ""}`);
    return;
  }

  const s = autoLpStatus();
  const armed = a.tpPct > 0 || a.slPct > 0 || a.closeOor;
  const T = [
    `${padR("status", 13)} ${a.enabled ? "🟢 ON" : "off"}`,
    `── auto-add ──`,
    `${padR("ukuran", 13)} ${a.sizeEth}${NAT_TAG} · ${a.mode}`,
    `${padR("trigger", 13)} ${a.requireAction} & skor ≥ ${a.minScore}`,
    `${padR("source", 13)} ${a.sources.join(", ")}`,
    // 0 = UNLIMITED (radar/autolp.ts capOff). Printing a bare "0 posisi · 0/jam" reads as "nothing
    // may open", which is the exact opposite — the Arc profile ships all three at 0 on purpose.
    `${padR("cap", 13)} ${capTxt(a.maxOpen, " posisi")} · ${capTxt(a.maxPerHour, "/jam")} · ${capTxt(a.dailyCapEth, NAT_TAG + "/hari")}`,
    `── auto-close ──`,
    `${padR("take-profit", 13)} ${a.tpPct > 0 ? "+" + a.tpPct + "%" : "off"}`,
    `${padR("stop-loss", 13)} ${a.slPct > 0 ? "-" + a.slPct + "%" : "off"}`,
    `${padR("close OOR", 13)} ${a.closeOor ? "on" : "off"}${a.closeOor && a.oorAction === "rebalance" ? " → ♻️ rebalance" : ""}`,
    `${padR("vol-fade", 13)} ${a.volFadeX > 0 ? `on (spike < ${a.volFadeX}× · age > ${a.vfadeMinAgeMin}m)` : "off"}`,
    `${padR("fee-velocity", 13)} ${a.minFeePerHourUsd > 0 ? `on (< $${a.minFeePerHourUsd}/h · age > ${a.feeGraceMin}m)` : "off"}`,
    `${padR("compound", 13)} ${a.compound ? `on (fee ≥ $${a.compoundMinUsd})` : "off"}`,
    `${padR("cek tiap", 13)} ${a.manageSec}s`,
    ``,
    `${padR("hari ini", 13)} ${s.opensToday} open · ${s.spentToday.toFixed(4)}${NAT_TAG}`,
  ];
  await send(
    `🤖 <b>Auto (add + close)</b>${pre(T.join("\n"))}` +
      `<code>/auto on</code> · <code>/auto off</code>\n` +
      `Close: <code>/auto tp 100</code> · <code>/auto sl 50</code> · <code>/auto oor on|off</code>\n` +
      `Mode: <code>/set alpmode single</code> (rug-safe) · <code>/set alpmode inrange</code> (fee langsung)\n` +
      `♻️ OOR→recenter: <code>/set alprebalance rebalance</code> · 🔁 compound fee: <code>/set alpcompound 1</code> · <code>/set alpcompoundmin 0.5</code>\n` +
      `Add: <code>/set alpsize 0.001</code> · <code>/set alpscore 75</code> · <code>/set alpmaxopen 3</code>\n` +
      `<i>⚠️ Tx otomatis pakai dana real. ${armed ? "Auto-close ARMED." : "Auto-close belum di-set."} Auto-add butuh radar (/set radar 1).` +
      // Two chain facts that change what "auto" MEANS here, so they belong on the auto screen:
      // (1) no GMGN → the honeypot/tax gates never ran, they did not pass; (2) the gas reserve is a
      //     floor the sizer always leaves behind, which on a stable-native chain is the LP capital too.
      `${CHAIN.data.gmgn ? "" : ` ${esc(CHAIN_NAME)} gak ada GMGN → gate honeypot/tax TIDAK dievaluasi (unknown, bukan 0).`}` +
      `${gasReserve() > 0 ? ` Cadangan gas ${gasReserve()} ${NAT_SYM} selalu ditahan (FLOOR, bukan cap).` : ""}</i>`,
  );
}

// ══════════ close ══════════

export async function onCloseAsk(tokenId: string, mid: number): Promise<void> {
  await edit(mid, `Close #${tokenId} — fee/token-nya mau diapain?\n<i>(LP principal tetap balik jadi ${NAT_SYM})</i>`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: `🔄 Swap token → ${NAT_SYM} (full ${NAT_SYM})`, callback_data: `cs:${tokenId}` }],
        [{ text: `🪙 Simpen token (${WRAP_SYM} + token)`, callback_data: `ck:${tokenId}` }],
      ],
    },
  });
}

export async function onClose(tokenId: string, mid: number, swapToken = true): Promise<void> {
  invalidateListCache();
  await edit(mid, `⏳ Closing #${tokenId}… ${swapToken ? `(swap token→${NAT_SYM})` : "(simpen token)"}`);
  try {
    const r = await closePosition(tokenId, { swapToken });
    const px = await nativeUsd().catch(() => 0);
    const pnl =
      r.pnlEth != null
        ? `\n💰 <b>PnL ${NAT_SYM}: ${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}${NAT_TAG}</b> (${r.pnlPct! >= 0 ? "+" : ""}${r.pnlPct!.toFixed(1)}%)\n💵 <b>PnL USD: ${r.pnlEth >= 0 ? "+" : ""}$${px ? (r.pnlEth * px).toFixed(2) : "?"}</b>`
        : `\nPnL: — (deposit tak tercatat)`;
    await send(
      [
        `✅ <b>Closed #${tokenId}</b>${px && !NAT_IS_USD ? ` · ${NAT_SYM} $${px.toFixed(0)}` : ""}`,
        r.heldMs != null ? `⏱ di-hold <b>${fmtAge(r.heldMs)}</b>` : "",
        `Tarik: ${r.recvWeth.toFixed(6)} ${r.wethSym}${r.recvToken > 0 ? ` + ${r.recvToken.toFixed(2)} ${r.tokenSym}` : ""}`,
        r.swappedWeth > 0
          ? `🔄 Swap ${r.tokenSym} → +${r.swappedWeth.toFixed(6)} ${esc(r.wethSym)}`
          : r.tokenStuck > 0
            ? swapToken
              ? `⚠️ ${r.tokenStuck.toFixed(2)} ${r.tokenSym} gagal dijual (rug) — nyangkut`
              : `🪙 ${r.tokenStuck.toFixed(2)} ${r.tokenSym} disimpen (senilai ~$${px ? ((r.valEth - r.recvWeth) * px).toFixed(2) : "?"})`
            : "",
        `Total balik: <b>${r.valEth.toFixed(6)}${NAT_TAG} / $${px ? (r.valEth * px).toFixed(2) : "?"}</b>${r.depEth != null ? ` (deposit ${r.depEth.toFixed(6)}${NAT_TAG})` : ""}${pnl}`,
        r.topUp ? `⛽ Top-up gas: unwrap ${r.topUp.unwrapped.toFixed(5)} ${WRAP_SYM} → ${NAT_SYM} native (${r.topUp.nativeAfter.toFixed(4)}${NAT_TAG})` : "",
        r.collectHash ? `tx: <a href="${explorerTx(r.collectHash)}">collect</a>${r.swapHash ? ` · <a href="${explorerTx(r.swapHash)}">swap</a>` : ""}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    // positions.ts sets wethSym = stableSym() on the stable-quoted close path, so compare against the
    // PROFILE's symbol. The old `=== "USDG"` literal made every Arc close render as a native pair.
    const isUsdgClose = r.wethSym === STABLE_SYM;
    await sendCloseCard({ name: `${r.tokenSym}/${isUsdgClose ? STABLE_SYM : WRAP_SYM}`, version: "v3", quote: isUsdgClose ? "usd" : "eth", depEth: r.depEth, outEth: r.valEth, pnlEth: r.pnlEth, pnlPct: r.pnlPct, heldMs: r.heldMs });
  } catch (e) {
    await send(`❌ Close gagal: ${short(e, 120)}`);
  }
}

export async function onCloseAll(): Promise<void> {
  invalidateListCache();
  let rows;
  try {
    rows = await listPositions();
  } catch (e) {
    await send(`❌ ${short(e, 80)}`);
    return;
  }
  if (!rows.length) {
    await send("Tidak ada posisi buat ditutup.");
    return;
  }
  const px = await nativeUsd().catch(() => 0);
  await send(`🗑🗑 <b>Menutup ${rows.length} posisi…</b> (satu per satu)`);
  let totPnl = 0, ok = 0, fail = 0;
  for (const row of rows) {
    try {
      const r = await closePosition(row.tokenId);
      if (r.pnlEth != null) totPnl += r.pnlEth;
      ok++;
      await send(
        `✅ #${row.tokenId} ${row.tokenSym} closed · PnL ${r.pnlEth != null ? `${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}${NAT_TAG}${px ? ` (${r.pnlEth >= 0 ? "+" : ""}$${(r.pnlEth * px).toFixed(2)})` : ""}` : "—"}`,
      );
    } catch (e) {
      fail++;
      await send(`❌ #${row.tokenId} gagal: ${short(e, 70)}`);
    }
  }
  await send(
    [
      `🏁 <b>Close ALL selesai</b> — ${ok} sukses${fail ? `, ${fail} gagal` : ""}`,
      `💰 Total PnL ${NAT_SYM}: <b>${totPnl >= 0 ? "+" : ""}${totPnl.toFixed(6)}${NAT_TAG}</b>`,
      px ? `💵 Total PnL USD: <b>${totPnl >= 0 ? "+" : ""}$${(totPnl * px).toFixed(2)}</b>` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (ok > 0) await onCard(); // flex the portfolio result
}

// ══════════ 🔄 swap (KyberSwap aggregator) ══════════

let pendingSwap: { fromAddr: string; toAddr: string; amountIn: bigint; fromSym: string; toSym: string; toDec: number } | null = null;
// DEX-style swap menu state (token picker → % amount)
let swapTokens: WalletToken[] = [];
let swapFrom: WalletToken | null = null;

/** Pretty token amount: thousands-separated when big, precise when small. */
const fmtAmt = (n: number): string =>
  n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n > 0 ? n.toPrecision(4) : "0";

/** /swap — no args → DEX-style token menu (auto-detect wallet holdings); with args → manual form. */
export async function onSwap(text: string): Promise<void> {
  const { kyberEnabled } = await import("../chain/kyber.js");
  if (!kyberEnabled()) {
    // Two DIFFERENT reasons, and conflating them sent people hunting for an .env var that would
    // never help: the aggregator either has no route API for this chain at all (profile
    // data.kyberChain === null → Arc), or it does and the router address just isn't configured.
    await send(
      CHAIN.data.kyberChain === null
        ? `🔄 <b>/swap manual belum ada di ${esc(CHAIN_NAME)}</b> — KyberSwap nggak punya route API di chain ini.\n` +
            `LP tetep jalan (router internal ${ROUTER_LABEL}); buat keluar dari token, tutup posisinya lewat /list.`
        : "🔄 Swap butuh KyberSwap — <code>KYBERSWAP_ROUTER_ADDRESS</code> belum diset di .env.",
    );
    return;
  }
  return text.trim().split(/\s+/).length >= 4 ? onSwapManual(text) : onSwapMenu();
}

/** Auto-detect sellable tokens in the wallet → tap one → tap a %, no CA/amount typing. */
async function onSwapMenu(): Promise<void> {
  const m = await send("🔄 <b>Scan token di wallet…</b> <i>(ngecek rute jual tiap token, bisa ~10-20s)</i>");
  const mid = m?.result?.message_id;
  swapFrom = null;
  const toks = await walletTokens().catch(() => [] as WalletToken[]);
  swapTokens = toks;
  if (!toks.length) {
    await edit(
      mid,
      [
        "🔄 <b>Swap</b>",
        "Nggak ada token (yang bisa dijual) kedetect di wallet.",
        "",
        `Beli / manual: <code>/swap &lt;jumlah&gt; &lt;dari&gt; &lt;ke&gt;</code> (dari/ke = <b>eth</b> = native ${NAT_SYM}, atau CA).`,
      ].join("\n"),
    );
    return;
  }
  const rows = toks.map((t) => [{ text: `${tokenEmoji(t.symbol)} ${t.symbol} · ${fmtAmt(t.ui)} ($${t.usd.toFixed(2)})`, callback_data: `swf:${t.addr}` }]);
  await edit(mid, [`🔄 <b>Swap → ${NAT_SYM}</b>`, `Pilih token yang mau dijual (${toks.length} kedetect):`].join("\n"), {
    reply_markup: { inline_keyboard: rows },
  });
}

/** Token picked (swf:<addr>) → show the 10-100% amount buttons (DEX-style). */
export async function onSwapFrom(addr: string, mid: number): Promise<void> {
  const t = swapTokens.find((x) => x.addr.toLowerCase() === addr.toLowerCase());
  if (!t) {
    await edit(mid, "Token nggak kebaca lagi — kirim /swap ulang.");
    return;
  }
  swapFrom = t;
  await edit(
    mid,
    [
      `🔄 <b>Jual ${tokenEmoji(t.symbol)} ${esc(t.symbol)} → ${NAT_SYM}</b>`,
      `Saldo: <b>${fmtAmt(t.ui)}</b> ($${t.usd.toFixed(2)}) · jual semua ≈ ${t.ethOut.toPrecision(4)} ${NAT_SYM}`,
      ``,
      `Mau jual berapa persen?`,
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "10%", callback_data: "swp:10" },
            { text: "25%", callback_data: "swp:25" },
            { text: "50%", callback_data: "swp:50" },
          ],
          [
            { text: "75%", callback_data: "swp:75" },
            { text: "💯 100%", callback_data: "swp:100" },
          ],
          [
            { text: "🔙 Token lain", callback_data: "swap" },
            { text: "❌ Cancel", callback_data: "cancel" },
          ],
        ],
      },
    },
  );
}

/** Percentage picked (swp:<pct>) → quote via Kyber, show the ✅ Swap confirm. */
export async function onSwapPct(pct: number, mid: number): Promise<void> {
  if (!swapFrom) {
    await edit(mid, "Pilih token dulu — kirim /swap ulang.");
    return;
  }
  const t = swapFrom;
  // read the LIVE balance (wallet is shared with the arb bot + Blockscout can lag) so 100% never
  // tries to sell more than we actually hold, and the % is always of the real current balance.
  const liveRaw = await tokenBalanceRaw(t.addr).catch(() => t.raw);
  const bal = liveRaw > 0n ? liveRaw : t.raw;
  const amountIn = pct >= 100 ? bal : (bal * BigInt(pct)) / 100n;
  if (amountIn <= 0n) {
    await edit(mid, "Saldo token 0 sekarang — mungkin udah kejual / kepake. Kirim /swap ulang.");
    return;
  }
  const { kyberRoute, routeBreakdown, KYBER_NATIVE } = await import("../chain/kyber.js");
  await edit(mid, `🔄 Cari rute ${pct}% ${esc(t.symbol)} → ${NAT_SYM}…`);
  const route = await kyberRoute(t.addr, KYBER_NATIVE, amountIn).catch(() => null);
  if (!route) {
    await edit(mid, `❌ ${ROUTER_LABEL} nggak nemu rute (likuiditas kering?).`);
    return;
  }
  // fmtNat(): the route's output is NATIVE wei, whose width comes from the profile.
  const outUi = Number(fmtNat(BigInt(route.routeSummary.amountOut)));
  const px = await nativeUsd().catch(() => 0);
  const amtUi = Number(ethers.formatUnits(amountIn, t.decimals));
  pendingSwap = { fromAddr: t.addr, toAddr: KYBER_NATIVE, amountIn, fromSym: t.symbol, toSym: NAT_SYM, toDec: CHAIN.native.decimals };
  await edit(
    mid,
    [
      `🔄 <b>Jual ${pct}% ${esc(t.symbol)}</b> = ${fmtAmt(amtUi)} ${esc(t.symbol)}`,
      `→ ~<b>${outUi.toPrecision(6)} ${NAT_SYM}</b>${px ? ` <i>($${(outUi * px).toFixed(2)})</i>` : ""}`,
      `rute: <i>${esc(routeBreakdown(route.routeSummary) || "kyber")}</i> · slippage ${cfg.lp.slippagePct}%`,
    ].join("\n"),
    { reply_markup: { inline_keyboard: [[{ text: "✅ Swap", callback_data: "swapdo" }, { text: "❌ Cancel", callback_data: "cancel" }]] } },
  );
}

/** Manual power-user form: /swap <amount> <from> <to>  (eth or 0x… contract, any direction). */
async function onSwapManual(text: string): Promise<void> {
  const { kyberRoute, routeBreakdown, KYBER_NATIVE } = await import("../chain/kyber.js");
  const parts = text.trim().split(/\s+/);
  const [, amtStr, fromS, toS] = parts as [string, string, string, string];
  // "eth" is kept as the NATIVE alias on every chain (muscle memory + old messages); the native
  // symbol is accepted too, so "/swap 1 usdc <ca>" works on Arc.
  const nativeAlias = new RegExp(`^(eth|${NAT_SYM})$`, "i");
  const resolve = (s: string) => (nativeAlias.test(s) ? KYBER_NATIVE : /^0x[0-9a-fA-F]{40}$/.test(s) ? ethers.getAddress(s) : null);
  const fromAddr = resolve(fromS);
  const toAddr = resolve(toS);
  if (!fromAddr || !toAddr) {
    await send(`Dari/ke harus <b>${NAT_SYM.toLowerCase()}</b> (native) atau alamat kontrak (0x… 40 hex).`);
    return;
  }
  if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
    await send("Dari & ke sama — nggak ada yang di-swap.");
    return;
  }
  if (!(parseFloat(amtStr) > 0)) {
    await send("Jumlah nggak valid, contoh: <code>0.01</code>");
    return;
  }
  const nativeIn = fromAddr.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const nativeOut = toAddr.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const natMeta = { decimals: CHAIN.native.decimals, symbol: NAT_SYM };
  const fromMeta = nativeIn ? natMeta : await tokenMeta(fromAddr).catch(() => ({ decimals: 18, symbol: "?" }));
  const toMeta = nativeOut ? natMeta : await tokenMeta(toAddr).catch(() => ({ decimals: 18, symbol: "?" }));
  let amountIn: bigint;
  try {
    amountIn = ethers.parseUnits(amtStr, fromMeta.decimals);
  } catch {
    await send("Format jumlah salah.");
    return;
  }

  const m = await send(`🔄 Cari rute ${ROUTER_LABEL}…`);
  const mid = m?.result?.message_id;
  const route = await kyberRoute(fromAddr, toAddr, amountIn).catch(() => null);
  if (!route) {
    await edit(mid, `❌ ${ROUTER_LABEL} nggak nemu rute buat pair ini (likuiditas kering?).`);
    return;
  }
  const outRaw = BigInt(route.routeSummary.amountOut);
  const outUi = Number(ethers.formatUnits(outRaw, toMeta.decimals));
  const usd = route.routeSummary.amountOutUsd ? ` <i>($${Number(route.routeSummary.amountOutUsd).toFixed(2)})</i>` : "";
  pendingSwap = { fromAddr, toAddr, amountIn, fromSym: fromMeta.symbol, toSym: toMeta.symbol, toDec: toMeta.decimals };
  await edit(
    mid,
    [
      `🔄 <b>Swap ${esc(amtStr)} ${esc(fromMeta.symbol)} → ~${outUi.toPrecision(6)} ${esc(toMeta.symbol)}</b>${usd}`,
      `rute: <i>${esc(routeBreakdown(route.routeSummary) || "kyber")}</i> · slippage ${cfg.lp.slippagePct}%`,
    ].join("\n"),
    { reply_markup: { inline_keyboard: [[{ text: "✅ Swap", callback_data: "swapdo" }, { text: "❌ Cancel", callback_data: "cancel" }]] } },
  );
}

export async function onSwapDo(mid: number): Promise<void> {
  if (!pendingSwap) return;
  const s = pendingSwap;
  pendingSwap = null;
  await edit(mid, `⏳ Swap ${esc(s.fromSym)} → ${esc(s.toSym)}…`);
  try {
    const { kyberSwap } = await import("../chain/kyber.js");
    const r = await kyberSwap(s.fromAddr, s.toAddr, s.amountIn);
    if (!r || r.amountOut <= 0n) {
      await edit(mid, "❌ Swap gagal / output 0.");
      return;
    }
    await edit(
      mid,
      `✅ <b>Swap sukses</b> → +${Number(ethers.formatUnits(r.amountOut, s.toDec)).toPrecision(6)} ${esc(s.toSym)}\ntx: <a href="${explorerTx(r.tx)}">tx</a>`,
    );
  } catch (e) {
    await edit(mid, `❌ Swap gagal: ${short(e, 150)}`);
  }
}

// ══════════ 🎯 candidate hunter ══════════

/** /hunt [on|off|now] — the quality-candidate scanner (fee 3-5% + rame + lolos screening). */
export async function onHunt(arg?: string): Promise<void> {
  const { startScan, stopScan, scanStatus, scanNow } = await import("../radar/scanLoop.js");
  const a = (arg ?? "").toLowerCase();
  if (a === "on") {
    cfg.scan.enabled = true;
    persist();
    startScan();
    await send(`🎯 <b>Hunter ON</b> · ${esc(CHAIN_NAME)} — scan kandidat LP tiap ${cfg.scan.intervalMin} menit (fee 3-5% + tx rame + lolos screening).`);
    return;
  }
  if (a === "off") {
    cfg.scan.enabled = false;
    persist();
    stopScan();
    await send("🎯 <b>Hunter OFF.</b>");
    return;
  }
  if (a === "now") {
    const { scanSources } = await import("../radar/scanLoop.js");
    const m = await send(`🎯 Scan kandidat sekarang… <i>(source: ${esc(scanSources().join(" + "))}, bisa ~15-30s)</i>`);
    const mid = m?.result?.message_id;
    try {
      const r = await scanNow();
      await edit(mid, `🎯 Scan kelar — <b>${r.scanned}</b> kandidat mentah → <b>${r.found} lolos</b> (fee 3-5% + rame + screening).${r.found ? " Alert dikirim ↑" : " Gak ada yang lolos sekarang."}`);
    } catch (e) {
      await edit(mid, `❌ Scan gagal: ${short(e, 100)}`);
    }
    return;
  }
  const st = scanStatus();
  const { scanSources } = await import("../radar/scanLoop.js");
  const { gmgnSupported } = await import("../radar/gmgn.js");
  await send(
    [
      `🎯 <b>Hunter kandidat LP</b> · ${esc(CHAIN_NAME)} — ${st.on ? "🟢 ON" : "🔴 OFF"}`,
      `Source: <b>${esc(scanSources().join(" + "))}</b>`,
      // spread, not "" — the `` below is a deliberate blank line (see onHelp)
      ...(gmgnSupported() ? [] : [`<i>⚠️ Tanpa GMGN di chain ini: gate honeypot/tax/holder TIDAK dievaluasi (unknown, bukan aman).</i>`]),
      `Kriteria: pool <b>v4 fee ${(st.feeMinPpm / 10000).toFixed(0)}-${(st.feeMaxPpm / 10000).toFixed(0)}%</b> · vol ≥ $${(st.minVolUsd / 1000).toFixed(0)}k · skor ≥ ${st.minScore}`,
      `Interval ${st.intervalMin} menit · cooldown ${st.cooldownMin} menit`,
      st.scans > 0
        ? `Scan terakhir: ${st.lastScanned} trending → <b>${st.lastFound}</b> kandidat · total ${st.alerts} alert`
        : `Belum ada scan.`,
      ``,
      `<code>/hunt on</code> · <code>/hunt off</code> · <code>/hunt now</code>`,
    ].join("\n"),
  );
}

// ══════════ 📸 profit card ══════════

/** Generate + send the whole-portfolio profit card (Meteora-style flex graphic). */
export async function onCard(): Promise<void> {
  const m = await send("📸 Bikin kartu profit…");
  const mid = m?.result?.message_id;
  try {
    const { renderCard, portfolioCardData } = await import("./card.js");
    const png = await renderCard(await portfolioCardData());
    await sendPhoto(png, `📊 <b>Profit LP Bot · ${esc(CHAIN_NAME)}</b> — share it 🚀`);
    if (mid) await edit(mid, "📸 Kartu profit ↑");
  } catch (e) {
    if (mid) await edit(mid, `❌ Gagal bikin kartu: ${short(e, 100)}`);
  }
}

/** Save a photo the owner sent as the profit-card background (assets/card-bg.jpg). */
export async function onSetBg(fileId: string): Promise<void> {
  const m = await send("🖼 Nyimpen background kartu…");
  const mid = m?.result?.message_id;
  try {
    const buf = await downloadTgFile(fileId);
    if (!buf) {
      if (mid) await edit(mid, "❌ Gagal ambil gambar dari Telegram.");
      return;
    }
    mkdirSync("assets", { recursive: true });
    writeFileSync("assets/card-bg.jpg", buf);
    if (mid) await edit(mid, "✅ Background kartu di-set. Ini preview-nya 👇");
    const { renderCard, portfolioCardData } = await import("./card.js");
    const png = await renderCard(await portfolioCardData());
    await sendPhoto(png, "🎴 Background baru kepasang — <b>/card</b> kapan aja buat share.");
  } catch (e) {
    if (mid) await edit(mid, `❌ Gagal set background: ${short(e, 100)}`);
  }
}

/** Print a profit card for an ALREADY-closed position (from a ledger entry, by tokenId). */
export async function onCardFor(tokenId: string): Promise<void> {
  const e = readLedger().find((x) => x.tokenId === tokenId);
  if (!e) {
    await send("❌ Posisi nggak ketemu di ledger.");
    return;
  }
  const m = await send("📸 Bikin kartu posisi…");
  const mid = m?.result?.message_id;
  try {
    const { renderCard, closeCardData } = await import("./card.js");
    const png = await renderCard(
      await closeCardData({
        name: e.pair ?? `${e.sym}/${WRAP_SYM}`,
        version: (e.version ?? "v3") as "v2" | "v3" | "v4",
        quote: e.quote,
        depEth: e.depEth ?? null,
        outEth: e.outEth ?? 0,
        pnlEth: e.pnlEth,
        pnlPct: e.pnlPct,
        feeEth: e.feeEth,
        heldMs: e.heldMs,
        ethUsd: e.ethUsdAtClose ?? undefined,
      }),
    );
    await sendPhoto(png, `🎴 <b>${esc(e.pair ?? `${e.sym}/${WRAP_SYM}`)}</b> — share it 🚀`);
    if (mid) await edit(mid, "📸 Kartu ↑");
  } catch (err) {
    if (mid) await edit(mid, `❌ Gagal bikin kartu: ${short(err, 100)}`);
  }
}

/** Fire-and-forget a per-close card (never blocks / breaks the close flow). */
async function sendCloseCard(p: {
  name: string;
  version: "v2" | "v3" | "v4";
  quote?: "eth" | "usd";
  depEth: number | null;
  outEth: number;
  pnlEth: number | null;
  pnlPct?: number | null;
  feeEth?: number;
  heldMs?: number | null;
}): Promise<void> {
  try {
    const { renderCard, closeCardData } = await import("./card.js");
    const png = await renderCard(await closeCardData(p));
    await sendPhoto(png);
  } catch {
    /* card is a nice-to-have — never let it break a close */
  }
}

export async function onBriefing(): Promise<void> {
  await send("📋 Nyusun briefing harian… (analisa LLM bisa ~1 menit)");
  const { runBriefing } = await import("./briefing.js");
  await runBriefing("manual");
}

export async function onPnl(): Promise<void> {
  await send("📊 Menghitung PnL seumur hidup… (scan history + rug, ±20 detik)");
  let r;
  try {
    // overall safety-net timeout so /pnl can't hang forever if Blockscout/RPC is slow (the per-token
    // quote timeout in analytics.ts handles the usual culprit; this bounds the total scan).
    r = await Promise.race([
      lifetimePnl(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("scan &gt; 45s — Blockscout/RPC lambat, coba lagi")), 45_000)),
    ]);
  } catch (e) {
    await send(`❌ ${short(e, 90)}`);
    return;
  }
  const px = r.px;
  const $ = (e: number) => (px ? "$" + (e * px).toFixed(2) : "?");
  // ACCURATE LP number from the ledger (closed positions). The wallet capital-flow below is
  // wallet-level and — because this wallet is shared with the arb bot — mixes in non-LP flows.
  const sum = ledgerSummary();
  const row = (lbl: string, eth: string, usd = "") => `${padR(lbl, 8)}${padL(eth, 12)}${usd ? "  " + padL(usd, 9) : ""}`;

  const T: string[] = [];
  T.push(`LP REALIZED · ${sum.count} ditutup`);
  T.push("─".repeat(31));
  T.push(row("PnL", sg(sum.pnlEth, 5) + NAT_TAG, money(sum.pnlUsd)));
  T.push(row("menang", `${sum.winRate.toFixed(0)}% (${sum.wins}/${sum.losses})`));
  T.push(row("fee", sum.feeEth.toFixed(5) + NAT_TAG));
  T.push("");
  T.push(`ARUS WALLET (+arb)${r.partial ? " · window" : ""}`);
  T.push("─".repeat(31));
  // capKnown=false means this chain CANNOT reconstruct capital flow (no indexer → native transfers
  // emit no log). Printing 0.00000 there invents a figure; "n/a" says we don't know. valueNow is
  // measured on-chain and stays accurate either way.
  const cap = (v: number) => (r.capKnown ? v.toFixed(5) + NAT_TAG : "n/a");
  const capUsd = (v: number) => (r.capKnown ? $(v) : "");
  T.push(row("setor", cap(r.capIn), capUsd(r.capIn)));
  T.push(row("tarik", cap(r.capOut), capUsd(r.capOut)));
  T.push(row("nilai", r.valueNowEth.toFixed(5) + NAT_TAG, $(r.valueNowEth)));
  T.push(`  native ${r.nativeEth.toFixed(4)}${hasWrapped() ? `  ${WRAP_SYM} ${r.wethHeld.toFixed(4)}` : ""}`);
  T.push(`  LP ${r.openLpEth.toFixed(4)}${NAT_TAG}  token $${r.tokensUsd.toFixed(2)}`);
  T.push(row("net", r.capKnown ? sg(r.pnlEth, 5) + NAT_TAG : "n/a", r.capKnown ? money(r.pnlUsd) : ""));

  const grave = r.graveyardCount
    ? `\n🪦 <b>${r.graveyardCount} token nyangkut</b> <i>(rug/likuiditas kering)</i>\n${pre(r.graveyard.join(", ") + (r.graveyardCount > r.graveyard.length ? " …" : ""))}`
    : "";
  await sendMenu(
    `📊 <b>PnL SEUMUR HIDUP</b> · ${esc(CHAIN_NAME)}${px && !NAT_IS_USD ? ` · ${NAT_SYM} $${px.toFixed(0)}` : ""}\n` +
      pre(T.join("\n")) +
      `<i>⚠️ Net wallet nyampur flow arb — angka LP akurat = "LP realized".</i>` +
      (r.capKnown
        ? ""
        : `\n<i>ℹ️ ${esc(CHAIN_NAME)} belum punya indexer buat arus wallet (setor/tarik/net = n/a). Nilai sekarang &amp; "LP realized" tetep akurat.</i>`) +
      (r.partial ? `\n<i>ℹ️ Histori dibatesin window scan (RH_INDEX_HOURS), bukan seumur hidup beneran.</i>` : "") +
      grave,
  );
}

export async function onSell(): Promise<void> {
  // The proceeds currency is the chain's DEFAULT QUOTE (WETH here, the USDC ERC-20 on Arc), which
  // is what sellAllTokens now reports back as `quoteSym`. The opener said "→ ETH" while the total
  // underneath said "WETH" — one flow, two currencies, neither of them wrong enough to notice.
  await send(`🔄 <b>Menjual semua token nyangkut → ${WRAP_SYM}…</b>\n(skip yang rug/pool kering)`);
  try {
    const r = await sellAllTokens((msg) => {
      void send(msg).catch(() => {});
    });
    await sendMenu(
      [
        `🏁 <b>Selesai jual</b> — ${r.sold} token → ${esc(r.quoteSym)}${r.skipped ? `, ${r.skipped} di-skip (rug)` : ""}`,
        `💰 Total dapet: <b>+${r.soldEth.toFixed(6)} ${esc(r.quoteSym)} ($${r.soldUsd.toFixed(2)})</b>`,
      ].join("\n"),
    );
  } catch (e) {
    await send(`❌ ${short(e, 90)}`);
  }
}

export async function onWallet(): Promise<void> {
  try {
    const b = await balances();
    // The chain line is first: this is the screen people screenshot, and an address alone does not
    // say which chain's balance it is. The gas-reserve note only matters where the native currency
    // is ALSO the LP capital (Arc) — there, spending it all means a position you can't close.
    await sendMenu(
      [
        `👛 <b>${esc(CHAIN_NAME)}</b>  <code>${b.address}</code>`,
        `${NAT_SYM}: ${Number(b.eth).toFixed(5)}${hasWrapped() ? ` · ${WRAP_SYM}: ${Number(b.weth).toFixed(5)}` : ""}`,
        `bisa di-LP: <b>${usableEth(b).toFixed(5)} ${NAT_SYM}</b> <i>(cadangan gas ${gasReserve()} ditahan)</i>`,
        hasWrapped()
          ? ""
          : `<i>⚠️ Di ${esc(CHAIN_NAME)} gas &amp; modal LP itu saldo yang SAMA — cadangan gas di atas yang bikin posisi tetep bisa ditutup.</i>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ ${short(e, 80)}`);
  }
}

export async function onSettings(): Promise<void> {
  const T = [
    `${padR("width", 12)} ${cfg.lp.widthPct}%`,
    `${padR("slippage", 12)} ${cfg.lp.slippagePct}%`,
    `${padR("fee floor LP", 12)} ${(cfg.lp.minFeePpm / 10000).toFixed(2)}%`,
    `${padR("gas target", 12)} ${cfg.lp.nativeTargetEth}${NAT_TAG}`,
    `${padR("cadangan gas", 12)} ${gasReserve()}${NAT_TAG} ${hasWrapped() ? "" : "(= modal LP juga!)"}`,
    `${padR("auto-wrap", 12)} ${cfg.lp.autoWrap ? "on" : "off"}`,
    ``,
    `${padR("radar LLM", 12)} ${cfg.radar.enabled ? "on" : "off"}`,
    `${padR("feed", 12)} ${cfg.feed.enabled ? "on" : "off"}`,
    `${padR("auto-LP", 12)} ${cfg.autoLp.enabled ? "🟢 ON" : "off"}`,
    `${padR("fast-submit", 12)} ${env.fastSubmit ? "on" : "off"}`,
  ];
  await sendMenu(
    `⚙️ <b>Setting</b> · ${esc(CHAIN_NAME)}${pre(T.join("\n"))}` +
      `Ubah: <code>/set width 40</code> · <code>/set slippage 5</code> · <code>/set gastarget 0.015</code>\n` +
      `<i>Watch/Feed/Auto/Radar diatur di menu masing-masing. Cadangan gas dari chains/${CHAIN.key}.json (native.gasReserve), bukan /set.</i>`,
  );
}

const LP_MAP: Record<string, keyof typeof cfg.lp> = {
  width: "widthPct",
  deposit: "depositUsd",
  slippage: "slippagePct",
  gastarget: "nativeTargetEth",
};
const WATCH_MAP: Record<string, keyof typeof cfg.watch> = {
  vol5m: "minVol5m",
  vol1h: "minVol1h",
  rise: "riseFactor",
  liq: "minLiqUsd",
  tax: "maxTaxPct",
  cooldown: "cooldownMin",
  interval: "intervalSec",
};
const FEED_NUM_MAP: Record<string, keyof typeof cfg.feed> = {
  minseed: "newTokenMinWethSeed",
  activity: "activityThreshold",
  feedcooldown: "cooldownMin",
};
const FEED_BOOL_MAP: Record<string, keyof typeof cfg.feed> = {
  newtoken: "newToken",
  posmon: "positionMonitor",
  autoclose: "autoCloseOutOfRange",
};
const RADAR_BOOL_MAP: Record<string, keyof typeof cfg.radar> = {
  radar: "enabled",
  gmgn: "useGmgn",
};
const AUTOLP_NUM_MAP: Record<string, keyof typeof cfg.autoLp> = {
  alpsize: "sizeEth",
  alpscore: "minScore",
  alpmaxopen: "maxOpen",
  alpperhour: "maxPerHour",
  alpdaily: "dailyCapEth",
  alpminliq: "minLiqUsd",
  alpmaxtax: "maxTaxPct",
  alpgrace: "oorGraceMin",
  alpoorcount: "oorCooldownCount",
  alpoorhours: "oorCooldownHours",
  alpcompoundmin: "compoundMinUsd", // min uncollected fees ($) before compounding
  alpvolfade: "volFadeX", // #3 volume-fade exit: close when spikeX < this (0 = off). MUST be < scan.minSpikeX
  alpvfadeage: "vfadeMinAgeMin", // #3 volume-fade age guard (min): no VFADE close before a position is this old
  alpminfeeh: "minFeePerHourUsd", // fee-velocity exit: close when recent fee-rate < this $/h (0 = off)
  alpfeegrace: "feeGraceMin", // fee-velocity age guard (min): no fee-velocity close before this old
};
const SCAN_NUM_MAP: Record<string, keyof typeof cfg.scan> = {
  huntvol: "minVolUsd",
  huntfees: "minPoolFeesUsd", // #1 fee-yield: min 24h pool fees
  huntyield: "minFeeYieldPct", // #1 fee-yield: min daily fee/TVL %
  huntscore: "minScore",
  huntmcapmin: "screenMinMcap", // mcap floor
  huntmcapmax: "screenMaxMcap", // mcap ceiling (0 = off) — farm SMALL-cap
  huntpoolliq: "minPoolLiqUsd", // anti-wash: pool liquidity floor ($)
  huntmaxratio: "maxVolLiqRatio", // anti-wash: max vol/liq ratio (0 = off)
  huntspike: "minSpikeX", // #1 volume-spike: min recent-hour vs 24h-avg (0 = off)
  huntcooldown: "cooldownMin", // menit sebelum token yg udah di-alert boleh muncul lagi (rotasi cepet = kecil)
};
const SET_HELP =
  "LP: width, deposit, slippage, gastarget\nWatch: vol5m, vol1h, rise, liq, tax, cooldown, interval\nFeed: minseed, activity, feedcooldown · toggle: newtoken/posmon/autoclose (0/1)\nRadar: radar/gmgn (0/1)\nHunt: huntvol, huntfees, huntyield, huntscore, huntmcapmin, huntmcapmax, huntpoolliq, huntmaxratio, huntspike, huntcooldown\nAuto-LP: alpsize, alpscore, alpmaxopen, alpperhour, alpdaily, alpminliq, alpmaxtax, alpgrace, alpoorcount, alpoorhours, alpcompoundmin, alpvolfade, alpvfadeage, alpminfeeh, alpfeegrace · alpmode single|inrange · alpclose 0/1 · alprebalance close|rebalance · alpcompound 0/1";

export async function onSet(text: string): Promise<void> {
  const [, k, v] = text.split(/\s+/);
  // ── enum / string auto-LP settings (handled BEFORE the numeric guard below) ──
  if (k === "alpmode") {
    if (v !== "single" && v !== "inrange") {
      await send("Pilih: <code>/set alpmode single</code> (rug-safe, parkir quote) atau <code>/set alpmode inrange</code> (both-sided, fee langsung).");
      return;
    }
    cfg.autoLp.mode = v;
    persist();
    await send(
      `✓ autoLp.mode → <b>${v}</b> ${v === "inrange" ? "(both-sided — fee LANGSUNG, tapi pegang token → rug=rugi)" : "(single-side — parkir quote asset, rug-safe)"}`,
    );
    return;
  }
  if (k === "alpclose") {
    if (v !== "0" && v !== "1") {
      await send("Toggle: <code>/set alpclose 1</code> (tutup OOR) / <code>/set alpclose 0</code> (biarin jalan)");
      return;
    }
    cfg.autoLp.closeOor = v === "1";
    persist();
    await send(`✓ autoLp.closeOor → ${v === "1" ? "on (tutup posisi OOR)" : "off (posisi dibiarin jalan)"}`);
    return;
  }
  if (k === "alprebalance" || k === "alprebal") {
    if (v !== "close" && v !== "rebalance") {
      await send(
        `Pilih: <code>/set alprebalance rebalance</code> (posisi OOR di-recenter ke harga baru) atau <code>/set alprebalance close</code> (default — tutup ke ${NAT_SYM}).\n<i>butuh /set alpclose 1</i>`,
      );
      return;
    }
    cfg.autoLp.oorAction = v;
    persist();
    await send(
      `✓ autoLp.oorAction → <b>${v}</b> ${v === "rebalance" ? "(OOR → tutup + buka ulang recentered, modal terus kerja)" : `(OOR ditutup ke ${NAT_SYM})`}${v === "rebalance" && !cfg.autoLp.closeOor ? "\n⚠️ nyalain dulu: <code>/set alpclose 1</code>" : ""}`,
    );
    return;
  }
  if (k === "alpcompound") {
    if (v !== "0" && v !== "1") {
      await send("Toggle: <code>/set alpcompound 1</code> (fee di-compound balik) / <code>/set alpcompound 0</code> (off)");
      return;
    }
    cfg.autoLp.compound = v === "1";
    persist();
    await send(`✓ autoLp.compound → ${v === "1" ? `on (fee ≥ $${cfg.autoLp.compoundMinUsd} di-harvest & di-add balik)` : "off"}`);
    return;
  }
  if (!k || v == null || isNaN(Number(v))) {
    await send(`Format: <code>/set &lt;key&gt; &lt;angka&gt;</code>\n${SET_HELP}`);
    return;
  }
  if (LP_MAP[k]) {
    (cfg.lp[LP_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ ${k} → ${v}`);
    return;
  }
  if (WATCH_MAP[k]) {
    (cfg.watch[WATCH_MAP[k]] as number) = Number(v);
    persist();
    if (k === "interval") restartWatch();
    await send(`✓ watch.${k} → ${v}`);
    return;
  }
  if (FEED_NUM_MAP[k]) {
    (cfg.feed[FEED_NUM_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ feed.${k} → ${v}`);
    return;
  }
  if (FEED_BOOL_MAP[k]) {
    (cfg.feed[FEED_BOOL_MAP[k]] as boolean) = Number(v) !== 0;
    persist();
    await send(`✓ feed.${k} → ${Number(v) !== 0 ? "on" : "off"}${k === "autoclose" && Number(v) !== 0 ? " ⚠️" : ""}`);
    return;
  }
  if (RADAR_BOOL_MAP[k]) {
    (cfg.radar[RADAR_BOOL_MAP[k]] as boolean) = Number(v) !== 0;
    persist();
    const warn = k === "radar" && Number(v) !== 0 && !env.openrouterKey ? " ⚠️ RH_OPENROUTER_KEY belum diset" : "";
    await send(`✓ radar.${k} → ${Number(v) !== 0 ? "on" : "off"}${warn}`);
    return;
  }
  if (AUTOLP_NUM_MAP[k]) {
    (cfg.autoLp[AUTOLP_NUM_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ autoLp.${k} → ${v}`);
    return;
  }
  if (SCAN_NUM_MAP[k]) {
    (cfg.scan[SCAN_NUM_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ hunt.${k} → ${v}`);
    return;
  }
  await send(`Key nggak dikenal.\n${SET_HELP}`);
}

export async function onHelp(): Promise<void> {
  const body = [
    // The chain is in the FIRST line of /start: the operator runs two of these in two chats and
    // this is the message that tells them which one they just tapped.
    `🤖 <b>LP Bot · ${esc(CHAIN_NAME)}</b>  <i>v2 · Uniswap v2+v3+v4 · native ${NAT_SYM}</i>`,
    `Paste <b>CA token</b> (0x…) → pilih pool (v2/v3/v4) → jumlah ${NAT_SYM} → LP.`,
    // Conditional SPREAD, not a "" + filter(Boolean): the `` entries below are deliberate
    // blank-line separators, and filtering falsy values would collapse the whole help screen.
    ...(hasWrapped()
      ? []
      : [`<i>⚠️ Di sini gas &amp; modal LP itu saldo ${NAT_SYM} yang SAMA — bot selalu nahan ${gasReserve()} ${NAT_SYM} biar posisi tetep bisa ditutup.</i>`]),
    ``,
    `<b>━━━ 📊 POSISI ━━━</b>`,
    `📋 /list — posisi terbuka + PnL + close`,
    `📒 /ledger — riwayat ditutup (realized)`,
    `💰 /pnl — PnL seumur hidup`,
    `📸 /card — kartu profit shareable`,
    ``,
    `<b>━━━ 🎯 RADAR & AUTO ━━━</b>`,
    `🧪 /screen — screening GMGN 24h (mcap&gt;500k, vol&gt;1M, no flap, util&gt;meme)`,
    sequencerEnabled() ? `📡 /feed — monitor sequencer real-time` : `📡 /feed — <i>n/a (${esc(CHAIN_NAME)} tanpa sequencer)</i>`,
    `👁 /watch — scanner volume nanjak`,
    `🔍 /scan — cek volume sekarang`,
    `🤖 /auto — auto-LP (radar → buka sendiri)`,
    `🦄 /v4 <code>&lt;ca&gt;</code> — cek pool v4 fee-tinggi`,
    ``,
    `<b>━━━ ⚡ AKSI ━━━</b>`,
    `🔄 /swap <code>&lt;jml&gt; &lt;dari&gt; &lt;ke&gt;</code> — swap via ${ROUTER_LABEL}`,
    `🗑 /closeall · 💸 /sell · 👛 /wallet`,
    `⚙️ /settings · /set <code>&lt;k&gt; &lt;v&gt;</code>`,
    ``,
    `<i>Menu cepat ada di bawah 👇 — nggak perlu ngetik.</i>`,
  ].join("\n");
  await sendMenu(body);
}

// per-message pending accessors for bot.ts routing
// ══════════ ➕ Add — increase an EXISTING position (not a new NFT) ══════════

export async function onAddAsk(tokenId: string, version: "v3" | "v4"): Promise<void> {
  pending = null; // drop any open-flow so a stray number doesn't mis-route
  pendingAdd = { tokenId, version };
  await send(
    `➕ <b>Tambah liq ke posisi #${tokenId}</b> [${version}]\n` +
      `Ketik jumlah <b>${NAT_SYM}</b> yang mau ditambahin (contoh: <code>0.005</code>). Bot auto split ½ token + ½ ${STABLE_SYM} → masuk ke posisi itu (bukan buka baru).`,
  );
}

export async function onAddAmount(text: string): Promise<void> {
  if (!pendingAdd) return;
  const eth = parseFloat(text);
  if (!(eth > 0)) {
    await send(`Masukin angka ${NAT_SYM} yang bener, contoh: 0.005`);
    return;
  }
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(`⚠️ Kegedean. Yang bisa di-LP cuma ${usableEth(b).toFixed(5)} ${NAT_SYM}.`);
    return;
  }
  if (b && Number(b.eth) < gasReserve()) {
    await send(`⚠️ ${NAT_SYM} native cuma ${Number(b.eth).toFixed(5)} — kurang buat gas (min ${gasReserve()}).`);
    return;
  }
  const { tokenId, version } = pendingAdd;
  pendingAdd = null;
  const amt = toEthStr(eth) ?? String(eth);
  invalidateListCache();
  const m = await send(`⏳ <b>Nambah ${amt} ${NAT_SYM} ke posisi #${tokenId}…</b> (swap ½+½ → increase)`);
  const mid = m?.result?.message_id;
  try {
    if (version === "v4") {
      const { increaseV4Position } = await import("../chain/v4/mint.js");
      const r = await increaseV4Position(tokenId, amt);
      await edit(
        mid,
        [
          `✅ <b>Liq masuk ke #${tokenId}</b> [v4] · pool fee ${(r.fee / 10000).toFixed(2)}%`,
          r.swapHash ? `swap ½+½: <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
          `deposit <b>+${amt}${NAT_TAG}</b> (masuk ke posisi lama, bukan #baru)`,
          `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } else {
      await edit(mid, "increase v3 belum didukung (baru v4).");
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const friendly = /revert|settle|slippage|CurrencyNotSettled/i.test(msg)
      ? `harga pool gerak pas settle (pool volatil / fee tinggi). <b>Coba tap ➕ Add lagi</b> — token/${STABLE_SYM} yang keburu kebeli di-reuse, biasanya berhasil percobaan ke-2.`
      : short(e, 160);
    await edit(mid, `❌ Gagal nambah liq: ${friendly}`);
  }
}

export const isAwaitingAdd = (): boolean => !!pendingAdd;

// ══════════ 📅 Profit Calendar ══════════

export async function onCalendar(year?: number, month0?: number): Promise<void> {
  const now = new Date();
  const y = year ?? now.getUTCFullYear();
  const m = month0 ?? now.getUTCMonth();
  try {
    const { renderCalendar } = await import("./calendar.js");
    const png = await renderCalendar(y, m);
    const prev = m === 0 ? [y - 1, 11] : [y, m - 1];
    const next = m === 11 ? [y + 1, 0] : [y, m + 1];
    await sendPhoto(png, "📅 <b>Profit Calendar</b> — tiap kotak = PnL posisi yang di-close hari itu (fee included). Reset 07:00 WIB.", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⬅️ Prev", callback_data: `cal:${prev[0]}:${prev[1]}` },
            { text: "Next ➡️", callback_data: `cal:${next[0]}:${next[1]}` },
          ],
        ],
      },
    });
  } catch (e) {
    await send(`❌ Calendar gagal: ${short(e, 120)}`);
  }
}

export const isAwaitingAmount = (): boolean => !!pending?.awaitingAmount;
export const cancelPending = (): void => {
  pending = null;
  pendingAdd = null;
  pendingSwap = null;
  swapFrom = null;
};

function short(e: unknown, n: number): string {
  return String((e as Error)?.message ?? e).slice(0, n);
}
