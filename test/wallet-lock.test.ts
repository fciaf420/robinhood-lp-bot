import test from "node:test";
import assert from "node:assert/strict";
import { acquireWallet, releaseWallet, walletBusy, withWalletLock } from "../src/chain/txlock.ts";

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
