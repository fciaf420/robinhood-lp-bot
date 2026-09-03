import test from "node:test";
import assert from "node:assert/strict";
import { closeCardData } from "../src/telegram/card.ts";

test("close PnL cards preserve the close reason", async () => {
  const card = await closeCardData({
    name: "ETH/TEST",
    version: "v4",
    depEth: 0.1,
    outEth: 0.11,
    pnlEth: 0.01,
    ethUsd: 2000,
    reason: "TP",
  });
  assert.equal(card.reason, "TP");
});

test("close PnL cards show elapsed hold time and pool fee tier", async () => {
  const card = await closeCardData({
    name: "ETH/TEST",
    version: "v4",
    depEth: 0.1,
    outEth: 0.11,
    pnlEth: 0.01,
    ethUsd: 2000,
    heldMs: 3_661_000,
    poolFeePpm: 30_400,
    reason: "manual",
  });
  assert.equal(card.hold, "01:01:01");
  assert.equal(card.stats.some((s) => s.label === "Pool" && s.value === "3.04%"), true);
});
