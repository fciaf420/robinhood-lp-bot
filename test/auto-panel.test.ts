import test from "node:test";
import assert from "node:assert/strict";
import { autoPanelKeyboard, exitRuleKeyboard } from "../src/telegram/autoPanel.ts";

test("auto panel exposes plain-English controls for the full Auto-LP setup", () => {
  const rows = autoPanelKeyboard({
    enabled: false,
    mode: "single",
    sources: ["watch-spike"],
    tpPct: 0,
    slPct: 0,
    closeOor: false,
  });
  const buttons = rows.flat();
  const labels = buttons.map((b) => b.text);
  const callbacks = buttons.map((b) => b.callback_data);

  assert.ok(labels.includes("▶️ Enable Auto-LP"));
  assert.ok(labels.includes("💰 Entry settings"));
  assert.ok(labels.includes("🛡 Position limits"));
  assert.ok(labels.includes("🎯 Entry mode"));
  assert.ok(labels.includes("🔎 Candidate sources"));
  assert.ok(labels.includes("📉 Exit rules"));
  assert.ok(callbacks.includes("auto:enable:ask"));
  assert.ok(callbacks.includes("auto:entry"));
  assert.ok(callbacks.includes("auto:limits"));
  assert.ok(callbacks.includes("auto:mode"));
  assert.ok(callbacks.includes("auto:sources"));
  assert.ok(callbacks.includes("auto:exits"));
});

test("exit rule panels offer custom take-profit and stop-loss percentages", () => {
  const tp = exitRuleKeyboard("tp", 37);
  const sl = exitRuleKeyboard("sl", 18);

  assert.ok(tp.flat().some((b) => b.text.startsWith("Custom percentage") && b.callback_data === "auto:tp:custom"));
  assert.ok(sl.flat().some((b) => b.text.startsWith("Custom percentage") && b.callback_data === "auto:sl:custom"));
  assert.ok(tp.flat().some((b) => b.text === "Custom percentage (37%) ✓"));
  assert.ok(sl.flat().some((b) => b.text === "Custom percentage (18%) ✓"));
});
