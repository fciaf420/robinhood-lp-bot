import test from "node:test";
import assert from "node:assert/strict";
import { pnlUsdForEntry, winRateText } from "../src/chain/ledger.ts";
import type { LedgerEntry } from "../src/types.ts";

test("PnL win rate uses wins over closed positions", () => {
  assert.equal(winRateText(2, 4), "50% (2/4)");
  assert.equal(winRateText(0, 0), "0% (0/0)");
});

test("PnL USD falls back to the close-time ETH price when legacy USD is missing", () => {
  const entry = {
    pnlEth: -0.01,
    pnlUsd: null,
    ethUsdAtClose: 2_400,
  } as LedgerEntry;
  assert.equal(pnlUsdForEntry(entry), -24);
});
