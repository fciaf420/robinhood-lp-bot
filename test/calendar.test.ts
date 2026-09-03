import test from "node:test";
import assert from "node:assert/strict";
import { dailyPnlFromEntries } from "../src/telegram/calendar.ts";
import type { LedgerEntry } from "../src/types.ts";

const entry = (overrides: Partial<LedgerEntry>): LedgerEntry => ({
  tokenId: "1",
  sym: "TEST",
  mode: "single",
  openedAt: null,
  closedAt: null,
  heldMs: null,
  depEth: 0.1,
  outEth: 0.1,
  feeEth: 0,
  pnlEth: null,
  pnlPct: null,
  pnlUsd: null,
  ethUsdAtClose: null,
  tokenKept: 0,
  tokenRug: 0,
  ...overrides,
});

test("calendar excludes open entries and uses ETH fallback for legacy closes", () => {
  const days = dailyPnlFromEntries([
    entry({ tokenId: "open", openedAt: Date.UTC(2026, 8, 2), pnlEth: 0.2 }),
    entry({ tokenId: "closed", closedAt: Date.UTC(2026, 8, 2, 12), pnlEth: -0.01, ethUsdAtClose: 2400 }),
    entry({ tokenId: "usd", closedAt: Date.UTC(2026, 8, 2, 18), pnlEth: 0.01, pnlUsd: 30, ethUsdAtClose: 2400 }),
  ], 2026, 8);
  assert.deepEqual(days.get(2), { pnlUsd: 6, trades: 2 });
  assert.equal(days.has(1), false);
});
