import test from "node:test";
import assert from "node:assert/strict";
import { closeTokenPolicy } from "../src/chain/closePolicy.ts";

test("every close forces returned tokens through the ETH sweep", () => {
  assert.equal(closeTokenPolicy(true), true);
  assert.equal(closeTokenPolicy(false), true);
});
