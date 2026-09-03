import test from "node:test";
import assert from "node:assert/strict";
import { positiveBalanceDelta } from "../src/chain/balanceDelta.ts";

test("close settlement sweeps only the balance received by the position", () => {
  assert.equal(positiveBalanceDelta(150n, 100n), 50n);
  assert.equal(positiveBalanceDelta(100n, 100n), 0n);
  assert.equal(positiveBalanceDelta(90n, 100n), 0n);
});
