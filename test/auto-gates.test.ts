import test from "node:test";
import assert from "node:assert/strict";
import { hasTrustedLlmApproval } from "../src/radar/autolp.ts";

test("Auto-LP trusts only a real LLM verdict", () => {
  const llm = { action: "ape" as const, score: 92, summary: "approved" };
  assert.equal(hasTrustedLlmApproval({ llm, gmgn: null, provenance: "llm" }), true);
  assert.equal(hasTrustedLlmApproval({ llm, gmgn: null, provenance: "none" }), false);
  assert.equal(hasTrustedLlmApproval({ llm: null, gmgn: null, provenance: "none" }), false);
});
