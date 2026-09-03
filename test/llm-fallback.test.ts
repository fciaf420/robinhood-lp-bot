import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config.ts";
import { clearRateLimit } from "../src/radar/rateLimit.ts";
import { llmComplete, llmProviderPlan, llmScore } from "../src/radar/openrouter.ts";

test("LLM fallback keeps OpenRouter first and DeepSeek available second", () => {
  assert.deepEqual(llmProviderPlan({ openrouter: true, openrouterCoolingDown: false, deepseek: true }), ["openrouter", "deepseek"]);
});

test("LLM fallback uses DeepSeek while OpenRouter is cooling down", () => {
  assert.deepEqual(llmProviderPlan({ openrouter: true, openrouterCoolingDown: true, deepseek: true }), ["deepseek"]);
});

test("LLM fallback calls DeepSeek after an OpenRouter 429", async () => {
  const saved = {
    openrouterKey: env.openrouterKey,
    openrouterUrl: env.openrouterUrl,
    deepseekKey: env.deepseekKey,
    deepseekUrl: env.deepseekUrl,
  };
  const calls: { url: string; body: any }[] = [];
  const originalFetch = globalThis.fetch;
  clearRateLimit();
  env.openrouterKey = "openrouter-test-key";
  env.openrouterUrl = "https://openrouter.test/chat/completions";
  env.deepseekKey = "deepseek-test-key";
  env.deepseekUrl = "https://deepseek.test";
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(input), body });
    if (calls.length === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true,"action":"watch","score":50,"summary":"fallback"}' } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await llmScore("Return JSON.", "Test fallback.", { timeoutMs: 100, retries: 1 });
    assert.equal(result?.summary, "fallback");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://openrouter.test/chat/completions");
    assert.equal(calls[1]?.url, "https://deepseek.test/chat/completions");
    assert.deepEqual(calls[1]?.body.response_format, { type: "json_object" });
    assert.deepEqual(calls[1]?.body.thinking, { type: "disabled" });
    assert.equal((await llmComplete("Return text.", "No call expected.", { openrouter: { key: "", url: env.openrouterUrl, model: env.openrouterModel } }))?.provider, "deepseek");
  } finally {
    globalThis.fetch = originalFetch;
    env.openrouterKey = saved.openrouterKey;
    env.openrouterUrl = saved.openrouterUrl;
    env.deepseekKey = saved.deepseekKey;
    env.deepseekUrl = saved.deepseekUrl;
    clearRateLimit();
  }
});
