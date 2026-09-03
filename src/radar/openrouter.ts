/**
 * LLM client — OpenRouter is the primary endpoint and DeepSeek is an optional paid fallback.
 * Both speak the OpenAI-compatible chat-completions API. stream:false keeps every call to one
 * JSON response. Best-effort: returns null if no key or if every configured provider fails.
 */
import { env } from "../config.js";
import { logger } from "../util/log.js";
import { clearRateLimit, isRateLimited, noteRateLimit } from "./rateLimit.js";

const log = logger("llm");
const MIN_GAP_MS = Math.max(0, Number(process.env.RH_LLM_MIN_GAP_MS) || 2_000);
export const DEFAULT_LLM_SCREEN_TIMEOUT_MS = 30_000;
const MAX_COMPLETION_TOKENS = 512;
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

export type LlmProvider = "openrouter" | "deepseek";

export interface LlmProviderPlanInput {
  openrouter: boolean;
  openrouterCoolingDown: boolean;
  deepseek: boolean;
}

/** Provider order is exported so the failover contract stays covered without calling paid APIs. */
export function llmProviderPlan(input: LlmProviderPlanInput): LlmProvider[] {
  const plan: LlmProvider[] = [];
  if (input.openrouter && !input.openrouterCoolingDown) plan.push("openrouter");
  if (input.deepseek) plan.push("deepseek");
  return plan;
}

interface EndpointOverride {
  key?: string;
  url?: string;
  model?: string;
}

export interface LlmCompleteOptions {
  timeoutMs?: number;
  retries?: number;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  openrouter?: EndpointOverride;
  deepseek?: EndpointOverride;
}

export interface LlmCompletion {
  content: string;
  provider: LlmProvider;
}

type ProviderResult = { content: string; failure?: never } | { content: null; failure: string };

function endpoint(provider: LlmProvider, override?: EndpointOverride): Required<EndpointOverride> {
  if (provider === "openrouter") {
    return {
      key: override?.key ?? env.openrouterKey,
      url: override?.url ?? env.openrouterUrl,
      model: override?.model ?? env.openrouterModel,
    };
  }
  return {
    key: override?.key ?? env.deepseekKey,
    url: `${override?.url ?? env.deepseekUrl}/chat/completions`,
    model: override?.model ?? env.deepseekModel,
  };
}

function contentFromResponse(j: any): string {
  const msg = j?.choices?.[0]?.message ?? {};
  // reasoning models sometimes leave content null and put the answer in reasoning_content/reasoning.
  return String(msg.content || msg.reasoning_content || msg.reasoning || j?.choices?.[0]?.text || "").trim();
}

async function requestCompletion(
  provider: LlmProvider,
  system: string,
  user: string,
  options: LlmCompleteOptions,
  override?: EndpointOverride,
): Promise<ProviderResult> {
  const ep = endpoint(provider, override);
  if (!ep.key) return { content: null, failure: "missing-key" };

  const hasFallback = provider === "openrouter" && !!(options.deepseek?.key ?? env.deepseekKey);
  // When a paid fallback exists, do not spend another 30 seconds retrying a free provider that is
  // already timing out. With no fallback, preserve the old retry behavior for OpenRouter.
  const attempts = provider === "openrouter" && !hasFallback ? Math.max(1, (options.retries ?? 1) + 1) : 1;
  const bodyObject: Record<string, unknown> = {
    model: ep.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? MAX_COMPLETION_TOKENS,
  };
  if (provider === "deepseek" && options.json) {
    bodyObject.response_format = { type: "json_object" };
    bodyObject.thinking = { type: "disabled" };
  }
  const body = JSON.stringify(bodyObject);

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ep.key}`,
          "Content-Type": "application/json",
          ...(provider === "openrouter" ? { "X-Title": "Robinhood LP Bot" } : {}),
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 40_000),
      });
      if (res.status === 429) {
        const wait = provider === "openrouter" ? noteRateLimit(res.headers.get("retry-after")) : 0;
        if (attempt + 1 < attempts) {
          log.warn(`${provider} 429 — retry in ${wait}ms`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        log.warn(`${provider} 429 — ${provider === "openrouter" ? "DeepSeek fallback will be tried" : "no further fallback"}`);
        return { content: null, failure: "429" };
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 160);
        log.warn(`${provider} HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
        return { content: null, failure: `HTTP ${res.status}` };
      }
      if (provider === "openrouter") clearRateLimit();
      const content = contentFromResponse(await res.json());
      if (!content) {
        log.warn(`${provider} returned empty content`);
        return { content: null, failure: "empty response" };
      }
      return { content };
    } catch (e) {
      const message = (e as Error).message || "request failed";
      log.warn(`${provider} failed: ${message.slice(0, 140)}`);
      if (attempt + 1 >= attempts) return { content: null, failure: message.includes("abort") ? "timeout" : "network error" };
    }
  }
  return { content: null, failure: "request failed" };
}

export async function llmComplete(system: string, user: string, options: LlmCompleteOptions = {}): Promise<LlmCompletion | null> {
  const openrouter = endpoint("openrouter", options.openrouter);
  const deepseek = endpoint("deepseek", options.deepseek);
  if (!openrouter.key && !deepseek.key) return null;
  return withLlmSlot(async () => {
    const plan = llmProviderPlan({
      openrouter: !!openrouter.key,
      openrouterCoolingDown: isRateLimited(),
      deepseek: !!deepseek.key,
    });
    let previousFailure = "provider unavailable";
    for (const provider of plan) {
      const result = await requestCompletion(provider, system, user, options, provider === "openrouter" ? options.openrouter : options.deepseek);
      if (result.content !== null) {
        if (provider === "deepseek" && plan[0] === "openrouter") log.warn(`DeepSeek fallback used after OpenRouter ${previousFailure}`);
        return { content: result.content, provider };
      }
      previousFailure = result.failure;
      if (provider === "openrouter" && deepseek.key) log.warn(`OpenRouter unavailable (${result.failure}); trying DeepSeek`);
    }
    return null;
  });
}

export async function llmScore(system: string, user: string, opts: { timeoutMs?: number; retries?: number } = {}): Promise<LlmVerdict | null> {
  const result = await llmComplete(system, user, { ...opts, json: true, maxTokens: MAX_COMPLETION_TOKENS });
  return result ? parseVerdict(result.content) : null;
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
