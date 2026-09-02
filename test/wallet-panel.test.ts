import test from "node:test";
import assert from "node:assert/strict";
import { unwrapConfirmationKeyboard, walletKeyboard } from "../src/telegram/walletPanel.ts";

test("wallet exposes a manual WETH unwrap action", () => {
  assert.deepEqual(walletKeyboard(), [[{ text: "🔓 Unwrap all WETH → ETH", callback_data: "unwrap:ask" }]]);
});

test("manual WETH unwrap requires confirmation or cancellation", () => {
  assert.deepEqual(unwrapConfirmationKeyboard(), [[
    { text: "✅ Confirm unwrap", callback_data: "unwrap:confirm" },
    { text: "Cancel", callback_data: "unwrap:cancel" },
  ]]);
});
