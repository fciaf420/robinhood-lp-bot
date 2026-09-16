/**
 * Quality-candidate hunter. Every `cfg.scan.intervalMin` it pulls candidates from the CHAIN'S
 * ENABLED SOURCES, keeps only the ones that ALSO have a pool in the 3-5% fee band with real
 * volume, and alerts with a 1-tap LP button. This is the focused replacement for the old
 * "every new token" feed spam.
 *
 * WHY THERE ARE SOURCES NOW. The whole pipeline used to begin at GMGN trending, which exists on
 * exactly one chain. On Arc there is no GMGN at all, so a hunter built on it would simply never
 * fire — "full parity" has to mean a different FEED, not a disabled feature. The sources are:
 *
 *   gmgn-trending  Robinhood. GMGN's trending rows → thesis/LLM screen → per-token pool check.
 *   onchain-new    Any chain. v4 PoolManager `Initialize` + v3 factory `PoolCreated` logs over a
 *                  recent window → the non-quote side of each new pair is a candidate token.
 *   volume-spike   Any chain. Pools already in the universe whose RECENT hour beats their 24h
 *                  average, measured through poolVolume() (indexer or on-chain Swap logs).
 *
 * The two on-chain sources run in the OPPOSITE order to the GMGN one — qualify first, screen
 * second — because a pool address carries no numbers until it is measured, whereas a GMGN row
 * arrives pre-populated. Both converge on the same {ScreenResult, QualifiedPool} pair, so
 * notify/pipeline/autoLp need no branch.
 */
import { cfg, env } from "../config.js";
import { CHAIN } from "../chain/profile.js";
import { screenTokens, screenOnchainCandidates, type ScreenResult, type ScanSource, type OnchainCandidate } from "./screen.js";
import { qualifyCandidate, scanNewPools, spikePools, poolUniverseStats, type QualifiedPool, type PoolSighting } from "../chain/candidate.js";
import { logger } from "../util/log.js";

const log = logger("hunt");

export interface ScanHooks {
  onCandidate: (r: ScreenResult, pool: QualifiedPool) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let hooks: ScanHooks | null = null;
const alerted = new Map<string, number>(); // token → last alert ts (cooldown)
// Tokens whose pools we already discovered+measured recently and that did NOT qualify. Purely a
// cost guard for the on-chain sources: without it every 3-minute scan re-runs full v4 discovery on
// the same few hundred dead pools the chain emitted overnight. GMGN candidates are not filtered by
// this — that path costs one API call for the whole batch.
const probed = new Map<string, number>();
const stats = { scans: 0, alerts: 0, lastAt: 0, lastFound: 0, lastScanned: 0 };

const ALL_SOURCES: ScanSource[] = ["gmgn-trending", "onchain-new", "volume-spike"];

/**
 * Which candidate sources are live on this chain.
 *
 * Resolution order, first non-empty wins:
 *   1. RH_SCAN_SOURCES=onchain-new,volume-spike  — operator escape hatch
 *   2. cfg.scan.sources                          — config.json / config.<chain>.json. Optional in
 *      ScanSchema, so "absent" is a real state and means "ask the profile", not "no sources".
 *   3. the profile: GMGN chain → gmgn-trending; otherwise the two on-chain sources.
 *
 * An unknown name is dropped with a warning rather than crashing the loop — a typo in an env var
 * must not take a running bot's hunter offline. Only the env path can actually carry one now that
 * the schema validates the config path, but it is the path an operator edits under pressure.
 */
export function scanSources(): ScanSource[] {
  const fromEnv = (process.env.RH_SCAN_SOURCES || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const raw: string[] = fromEnv.length ? fromEnv : (cfg.scan.sources ?? []);
  if (raw.length) {
    const ok = raw.filter((x): x is ScanSource => (ALL_SOURCES as string[]).includes(x));
    const bad = raw.filter((x) => !(ALL_SOURCES as string[]).includes(x));
    if (bad.length) log.warn(`scan.sources unrecognized, skipping: ${bad.join(", ")} (valid: ${ALL_SOURCES.join(", ")})`);
    if (ok.length) return ok;
  }
  return CHAIN.data.gmgn ? ["gmgn-trending"] : ["onchain-new", "volume-spike"];
}

/** Register hooks (pass at boot) and start the timer when enabled. Called again by /hunt on. */
export function startScan(h?: ScanHooks): void {
  if (h) hooks = h;
  if (timer || !hooks || !cfg.scan.enabled) return; // hooks stored, but only run when enabled
  void tick();
  timer = setInterval(() => void tick(), cfg.scan.intervalMin * 60_000);
  log.info(
    `hunt ON — every ${cfg.scan.intervalMin}m · sources ${scanSources().join("+")} · fee ${(cfg.scan.feeMinPpm / 10000).toFixed(0)}-${(cfg.scan.feeMaxPpm / 10000).toFixed(0)}% · vol≥$${cfg.scan.minVolUsd} · score≥${cfg.scan.minScore}`,
  );
}

export function stopScan(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("hunt OFF");
  }
}

export function isScanOn(): boolean {
  return timer !== null;
}

export function scanStatus(): { on: boolean; sources: ScanSource[] } & typeof cfg.scan & typeof stats {
  return { on: isScanOn(), sources: scanSources(), ...cfg.scan, ...stats };
}

/** Run one scan immediately (used by /hunt now). */
export async function scanNow(): Promise<{ found: number; scanned: number }> {
  return runScan();
}

async function tick(): Promise<void> {
  try {
    await runScan();
  } catch (e) {
    log.warn(`scan failed: ${(e as Error).message.slice(0, 90)}`);
  }
}

/**
 * Drop map entries older than `ttl`. The cooldown map used to grow for the whole process lifetime;
 * on a chain where the candidate feed is every new pool rather than ~100 trending rows, that is an
 * unbounded leak in a process expected to run for weeks. An entry past its own TTL has no effect
 * on any decision, so forgetting it is free.
 */
function prune(m: Map<string, number>, now: number, ttl: number): void {
  if (m.size < 500) return;
  for (const [k, ts] of m) if (now - ts > ttl) m.delete(k);
}

/** One screened candidate that also has a farmable pool. */
interface Hit {
  r: ScreenResult;
  pool: QualifiedPool;
}

/**
 * Tokens we ALREADY hold a position in — don't re-alert / risk a duplicate add (the operator asked:
 * "if there's already a position in the token, skip"). maybeAutoLp already dedupes the auto-add, but this also
 * silences the noisy repeat ALERT (and the manual "LP <token>" tap that would open a 2nd position).
 */
async function heldTokens(): Promise<Set<string>> {
  const held = new Set<string>();
  try {
    const [{ listPositions }, { listV4Positions }] = await Promise.all([import("../chain/positions.js"), import("../chain/v4/list.js")]);
    const [v3, v4] = await Promise.all([listPositions().catch(() => []), listV4Positions().catch(() => [])]);
    for (const r of v3) {
      const a = (r as { tokenAddr?: string }).tokenAddr;
      if (a) held.add(a.toLowerCase());
    }
    for (const r of v4) held.add(r.tokenAddr.toLowerCase());
  } catch {
    /* best-effort — if holdings can't be read, don't block alerts */
  }
  return held;
}

/** GMGN trending → screen → per-token 3-5% pool check. Unchanged Robinhood path. */
async function fromGmgn(cooled: (addr: string) => boolean): Promise<{ hits: Hit[]; scanned: number }> {
  const s = cfg.scan;
  // Loose GMGN gates (the 3-5% pools live on smaller tokens) + thesis/LLM screening.
  const { results, scanned } = await screenTokens({
    llm: !!env.openrouterKey,
    minMarketCap: s.screenMinMcap,
    minVolume: s.screenMinVol,
    minLiquidity: s.screenMinLiq,
    limit: 40,
  });
  // survivors past the score/verdict floor and out of cooldown → check the 3-5% pool in parallel
  const cand = results
    .filter(
      (r) =>
        r.token.address &&
        r.score >= s.minScore &&
        r.verdict !== "skip" &&
        (s.screenMaxMcap <= 0 || (r.token.marketCap ?? 0) <= s.screenMaxMcap) && // farm SMALL-cap (bigger fee share for small capital)
        cooled(r.token.address),
    )
    .slice(0, 20);
  const { mapLimit } = await import("../chain/blockscout.js");
  const qualified = await mapLimit(cand, 5, async (r) => {
    const pool = await qualifyCandidate(r.token.address).catch(() => null);
    return pool ? { r, pool } : null;
  });
  return { hits: qualified.filter((q): q is Hit => q !== null), scanned };
}

/** How many tokens the on-chain sources may fully discover+measure in ONE scan. */
const ONCHAIN_QUALIFY_CAP = 12;

/** Don't re-discover a token that just failed to qualify (see `probed`). */
function probeTtlMs(): number {
  return Math.max(20 * 60_000, cfg.scan.intervalMin * 3 * 60_000);
}

/**
 * The chain's own candidate feed: new pools and/or spiking pools → qualify → screen.
 *
 * `scanned` counts the DISTINCT TOKENS the sources surfaced, which is the analogue of "trending
 * rows scanned" in the GMGN path — the number an operator reads as "how much did we look at".
 */
async function fromOnchain(now: number, srcs: ScanSource[], cooled: (addr: string) => boolean): Promise<{ hits: Hit[]; scanned: number }> {
  const s = cfg.scan;
  // Candidate order matters: a SPIKING pool already carries volume evidence, a brand-new one
  // carries none, so spikes are qualified first and get the probe budget.
  const ordered: Array<{ sighting: PoolSighting; source: ScanSource; spikeX: number }> = [];
  // volume-spike measures pools that are ALREADY in the universe, and onchain-new is the only
  // thing that puts them there. Enabling one without the other is a configuration that can never
  // produce a candidate, which is worth saying out loud rather than looking like a quiet chain.
  if (srcs.includes("volume-spike") && !srcs.includes("onchain-new") && poolUniverseStats().pools === 0)
    log.warn("volume-spike source active but pool universe empty — enable onchain-new too so there's something to fill");
  if (srcs.includes("volume-spike")) {
    const spikes = await spikePools({ probe: 24 }).catch((e: Error) => {
      log.warn(`volume-spike failed: ${e.message.slice(0, 70)}`);
      return [];
    });
    for (const p of spikes) ordered.push({ sighting: p, source: "volume-spike", spikeX: p.spikeX });
  }
  if (srcs.includes("onchain-new")) {
    // Look back further than one interval so a scan that errored (or a short restart) doesn't
    // leave a hole in the feed; scanNewPools dedupes against the persistent universe anyway.
    const fresh = await scanNewPools({ lookbackMin: Math.max(30, s.intervalMin * 4) }).catch((e: Error) => {
      log.warn(`onchain-new failed: ${e.message.slice(0, 70)}`);
      return [];
    });
    for (const p of fresh) ordered.push({ sighting: p, source: "onchain-new", spikeX: 0 });
  }
  if (!ordered.length) return { hits: [], scanned: 0 };

  // Collapse to one entry per TOKEN (a token can open five pools in a block) keeping the first —
  // spikes precede new pools above, so a token that is both is treated as a spike.
  const byToken = new Map<string, { sighting: PoolSighting; source: ScanSource; spikeX: number }>();
  for (const o of ordered) {
    const k = o.sighting.token.toLowerCase();
    if (!byToken.has(k)) byToken.set(k, o);
  }
  const scanned = byToken.size;

  const ttl = probeTtlMs();
  const batch = [...byToken.values()]
    .filter((o) => {
      const k = o.sighting.token.toLowerCase();
      if (!cooled(o.sighting.token)) return false;
      return now - (probed.get(k) ?? 0) >= ttl;
    })
    .slice(0, ONCHAIN_QUALIFY_CAP);
  if (!batch.length) return { hits: [], scanned };

  const { mapLimit } = await import("../chain/blockscout.js");
  const { tokenMeta } = await import("../chain/tokens.js");
  const measured = await mapLimit(batch, 4, async (o) => {
    probed.set(o.sighting.token.toLowerCase(), now); // mark probed even on failure — that's the point of the cache
    const pool = await qualifyCandidate(o.sighting.token).catch(() => null);
    if (!pool) return null;
    const meta = await tokenMeta(o.sighting.token).catch(() => null);
    const c: OnchainCandidate = {
      address: o.sighting.token,
      symbol: meta?.symbol ?? o.sighting.token.slice(0, 8),
      // No name() on ERC-20's required surface here; the symbol is what the util/meme classifier
      // has to work with, so it is used for both rather than left blank.
      name: meta?.symbol ?? "",
      source: o.source,
      venue: o.sighting.venue,
      fee: pool.fee,
      vol24h: pool.volUsd,
      volH1: pool.volH1,
      liqUsd: pool.liqUsd,
      spikeX: pool.spikeX || o.spikeX,
      ageMs: o.sighting.firstSeen > 0 ? now - o.sighting.firstSeen : null,
      volSource: pool.volSource,
    };
    return { c, pool };
  });
  const rows = measured.filter((m): m is { c: OnchainCandidate; pool: QualifiedPool } => m !== null);
  if (!rows.length) return { hits: [], scanned };

  const screened = await screenOnchainCandidates(
    rows.map((m) => m.c),
    { llm: !!env.openrouterKey, limit: ONCHAIN_QUALIFY_CAP },
  );
  const poolOf = new Map(rows.map((m) => [m.c.address.toLowerCase(), m.pool]));
  const hits: Hit[] = [];
  for (const r of screened) {
    // Same floors as the GMGN path. The score is built from a smaller evidence base here (see
    // screen.ts), so these thresholds bite HARDER on-chain — deliberately.
    if (r.score < s.minScore || r.verdict === "skip") continue;
    const pool = poolOf.get(r.token.address.toLowerCase());
    if (pool) hits.push({ r, pool });
  }
  return { hits, scanned };
}

async function runScan(): Promise<{ found: number; scanned: number }> {
  const s = cfg.scan;
  const now = Date.now();
  const srcs = scanSources();
  stats.scans++;
  stats.lastAt = now;

  const held = await heldTokens();
  const skippedHeld = new Set<string>();
  // One predicate for both paths: out of alert cooldown AND not already an open position. Checked
  // BEFORE the expensive pool discovery, not after, so a held token costs nothing to skip — the
  // operator's rule ("if there's already a position in the token, skip") is unchanged, only cheaper.
  const cooled = (addr: string): boolean => {
    const k = addr.toLowerCase();
    if (held.has(k)) {
      skippedHeld.add(k);
      return false;
    }
    return now - (alerted.get(k) ?? 0) >= s.cooldownMin * 60_000;
  };

  const parts = await Promise.all([
    srcs.includes("gmgn-trending") ? fromGmgn(cooled) : Promise.resolve({ hits: [] as Hit[], scanned: 0 }),
    srcs.some((x) => x === "onchain-new" || x === "volume-spike") ? fromOnchain(now, srcs, cooled) : Promise.resolve({ hits: [] as Hit[], scanned: 0 }),
  ]);
  const scanned = parts.reduce((n, p) => n + p.scanned, 0);
  stats.lastScanned = scanned;
  if (skippedHeld.size) log.info(`skip ${skippedHeld.size} candidates — already have position in that token`);
  prune(probed, now, probeTtlMs() * 4);
  prune(alerted, now, Math.max(6 * 3600_000, s.cooldownMin * 60_000 * 4));

  // De-dupe across sources (a token can be both GMGN-trending and freshly-pooled) — first wins.
  const seen = new Set<string>();
  let found = 0;
  for (const q of parts.flatMap((p) => p.hits)) {
    const k = q.r.token.address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (held.has(k)) {
      log.info(`skip candidate ${q.r.token.symbol} — already have position in that token`);
      continue;
    }
    alerted.set(k, now);
    found++;
    stats.alerts++;
    const mc = q.r.token.marketCap ?? 0;
    log.info(
      `candidate ${q.r.token.symbol} [${q.r.source}] · mcap ${mc > 0 ? `$${(mc / 1e3).toFixed(0)}k` : "?"} · pool ${(q.pool.fee / 10000).toFixed(2)}% vol $${(q.pool.volUsd / 1e3).toFixed(1)}k fees $${q.pool.feesUsd.toFixed(0)} · spike ${q.pool.spikeX.toFixed(1)}x · score ${q.r.score}` +
        (q.r.unchecked.length ? ` · NOT CHECKED: ${q.r.unchecked.join(",")}` : ""),
    );
    hooks?.onCandidate(q.r, q.pool);
  }
  stats.lastFound = found;
  const uni = srcs.some((x) => x === "onchain-new" || x === "volume-spike") ? ` · universe ${poolUniverseStats().pools} pool` : "";
  log.info(`hunt scan [${srcs.join("+")}]: ${scanned} candidates → ${found} passed (pool ${(s.feeMinPpm / 10000).toFixed(0)}-${(s.feeMaxPpm / 10000).toFixed(0)}% active)${uni}`);
  return { found, scanned };
}
