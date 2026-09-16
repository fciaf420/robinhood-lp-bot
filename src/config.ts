/**
 * Config = chain profile (chains/<chain>.json) + strategy tunables (config.json) + secrets (.env).
 *
 * Split, and why:
 *   chains/<key>.json  WHERE we trade — chainId, RPC, contracts, gas policy, capability flags.
 *                      Picked by RH_CHAIN (unset = robinhood). See chain/profile.ts.
 *   config.json        HOW we trade — lp/watch/feed/radar/autoLp/scan. Chain-agnostic, safe to
 *                      commit. config.<key>.json optionally overlays it for a non-default chain.
 *   .env               private key, RPC URLs, Telegram token, OWNER chat id (the auth boundary).
 *                      Anything money- or identity-sensitive lives here only.
 *
 * The exported `cfg` / `C` shape is UNCHANGED by the chain split: the chain keys are simply
 * sourced from the profile instead of from config.json, so every other module keeps working and
 * the live Robinhood bot (RH_CHAIN unset) loads exactly the values it loaded before.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CHAIN, ProfileContractsSchema } from "./chain/profile.js";
import { CHAIN_KEY, DEFAULT_CHAIN, ROOT, writeJson } from "./util/files.js";
import { logger } from "./util/log.js";

const log = logger("config");
const IS_DEFAULT_CHAIN = CHAIN_KEY === DEFAULT_CHAIN;
/** Strategy base — shared by every chain. */
const CONFIG_FILE = path.join(ROOT, "config.json");
/** Per-chain strategy overlay. Only for non-default chains: on Robinhood config.json IS the file
 *  /set writes to, and a stray config.robinhood.json silently overriding it would be a trap. */
const OVERLAY_FILE = IS_DEFAULT_CHAIN ? "" : path.join(ROOT, `config.${CHAIN_KEY}.json`);
/** Where persist()/`/set` writes. Never the profile — addresses are not runtime-tunable. */
const PERSIST_FILE = IS_DEFAULT_CHAIN ? CONFIG_FILE : OVERLAY_FILE;

/**
 * Arc has NO wrapped native (no WETH9 exists), but `C.weth` is a plain string in ~40 call sites.
 * It is filled with the zero address there ON PURPOSE: every comparison against it fails to match
 * (so no token is ever mistaken for WETH) and any contract call to it reverts loudly instead of
 * silently swapping the wrong asset. hasWrappedNative() is the guard those paths check.
 */
const NO_WETH = "0x0000000000000000000000000000000000000000";

/**
 * Contracts deployed at the SAME CREATE2 address on every chain the bot targets. A profile may
 * still pin its own (chains/arc.json pins both), so the profile always wins; these are the
 * fallback when it says nothing.
 *
 * Resolved HERE, once, rather than as a `C.x ?? "0x…"` at each use. There were four such
 * fallbacks across v4/{mint,swap,discover,list}.ts — two spellings of Permit2 and two of
 * Multicall3 — and two copies of an address constant is two places for a chain to be half
 * migrated. Multicall3 only ever costs speed if it is wrong (every caller falls back to per-pool
 * reads), but Permit2 is an APPROVAL TARGET: approving the wrong one reverts inside SETTLE_ALL
 * with a bare "execution reverted", which is the least debuggable failure in the v4 swap path.
 */
const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const CANONICAL_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Same contract set as the profile, but `weth`, `permit2` and `multicall` are ALWAYS present
// (see NO_WETH and the canonical addresses above) so nothing downstream deals with an optional.
const ContractsSchema = ProfileContractsSchema.extend({
  weth: z.string(),
  permit2: z.string(),
  multicall: z.string(),
  extraV3Factories: z.array(z.string()).default([]),
});

const LpSchema = z.object({
  widthPct: z.number().positive().default(50),
  depositUsd: z.number().default(20),
  // feeTiers = ALL tiers, used for quoting/sell-routing (keep complete). On Robinhood v3
  // only 100/500/3000/10000 are enabled; 3-25% tiers live on v4 (not yet supported).
  feeTiers: z.array(z.number().int()).nonempty().default([10000, 3000, 500, 100]),
  // minFeePpm = LP fee floor (hundredths of a bip). Memecoin fees are thin at low tiers,
  // so LP (manual pick prefers, auto-LP requires) targets fee >= this. 3000 = 0.3%.
  minFeePpm: z.number().int().default(3000),
  preferHighestFee: z.boolean().default(true), // pick the highest eligible fee pool
  slippagePct: z.number().min(0).max(50).default(5),
  autoWrap: z.boolean().default(true),
  rangeBufferSpacings: z.number().int().default(2),
  nativeTargetEth: z.number().min(0).default(0.015),
  autoSwapOnClose: z.boolean().default(true),
  minPoolTvlUsd: z.number().min(0).default(2000), // hide pools below this total liquidity ($) in the LP picker
});

const WatchSchema = z.object({
  enabled: z.boolean().default(true),
  intervalSec: z.number().int().positive().default(120),
  minVol5m: z.number().default(150000),
  riseFactor: z.number().default(1.4),
  minVol1h: z.number().default(300000),
  minLiqUsd: z.number().default(50000),
  maxTaxPct: z.number().default(6),
  cooldownMin: z.number().default(60),
  maxTokens: z.number().int().default(300),
});

// Real-time sequencer-feed monitor (see src/feed/). Opt-in (advanced).
const FeedSchema = z.object({
  enabled: z.boolean().default(false),
  newToken: z.boolean().default(true), // alert on fresh WETH pools / first mints
  positionMonitor: z.boolean().default(true), // watch swaps hitting YOUR pools + range
  autoCloseOutOfRange: z.boolean().default(false), // DANGER: auto-close when price leaves range
  newTokenMinWethSeed: z.number().min(0).default(0.02), // ignore micro launches
  activityThreshold: z.number().int().positive().default(3), // swaps before a tick re-check
  cooldownMin: z.number().default(30),
});

// LLM radar (OpenRouter) + GMGN enrichment for candidate scoring/confirmation.
const RadarSchema = z.object({
  enabled: z.boolean().default(false), // needs RH_OPENROUTER_KEY too
  useGmgn: z.boolean().default(true), // enrich with GMGN (needs configured gmgn-cli)
  attachToNewToken: z.boolean().default(true),
  attachToWatch: z.boolean().default(true),
});

// Autonomous LP: candidate → radar confirm → auto-open. DANGEROUS (spends funds
// unattended). Default OFF with conservative caps; every gate must pass.
const AutoLpSchema = z.object({
  enabled: z.boolean().default(false),
  sizeEth: z.number().positive().default(0.001), // ETH per auto position
  mode: z.enum(["single", "inrange"]).default("single"), // single = rug-safe
  minScore: z.number().min(0).max(100).default(75), // radar LLM score floor
  requireAction: z.enum(["ape", "watch", "skip"]).default("ape"),
  requireLlm: z.boolean().default(true), // need an LLM verdict, not just GMGN
  requireGmgn: z.boolean().default(false),
  minLiqUsd: z.number().default(20000), // hard liquidity floor
  maxTaxPct: z.number().default(5), // hard tax ceiling (GMGN)
  maxOpen: z.number().int().default(3), // max concurrent LP positions total
  maxPerHour: z.number().int().default(2), // rate limit
  dailyCapEth: z.number().default(0.01), // max ETH auto-deployed per 24h
  sources: z.array(z.enum(["feed-new", "watch-spike", "hunt"])).default(["watch-spike", "hunt"]),
  // ── auto-CLOSE (manage loop, opt-in per trigger; 0/false = off) ──
  tpPct: z.number().default(0), // take-profit: close when PnL% ≥ this
  slPct: z.number().default(0), // stop-loss: close when PnL% ≤ -this
  closeOor: z.boolean().default(false), // close positions that drift OUT OF RANGE
  oorGraceMin: z.number().default(30), // wait this long OOR before closing (single-side parks are OOR by design)
  oorCooldownCount: z.number().int().default(3), // #2 OOR cooldown: after this many OOR-closes, blacklist the token
  oorCooldownHours: z.number().default(12), // #2 OOR cooldown: ...for this long (stop re-entering a token that never fills)
  // #1 rebalance-on-OOR: "close" = just close an OOR position (default). "rebalance" = close it THEN
  // re-open the same token recentered on the current price (volatility-adaptive width) so the capital
  // keeps earning instead of sitting idle in ETH. The OOR cooldown (above) caps the rebalance churn.
  oorAction: z.enum(["close", "rebalance"]).default("close"),
  // #3 fee-compound: harvest an in-range position's accrued fees and add them BACK as liquidity
  // (compounding, no swap → no drag) once they clear compoundMinUsd. OFF by default.
  compound: z.boolean().default(false),
  compoundMinUsd: z.number().default(0.5), // only compound when uncollected fees ≥ this ($)
  // #3 volume-FADE exit (Meteora "exit when volume fades"): close a position once its pool's current
  // hour drops below this × the 24h-average hour (spikeX < volFadeX = the spike is over → rotate out).
  // 0 = off. e.g. 0.35 = close when the current hour is under 35% of the pool's average hour.
  volFadeX: z.number().default(0),
  // #3 volume-fade age guard: don't let VFADE close a position younger than this (minutes). Stops the
  // "enter → instantly fade-exit" trap when the entry spike (minSpikeX) sits near volFadeX — the fresh
  // position needs time to actually earn fees before a momentary volume dip is allowed to close it.
  vfadeMinAgeMin: z.number().default(20),
  // fee-velocity exit: close an IN-RANGE position whose RECENT fee-earning rate ($/h, measured over a
  // rolling window) drops below this floor → the pool stopped being productive, so evict it and free the
  // slot for a live candidate. 0 = off. The direct "is this LP actually earning?" signal, complementing
  // the volume-proxy volFadeX. feeGraceMin protects a slow-starter from being cut too early.
  minFeePerHourUsd: z.number().default(0),
  feeGraceMin: z.number().default(30), // min position age (min) before fee-velocity can fire
  manageSec: z.number().int().positive().default(90), // manage-loop interval (seconds)
});

// Quality-candidate hunter: poll GMGN trending → screen (thesis + LLM) → keep only tokens that
// have a v4 pool in the target fee band (3-5%) with real 24h volume → alert with 1-tap LP.
// Replaces the noisy "every new token/pool" feed spam with focused, farmable candidates.
const ScanSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMin: z.number().int().positive().default(3),
  // Which candidate FEEDS the hunter runs (radar/scanLoop.ts scanSources()). Declared here because
  // zod STRIPS undeclared keys: without this line a `scan.sources` written into config.json by a
  // human parses away to undefined and the operator's override silently does nothing.
  // Deliberately `.optional()` with no default — absent means "let the chain profile decide"
  // (gmgn-trending on a GMGN chain, the two on-chain sources elsewhere), which is not the same
  // statement as any fixed list, and a default here would freeze one chain's answer into both.
  // The union mirrors ScanSource in radar/screen.ts; it is repeated rather than imported because
  // config.ts is the root of the import graph and screen.ts sits far downstream of it.
  sources: z.array(z.enum(["gmgn-trending", "onchain-new", "volume-spike"])).optional(),
  feeMinPpm: z.number().int().default(30000), // 3.00%
  feeMaxPpm: z.number().int().default(50000), // 5.00%
  minVolUsd: z.number().default(10000), // pool 24h volume floor ("tx rame")
  minPoolFeesUsd: z.number().default(250), // #1 fee-yield: min 24h fees the pool generated (vol × fee%) — weights busy + HIGH-fee over raw volume
  minFeeYieldPct: z.number().default(0), // #1 fee-yield: min daily fee/TVL yield % — only enforced when TVL is readable (v4 singleton often reads $0 → skipped)
  // ANTI-WASH: reject pools with huge volume on near-zero REAL liquidity (e.g. $130k vol on $0.5k liq
  // = fake/wash volume + trap: your LP becomes ~all the liquidity). Only applied when liq is READABLE
  // (>0) — v4 singleton liq frequently reads $0 which we can't assess, so those aren't blocked here.
  minPoolLiqUsd: z.number().default(1000), // pool liquidity floor ($) — 0 = off
  maxVolLiqRatio: z.number().default(0), // reject when vol/liq exceeds this (wash indicator) — 0 = off
  // #1 volume-SPIKE (Meteora "volume is king"): require the pool's recent hour to be ≥ this × its
  // 24h-average hour (spikeX = volH1/(vol24h/24)). >1 = heating up NOW. 0 = off (don't gate on spike).
  minSpikeX: z.number().default(0),
  minScore: z.number().default(55), // screening score floor (0-100)
  cooldownMin: z.number().default(120), // don't re-alert the same token within this window
  // GMGN trending gates for the hunt — LOOSER than /screen (which targets big tokens), because
  // the 3-5% high-fee pools live on SMALLER tokens (a JACKET, not a VIRTUAL). These decide which
  // tokens get to the per-token 3-5%-pool check.
  screenMinMcap: z.number().default(20000),
  screenMaxMcap: z.number().default(0), // 0 = no ceiling. Set to farm SMALL-cap pools: for a fixed small position, a smaller pool = bigger fee share = faster fees.
  screenMinVol: z.number().default(50000),
  screenMinLiq: z.number().default(3000),
});

const ConfigSchema = z.object({
  rpcUrl: z.string(),
  chainId: z.number().int(),
  explorer: z.string(),
  contracts: ContractsSchema,
  lp: LpSchema,
  gasPriceGwei: z.number().default(0),
  watch: WatchSchema,
  feed: FeedSchema.default({}),
  radar: RadarSchema.default({}),
  autoLp: AutoLpSchema.default({}),
  scan: ScanSchema.default({}),
  telegramChatId: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LpConfig = z.infer<typeof LpSchema>;
export type WatchConfig = z.infer<typeof WatchSchema>;
export type FeedConfig = z.infer<typeof FeedSchema>;
export type RadarConfig = z.infer<typeof RadarSchema>;
export type AutoLpConfig = z.infer<typeof AutoLpSchema>;
export type ScanConfig = z.infer<typeof ScanSchema>;

/** Strategy sections that are merged KEY-BY-KEY (overlay/persist), not replaced wholesale, so a
 *  partial config.<chain>.json only has to name the fields it actually changes. */
const SECTIONS = ["lp", "watch", "feed", "radar", "autoLp", "scan"] as const;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

/** base ⊕ overlay, one level deep on the known sections. Same merge persist() has always used. */
function mergeStrategy(base: Raw, over: Raw): Raw {
  const out: Raw = { ...base, ...over };
  for (const s of SECTIONS) {
    if (isObj(base[s]) || isObj(over[s])) {
      out[s] = { ...(isObj(base[s]) ? base[s] : {}), ...(isObj(over[s]) ? over[s] : {}) };
    }
  }
  return out;
}

function readRaw(file: string, required: boolean): Raw {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObj(v) ? v : {};
  } catch (e) {
    if (required) throw new Error(`config.json unreadable: ${(e as Error).message}`);
    return {}; // overlay is optional — absent means "no per-chain override"
  }
}

function load(): Config {
  const raw = mergeStrategy(readRaw(CONFIG_FILE, true), OVERLAY_FILE ? readRaw(OVERLAY_FILE, false) : {});
  // Chain keys come from the profile and OVERRIDE whatever config.json still carries. config.json
  // keeps its old rpcUrl/chainId/explorer/contracts block (identical to chains/robinhood.json) —
  // ignoring it here is what lets the Arc process share the same strategy file without ever
  // reading Robinhood's addresses.
  const merged: Raw = {
    ...raw,
    rpcUrl: CHAIN.rpcUrl,
    chainId: CHAIN.chainId,
    explorer: CHAIN.explorer.url,
    contracts: {
      ...CHAIN.contracts,
      weth: CHAIN.contracts.weth ?? CHAIN.native.wrapped ?? NO_WETH,
      permit2: CHAIN.contracts.permit2 ?? CANONICAL_PERMIT2,
      multicall: CHAIN.contracts.multicall ?? CANONICAL_MULTICALL3,
      extraV3Factories: CHAIN.contracts.extraV3Factories ?? [],
    },
  };
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    log.error("config.json invalid", parsed.error.flatten().fieldErrors);
    throw new Error("config.json failed validation — check fields above.");
  }
  return parsed.data;
}

/** Mutable in-memory config. /set mutates this and calls persist(). */
export const cfg: Config = load();
export const C = cfg.contracts;

/**
 * Persist current config back to disk. MERGE with what's on disk so a concurrent edit
 * of an unrelated key isn't clobbered by our in-memory snapshot.
 *
 * Writes STRATEGY ONLY. rpcUrl/chainId/explorer/contracts now live in the chain profile, so
 * writing them back would (a) re-materialise Robinhood's addresses into a file the Arc process
 * also reads and (b) let a `/set` silently fork the address book away from chains/*.json. The
 * existing chain block in config.json is left exactly as it is by the `...disk` spread.
 */
export function persist(): void {
  const disk = readRaw(PERSIST_FILE, false);
  const strategy: Raw = {
    lp: cfg.lp,
    gasPriceGwei: cfg.gasPriceGwei,
    watch: cfg.watch,
    feed: cfg.feed,
    radar: cfg.radar,
    autoLp: cfg.autoLp,
    scan: cfg.scan,
  };
  if (cfg.telegramChatId !== undefined) strategy.telegramChatId = cfg.telegramChatId;
  writeJson(PERSIST_FILE, mergeStrategy(disk, strategy));
}

// ── Secrets & identity (env only) ──
/**
 * RPC URLs are CHAIN-SPECIFIC. On a non-default chain the RH_* RPC vars are IGNORED: a second
 * process started with the Robinhood .env still in the environment would otherwise sign
 * Arc-intended transactions against a chainId-4663 node (the provider is constructed with a
 * static network, so ethers would not catch the mismatch). Use <CHAIN>_RPC_URL instead —
 * ARC_RPC_URL, which is also what scripts/probe-arc.ts reads.
 */
const ignoredEnv: string[] = [];
function rpcVar(rhName: string, chainName: string, fallback: string): string {
  const rh = (process.env[rhName] || "").trim();
  if (IS_DEFAULT_CHAIN) return rh || fallback;
  const own = (process.env[`${CHAIN_KEY.toUpperCase()}_${chainName}`] || "").trim();
  if (rh) ignoredEnv.push(rhName);
  return own || fallback;
}

export const env = {
  rpcUrl: rpcVar("RH_RPC_URL", "RPC_URL", cfg.rpcUrl),
  watchRpcUrl: rpcVar("RH_WATCH_RPC_URL", "WATCH_RPC_URL", ""),
  // dedicated RPC for the heavy v4 discovery getLogs (fromBlock=0 full-range) so a hunt-scan burst
  // can't rate-limit / slow the main RPC that LP ops (mint/close) need. Falls back to `provider`.
  logsRpcUrl: rpcVar("RH_LOGS_RPC_URL", "LOGS_RPC_URL", ""),
  walletKey: (process.env.RH_WALLET_KEY || "").trim(),
  tgToken: (process.env.RH_TG_TOKEN || "").trim(),
  /** OWNER chat id — the auth boundary. Only this chat may command the bot. */
  ownerChat: (process.env.RH_TG_CHAT || cfg.telegramChatId || "").trim(),
  // fast-submit: broadcast raw txs straight to the sequencer (skip Alchemy relay hop). Only a
  // chain that HAS a sequencer can do this — Arc is a validator L1, so the flag is forced off
  // there and the plain JsonRpcProvider is used (see chain/client.ts).
  fastSubmit: !!CHAIN.sequencer && /^(1|true|yes|on)$/i.test(process.env.RH_FAST_SUBMIT?.trim() || ""),
  sequencerUrl: CHAIN.sequencer ? process.env.RH_SEQUENCER_URL?.trim() || CHAIN.sequencer : "",
  sequencerIp: CHAIN.sequencer ? process.env.RH_SEQUENCER_IP?.trim() || "" : "",
  // LLM radar — any OpenAI-compatible endpoint (OpenRouter default; override RH_OPENROUTER_URL
  // for a custom gateway, e.g. agentcash). + GMGN enrichment.
  openrouterKey: (process.env.RH_OPENROUTER_KEY || "").trim(),
  openrouterUrl: process.env.RH_OPENROUTER_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions",
  openrouterModel: process.env.RH_OPENROUTER_MODEL?.trim() || "nvidia/nemotron-3-super-120b-a12b:free",
  // Daily-briefing LLM (a smarter model for the once-a-day analysis). Falls back to the same gateway
  // + key the screener already uses (RH_OPENROUTER_*, both SECRET / private-gateway URL → .env only)
  // so neither the key nor the gateway host is ever committed; only the MODEL differs
  // (cc/claude-sonnet-5). Override per-var via RH_BRIEF_* to point the briefing at a different gateway.
  briefUrl: process.env.RH_BRIEF_URL?.trim() || process.env.RH_OPENROUTER_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions",
  briefKey: (process.env.RH_BRIEF_KEY || process.env.RH_OPENROUTER_KEY || "").trim(),
  briefModel: process.env.RH_BRIEF_MODEL?.trim() || "cc/claude-sonnet-5",
  gmgnKey: (process.env.RH_GMGN_KEY || "").trim(),
  // KyberSwap aggregator — best-route swaps (auto multi-hop across all pools/fee-tiers/hooks).
  // Used to acquire the token side before an in-range LP (far better execution than swapping on
  // the fee-tier pool you're farming). Router is a hard whitelist: calldata is only ever sent here.
  kyberBase: (process.env.KYBERSWAP_AGGREGATOR_API_BASE_URL || "https://aggregator-api.kyberswap.com").trim().replace(/\/$/, ""),
  // Chain slug in the aggregator URL. null in the profile = Kyber has no route API for this chain
  // (unverified on Arc until `npm run probe:arc` says otherwise).
  kyberChain: (process.env.KYBERSWAP_CHAIN || CHAIN.data.kyberChain || "").trim(),
  // The router is a HARD WHITELIST — swap calldata is only ever sent to this address. When the
  // profile says the aggregator doesn't serve this chain, the address is dropped so kyberEnabled()
  // stays false: a copied-over KYBERSWAP_ROUTER_ADDRESS would otherwise build `${base}//api/v1`
  // requests and, worse, point a swap at a router deployed on a DIFFERENT chain.
  kyberRouter: CHAIN.data.kyberChain ? (process.env.KYBERSWAP_ROUTER_ADDRESS || "").trim() : "",
};

if (ignoredEnv.length) {
  log.warn(`chain ${CHAIN_KEY}: ${ignoredEnv.join(", ")} ignored (those are other chain's RPCs) — use ${CHAIN_KEY.toUpperCase()}_RPC_URL.`);
}
if (!CHAIN.data.kyberChain && (process.env.KYBERSWAP_ROUTER_ADDRESS || "").trim()) {
  log.warn(`chain ${CHAIN_KEY}: KYBERSWAP_ROUTER_ADDRESS ignored — profile says Kyber doesn't support this chain yet (router "${CHAIN.data.router}").`);
}
if (!CHAIN.sequencer && /^(1|true|yes|on)$/i.test(process.env.RH_FAST_SUBMIT?.trim() || "")) {
  log.warn(`chain ${CHAIN_KEY}: RH_FAST_SUBMIT ignored — this chain has no sequencer.`);
}

/** Fail fast at startup if a required secret is missing or malformed. */
export function assertSecrets(): void {
  if (!env.tgToken) throw new Error("RH_TG_TOKEN not set in .env");
  if (!env.walletKey) throw new Error("RH_WALLET_KEY not set in .env");
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.walletKey)) {
    throw new Error("RH_WALLET_KEY bad format — must be 0x + 64 hex.");
  }
  if (!env.ownerChat) {
    log.warn(
      "RH_TG_CHAT not set — bot will lock to the FIRST chat that sends /start, " +
        "then reject others. Set RH_TG_CHAT in .env to lock permanently.",
    );
  }
}
