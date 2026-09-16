/**
 * Pool VOLUME — the signal the whole high-fee-farming thesis rests on — from whichever source
 * the chain profile names, behind ONE function so no caller has to know which.
 *
 *   data.volumeSource = "dexscreener"  → today's path, unchanged (Robinhood).
 *   data.volumeSource = "onchain"      → derived from Swap events. Nothing to index, nothing to
 *                                        rate-limit, works on a chain nobody covers yet (Arc).
 *
 * WHY THE ON-CHAIN PATH LOOKS LIKE THIS
 * A swap's dollar size is sitting right there in the log: every pool the bot farms is
 * token/<stable>, and the stable leg of the swap IS the trade's USD value — the quote asset is a
 * dollar by definition (profile quote class "usd"), so no price feed, no oracle and no third
 * party is involved. What it costs is BLOCKS: at Arc's ~500ms cadence, 24h is ~172 800 blocks,
 * which no node will serve in one getLogs. Hence:
 *   - the scan is chunked + budgeted (chain/indexer.ts getLogsChunked),
 *   - results are kept as PER-MINUTE BUCKETS so 24h / 1h / 5m all come off one scan, and
 *   - a refresh only reads the blocks since the last one (a few hundred), so the 172k-block cost
 *     is paid once per pool and never again while the bot is up.
 *
 * MONEY-SAFETY RULE FOR THIS FILE: an INCOMPLETE read returns ZEROS, never a partial number.
 * Zero already means "no data" to every consumer (candidate.ts won't qualify a pool it can't
 * prove is busy; automanage's volume-fade returns neutral when vol24h <= 0). A half-scanned
 * window reported as a real number would do the opposite of both: it under-states volume, so an
 * entry gate silently drops good pools and — far worse — a FADE-EXIT gate would read the missing
 * blocks as "the spike is over" and close a live position. Nothing here throws.
 */
import { ethers } from "ethers";
import { C } from "../config.js";
import { CHAIN } from "./profile.js";
import { provider } from "./client.js";
import { ERC20_ABI } from "./abis.js";
import { dexPairs } from "./dexscreener.js";
import { getLogsChunked, headBlock, blocksForMs } from "./indexer.js";
import { stableAddr, stableDecimals, isStableQuote, quoteDecimalsOf as profileQuoteDecimals } from "./currency.js";
import { findStableQuotePools } from "./pools.js";
import { mapLimit } from "./blockscout.js";
import { logger } from "../util/log.js";

const log = logger("volume");

export interface PoolVolume {
  vol24h: number;
  volH1: number;
  liqUsd: number;
  source: "dexscreener" | "onchain";
  /** 5m volume ($). Only the on-chain path can produce it per-pool; undefined otherwise. */
  volM5?: number;
}

const SOURCE = CHAIN.data.volumeSource;

/** Where pool volume comes from on this chain — for log lines and UI labels. */
export function volumeSource(): PoolVolume["source"] {
  return SOURCE;
}

const zero = (): PoolVolume => ({ vol24h: 0, volH1: 0, liqUsd: 0, source: SOURCE });

// ══════════════════════════ window sizing (from the profile's real block cadence) ══════════════════════════

const BLOCKS_PER_MIN = blocksForMs(60_000); // 120 on a 500ms chain
const W_24H = blocksForMs(24 * 3_600_000);
const W_1H = blocksForMs(3_600_000);
const W_5M = blocksForMs(5 * 60_000);

/** Bucket index of a block. One minute per bucket → 1440 numbers per pool per day. */
const bucketOf = (block: number): number => Math.floor(block / BLOCKS_PER_MIN);

/**
 * How long a computed figure is served before the next (incremental) scan. 60s is a compromise:
 * the "is this pool heating up NOW" signal is a 1h/5m number, and a scan pass touches dozens of
 * pools, so a shorter TTL would turn one hunt cycle into a burst of getLogs for no new signal.
 */
const TTL_MS = Math.max(10_000, Number(process.env.RH_VOL_TTL_MS) || 60_000);

/** A single swap bigger than this is decode/decimal nonsense, not a trade — see stableSide(). */
const ABSURD_USD = 1e9;

/** Pools tracked at once. Bounded because each one keeps a day of minute buckets in memory. */
const MAX_TRACKED = 64;

interface Agg {
  buckets: Map<number, number>; // bucket index → USD traded in that minute
  lastBlock: number; // highest block already counted (inclusive)
  at: number; // last refresh (ms)
  used: number; // LRU stamp
  v: PoolVolume; // last computed answer (served inside TTL)
}
const aggs = new Map<string, Agg>();
let lru = 0;

function evictIfNeeded(): void {
  if (aggs.size <= MAX_TRACKED) return;
  let oldestKey = "";
  let oldest = Infinity;
  for (const [k, a] of aggs) {
    if (a.used >= oldest) continue;
    oldest = a.used;
    oldestKey = k;
  }
  if (oldestKey) aggs.delete(oldestKey);
}

// ══════════════════════════ Swap events ══════════════════════════

// v3 pool: Swap(sender, recipient, int256 amount0, int256 amount1, uint160, uint128, int24)
const V3_SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const V3_SWAP_DATA = ["int256", "int256", "uint160", "uint128", "int24"];
// v4 PoolManager: Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1, …)
const V4_SWAP_TOPIC = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const V4_SWAP_DATA = ["int128", "int128", "uint160", "uint128", "int24", "uint24"];
const coder = ethers.AbiCoder.defaultAbiCoder();

const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const isPoolId = (s: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(s);
const isAddr = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

/**
 * Decimals of a profile-known quote asset (never guessed — this is the 1e12 hazard). The lookup
 * lives in currency.ts; the fallback is local because HERE an unrecognised quote is still a dollar
 * leg we chose to measure, so the stable's width is the only sane width to read it at.
 */
function quoteDecimalsOf(addr: string): number {
  return profileQuoteDecimals(addr) ?? stableDecimals();
}

interface StableSide {
  idx: 0 | 1; // which of amount0/amount1 is the dollar leg
  decimals: number;
}

// token0() is immutable — cache it forever, it is one read per pool for the life of the process.
const v3Token0 = new Map<string, [string, string]>();

/**
 * Which leg of a Swap is the dollar leg, and at what width.
 *
 * v3: read straight off the pool (authoritative). v4: the PoolManager is a singleton and a poolId
 * is a HASH — the key is not recoverable from it, so the pairing is inferred from the sort order
 * of (token, stable), which is exactly how the key was built. That inference is only sound on a
 * chain where every farmable pool is token/<stable> (the only shape that exists where there is no
 * wrapped native), so callers that DO know the key pass it via `opts` and skip the guess.
 *
 * Getting this wrong is the 18-vs-6 class of bug in its worst form: reading the TOKEN leg at the
 * stable's 6 decimals would inflate a $30 swap into a $30M one and hand a wash pool a green light.
 * Hence: no stable leg identified → zeros, never a number.
 */
async function stableSide(poolIdOrAddr: string, token: string, opts?: VolumeOpts): Promise<StableSide | null> {
  const t = (token || "").toLowerCase();
  if (opts?.currency0 && opts?.currency1) {
    if (isStableQuote(opts.currency0)) return { idx: 0, decimals: quoteDecimalsOf(opts.currency0) };
    if (isStableQuote(opts.currency1)) return { idx: 1, decimals: quoteDecimalsOf(opts.currency1) };
    return null;
  }
  if (isAddr(poolIdOrAddr)) {
    let pair = v3Token0.get(poolIdOrAddr.toLowerCase());
    if (!pair) {
      try {
        const pc = new ethers.Contract(poolIdOrAddr, ["function token0() view returns (address)", "function token1() view returns (address)"], provider);
        const [a, b] = await Promise.all([pc.token0!(), pc.token1!()]);
        pair = [String(a).toLowerCase(), String(b).toLowerCase()];
        v3Token0.set(poolIdOrAddr.toLowerCase(), pair);
      } catch {
        return null;
      }
    }
    if (isStableQuote(pair[0])) return { idx: 0, decimals: quoteDecimalsOf(pair[0]) };
    if (isStableQuote(pair[1])) return { idx: 1, decimals: quoteDecimalsOf(pair[1]) };
    return null;
  }
  // v4 pool id → infer from the key's sort order.
  const stable = stableAddr().toLowerCase();
  if (!t || t === stable) return null; // a stable/stable pool has no token leg to measure
  return { idx: stable < t ? 0 : 1, decimals: quoteDecimalsOf(stable) };
}

// ══════════════════════════ liquidity ══════════════════════════

const liqCache = new Map<string, { usd: number; at: number }>();
const LIQ_TTL_MS = 60_000;

/**
 * Dollars sitting in the pool, on-chain.
 *
 * v3: the stable-side balance, NOT doubled into a "TVL". Two reasons it is the honest number to
 * report: it is measured rather than modelled (doubling only holds for a balanced range), and the
 * gate it feeds is the ANTI-WASH one, where under-stating liquidity is the safe direction (a wash
 * pool stays rejected). v4: 0 — the singleton PoolManager holds every pool's funds in one balance,
 * so per-pool depth is not readable at all; every consumer already treats 0 as "unknown, don't
 * block" (the same thing DexScreener reports for v4 on Robinhood).
 */
async function poolLiqUsd(poolIdOrAddr: string): Promise<number> {
  if (!isAddr(poolIdOrAddr)) return 0;
  const k = poolIdOrAddr.toLowerCase();
  const hit = liqCache.get(k);
  if (hit && Date.now() - hit.at < LIQ_TTL_MS) return hit.usd;
  let usd = 0;
  try {
    const c = new ethers.Contract(stableAddr(), ERC20_ABI, provider);
    const raw: bigint = await c.balanceOf!(poolIdOrAddr);
    usd = Number(ethers.formatUnits(raw, stableDecimals()));
  } catch {
    usd = 0;
  }
  liqCache.set(k, { usd, at: Date.now() });
  return usd;
}

// ══════════════════════════ the public call ══════════════════════════

export interface VolumeOpts {
  /** v4 pool-key currencies when the caller knows them — removes the sort-order inference. */
  currency0?: string;
  currency1?: string;
}

/**
 * 1h / 24h volume + liquidity for ONE pool.
 *   `poolIdOrAddr` — a v3 pool ADDRESS (20 bytes) or a v4 POOL ID (32 bytes).
 *   `token`        — the non-quote side; identifies the DexScreener pair set and, on the on-chain
 *                    path, which leg of the v4 swap is the dollar one.
 * Never throws. Zeros mean "no data", not "no volume".
 */
export async function poolVolume(poolIdOrAddr: string, token: string, now: number, opts?: VolumeOpts): Promise<PoolVolume> {
  try {
    if (SOURCE === "dexscreener") return await dexVolume(poolIdOrAddr, token, now);
    return await onchainVolume(poolIdOrAddr, token, now, opts);
  } catch (e) {
    log.warn(`poolVolume ${poolIdOrAddr.slice(0, 12)}… gagal: ${(e as Error).message.slice(0, 80)}`);
    return zero();
  }
}

/** Today's path: the DexScreener pair rows for the token, matched by pool address / poolId. */
async function dexVolume(poolIdOrAddr: string, token: string, now: number): Promise<PoolVolume> {
  const m = await dexPairs(token, now).catch(() => null);
  const d = m?.get(poolIdOrAddr.toLowerCase());
  if (!d) return zero();
  return { vol24h: d.vol24h, volH1: d.volH1, liqUsd: d.liqUsd, source: "dexscreener" };
}

async function onchainVolume(poolIdOrAddr: string, token: string, now: number, opts?: VolumeOpts): Promise<PoolVolume> {
  const key = poolIdOrAddr.toLowerCase();
  const cached = aggs.get(key);
  if (cached && now - cached.at < TTL_MS) {
    cached.used = ++lru;
    return cached.v;
  }
  if (!isPoolId(poolIdOrAddr) && !isAddr(poolIdOrAddr)) return zero();

  const side = await stableSide(poolIdOrAddr, token, opts);
  if (!side) {
    // Not a token/<stable> pool as far as we can tell → we have no price for the other leg, so
    // there is no honest dollar figure to report.
    return zero();
  }
  const head = await headBlock().catch(() => 0);
  if (!head) return zero();

  const filter = isPoolId(poolIdOrAddr)
    ? { address: C.v4PoolManager, topics: [V4_SWAP_TOPIC, poolIdOrAddr] }
    : { address: poolIdOrAddr, topics: [V3_SWAP_TOPIC] };
  if (isPoolId(poolIdOrAddr) && !C.v4PoolManager) return zero();

  const floor = Math.max(0, head - W_24H + 1);
  const agg: Agg = cached && cached.lastBlock >= floor - 1 ? cached : { buckets: new Map(), lastBlock: floor - 1, at: 0, used: ++lru, v: zero() };
  const from = Math.max(floor, agg.lastBlock + 1);

  if (from <= head) {
    // Budget: a COLD pool has to walk a full day of blocks; a warm one only the delta since the
    // last refresh (a few hundred), which is why the steady-state cost of this whole file is tiny.
    const cold = agg.buckets.size === 0;
    const scan = await getLogsChunked(filter, from, head, {
      budgetMs: cold ? 25_000 : 8_000,
      maxCalls: cold ? 240 : 40,
    });
    if (scan.partial) {
      // A hole in the window makes every derived number wrong-low. Drop the aggregate rather than
      // keep a corrupted one — the next call starts clean — and report "no data".
      aggs.delete(key);
      log.warn(`volume ${key.slice(0, 12)}… scan kepotong (${scan.from}..${scan.to}) — dianggap nggak ada data`);
      return zero();
    }
    const dataTypes = isPoolId(poolIdOrAddr) ? V4_SWAP_DATA : V3_SWAP_DATA;
    for (const l of scan.logs) {
      let usd = 0;
      try {
        const vals = coder.decode(dataTypes, l.data);
        usd = Number(ethers.formatUnits(abs(vals[side.idx] as bigint), side.decimals));
      } catch {
        continue; // a hook-shaped or otherwise unexpected log → not a swap we can price
      }
      if (!Number.isFinite(usd) || usd <= 0 || usd > ABSURD_USD) continue;
      const b = bucketOf(l.blockNumber);
      agg.buckets.set(b, (agg.buckets.get(b) ?? 0) + usd);
    }
    agg.lastBlock = head;
  }

  // Sum + prune in one pass.
  const cut24 = bucketOf(head - W_24H);
  const cut1h = bucketOf(head - W_1H);
  const cut5m = bucketOf(head - W_5M);
  let vol24h = 0;
  let volH1 = 0;
  let volM5 = 0;
  for (const [b, usd] of [...agg.buckets]) {
    if (b < cut24) {
      agg.buckets.delete(b);
      continue;
    }
    vol24h += usd;
    if (b >= cut1h) volH1 += usd;
    if (b >= cut5m) volM5 += usd;
  }

  const v: PoolVolume = { vol24h, volH1, volM5, liqUsd: await poolLiqUsd(poolIdOrAddr), source: "onchain" };
  agg.v = v;
  agg.at = now;
  agg.used = ++lru;
  aggs.set(key, agg);
  evictIfNeeded();
  return v;
}

// ══════════════════════════ per-TOKEN volume (the scanner's view) ══════════════════════════

const tokenCache = new Map<string, { at: number; v: PoolVolume }>();
/** Pools probed per token. A probe budget, NOT a position cap — see the module header. */
const TOKEN_POOL_CAP = 4;

/**
 * Volume for a TOKEN rather than a pool: the sum over its pools.
 *
 * This is what the spike scanner needs (it ranks tokens, not pools) and it is the piece that keeps
 * a chain with no DexScreener coverage from having an empty market view. It is deliberately NOT
 * used on the DexScreener path unless that path returned nothing for the token, so the Robinhood
 * scanner keeps reading exactly the rows it reads today.
 */
export async function tokenVolume(token: string, now: number): Promise<PoolVolume> {
  const key = token.toLowerCase();
  const hit = tokenCache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.v;
  let v = zero();
  try {
    v = SOURCE === "dexscreener" ? await dexTokenVolume(token, now) : await onchainTokenVolume(token, now);
  } catch (e) {
    log.warn(`tokenVolume ${token.slice(0, 10)}… gagal: ${(e as Error).message.slice(0, 80)}`);
    v = zero();
  }
  tokenCache.set(key, { at: now, v });
  if (tokenCache.size > 512) tokenCache.clear(); // crude but bounded; entries are tiny and cheap to rebuild
  return v;
}

async function dexTokenVolume(token: string, now: number): Promise<PoolVolume> {
  const m = await dexPairs(token, now).catch(() => null);
  if (!m || !m.size) return zero();
  let vol24h = 0;
  let volH1 = 0;
  let liqUsd = 0;
  for (const d of m.values()) {
    vol24h += d.vol24h;
    volH1 += d.volH1;
    liqUsd = Math.max(liqUsd, d.liqUsd); // deepest pool, not the sum — matches how the scanner picks
  }
  return { vol24h, volH1, liqUsd, source: "dexscreener" };
}

async function onchainTokenVolume(token: string, now: number): Promise<PoolVolume> {
  // v3 first: findStableQuotePools already returns the stable-side depth, so liquidity comes free.
  const v3 = await findStableQuotePools(token).catch(() => []);
  const targets: Array<{ id: string; liq: number }> = v3
    .slice(0, TOKEN_POOL_CAP)
    .map((p) => ({ id: p.pool, liq: p.usdgInPool ?? 0 }));
  if (CHAIN.venues.v4) {
    try {
      // Lazy: v4 discovery pulls in the PoolManager/StateView stack, which a watch-only pass that
      // finds nothing should not pay for.
      const { discoverV4StablePools } = await import("./v4/discover.js");
      const v4 = await discoverV4StablePools(token).catch(() => []);
      for (const p of v4.slice(0, TOKEN_POOL_CAP)) targets.push({ id: p.poolId, liq: 0 });
    } catch {
      /* v4 unavailable on this chain → v3 numbers only */
    }
  }
  if (!targets.length) return zero();
  const parts = await mapLimit(targets, 4, (t) => poolVolume(t.id, token, now));
  let vol24h = 0;
  let volH1 = 0;
  let volM5 = 0;
  let liqUsd = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    vol24h += p.vol24h;
    volH1 += p.volH1;
    volM5 += p.volM5 ?? 0;
    liqUsd += p.liqUsd || targets[i]!.liq;
  }
  return { vol24h, volH1, volM5, liqUsd, source: "onchain" };
}
