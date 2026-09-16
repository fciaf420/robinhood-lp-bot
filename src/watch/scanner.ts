/**
 * Volume-spike scanner.
 *   1. token list   ← the chain's indexer (Blockscout catalog, or recent on-chain transfers)
 *   2. volume 5m/1h ← DexScreener (batched 30 CA), falling back to chain/volume.ts
 *   3. spike        ← 5m volume RISING vs previous scan (not merely high)
 *   4. safety       ← buy the quote asset → sell back via Quoter (on-chain, not reputation)
 *
 * Why simulate the round-trip: no honeypot API covers these chains. The Quoter simulates a
 * real swap — a token that can't be sold (blacklist/tax) reverts or returns far too little.
 *
 * NOTHING here is chain-specific any more. The DexScreener slug, the explorer, the buy-side asset
 * of the honeypot probe and the volume source all come from the chain profile, because on Arc
 * three of those four are different: no wrapped native to probe with (the buy side is the 6-decimal
 * USDC ERC-20), possibly no DexScreener coverage at all, and a token list that has to be derived
 * from Transfer logs. Where a third party is missing the scanner runs on on-chain numbers rather
 * than going blind.
 */
import { ethers } from "ethers";
import { cfg, C } from "../config.js";
import { CHAIN } from "../chain/profile.js";
import { quoteAssetOf } from "../chain/currency.js";
import { watchProvider, usingOwnWatchRpc } from "../chain/client.js";
import { QUOTER_ABI } from "../chain/abis.js";
import { defaultQuoteAddr } from "../chain/swaps.js";
import { DS_CHAIN } from "../chain/dexscreener.js";
import { tokenVolume, volumeSource } from "../chain/volume.js";
import { tokenCatalog } from "../chain/indexer.js";
import { mapLimit } from "../chain/blockscout.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";
import type { SpikeHit, SafetyResult } from "../types.js";
import type { WatchConfig } from "../config.js";

const log = logger("watch");
export { usingOwnWatchRpc };

const HIST_FILE = dataPath("watch-history.json");
const DS = "https://api.dexscreener.com/latest/dex/tokens";

export const wcfg = (): WatchConfig => cfg.watch;

interface Hist {
  vol: Record<string, { vol5m: number; at: number }>;
  alerted: Record<string, number>;
}
const loadHist = (): Hist => readJson<Hist>(HIST_FILE, { vol: {}, alerted: {} });
const saveHist = (h: Hist): void => writeJson(HIST_FILE, h);

interface TokenRef {
  addr: string;
  symbol: string;
}

interface MarketRow {
  addr: string;
  symbol: string;
  vol5m: number;
  vol1h: number;
  vol24h: number;
  liq: number;
  fdv: number;
  priceUsd: number;
  chg5m: number;
  chg1h: number;
  url: string;
  /** Where the numbers came from. On-chain rows have no price/FDV and often no readable liquidity. */
  src: "dexscreener" | "onchain";
}

// ── 1. token list from the chain's indexer (cache 30m) ──
let tokenCache: { list: TokenRef[]; at: number } = { list: [], at: 0 };
async function tokenList(max: number): Promise<TokenRef[]> {
  if (Date.now() - tokenCache.at < 30 * 60_000 && tokenCache.list.length) return tokenCache.list;
  const rows = await tokenCatalog(max);
  if (rows === null) {
    // "can't know" — keep serving the previous list instead of caching an empty one for half an
    // hour, which is what a single flaky fetch used to buy us (30 minutes of scanning nothing).
    log.warn(`token list unreadable (indexer) — using stale cache (${tokenCache.list.length} tokens)`);
    return tokenCache.list;
  }
  tokenCache = { list: rows.map((r) => ({ addr: r.address, symbol: r.symbol })).slice(0, max), at: Date.now() };
  return tokenCache.list;
}

// ── 2. market data from DexScreener, batched 30 ──
async function marketData(toks: TokenRef[]): Promise<Record<string, MarketRow>> {
  const out: Record<string, MarketRow> = {};
  const addrs = toks.map((t) => t.addr);
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    const r: any = await fetch(`${DS}/${chunk.join(",")}`, { signal: AbortSignal.timeout(15_000) })
      .then((x) => x.json())
      .catch(() => null);
    for (const p of r?.pairs ?? []) {
      if (p.chainId !== DS_CHAIN) continue; // another chain's pool sharing this token address
      const a = p.baseToken?.address;
      if (!a) continue;
      const liq = Number(p.liquidity?.usd || 0);
      if (out[a] && out[a]!.liq >= liq) continue; // keep deepest pool per token
      out[a] = {
        addr: a,
        symbol: p.baseToken?.symbol || "?",
        vol5m: Number(p.volume?.m5 || 0),
        vol1h: Number(p.volume?.h1 || 0),
        vol24h: Number(p.volume?.h24 || 0),
        liq,
        fdv: Number(p.fdv || 0),
        priceUsd: Number(p.priceUsd || 0),
        chg5m: Number(p.priceChange?.m5 || 0),
        chg1h: Number(p.priceChange?.h1 || 0),
        url: p.url || `https://dexscreener.com/${DS_CHAIN}/${p.pairAddress}`,
        src: "dexscreener",
      };
    }
    await sleep(250); // polite to the API
  }
  await fillFromChain(toks, out);
  return out;
}

/**
 * Tokens DexScreener said nothing about, measured on-chain instead.
 *
 * Only on a chain whose profile says volume is on-chain, so the Robinhood scanner reads exactly the
 * rows it reads today. The cap is the point: one token's on-chain volume is a getLogs per pool, and
 * a 300-token list would be thousands. The list arrives ACTIVITY-RANKED from the rpc indexer (most
 * transfers in the last minutes first), so the first N are precisely the ones a spike could be in.
 */
const ONCHAIN_TOKEN_CAP = Math.max(1, Number(process.env.RH_WATCH_ONCHAIN_CAP) || 12);

async function fillFromChain(toks: TokenRef[], out: Record<string, MarketRow>): Promise<void> {
  if (volumeSource() !== "onchain") return;
  const have = new Set(Object.keys(out).map((a) => a.toLowerCase()));
  const missing = toks.filter((t) => !have.has(t.addr.toLowerCase())).slice(0, ONCHAIN_TOKEN_CAP);
  if (!missing.length) return;
  const now = Date.now();
  await mapLimit(missing, 3, async (t) => {
    const v = await tokenVolume(t.addr, now).catch(() => null);
    if (!v || (v.vol24h <= 0 && v.volH1 <= 0)) return; // zeros = no data (see chain/volume.ts)
    out[t.addr] = {
      addr: t.addr,
      symbol: t.symbol,
      vol5m: v.volM5 ?? 0,
      vol1h: v.volH1,
      vol24h: v.vol24h,
      liq: v.liqUsd,
      fdv: 0, // no supply/price feed without an indexer — left 0 rather than guessed
      priceUsd: 0,
      chg5m: 0,
      chg1h: 0,
      url: `${CHAIN.explorer.url}/token/${t.addr}`,
      src: "onchain",
    };
  });
}

// ── 4. on-chain safety: buy with the quote asset, then sell back ──

/**
 * The probe trade, in the BUY ASSET's own units.
 *
 * Robinhood: 0.01 of the wrapped native — bit-for-bit the old `parseEther("0.01")`. A chain whose
 * quote asset is a DOLLAR needs a dollar-sized probe instead: 0.01 USDC is 10 000 raw units at 6
 * decimals, small enough that rounding in a thin pool reads as "can't sell" and flags a healthy
 * token as a honeypot. The size is in the quote's decimals, never the native's — on Arc those
 * differ by 1e12.
 */
const PROBE_USD = 10;
function probeBuy(): { addr: string; dec: number; ui: number; raw: bigint } {
  const addr = defaultQuoteAddr();
  const q = quoteAssetOf(addr); // shared profile lookup — see chain/currency.ts
  const dec = q?.decimals ?? 18;
  const ui = q?.class === "usd" ? PROBE_USD : 0.01;
  return { addr, dec, ui, raw: ethers.parseUnits(String(ui), dec) };
}

export async function safetyCheck(tokenAddr: string, maxTaxPct = 6): Promise<SafetyResult> {
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, watchProvider);
  const { addr: BUY, dec, ui, raw: IN } = probeBuy();
  let best: (SafetyResult & { fee: number }) | null = null;
  for (const fee of cfg.lp.feeTiers) {
    try {
      const buy = await q.quoteExactInputSingle!.staticCall({
        tokenIn: BUY,
        tokenOut: tokenAddr,
        amountIn: IN,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      if (buy[0] === 0n) continue;
      const sell = await q.quoteExactInputSingle!.staticCall({
        tokenIn: tokenAddr,
        tokenOut: BUY,
        amountIn: buy[0],
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const backPct = (Number(ethers.formatUnits(sell[0], dec)) / ui) * 100;
      const expected = Math.pow(1 - fee / 1e6, 2) * 100;
      const taxPct = expected - backPct;
      if (!best || backPct > best.backPct) best = { ok: true, fee, backPct, taxPct, reason: "" };
    } catch {
      /* no pool / cannot sell this tier */
    }
  }
  if (!best) return { ok: false, backPct: 0, taxPct: 100, reason: "CANNOT BE SOLD (simulation reverted) — honeypot" };
  if (best.taxPct > maxTaxPct) return { ...best, ok: false, reason: `hidden tax ~${best.taxPct.toFixed(1)}%` };
  return { ...best, ok: true, reason: `healthy (return ${best.backPct.toFixed(1)}%)` };
}

// stablecoins have high volume but no momentum — filter by name AND behaviour
const STABLE_RE = /^(w?eth|usd[a-z]?|.*usd[a-z]?|dai|frax|tusd|susd|.*syrup.*)$/i;
function isStable(m: MarketRow): boolean {
  if (STABLE_RE.test(m.symbol)) return true;
  return m.priceUsd > 0.95 && m.priceUsd < 1.05 && Math.abs(m.chg1h) < 1;
}

/** Highest current 5m volume (non-stable) — used by /watch to show market context. */
export async function topVolumeNow(n = 3): Promise<MarketRow[]> {
  const w = wcfg();
  const toks = await tokenList(w.maxTokens);
  const md = await marketData(toks);
  return Object.values(md)
    .filter((m) => !isStable(m))
    .sort((a, b) => b.vol5m - a.vol5m)
    .slice(0, n);
}

/** One scan pass. Returns tokens that passed every filter + safety check. */
export async function scanOnce(onLog: (msg: string) => void = () => {}): Promise<SpikeHit[]> {
  const w = wcfg();
  const hist = loadHist();
  const toks = await tokenList(w.maxTokens);
  onLog(`checking ${toks.length} tokens…`);
  const md = await marketData(toks);
  const now = Date.now();
  const hits: SpikeHit[] = [];

  for (const m of Object.values(md)) {
    const prev = hist.vol[m.addr];
    const prevVol = prev?.vol5m ?? 0;
    hist.vol[m.addr] = { vol5m: m.vol5m, at: now };

    if (isStable(m)) continue;
    if (m.vol5m < w.minVol5m) continue;
    if (m.vol1h < w.minVol1h) continue;
    // Liquidity gate. An on-chain row can report liq 0 for a reason that has nothing to do with the
    // pool being thin — v4's singleton PoolManager makes per-pool depth unreadable — so an UNKNOWN
    // (0) liquidity is not treated as a failing one there. A DexScreener row is unchanged: 0 means
    // DexScreener says there is nothing in it, and that still fails.
    if (!(m.src === "onchain" && m.liq === 0) && m.liq < w.minLiqUsd) continue;
    if (!prev) continue; // need a baseline to prove "rising"
    if (m.vol5m < prevVol * w.riseFactor) continue;
    if (now - (hist.alerted[m.addr] || 0) < w.cooldownMin * 60_000) continue;

    onLog(`spike: ${m.symbol} $${(m.vol5m / 1000).toFixed(0)}k/5m — safety check…`);
    const safe = await safetyCheck(m.addr, w.maxTaxPct);
    if (!safe.ok) {
      onLog(`  ✗ ${m.symbol} rejected: ${safe.reason}`);
      continue;
    }
    hist.alerted[m.addr] = now;
    hits.push({ ...m, prevVol5m: prevVol, safe });
  }
  saveHist(hist);
  if (hits.length) log.info(`${hits.length} spikes passed filter`);
  return hits;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
