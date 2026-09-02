import test from "node:test";
import assert from "node:assert/strict";
import { rangeBins } from "../src/telegram/format.ts";

test("range bins mark the current tick inside the range", () => {
  const bar = rangeBins(50, 0, 100, 10);
  assert.equal(bar, "🟩🟩🟩🟩🟩🔹🟦🟦🟦🟦");
});

test("range bins mark prices below and above the range", () => {
  assert.equal(rangeBins(-1, 0, 100, 6), "◀🟦🟦🟦🟦🟦🟦");
  assert.equal(rangeBins(100, 0, 100, 6), "🟦🟦🟦🟦🟦🟦▶");
});
