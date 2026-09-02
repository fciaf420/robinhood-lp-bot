import test from "node:test";
import assert from "node:assert/strict";
import { explorerTx, explorerTxLink } from "../src/telegram/tg.ts";

test("transaction links point to Robinhood Blockscout and explain that they are inspectable", () => {
  const hash = "0xabc123";

  assert.equal(explorerTx(hash), "https://robinhoodchain.blockscout.com/tx/0xabc123");
  assert.equal(
    explorerTxLink(hash),
    '<a href="https://robinhoodchain.blockscout.com/tx/0xabc123">View on-chain</a>',
  );
});
