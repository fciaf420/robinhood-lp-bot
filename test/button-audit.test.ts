import test from "node:test";
import assert from "node:assert/strict";
import { autoBackButton, autoPanelKeyboard } from "../src/telegram/autoPanel.ts";
import { settingsPanelKeyboard } from "../src/telegram/settingsPanel.ts";
import { MENU_KEYBOARD, resolveMenu } from "../src/telegram/menu.ts";

type Button = { text: string; callback_data?: string; url?: string };

function assertInlineKeyboard(rows: unknown): void {
  assert.ok(Array.isArray(rows));
  for (const row of rows) {
    assert.ok(Array.isArray(row), "each inline keyboard row must be an array");
    assert.ok(row.length > 0, "inline keyboard rows must not be empty");
    for (const button of row as Button[]) {
      assert.equal(typeof button.text, "string");
      assert.ok(button.callback_data || button.url, "button needs callback_data or url");
      if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
    }
  }
}

test("Auto and Settings panel keyboards use valid Telegram row shapes", () => {
  assertInlineKeyboard(autoPanelKeyboard({ enabled: false, mode: "single", sources: [], tpPct: 0, slPct: 0, closeOor: false }));
  assertInlineKeyboard([autoBackButton()]);
  assertInlineKeyboard(settingsPanelKeyboard());
});

test("persistent menu labels route to their commands", () => {
  const labels = MENU_KEYBOARD.keyboard.flat();
  assert.ok(labels.includes("🤖 Auto"));
  assert.ok(labels.includes("⚙️ Settings"));
  assert.equal(resolveMenu("🤖 Auto"), "/auto");
  assert.equal(resolveMenu("⚙️ Settings"), "/settings");
  assert.equal(resolveMenu("⚙️ Setting"), "/settings");
});
