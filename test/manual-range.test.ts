import test from "node:test";
import assert from "node:assert/strict";
import { widthInTicks } from "../src/chain/pools.ts";
import { MANUAL_RANGE_PRESETS, normalizeManualRangePct } from "../src/telegram/manualRange.ts";

test("manual range width follows the selected percentage", () => {
  assert.ok(widthInTicks(10, 100) > widthInTicks(10, 50));
  assert.equal(widthInTicks(10, 0), widthInTicks(10, 50));
});

test("manual range input accepts bounded positive percentages", () => {
  assert.equal(normalizeManualRangePct("25"), 25);
  assert.equal(normalizeManualRangePct(" 100.5 "), 100.5);
  assert.equal(normalizeManualRangePct("0"), null);
  assert.equal(normalizeManualRangePct("1001"), null);
  assert.equal(normalizeManualRangePct("nope"), null);
});

test("manual range presets are useful and stable", () => {
  assert.deepEqual(MANUAL_RANGE_PRESETS, [10, 25, 50, 100, 200]);
});
