import test from "node:test";
import assert from "node:assert/strict";
import { screenDisplayCount } from "../src/telegram/screenDisplay.ts";

test("screen display stays below Telegram message limits when LLM theses are present", () => {
  assert.equal(screenDisplayCount(15, true), 8);
  assert.equal(screenDisplayCount(4, true), 4);
  assert.equal(screenDisplayCount(15, false), 12);
});
