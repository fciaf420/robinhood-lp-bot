/** Command + callback handlers. Each renders through tg.send/edit (owner chat only). */
import { cfg, env, C, persist } from "../config.js";
import { tokenMeta } from "../chain/tokens.js";
import { findPools, findUsdgPools, USDG } from "../chain/pools.js";
import { dexPairs, type DexPair } from "../chain/dexscreener.js";
import { discoverV4Pools, type V4Pool } from "../chain/v4/discover.js";
import { type V2Pool } from "../chain/v2/pair.js";
import { previewRange, openPosition, openV3UsdgInRange, openV3UsdgSingleSide, listPositions, closePosition } from "../chain/positions.js";
import { readLedger, ledgerSummary, backfillLedger, winRateText } from "../chain/ledger.js";
import { lifetimePnl } from "../chain/analytics.js";
import { balances, sellAllTokens, walletTokens, type WalletToken } from "../chain/holdings.js";
import { tokenBalanceRaw, unwrapAllWeth } from "../chain/swaps.js";
import { acquireWallet, releaseWallet } from "../chain/txlock.js";
import { revokeKnownApprovals } from "../chain/approvals.js";
import { ethUsd } from "../chain/price.js";
import { topVolumeNow, wcfg, usingOwnWatchRpc } from "../watch/scanner.js";
import { startWatch, stopWatch, restartWatch, isWatchOn } from "./watchLoop.js";
import { startFeed, stopFeed, feedStatus } from "./feedLoop.js";
import { autoLpStatus } from "../radar/autolp.js";
import { send, sendMenu, edit, explorerTx, sendPhoto, downloadTgFile } from "./tg.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { ethers } from "ethers";
import { esc, pre, padR, padL, sg, money, tokenEmoji, rangeBins } from "./format.js";
import { fmtMcap, fmtAge } from "../util/format.js";
import { logger } from "../util/log.js";
import { autoPanelKeyboard, autoBackButton, exitRuleKeyboard, type AutoPanelButton } from "./autoPanel.js";
import { settingsPanelKeyboard, type SettingsButton } from "./settingsPanel.js";
import { feedPanelKeyboard, feedAutoCloseConfirmKeyboard } from "./feedPanel.js";
import { screenDisplayCount } from "./screenDisplay.js";
import { closeAllConfirmationKeyboard, totalCloseAllPositions } from "./positionPanel.js";
import { walletBalanceText, walletKeyboard, unwrapConfirmationKeyboard } from "./walletPanel.js";
import type { PoolInfo, TokenMeta, MintMode } from "../types.js";

const log = logger("handlers");

/** Unified candidate pool across Uniswap versions (v2 + v3 + v4). */
interface UPool {
  version: "v2" | "v3" | "v4";
  fee: number;
  liqLabel: string; // display, e.g. "ETH · liq $18k · vol $127k"
  asset: string; // quote side: WETH | USDG | ETH — for the "TOKEN/asset" pair name
  tvl: number; // effective liquidity (USD) = max(on-chain estimate, DexScreener liq)
  vol: number; // 24h volume (USD) from DexScreener — the high-fee-farming signal
  v2?: V2Pool;
  v3?: PoolInfo;
  v4?: V4Pool;
}

const Q96 = 1n << 96n;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** Compact USD: $523 · $2.1k · $150k. */
const fmtUsdShort = (n: number): string =>
  n >= 1000 ? `$${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `$${Math.max(0, n).toFixed(0)}`;

/**
 * Total pool liquidity (USD) ≈ 2× the ETH/USDG-side virtual reserve at the current price. For v3/v2
 * the ETH side is the pool's REAL WETH balance; for v4 (singleton PoolManager, no per-pool balance)
 * it's derived from the active liquidity L and sqrtPrice. A rough figure — enough to filter dust
 * (a scam 99% pool has near-zero L) and rank real pools.
 */
function v4TvlUsd(p: V4Pool, px: number): number {
  const L = p.liquidity;
  const sp = p.sqrtPriceX96;
  if (L <= 0n || sp <= 0n) return 0;
  const c0 = p.poolKey.currency0.toLowerCase();
  const c1 = p.poolKey.currency1.toLowerCase();
  const usdgL = USDG.toLowerCase();
  // amount0 = L·2^96/sqrtP (currency0 raw) ; amount1 = L·sqrtP/2^96 (currency1 raw)
  if (c0 === ZERO_ADDR) return 2 * Number(ethers.formatEther((L * Q96) / sp)) * px; // ETH = currency0
  if (c1 === ZERO_ADDR) return 2 * Number(ethers.formatEther((L * sp) / Q96)) * px; // ETH = currency1
  if (c1 === usdgL) return 2 * Number(ethers.formatUnits((L * sp) / Q96, 6)); // USDG = currency1
  if (c0 === usdgL) return 2 * Number(ethers.formatUnits((L * Q96) / sp, 6)); // USDG = currency0
  return 0;
}

/** Price/MCAP snapshot for the exact v4 pool used by a newly opened position. */
function v4MarketLine(p: V4Pool, meta: TokenMeta, token: string, tickLower: number, tickUpper: number, ethPx: number): string | null {
  const c0 = p.poolKey.currency0.toLowerCase();
  const c1 = p.poolKey.currency1.toLowerCase();
  const tokenL = token.toLowerCase();
  const tokenIs0 = c0 === tokenL;
  const tokenIs1 = c1 === tokenL;
  if (!tokenIs0 && !tokenIs1) return null;
  const native = c0 === ZERO_ADDR || c1 === ZERO_ADDR || c0 === C.weth.toLowerCase() || c1 === C.weth.toLowerCase();
  const quoteDecimals = native ? 18 : 6; // the non-native v4 quote supported by the bot is USDG
  const quoteUsd = native ? ethPx : 1;
  if (!(quoteUsd > 0) || !(meta.supplyUi > 0)) return null;
  const ratioAt = (tick: number): number => Math.pow(1.0001, Math.min(887272, Math.max(-887272, tick)));
  const quotePerTokenUsdAt = (tick: number): number => {
    const rawQuotePerToken = tokenIs0
      ? ratioAt(tick) * 10 ** meta.decimals / 10 ** quoteDecimals
      : (1 / ratioAt(tick)) * 10 ** meta.decimals / 10 ** quoteDecimals;
    return rawQuotePerToken * quoteUsd;
  };
  const price = quotePerTokenUsdAt(p.tick);
  const low = quotePerTokenUsdAt(tickLower) * meta.supplyUi;
  const high = quotePerTokenUsdAt(tickUpper) * meta.supplyUi;
  const priceText = price >= 1 ? `$${price.toFixed(4)}` : price >= 0.01 ? `$${price.toFixed(6)}` : `$${price.toPrecision(4)}`;
  return `📊 MCAP range <b>${fmtMcap(Math.min(low, high))} → ${fmtMcap(Math.max(low, high))}</b> · price <b>${priceText}</b>`;
}

/**
 * Telegram cannot embed an interactive chart in a message. Use the selected pair/pool as the
 * DexScreener target so the decision screen opens the same market the mint will use, not merely
 * an unrelated token page. DexScreener indexes Robinhood v4 pool IDs as pair addresses.
 */
function chartButton(p: UPool, token: string): { text: string; url: string } {
  const target = p.v3?.pool ?? p.v4?.poolId ?? p.v2?.pair ?? token;
  return { text: "📈 Open live chart", url: `https://dexscreener.com/robinhood/${target}` };
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
type AutoInput = "sizeEth" | "minScore" | "maxOpen" | "maxPerHour" | "dailyCapEth" | "compoundMinUsd" | "tpPct" | "slPct";
let pendingAutoInput: AutoInput | null = null;
type SettingsInput = "widthPct" | "slippagePct" | "minFeePpm" | "nativeTargetEth";
let pendingSettingsInput: SettingsInput | null = null;
// "➕ Add" flow — top up an EXISTING position (increase liquidity, not a new NFT)
let pendingAdd: { tokenId: string; version: "v3" | "v4" } | null = null;

const GAS_RESERVE = 0.0004; // native ETH kept for gas (~4-5 tx at ~0.0001 each)
const usableEth = (b: { weth: string; eth: string }): number =>
  Number(b.weth) + Math.max(0, Number(b.eth) - GAS_RESERVE);

/**
 * A computed ETH amount → a parseEther-safe decimal string. A raw JS float such as
 * 0.00005454831971162516 has 20 significant decimals and makes ethers.parseEther throw
 * "too many decimals for format"; 9 decimals (1 gwei) is ample precision for an LP amount.
 * Returns null for non-finite / non-positive / sub-gwei dust so callers can reject it.
 */
const toEthStr = (n: number): string | null => {
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = n.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return s === "0" || s === "" ? null : s;
};

// ══════════ open flow ══════════

export async function onCA(addr: string): Promise<void> {
  const status = await send(`🔎 <b>Searching v3 + v4 pools</b> on Robinhood Chain\n<code>${addr}</code>`);
  const statusId = status?.result?.message_id;
  // Cold v4 discovery may need to read historical initialize logs. Give the user visible feedback
  // while the bounded search is running instead of leaving the first message looking frozen.
  const progressTimer = statusId
    ? setTimeout(() => {
        void edit(statusId, `🔎 <b>Still scanning…</b>\n\nReading v3/v4 pool data and checking market activity. A cold scan can take up to ~25 seconds.`, {
          reply_markup: { inline_keyboard: [[{ text: "⏳ Scanning…", callback_data: "scan:busy" }]] },
        });
      }, 4000)
    : undefined;
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
      await send(`⌛ RPC is slow — token metadata is not available yet. Paste it again in a moment.`);
      if (progressTimer) clearTimeout(progressTimer);
      return;
    }
    meta = m;
    const { discoverV4UsdgPools } = await import("../chain/v4/discover.js");
    // ETH price + DexScreener 24h volume + v3 (WETH) + v3 (USDG) + v4 (ETH) + v4 (USDG) in parallel.
    // v2 dropped — fee 0.30% only, not part of the high-fee farming strategy (and it was a slow leg).
    const [px, dex, v3, v3usd, v4, v4usd] = await Promise.all([
      to(ethUsd().catch(() => 0), 8000, 0),
      to(dexPairs(addr, Date.now()).catch(() => new Map<string, DexPair>()), 8000, new Map<string, DexPair>()),
      to(findPools(addr).catch(() => [] as PoolInfo[]), 8000, [] as PoolInfo[]),
      to(findUsdgPools(addr).catch(() => [] as PoolInfo[]), 8000, [] as PoolInfo[]),
      // v4 = the focus. RPC getLogs (cache-first, usually <1s); give a COLD full-range scan generous
      // room to finish so pools aren't missed by a premature timeout.
      to(discoverV4Pools(addr).catch(() => [] as V4Pool[]), 22000, [] as V4Pool[]),
      to(discoverV4UsdgPools(addr).catch(() => [] as V4Pool[]), 22000, [] as V4Pool[]),
    ]);
    log.info(`Cari pool ${meta.symbol}: v3 ${v3.length + v3usd.length} · v4 ${v4.length + v4usd.length} · dex ${dex.size}${timedOut ? " · ⚠️TIMEOUT" : ""}`);
    // Enrich each pool with DexScreener 24h VOLUME (matched by pool address for v2/v3, by poolId for
    // v4). v4 standing TVL isn't readable on Robinhood (singleton PoolManager → getLiquidity is a
    // dust snapshot, DexScreener reads $0), so VOLUME is the real high-fee-farming signal.
    const mk = (version: UPool["version"], fee: number, asset: string, est: number, key: string, extra: Partial<UPool>) => {
      const d = dex.get(key.toLowerCase());
      const liq = d && d.liqUsd > 0 ? d.liqUsd : est; // DexScreener liq accurate for v2/v3; on-chain estimate for v4
      const vol = d?.vol24h ?? 0;
      const label = vol > 0 ? `${asset} · liq ${fmtUsdShort(liq)} · vol ${fmtUsdShort(vol)}` : `${asset} · liq ${fmtUsdShort(liq)}`;
      all.push({ version, fee, asset, tvl: Math.max(est, d?.liqUsd ?? 0), vol, liqLabel: label, ...extra });
    };
    for (const p of v3) mk("v3", p.fee, "WETH", 2 * p.wethInPool * px, p.pool, { v3: p });
    for (const p of v3usd) mk("v3", p.fee, "USDG", 2 * (p.usdgInPool ?? 0), p.pool, { v3: p });
    // NO `liquidity > 0` gate: v4 active-L is a JIT snapshot that flips to 0 between blocks, which
    // would drop a live, high-volume pool at random. The liq/vol filter below decides instead — a
    // pool with real 24h VOLUME stays even when its standing liquidity momentarily reads 0.
    for (const p of v4) mk("v4", p.fee, "ETH", v4TvlUsd(p, px), p.poolId, { v4: p });
    for (const p of v4usd) mk("v4", p.fee, "USDG", v4TvlUsd(p, px), p.poolId, { v4: p });
  } catch (e) {
    await send(`❌ Failed to read token/pool: ${short(e, 80)}`);
    if (progressTimer) clearTimeout(progressTimer);
    return;
  }
  if (progressTimer) clearTimeout(progressTimer);
  if (!all.length) {
    await send(
      timedOut
        ? `⌛ RPC is slow — not all ${esc(meta.symbol)} pools were available. Paste again shortly (the second attempt should be faster because results are cached).`
        : `⚠️ No ${esc(meta.symbol)} pools found (v3 WETH, v4 ETH/USDG). LP is not available yet.`,
    );
    return;
  }
  // Keep pools with real activity: standing liq ≥ min OR 24h volume ≥ min. High-fee farming lives on
  // TURNOVER, not standing TVL, so a low-liq pool with volume stays. Highest fee first, then most
  // volume. If nothing passes, show the 3 most-active anyway (with a warning) so the user isn't stuck.
  const min = cfg.lp.minPoolTvlUsd;
  const active = (p: UPool) => Math.max(p.tvl, p.vol);
  // v4 liq/vol read unreliably ($0) on Robinhood's singleton PoolManager, so DON'T hide v4 by the
  // liq/vol floor — that dropped real pools. Show EVERY v4 pool; the dust
  // filter applies only to v3 (reliable metrics). Busiest (most 24h vol) first, then highest fee.
  const MAX_SHOW = 14;
  let pools = all
    .filter((p) => p.version === "v4" || p.tvl >= min || p.vol >= min)
    .sort((a, b) => b.vol - a.vol || b.fee - a.fee)
    .slice(0, MAX_SHOW);
  let note = "";
  if (!pools.length) {
    pools = [...all].sort((a, b) => active(b) - active(a)).slice(0, 3);
    note = `\n⚠️ All pools are below ${fmtUsdShort(min)} liquidity &amp; volume — showing the 3 most active (thin liquidity, use caution).`;
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
  const dropLine = dropped > 0 && !note ? ` · +${dropped} hidden` : "";
  await send(
    `🦄 <b>${esc(meta.symbol)} pools</b>  ·  ${pools.length} pools  ·  sorted by volume${dropLine}${note}\n\n` +
      `${body}\n\n` +
      `<i>🔥 = meaningful volume · n/a = not indexed yet (quiet/new).\nChoose a number below 👇</i>`,
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
    isUsdPool ? tokenBalanceRaw(USDG).catch(() => 0n) : Promise.resolve(0n),
  ]);
  // token already in the wallet (e.g. bought on a prior attempt) — in-range LP reuses it, no re-buy
  const tokUi = tokRaw > 0n ? Number(tokRaw) / 10 ** pending.meta.decimals : 0;
  pending.heldTokenUi = tokUi;
  // USDG already in the wallet → offer a one-tap single-side that funds ENTIRELY from it (no ETH
  // input, no ETH→USDG swap). This is the "kalo udah ada USDG, gak usah input 0.001 buat swap" flow.
  const usdgUi = Number(ethers.formatUnits(usdgRaw, 6));

  // for a v4 dual-side (in-range) mint, compute the ETH that BALANCES the held token so the
  // two sides fill evenly (no swap, minimal leftover) — this is the "hitungan sama" the user wants
  // ETH-paired v4 only: a "held-token-balancing" ETH amount is meaningless on a USDG pool (both
  // sides are funded from ETH via Kyber), and computing it there mis-reads the pool price → garbage.
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
      ? `♻️ <b>${tokUi.toPrecision(4)} ${esc(pending.meta.symbol)}</b> is already in the wallet — it will be <b>reused</b> (no repurchase).`
      : "";
  const balLine = balanced > 0 ? `⚖️ For a <b>balanced dual-side</b> position with that token: use <b>~${balanced.toFixed(5)} ETH</b>.` : "";
  const showUsdgBtn = isUsdPool && usdgUi >= 1;
  const usdgLine = showUsdgBtn
    ? `💵 <b>$${usdgUi.toFixed(2)} USDG</b> is already in the wallet — tap the button for <b>single-side without a swap or amount input</b>.`
    : "";
  const kbRows: { text: string; callback_data: string }[][] = [];
  if (balanced > 0) kbRows.push([{ text: `⚖️ Balanced dual-side (~${balanced.toFixed(4)} Ξ)`, callback_data: "ballp" }]);
  if (showUsdgBtn) kbRows.push([{ text: `💵 Single-side using wallet USDG ($${usdgUi.toFixed(2)})`, callback_data: "usdgw" }]);
  const extra = kbRows.length ? { reply_markup: { inline_keyboard: kbRows } } : {};
  await edit(
    mid,
    [
      `<b>${esc(pending.meta.symbol)}</b> · <b>${p.version.toUpperCase()}</b> fee ${(p.fee / 10000).toFixed(2)}% selected.`,
      b
        ? `Available for LP: <b>${usableEth(b).toFixed(5)} ETH</b>  <i>(WETH ${Number(b.weth).toFixed(4)} + ETH ${Number(b.eth).toFixed(4)})</i>`
        : "",
      reuseLine,
      balLine,
      usdgLine,
      ``,
      `💬 <b>Enter the ETH amount</b> to LP (example: <code>0.005</code>)${kbRows.length ? " — or tap a button below." : ""}`,
    ]
      .filter(Boolean)
      .join("\n"),
    extra,
  );
}

/** One-tap: dual-side v4 mint with the ETH amount that balances the held token. */
export async function onBalancedLp(mid: number): Promise<void> {
  if (!pending?.chosen?.v4 || !pending.balancedEth) return;
  const amt = toEthStr(pending.balancedEth);
  const b = await balances().catch(() => null);
  if (!amt || (b && Number(amt) > usableEth(b) + 1e-9)) {
    pending.awaitingAmount = true;
    await send(
      `⚠️ Balanced dual-side amount (${pending.balancedEth}) is invalid or exceeds the balance (${b ? usableEth(b).toFixed(5) : "?"} ETH). Enter an ETH amount manually (example: <code>0.005</code>).`,
    );
    return;
  }
  pending.ethAmt = amt;
  pending.awaitingAmount = false;
  await onMintV4(mid, "inrange");
}

/**
 * One-tap: open SINGLE-SIDE USDG funded ENTIRELY from the USDG already in the wallet — no ETH
 * amount to type, no ETH→USDG swap. Sizes the position to the full held USDG by passing its
 * ETH-equivalent as the budget; the mint fn computes target = ethAmt×ethUsd and reuses the held
 * USDG (buys nothing). Only native ETH for gas is needed. This is the "USDG already exists → no need
 * to enter 0.001 for a swap" flow.
 */
export async function onUseWalletUsdg(mid: number): Promise<void> {
  if (!pending?.chosen) return;
  const isUsd = pending.chosen.v4?.quote === "usd" || pending.chosen.v3?.quote === "usd";
  if (!isUsd) {
    await send("This pool is not a USDG pair — use the regular ETH input.");
    return;
  }
  const [usdgRaw, b, px] = await Promise.all([
    tokenBalanceRaw(USDG).catch(() => 0n),
    balances().catch(() => null),
    ethUsd().catch(() => 0),
  ]);
  const usdgUi = Number(ethers.formatUnits(usdgRaw, 6));
  if (usdgUi < 1) {
    await send(`Wallet USDG is only $${usdgUi.toFixed(2)} — not enough for single-side. Enter an ETH amount manually.`);
    return;
  }
  if (b && Number(b.eth) < GAS_RESERVE) {
    await send(`⚠️ Native ETH ${Number(b.eth).toFixed(5)} < gas reserve ${GAS_RESERVE} — mint still needs gas. Add some native ETH first.`);
    return;
  }
  if (!(px > 0)) {
    await send("⚠️ ETH/USD price is unavailable — try again shortly (needed for USDG sizing).");
    return;
  }
  // USD → ETH-equivalent budget so the mint fn's target ≈ held USDG → reuse buys nothing (no swap).
  pending.ethAmt = toEthStr(usdgUi / px) ?? String(usdgUi / px);
  pending.awaitingAmount = false;
  const feePct = (pending.chosen.fee / 10000).toFixed(2);
  await edit(mid, `⏳ <b>Single-side USDG using $${usdgUi.toFixed(2)} from the wallet…</b> (no swap · fee ${feePct}%)`);
  if (pending.chosen.version === "v4") return onMintV4(mid, "v4us");
  return onMintV3Usdg(mid, true);
}

export async function onAmount(text: string): Promise<void> {
  if (!pending?.awaitingAmount || !pending.chosen) return;
  const eth = parseFloat(text);
  if (!(eth > 0)) {
    await send("Enter a valid ETH amount, for example: 0.005");
    return;
  }
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(
      `⚠️ Amount too large. Only ${usableEth(b).toFixed(5)} ETH is available for LP (WETH ${Number(b.weth).toFixed(4)} + ETH ${Number(b.eth).toFixed(4)}, leaving gas reserved). Enter a smaller amount.`,
    );
    return;
  }
  if (b && Number(b.eth) < GAS_RESERVE) {
    await send(
      `⚠️ Native ETH is only ${Number(b.eth).toFixed(5)} — below the gas reserve (minimum ${GAS_RESERVE}). Add native ETH, or unwrap some WETH → ETH.`,
    );
    return;
  }
  pending.ethAmt = toEthStr(eth) ?? String(eth);
  pending.awaitingAmount = false;

  // ── v2 pool → zap (full-range, always both-sided) ──
  if (pending.chosen.version === "v2") {
    await send(
      [
        `<b>Confirm LP · Uniswap v2</b>`,
        `${esc(pending.meta.symbol)} · fee <b>0.30%</b> · deposit <b>${eth} ETH</b> · full-range`,
        ``,
        `🎯 v2 is always <b>both-sided 50/50</b>: the bot swaps ~half the ETH → ${esc(pending.meta.symbol)}, with the rest becoming the LP pair. <b>Fees start immediately.</b>`,
        `⚠️ You hold the token directly (a rug can lose ~half). v2 has no single-side mode.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 LP v2 (zap ${eth}Ξ)`, callback_data: "mint:v2" }],
            [chartButton(pending.chosen, pending.token)],
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
          `<b>Confirm LP · Uniswap v4 · USDG</b> 🦄`,
          `${esc(pending.meta.symbol)}/USDG · fee <b>${feePct}%</b> · deposit <b>${eth} ETH</b>`,
          ``,
          `🎯 <b>In-range (farming)</b> — buy USDG + ${esc(pending.meta.symbol)} with ETH (Kyber), then mint both-sided. <b>${feePct}% fees start immediately.</b> You hold the token directly (rug risk).`,
          ``,
          `🛡 <b>Single-side USDG</b> — park <b>USDG only (0 tokens)</b>, with the range on the USDG side. Fees start only when ${esc(pending.meta.symbol)} <b>pumps</b> into range. Rug-safe: if the token dumps, your USDG remains intact.`,
        ].join("\n"),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: `🎯 In-range ${feePct}% (${eth}Ξ)`, callback_data: "mint:v4r" }],
              [{ text: `🛡 Single-side USDG ${feePct}%`, callback_data: "mint:v4us" }],
              [chartButton(pending.chosen, pending.token)],
              [{ text: "❌ Cancel", callback_data: "cancel" }],
            ],
          },
        },
      );
      return;
    }
    await send(
      [
        `<b>Confirm mint · Uniswap v4</b> 🦄`,
        `${esc(pending.meta.symbol)} · fee <b>${feePct}%</b> · deposit <b>${eth} ETH</b> · pair native ETH`,
        ``,
        `🎯 <b>In-range (farming)</b> — buy the token through the best route (Kyber), then mint around the current price. <b>${feePct}% fees start immediately.</b> You hold the token directly (rug risk).`,
        ``,
        `🛡 <b>Single-side ETH</b> — park ETH with the range above the current price. Fees start only when price rises into range. Protected from token rugs.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 In-range farming ${feePct}%`, callback_data: "mint:v4r" }],
            [{ text: `🛡 Single-side ETH ${feePct}%`, callback_data: "mint:v4" }],
            [chartButton(pending.chosen, pending.token)],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      },
    );
    return;
  }

  // ── v3 token/USDG pool → in-range (farming) or single-side USDG ──
  if (pending.chosen.v3?.quote === "usd") {
    const feePct = (pending.chosen.fee / 10000).toFixed(2);
    await send(
      [
          `<b>Confirm LP · Uniswap v3 · USDG</b>`,
        `${esc(pending.meta.symbol)}/USDG · fee <b>${feePct}%</b> · deposit <b>${eth} ETH</b>`,
        ``,
        `🎯 <b>In-range (farming)</b> — buy USDG + ${esc(pending.meta.symbol)} with ETH (Kyber), then mint both-sided. <b>${feePct}% fees start immediately.</b> You hold the token directly (rug risk).`,
        ``,
        `🛡 <b>Single-side USDG</b> — park <b>USDG only (0 tokens)</b>, with the range on the USDG side. Fees start only when ${esc(pending.meta.symbol)} <b>pumps</b> into range. Rug-safe: if the token dumps, your USDG remains intact.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 In-range ${feePct}% (${eth}Ξ)`, callback_data: "mint:v3u" }],
            [{ text: `🛡 Single-side USDG ${feePct}%`, callback_data: "mint:v3us" }],
            [chartButton(pending.chosen, pending.token)],
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
        `<b>Confirm mint · Uniswap v3</b>`,
      `${esc(pending.meta.symbol)} · fee ${(pending.chosen.fee / 10000).toFixed(2)}% · deposit <b>${eth} ETH</b> · width ${cfg.lp.widthPct}%`,
      pS ? `📊 MCAP now: <b>${fmtMcap(pS.mcapNow)}</b>` : "",
      ``,
      `🛡 <b>Single-side ETH</b> — range ${rng(pS)}`,
      `   0% token. Fees start only when MCAP enters the range. Protected from token rugs.`,
      ``,
      `🎯 <b>In-range</b> — range ${rng(pI)}`,
      `   swap ~<b>${pI?.swapPct ?? "?"}%</b> of the capital into ${esc(pending.meta.symbol)} first. Fees start immediately,`,
      `   but you hold the token directly (a rug can immediately lose ~${pI?.swapPct ?? "?"}%).`,
    ]
      .filter(Boolean)
      .join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: `🎯 In-range (swap ~${pI?.swapPct ?? "?"}%)`, callback_data: "mint:inrange" }],
          [{ text: "🛡 Single-side ETH", callback_data: "mint:single" }],
          [chartButton(pending.chosen, pending.token)],
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
  if (pending.chosen.v3?.quote === "usd") return onMintV3Usdg(mid, action === "v3us");

  const mode: MintMode = action === "inrange" ? "inrange" : "single";
  const inR = mode === "inrange";
  await edit(
    mid,
    `⏳ <b>Minting v3 ${pending.ethAmt} ETH…</b> ${inR ? "(wrap → swap → approve → mint)" : "(wrap → approve → mint)"}`,
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
        `deposit ~${Number(r.depositEth).toFixed(5)}Ξ`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ Mint failed: ${short(e, 160)}`);
  }
}

/** Mint a token/USDG v3 position — both-sided in-range, or single-side USDG (park stable only). */
async function onMintV3Usdg(mid: number, single = false): Promise<void> {
  invalidateListCache();
  if (!pending?.chosen?.v3 || !pending.ethAmt) return;
  const feePct = (pending.chosen.fee / 10000).toFixed(2);
  await edit(mid, `⏳ <b>Minting v3 USDG ${pending.ethAmt} ETH…</b> ${single ? "(Kyber → USDG → single-side)" : "(Kyber → USDG+token → mint both-sided)"}`);
  try {
    const r = single ? await openV3UsdgSingleSide(pending.chosen.v3, pending.ethAmt) : await openV3UsdgInRange(pending.chosen.v3, pending.ethAmt);
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)}/USDG #${r.tokenId ?? "?"}</b> [v3] ${single ? "🛡 SINGLE-SIDE USDG" : "🎯 IN-RANGE (farming)"}`,
        r.wrapHash ? `wrap: <a href="${explorerTx(r.wrapHash)}">tx</a>` : "",
        r.swapHash ? `beli USDG (Kyber): <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
        `pool fee <b>${feePct}%</b> · range tick ${r.tickLower}..${r.tickUpper}`,
        `deposit ${r.depositEth}Ξ · ${esc(r.side)}`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ Mint failed: ${short(e, 160)}`);
  }
}

async function onMintV4(mid: number, action: string): Promise<void> {
  invalidateListCache();
  if (!pending?.chosen?.v4 || !pending.ethAmt) return;
  const fee = pending.chosen.v4.fee;
  const isUsd = pending.chosen.v4.quote === "usd";
  const v4pool = pending.chosen.v4;
  const usdgSingle = isUsd && action === "v4us";
  const inR = isUsd ? !usdgSingle : action === "v4r" || action === "inrange"; // ETH: v4r/inrange = farming
  await edit(mid, `⏳ <b>Minting v4 ${pending.ethAmt} ETH…</b> ${usdgSingle ? "(Kyber → USDG → single-side)" : isUsd ? "(Kyber → USDG+token → mint)" : inR ? "(swap → Permit2 → mint in-range)" : "(simulate → mint single-side)"}`);
  try {
    const { openV4SingleSide, openV4InRange, openV4UsdgInRange, openV4UsdgSingleSide } = await import("../chain/v4/mint.js");
    const r = usdgSingle
      ? await openV4UsdgSingleSide(v4pool, pending.ethAmt)
      : isUsd
        ? await openV4UsdgInRange(v4pool, pending.ethAmt)
        : inR
          ? await openV4InRange(pending.token, pending.ethAmt, { fee })
          : await openV4SingleSide(pending.token, pending.ethAmt, { fee });
    const market = v4MarketLine(v4pool, pending.meta, pending.token, r.tickLower, r.tickUpper, await ethUsd().catch(() => 0));
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)} #${r.tokenId ?? "?"}</b> [v4] 🦄 ${inR ? "🎯 IN-RANGE (farming)" : "single-side"}`,
        inR && (r as any).swapHash ? `swap ${(r as any).swappedPct}% → ${esc(sym)}: <a href="${explorerTx((r as any).swapHash)}">tx</a>` : "",
        `pool fee <b>${(r.fee / 10000).toFixed(2)}%</b> · range tick ${r.tickLower}..${r.tickUpper}`,
        market ?? "",
        `deposit ${r.depositEth}Ξ`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `Close: <code>/v4close ${r.tokenId}</code>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    log.error(`v4 mint failed (${action}): ${short(e, 240)}`);
    // Clear the in-memory prompt so a failed attempt cannot be accidentally submitted later.
    // The user can verify chain state first, then restart from a fresh pool card.
    cancelPending();
    await edit(mid, `❌ <b>v4 LP was not opened</b>\n\n${esc(short(e, 180))}\n\n<i>No success was confirmed. Check positions before trying again.</i>`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📋 Check positions", callback_data: "refresh" }],
          [{ text: "❌ Dismiss", callback_data: "cancel" }],
        ],
      },
    });
  }
}

async function onMintV2(mid: number): Promise<void> {
  if (!pending?.chosen?.v2 || !pending.ethAmt) return;
  if (!cfg.lp.v2Enabled) {
    await edit(mid, "🛡 v2 zap disabled in optimized fork: pair-level swaps have no minimum-output protection. Use v3/v4.");
    return;
  }
  await edit(mid, `⏳ <b>LP v2 ${pending.ethAmt} ETH…</b> (wrap → swap ~50% → add liquidity)`);
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
        `pool fee <b>0.30%</b> · deposit ${r.depositEth}Ξ`,
        `add-LP: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `pair <code>${r.pair}</code>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ v2 LP failed: ${short(e, 160)}`);
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
    const m = await send("⏳ Loading positions…");
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
    await out("No open LP positions (v3/v4).", { reply_markup: { inline_keyboard: [refreshBtn] } });
    return;
  }
  const px = await ethUsd().catch(() => 0);
  const usd = (e: number) => (px ? `$${(e * px).toFixed(2)}` : "?");
  let totEth = 0, totPnl = 0, totFee = 0, totDep = 0;

  const T: string[] = [];
  rows.forEach((r, i) => {
    totEth += r.valEth || 0;
    totFee += r.feeEth || 0;
    totDep += r.depEth || 0;
    if (r.pnlEth != null) totPnl += r.pnlEth;
    const hrs = r.ageMs ? r.ageMs / 3_600_000 : 0;
    const rate = hrs > 0.05 && r.feeEth ? `${usd(r.feeEth / hrs)}/h` : "—";
    const tag = `${r.inRange ? "🟢 IN RANGE" : "🔴 OUT OF RANGE"}${r.mode === "inrange" ? " · 🎯" : ""}`;
    if (i) T.push("");
    T.push(`${tokenEmoji(r.tokenSym)} ${r.pair ?? `${r.tokenSym}/WETH`}  ·  fee ${(r.fee / 10000).toFixed(2)}%  ·  #${r.tokenId}`);
    T.push(`   ${tag}`);
    T.push("   " + "─".repeat(34));
    T.push(`   ${padR("deposit", 7)} ${padL(r.depEth != null ? r.depEth.toFixed(6) + "Ξ" : "—", 11)}  ${padL(r.depEth != null ? usd(r.depEth) : "—", 9)}`);
    T.push(`   ${padR("value", 7)} ${padL(r.valEth.toFixed(6) + "Ξ", 11)}  ${padL(usd(r.valEth), 9)}`);
    T.push(`   ${padR("fee", 7)} ${padL(r.feeEth.toFixed(6) + "Ξ", 11)}  ${padL(usd(r.feeEth), 9)}`);
    T.push(`   ${padR("age", 7)} ${padL(fmtAge(r.ageMs) + (r.ageSource === "onchain" ? " ⛓" : ""), 11)}  ${rate}`);
    T.push(`   ${padR("MCAP", 7)} ${padL(fmtMcap(r.mcapNow), 11)}  ${r.entryMcap ? "entry " + fmtMcap(r.entryMcap) : "—"}`);
    if (r.rangeMcapHigh > 0) T.push(`   ${padR("range", 7)} ${fmtMcap(r.rangeMcapLow)} → ${fmtMcap(r.rangeMcapHigh)}`);
    T.push(`   ${padR("bins", 7)} ${rangeBins(r.tick, r.tickLower, r.tickUpper)}`);
    if (r.pnlEth != null) {
      T.push(`   ${padR("PnL", 7)} ${padL(sg(r.pnlEth, 6) + "Ξ", 11)}  ${padL((r.pnlEth >= 0 ? "+" : "-") + "$" + Math.abs(r.pnlEth * px).toFixed(2), 9)}  ${sg(r.pnlPct ?? 0, 1)}%`);
    } else {
      T.push(`   ${padR("PnL", 7)} — (deposit not recorded)`);
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
  // ── v4 positions block ──
  const T4: string[] = [];
  if (v4rows.length) {
      T4.push(`🦄 UNISWAP v4 · ${v4rows.length} positions`);
    T4.push("─".repeat(37));
    v4rows.forEach((r, i) => {
      const vEth = px ? r.valueUsd / px : 0;
      const fEth = px ? r.feeUsd / px : 0;
      const basisUsd = r.depEth != null && px ? r.depEth * px : null;
      const pnlUsd = basisUsd != null ? r.valueUsd - basisUsd : null;
      const pnlPct = basisUsd != null && basisUsd > 0 ? (pnlUsd! / basisUsd) * 100 : null;
      totEth += vEth;
      totFee += fEth;
      if (r.depEth != null) {
        totDep += r.depEth;
        totPnl += vEth - r.depEth;
      }
      if (i) T4.push("");
      T4.push(`${tokenEmoji(r.sym)} ${r.pair}  ·  fee ${(r.fee / 10000).toFixed(2)}%  ·  #${r.tokenId}`);
      T4.push(`   ${r.inRange ? "🟢 IN RANGE" : "🔴 OUT OF RANGE"}${r.ethPaired ? "" : " · non-ETH pair"}`);
      T4.push(`   ${padR("bins", 7)} ${rangeBins(r.tick, r.tickLower, r.tickUpper)}`);
      T4.push(`   ${padR("value", 7)} $${r.valueUsd.toFixed(2)}`);
      T4.push(`   ${padR("deposit", 7)} ${r.amount0} ${r.sym0} + ${r.amount1} ${r.sym1}`);
      T4.push(`   ${padR("fee", 7)} $${r.feeUsd.toFixed(2)} earned`);
      if (r.depEth != null) {
        T4.push(`   ${padR("basis", 7)} ${r.depEth.toFixed(6)}Ξ (${usd(r.depEth)})`);
        if (pnlUsd != null && pnlPct != null) {
          T4.push(`   ${padR("PnL", 7)} ${pnlUsd >= 0 ? "🟩 +" : "🟥 -"}$${Math.abs(pnlUsd).toFixed(2)}  ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`);
        } else {
          T4.push(`   ${padR("PnL", 7)} — (price unavailable)`);
        }
      } else {
        T4.push(`   ${padR("PnL", 7)} — (deposit not recorded)`);
      }
      T4.push(`   ${padR("age", 7)} ${fmtAge(r.ageMs)}`);
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
  const totalCount = totalCloseAllPositions(rows.length, v4rows.length);
  if (totalCount > 1) btns.push([{ text: `🗑🗑 CLOSE ALL (${totalCount} positions)`, callback_data: "closeall" }]);
  const S: string[] = [];
  if (totalCount > 1) {
    S.push(`TOTAL ${totalCount} positions  ·  v3 ${rows.length} · v4 ${v4rows.length}`);
    S.push("─".repeat(37));
    S.push(`${padR("deposit", 7)} ${padL(totDep.toFixed(6) + "Ξ", 11)}  ${padL(usd(totDep), 9)}`);
    S.push(`${padR("value", 7)} ${padL(totEth.toFixed(6) + "Ξ", 11)}  ${padL(usd(totEth), 9)}`);
    S.push(`${padR("fee", 7)} ${padL(totFee.toFixed(6) + "Ξ", 11)}  ${padL(usd(totFee), 9)}`);
    S.push(`${padR("PnL", 7)} ${padL(sg(totPnl, 6) + "Ξ", 11)}  ${padL((totPnl >= 0 ? "+" : "-") + "$" + Math.abs(totPnl * px).toFixed(2), 9)}`);
  }

  const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const head = `📋 <b>LP Positions</b>${px ? ` · ETH $${px.toFixed(0)}` : ""} · <i>${time}</i>`;
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
      await out("⏳ <b>Ledger is empty — rebuilding from on-chain data…</b>");
    try {
      await backfillLedger();
    } catch (e) {
      await out(`❌ Rebuild failed: ${short(e, 90)}`);
      return;
    }
    if (!readLedger().length) {
      await out("📒 No closed LP positions yet.\n<i>Entries are added automatically whenever you close a position.</i>");
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
  const px = await ethUsd().catch(() => 0);
  const when = (ts: number | null) =>
    ts ? new Date(ts).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "?";
  const verTag = (v?: string) => (v === "v4" ? "v4 🦄" : v === "v2" ? "v2 💧" : "v3");

  const T: string[] = [];
  slice.forEach((row, i) => {
    const n = page * LEDGER_PER_PAGE + i + 1;
    if (i) T.push("");
    if (row.e) {
      const e = row.e;
      const name = e.pair ?? `${e.sym}/WETH`; // v3 has no pair field → it's always token/WETH
      const win = e.pnlEth == null ? "⬜" : e.pnlEth >= 0 ? "🟩" : "🟥";
      T.push(`${win} ${tokenEmoji(e.sym)} ${name} · ${verTag(e.version)}${e.mode === "inrange" ? " 🎯" : ""}   ${n}/${combined.length}`);
      T.push(`   ${when(e.closedAt)} · hold ${fmtAge(e.heldMs)}`);
      if (e.quote === "usd") {
        // USDG-paired pools → show USD (natural unit); ETH shown as secondary
        const at = e.ethUsdAtClose || px || 0;
        const $ = (eth: number) => "$" + (eth * at).toFixed(2);
        T.push(`   deposit ${$(e.depEth ?? 0)} → returned ${$(e.outEth ?? 0)}`);
        if (e.pnlEth != null) T.push(`   PnL ${e.pnlUsd != null ? money(e.pnlUsd) : $(e.pnlEth)}  (${sg(e.pnlEth, 5)}Ξ)  ${sg(e.pnlPct ?? 0, 1)}%`);
        else T.push(`   PnL — (deposit not recorded)`);
      } else {
        T.push(`   deposit ${(e.depEth ?? 0).toFixed(5)}Ξ → returned ${(e.outEth ?? 0).toFixed(5)}Ξ`);
        if (e.pnlEth != null) T.push(`   PnL ${sg(e.pnlEth, 5)}Ξ  ${e.pnlUsd != null ? money(e.pnlUsd) : "—"}  ${sg(e.pnlPct ?? 0, 1)}%`);
        else T.push(`   PnL — (deposit not recorded)`);
      }
      if ((e.unsoldEth ?? 0) > 0) T.push(`   🪙 stranded ~${(e.unsoldEth ?? 0).toFixed(5)}Ξ (not sold)`);
    } else if (row.v4h) {
      const c = row.v4h;
      T.push(`⬜ ${tokenEmoji(c.pair)} ${c.pair} · v4 🦄   ${n}/${combined.length}`);
      T.push(`   ${when(c.closedAt)} · #${c.tokenId} · fee ${(c.fee / 10000).toFixed(2)}%`);
      T.push(`   PnL — (history before tracking${c.depEth != null ? `, deposit ${c.depEth.toFixed(5)}Ξ` : ""})`);
    }
  });

  const nV3 = allEntries.filter((e) => (e.version ?? "v3") === "v3").length;
  const nV4 = allEntries.filter((e) => e.version === "v4").length + v4hist.length;
  const nV2 = allEntries.filter((e) => e.version === "v2").length;
  const net = sum.pnlEth + sum.unsoldEth;
  const S: string[] = [];
  S.push(`${combined.length} CLOSED · ${nV3} v3 · ${nV4} v4${nV2 ? ` · ${nV2} v2` : ""}`);
  S.push("─".repeat(34));
    S.push(`${padR("win rate", 9)} ${sum.wins}W / ${sum.losses}L · ${sum.winRate.toFixed(0)}%`);
  S.push(`${padR("deposit", 9)} ${sum.depEth.toFixed(5)}Ξ · fee ${sum.feeEth.toFixed(5)}Ξ`);
  S.push(`${padR("REALIZED", 9)} ${sg(sum.pnlEth, 5)}Ξ · ${money(sum.pnlUsd)}`);
  if (sum.unsoldEth > 0) S.push(`${padR("stranded", 9)} +${sum.unsoldEth.toFixed(5)}Ξ · +$${(sum.unsoldEth * px).toFixed(2)}`);
  S.push(`${padR("NET", 9)} ${sg(net, 5)}Ξ · ${money(net * px)}`);

  const nav: object[] = [];
  if (page > 0) nav.push({ text: "◀️ Back", callback_data: `lg:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: `lg:${page}` });
  if (page < pages - 1) nav.push({ text: "Next ▶️", callback_data: `lg:${page + 1}` });

  const head = `📒 <b>LP Ledger</b> · ${combined.length} positions closed`;
  const foot = v4hist.length
    ? `<i>Combined v3+v4+v2 stats. ${v4hist.length} older v4 positions are not reconstructed — tap 🔄 Rebuild.</i>`
    : "";
  // 📸 card button per closed position on this page (positions with recorded PnL)
  const cardBtns: object[] = [];
  slice.forEach((row) => {
    if (row.e && row.e.pnlEth != null) {
      const e = row.e;
      const p = e.pnlEth! >= 0 ? "🟩" : "🟥";
      cardBtns.push([{ text: `📸 ${tokenEmoji(e.sym)} ${e.pair ?? `${e.sym}/WETH`} ${p}`, callback_data: `cardp:${e.tokenId}` }]);
    }
  });
  await out(head + "\n" + pre(T.join("\n")) + pre(S.join("\n")) + foot, {
    reply_markup: {
      inline_keyboard: [
        nav,
        ...cardBtns,
        [{ text: "📸 Portfolio card", callback_data: "card" }, { text: "🔄 Rebuild on-chain", callback_data: "lgrb" }],
      ],
    },
  });
}

export async function onLedgerRebuild(mid: number): Promise<void> {
  ledgerHistCache = null; // force a fresh on-chain scan
  try {
    const prog = (msg: string) => void edit(mid, `⏳ <b>Rebuilding ledger from on-chain</b>\n<i>${esc(msg)}</i>`).catch(() => {});
    const r = await backfillLedger(prog);
    // v4 positions closed before tracking → reconstruct realized PnL from archive (historical price)
    const { backfillLedgerV4 } = await import("../chain/v4/backfill.js");
    const r4 = await backfillLedgerV4(prog).catch(() => ({ rebuilt: 0 }));
    await edit(mid, `✅ Rebuild complete — v3: ${r.rebuilt} · v4: ${r4.rebuilt} reconstructed from on-chain.`);
    await onLedger(0);
  } catch (e) {
      await edit(mid, `❌ Rebuild failed: ${short(e, 100)}`);
  }
}

// ══════════ /scan (manual) ══════════

// ══════════ /screen (GMGN 24h thesis screen) ══════════

export async function onScreen(arg?: string): Promise<void> {
  const useLlm = arg !== "fast" && !!env.openrouterKey;
  const m = await send(`🧪 <b>Screening GMGN 24h…</b> <i>(mcap&gt;$500k · vol&gt;$1M · no flap${useLlm ? " · +thesis LLM" : ""})</i>`);
  const mid = m?.result?.message_id;
  try {
    const { screenTokens } = await import("../radar/screen.js");
    const { results, scanned, excludedFlap, excludedUnsafe } = await screenTokens({ llm: useLlm });
    if (!scanned) {
      await edit(mid, "🧪 GMGN returned no trending data (CLI inactive or rate-limited). Try again.");
      return;
    }
    if (!results.length) {
      await edit(mid, `🧪 No tokens passed the filters.\n<i>scanned ${scanned} · removed ${excludedFlap} flap · ${excludedUnsafe} unsafe</i>`);
      return;
    }
    const visible = results.slice(0, screenDisplayCount(results.length, useLlm));
    const kindTag = (k: string) => (k === "util" ? "🛠 utility" : k === "meme" ? "🐸 meme" : "❓ unclear");
    const commTag = (c: string) => (c === "clear" ? "🟢 clear community" : c === "thin" ? "🟡 thin community" : "🔴 suspicious community");
    const T: string[] = [];
    visible.forEach((r, i) => {
      const t = r.token;
      if (i) T.push("");
      T.push(`${i + 1}. ${tokenEmoji(t.symbol)} ${t.symbol}  ·  ${kindTag(r.kind)}  ·  score ${r.score}${r.verdict ? " · " + r.verdict.toUpperCase() : ""}`);
      T.push(`   ${commTag(r.community)} · FOMO ${r.fomo}`);
      T.push(`   mcap ${fmtMcap(t.marketCap)} · vol ${fmtMcap(t.volume)} · liq ${fmtMcap(t.liquidity)}`);
      const turn = t.liquidity > 0 ? (t.volume / t.liquidity).toFixed(0) + "×" : "?";
      T.push(`   turn ${turn} · 24h ${sg(t.change24hPct, 0)}% · smart ${t.smartWallets} · KOL ${t.kolWallets} · hold ${t.holders}`);
      if (r.thesis) T.push(`   💡 ${r.thesis}`);
      if (r.flags.length) T.push(`   🚩 ${r.flags.join(" · ")}`);
    });
    const head = `🧪 <b>GMGN 24h Screen</b> — showing ${visible.length} of ${results.length} candidates\n<i>scanned ${scanned} · removed ${excludedFlap} flap · ${excludedUnsafe} unsafe</i>`;
    // LP shortcut buttons for the top 6
    const btns = visible.slice(0, 6).map((r) => [
      { text: `${tokenEmoji(r.token.symbol)} LP ${r.token.symbol} (${r.score})`, callback_data: `ca:${r.token.address}` },
    ]);
    btns.push([{ text: "🔄 Refresh", callback_data: "screen" }]);
    await edit(mid, head + "\n" + pre(T.join("\n")), { reply_markup: { inline_keyboard: btns } });
  } catch (e) {
    await edit(mid, `❌ Screen failed: ${short(e, 120)}`);
  }
}

export async function onScan(): Promise<void> {
  const { scanOnce } = await import("../watch/scanner.js");
  const m = await send("🔍 Scanning volume…");
  const mid = m?.result?.message_id;
  try {
    const hits = await scanOnce((msg) => {
      if (mid) void edit(mid, `🔍 <i>${esc(msg)}</i>`).catch(() => {});
    });
    const { handleSpike } = await import("./pipeline.js");
    if (!hits.length) {
      await edit(mid, "🔍 No tokens passed the latest filters.\n<i>(two scans are needed to measure a rise — try again shortly)</i>");
      return;
    }
    await edit(mid, `🔍 <b>${hits.length} tokens</b> passed:`);
    for (const h of hits) await handleSpike(h);
  } catch (e) {
    await edit(mid, `❌ Scan failed: ${short(e, 90)}`);
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
    `${padR("scan every", 12)} ${w.intervalSec}s`,
    `${padR("vol 5m min", 12)} $${(w.minVol5m / 1000).toFixed(0)}k`,
    `${padR("min rise", 12)} ${w.riseFactor}× vs previous scan`,
    `${padR("vol 1h min", 12)} $${(w.minVol1h / 1000).toFixed(0)}k`,
    `${padR("min liquidity", 12)} $${(w.minLiqUsd / 1000).toFixed(0)}k`,
    `${padR("tax maks", 12)} ${w.maxTaxPct}%`,
    `${padR("cooldown", 12)} ${w.cooldownMin} minutes/token`,
    `${padR("RPC", 12)} ${usingOwnWatchRpc ? "separate (scanner only)" : "shared with LP"}`,
  ];
  const top = await topVolumeNow(3).catch(() => []);
  if (top.length) {
    T.push("");
    T.push("HIGHEST CURRENT 5m VOLUME");
    for (const t of top) {
      const pass = t.vol5m >= w.minVol5m;
      T.push(`  ${pass ? "✓" : " "} ${padR(t.symbol.slice(0, 10), 11)} $${(t.vol5m / 1000).toFixed(0)}k`);
    }
    const gap = w.minVol5m / Math.max(top[0]!.vol5m, 1);
    T.push(gap > 1 ? `  → threshold is ${gap.toFixed(1)}× above the high: QUIET` : `  → something crossed the threshold`);
  }
  await send(
    `👁 <b>Volume Watch</b>${pre(T.join("\n"))}<code>/watch on</code> · <code>/watch off</code> · <code>/scan</code> (scan now)\nChange: <code>/set vol5m 200000</code> · <code>/set rise 2</code> · <code>/set liq 100000</code>`,
  );
}

// ══════════ /feed (real-time sequencer monitor) ══════════

async function renderFeedPanel(mid?: number): Promise<void> {
  const s = feedStatus();
  const f = cfg.feed;
  const r = cfg.radar;
  const T = [
    `${padR("new-token alerts", 16)} ${f.newToken ? "on" : "off"}`,
    `${padR("position monitor", 16)} ${f.positionMonitor ? "on" : "off"}`,
    `${padR("auto-close OOR", 16)} ${f.autoCloseOutOfRange ? "⚠️ ON" : "off"}`,
    `${padR("minimum seed", 16)} ${f.newTokenMinWethSeed} WETH`,
    ``,
    `${padR("radar LLM", 16)} ${r.enabled ? (env.openrouterKey ? "on" : "on (missing key)") : "off"}`,
    `${padR("radar model", 16)} ${env.openrouterModel}`,
    `${padR("radar GMGN", 16)} ${r.useGmgn ? "on" : "off"}`,
    `${padR("fast submit", 16)} ${env.fastSubmit ? "ON → sequencer" : "off (via RPC)"}`,
    ``,
    `${padR("known tokens", 16)} ${s.seen}`,
    `${padR("position assets", 16)} ${s.positionTokens}`,
    `${padR("new-token alerts", 16)} ${s.newTokens}`,
    `${padR("range alerts", 16)} ${s.rangeAlerts}`,
  ];
  const text =
    `📡 <b>Sequencer Feed Monitor</b> · ${s.on ? "🟢 RUNNING" : "🔴 OFF"}\n` +
    `<i>Real-time transaction stream for new-token and position alerts. Separate from Hunter and Volume Watch.</i>\n\n` +
    pre(T.join("\n")) +
    `\n<i>Position assets includes unique v3/v4 token assets loaded by the monitor. Counters reset when the monitor restarts${s.on ? "." : "; start the feed to load them."}</i>`;
  const extra = { reply_markup: { inline_keyboard: feedPanelKeyboard({ enabled: s.on, newToken: f.newToken, positionMonitor: f.positionMonitor, autoCloseOutOfRange: f.autoCloseOutOfRange, radar: r.enabled }) } };
  if (mid != null) await edit(mid, text, extra);
  else await send(text, extra);
}

export async function onFeed(arg?: string): Promise<void> {
  if (arg === "on") {
    cfg.feed.enabled = true;
    persist();
    await startFeed();
    await renderFeedPanel();
    return;
  }
  if (arg === "off") {
    cfg.feed.enabled = false;
    persist();
    stopFeed();
    await renderFeedPanel();
    return;
  }
  await renderFeedPanel();
}

/** Handle the feed panel without forcing the user to remember slash commands. */
export async function onFeedButton(data: string, mid: number): Promise<void> {
  if (data === "feed:refresh") return renderFeedPanel(mid);
  if (data === "feed:on") {
    cfg.feed.enabled = true;
    persist();
    await edit(mid, "⏳ <b>Starting sequencer feed…</b>");
    await startFeed();
    return renderFeedPanel(mid);
  }
  if (data === "feed:off") {
    cfg.feed.enabled = false;
    persist();
    stopFeed();
    return renderFeedPanel(mid);
  }
  if (data === "feed:toggle:newtoken") cfg.feed.newToken = !cfg.feed.newToken;
  else if (data === "feed:toggle:posmon") cfg.feed.positionMonitor = !cfg.feed.positionMonitor;
  else if (data === "feed:toggle:radar") cfg.radar.enabled = !cfg.radar.enabled;
  else if (data === "feed:toggle:autoclose") {
    if (!cfg.feed.autoCloseOutOfRange) {
      await edit(mid, "⚠️ <b>Enable automatic out-of-range closing?</b>\n\nThis can close a live LP position without another prompt.", { reply_markup: { inline_keyboard: feedAutoCloseConfirmKeyboard() } });
      return;
    }
      cfg.feed.autoCloseOutOfRange = false;
  } else if (data === "feed:autoclose:yes") {
    cfg.feed.autoCloseOutOfRange = true;
  } else {
    return onFeed();
  }
  persist();
  return renderFeedPanel(mid);
}

// ══════════ /v4 (detect v4 pools) ══════════

export async function onV4(ca?: string): Promise<void> {
  if (!ca || !/^0x[a-fA-F0-9]{40}$/.test(ca)) {
    await send("Format: <code>/v4 0x…</code> (token CA) — view v4/ETH pools + fees + liquidity.");
    return;
  }
  const m = await send(`🔎 Checking v4 pools for <code>${ca}</code>…`);
  const mid = m?.result?.message_id;
  try {
    const { discoverV4Pools, pickV4Pool } = await import("../chain/v4/discover.js");
    const meta = await tokenMeta(ca).catch(() => null);
    const pools = await discoverV4Pools(ca);
    if (!pools.length) {
      await edit(mid, `No v4/ETH pools found for this ${meta?.symbol ?? "token"}.`);
      return;
    }
    const T = pools
      .sort((a, b) => b.fee - a.fee)
      .map((p) => `  ${padR((p.fee / 10000).toFixed(2) + "%", 7)} ${p.liquidity > 0n ? "✅ liquidity available" : "— empty"}  tick ${p.tick}`);
    const pick = pickV4Pool(pools);
    await edit(
      mid,
      `🦄 <b>Pool v4/ETH · ${esc(meta?.symbol ?? "?")}</b>${pre(T.join("\n"))}` +
        (pick ? `Suggested LP target (highest fee + liquidity): <b>${(pick.fee / 10000).toFixed(2)}%</b>\n` : "") +
        `<i>v4 mint/close are available in this build. This command also supports discovery.</i>`,
    );
  } catch (e) {
    await edit(mid, `❌ ${short(e, 90)}`);
  }
}

// ══════════ /v4lp /v4close (v4 LP execution — single-side ETH) ══════════

export async function onV4Lp(text: string): Promise<void> {
  const [, ca, ethStr] = text.split(/\s+/);
  if (!ca || !/^0x[a-fA-F0-9]{40}$/.test(ca) || !ethStr || !(parseFloat(ethStr) > 0)) {
    await send("Format: <code>/v4lp 0x… 0.001</code> — open single-side ETH LP in the highest-fee v4 pool.");
    return;
  }
  const eth = parseFloat(ethStr);
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(`⚠️ Amount too large. Only ${usableEth(b).toFixed(5)} ETH is available for LP.`);
    return;
  }
  const m = await send(`⏳ <b>Mint v4 ${eth} ETH…</b> (discover pool → simulate → mint with native ETH)`);
  const mid = m?.result?.message_id;
  try {
    const { openV4SingleSide } = await import("../chain/v4/mint.js");
    const r = await openV4SingleSide(ca, String(eth));
    const displayMeta = await tokenMeta(ca).catch(() => null);
    const displayPool = (await discoverV4Pools(ca).catch(() => [])).find((p) => p.fee === r.fee);
    const market = displayMeta && displayPool ? v4MarketLine(displayPool, displayMeta, ca, r.tickLower, r.tickUpper, await ethUsd().catch(() => 0)) : null;
    await edit(
      mid,
      [
        `✅ <b>v4 LP opened</b> #${r.tokenId ?? "?"} 🦄`,
        `pool fee <b>${(r.fee / 10000).toFixed(2)}%</b> · single-side ETH`,
        `range tick ${r.tickLower}..${r.tickUpper} · deposit ${r.depositEth}Ξ`,
        market ?? "",
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `Close: <code>/v4close ${r.tokenId}</code>`,
      ].join("\n"),
    );
  } catch (e) {
    await edit(mid, `❌ v4 mint failed: ${short(e, 160)}`);
  }
}

export async function onV4CloseAsk(tokenId: string, mid: number): Promise<void> {
  if (!/^\d+$/.test(tokenId)) return;
  await edit(mid, `⚠️ <b>Close v4 position #${tokenId}?</b>\n\nThis withdraws liquidity, claims fees, and may swap the token side back to ETH.`, {
    reply_markup: {
      inline_keyboard: [[
        { text: "⚠️ Confirm close", callback_data: `v4close:confirm:${tokenId}` },
        { text: "Cancel", callback_data: "v4close:cancel" },
      ]],
    },
  });
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
    const r = await closeV4Position(tokenId, "manual");
    await edit(
      mid,
      [
        `✅ <b>v4 #${tokenId} closed</b> · pool fee ${(r.fee / 10000).toFixed(2)}%`,
        `Reason: <b>${r.reason}</b>`,
        `Returned: ${r.recv0 > 0 ? `${r.recv0.toFixed(6)} ${r.sym0}` : ""}${r.recv0 > 0 && r.recv1 > 0 ? " + " : ""}${r.recv1 > 0 ? `${r.recv1.toFixed(6)} ${r.sym1}` : ""}`,
        r.feeEth > 0 ? `🧲 fee earned: <b>${r.feeEth.toFixed(6)}Ξ</b>` : "",
        r.sweptEth && r.sweptEth > 0
          ? `💱 proceeds → <b>+${r.sweptEth.toFixed(6)}Ξ</b> (auto-swapped to ETH)${r.sweepHash ? ` · <a href="${explorerTx(r.sweepHash)}">tx</a>` : ""}`
          : "",
        r.unwrap ? `🔓 Unwrapped ${r.unwrap.unwrapped.toFixed(5)} WETH → native ETH · <a href="${explorerTx(r.unwrap.tx)}">tx</a>` : "",
        r.forfeited ? `⚠️ <b>${esc(r.forfeited)}</b> could not be withdrawn (honeypot/rug) — abandoned while saving the ETH.` : "",
        `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const v4quote = /usdg|usd/i.test(r.pair) && !/\beth\b|weth/i.test(r.pair) ? ("usd" as const) : ("eth" as const);
    await sendCloseCard({ name: r.pair, version: "v4", quote: v4quote, depEth: r.depEth, outEth: r.outEth, feeEth: r.feeEth, pnlEth: r.pnlEth, pnlPct: r.pnlPct, reason: r.reason });
  } catch (e) {
    await edit(mid, `❌ v4 close failed: ${short(e, 160)}`);
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
        `✅ <b>Fees claimed · v4 #${tokenId}</b>`,
        got ? `Collected: ${got}` : `No fees available to claim.`,
        `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ].join("\n"),
    );
  } catch (e) {
    await edit(mid, `❌ Fee claim failed: ${short(e, 160)}`);
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
    const r = await closeV2Position(pair, { autoSwap: cfg.lp.v2Enabled && cfg.lp.autoSwapOnClose, reason: "manual" });
    await edit(
      mid,
      [
        `✅ <b>v2 ${esc(r.sym)}/WETH closed</b>`,
        `Reason: <b>${r.reason}</b>`,
        `Returned: <b>${r.recvEth.toFixed(6)} ETH</b>${r.soldToken ? " (token sold back)" : r.recvToken > 0 ? ` + ${r.recvToken.toPrecision(6)} ${esc(r.sym)}` : ""}`,
        r.pnlEth != null ? `PnL: ${r.pnlEth >= 0 ? "🟩 +" : "🟥 "}${r.pnlEth.toFixed(6)}Ξ` : "",
        `burn: <a href="${explorerTx(r.txHash)}">tx</a>${r.swapHash ? ` · sell: <a href="${explorerTx(r.swapHash)}">tx</a>` : ""}${r.unwrapHash ? ` · unwrap: <a href="${explorerTx(r.unwrapHash)}">tx</a>` : ""}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    await sendCloseCard({ name: `${r.sym}/WETH`, version: "v2", depEth: r.depEth, outEth: r.recvEth, pnlEth: r.pnlEth, reason: r.reason });
  } catch (e) {
    await edit(mid, `❌ v2 close failed: ${short(e, 160)}`);
  }
}

// ══════════ /auto (autonomous LP) ══════════

function autoSourceLabel(source: string): string {
  return source === "watch-spike" ? "Watch spikes" : source === "feed-new" ? "New tokens" : "Hunter candidates";
}

function autoPanelText(): string {
  const a = cfg.autoLp;
  const s = autoLpStatus();
  const armed = a.tpPct > 0 || a.slPct > 0 || a.closeOor;
  const sources = a.sources.length ? a.sources.map(autoSourceLabel).join(", ") : "None";
  return [
    `🤖 <b>Auto-LP control panel</b>`,
    `Status: <b>${a.enabled ? "🟢 ON" : "🔴 OFF"}</b>`,
    `<i>Auto-LP can use real funds when enabled.</i>`,
    ``,
    `Entry: <b>${a.sizeEth} ETH</b> · score ≥ <b>${a.minScore}</b> · ${a.mode === "single" ? "Safe single-side" : "In-range"}`,
    `Limits: <b>${a.maxOpen}</b> open · <b>${a.maxPerHour}</b>/hour · <b>${a.dailyCapEth} ETH</b>/day`,
    `Sources: <b>${sources}</b>`,
    `Exits: TP ${a.tpPct > 0 ? "+" + a.tpPct + "%" : "off"} · SL ${a.slPct > 0 ? "-" + a.slPct + "%" : "off"} · OOR ${a.closeOor ? "on" : "off"}`,
    `Today: ${s.opensToday} opened · ${s.spentToday.toFixed(4)} ETH deployed`,
    armed ? `⚠️ Auto-close is armed.` : `Auto-close is not armed.`,
  ].join("\n");
}

async function showAutoPanel(mid?: number): Promise<void> {
  const extra = { reply_markup: { inline_keyboard: autoPanelKeyboard(cfg.autoLp) } };
  if (mid != null) await edit(mid, autoPanelText(), extra);
  // Inline controls and the persistent bottom reply keyboard are separate Telegram
  // reply markups; using sendMenu here would replace the inline controls entirely.
  else await send(autoPanelText(), extra);
}

function autoSubmenu(title: string, lines: string[], rows: AutoPanelButton[]): { text: string; reply_markup: { inline_keyboard: AutoPanelButton[][] } } {
  return { text: [`🤖 <b>${title}</b>`, ...lines].join("\n"), reply_markup: { inline_keyboard: [...rows.map((r) => [r]), autoBackButton()] } };
}

export async function onAutoButton(data: string, mid: number): Promise<void> {
  // Any button navigation cancels a pending numeric prompt. Otherwise a later
  // number could unexpectedly be applied to an earlier custom setting.
  pendingAutoInput = null;
  pendingSettingsInput = null;
  const a = cfg.autoLp;
  if (data === "auto:refresh") return showAutoPanel(mid);
  if (data === "auto:enable:ask") {
    await edit(mid, "⚠️ <b>Enable Auto-LP?</b>\nThe bot may open LP positions using real funds when all configured gates pass.", {
      reply_markup: { inline_keyboard: [[{ text: "✅ Enable Auto-LP", callback_data: "auto:enable:yes" }], autoBackButton()] },
    });
    return;
  }
  if (data === "auto:enable:yes") {
    a.enabled = true;
    persist();
    const { startManage } = await import("../radar/automanage.js");
    startManage();
    return showAutoPanel(mid);
  }
  if (data === "auto:disable") {
    a.enabled = false;
    persist();
    const { stopManage } = await import("../radar/automanage.js");
    stopManage();
    return showAutoPanel(mid);
  }
  if (data === "auto:entry") {
    const rows: AutoPanelButton[] = [
      { text: `0.001 ETH${a.sizeEth === 0.001 ? " ✓" : ""}`, callback_data: "auto:size:0.001" },
      { text: `0.002 ETH${a.sizeEth === 0.002 ? " ✓" : ""}`, callback_data: "auto:size:0.002" },
      { text: `0.005 ETH${a.sizeEth === 0.005 ? " ✓" : ""}`, callback_data: "auto:size:0.005" },
      { text: "Custom size", callback_data: "auto:size:custom" },
      { text: `Score ≥ ${a.minScore}`, callback_data: "auto:score:custom" },
    ];
    const page = autoSubmenu("Entry settings", ["Choose how much each automatic LP entry may use."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "auto:limits") {
    const rows: AutoPanelButton[] = [
      { text: `1 position${a.maxOpen === 1 ? " ✓" : ""}`, callback_data: "auto:maxopen:1" },
      { text: `2 positions${a.maxOpen === 2 ? " ✓" : ""}`, callback_data: "auto:maxopen:2" },
      { text: `3 positions${a.maxOpen === 3 ? " ✓" : ""}`, callback_data: "auto:maxopen:3" },
      { text: "Custom max open", callback_data: "auto:maxopen:custom" },
      { text: `1/hour${a.maxPerHour === 1 ? " ✓" : ""}`, callback_data: "auto:maxhour:1" },
      { text: `2/hour${a.maxPerHour === 2 ? " ✓" : ""}`, callback_data: "auto:maxhour:2" },
      { text: "Custom hourly limit", callback_data: "auto:maxhour:custom" },
      { text: `0.001 ETH/day${a.dailyCapEth === 0.001 ? " ✓" : ""}`, callback_data: "auto:daily:0.001" },
      { text: `0.005 ETH/day${a.dailyCapEth === 0.005 ? " ✓" : ""}`, callback_data: "auto:daily:0.005" },
      { text: `0.01 ETH/day${a.dailyCapEth === 0.01 ? " ✓" : ""}`, callback_data: "auto:daily:0.01" },
      { text: "Custom daily limit", callback_data: "auto:daily:custom" },
    ];
    const page = autoSubmenu("Position limits", ["Set hard limits for automatic entries."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "auto:mode") {
    const rows: AutoPanelButton[] = [
      { text: `🛡 Safe single-side${a.mode === "single" ? " ✓" : ""}`, callback_data: "auto:mode:single" },
      { text: `⚡ In-range (more risk)${a.mode === "inrange" ? " ✓" : ""}`, callback_data: "auto:mode:inrange" },
    ];
    const page = autoSubmenu("Entry mode", ["Safe single-side parks the quote asset and reduces token exposure.", "In-range uses both sides immediately and carries more token/rug risk."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "auto:sources") {
    const sources = ["watch-spike", "hunt", "feed-new"] as const;
    const rows: AutoPanelButton[] = sources.map((source) => ({ text: `${a.sources.includes(source) ? "✅" : "⬜"} ${autoSourceLabel(source)}`, callback_data: `auto:source:${source}` }));
    const page = autoSubmenu("Candidate sources", ["Choose which scanners may trigger automatic LP entries.", "Turning one on also starts its scanner. Use /watch off, /hunt off, or /feed off to stop a scanner."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "auto:exits") {
    const rows: AutoPanelButton[] = [
      { text: `Take profit: ${a.tpPct > 0 ? "+" + a.tpPct + "%" : "off"}`, callback_data: "auto:exit:tp" },
      { text: `Stop loss: ${a.slPct > 0 ? "-" + a.slPct + "%" : "off"}`, callback_data: "auto:exit:sl" },
      { text: `Out of range: ${a.closeOor ? "close" : "leave open"}`, callback_data: "auto:exit:oor" },
      { text: "Advanced performance rules", callback_data: "auto:advanced" },
    ];
    const page = autoSubmenu("Exit rules", ["All exit rules are off by default."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "auto:exit:tp" || data === "auto:exit:sl") {
    const isTp = data.endsWith("tp");
    const kind = isTp ? "tp" : "sl";
    const rows = exitRuleKeyboard(kind, isTp ? a.tpPct : a.slPct).flat();
    const page = autoSubmenu(isTp ? "Take-profit" : "Stop-loss", [isTp ? "Close when the position reaches this profit." : "Close when the position reaches this loss."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "auto:exit:oor") {
    const rows: AutoPanelButton[] = [
      { text: `Leave positions open${!a.closeOor ? " ✓" : ""}`, callback_data: "auto:oor:0" },
      { text: `Close out-of-range${a.closeOor ? " ✓" : ""}`, callback_data: "auto:oor:1" },
    ];
    const page = autoSubmenu("Out-of-range rule", ["Single-side positions may be out of range by design."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "auto:advanced") {
    const rows: AutoPanelButton[] = [
      { text: `Compound fees: ${a.compound ? "on" : "off"}`, callback_data: "auto:compound:toggle" },
      { text: `Compound minimum: $${a.compoundMinUsd}`, callback_data: "auto:compound:min" },
      { text: `Volume fade: ${a.volFadeX > 0 ? a.volFadeX + "×" : "off"}`, callback_data: "auto:advanced:vol" },
      { text: `Fee-rate exit: ${a.minFeePerHourUsd > 0 ? "$" + a.minFeePerHourUsd + "/h" : "off"}`, callback_data: "auto:advanced:fee" },
    ];
    const page = autoSubmenu("Advanced exit rules", ["These rules can close positions when pool performance deteriorates."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "auto:compound:toggle") {
    a.compound = !a.compound;
    persist();
    return onAutoButton("auto:advanced", mid);
  }
  if (data === "auto:compound:min") {
    pendingAutoInput = "compoundMinUsd";
    await edit(mid, "Reply with the minimum uncollected fee amount in USD for compounding (for example: <code>0.50</code>).", { reply_markup: { inline_keyboard: [autoBackButton()] } });
    return;
  }
  if (data === "auto:advanced:vol") {
    const rows: AutoPanelButton[] = [
      { text: "Off", callback_data: "auto:vol:0" },
      { text: "0.35×", callback_data: "auto:vol:0.35" },
      { text: "0.50×", callback_data: "auto:vol:0.5" },
      { text: "0.75×", callback_data: "auto:vol:0.75" },
    ];
    const page = autoSubmenu("Volume-fade exit", ["Close when the current hourly volume falls below this share of its 24-hour average."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "auto:advanced:fee") {
    const rows: AutoPanelButton[] = [
      { text: "Off", callback_data: "auto:fee:0" },
      { text: "$5/hour", callback_data: "auto:fee:5" },
      { text: "$10/hour", callback_data: "auto:fee:10" },
      { text: "$25/hour", callback_data: "auto:fee:25" },
    ];
    const page = autoSubmenu("Fee-rate exit", ["Close an in-range position when recent fee earnings fall below the selected rate."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data.startsWith("auto:vol:")) {
    a.volFadeX = Number(data.slice("auto:vol:".length));
    persist();
    return onAutoButton("auto:advanced", mid);
  }
  if (data.startsWith("auto:fee:")) {
    a.minFeePerHourUsd = Number(data.slice("auto:fee:".length));
    persist();
    return onAutoButton("auto:advanced", mid);
  }
  if (data.startsWith("auto:size:") || data.startsWith("auto:score:") || data.startsWith("auto:maxopen:") || data.startsWith("auto:maxhour:") || data.startsWith("auto:daily:")) {
    const [_, kind, value] = data.split(":");
    if (value === "custom") {
      const input: Record<string, AutoInput> = { size: "sizeEth", score: "minScore", maxopen: "maxOpen", maxhour: "maxPerHour", daily: "dailyCapEth" };
      pendingAutoInput = input[kind];
      await edit(mid, `Reply with a custom value for <b>${kind === "size" ? "entry size in ETH" : kind === "daily" ? "daily ETH limit" : kind}</b>.`, { reply_markup: { inline_keyboard: [autoBackButton()] } });
      return;
    }
    const input: Record<string, AutoInput> = { size: "sizeEth", score: "minScore", maxopen: "maxOpen", maxhour: "maxPerHour", daily: "dailyCapEth" };
    const key = input[kind];
    if (!key) return;
    (a[key] as number) = Number(value);
    persist();
    return kind === "size" || kind === "score" ? onAutoButton("auto:entry", mid) : onAutoButton("auto:limits", mid);
  }
  if (data.startsWith("auto:mode:")) {
    a.mode = data.endsWith("inrange") ? "inrange" : "single";
    persist();
    return onAutoButton("auto:mode", mid);
  }
  if (data.startsWith("auto:source:")) {
    const source = data.slice("auto:source:".length) as "watch-spike" | "hunt" | "feed-new";
    const enabling = !a.sources.includes(source);
    a.sources = enabling ? [...a.sources, source] : a.sources.filter((x) => x !== source);

    if (enabling) {
      // Auto-LP source selection controls eligibility; starting the scanner is
      // required for that source to produce candidates in the first place.
      // Scanner shutdown remains explicit via /watch off, /hunt off, or /feed off.
      if (source === "watch-spike") {
        cfg.watch.enabled = true;
        startWatch();
      } else if (source === "hunt") {
        cfg.scan.enabled = true;
        const { startScan } = await import("../radar/scanLoop.js");
        startScan();
      } else {
        cfg.feed.enabled = true;
        cfg.feed.newToken = true;
        await startFeed();
      }

      // Watch and new-token candidates need the radar verdict when the
      // Auto-LP gate requires an LLM. Hunter already supplies its screen
      // verdict, but enabling radar here keeps the source menu predictable.
      if (a.requireLlm) cfg.radar.enabled = true;
    }

    persist();
    return onAutoButton("auto:sources", mid);
  }
  if (data.startsWith("auto:tp:") || data.startsWith("auto:sl:")) {
    const [_, kind, value] = data.split(":");
    if (value === "custom") {
      pendingAutoInput = kind === "tp" ? "tpPct" : "slPct";
      await edit(mid, `Reply with a custom ${kind === "tp" ? "take-profit" : "stop-loss"} percentage (for example: <code>${kind === "tp" ? "75" : "20"}</code>). Use <code>0</code> to turn it off.`, { reply_markup: { inline_keyboard: [autoBackButton()] } });
      return;
    }
    a[kind === "tp" ? "tpPct" : "slPct"] = Number(value);
    persist();
    return onAutoButton("auto:exits", mid);
  }
  if (data.startsWith("auto:oor:")) {
    a.closeOor = data.endsWith(":1");
    persist();
    return onAutoButton("auto:exits", mid);
  }
}

export async function onAutoInput(text: string): Promise<boolean> {
  if (!pendingAutoInput) return false;
  if (text.trim().startsWith("/")) {
    pendingAutoInput = null;
    return false;
  }
  const key = pendingAutoInput;
  pendingAutoInput = null;
  const n = Number(text.trim());
  const integer = key === "minScore" || key === "maxOpen" || key === "maxPerHour";
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n)) || (key === "sizeEth" && n <= 0)) {
    await send("That value is not valid. Open <code>/auto</code> and try again.");
    return true;
  }
  (cfg.autoLp[key] as number) = n;
  persist();
  await showAutoPanel();
  return true;
}

export async function onAuto(arg = ""): Promise<void> {
  const a = cfg.autoLp;
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const cmd = (parts[0] ?? "").toLowerCase();
  const { startManage, stopManage } = await import("../radar/automanage.js");

  if (!cmd) return showAutoPanel();

  if (cmd === "on") {
    a.enabled = true;
    persist();
    startManage();
    return showAutoPanel();
  }
  if (cmd === "off") {
    a.enabled = false;
    persist();
    stopManage();
    return showAutoPanel();
  }
  if (cmd === "tp" || cmd === "sl") {
    const v = parseFloat(parts[1] ?? "");
    if (!(v >= 0)) {
      await send(`Format: <code>/auto ${cmd} ${cmd === "tp" ? "100" : "50"}</code> (percent, 0 = off)`);
      return;
    }
    if (cmd === "tp") a.tpPct = v;
    else a.slPct = v;
    persist();
    await send(
      cmd === "tp"
        ? `🎯 Take-profit: ${v > 0 ? `auto-close positions at profit <b>≥ +${v}%</b>` : "OFF"}.${v > 0 && !a.enabled ? " (enable with: /auto on)" : ""}`
        : `🛑 Stop-loss: ${v > 0 ? `auto-close positions at loss <b>≤ -${v}%</b>` : "OFF"}.${v > 0 && !a.enabled ? " (enable with: /auto on)" : ""}`,
    );
    return;
  }
  if (cmd === "oor") {
    a.closeOor = /^(on|1|true|yes)$/i.test(parts[1] ?? "");
    persist();
    await send(`🚪 Auto-close out-of-range: <b>${a.closeOor ? "ON" : "OFF"}</b>.${a.closeOor && !a.enabled ? " (enable with: /auto on)" : ""}`);
    return;
  }

  const s = autoLpStatus();
  const armed = a.tpPct > 0 || a.slPct > 0 || a.closeOor;
  const T = [
    `${padR("status", 13)} ${a.enabled ? "🟢 ON" : "off"}`,
    `── auto-add ──`,
    `${padR("size", 13)} ${a.sizeEth}Ξ · ${a.mode}`,
    `${padR("trigger", 13)} ${a.requireAction} & score ≥ ${a.minScore}`,
    `${padR("source", 13)} ${a.sources.join(", ")}`,
    `${padR("cap", 13)} ${a.maxOpen} positions · ${a.maxPerHour}/h · ${a.dailyCapEth}Ξ/day`,
    `── auto-close ──`,
    `${padR("take-profit", 13)} ${a.tpPct > 0 ? "+" + a.tpPct + "%" : "off"}`,
    `${padR("stop-loss", 13)} ${a.slPct > 0 ? "-" + a.slPct + "%" : "off"}`,
    `${padR("close OOR", 13)} ${a.closeOor ? "on" : "off"}${a.closeOor && a.oorAction === "rebalance" ? " → ♻️ rebalance" : ""}`,
    `${padR("vol-fade", 13)} ${a.volFadeX > 0 ? `on (spike < ${a.volFadeX}× · age > ${a.vfadeMinAgeMin}m)` : "off"}`,
    `${padR("fee-velocity", 13)} ${a.minFeePerHourUsd > 0 ? `on (< $${a.minFeePerHourUsd}/h · age > ${a.feeGraceMin}m)` : "off"}`,
    `${padR("compound", 13)} ${a.compound ? `on (fee ≥ $${a.compoundMinUsd})` : "off"}`,
    `${padR("check every", 13)} ${a.manageSec}s`,
    ``,
    `${padR("today", 13)} ${s.opensToday} open · ${s.spentToday.toFixed(4)}Ξ`,
  ];
  await send(
    `🤖 <b>Auto (add + close)</b>${pre(T.join("\n"))}` +
      `<code>/auto on</code> · <code>/auto off</code>\n` +
      `Close: <code>/auto tp 100</code> · <code>/auto sl 50</code> · <code>/auto oor on|off</code>\n` +
      `Mode: <code>/set alpmode single</code> (rug-safe) · <code>/set alpmode inrange</code> (fees immediately)\n` +
      `♻️ OOR→recenter: <code>/set alprebalance rebalance</code> · 🔁 compound fee: <code>/set alpcompound 1</code> · <code>/set alpcompoundmin 0.5</code>\n` +
      `Add: <code>/set alpsize 0.001</code> · <code>/set alpscore 75</code> · <code>/set alpmaxopen 3</code>\n` +
      `<i>⚠️ Automatic transactions use real funds. ${armed ? "Auto-close ARMED." : "Auto-close is not configured."} Auto-add requires radar (/set radar 1).</i>`,
  );
}

// ══════════ close ══════════

export async function onCloseAsk(tokenId: string, mid: number): Promise<void> {
  await edit(mid, `Close #${tokenId} — what should happen to fees/tokens?\n<i>(LP principal is still returned as ETH)</i>`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Swap token → ETH (full ETH)", callback_data: `cs:${tokenId}` }],
        [{ text: "🪙 Keep token (WETH + token)", callback_data: `ck:${tokenId}` }],
      ],
    },
  });
}

export async function onClose(tokenId: string, mid: number, swapToken = true): Promise<void> {
  invalidateListCache();
  await edit(mid, `⏳ Closing #${tokenId}… ${swapToken ? "(swap token→ETH)" : "(keep token)"}`);
  try {
    const r = await closePosition(tokenId, { swapToken, reason: "manual" });
    const px = await ethUsd().catch(() => 0);
    const pnl =
      r.pnlEth != null
        ? `\n💰 <b>PnL ETH: ${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}Ξ</b> (${r.pnlPct! >= 0 ? "+" : ""}${r.pnlPct!.toFixed(1)}%)\n💵 <b>PnL USD: ${r.pnlEth >= 0 ? "+" : ""}$${px ? (r.pnlEth * px).toFixed(2) : "?"}</b>`
        : `\nPnL: — (deposit not recorded)`;
    await send(
      [
        `✅ <b>Closed #${tokenId}</b>${px ? ` · ETH $${px.toFixed(0)}` : ""}`,
        `Reason: <b>${r.reason}</b>`,
        r.heldMs != null ? `⏱ held for <b>${fmtAge(r.heldMs)}</b>` : "",
        `Withdrawn: ${r.recvWeth.toFixed(6)} ${r.wethSym}${r.recvToken > 0 ? ` + ${r.recvToken.toFixed(2)} ${r.tokenSym}` : ""}`,
        r.swappedWeth > 0
          ? `🔄 Swap ${r.tokenSym} → +${r.swappedWeth.toFixed(6)} WETH`
          : r.tokenStuck > 0
            ? swapToken
              ? `⚠️ ${r.tokenStuck.toFixed(2)} ${r.tokenSym} could not be sold (rug) — stranded`
              : `🪙 ${r.tokenStuck.toFixed(2)} ${r.tokenSym} kept (worth ~$${px ? ((r.valEth - r.recvWeth) * px).toFixed(2) : "?"})`
            : "",
        `Total returned: <b>${r.valEth.toFixed(6)}Ξ / $${px ? (r.valEth * px).toFixed(2) : "?"}</b>${r.depEth != null ? ` (deposit ${r.depEth.toFixed(6)}Ξ)` : ""}${pnl}`,
        r.topUp ? `🔓 Unwrapped ${r.topUp.unwrapped.toFixed(5)} WETH → native ETH (${r.topUp.nativeAfter.toFixed(4)}Ξ) · <a href="${explorerTx(r.topUp.tx)}">tx</a>` : "",
        r.collectHash ? `tx: <a href="${explorerTx(r.collectHash)}">collect</a>${r.swapHash ? ` · <a href="${explorerTx(r.swapHash)}">swap</a>` : ""}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const isUsdgClose = r.wethSym === "USDG";
    await sendCloseCard({ name: isUsdgClose ? `${r.tokenSym}/USDG` : `${r.tokenSym}/WETH`, version: "v3", quote: isUsdgClose ? "usd" : "eth", depEth: r.depEth, outEth: r.valEth, pnlEth: r.pnlEth, pnlPct: r.pnlPct, heldMs: r.heldMs, reason: r.reason });
  } catch (e) {
    await send(`❌ Close failed: ${short(e, 120)}`);
  }
}

export async function onCloseAllAsk(mid?: number): Promise<void> {
  let rows;
  try {
    rows = await listPositions();
  } catch (e) {
    await send(`❌ ${short(e, 80)}`);
    return;
  }
  const { listV4Positions } = await import("../chain/v4/list.js");
  let v4rows: Awaited<ReturnType<typeof listV4Positions>>;
  try {
    v4rows = await listV4Positions();
  } catch (e) {
    await send(`❌ Could not verify v4 positions, so Close ALL was not started: ${short(e, 100)}`);
    return;
  }
  const total = totalCloseAllPositions(rows.length, v4rows.length);
  if (!total) {
    await send("There are no open positions to close.");
    return;
  }
  const split = [rows.length ? `${rows.length} v3` : "", v4rows.length ? `${v4rows.length} v4` : ""].filter(Boolean).join(" + ");
  const text = `⚠️ <b>Close all ${total} open positions?</b>\n\n${split}\n\nThis withdraws liquidity and may swap token balances to ETH. This cannot be undone.`;
  if (mid != null) {
    await edit(mid, text, { reply_markup: { inline_keyboard: closeAllConfirmationKeyboard(total) } });
  } else {
    await send(text, { reply_markup: { inline_keyboard: closeAllConfirmationKeyboard(total) } });
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
  const { listV4Positions } = await import("../chain/v4/list.js");
  let v4rows: Awaited<ReturnType<typeof listV4Positions>>;
  try {
    v4rows = await listV4Positions();
  } catch (e) {
    await send(`❌ Could not verify v4 positions, so Close ALL was not started: ${short(e, 100)}`);
    return;
  }
  const total = totalCloseAllPositions(rows.length, v4rows.length);
  if (!total) {
    await send("There are no positions to close.");
    return;
  }
  const px = await ethUsd().catch(() => 0);
  await send(`🗑🗑 <b>Closing ${total} positions…</b> (one at a time)`);
  let totPnl = 0, ok = 0, fail = 0;
  for (const row of rows) {
    try {
      const r = await closePosition(row.tokenId, { reason: "manual" });
      if (r.pnlEth != null) totPnl += r.pnlEth;
      ok++;
      await send(
        `✅ #${row.tokenId} ${row.tokenSym} closed · reason ${r.reason} · PnL ${r.pnlEth != null ? `${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}Ξ${px ? ` (${r.pnlEth >= 0 ? "+" : ""}$${(r.pnlEth * px).toFixed(2)})` : ""}` : "—"}`,
      );
    } catch (e) {
      fail++;
      await send(`❌ #${row.tokenId} failed: ${short(e, 70)}`);
    }
  }
  for (const row of v4rows) {
    try {
      const { closeV4Position } = await import("../chain/v4/close.js");
      const r = await closeV4Position(row.tokenId, "manual");
      if (r.pnlEth != null) totPnl += r.pnlEth;
      ok++;
      await send(`✅ v4 #${row.tokenId} ${row.pair} closed · reason ${r.reason} · PnL ${r.pnlEth != null ? `${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}Ξ${px ? ` (${r.pnlEth >= 0 ? "+" : ""}$${(r.pnlEth * px).toFixed(2)})` : ""}` : "—"}`);
    } catch (e) {
      fail++;
      await send(`❌ v4 #${row.tokenId} failed: ${short(e, 70)}`);
    }
  }
  await send(
    [
      `🏁 <b>Close ALL complete</b> — ${ok} succeeded${fail ? `, ${fail} failed` : ""}`,
      `💰 Total PnL ETH: <b>${totPnl >= 0 ? "+" : ""}${totPnl.toFixed(6)}Ξ</b>`,
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
    await send("🔄 Swap requires KyberSwap — <code>KYBERSWAP_ROUTER_ADDRESS</code> is not set in .env.");
    return;
  }
  return text.trim().split(/\s+/).length >= 4 ? onSwapManual(text) : onSwapMenu();
}

/** Auto-detect sellable tokens in the wallet → tap one → tap a %, no CA/amount typing. */
async function onSwapMenu(): Promise<void> {
  const m = await send("🔄 <b>Scanning wallet tokens…</b> <i>(checking a sell route for each token, may take ~10-20s)</i>");
  const mid = m?.result?.message_id;
  swapFrom = null;
  const toks = await walletTokens().catch(() => [] as WalletToken[]);
  swapTokens = toks;
  if (!toks.length) {
    await edit(
      mid,
      [
        "🔄 <b>Swap</b>",
        "No sellable tokens detected in the wallet.",
        "",
        "Buy / manual: <code>/swap &lt;amount&gt; &lt;from&gt; &lt;to&gt;</code> (from/to = <b>eth</b> or CA).",
      ].join("\n"),
    );
    return;
  }
  const rows = toks.map((t) => [{ text: `${tokenEmoji(t.symbol)} ${t.symbol} · ${fmtAmt(t.ui)} ($${t.usd.toFixed(2)})`, callback_data: `swf:${t.addr}` }]);
  await edit(mid, [`🔄 <b>Swap → ETH</b>`, `Choose a token to sell (${toks.length} detected):`].join("\n"), {
    reply_markup: { inline_keyboard: rows },
  });
}

/** Token picked (swf:<addr>) → show the 10-100% amount buttons (DEX-style). */
export async function onSwapFrom(addr: string, mid: number): Promise<void> {
  const t = swapTokens.find((x) => x.addr.toLowerCase() === addr.toLowerCase());
  if (!t) {
    await edit(mid, "Token is no longer available — send /swap again.");
    return;
  }
  swapFrom = t;
  await edit(
    mid,
    [
      `🔄 <b>Sell ${tokenEmoji(t.symbol)} ${esc(t.symbol)} → ETH</b>`,
      `Balance: <b>${fmtAmt(t.ui)}</b> ($${t.usd.toFixed(2)}) · sell all ≈ ${t.ethOut.toPrecision(4)} ETH`,
      ``,
      `What percentage would you like to sell?`,
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
            { text: "🔙 Another token", callback_data: "swap" },
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
    await edit(mid, "Choose a token first — send /swap again.");
    return;
  }
  const t = swapFrom;
  // read the LIVE balance (wallet is shared with the arb bot + Blockscout can lag) so 100% never
  // tries to sell more than we actually hold, and the % is always of the real current balance.
  const liveRaw = await tokenBalanceRaw(t.addr).catch(() => t.raw);
  const bal = liveRaw > 0n ? liveRaw : t.raw;
  const amountIn = pct >= 100 ? bal : (bal * BigInt(pct)) / 100n;
  if (amountIn <= 0n) {
    await edit(mid, "The token balance is now 0 — it may already be sold or spent. Send /swap again.");
    return;
  }
  const { kyberRoute, routeBreakdown, KYBER_NATIVE } = await import("../chain/kyber.js");
  await edit(mid, `🔄 Finding a route for ${pct}% ${esc(t.symbol)} → ETH…`);
  const route = await kyberRoute(t.addr, KYBER_NATIVE, amountIn).catch(() => null);
  if (!route) {
    await edit(mid, "❌ Kyber found no route (is liquidity too thin?).");
    return;
  }
  const outUi = Number(ethers.formatEther(BigInt(route.routeSummary.amountOut)));
  const px = await ethUsd().catch(() => 0);
  const amtUi = Number(ethers.formatUnits(amountIn, t.decimals));
  pendingSwap = { fromAddr: t.addr, toAddr: KYBER_NATIVE, amountIn, fromSym: t.symbol, toSym: "ETH", toDec: 18 };
  await edit(
    mid,
    [
      `🔄 <b>Sell ${pct}% ${esc(t.symbol)}</b> = ${fmtAmt(amtUi)} ${esc(t.symbol)}`,
      `→ ~<b>${outUi.toPrecision(6)} ETH</b>${px ? ` <i>($${(outUi * px).toFixed(2)})</i>` : ""}`,
      `route: <i>${esc(routeBreakdown(route.routeSummary) || "kyber")}</i> · slippage ${cfg.lp.slippagePct}% · bot fee 0 · pool/network costs may apply`,
    ].join("\n"),
    { reply_markup: { inline_keyboard: [[{ text: "✅ Swap", callback_data: "swapdo" }, { text: "❌ Cancel", callback_data: "cancel" }]] } },
  );
}

/** Manual power-user form: /swap <amount> <from> <to>  (eth or 0x… contract, any direction). */
async function onSwapManual(text: string): Promise<void> {
  const { kyberRoute, routeBreakdown, KYBER_NATIVE } = await import("../chain/kyber.js");
  const parts = text.trim().split(/\s+/);
  const [, amtStr, fromS, toS] = parts as [string, string, string, string];
  const resolve = (s: string) => (/^eth$/i.test(s) ? KYBER_NATIVE : /^0x[0-9a-fA-F]{40}$/.test(s) ? ethers.getAddress(s) : null);
  const fromAddr = resolve(fromS);
  const toAddr = resolve(toS);
  if (!fromAddr || !toAddr) {
  await send("From/to must be <b>eth</b> or a contract address (0x… 40 hex).");
    return;
  }
  if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
  await send("From and to are the same — nothing to swap.");
    return;
  }
  if (!(parseFloat(amtStr) > 0)) {
  await send("Invalid amount, for example: <code>0.01</code>");
    return;
  }
  const nativeIn = fromAddr.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const nativeOut = toAddr.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const fromMeta = nativeIn ? { decimals: 18, symbol: "ETH" } : await tokenMeta(fromAddr).catch(() => ({ decimals: 18, symbol: "?" }));
  const toMeta = nativeOut ? { decimals: 18, symbol: "ETH" } : await tokenMeta(toAddr).catch(() => ({ decimals: 18, symbol: "?" }));
  let amountIn: bigint;
  try {
    amountIn = ethers.parseUnits(amtStr, fromMeta.decimals);
  } catch {
  await send("Invalid amount format.");
    return;
  }

  const m = await send("🔄 Finding a Kyber route…");
  const mid = m?.result?.message_id;
  const route = await kyberRoute(fromAddr, toAddr, amountIn).catch(() => null);
  if (!route) {
    await edit(mid, "❌ Kyber found no route for this pair (is liquidity too thin?).");
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
      `route: <i>${esc(routeBreakdown(route.routeSummary) || "kyber")}</i> · slippage ${cfg.lp.slippagePct}% · bot fee 0 · pool/network costs may apply`,
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
    await edit(mid, "❌ Swap failed / output was 0.");
      return;
    }
    await edit(
      mid,
      `✅ <b>Swap successful</b> → +${Number(ethers.formatUnits(r.amountOut, s.toDec)).toPrecision(6)} ${esc(s.toSym)}\ntx: <a href="${explorerTx(r.tx)}">tx</a>`,
    );
  } catch (e) {
    await edit(mid, `❌ Swap failed: ${short(e, 150)}`);
  }
}

// ══════════ 🎯 candidate hunter ══════════

/** /hunt [on|off|now] — the quality-candidate scanner (fee 3-5% + active trading + screening). */
export async function onHunt(arg?: string): Promise<void> {
  const { startScan, stopScan, scanStatus, scanNow } = await import("../radar/scanLoop.js");
  const a = (arg ?? "").toLowerCase();
  if (a === "on") {
    cfg.scan.enabled = true;
    persist();
    startScan();
    await send(`🎯 <b>Hunter ON</b> — scan LP candidates every ${cfg.scan.intervalMin} minutes (3-5% fee + active trading + passed screening).`);
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
    const m = await send("🎯 Scanning candidates now… <i>(GMGN trending + screening, may take ~15-30s)</i>");
    const mid = m?.result?.message_id;
    try {
      const r = await scanNow();
      await edit(mid, `🎯 Scan complete — <b>${r.scanned}</b> trending → <b>${r.found} candidates</b> passed (3-5% fee + activity + screening).${r.found ? " Alert sent ↑" : " None passed right now."}`);
    } catch (e) {
      await edit(mid, `❌ Scan failed: ${short(e, 100)}`);
    }
    return;
  }
  const st = scanStatus();
  await send(
    [
      `🎯 <b>LP Candidate Hunter</b> — ${st.on ? "🟢 ON" : "🔴 OFF"}`,
      `Criteria: <b>v4 fee ${(st.feeMinPpm / 10000).toFixed(0)}-${(st.feeMaxPpm / 10000).toFixed(0)}%</b> pool · vol ≥ $${(st.minVolUsd / 1000).toFixed(0)}k · score ≥ ${st.minScore}`,
      `Interval ${st.intervalMin} minutes · cooldown ${st.cooldownMin} minutes`,
      st.scans > 0
        ? `Last scan: ${st.lastScanned} trending → <b>${st.lastFound}</b> candidates · ${st.alerts} total alerts`
        : `No scans yet.`,
      ``,
      `<code>/hunt on</code> · <code>/hunt off</code> · <code>/hunt now</code>`,
    ].join("\n"),
  );
}

// ══════════ 📸 profit card ══════════

/** Generate + send the whole-portfolio profit card (Meteora-style flex graphic). */
export async function onCard(): Promise<void> {
  const m = await send("📸 Creating profit card…");
  const mid = m?.result?.message_id;
  try {
    const { renderCard, portfolioCardData } = await import("./card.js");
    const png = await renderCard(await portfolioCardData());
    await sendPhoto(png, "📊 <b>Profit Robinhood LP Bot</b> — share it 🚀");
    if (mid) await edit(mid, "📸 Profit card ↑");
  } catch (e) {
    if (mid) await edit(mid, `❌ Failed to create card: ${short(e, 100)}`);
  }
}

/** Save a photo the owner sent as the profit-card background (assets/card-bg.jpg). */
export async function onSetBg(fileId: string): Promise<void> {
  const m = await send("🖼 Saving card background…");
  const mid = m?.result?.message_id;
  try {
    const buf = await downloadTgFile(fileId);
    if (!buf) {
      if (mid) await edit(mid, "❌ Failed to download the image from Telegram.");
      return;
    }
    mkdirSync("assets", { recursive: true });
    writeFileSync("assets/card-bg.jpg", buf);
      if (mid) await edit(mid, "✅ Card background updated. Here is the preview 👇");
    const { renderCard, portfolioCardData } = await import("./card.js");
    const png = await renderCard(await portfolioCardData());
    await sendPhoto(png, "🎴 New background applied — use <b>/card</b> any time to share.");
  } catch (e) {
    if (mid) await edit(mid, `❌ Failed to set background: ${short(e, 100)}`);
  }
}

/** Print a profit card for an ALREADY-closed position (from a ledger entry, by tokenId). */
export async function onCardFor(tokenId: string): Promise<void> {
  const e = readLedger().find((x) => x.tokenId === tokenId);
  if (!e) {
    await send("❌ Position not found in the ledger.");
    return;
  }
  const m = await send("📸 Creating position card…");
  const mid = m?.result?.message_id;
  try {
    const { renderCard, closeCardData } = await import("./card.js");
    const png = await renderCard(
      await closeCardData({
        name: e.pair ?? `${e.sym}/WETH`,
        version: (e.version ?? "v3") as "v2" | "v3" | "v4",
        quote: e.quote,
        depEth: e.depEth ?? null,
        outEth: e.outEth ?? 0,
        pnlEth: e.pnlEth,
        pnlPct: e.pnlPct,
        feeEth: e.feeEth,
        heldMs: e.heldMs,
        ethUsd: e.ethUsdAtClose ?? undefined,
        reason: e.reason,
      }),
    );
    await sendPhoto(png, `🎴 <b>${esc(e.pair ?? `${e.sym}/WETH`)}</b> — share it 🚀`);
    if (mid) await edit(mid, "📸 Card ↑");
  } catch (err) {
    if (mid) await edit(mid, `❌ Failed to create card: ${short(err, 100)}`);
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
  reason?: string;
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
  await send("📋 Preparing daily briefing… (LLM analysis may take ~1 minute)");
  const { runBriefing } = await import("./briefing.js");
  await runBriefing("manual");
}

export async function onPnl(): Promise<void> {
  await send("📊 Calculating lifetime PnL… (history + rug scan, ~20 seconds)");
  let r;
  try {
    // overall safety-net timeout so /pnl can't hang forever if Blockscout/RPC is slow (the per-token
    // quote timeout in analytics.ts handles the usual culprit; this bounds the total scan).
    r = await Promise.race([
      lifetimePnl(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("scan &gt; 45s — Blockscout/RPC is slow, try again")), 45_000)),
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
  T.push(`LP REALIZED · ${sum.count} closed`);
  T.push("─".repeat(31));
  T.push(row("PnL", sg(sum.pnlEth, 5) + "Ξ", money(sum.pnlUsd)));
  T.push(row("win rate", winRateText(sum.wins, sum.count)));
  T.push(row("fee", sum.feeEth.toFixed(5) + "Ξ"));
  T.push("");
  T.push(`WALLET FLOWS (+arb) · ${r.historySource}`);
  T.push("─".repeat(31));
  T.push(row("in", r.capIn.toFixed(5) + "Ξ", $(r.capIn)));
  T.push(row("out", r.capOut.toFixed(5) + "Ξ", $(r.capOut)));
  T.push(row("value", r.valueNowEth.toFixed(5) + "Ξ", $(r.valueNowEth)));
  T.push(`  native ${r.nativeEth.toFixed(4)}  WETH ${r.wethHeld.toFixed(4)}`);
  T.push(`  LP ${r.openLpEth.toFixed(4)}Ξ  token $${r.tokensUsd.toFixed(2)}`);
  T.push(row("net", sg(r.pnlEth, 5) + "Ξ", money(r.pnlUsd)));

  const grave = r.graveyardCount
    ? `\n🪦 <b>${r.graveyardCount} stranded tokens</b> <i>(rug/thin liquidity)</i>\n${pre(r.graveyard.join(", ") + (r.graveyardCount > r.graveyard.length ? " …" : ""))}`
    : "";
  await sendMenu(
      `📊 <b>LIFETIME PNL</b>${px ? ` · ETH $${px.toFixed(0)}` : ""}\n` +
      pre(T.join("\n")) +
      `<i>⚠️ Net wallet mixes arb flow — LP figures are accurate as "LP realized".</i>` +
      grave,
  );
}

export async function onSell(): Promise<void> {
  await send("🔄 <b>Selling all stranded tokens → ETH…</b>\n(skipping rugs/illiquid pools)");
  try {
    const r = await sellAllTokens((msg) => {
      void send(msg).catch(() => {});
    });
    await sendMenu(
      [
        `🏁 <b>Sales complete</b> — ${r.sold} tokens → ETH${r.skipped ? `, ${r.skipped} skipped (rug)` : ""}`,
        `💰 Total received: <b>+${r.soldEth.toFixed(6)} WETH ($${r.soldUsd.toFixed(2)})</b>`,
      ].join("\n"),
    );
  } catch (e) {
  await send(`❌ ${short(e, 90)}`);
  }
}

export async function onWallet(): Promise<void> {
  try {
    const b = await balances();
    await send(
      walletBalanceText(b),
      { reply_markup: { inline_keyboard: walletKeyboard() } },
    );
  } catch (e) {
    await send(`❌ ${short(e, 80)}`);
  }
}

export async function onUnwrapAsk(mid: number): Promise<void> {
  try {
    const b = await balances();
    const weth = Number(b.weth);
    if (!(weth > 0)) {
      await edit(mid, `✅ No WETH is currently held by the bot wallet.`);
      return;
    }
    await edit(mid, `⚠️ <b>Unwrap all wallet WETH?</b>\n\nThis will convert <b>${weth.toFixed(6)} WETH</b> to native ETH and submit a real on-chain transaction.`, {
      reply_markup: { inline_keyboard: unwrapConfirmationKeyboard() },
    });
  } catch (e) {
    await edit(mid, `❌ Could not read wallet balance: ${short(e, 90)}`);
  }
}

export async function onUnwrapConfirm(mid: number): Promise<void> {
  if (!acquireWallet()) {
    await edit(mid, "⏳ Another wallet transaction is in progress. Try again when it finishes.");
    return;
  }
  try {
    await edit(mid, "⏳ Unwrapping all WETH → native ETH…");
    const r = await unwrapAllWeth();
    if (!r) {
      await edit(mid, "✅ No WETH was available to unwrap.");
      return;
    }
    await edit(mid, `✅ Unwrapped <b>${r.unwrapped.toFixed(6)} WETH</b> → native ETH\nETH after: <b>${r.nativeAfter.toFixed(6)}</b>\n<a href="${explorerTx(r.tx)}">View unwrap transaction</a>`);
    const b = await balances();
    await send(walletBalanceText(b, false), { reply_markup: { inline_keyboard: walletKeyboard() } });
  } catch (e) {
    await edit(mid, `❌ WETH unwrap failed: ${short(e, 120)}`);
  } finally {
    releaseWallet();
  }
}

export async function onUnwrapCancel(mid: number): Promise<void> {
  await edit(mid, "✅ Unwrap cancelled. Your WETH remains in the wallet.");
}

function settingsText(): string {
  return [
    `⚙️ <b>Settings control panel</b>`,
    ``,
    `LP: width <b>${cfg.lp.widthPct}%</b> · slippage <b>${cfg.lp.slippagePct}%</b> · fee floor <b>${(cfg.lp.minFeePpm / 10000).toFixed(2)}%</b>`,
    `Gas target: <b>${cfg.lp.nativeTargetEth} ETH</b> · auto-wrap <b>${cfg.lp.autoWrap ? "on" : "off"}</b>`,
    `Radar: <b>${cfg.radar.enabled ? "on" : "off"}</b> · GMGN <b>${cfg.radar.useGmgn ? "on" : "off"}</b>`,
    `Feed: <b>${cfg.feed.enabled ? "on" : "off"}</b> · Auto-LP: <b>${cfg.autoLp.enabled ? "on" : "off"}</b>`,
    `Fast submit: <b>${env.fastSubmit ? "on" : "off"}</b>`,
    ``,
    `<i>Use the buttons below. Technical /set commands remain available as advanced shortcuts.</i>`,
  ].join("\n");
}

async function showSettingsPanel(mid?: number): Promise<void> {
  const extra = { reply_markup: { inline_keyboard: settingsPanelKeyboard() } };
  if (mid != null) await edit(mid, settingsText(), extra);
  // Keep the inline settings controls on this message; the persistent bottom menu
  // remains available from the earlier /start response.
  else await send(settingsText(), extra);
}

function settingsSubmenu(title: string, lines: string[], rows: SettingsButton[]): { text: string; reply_markup: { inline_keyboard: SettingsButton[][] } } {
  return { text: [`⚙️ <b>${title}</b>`, ...lines].join("\n"), reply_markup: { inline_keyboard: [...rows.map((r) => [r]), [{ text: "◀️ Back to Settings", callback_data: "settings:refresh" }]] } };
}

export async function onSettingsButton(data: string, mid: number): Promise<void> {
  // Any button navigation cancels a pending numeric prompt. Otherwise a later
  // number could unexpectedly be applied to an earlier custom setting.
  pendingAutoInput = null;
  pendingSettingsInput = null;
  if (data === "settings:refresh") return showSettingsPanel(mid);
  if (data === "settings:auto") return onAutoButton("auto:refresh", mid);
  if (data === "settings:lp") {
    const rows: SettingsButton[] = [
      { text: `Width: ${cfg.lp.widthPct}%`, callback_data: "settings:width" },
      { text: `Slippage: ${cfg.lp.slippagePct}%`, callback_data: "settings:slippage" },
      { text: `Fee floor: ${(cfg.lp.minFeePpm / 10000).toFixed(2)}%`, callback_data: "settings:fee" },
      { text: `Auto-wrap: ${cfg.lp.autoWrap ? "on" : "off"}`, callback_data: "settings:toggle:wrap" },
    ];
    const page = settingsSubmenu("LP settings", ["Configure range width, swap tolerance, fee preference, and WETH wrapping."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "settings:width" || data === "settings:slippage" || data === "settings:fee" || data === "settings:gas") {
    const isWidth = data === "settings:width";
    const isSlippage = data === "settings:slippage";
    const values = isWidth ? [25, 50, 100] : isSlippage ? [1, 3, 5, 10] : data === "settings:fee" ? [0, 0.3, 1, 3, 5] : [0.005, 0.01, 0.015, 0.03];
    const current = isWidth ? cfg.lp.widthPct : isSlippage ? cfg.lp.slippagePct : data === "settings:fee" ? cfg.lp.minFeePpm / 10000 : cfg.lp.nativeTargetEth;
    const rows: SettingsButton[] = values.map((v) => ({
      text: `${v}${data === "settings:gas" ? " ETH" : "%"}${v === current ? " ✓" : ""}`,
      callback_data: `settings:set:${data.slice("settings:".length)}:${v}`,
    }));
    rows.push({ text: "Custom value", callback_data: `settings:custom:${isWidth ? "widthPct" : isSlippage ? "slippagePct" : data === "settings:fee" ? "minFeePpm" : "nativeTargetEth"}` });
    const title = isWidth ? "LP width" : isSlippage ? "Swap slippage" : data === "settings:fee" ? "LP fee floor" : "Gas target";
    const page = settingsSubmenu(title, [isWidth ? "Wider ranges stay active longer but earn less concentrated fees." : isSlippage ? "Higher slippage is more tolerant but increases execution risk." : data === "settings:fee" ? "Pools below this fee tier will not be preferred for LP." : "Keep this much native ETH available for future gas."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "settings:radar") {
    const rows: SettingsButton[] = [
      { text: `LLM radar: ${cfg.radar.enabled ? "on" : "off"}`, callback_data: "settings:toggle:radar" },
      { text: `GMGN enrichment: ${cfg.radar.useGmgn ? "on" : "off"}`, callback_data: "settings:toggle:gmgn" },
    ];
    const page = settingsSubmenu("Radar & GMGN", ["Radar adds LLM scoring; GMGN adds market and safety data."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "settings:feed") {
    const rows: SettingsButton[] = [
      { text: `Sequencer feed: ${cfg.feed.enabled ? "on" : "off"}`, callback_data: "settings:toggle:feed" },
      { text: `New-token alerts: ${cfg.feed.newToken ? "on" : "off"}`, callback_data: "settings:toggle:newtoken" },
      { text: `Position monitor: ${cfg.feed.positionMonitor ? "on" : "off"}`, callback_data: "settings:toggle:posmon" },
      { text: `Feed auto-close OOR: ${cfg.feed.autoCloseOutOfRange ? "on" : "off"}`, callback_data: "settings:toggle:feedoor" },
    ];
    const page = settingsSubmenu("Feed settings", ["The sequencer feed is optional and advanced."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "settings:hunt") {
    const rows: SettingsButton[] = [
      { text: `Scan interval: ${cfg.scan.intervalMin} minutes`, callback_data: "settings:hunt:interval" },
      { text: `Minimum score: ${cfg.scan.minScore}`, callback_data: "settings:hunt:score" },
      { text: `Minimum pool volume: $${cfg.scan.minVolUsd}`, callback_data: "settings:hunt:volume" },
      { text: `Alert cooldown: ${cfg.scan.cooldownMin} minutes`, callback_data: "settings:hunt:cooldown" },
    ];
    const page = settingsSubmenu("Hunter settings", ["Hunter searches GMGN, screens candidates, and checks for active 3–5% pools."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data === "settings:watch") {
    const rows: SettingsButton[] = [
      { text: `Watch scanner: ${cfg.watch.enabled ? "on" : "off"}`, callback_data: "settings:toggle:watch" },
      { text: `Scan interval: ${cfg.watch.intervalSec}s`, callback_data: "settings:watch:interval" },
      { text: `Rise threshold: ${cfg.watch.riseFactor}×`, callback_data: "settings:watch:rise" },
      { text: `Minimum liquidity: $${cfg.watch.minLiqUsd}`, callback_data: "settings:watch:liq" },
    ];
    const page = settingsSubmenu("Watch settings", ["Watch detects rising volume and can send candidate alerts."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data.startsWith("settings:hunt:")) {
    const kind = data.slice("settings:hunt:".length);
    const values: Record<string, number[]> = {
      interval: [3, 5, 10],
      score: [55, 65, 75],
      volume: [10000, 25000, 50000],
      cooldown: [60, 120, 240],
    };
    const current: Record<string, number> = { interval: cfg.scan.intervalMin, score: cfg.scan.minScore, volume: cfg.scan.minVolUsd, cooldown: cfg.scan.cooldownMin };
    if (!values[kind]) return;
    const rows = values[kind].map((v) => ({ text: `${kind === "volume" ? "$" + v : kind === "cooldown" ? v + " minutes" : kind === "interval" ? v + " minutes" : "score " + v}${v === current[kind] ? " ✓" : ""}`, callback_data: `settings:huntset:${kind}:${v}` }));
    const page = settingsSubmenu("Hunter setting", ["Choose a preset value."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data.startsWith("settings:watch:")) {
    const kind = data.slice("settings:watch:".length);
    const values: Record<string, number[]> = { interval: [120, 300, 600], rise: [1.2, 1.4, 2], liq: [25000, 50000, 100000] };
    const current: Record<string, number> = { interval: cfg.watch.intervalSec, rise: cfg.watch.riseFactor, liq: cfg.watch.minLiqUsd };
    if (!values[kind]) return;
    const rows = values[kind].map((v) => ({ text: `${kind === "liq" ? "$" + v : kind === "interval" ? v + " seconds" : v + "× rise"}${v === current[kind] ? " ✓" : ""}`, callback_data: `settings:watchset:${kind}:${v}` }));
    const page = settingsSubmenu("Watch setting", ["Choose a preset value."], rows);
    await edit(mid, page.text, { reply_markup: page.reply_markup });
    return;
  }
  if (data.startsWith("settings:toggle:")) {
    const key = data.slice("settings:toggle:".length);
    if (key === "wrap") cfg.lp.autoWrap = !cfg.lp.autoWrap;
    else if (key === "radar") cfg.radar.enabled = !cfg.radar.enabled;
    else if (key === "gmgn") cfg.radar.useGmgn = !cfg.radar.useGmgn;
    else if (key === "feed") cfg.feed.enabled = !cfg.feed.enabled;
    else if (key === "newtoken") cfg.feed.newToken = !cfg.feed.newToken;
    else if (key === "posmon") cfg.feed.positionMonitor = !cfg.feed.positionMonitor;
    else if (key === "feedoor") cfg.feed.autoCloseOutOfRange = !cfg.feed.autoCloseOutOfRange;
    else if (key === "watch") {
      cfg.watch.enabled = !cfg.watch.enabled;
      if (cfg.watch.enabled) startWatch();
      else stopWatch();
    }
    if (key === "feed") {
      if (cfg.feed.enabled) void startFeed();
      else stopFeed();
    }
    persist();
    return showSettingsPanel(mid);
  }
  if (data.startsWith("settings:set:")) {
    const parts = data.split(":");
    const kind = parts[2];
    const value = Number(parts[3]);
    if (kind === "width") cfg.lp.widthPct = value;
    else if (kind === "slippage") cfg.lp.slippagePct = value;
    else if (kind === "fee") cfg.lp.minFeePpm = Math.round(value * 10000);
    else if (kind === "gas") cfg.lp.nativeTargetEth = value;
    else return;
    persist();
    return showSettingsPanel(mid);
  }
  if (data.startsWith("settings:huntset:")) {
    const [, , kind, raw] = data.split(":");
    const value = Number(raw);
    if (kind === "interval") cfg.scan.intervalMin = value;
    else if (kind === "score") cfg.scan.minScore = value;
    else if (kind === "volume") cfg.scan.minVolUsd = value;
    else if (kind === "cooldown") cfg.scan.cooldownMin = value;
    else return;
    persist();
    return onSettingsButton("settings:hunt", mid);
  }
  if (data.startsWith("settings:watchset:")) {
    const [, , kind, raw] = data.split(":");
    const value = Number(raw);
    if (kind === "interval") cfg.watch.intervalSec = value;
    else if (kind === "rise") cfg.watch.riseFactor = value;
    else if (kind === "liq") cfg.watch.minLiqUsd = value;
    else return;
    persist();
    restartWatch();
    return onSettingsButton("settings:watch", mid);
  }
  if (data.startsWith("settings:custom:")) {
    pendingSettingsInput = data.slice("settings:custom:".length) as SettingsInput;
    await edit(mid, "Reply with the custom value. Width/slippage/fee use percent; gas target uses ETH.", { reply_markup: { inline_keyboard: [[{ text: "◀️ Back to Settings", callback_data: "settings:refresh" }]] } });
    return;
  }
}

export async function onSettingsInput(text: string): Promise<boolean> {
  if (!pendingSettingsInput) return false;
  if (text.trim().startsWith("/")) {
    pendingSettingsInput = null;
    return false;
  }
  const key = pendingSettingsInput;
  pendingSettingsInput = null;
  const n = Number(text.trim());
  if (!Number.isFinite(n) || n < 0 || (key === "widthPct" && n <= 0) || (key === "slippagePct" && n > 50)) {
    await send("That value is not valid. Open <code>/settings</code> and try again.");
    return true;
  }
  if (key === "widthPct") cfg.lp.widthPct = n;
  else if (key === "slippagePct") cfg.lp.slippagePct = n;
  else if (key === "minFeePpm") cfg.lp.minFeePpm = Math.round(n * 10000);
  else cfg.lp.nativeTargetEth = n;
  persist();
  await showSettingsPanel();
  return true;
}

export async function onSettings(): Promise<void> {
  await showSettingsPanel();
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
  huntcooldown: "cooldownMin", // minutes before an alerted token may appear again (smaller = faster rotation)
};
const SET_HELP =
  "LP: width, deposit, slippage, gastarget\nWatch: vol5m, vol1h, rise, liq, tax, cooldown, interval\nFeed: minseed, activity, feedcooldown · toggle: newtoken/posmon/autoclose (0/1)\nRadar: radar/gmgn (0/1)\nHunt: huntvol, huntfees, huntyield, huntscore, huntmcapmin, huntmcapmax, huntpoolliq, huntmaxratio, huntspike, huntcooldown\nAuto-LP: alpsize, alpscore, alpmaxopen, alpperhour, alpdaily, alpminliq, alpmaxtax, alpgrace, alpoorcount, alpoorhours, alpcompoundmin, alpvolfade, alpvfadeage, alpminfeeh, alpfeegrace · alpmode single|inrange · alpclose 0/1 · alprebalance close|rebalance · alpcompound 0/1";

export async function onSet(text: string): Promise<void> {
  const [, k, v] = text.split(/\s+/);
  // ── enum / string auto-LP settings (handled BEFORE the numeric guard below) ──
  if (k === "alpmode") {
    if (v !== "single" && v !== "inrange") {
      await send("Choose: <code>/set alpmode single</code> (rug-safe, park quote) or <code>/set alpmode inrange</code> (both-sided, fees immediately).");
      return;
    }
    cfg.autoLp.mode = v;
    persist();
    await send(
      `✓ autoLp.mode → <b>${v}</b> ${v === "inrange" ? "(both-sided — fees immediately, but you hold the token → rug risk)" : "(single-side — quote asset parked, rug-safe)"}`,
    );
    return;
  }
  if (k === "alpclose") {
    if (v !== "0" && v !== "1") {
      await send("Toggle: <code>/set alpclose 1</code> (close OOR) / <code>/set alpclose 0</code> (leave positions open)");
      return;
    }
    cfg.autoLp.closeOor = v === "1";
    persist();
    await send(`✓ autoLp.closeOor → ${v === "1" ? "on (close OOR positions)" : "off (leave OOR positions open)"}`);
    return;
  }
  if (k === "alprebalance" || k === "alprebal") {
    if (v !== "close" && v !== "rebalance") {
      await send(
        "Choose: <code>/set alprebalance rebalance</code> (recenter OOR positions at the new price) or <code>/set alprebalance close</code> (default — close to ETH).\n<i>requires /set alpclose 1</i>",
      );
      return;
    }
    cfg.autoLp.oorAction = v;
    persist();
    await send(
      `✓ autoLp.oorAction → <b>${v}</b> ${v === "rebalance" ? "(OOR → close + reopen recentered, capital keeps working)" : "(OOR closed to ETH)"}${v === "rebalance" && !cfg.autoLp.closeOor ? "\n⚠️ enable first: <code>/set alpclose 1</code>" : ""}`,
    );
    return;
  }
  if (k === "alpcompound") {
    if (v !== "0" && v !== "1") {
      await send("Toggle: <code>/set alpcompound 1</code> (compound fees back) / <code>/set alpcompound 0</code> (off)");
      return;
    }
    cfg.autoLp.compound = v === "1";
    persist();
    await send(`✓ autoLp.compound → ${v === "1" ? `on (harvest and add back fees ≥ $${cfg.autoLp.compoundMinUsd})` : "off"}`);
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
    const warn = k === "radar" && Number(v) !== 0 && !env.openrouterKey ? " ⚠️ RH_OPENROUTER_KEY is not set" : "";
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
  await send(`Unknown key.\n${SET_HELP}`);
}

export async function onHelp(): Promise<void> {
  const body = [
    `🤖 <b>Robinhood LP Bot</b>  <i>optimized · Uniswap v3+v4</i>`,
    `Paste a <b>token CA</b> (0x…) → choose a pool (v3/v4) → enter ETH → LP.`,
    ``,
    `<b>━━━ 📊 POSITIONS ━━━</b>`,
    `📋 /list — open positions + PnL + close`,
    `📒 /ledger — closed-position history (realized)`,
    `💰 /pnl — lifetime PnL`,
    `📸 /card — shareable profit card`,
    ``,
    `<b>━━━ 🎯 RADAR & AUTO ━━━</b>`,
    `🧪 /screen — GMGN 24h screening (mcap&gt;500k, vol&gt;1M, no flap, utility&gt;meme)`,
    `📡 /feed — real-time sequencer monitor`,
    `👁 /watch — volume-spike scanner`,
    `🔍 /scan — scan current volume`,
    `🤖 /auto — auto-LP (radar → open automatically)`,
    `🦄 /v4 <code>&lt;ca&gt;</code> — check high-fee v4 pools`,
    ``,
    `<b>━━━ ⚡ AKSI ━━━</b>`,
    `🔄 /swap <code>&lt;amount&gt; &lt;from&gt; &lt;to&gt;</code> — swap via Kyber`,
    `🗑 /closeall · 💸 /sell · 👛 /wallet · 🔒 /revoke`,
    `⚙️ /settings · /set <code>&lt;k&gt; &lt;v&gt;</code>`,
    ``,
    `<i>Quick menu is below 👇 — no typing required.</i>`,
  ].join("\n");
  await sendMenu(body);
}

/** /revoke — zero allowances to the protocol spenders used by this bot. */
export async function onRevoke(): Promise<void> {
  await send("🔒 Scanning known ERC-20 approvals… (no transfers will be made)");
  try {
    const r = await revokeKnownApprovals();
    await sendMenu([
      `✅ <b>Approval scan complete</b>`,
      `Tokens scanned: ${r.tokensScanned}`,
      `Active allowances found: ${r.allowancesFound}`,
      `Revoked: ${r.revoked}`,
      r.failed
        ? `⚠️ Failed: ${r.failed}\n<code>${r.failures.slice(0, 5).map(esc).join("\n")}</code>`
        : "No revoke failures.",
    ].join("\n"));
  } catch (e) {
    await send(`❌ Approval scan failed: ${esc(short(e, 180))}`);
  }
}

// per-message pending accessors for bot.ts routing
// ══════════ ➕ Add — increase an EXISTING position (not a new NFT) ══════════

export async function onAddAsk(tokenId: string, version: "v3" | "v4"): Promise<void> {
  pending = null; // drop any open-flow so a stray number doesn't mis-route
  pendingAdd = { tokenId, version };
  await send(
    `➕ <b>Add liquidity to position #${tokenId}</b> [${version}]\n` +
      `Enter the <b>ETH</b> amount to add (example: <code>0.005</code>). The bot automatically splits ½ token + ½ USDG → into this position (not a new one).`,
  );
}

export async function onAddAmount(text: string): Promise<void> {
  if (!pendingAdd) return;
  const eth = parseFloat(text);
  if (!(eth > 0)) {
    await send("Enter a valid ETH amount, for example: 0.005");
    return;
  }
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(`⚠️ Amount too large. Only ${usableEth(b).toFixed(5)} ETH is available for LP.`);
    return;
  }
  if (b && Number(b.eth) < GAS_RESERVE) {
    await send(`⚠️ Native ETH is only ${Number(b.eth).toFixed(5)} — below the gas reserve (minimum ${GAS_RESERVE}).`);
    return;
  }
  const { tokenId, version } = pendingAdd;
  pendingAdd = null;
  const amt = toEthStr(eth) ?? String(eth);
  invalidateListCache();
  const m = await send(`⏳ <b>Adding ${amt} ETH to position #${tokenId}…</b> (swap ½+½ → increase)`);
  const mid = m?.result?.message_id;
  try {
    if (version === "v4") {
      const { increaseV4Position } = await import("../chain/v4/mint.js");
      const r = await increaseV4Position(tokenId, amt);
      await edit(
        mid,
        [
          `✅ <b>Liquidity added to #${tokenId}</b> [v4] · pool fee ${(r.fee / 10000).toFixed(2)}%`,
          r.swapHash ? `swap ½+½: <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
          `deposit <b>+${amt}Ξ</b> (added to the existing position, not a new #)`,
          `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } else {
      await edit(mid, "v3 increases are not supported yet (v4 only).");
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const friendly = /revert|settle|slippage|CurrencyNotSettled/i.test(msg)
      ? "The pool moved during settlement (volatile/high-fee pool). <b>Tap ➕ Add again</b> — the token/USDG already purchased will be reused; the second attempt usually works."
      : short(e, 160);
    await edit(mid, `❌ Failed to add liquidity: ${friendly}`);
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
    await sendPhoto(png, "📅 <b>Profit Calendar</b> — each square = the PnL of positions closed that day (fees included). Resets at 07:00 WIB.", {
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
    await send(`❌ Calendar failed: ${short(e, 120)}`);
  }
}

export const isAwaitingAmount = (): boolean => !!pending?.awaitingAmount;
export const cancelPending = (): void => {
  pending = null;
  pendingAutoInput = null;
  pendingSettingsInput = null;
  pendingAdd = null;
  pendingSwap = null;
  swapFrom = null;
};

function short(e: unknown, n: number): string {
  return String((e as Error)?.message ?? e).slice(0, n);
}
