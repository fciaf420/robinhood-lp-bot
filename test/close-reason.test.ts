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
