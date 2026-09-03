/**
 * Token screener — Hermes' 24h thesis filter over GMGN trending data.
 *
 * Hard gates (server-side): mcap > $500k, vol > $1m, 24h interval.
 * Then, per the operator's playbook:
 *   • Robinhood favours UTILITY tokens — memes are fading → classify util/meme, reward util,
 *     penalise meme.
 *   • Drop anything launched on flap.fun.
 *   • Grade community clarity (real, non-recycled socials).
 *   • Read FOMO / traction (smart money, KOL, turnover, holders, momentum) and, when the LLM
 *     is enabled, generate a one-line thesis.
 */
import { gmgnTrending, type GmgnTrendToken } from "./gmgn.js";
import { DEFAULT_LLM_SCREEN_TIMEOUT_MS, llmScore, type LlmVerdict } from "./openrouter.js";
import { mapLimit } from "../chain/blockscout.js";
import { logger } from "../util/log.js";

const log = logger("screen");
const LLM_CACHE_MS = 6 * 60 * 60_000;
const LLM_SCREEN_TIMEOUT_MS = Math.max(15_000, Number(process.env.RH_LLM_SCREEN_TIMEOUT_MS) || DEFAULT_LLM_SCREEN_TIMEOUT_MS);
const llmCache = new Map<string, { at: number; verdict: LlmVerdict }>();

export interface ScreenOpts {
  minMarketCap?: number; // default 500_000
  minVolume?: number; // default 1_000_000
  minLiquidity?: number; // default 15_000 (must be tradeable)
  interval?: string; // default "24h"
  excludeFlap?: boolean; // default true
  llm?: boolean; // run LLM thesis on the top survivors
  llmTop?: number; // how many to send to the LLM (default 3)
  limit?: number; // final list size (default 15)
}

export interface ScreenResult {
  token: GmgnTrendToken;
  kind: "util" | "meme" | "unclear";
  community: "clear" | "thin" | "sus";
  fomo: number; // 0-100 traction read
  score: number; // 0-100 overall rank
  flags: string[]; // human-readable warnings / notes
  thesis?: string; // LLM one-liner (if enabled)
  verdict?: "ape" | "watch" | "skip";
  verdictSource?: "llm";
}

const MEME_RE = /(cat|dog|inu|shib|pepe|wojak|moon|elon|trump|doge|frog|chad|wif\b|bonk|floki|meme|baby|safe|rocket|\bape|kitty|puppy|lambo|degen|based|wagmi|\bgm\b|fud|coin|pump|hood|pump|milady|retard|cum|ballz|69|420)/i;
const UTIL_RE =
  /(protocol|finance|\bfi\b|swap|\bdex\b|\bai\b|agent|oracle|\brwa\b|chain|network|bridge|vault|index|lend|perp|stake|yield|\bdata\b|compute|\bgpu\b|node|infra|\bpay|bank|credit|trade|exchange|launch|tool|app|market|treasury|fund|asset|invest|stock|equit|bond|real|estate|game|social|identity)/i;

/** Best-effort utility vs meme call from name/symbol/site (LLM refines later). */
function classify(t: GmgnTrendToken): ScreenResult["kind"] {
  const hay = `${t.name} ${t.symbol}`.toLowerCase();
  const util = UTIL_RE.test(hay) || (!!t.website && UTIL_RE.test(t.website.toLowerCase()));
  const meme = MEME_RE.test(hay);
  if (util && !meme) return "util";
  if (meme && !util) return "meme";
  if (util && meme) return "unclear";
  // no keyword hit: a real site + non-joke name leans util; nothing leans unclear
  return t.website ? "util" : "unclear";
}

function communityGrade(t: GmgnTrendToken): { grade: ScreenResult["community"]; flags: string[] } {
  const flags: string[] = [];
  const socials = [t.twitter, t.website, t.telegram].filter(Boolean).length;
  const recycled = t.twitterDup >= 3 || t.telegramDup >= 3 || t.websiteDup >= 3;
  if (t.twitterChanged) flags.push("⚠️ renamed X account");
  if (recycled) flags.push("⚠️ recycled social account");
  if (!t.twitter) flags.push("no X account");
  if (!t.website) flags.push("no website");
  if (t.ctoFlag) flags.push("CTO");
  let grade: ScreenResult["community"];
  if (t.twitterChanged || recycled) grade = "sus";
  else if (socials >= 2) grade = "clear";
  else grade = "thin";
  return { grade, flags };
}

/** 0-100 traction / FOMO read. */
function fomoScore(t: GmgnTrendToken): number {
  const turnover = t.liquidity > 0 ? t.volume / t.liquidity : 0;
  const s =
    Math.min(25, t.smartWallets * 1.2) + // smart money
    Math.min(20, t.kolWallets * 0.4) + // KOL / renowned
    Math.min(20, Math.log10(1 + turnover) * 12) + // volume vs liquidity churn
    Math.min(10, Math.log10(1 + t.holders) * 3) + // holder base
    Math.min(15, Math.max(0, t.change24hPct) * 0.05) + // 24h momentum
    Math.min(10, t.hotLevel * 3 + Math.log10(1 + t.visitingCount) * 1.5); // heat / attention
  return Math.round(Math.max(0, Math.min(100, s)));
}

/** 0-25 safety points + flags (honeypot handled as a hard drop upstream). */
function safety(t: GmgnTrendToken): { pts: number; flags: string[] } {
  const flags: string[] = [];
  let pts = 25;
  const tax = Math.max(t.buyTax, t.sellTax) * 100;
  if (tax >= 5) {
    pts -= Math.min(10, tax - 4);
    flags.push(`tax ${tax.toFixed(0)}%`);
  }
  if (t.rugRatio > 0.3) { pts -= 6; flags.push(`rug ${(t.rugRatio * 100).toFixed(0)}%`); }
  if (t.top10Rate > 0.5) { pts -= 5; flags.push(`top10 ${(t.top10Rate * 100).toFixed(0)}%`); }
  if (t.bundlerRate > 0.3) { pts -= 4; flags.push(`bundler ${(t.bundlerRate * 100).toFixed(0)}%`); }
  if (t.entrapmentRatio > 0.6) { pts -= 4; flags.push(`entrap ${(t.entrapmentRatio * 100).toFixed(0)}%`); }
  if (t.devHoldRate > 0.1) { pts -= 3; flags.push(`dev ${(t.devHoldRate * 100).toFixed(0)}%`); }
  if (t.sniperHoldRate > 0.15) { pts -= 3; flags.push(`sniper hold ${(t.sniperHoldRate * 100).toFixed(0)}%`); }
  if (!t.isRenounced) flags.push("not renounced");
  else pts += 1;
  if (t.lockPercent >= 0.5 || t.burnStatus === "yes") pts += 1;
  return { pts: Math.max(0, Math.min(25, pts)), flags };
}

const SYSTEM = [
  "You are Hermes' token analyst for the Robinhood Chain. The operator's thesis: Robinhood users increasingly favour UTILITY tokens; pure memes are fading. You judge whether a trending token is worth a closer look for LP/entry.",
  "Weigh: (1) utility vs meme — real product/use-case beats a joke coin; (2) community clarity — genuine, active, non-recycled socials; (3) FOMO/thesis — is the momentum backed by smart money + a real narrative, or an empty pump about to fade?",
  "Given hard numbers already passed the mcap/volume gate. Be skeptical of thin liquidity, recycled socials, high dev/sniper holdings.",
  'Respond ONLY as compact JSON: {"score": <0-100 conviction>, "action": "ape"|"watch"|"skip", "summary": "<one English sentence, <160 chars: utility/meme + thesis + FOMO verdict>"}.',
].join(" ");

function llmPrompt(t: GmgnTrendToken, kind: string, community: string): string {
  return (
    "Evaluate this trending token:\n" +
    JSON.stringify(
      {
        name: t.name,
        symbol: t.symbol,
        heuristic_kind: kind,
        community: community,
        market_cap_usd: Math.round(t.marketCap),
        ath_market_cap_usd: Math.round(t.athMarketCap),
        volume_24h_usd: Math.round(t.volume),
        liquidity_usd: Math.round(t.liquidity),
        turnover_x: t.liquidity > 0 ? +(t.volume / t.liquidity).toFixed(1) : 0,
        price_change_24h_pct: +t.change24hPct.toFixed(1),
        holders: t.holders,
        smart_money_wallets: t.smartWallets,
        kol_wallets: t.kolWallets,
        top10_holder_rate: +t.top10Rate.toFixed(2),
        sniper_count: t.sniperCount,
        dev_hold_rate: +t.devHoldRate.toFixed(3),
        launchpad: t.launchpad,
        has_twitter: !!t.twitter,
        has_website: !!t.website,
        has_telegram: !!t.telegram,
        buy_tax: t.buyTax,
        sell_tax: t.sellTax,
      },
      null,
      0,
    )
  );
}

/** Run the screen. Returns ranked survivors (highest score first). */
export async function screenTokens(opts: ScreenOpts = {}): Promise<{ results: ScreenResult[]; scanned: number; excludedFlap: number; excludedUnsafe: number }> {
  const minMarketCap = opts.minMarketCap ?? 500_000;
  const minVolume = opts.minVolume ?? 1_000_000;
  const minLiquidity = opts.minLiquidity ?? 15_000;
  const excludeFlap = opts.excludeFlap !== false;

  const raw = await gmgnTrending({ interval: opts.interval ?? "24h", minMarketCap, minVolume, minLiquidity, orderBy: "volume", limit: 100 });
  const scanned = raw.length;
  let excludedFlap = 0;
  let excludedUnsafe = 0;

  const survivors: ScreenResult[] = [];
  for (const t of raw) {
    if (!t.address) continue;
    if (excludeFlap && /flap/i.test(t.launchpad + t.launchpadPlatform)) { excludedFlap++; continue; }
    if (t.isHoneypot || Math.max(t.buyTax, t.sellTax) * 100 > 15) { excludedUnsafe++; continue; }

    const kind = classify(t);
    const { grade, flags: cflags } = communityGrade(t);
    const fomo = fomoScore(t);
    const { pts: safePts, flags: sflags } = safety(t);

    const utilAdj = kind === "util" ? 10 : kind === "meme" ? -15 : 0;
    const commPts = grade === "clear" ? 25 : grade === "thin" ? 10 : 0;
    const score = Math.round(Math.max(0, Math.min(100, fomo * 0.4 + commPts + safePts + utilAdj)));

    survivors.push({ token: t, kind, community: grade, fomo, score, flags: [...cflags, ...sflags] });
  }

  survivors.sort((a, b) => b.score - a.score);
  const trimmed = survivors.slice(0, opts.limit ?? 15);

  // LLM thesis on the top survivors (best-effort, bounded concurrency)
  if (opts.llm) {
    const top = trimmed.slice(0, opts.llmTop ?? 3);
    await mapLimit(top, 1, async (r) => {
      const cacheKey = r.token.address.toLowerCase();
      const cached = llmCache.get(cacheKey);
      if (cached && Date.now() - cached.at < LLM_CACHE_MS) {
        r.thesis = cached.verdict.summary;
        r.verdict = cached.verdict.action;
        r.verdictSource = "llm";
        r.score = Math.round(r.score * 0.7 + cached.verdict.score * 0.3);
        return;
      }
      // Nemotron's free endpoint has >12s median latency; allow a normal response to finish while
      // still bounding a stuck provider. A real model verdict is required by Auto-LP when enabled.
      const v: LlmVerdict | null = await llmScore(SYSTEM, llmPrompt(r.token, r.kind, r.community), { timeoutMs: LLM_SCREEN_TIMEOUT_MS, retries: 1 }).catch(() => null);
      if (v) {
        llmCache.set(cacheKey, { at: Date.now(), verdict: v });
        r.thesis = v.summary;
        r.verdict = v.action;
        r.verdictSource = "llm";
        // blend LLM conviction into the rank (30% weight)
        r.score = Math.round(r.score * 0.7 + v.score * 0.3);
      }
    });
    trimmed.sort((a, b) => b.score - a.score);
  }

  log.info(`screen: ${scanned} trending → ${survivors.length} passed (flap -${excludedFlap}, unsafe -${excludedUnsafe})`);
  return { results: trimmed, scanned, excludedFlap, excludedUnsafe };
}
