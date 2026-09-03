import test from "node:test";
import assert from "node:assert/strict";
import { manualFundingButtons, manualFundingPrompt } from "../src/telegram/handlers.ts";

test("manual ETH LP prompt offers fresh, held-token, and custom amount choices", () => {
  const rows = manualFundingButtons({ heldTokenUi: 3.0585, balancedEth: 0.03636 });

  assert.deepEqual(
    rows.map((row) => row[0]?.callback_data),
    ["fund:fresh", "fund:held", "amount:custom"],
  );
  assert.match(rows[0]![0]!.text, /Fresh/);
  assert.match(rows[1]![0]!.text, /held token/);
  assert.match(rows[2]![0]!.text, /custom ETH amount/i);
});

test("manual funding prompts preserve the wallet balances and selected funding mode", () => {
  const prompt = manualFundingPrompt({
    symbol: "HUGGY",
    availableEth: 0.1623,
    weth: 0,
    eth: 0.1627,
    heldTokenUi: 3.0585,
    choice: "fresh",
  });

  assert.match(prompt, /Available for LP: <b>0\.16230 ETH<\/b>/);
  assert.match(prompt, /WETH 0\.0000 \+ ETH 0\.1627/);
  assert.match(prompt, /Wallet token balance: <b>3\.0585 HUGGY<\/b>/);
  assert.match(prompt, /existing HUGGY balance will not be used/i);
});
