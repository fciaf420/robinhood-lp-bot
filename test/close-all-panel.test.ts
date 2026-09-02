import test from "node:test";
import assert from "node:assert/strict";
import { closeAllConfirmationKeyboard, totalCloseAllPositions } from "../src/telegram/positionPanel.ts";

test("Close ALL panel requires explicit confirmation and offers cancel", () => {
  assert.deepEqual(closeAllConfirmationKeyboard(3), [
    [{ text: "⚠️ Confirm close all (3)", callback_data: "closeall:confirm" }],
    [{ text: "Cancel", callback_data: "closeall:cancel" }],
  ]);
});

test("Close ALL count includes both v3 and v4 positions", () => {
  assert.equal(totalCloseAllPositions(2, 1), 3);
});
