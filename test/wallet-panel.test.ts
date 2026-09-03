import test from "node:test";
import assert from "node:assert/strict";
import { unwrapConfirmationKeyboard, walletBalanceText, walletKeyboard } from "../src/telegram/walletPanel.ts";

test("wallet exposes a manual WETH unwrap action", () => {
  assert.deepEqual(walletKeyboard(), [
    [{ text: "💱 Swap USDG → ETH", callback_data: "wallet:usdg" }],
    [{ text: "🔓 Unwrap all WETH → ETH", callback_data: "unwrap:ask" }],
  ]);
});

test("manual WETH unwrap requires confirmation or cancellation", () => {
  assert.deepEqual(unwrapConfirmationKeyboard(), [[
    { text: "✅ Confirm unwrap", callback_data: "unwrap:confirm" },
    { text: "Cancel", callback_data: "unwrap:cancel" },
  ]]);
});

test("wallet display includes USDG and liquid USD total", () => {
  const text = walletBalanceText({ address: "0xabc", eth: "0.1", weth: "0.2", usdg: "12.34", totalUsd: 987.65 });
  assert.match(text, /USDG: \$12\.34/);
  assert.match(text, /Total wallet: <b>\$987\.65<\/b>/);
});
