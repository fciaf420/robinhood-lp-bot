import test from "node:test";
import assert from "node:assert/strict";
import {
  extractKyberCalldata,
  isKyberBroadcastReverted,
  isKyberBroadcastUnknown,
  isKyberPreflight,
  KyberBroadcastRevertedError,
  KyberBroadcastUnknownError,
  KyberPreflightError,
} from "../src/chain/kyber.ts";

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

test("a receipt-confirmed Kyber revert is distinguished from an unknown receipt", () => {
  const error = new KyberBroadcastRevertedError("transaction reverted on-chain", "0xabc");
  assert.equal(isKyberBroadcastReverted(error), true);
  assert.equal(isKyberBroadcastUnknown(error), true); // still blocks unsafe fallback/resubmission
  assert.equal(isKyberBroadcastReverted(new KyberBroadcastUnknownError("confirmation unavailable", "0xabc")), false);
});

test("a Kyber gas preflight failure blocks direct-swap fallback", () => {
  assert.equal(isKyberPreflight(new KyberPreflightError("blocked before broadcast")), true);
  assert.equal(isKyberPreflight(new Error("blocked before broadcast")), false);
});
