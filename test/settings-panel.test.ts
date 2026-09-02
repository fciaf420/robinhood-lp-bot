import test from "node:test";
import assert from "node:assert/strict";
import { settingsPanelKeyboard } from "../src/telegram/settingsPanel.ts";

test("settings panel exposes plain-English sections", () => {
  const buttons = settingsPanelKeyboard().flat();
  const labels = buttons.map((b) => b.text);
  const callbacks = buttons.map((b) => b.callback_data);

  assert.ok(labels.includes("📐 LP settings"));
  assert.ok(labels.includes("⛽ Gas target"));
  assert.ok(labels.includes("🧠 Radar & GMGN"));
  assert.ok(labels.includes("📡 Feed settings"));
  assert.ok(labels.includes("🤖 Auto-LP panel"));
  assert.ok(labels.includes("🎯 Hunter settings"));
  assert.ok(labels.includes("👁 Watch settings"));
  assert.ok(callbacks.includes("settings:lp"));
  assert.ok(callbacks.includes("settings:gas"));
  assert.ok(callbacks.includes("settings:radar"));
});
