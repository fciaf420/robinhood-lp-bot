import test from "node:test";
import assert from "node:assert/strict";
import { acquireWallet, releaseWallet, walletBusy, withKyberSwapLock, withWalletLock } from "../src/chain/txlock.ts";

test("wallet lock rejects an overlapping transaction sequence", async () => {
  assert.equal(walletBusy(), false);
  assert.equal(acquireWallet(), true);
  try {
    assert.equal(await withWalletLock(async () => "should not run"), false);
  } finally {
    releaseWallet();
  }
});

test("wallet lock releases after a completed transaction sequence", async () => {
  const result = await withWalletLock(async () => "completed");
  assert.equal(result, "completed");
  assert.equal(walletBusy(), false);
});

test("Kyber swap lock serializes overlapping balance-spending work", async () => {
  const events: string[] = [];
  const first = withKyberSwapLock(async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push("first:end");
  });
  const second = withKyberSwapLock(async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});
