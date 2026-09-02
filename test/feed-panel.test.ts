import test from "node:test";
import assert from "node:assert/strict";
import { feedAutoCloseConfirmKeyboard, feedPanelKeyboard } from "../src/telegram/feedPanel.ts";

test("feed panel exposes clear controls and valid callback shapes", () => {
  const rows = feedPanelKeyboard({ enabled: false, newToken: true, positionMonitor: true, autoCloseOutOfRange: false, radar: false });
  assert.ok(rows.some((row) => row[0]?.text === "▶️ Start feed"));
  assert.ok(rows.some((row) => row[0]?.callback_data === "feed:toggle:posmon"));
  for (const row of [...rows, ...feedAutoCloseConfirmKeyboard()]) {
    assert.equal(row.length, 1);
    assert.ok(row[0]?.callback_data?.startsWith("feed:"));
  }
});
