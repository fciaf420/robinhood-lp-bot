import test from "node:test";
import assert from "node:assert/strict";
import { hasTrustedLlmApproval, needsLlmApproval } from "../src/radar/autolp.ts";

test("Auto-LP trusts only a real LLM verdict", () => {
  const llm = { action: "ape" as const, score: 92, summary: "approved" };
  assert.equal(hasTrustedLlmApproval({ llm, gmgn: null, provenance: "llm" }), true);
  assert.equal(hasTrustedLlmApproval({ llm, gmgn: null, provenance: "none" }), false);
  assert.equal(hasTrustedLlmApproval({ llm: null, gmgn: null, provenance: "none" }), false);
});

test("Hunter candidates request a real LLM verdict when Auto-LP requires one", () => {
  assert.equal(needsLlmApproval(true, { llm: null, gmgn: null, provenance: "none" }), true);
  assert.equal(needsLlmApproval(true, { llm: { action: "ape", score: 90, summary: "approved" }, gmgn: null, provenance: "llm" }), false);
  assert.equal(needsLlmApproval(false, { llm: null, gmgn: null, provenance: "none" }), false);
});
