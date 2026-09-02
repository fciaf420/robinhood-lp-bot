/**
 * LLM screener client — any OpenAI-compatible chat-completions endpoint (OpenRouter by
 * default; RH_OPENROUTER_URL points it at a custom gateway). stream:false so we always get
 * one JSON body. Best-effort: returns null if no key or on any failure.
 */
import { env } from "../config.js";
import { logger } from "../util/log.js";
import { clearRateLimit, isRateLimited, noteRateLimit } from "./rateLimit.js";

const log = logger("llm");

export interface LlmVerdict {
  score: number; // 0..100 conviction
  action: "ape" | "watch" | "skip";
  summary: string;
}

export async function llmScore(system: string, user: string, opts: { timeoutMs?: number; retries?: number } = {}): Promise<LlmVerdict | null> {
  if (!env.openrouterKey) return null;
  // A free-tier 429 applies to the model/account, not just this request. Avoid
  // sending the next candidate into the same throttle window.
  if (isRateLimited()) return null;
  const body = JSON.stringify({
    model: env.openrouterModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    stream: false, // some gateways stream by default; we want one JSON body
    temperature: 0.2,
    max_tokens: 1200,
  });
  // Free models throttle upstream (HTTP 429 with Retry-After) — retry once, briefly.
  const retries = opts.retries ?? 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(env.openrouterUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.openrouterKey}`, "Content-Type": "application/json", "X-Title": "Robinhood LP Bot" },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 40_000),
      });
      if (res.status === 429) {
        const wait = noteRateLimit(res.headers.get("retry-after"));
        if (attempt < retries) {
          log.warn(`openrouter 429 (free throttle) — retry in ${wait}ms`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        log.warn(`openrouter 429 (free throttle) — cooling down for ${wait}ms`);
        return null;
      }
      if (!res.ok) {
        log.warn(`openrouter HTTP ${res.status}`);
        return null;
      }
      clearRateLimit();
      const j: any = await res.json();
      const msg = j?.choices?.[0]?.message ?? {};
      // reasoning models sometimes leave content null and put the answer in `reasoning`
      return parseVerdict(msg.content || msg.reasoning || "");
    } catch (e) {
      log.warn(`OpenRouter failed: ${(e as Error).message}`);
      return null;
    }
  }
  return null;
}

function parseVerdict(content: string): LlmVerdict | null {
  let obj: any;
  try {
    obj = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/); // some models wrap JSON in prose
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const score = Math.max(0, Math.min(100, Number(obj.score) || 0));
  const action = ["ape", "watch", "skip"].includes(obj.action) ? obj.action : score >= 70 ? "ape" : score >= 40 ? "watch" : "skip";
  return { score, action, summary: String(obj.summary ?? "").slice(0, 240) };
}
