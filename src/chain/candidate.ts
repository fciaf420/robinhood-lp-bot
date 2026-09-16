/**
 * Candidate qualifier + the CHAIN'S OWN candidate sources.
 *
 * Two jobs, and they used to be one:
 *
 *  1. `qualifyCandidate(token)` — the hard gate shared by the hunter and the feed: does this token
 *     have a v4 pool in the target fee band (3-5%) with real volume? A token only counts as a
 *     farmable LP candidate if there's an actual high-fee pool with turnover to earn from.
 *
 *  2. `scanNewPools()` / `spikePools()` — where candidates COME FROM on a chain GMGN and the
 *     trending feeds never heard of. Robinhood's pipeline starts at GMGN trending; Arc has no GMGN
 *     (profile `data.gmgn === false`) and possibly no DexScreener coverage either, so the candidate
 *     feed has to be reconstructed from the only source that is always true: the chain itself —
 *     v4 PoolManager `Initialize` logs and v3 factory `PoolCreated` logs.
 *
 * These scanners deliberately harvest TOKEN ADDRESSES ONLY. Verification (which pools are live,
 * their price/liquidity/tickSpacing) stays in v4/discover.ts, which already does it with caching,
 * Multicall3 batching and a last-good fallback — duplicating that here would give the bot two
 * discovery implementations that can disagree about what a pool is.
 *
 * All volume/liquidity numbers come from `poolVolume()` (chain/volume.ts), never from DexScreener
 * directly: that indirection is what lets the same fee-band / fee-yield / anti-wash / spike gates
 * below keep working on a chain no indexer covers, with on-chain Swap logs behind them instead.
 */
import { ethers } from "ethers";
import { cfg, C } from "../config.js";
import { CHAIN } from "./profile.js";
import { provider, logsProvider } from "./client.js";
import { isStableQuote, isWrappedNative } from "./currency.js";
import { discoverV4Pools, discoverV4StablePools, type V4Pool } from "./v4/discover.js";
import { poolVolume, type PoolVolume } from "./volume.js";
import { dexPairs, type DexPair } from "./dexscreener.js";
import { mapLimit } from "./blockscout.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";

const log = logger("candidate");

export interface QualifiedPool {
  v4: V4Pool;
  fee: number;
  quote: "eth" | "usd";
  volUsd: number; // pool 24h volume ($)
  liqUsd: number;
  feesUsd: number; // est. 24h fees the pool generated = volUsd × feeRate
  feeYieldPct: number; // daily fee yield vs TVL (0 when TVL unreadable)
  volPct: number; // |price change| % (max of 1h/6h) — volatility for adaptive range width
  volH1: number; // 1h volume ($)
  spikeX: number; // volH1 / (vol24h/24) — recent hour vs 24h-avg hour; >1 = heating up NOW (#1 spike)
  volSource: PoolVolume["source"]; // where volUsd/liqUsd came from — "onchain" numbers can under-report
}

/**
 * How many pools we're willing to ask for volume, per token, when volume is derived ON-CHAIN.
 * With an indexer one call answers for every pool of a token (cached), so there is NO cap there and
 * the Robinhood selection is byte-for-byte what it always was. On-chain each pool is its own
 * getLogs, and a token with 120 micro-pools would stall the scan — so the deepest N in the fee band
 * are probed and the dust is left alone. It is a probe budget, not a position cap.
 */
const ONCHAIN_VOL_PROBE_CAP = 12;

/**
 * Best v4 pool for `token` inside [feeMinPpm, feeMaxPpm]. Gates (#1 fee-yield):
 *   - volume ≥ minVolUsd (busy)
 *   - 24h fees generated (vol × feeRate) ≥ minPoolFeesUsd — weights a busy HIGH-fee pool over raw
 *     volume (a 5% pool at $8k vol beats a 3% pool at $9k), which is exactly what we farm.
 *   - daily fee/TVL yield ≥ minFeeYieldPct — only when TVL is readable (v4 singleton often reads $0,
 *     so this is skipped rather than blocking).
 * Ranks the survivors by absolute 24h fees (the real earning signal), not raw volume.
 */
export async function qualifyCandidate(token: string): Promise<QualifiedPool | null> {
  const s = cfg.scan;
  const now = Date.now();
  const [eth, usd] = await Promise.all([
    discoverV4Pools(token).catch(() => [] as V4Pool[]),
    discoverV4StablePools(token).catch(() => [] as V4Pool[]),
  ]);
  // Fee band first: it is free and throws away most of the pool set before anything costs a call.
  const inBand = [...eth, ...usd].filter((p) => p.fee >= s.feeMinPpm && p.fee <= s.feeMaxPpm);
  if (!inBand.length) return null;

  const onchain = CHAIN.data.volumeSource === "onchain";
  // Deepest-first ONLY when we have to ration probes; with an indexer the original discovery order
  // is preserved so the "best pool" choice on Robinhood cannot shift.
  const probe = onchain
    ? inBand
        .slice()
        .sort((a, b) => (a.liquidity === b.liquidity ? b.fee - a.fee : b.liquidity > a.liquidity ? 1 : -1))
        .slice(0, ONCHAIN_VOL_PROBE_CAP)
    : inBand;

  // Price CHANGE (volatility → adaptive range width) has no on-chain equivalent here — it comes off
  // the indexer's pair rows. Where there is no indexer, volPct stays 0, which lands autolp on its
  // BASE width (8 spacings) instead of a made-up one. A neutral range is the conservative answer;
  // inventing volatility from nothing would size real positions off a guess.
  const dex: Map<string, DexPair> = onchain ? new Map() : await dexPairs(token, now).catch(() => new Map<string, DexPair>());

  // Concurrency 1 on the indexer path: poolVolume() answers every pool of a token from ONE cached
  // fetch, so serialising the lookups keeps the API cost at exactly one request (parallel calls
  // would all miss the cold cache and fire N). On-chain each probe is an independent getLogs, so
  // there is nothing to share and 4 at a time is the throughput we want.
  // The pool KEY is passed through. Without it poolVolume() has to infer which leg of a v4 Swap is
  // the dollar one from the sort order of (token, stable) — a sound inference, but an inference,
  // and the cost of getting it wrong is reading the TOKEN leg at the stable's 6 decimals, which
  // inflates a $30 swap into a $30M one and hands a wash pool a green light. We already know the
  // currencies here (discovery returned them), so there is no reason to guess.
  const measured = await mapLimit(probe, onchain ? 4 : 1, async (p) => ({
    p,
    v: await poolVolume(p.poolId, token, now, { currency0: p.poolKey.currency0, currency1: p.poolKey.currency1 }).catch(() => null),
  }));

  let best: QualifiedPool | null = null;
  for (const { p, v } of measured) {
    if (!v) continue; // volume unreadable → cannot assert "busy", so it does not qualify
    const volUsd = v.vol24h;
    if (volUsd < s.minVolUsd) continue; // not busy enough
    const liqUsd = v.liqUsd;
    // ANTI-WASH: a pool with big volume but near-zero REAL liquidity is a wash/trap (fake volume; your
    // LP would be ~all the liquidity → exposed to the wash operator + rug). Only assessable when liq is
    // READABLE (>0); v4 singleton liq often reads $0 (unknown → not blocked here).
    if (liqUsd > 0 && s.minPoolLiqUsd > 0 && liqUsd < s.minPoolLiqUsd) continue; // liq too thin to farm safely
    if (liqUsd > 0 && s.maxVolLiqRatio > 0 && volUsd / liqUsd > s.maxVolLiqRatio) continue; // vol >> liq = wash
    const feesUsd = volUsd * (p.fee / 1e6); // fee ppm → rate (30000ppm = 3%)
    if (feesUsd < s.minPoolFeesUsd) continue; // #1: not enough fees generated to be worth farming
    const feeYieldPct = liqUsd > 0 ? (feesUsd / liqUsd) * 100 : 0;
    if (liqUsd > 0 && s.minFeeYieldPct > 0 && feeYieldPct < s.minFeeYieldPct) continue; // #1: TVL-relative yield too thin
    const d = dex.get(p.poolId.toLowerCase());
    const volPct = Math.max(Math.abs(d?.chgH1 ?? 0), Math.abs(d?.chgH6 ?? 0));
    // #1 volume-SPIKE: recent hour vs the 24h-average hour. >1 = heating up NOW (the Meteora "hunt the
    // spike" idea). A stale pool (all its 24h volume happened hours ago) reads spikeX ~0 → skip when armed.
    const volH1 = v.volH1;
    const spikeX = volUsd > 0 ? volH1 / (volUsd / 24) : 0;
    if (s.minSpikeX > 0 && spikeX < s.minSpikeX) continue; // require recent momentum (active now, not stale)
    if (!best || feesUsd > best.feesUsd)
      best = { v4: p, fee: p.fee, quote: p.quote, volUsd, liqUsd, feesUsd, feeYieldPct, volPct, volH1, spikeX, volSource: v.source };
  }
  return best;
}

// ══════════════════════════ on-chain candidate sources ══════════════════════════

/** `Initialize(bytes32 id, address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)` */
const INITIALIZE_TOPIC = ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
/** `PoolCreated(address token0, address token1, uint24 fee, int24 tickSpacing, address pool)` */
const POOL_CREATED_TOPIC = ethers.id("PoolCreated(address,address,uint24,int24,address)");
const DYNAMIC_FEE_FLAG = 0x800000; // v4 fee with this bit = hook-set at swap time → not LP-able normally
const ZERO = "0x0000000000000000000000000000000000000000";

/** One pool the chain told us about. `poolId` is whatever poolVolume() keys on: v4 poolId, v3 address. */
export interface PoolSighting {
  poolId: string; // lowercased
  token: string; // checksummed — the NON-quote side, i.e. the thing we'd be LP-ing against
  quote: string; // lowercased quote side
  venue: "v3" | "v4";
  fee: number; // ppm
  block: number;
  // Approximate pool-init time, derived as now − (latest − block) × blockTimeMs rather than "when
  // the scanner happened to run". That distinction matters: a pool found by the first scan after a
  // restart would otherwise read as 0 minutes old and trip every "too fresh to trust" guard,
  // including the one that keeps a same-block snipe from being scored as an established pool.
  firstSeen: number;
  lastVolAt?: number; // last poolVolume() probe, for round-robin fairness in spikePools()
}

interface Universe {
  pools: Record<string, PoolSighting>; // keyed by poolId
  lastBlock: number; // highest block already scanned — successive scans resume instead of re-reading
}

const UNIVERSE_FILE = dataPath("pool-universe.json");
const loadUniverse = (): Universe => readJson<Universe>(UNIVERSE_FILE, { pools: {}, lastBlock: 0 });
const saveUniverse = (u: Universe): void => writeJson(UNIVERSE_FILE, u);

/**
 * Is this side of the pair one of OUR quote assets rather than a candidate token?
 *
 * The zero address is checked explicitly and FIRST. It is the v4 native sentinel on a chain that
 * allows it, and on a chain that doesn't (Arc) it is also what config.ts fills `contracts.weth`
 * with — either way it is never a token we could LP against, so it must never be picked as the
 * "token side" of a pair.
 */
function isQuoteSide(addr: string): boolean {
  const a = (addr || "").toLowerCase();
  return a === ZERO || isStableQuote(a) || isWrappedNative(a);
}

/** The LP-able side of a pair, or null when both sides are quotes (USDC/EURC) or neither is. */
function tokenSideOf(c0: string, c1: string): { token: string; quote: string } | null {
  const q0 = isQuoteSide(c0);
  const q1 = isQuoteSide(c1);
  if (q0 === q1) return null; // quote/quote (nothing to farm) or token/token (we hold neither side)
  return q0 ? { token: ethers.getAddress(c1), quote: c0.toLowerCase() } : { token: ethers.getAddress(c0), quote: c1.toLowerCase() };
}

const addrFromTopic = (t: string): string => "0x" + t.slice(26);

/**
 * getLogs over a bounded recent window, dedicated logs RPC first.
 *
 * Bounded on purpose: v4/discover.ts's per-token query can afford a full-range scan because it is
 * topic-filtered down to one token. This one filters on nothing but the event, so on a 26M-block
 * chain a full range would return every pool ever created. `lookbackMin` × the profile's real block
 * time is the window, which is why blockTimeMs is a profile field and not a constant.
 */
async function windowLogs(address: string, topic: string, fromBlock: number, toBlock: number): Promise<readonly ethers.Log[] | null> {
  if (fromBlock > toBlock) return [];
  const provs = logsProvider === provider ? [provider] : [logsProvider, provider];
  for (const prov of provs) {
    try {
      return await prov.getLogs({ address, topics: [topic], fromBlock, toBlock });
    } catch {
      /* next provider */
    }
  }
  // null, NOT []. The caller advances its block cursor on success, and an empty array means "this
  // window genuinely had no new pools". Conflating the two would move the cursor past a window the
  // RPC merely failed to serve — every pool launched in it would be invisible forever after.
  return null;
}

export interface NewPoolOpts {
  lookbackMin?: number; // how far back to look when there is no saved cursor (default 60)
  maxBlocks?: number; // hard span cap for one scan (default 200k) — a cold start can't DoS the RPC
}

/**
 * Pools initialized recently, newest first, recorded into the persistent universe.
 *
 * Covers BOTH venues because a chain may launch on either: v4 `Initialize` on the PoolManager and
 * v3 `PoolCreated` on the factory. Dynamic-fee v4 pools are skipped for the same reason discovery
 * skips them — their fee isn't knowable upfront, so no fee-band gate can be applied.
 */
export async function scanNewPools(opts: NewPoolOpts = {}): Promise<PoolSighting[]> {
  const lookbackMin = opts.lookbackMin ?? 60;
  const maxBlocks = opts.maxBlocks ?? 200_000;
  const u = loadUniverse();
  let latest: number;
  try {
    latest = await provider.getBlockNumber();
  } catch (e) {
    log.warn(`scanNewPools: getBlockNumber gagal — ${(e as Error).message.slice(0, 70)}`);
    return [];
  }
  // Window = max(saved cursor + 1, latest − lookback), then clamped to maxBlocks. Resuming from the
  // cursor is safe on both chains here (Robinhood settles through its sequencer, Arc has
  // deterministic BFT finality at 1 confirmation), so a block scanned once never needs re-reading.
  const lookbackBlocks = Math.ceil((lookbackMin * 60_000) / CHAIN.blockTimeMs);
  let from = Math.max(0, u.lastBlock > 0 ? u.lastBlock + 1 : latest - lookbackBlocks);
  if (latest - from > maxBlocks) from = latest - maxBlocks;
  if (from > latest) return [];

  const none: readonly ethers.Log[] = [];
  const [v4Logs, v3Logs] = await Promise.all([
    CHAIN.venues.v4 && C.v4PoolManager ? windowLogs(C.v4PoolManager, INITIALIZE_TOPIC, Math.max(from, CHAIN.discovery.v4FromBlock), latest) : Promise.resolve(none),
    CHAIN.venues.v3 && C.factory ? windowLogs(C.factory, POOL_CREATED_TOPIC, from, latest) : Promise.resolve(none),
  ]);

  const now = Date.now();
  // Block → wall-clock, from the profile's real block cadence. One getBlock per log would be
  // accurate to the second and cost an RPC round-trip per pool; the cadence is deterministic
  // enough (0.5s on both chains) for an "is this pool 2 minutes or 2 hours old" decision.
  const initTs = (block: number): number => now - Math.max(0, latest - block) * CHAIN.blockTimeMs;
  const fresh: PoolSighting[] = [];
  const add = (s: PoolSighting): void => {
    if (u.pools[s.poolId]) return; // already known — keep the ORIGINAL firstSeen
    u.pools[s.poolId] = s;
    fresh.push(s);
  };

  for (const lg of v4Logs ?? none) {
    try {
      const c0 = addrFromTopic(lg.topics[2]);
      const c1 = addrFromTopic(lg.topics[3]);
      const sides = tokenSideOf(c0, c1);
      if (!sides) continue;
      const fee = parseInt(lg.data.slice(2).slice(0, 64), 16);
      if (fee >= DYNAMIC_FEE_FLAG) continue; // hook-set fee → no fee band to gate on
      add({ poolId: lg.topics[1].toLowerCase(), token: sides.token, quote: sides.quote, venue: "v4", fee, block: lg.blockNumber, firstSeen: initTs(lg.blockNumber) });
    } catch {
      /* skip a malformed log rather than abort the whole scan */
    }
  }
  for (const lg of v3Logs ?? none) {
    try {
      const c0 = addrFromTopic(lg.topics[1]);
      const c1 = addrFromTopic(lg.topics[2]);
      const sides = tokenSideOf(c0, c1);
      if (!sides) continue;
      const fee = parseInt(lg.topics[3].slice(2), 16);
      // v3 PoolCreated data = [int24 tickSpacing][address pool]; the pool ADDRESS is the volume key.
      const poolAddr = ("0x" + lg.data.slice(2).slice(64 + 24, 128)).toLowerCase();
      if (poolAddr === ZERO) continue;
      add({ poolId: poolAddr, token: sides.token, quote: sides.quote, venue: "v3", fee, block: lg.blockNumber, firstSeen: initTs(lg.blockNumber) });
    } catch {
      /* skip */
    }
  }

  // Only advance the cursor when BOTH venue queries actually answered. A half-served window left
  // behind is the difference between "missed a pool for 3 minutes" and "missed it permanently".
  if (v4Logs !== null && v3Logs !== null) u.lastBlock = latest;
  else log.warn(`getLogs gagal (${v4Logs === null ? "v4" : ""}${v3Logs === null ? " v3" : ""}) — cursor blok ${u.lastBlock} nggak dimajuin, window diulang scan berikutnya`);
  pruneUniverse(u, now);
  saveUniverse(u);
  fresh.sort((a, b) => b.block - a.block);
  if (fresh.length) log.info(`pool baru: ${fresh.length} (blok ${from}-${latest}, universe ${Object.keys(u.pools).length})`);
  return fresh;
}

/**
 * Drop pools we have been carrying for longer than the retention window. A pool that has been in
 * the universe for days without ever spiking is not a candidate, it is RPC bills — and an unbounded
 * record here would grow into a multi-megabyte JSON the bot rewrites every scan.
 */
const UNIVERSE_TTL_MS = 48 * 3600_000;
const UNIVERSE_MAX = 4000;
function pruneUniverse(u: Universe, now: number): void {
  for (const [id, p] of Object.entries(u.pools)) if (now - p.firstSeen > UNIVERSE_TTL_MS) delete u.pools[id];
  const ids = Object.keys(u.pools);
  if (ids.length <= UNIVERSE_MAX) return;
  // still too many → keep the newest UNIVERSE_MAX by block
  const keep = new Set(ids.sort((a, b) => u.pools[b].block - u.pools[a].block).slice(0, UNIVERSE_MAX));
  for (const id of ids) if (!keep.has(id)) delete u.pools[id];
}

export interface SpikePool extends PoolSighting {
  vol24h: number;
  volH1: number;
  liqUsd: number;
  spikeX: number; // volH1 / (vol24h/24)
  volSource: PoolVolume["source"];
}

export interface SpikeOpts {
  minSpikeX?: number; // default cfg.scan.minSpikeX, floored at 1.5 (a "spike" must actually be one)
  minVolUsd?: number; // default cfg.scan.minVolUsd
  probe?: number; // how many universe pools to measure this pass (default 24)
}

/**
 * Pools whose RECENT hour beats their 24h average — the "volume-spike" candidate source.
 *
 * Walks the persistent universe least-recently-probed first, so every pool gets measured on a
 * rotation instead of the scan hammering the same head of the list forever. The probe budget is
 * what keeps this affordable when poolVolume() is reading Swap logs rather than an indexer.
 *
 * A pool that reads zero 24h volume is not a spike, it is a dead pool: spikeX is only meaningful
 * with a denominator, so those are dropped rather than scored as ∞.
 */
export async function spikePools(opts: SpikeOpts = {}): Promise<SpikePool[]> {
  const minSpikeX = Math.max(1.5, opts.minSpikeX ?? cfg.scan.minSpikeX);
  const minVolUsd = opts.minVolUsd ?? cfg.scan.minVolUsd;
  const budget = Math.max(1, opts.probe ?? 24);
  const u = loadUniverse();
  const all = Object.values(u.pools);
  if (!all.length) return [];
  const queue = all.sort((a, b) => (a.lastVolAt ?? 0) - (b.lastVolAt ?? 0)).slice(0, budget);
  const now = Date.now();
  const onchain = CHAIN.data.volumeSource === "onchain";
  const measured = await mapLimit(queue, onchain ? 4 : 2, async (p) => ({ p, v: await poolVolume(p.poolId, p.token, now).catch(() => null) }));
  const out: SpikePool[] = [];
  for (const { p, v } of measured) {
    const rec = u.pools[p.poolId];
    if (rec) rec.lastVolAt = now; // mark probed even on failure, so one dead pool can't monopolise the rotation
    if (!v || v.vol24h <= 0) continue;
    const spikeX = v.volH1 / (v.vol24h / 24);
    if (spikeX < minSpikeX || v.vol24h < minVolUsd) continue;
    out.push({ ...p, vol24h: v.vol24h, volH1: v.volH1, liqUsd: v.liqUsd, spikeX, volSource: v.source });
  }
  saveUniverse(u);
  out.sort((a, b) => b.spikeX - a.spikeX);
  return out;
}

/** Universe snapshot for /hunt status — how much of the chain we're actually watching. */
export function poolUniverseStats(): { pools: number; lastBlock: number; probed: number } {
  const u = loadUniverse();
  const all = Object.values(u.pools);
  return { pools: all.length, lastBlock: u.lastBlock, probed: all.filter((p) => p.lastVolAt).length };
}
