import test from "node:test";
import assert from "node:assert/strict";
import { isNonceConflict } from "../src/chain/client.ts";
import { shouldKeepV3Position } from "../src/chain/positions.ts";

test("nonce conflict detection recognizes retryable provider errors", () => {
  assert.equal(isNonceConflict(new Error("nonce has already been used")), true);
  assert.equal(isNonceConflict({ code: "NONCE_EXPIRED", message: "nonce too low" }), true);
  assert.equal(isNonceConflict(new Error("execution reverted")), false);
});

test("a locally tracked zero-liquidity NFT remains visible for cleanup", () => {
  assert.equal(shouldKeepV3Position(0n, true), true);
  assert.equal(shouldKeepV3Position(0n, false), false);
  assert.equal(shouldKeepV3Position(100n, false), true);
});
