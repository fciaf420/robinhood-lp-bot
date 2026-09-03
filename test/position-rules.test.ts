import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dataPath } from "../src/util/files.ts";
import { clearPositionExitRule, getPositionExitRule, hasActivePositionExitRules, setPositionExitRule } from "../src/radar/positionRules.ts";
import { parsePositionRuleCallback } from "../src/telegram/handlers.ts";

test("position TP/SL callbacks keep the selected version and token id", () => {
  assert.deepEqual(parsePositionRuleCallback("pr:tp:v4:1554210"), { action: "tp", kind: "tp", version: "v4", tokenId: "1554210" });
  assert.deepEqual(parsePositionRuleCallback("pr:sl:v3:974286"), { action: "sl", kind: "sl", version: "v3", tokenId: "974286" });
});

test("per-position TP/SL rules persist, override, and can be cleared", () => {
  const file = dataPath("position-exit-rules.json");
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file) : null;
  const id = "999999999";
  try {
    if (existed) fs.rmSync(file);
    setPositionExitRule(id, "tp", 100);
    setPositionExitRule(id, "sl", 25);
    assert.deepEqual(getPositionExitRule(id), { tpPct: 100, slPct: 25 });
    assert.equal(hasActivePositionExitRules(), true);
    clearPositionExitRule(id, "tp");
    assert.deepEqual(getPositionExitRule(id), { slPct: 25 });
    clearPositionExitRule(id, "sl");
    assert.equal(getPositionExitRule(id), null);
    assert.equal(hasActivePositionExitRules(), false);
  } finally {
    if (original) fs.writeFileSync(file, original);
    else if (fs.existsSync(file)) fs.rmSync(file);
  }
});
