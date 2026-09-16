/**
 * Candidate radar — the "confirmation layer" (pattern borrowed from the meridian Solana
 * agent). Gathers our on-chain signals + GMGN intelligence, then asks an LLM for a
 * skeptical LP verdict. Entirely best-effort: disabled unless cfg.radar.enabled AND an
 * OpenRouter key is set; GMGN is optional on top.
 */
import { cfg } from "../config.js";
import { CHAIN } from "../chain/profile.js";
import { logger } from "../util/log.js";
import { gmgnToken, gmgnSupported, GMGN_ONLY_GATES, type GmgnData } from "./gmgn.js";
import { llmScore, chainLabel, dataCaveat, type LlmVerdict } from "./openrouter.js";

const log = logger("radar");

export interface Candidate {
  token: string;
  symbol: string;
  source: "feed-new" | "watch-spike" | "hunt";
  fee?: number;
  wethSeed?: number;
  onchainBackPct?: number; // our buy→sell round-trip sim (100 = clean)
  onchainTaxPct?: number;
  vol5m?: number;
  vol1h?: number;
  liq?: number;
  fdv?: number;
}

/**
 * Why `gmgn` is null — a DIFFERENT question from "is this token clean":
 *   "ok"          → GMGN answered (gmgn is non-null)
 *   "unsupported" → the chain has no GMGN coverage at all (Arc) — those gates were NEVER RUN
 *   "unavailable" → covered chain, but the CLI is missing / throttled / errored on this call
 *   "off"         → cfg.radar.useGmgn is false (operator's choice)
 * The last three all mean UNCHECKED. `unchecked` names the specific gates so the alert can say
 * "tax belum dicek" instead of rendering nothing — an empty GMGN block reads as "no flags = safe",
 * which is exactly the inference that must not be made.
 */
export type GmgnStatus = "ok" | "unsupported" | "unavailable" | "off";

export interface Verdict {
  llm: LlmVerdict | null;
  gmgn: GmgnData | null;
  // Optional so telegram/pipeline.ts's hand-built Verdict (a file this stage doesn't own) still
  // compiles. Absent = a legacy verdict whose status nobody recorded.
  gmgnStatus?: GmgnStatus;
  unchecked?: string[];
}

export function radarEnabled(): boolean {
  // enabled runs the layer; LLM needs a key but GMGN enrichment works standalone
  return cfg.radar.enabled;
}

/**
 * Built per call instead of as a module const: the chain name and the data-availability caveat
 * come from the profile. Telling the model "Robinhood Chain" while running on Arc is not a
 * cosmetic bug — it would reason about the wrong native asset (ETH vs USDC), the wrong token
 * culture and the wrong venue set, and then hand that back as a conviction score we spend on.
 */
function systemPrompt(): string {
  const nat = CHAIN.native.symbol;
  return [
    `You are a skeptical liquidity-provider (LP) screener for Uniswap memecoin pools on ${chainLabel()} (native currency ${nat}).`,
    "Providing LP on a memecoin makes the bot an AUTOMATIC BUYER as the price falls, so downside risk matters more than upside.",
    "METRIC MEANINGS (read every number EXACTLY as given, do not invent values):",
    `• onchain_roundtrip_pct = % of value returned on a small (0.01 ${nat}) buy→sell sim. ~98-100 = CLEAN (only pool fee lost); <90 = hidden sell tax; 0/revert = honeypot. HIGHER IS BETTER — it is NOT a tax.`,
    "• onchain_hidden_tax_pct = extra loss beyond the normal fee. 0 = none; higher = worse.",
    "• liquidity_usd / liq = pool depth in USD (bigger = safer to enter/exit).",
    "• smart_money_wallets ≥3 = bullish; 0 = no smart interest (bearish, not a hard stop).",
    "• rug_ratio 0-1 (>0.3 risky). top10_holder_rate 0-1 (>0.5 too concentrated). sell_tax/buy_tax are decimals (0.05 = 5%).",
    "Missing/unavailable data = uncertainty, not safety. Be conservative on thin or very-new tokens.",
    dataCaveat(), // "" on a fully-covered chain → Robinhood's prompt is unchanged
    'Respond ONLY as compact JSON: {"score": <0-100 conviction>, "action": "ape"|"watch"|"skip", "summary": "<one sentence, <180 chars, state the KEY reason>"}.',
  ]
    .filter(Boolean)
    .join(" ");
}

/** Which GMGN-only gates this verdict could NOT evaluate, and why. [] when GMGN answered. */
export function gmgnStatusOf(gmgn: GmgnData | null): { status: GmgnStatus; unchecked: string[] } {
  if (gmgn) return { status: "ok", unchecked: [] };
  const status: GmgnStatus = !gmgnSupported() ? "unsupported" : !cfg.radar.useGmgn ? "off" : "unavailable";
  return { status, unchecked: [...GMGN_ONLY_GATES] };
}

export async function scoreCandidate(c: Candidate): Promise<Verdict | null> {
  if (!radarEnabled()) return null;
  // useGmgn stays the operator switch; gmgnToken() already self-disables on a chain without
  // coverage. What has to survive from here is the REASON, all the way to the alert.
  const gmgn = cfg.radar.useGmgn ? await gmgnToken(c.token).catch(() => null) : null;
  const { status, unchecked } = gmgnStatusOf(gmgn);
  const user = buildPrompt(c, gmgn, status);
  const llm = await llmScore(systemPrompt(), user);
  // Without GMGN the LLM verdict is the ONLY verdict, so a null LLM is a genuine dead end here —
  // returning null (rather than a hollow verdict) is what lets autoLp's requireLlm gate refuse.
  if (!llm && !gmgn) return null;
  if (llm) log.info(`${c.symbol}: ${llm.action} (${llm.score}) — ${llm.summary.slice(0, 60)}`);
  return { llm, gmgn, gmgnStatus: status, unchecked };
}

function buildPrompt(c: Candidate, gmgn: GmgnData | null, status: GmgnStatus): string {
  const payload = {
    token: c.token,
    symbol: c.symbol,
    source: c.source,
    fee_tier: c.fee,
    weth_seed: c.wethSeed,
    onchain_roundtrip_pct: c.onchainBackPct,
    onchain_hidden_tax_pct: c.onchainTaxPct,
    volume_5m_usd: c.vol5m,
    volume_1h_usd: c.vol1h,
    liquidity_usd: c.liq,
    fdv_usd: c.fdv,
    gmgn: gmgn
      ? {
          market_cap: gmgn.marketCap,
          liquidity_usd: gmgn.liquidityUsd,
          holders: gmgn.holders,
          smart_money_wallets: gmgn.smartWallets,
          kol_wallets: gmgn.kolWallets,
          is_honeypot: gmgn.isHoneypot,
          buy_tax: gmgn.buyTax,
          sell_tax: gmgn.sellTax,
          rug_ratio: gmgn.rugRatio,
          top10_holder_rate: gmgn.top10Rate,
          owner_renounced: gmgn.ownerRenounced,
          sniper_count: gmgn.sniperCount,
          dev_holding: gmgn.devHolding,
        }
      : // NOT the bare string "unavailable", and emphatically not a zero-filled object: a payload
        // of 0-valued tax/rug/top10 fields is indistinguishable from a token that genuinely
        // measured clean. Name the gates that were never run, and the reason.
        {
          status,
          note:
            status === "unsupported"
              ? `GMGN does not index ${chainLabel()} — ${GMGN_ONLY_GATES.join(", ")} were NEVER CHECKED (unknown, not 0)`
              : `GMGN ${status} — ${GMGN_ONLY_GATES.join(", ")} were NOT CHECKED (unknown, not 0)`,
        },
  };
  return "Screen this LP candidate:\n" + JSON.stringify(payload, null, 0);
}
