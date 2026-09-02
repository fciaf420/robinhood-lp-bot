import test from "node:test";
import assert from "node:assert/strict";
import { tokenLabel } from "../src/chain/tokens.ts";

test("token label uses symbol, then name, then shortened address", () => {
  const addr = "0x39dbed3a2bd333467115de45665cc57f813c4571";
  assert.equal(tokenLabel("PONS", "Pons", addr), "PONS");
  assert.equal(tokenLabel("?", "Pons", addr), "Pons");
  assert.equal(tokenLabel("?", "?", addr), "0x39db…4571");
});
