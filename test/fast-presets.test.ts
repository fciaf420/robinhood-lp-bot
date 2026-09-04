import test from "node:test";
import assert from "node:assert/strict";
import {
  fastMintCallback,
  fastSingleSideButtons,
  fastTwoSidedButtons,
  fastTwoSidedMintCallback,
  isFastPresetAmount,
} from "../src/telegram/fastPresets.ts";
import { classifyPoolInput } from "../src/telegram/poolInput.ts";
import { v4PoolTokenAddress } from "../src/chain/v4/discover.ts";
import { loadV4SwapPools, selectV4Pool } from "../src/chain/v4/mint.ts";

test("fast single-side presets show the amount, quote route, and configured auto range", () => {
  const rows = fastSingleSideButtons({ quote: "eth", availableEth: 0.2, widthPct: 50 });

  assert.deepEqual(
    rows.map((row) => row[0]?.callback_data),
    ["fast:0.1", "fast:0.05", "fast:0.01"],
  );
  assert.match(rows[0]![0]!.text, /0\.1 ETH/);
  assert.match(rows[0]![0]!.text, /Single-side ETH/);
  assert.match(rows[0]![0]!.text, /Auto 50%/);
});

test("fast presets label a token/USDG pool with its actual single-side route", () => {
  const rows = fastSingleSideButtons({ quote: "usd", availableEth: 0.2, widthPct: 35 });

  assert.match(rows[0]![0]!.text, /Single-side USDG/);
  assert.match(rows[0]![0]!.text, /Auto 35%/);
});

test("fast presets hide amounts that exceed the gas-safe balance", () => {
  const rows = fastSingleSideButtons({ quote: "eth", availableEth: 0.04, widthPct: 50 });

  assert.deepEqual(rows.map((row) => row[0]?.callback_data), ["fast:0.01"]);
});

test("fast two-sided presets show the fresh route and configured auto range", () => {
  const rows = fastTwoSidedButtons({ quote: "eth", availableEth: 0.2, widthPct: 50 });

  assert.deepEqual(
    rows.map((row) => row[0]?.callback_data),
    ["fast2:0.1", "fast2:0.05", "fast2:0.01"],
  );
  assert.match(rows[0]![0]!.text, /0\.1 ETH/);
  assert.match(rows[0]![0]!.text, /Two-sided fresh/);
  assert.match(rows[0]![0]!.text, /Auto 50%/);
});

test("fast two-sided presets label USDG pools with both acquisition legs", () => {
  const rows = fastTwoSidedButtons({ quote: "usd", availableEth: 0.2, widthPct: 35 });

  assert.match(rows[0]![0]!.text, /Two-sided · buy USDG \+ token/);
  assert.match(rows[0]![0]!.text, /Auto 35%/);
});

test("fast two-sided presets hide amounts that exceed the gas-safe balance", () => {
  const rows = fastTwoSidedButtons({ quote: "eth", availableEth: 0.04, widthPct: 50 });

  assert.deepEqual(rows.map((row) => row[0]?.callback_data), ["fast2:0.01"]);
});

test("fast preset callbacks accept only the fixed amounts shown to the user", () => {
  assert.equal(isFastPresetAmount("0.1"), true);
  assert.equal(isFastPresetAmount("0.05"), true);
  assert.equal(isFastPresetAmount("0.001"), false);
});

test("fast confirmation maps to the correct single-side mint for each quote", () => {
  assert.equal(fastMintCallback("v3", "eth"), "mint:single");
  assert.equal(fastMintCallback("v3", "usd"), "mint:v3us");
  assert.equal(fastMintCallback("v4", "eth"), "mint:v4");
  assert.equal(fastMintCallback("v4", "usd"), "mint:v4us");
});

test("fast two-sided confirmation maps to the in-range mint for each version", () => {
  assert.equal(fastTwoSidedMintCallback("v3", "eth"), "mint:inrange");
  assert.equal(fastTwoSidedMintCallback("v3", "usd"), "mint:v3u");
  assert.equal(fastTwoSidedMintCallback("v4", "eth"), "mint:v4r");
  assert.equal(fastTwoSidedMintCallback("v4", "usd"), "mint:v4r");
});

test("pool input accepts a v3 address or a v4 pool id", () => {
  assert.equal(classifyPoolInput("0x1111111111111111111111111111111111111111"), "address");
  assert.equal(classifyPoolInput("0x" + "11".repeat(32)), "v4-pool-id");
  assert.equal(classifyPoolInput("not-an-address"), "invalid");
});

test("v4 pool lookup identifies supported quote pairs and rejects token/token pools", () => {
  const token = "0x2222222222222222222222222222222222222222";
  const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const native = "0x0000000000000000000000000000000000000000";

  assert.equal(v4PoolTokenAddress({ poolKey: { currency0: native, currency1: token } }), token);
  assert.equal(v4PoolTokenAddress({ poolKey: { currency0: usdg, currency1: token } }), token);
  assert.equal(v4PoolTokenAddress({ poolKey: { currency0: token, currency1: "0x3333333333333333333333333333333333333333" } }), null);
});

test("an explicitly selected v4 pool wins over another pool with the same fee", () => {
  const key = { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x2222222222222222222222222222222222222222", fee: 30000, tickSpacing: 600, hooks: "0x0000000000000000000000000000000000000000" };
  const first = { poolKey: key, poolId: "0x" + "11".repeat(32), fee: 30000, tickSpacing: 600, sqrtPriceX96: 1n, tick: 0, liquidity: 1n, lpFee: 30000, quote: "eth" as const };
  const selected = { ...first, poolId: "0x" + "22".repeat(32) };

  assert.equal(selectV4Pool([first, selected], { fee: 30000, pool: selected }), selected);
});

test("v4 pool selection preserves a valid zero-fee tier", () => {
  const key = { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x2222222222222222222222222222222222222222", fee: 0, tickSpacing: 200, hooks: "0x0000000000000000000000000000000000000000" };
  const zeroFee = { poolKey: key, poolId: "0x" + "33".repeat(32), fee: 0, tickSpacing: 200, sqrtPriceX96: 1n, tick: 0, liquidity: 1n, lpFee: 0, quote: "eth" as const };
  const higherFee = { ...zeroFee, fee: 30000, lpFee: 30000, poolId: "0x" + "44".repeat(32) };

  assert.equal(selectV4Pool([higherFee, zeroFee], { fee: 0 }), zeroFee);
});

test("direct v4 entry reloads alternate pools before a fallback swap", async () => {
  const key = { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x2222222222222222222222222222222222222222", fee: 30000, tickSpacing: 600, hooks: "0x0000000000000000000000000000000000000000" };
  const selected = { poolKey: key, poolId: "0x" + "55".repeat(32), fee: 30000, tickSpacing: 600, sqrtPriceX96: 1n, tick: 0, liquidity: 1n, lpFee: 30000, quote: "eth" as const };
  const alternate = { ...selected, poolId: "0x" + "66".repeat(32), fee: 500, lpFee: 500 };
  let discoveredToken = "";

  const pools = await loadV4SwapPools(
    key.currency1,
    selected,
    async (token) => {
      discoveredToken = token;
      return [alternate];
    },
  );

  assert.equal(discoveredToken, key.currency1);
  assert.deepEqual(pools.map((pool) => pool.poolId), [alternate.poolId, selected.poolId]);
});
