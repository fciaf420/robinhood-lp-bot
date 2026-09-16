/**
 * GMGN enrichment via the `gmgn-cli`. Best-effort: if the CLI is missing or not configured
 * (keypair + GMGN_API_KEY must match, set up on the machine that generated the key), every
 * call returns null and the radar degrades gracefully.
 *
 * Setup on the host that runs the bot:
 *   npm install -g gmgn-cli
 *   gmgn-cli config              # generates keypair, prints a URL
 *   # open the URL, create the API key bound to the shown public key, then:
 *   gmgn-cli config --apply <API_KEY>
 *
 * CHAIN COVERAGE (profile `data.gmgn`): GMGN indexes Robinhood Chain, NOT Arc. On a chain it
 * does not cover every call here short-circuits — WITHOUT spawning the CLI, which would happily
 * answer `--chain arc` with an empty/garbage row that the screener cannot tell apart from a
 * genuine "this token is clean". The safety gates that ONLY GMGN can answer (honeypot flag, buy/
 * sell tax, holder concentration, sniper/dev/bundler stats) must then be reported as UNKNOWN,
 * never as 0 — see GMGN_ONLY_GATES and screen.ts's `unchecked` list.
 */
import { execFile } from "node:child_process";
import { CHAIN } from "../chain/profile.js";
import { logger } from "../util/log.js";

const log = logger("gmgn");
/** GMGN's own chain slug. It matches our profile key on the one chain GMGN covers (robinhood). */
const GMGN_CHAIN = CHAIN.key;
const TIMEOUT = 12_000;

/**
 * The gates NOTHING ELSE on this bot can evaluate. When GMGN is off these are UNCHECKED, and a
 * caller must surface them as such — "0% tax" and "tax never measured" are not the same claim,
 * and treating the second as the first is how a honeypot walks through a safety filter.
 */
export const GMGN_ONLY_GATES = ["honeypot", "buy/sell tax", "top10 holder", "rug ratio", "sniper/dev/bundler", "smart-money/KOL"] as const;

/** Does the ACTIVE chain have GMGN coverage at all? (Profile flag — not a CLI probe.) */
export function gmgnSupported(): boolean {
  return CHAIN.data.gmgn;
}

let available: boolean | null = null;

/** Run a gmgn-cli sub-command with --raw and parse JSON. Returns null on any failure. */
function run(args: string[]): Promise<any | null> {
  return new Promise((resolve) => {
    execFile("gmgn-cli", args, { timeout: TIMEOUT, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(null);
      }
    });
  });
}

/** One-time availability probe (chain covered + CLI present + configured). */
export async function gmgnAvailable(): Promise<boolean> {
  if (available !== null) return available;
  // Chain gate FIRST: never spawn the CLI for a chain GMGN doesn't index. `gmgn-cli config --check`
  // would succeed (it only validates the local keypair), so without this the bot would go on to
  // query `--chain arc`, get an empty row back, and read it as "no flags = safe".
  if (!gmgnSupported()) {
    available = false;
    log.info(`GMGN nggak cover chain ${CHAIN.name} — gate honeypot/tax/holder JADI UNKNOWN, bukan "aman"`);
    return false;
  }
  const r = await new Promise<boolean>((resolve) => {
    execFile("gmgn-cli", ["config", "--check"], { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
  });
  available = r;
  if (!r) log.info("gmgn-cli tidak tersedia / belum dikonfigurasi — enrichment GMGN dilewati");
  return r;
}

export interface GmgnData {
  symbol?: string;
  priceUsd?: number;
  marketCap?: number;
  liquidityUsd?: number;
  holders?: number;
  smartWallets?: number; // smart money holders
  kolWallets?: number;
  // security
  isHoneypot?: string; // "yes"/"no"/""
  buyTax?: number;
  sellTax?: number;
  rugRatio?: number;
  top10Rate?: number;
  ownerRenounced?: string;
  sniperCount?: number;
  devHolding?: string;
}

/** One trending-token row from `gmgn-cli market trending` (fields we screen on). */
export interface GmgnTrendToken {
  address: string;
  name: string;
  symbol: string;
  priceUsd: number;
  change24hPct: number; // price change over the chosen interval
  change1hPct: number;
  volume: number;
  liquidity: number;
  marketCap: number;
  athMarketCap: number; // history_highest_market_cap
  swaps: number;
  buys: number;
  sells: number;
  holders: number;
  top10Rate: number;
  launchpad: string; // e.g. "flap", "noxa"
  launchpadPlatform: string; // e.g. "flap_stocks"
  twitter: string;
  website: string;
  telegram: string;
  twitterDup: number;
  telegramDup: number;
  websiteDup: number;
  twitterChanged: boolean;
  ctoFlag: boolean; // community takeover
  isOg: boolean;
  smartWallets: number; // smart_degen_count
  kolWallets: number; // renowned_count
  sniperCount: number;
  botDegenCount: number;
  visitingCount: number;
  hotLevel: number;
  rugRatio: number;
  bundlerRate: number;
  entrapmentRatio: number;
  devHoldRate: number;
  sniperHoldRate: number;
  buyTax: number;
  sellTax: number;
  isHoneypot: boolean;
  isRenounced: boolean;
  isOpenSource: boolean;
  lockPercent: number;
  burnStatus: string;
  ageMs: number | null; // from creation_timestamp
}

export interface TrendingOpts {
  interval?: string; // 1m/5m/1h/6h/24h
  minMarketCap?: number;
  minVolume?: number;
  minLiquidity?: number;
  limit?: number;
  orderBy?: string; // default/volume/swaps/marketcap/holder_count/...
}

/** Query trending tokens (server-side filtered). Returns [] if the CLI is unavailable. */
export async function gmgnTrending(opts: TrendingOpts = {}): Promise<GmgnTrendToken[]> {
  if (!(await gmgnAvailable())) return [];
  const args = ["market", "trending", "--chain", GMGN_CHAIN, "--interval", opts.interval ?? "24h", "--limit", String(opts.limit ?? 100), "--raw"];
  if (opts.minMarketCap != null) args.push("--min-marketcap", String(opts.minMarketCap));
  if (opts.minVolume != null) args.push("--min-volume", String(opts.minVolume));
  if (opts.minLiquidity != null) args.push("--min-liquidity", String(opts.minLiquidity));
  if (opts.orderBy) args.push("--order-by", opts.orderBy, "--direction", "desc");
  const raw = await run(args);
  const rows: any[] = raw?.data?.rank ?? raw?.rank ?? (Array.isArray(raw?.data) ? raw.data : []);
  if (!Array.isArray(rows)) return [];
  const n = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);
  const now = Date.now();
  return rows.map((t): GmgnTrendToken => ({
    address: String(t.address ?? ""),
    name: String(t.name ?? ""),
    symbol: String(t.symbol ?? ""),
    priceUsd: n(t.price),
    change24hPct: n(t.price_change_percent),
    change1hPct: n(t.price_change_percent1h),
    volume: n(t.volume),
    liquidity: n(t.liquidity),
    marketCap: n(t.market_cap),
    athMarketCap: n(t.history_highest_market_cap),
    swaps: n(t.swaps),
    buys: n(t.buys),
    sells: n(t.sells),
    holders: n(t.holder_count),
    top10Rate: n(t.top_10_holder_rate),
    launchpad: String(t.launchpad ?? ""),
    launchpadPlatform: String(t.launchpad_platform ?? ""),
    twitter: String(t.twitter_username ?? ""),
    website: String(t.website ?? ""),
    telegram: String(t.telegram ?? ""),
    twitterDup: n(t.twitter_dup),
    telegramDup: n(t.telegram_dup),
    websiteDup: n(t.website_dup),
    twitterChanged: !!t.twitter_change_flag,
    ctoFlag: !!t.cto_flag,
    isOg: !!t.is_og,
    smartWallets: n(t.smart_degen_count),
    kolWallets: n(t.renowned_count),
    sniperCount: n(t.sniper_count),
    botDegenCount: n(t.bot_degen_count),
    visitingCount: n(t.visiting_count),
    hotLevel: n(t.hot_level),
    rugRatio: n(t.rug_ratio),
    bundlerRate: n(t.bundler_rate),
    entrapmentRatio: n(t.entrapment_ratio),
    devHoldRate: n(t.dev_team_hold_rate),
    sniperHoldRate: n(t.top70_sniper_hold_rate),
    buyTax: n(t.buy_tax),
    sellTax: n(t.sell_tax),
    isHoneypot: t.is_honeypot === 1 || t.is_honeypot === "1" || t.is_honeypot === true,
    isRenounced: t.is_renounced === 1 || t.is_renounced === "1" || t.is_renounced === true,
    isOpenSource: t.is_open_source === 1 || t.is_open_source === "1" || t.is_open_source === true,
    lockPercent: n(t.lock_percent),
    burnStatus: String(t.burn_status ?? ""),
    ageMs: t.creation_timestamp ? now - Number(t.creation_timestamp) * 1000 : null,
  }));
}

/** Fetch + flatten GMGN token info + security. null on a chain GMGN does not cover (= UNKNOWN). */
export async function gmgnToken(address: string): Promise<GmgnData | null> {
  if (!(await gmgnAvailable())) return null;
  const [info, sec] = await Promise.all([
    run(["token", "info", "--chain", GMGN_CHAIN, "--address", address, "--raw"]),
    run(["token", "security", "--chain", GMGN_CHAIN, "--address", address, "--raw"]),
  ]);
  if (!info && !sec) return null;
  const num = (v: unknown) => (v == null || v === "" ? undefined : Number(v));
  const price = num(info?.price?.price);
  const supply = num(info?.circulating_supply ?? info?.total_supply);
  return {
    symbol: info?.symbol,
    priceUsd: price,
    marketCap: price != null && supply != null ? price * supply : undefined,
    liquidityUsd: num(info?.liquidity),
    holders: num(info?.holder_count),
    smartWallets: num(info?.wallet_tags_stat?.smart_wallets),
    kolWallets: num(info?.wallet_tags_stat?.renowned_wallets),
    isHoneypot: sec?.is_honeypot,
    buyTax: num(sec?.buy_tax),
    sellTax: num(sec?.sell_tax),
    rugRatio: num(sec?.rug_ratio),
    top10Rate: num(sec?.top_10_holder_rate),
    ownerRenounced: sec?.owner_renounced,
    sniperCount: num(sec?.sniper_count),
    devHolding: sec?.creator_token_status,
  };
}
