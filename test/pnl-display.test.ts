import test from "node:test";
import assert from "node:assert/strict";
import { winRateText } from "../src/chain/ledger.ts";

test("PnL win rate uses wins over closed positions", () => {
  assert.equal(winRateText(2, 4), "50% (2/4)");
  assert.equal(winRateText(0, 0), "0% (0/0)");
});
