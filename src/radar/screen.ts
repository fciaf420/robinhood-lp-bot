/**
 * Token screener — turns a raw candidate into a ranked, explained verdict.
 *
 * TWO INPUT SHAPES, ONE OUTPUT SHAPE:
 *
 *  • `screenTokens()`  — GMGN trending (Robinhood). Hermes' 24h thesis filter: mcap/volume gates
 *    server-side, then classify util/meme, drop flap.fun launches, grade community clarity, read
 *    FOMO, score safety from GMGN's security fields, optional LLM thesis.
 *
 *  • `screenOnchainCandidates()` — pools the CHAIN told us about (Arc, and any chain GMGN doesn't
 *    index). Same output type, same downstream pipeline, but built from what actually exists:
 *    on-chain volume/liquidity/fee/age plus the LLM.
 *
 * THE SAFETY-RELEVANT PART. GMGN is the ONLY source for honeypot flag, buy/sell tax, holder
 * concentration and sniper/dev/bundler stats. Without it those numbers are not 0 — they are
 * UNKNOWN, and the two must never be conflated: a zero-filled security block is indistinguishable
 * from a token that genuinely measured clean, which is exactly how a honeypot walks through a
 * safety filter. So the on-chain path:
 *   - awards ZERO points for any GMGN-only gate (it cannot earn credit it was never tested for),
 *   - lists every skipped gate in `ScreenResult.unchecked` so the alert can say so out loud,
 *   - tells the LLM, in the prompt, which gates were never run.
 * A token screened this way therefore scores STRUCTURALLY LOWER than a fully-vetted one. That is
 * the intended asymmetry, not a bug to tune away.
 */
import { gmgnTrending, gmgnSupported, GMGN_ONLY_GATES, type GmgnTrendToken } from "./gmgn.js";
import { llmScore, chainLabel, dataCaveat, type LlmVerdict } from "./openrouter.js";
import { mapLimit } from "../chain/blockscout.js";
import { logger } from "../util/log.js";

const log = logger("screen");

/** Where a candidate came from. Robinhood defaults to gmgn-trending; Arc to the on-chain pair. */
export type ScanSource = "gmgn-trending" | "onchain-new" | "volume-spike";

export interface ScreenOpts {
  minMarketCap?: number; // default 500_000
  minVolume?: number; // default 1_000_000
  minLiquidity?: number; // default 15_000 (must be tradeable)
  interval?: string; // default "24h"
  excludeFlap?: boolean; // default true
  llm?: boolean; // run LLM thesis on the top survivors
  llmTop?: number; // how many to send to the LLM (default 10)
  limit?: number; // final list size (default 15)
}

export interface ScreenResult {
  token: GmgnTrendToken;
  kind: "util" | "meme" | "unclear";
  // "unknown" = there IS no socials source on this chain, which is not the same as "thin" (we
  // looked and found little) or "sus" (we looked and it smelled). Kept distinct so the alert can
  // say which of the three happened.
  community: "clear" | "thin" | "sus" | "unknown";
  fomo: number; // 0-100 traction read
  score: number; // 0-100 overall rank
  flags: string[]; // human-readable warnings / notes
  thesis?: string; // LLM one-liner (if enabled)
  verdict?: "ape" | "watch" | "skip";
  /** Gates that were NEVER EVALUATED for this token. Non-empty = "not checked", NOT "passed". */
  unchecked: string[];
  source: ScanSource;
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
  if (t.twitterChanged) flags.push("⚠️ twitter di-rename");
  if (recycled) flags.push("⚠️ sosial daur-ulang");
  if (!t.twitter) flags.push("no X");
  if (!t.website) flags.push("no web");
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

function systemPrompt(): string {
  return [
    `You are Hermes' token analyst for ${chainLabel()}. The operator's thesis: this chain's users increasingly favour UTILITY tokens; pure memes are fading. You judge whether a trending token is worth a closer look for LP/entry.`,
    "Weigh: (1) utility vs meme — real product/use-case beats a joke coin; (2) community clarity — genuine, active, non-recycled socials; (3) FOMO/thesis — is the momentum backed by smart money + a real narrative, or an empty pump about to fade?",
    "Given hard numbers already passed the mcap/volume gate. Be skeptical of thin liquidity, recycled socials, high dev/sniper holdings.",
    dataCaveat(), // "" on a fully-covered chain → Robinhood's prompt is unchanged
    'Respond ONLY as compact JSON: {"score": <0-100 conviction>, "action": "ape"|"watch"|"skip", "summary": "<satu kalimat bahasa Indonesia, <160 char: util/meme + thesis + FOMO verdict>"}.',
  ]
    .filter(Boolean)
    .join(" ");
}

function llmPrompt(t: GmgnTrendToken, kind: string, community: string): string {
  return (
    "Nilai token trending ini:\n" +
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

/** Attach an LLM thesis to the top N (best-effort, bounded concurrency) and re-rank. */
async function attachLlm(rows: ScreenResult[], top: number, prompt: (r: ScreenResult) => string): Promise<void> {
  await mapLimit(rows.slice(0, top), 3, async (r) => {
    const v: LlmVerdict | null = await llmScore(systemPrompt(), prompt(r)).catch(() => null);
    if (v) {
      r.thesis = v.summary;
      r.verdict = v.action;
      // blend LLM conviction into the rank (30% weight)
      r.score = Math.round(r.score * 0.7 + v.score * 0.3);
    }
  });
  rows.sort((a, b) => b.score - a.score);
}

/** Run the GMGN screen. Returns ranked survivors (highest score first). */
export async function screenTokens(
  opts: ScreenOpts = {},
): Promise<{ results: ScreenResult[]; scanned: number; excludedFlap: number; excludedUnsafe: number; gmgnOff: boolean }> {
  const minMarketCap = opts.minMarketCap ?? 500_000;
  const minVolume = opts.minVolume ?? 1_000_000;
  const minLiquidity = opts.minLiquidity ?? 15_000;
  const excludeFlap = opts.excludeFlap !== false;
  // A chain without GMGN coverage returns 0 rows from gmgnTrending(). Reported as a FLAG rather
  // than as "0 trending tokens" so the caller can tell "GMGN says nothing is hot" apart from
  // "GMGN was never asked" — the /screen command shows a very different message for each.
  const gmgnOff = !gmgnSupported();

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

    // A row that came back from GMGN was measured against every GMGN gate by definition → nothing
    // is unchecked here. This is the ONLY path that may carry an empty `unchecked`.
    survivors.push({ token: t, kind, community: grade, fomo, score, flags: [...cflags, ...sflags], unchecked: [], source: "gmgn-trending" });
  }

  survivors.sort((a, b) => b.score - a.score);
  const trimmed = survivors.slice(0, opts.limit ?? 15);

  if (opts.llm) await attachLlm(trimmed, opts.llmTop ?? 10, (r) => llmPrompt(r.token, r.kind, r.community));

  log.info(`screen: ${scanned} trending → ${survivors.length} lolos (flap -${excludedFlap}, unsafe -${excludedUnsafe})`);
  return { results: trimmed, scanned, excludedFlap, excludedUnsafe, gmgnOff };
}

// ══════════════════════════ on-chain path (no GMGN) ══════════════════════════

/** What the chain itself can tell us about a candidate. Every field here is measurable on-chain. */
export interface OnchainCandidate {
  address: string;
  symbol: string;
  name: string;
  source: ScanSource;
  venue: "v3" | "v4";
  fee: number; // ppm
  vol24h: number;
  volH1: number;
  liqUsd: number;
  spikeX: number; // volH1 / (vol24h/24); 0 when 24h volume is 0
  ageMs: number | null; // since we first saw the pool — a floor on the pool's real age, never an over-estimate
  volSource: "dexscreener" | "onchain";
}

/**
 * Gates that simply do not exist without GMGN, named the way an operator reads them. Community is
 * listed separately from GMGN_ONLY_GATES because it degrades for a different reason: GMGN carries
 * the socials, but so would any social indexer — it isn't a security measurement.
 */
const ONCHAIN_UNCHECKED = [...GMGN_ONLY_GATES, "socials/komunitas", "mcap/holders"];

/**
 * FOMO from on-chain numbers only. Deliberately a DIFFERENT function from fomoScore(): that one
 * leans on smart-money/KOL/holder counts, none of which exist here, and feeding it zeros would
 * quietly cap every on-chain candidate at the turnover term while pretending it measured the rest.
 */
function onchainFomo(c: OnchainCandidate): number {
  const turnover = c.liqUsd > 0 ? c.vol24h / c.liqUsd : 0;
  const s =
    Math.min(35, Math.log10(1 + turnover) * 22) + // churn vs depth — the strongest honest signal we have
    Math.min(35, Math.max(0, c.spikeX - 1) * 14) + // heating up NOW (spikeX 1 = average hour, 3.5 = maxed)
    Math.min(30, Math.log10(1 + c.vol24h) * 6); // absolute volume — a $200k pool beats a $2k one
  return Math.round(Math.max(0, Math.min(100, s)));
}

/**
 * 0-12 points, and NOT called "safety" by accident — this is on-chain SANITY, a much weaker claim
 * than GMGN's security scan. It can only reward things we actually measured: readable depth, a
 * volume/liquidity ratio that isn't a wash pattern, and a pool old enough not to be a same-block
 * snipe. Nothing here credits the token for tax or honeypot, which were never tested.
 */
function onchainSanity(c: OnchainCandidate): { pts: number; flags: string[] } {
  const flags: string[] = [];
  let pts = 0;
  if (c.liqUsd > 0) {
    pts += 6;
    const ratio = c.vol24h / c.liqUsd;
    if (ratio > 50) flags.push(`⚠️ vol/liq ${ratio.toFixed(0)}× (pola wash)`);
    else pts += 3;
  } else {
    // v4's singleton PoolManager reports $0 TVL for live pools, so this is common and NOT a red
    // flag on its own — but it does mean the anti-wash check could not run.
    flags.push("liq ? (TVL nggak kebaca)");
  }
  if (c.ageMs != null && c.ageMs >= 15 * 60_000) pts += 3;
  else if (c.ageMs != null) flags.push(`pool baru ${Math.round(c.ageMs / 60_000)}m`);
  return { pts, flags };
}

/**
 * Build the GmgnTrendToken-shaped carrier the rest of the pipeline expects.
 *
 * The GMGN-only numeric fields are zeroed because the type requires them — that is precisely why
 * NOTHING may score off this object's security fields, and why `unchecked` travels beside it. Read
 * a 0 here as "absent", never as "measured zero".
 */
function carrier(c: OnchainCandidate): GmgnTrendToken {
  return {
    address: c.address,
    name: c.name,
    symbol: c.symbol,
    priceUsd: 0,
    change24hPct: 0,
    change1hPct: 0,
    volume: c.vol24h,
    liquidity: c.liqUsd,
    marketCap: 0, // UNKNOWN — no supply/price feed here; the mcap ceiling gate is skipped, not passed
    athMarketCap: 0,
    swaps: 0,
    buys: 0,
    sells: 0,
    holders: 0,
    top10Rate: 0,
    launchpad: "",
    launchpadPlatform: "",
    twitter: "",
    website: "",
    telegram: "",
    twitterDup: 0,
    telegramDup: 0,
    websiteDup: 0,
    twitterChanged: false,
    ctoFlag: false,
    isOg: false,
    smartWallets: 0,
    kolWallets: 0,
    sniperCount: 0,
    botDegenCount: 0,
    visitingCount: 0,
    hotLevel: 0,
    rugRatio: 0,
    bundlerRate: 0,
    entrapmentRatio: 0,
    devHoldRate: 0,
    sniperHoldRate: 0,
    buyTax: 0,
    sellTax: 0,
    isHoneypot: false, // NOT "verified not a honeypot" — see `unchecked`
    isRenounced: false,
    isOpenSource: false,
    lockPercent: 0,
    burnStatus: "",
    ageMs: c.ageMs,
  };
}

function onchainLlmPrompt(c: OnchainCandidate, r: ScreenResult): string {
  return (
    "Nilai kandidat LP ini. Datanya MURNI on-chain — tidak ada data GMGN/sosial untuk token ini:\n" +
    JSON.stringify(
      {
        name: c.name,
        symbol: c.symbol,
        chain: chainLabel(),
        source: c.source,
        heuristic_kind: r.kind,
        venue: c.venue,
        pool_fee_pct: +(c.fee / 10000).toFixed(2),
        volume_24h_usd: Math.round(c.vol24h),
        volume_1h_usd: Math.round(c.volH1),
        liquidity_usd: Math.round(c.liqUsd),
        turnover_x: c.liqUsd > 0 ? +(c.vol24h / c.liqUsd).toFixed(1) : 0,
        spike_x: +c.spikeX.toFixed(2),
        pool_age_min: c.ageMs != null ? Math.round(c.ageMs / 60_000) : null,
        volume_source: c.volSource,
        NOT_CHECKED: ONCHAIN_UNCHECKED, // spelled out so the model cannot read absence as "clean"
      },
      null,
      0,
    )
  );
}

/**
 * Screen candidates that came from the chain itself. Same ScreenResult contract as the GMGN path,
 * so scanLoop / notify / autoLp need no branch — only the SCORE is built differently, and the
 * `unchecked` list rides along so every downstream message can say what wasn't tested.
 */
export async function screenOnchainCandidates(cands: OnchainCandidate[], opts: ScreenOpts = {}): Promise<ScreenResult[]> {
  const rows: ScreenResult[] = [];
  for (const c of cands) {
    if (!c.address) continue;
    const t = carrier(c);
    const kind = classify(t);
    const fomo = onchainFomo(c);
    const { pts: sanityPts, flags: sflags } = onchainSanity(c);
    const utilAdj = kind === "util" ? 10 : kind === "meme" ? -15 : 0;
    // 8, not the GMGN path's 25/10/0: community was neither verified (clear) nor found wanting
    // (thin/sus). A small neutral allowance keeps an unscreenable chain from being unfarmable while
    // still ranking below a token whose community WAS checked and passed.
    const COMM_UNKNOWN_PTS = 8;
    const score = Math.round(Math.max(0, Math.min(100, fomo * 0.4 + COMM_UNKNOWN_PTS + sanityPts + utilAdj)));
    rows.push({
      token: t,
      kind,
      community: "unknown",
      fomo,
      score,
      // The "not checked" warning is flags[0] deliberately: notify.ts renders only the FIRST FOUR
      // flags, and the one thing that must never be truncated out of an alert is the fact that the
      // token's safety gates were never run.
      flags: [`⚠️ belum dicek: ${ONCHAIN_UNCHECKED.join(", ")}`, `🔎 ${c.venue} ${(c.fee / 10000).toFixed(2)}% · vol ${c.volSource}`, ...sflags],
      unchecked: [...ONCHAIN_UNCHECKED],
      source: c.source,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  const trimmed = rows.slice(0, opts.limit ?? 15);
  if (opts.llm) {
    const byAddr = new Map(cands.map((c) => [c.address.toLowerCase(), c]));
    await attachLlm(trimmed, opts.llmTop ?? 10, (r) => {
      const c = byAddr.get(r.token.address.toLowerCase());
      return c ? onchainLlmPrompt(c, r) : llmPrompt(r.token, r.kind, r.community);
    });
  }
  log.info(`screen on-chain: ${cands.length} kandidat → ${trimmed.length} (tanpa GMGN: ${ONCHAIN_UNCHECKED.length} gate UNKNOWN)`);
  return trimmed;
}
