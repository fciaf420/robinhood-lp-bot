import test from "node:test";
import assert from "node:assert/strict";
import { alchemyHoldingItems } from "../src/chain/holdings.ts";

test("Alchemy token balances are normalized into sell-scanner holdings", () => {
  const alpha = "0x0000000000000000000000000000000000000001";
  const dust = "0x0000000000000000000000000000000000000002";
  const invalid = "0x0000000000000000000000000000000000000003";

  assert.deepEqual(
    alchemyHoldingItems(
      [
        { contractAddress: alpha, tokenBalance: "0x0a" },
        { contractAddress: dust, tokenBalance: "0x0" },
        { contractAddress: invalid, tokenBalance: "0x" },
      ],
      new Map([[alpha, { decimals: 18, symbol: "ALPHA" }]]),
    ),
    [{ token: { type: "ERC-20", address_hash: alpha, decimals: 18, symbol: "ALPHA" }, value: "10" }],
  );
});
