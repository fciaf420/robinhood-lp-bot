import test from "node:test";
import assert from "node:assert/strict";
import { extractKyberCalldata } from "../src/chain/kyber.ts";

test("Kyber build accepts the documented data field", () => {
  assert.equal(extractKyberCalldata({ data: "0x12345678" }), "0x12345678");
});

test("Kyber build accepts transaction-shaped calldata but never empty data", () => {
  assert.equal(extractKyberCalldata({ transaction: { data: "0xabcdef12" } }), "0xabcdef12");
  assert.throws(() => extractKyberCalldata({ data: "0x", transaction: { data: "" } }), /empty transaction data/);
});
