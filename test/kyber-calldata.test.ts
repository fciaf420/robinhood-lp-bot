import test from "node:test";
import assert from "node:assert/strict";
import { extractKyberCalldata, isKyberBroadcastUnknown, KyberBroadcastUnknownError } from "../src/chain/kyber.ts";

test("Kyber build accepts the documented data field", () => {
  assert.equal(extractKyberCalldata({ data: "0x12345678" }), "0x12345678");
});

test("Kyber build accepts transaction-shaped calldata but never empty data", () => {
  assert.equal(extractKyberCalldata({ transaction: { data: "0xabcdef12" } }), "0xabcdef12");
  assert.throws(() => extractKyberCalldata({ data: "0x", transaction: { data: "" } }), /empty transaction data/);
});

test("Kyber build accepts ZaaS-style callData", () => {
  assert.equal(extractKyberCalldata({ callData: "0xdeadbeef" }), "0xdeadbeef");
});

test("a broadcasted Kyber failure is explicitly non-fallback", () => {
  const error = new KyberBroadcastUnknownError("confirmation unavailable", "0xabc");
  assert.equal(isKyberBroadcastUnknown(error), true);
  assert.equal(isKyberBroadcastUnknown(new Error("preflight reverted")), false);
});
