/**
 * LLM screener client — any OpenAI-compatible chat-completions endpoint (OpenRouter by
 * default; RH_OPENROUTER_URL points it at a custom gateway). stream:false so we always get
 * one JSON body. Best-effort: returns null if no key or on any failure.
 */
import { env } from "../config.js";
import { logger } from "../util/log.js";
import { clearRateLimit, isRateLimited, noteRateLimit } from "./rateLimit.js";

const log = logger("llm");
const MIN_GAP_MS = Math.max(0, Number(process.env.RH_LLM_MIN_GAP_MS) || 2_000);
let queue: Promise<void> = Promise.resolve();
let nextRequestAt = 0;

/** Serialize model calls across radar, hunt, feed, and watch. Free endpoints reject bursts. */
async function withLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const previous = queue;
  queue = queue.then(() => turn);
  await previous;
  try {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    nextRequestAt = Date.now() + MIN_GAP_MS;
    return await fn();
  } finally {
    release();
  }
}

export interface LlmVerdict {
  score: number; // 0..100 conviction
  action: "ape" | "watch" | "skip";
  summary: string;
}

export async function llmScore(system: string, user: string, opts: { timeoutMs?: number; retries?: number } = {}): Promise<LlmVerdict | null> {
  if (!env.openrouterKey) return null;
  return withLlmSlot(async () => {
    // Recheck after waiting in the queue so a request does not pile onto an active cooldown.
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
          const detail = (await res.text().catch(() => "")).slice(0, 160);
          log.warn(`openrouter HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
          return null;
        }
        clearRateLimit();
        const j: any = await res.json();
        const msg = j?.choices?.[0]?.message ?? {};
        // reasoning models sometimes leave content null and put the answer in `reasoning`
        return parseVerdict(msg.content || msg.reasoning || "");
      } catch (e) {
        log.warn(`OpenRouter failed: ${(e as Error).message}`);
      }
    }
    return null;
  });
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
