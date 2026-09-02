import test from "node:test";
import assert from "node:assert/strict";
import { briefingCooldownRemaining } from "../src/telegram/briefing.ts";

test("daily briefing cooldown allows a first run", () => {
  assert.equal(briefingCooldownRemaining(0, 1_000), 0);
});

test("daily briefing cooldown remains active until 24 hours have elapsed", () => {
  const now = 100 * 3_600_000;
  assert.equal(briefingCooldownRemaining(now - 23 * 3_600_000, now), 3_600_000);
  assert.equal(briefingCooldownRemaining(now - 24 * 3_600_000, now), 0);
  assert.equal(briefingCooldownRemaining(now - 25 * 3_600_000, now), 0);
});
