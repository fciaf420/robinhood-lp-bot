import test from "node:test";
import assert from "node:assert/strict";
import { mergeRuntimeConfig } from "../src/configPersistence.ts";

test("runtime config overrides preserve unrelated baseline settings", () => {
  const baseline = {
    chainId: 4663,
    lp: { slippagePct: 5, nativeTargetEth: 0.015 },
    autoLp: { enabled: false, maxOpen: 3 },
    scan: { intervalMin: 3 },
  };
  const runtime = {
    lp: { slippagePct: 2 },
    autoLp: { enabled: true },
  };

  assert.deepEqual(mergeRuntimeConfig(baseline, runtime), {
    chainId: 4663,
    lp: { slippagePct: 2, nativeTargetEth: 0.015 },
    autoLp: { enabled: true, maxOpen: 3 },
    scan: { intervalMin: 3 },
  });
});
