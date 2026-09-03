import test from "node:test";
import assert from "node:assert/strict";
import { sellableTokenButtons } from "../src/telegram/handlers.ts";

test("sell menu creates a Kyber token button for every sellable wallet token", () => {
  const rows = sellableTokenButtons([
    { addr: "0x0000000000000000000000000000000000000001", symbol: "ALPHA", decimals: 18, raw: 100n, ui: 1, ethOut: 0.01, usd: 24 },
    { addr: "0x0000000000000000000000000000000000000002", symbol: "BETA", decimals: 6, raw: 2500000n, ui: 2.5, ethOut: 0.02, usd: 48 },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0]![0]!.callback_data, "swf:0x0000000000000000000000000000000000000001");
  assert.equal(rows[1]![0]!.callback_data, "swf:0x0000000000000000000000000000000000000002");
  assert.match(rows[0]![0]!.text, /ALPHA/);
  assert.match(rows[1]![0]!.text, /BETA/);
});
