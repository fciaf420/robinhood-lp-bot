import test from "node:test";
import assert from "node:assert/strict";
import { mergeRuntimeConfig, migrateRuntimeConfig } from "../src/configPersistence.ts";

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

test("legacy 5% hunter cap is upgraded to the 10% Auto-LP cap", () => {
  const runtime = { scan: { feeMaxPpm: 50_000, minVolUsd: 10_000 } };

  assert.deepEqual(migrateRuntimeConfig(runtime), {
    scan: { feeMaxPpm: 100_000, minVolUsd: 10_000 },
  });
});
