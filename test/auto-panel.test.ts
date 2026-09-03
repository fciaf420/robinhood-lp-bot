import test from "node:test";
import assert from "node:assert/strict";
import { autoAdvancedButtons, autoEntryButtons, autoPanelKeyboard, exitRuleKeyboard } from "../src/telegram/autoPanel.ts";

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

test("Auto entry and advanced panels expose the important safety gates", () => {
  const entry = autoEntryButtons({ sizeEth: 0.001, minScore: 75, minLiqUsd: 20_000, maxTaxPct: 5, requireAction: "ape", requireLlm: true, requireGmgn: false });
  const advanced = autoAdvancedButtons({ compound: false, compoundMinUsd: 0.5, volFadeX: 0, vfadeMinAgeMin: 20, minFeePerHourUsd: 0, feeGraceMin: 30 });
  const labels = [...entry, ...advanced].map((b) => b.text).join(" | ");
  assert.match(labels, /Liquidity/);
  assert.match(labels, /Max tax/);
  assert.match(labels, /Require trusted LLM/);
  assert.match(labels, /Volume-fade minimum age/);
  assert.match(labels, /Fee-rate minimum age/);
});
