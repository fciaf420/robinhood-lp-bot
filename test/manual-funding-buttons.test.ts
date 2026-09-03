import test from "node:test";
import assert from "node:assert/strict";
import { manualFundingButtons } from "../src/telegram/handlers.ts";

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
