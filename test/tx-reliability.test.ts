import test from "node:test";
import assert from "node:assert/strict";
import { hasUsableCalldata, isNonceConflict, isRetryableSendError } from "../src/chain/client.ts";
import { KyberBroadcastRevertedError, isRetryableKyberRevert } from "../src/chain/kyber.ts";
import { shouldKeepV3Position } from "../src/chain/positions.ts";

test("nonce conflict detection recognizes retryable provider errors", () => {
  assert.equal(isNonceConflict(new Error("nonce has already been used")), true);
  assert.equal(isNonceConflict({ code: "NONCE_EXPIRED", message: "nonce too low" }), true);
  assert.equal(isNonceConflict({ code: "NONCE_TOO_LOW", message: "invalid transaction nonce" }), true);
  assert.equal(isNonceConflict(new Error("nonce is too low")), true);
  assert.equal(isNonceConflict(new Error("execution reverted")), false);
});

test("generic empty-calldata send rejections are not retried", () => {
  assert.equal(
    isRetryableSendError({
      action: "sendTransaction",
      message: "transaction execution reverted",
      transaction: { data: "", from: "0x0000000000000000000000000000000000000001" },
    }),
    false,
  );
  assert.equal(isRetryableSendError(new Error("execution reverted by token")), false);
});

test("only confirmed Kyber output/slippage reverts are eligible for a fresh-route retry", () => {
  const hash = `0x${"ab".repeat(32)}`;
  assert.equal(
    isRetryableKyberRevert(new KyberBroadcastRevertedError("Kyber swap reverted: Return amount is not enough", hash)),
    true,
  );
  assert.equal(
    isRetryableKyberRevert(new KyberBroadcastRevertedError("Kyber swap reverted: TRANSFER_FROM_FAILED", hash)),
    false,
  );
  assert.equal(isRetryableKyberRevert(new Error("Return amount is not enough")), false);
});

test("empty transaction calldata is rejected before broadcast", () => {
  assert.equal(hasUsableCalldata("0x12345678"), true);
  assert.equal(hasUsableCalldata("0x"), false);
  assert.equal(hasUsableCalldata(""), false);
  assert.equal(hasUsableCalldata(undefined), false);
});

test("a locally tracked zero-liquidity NFT remains visible for cleanup", () => {
  assert.equal(shouldKeepV3Position(0n, true), true);
  assert.equal(shouldKeepV3Position(0n, false), false);
  assert.equal(shouldKeepV3Position(100n, false), true);
});
