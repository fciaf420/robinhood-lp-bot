import test from "node:test";
import assert from "node:assert/strict";
import { clearRateLimit, isRateLimited, noteRateLimit, retryAfterMs } from "../src/radar/rateLimit.ts";

test("retry-after values are bounded and default safely", () => {
  assert.equal(retryAfterMs("2"), 2_000);
  assert.equal(retryAfterMs("999"), 8_000);
  assert.equal(retryAfterMs("invalid"), 5_000);
  assert.equal(retryAfterMs(null), 5_000);
});

test("rate-limit cooldown suppresses requests until the retry window ends", () => {
  clearRateLimit();
  noteRateLimit("2", 1_000);
  assert.equal(isRateLimited(2_999), true);
  assert.equal(isRateLimited(3_000), false);
  clearRateLimit();
});
