import test from "node:test";
import assert from "node:assert/strict";
import { cfg } from "../src/config.ts";

test("Auto-LP accepts pools through the 10% fee tier by default", () => {
  assert.equal(cfg.scan.feeMinPpm, 30_000);
  assert.equal(cfg.scan.feeMaxPpm, 100_000);
});
