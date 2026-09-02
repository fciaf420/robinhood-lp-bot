import test from "node:test";
import assert from "node:assert/strict";
import { alchemyNftOwnerUrl, parseAlchemyOwnedNftIds } from "../src/chain/alchemy.ts";

test("Alchemy NFT fallback builds a Robinhood endpoint without changing the key", () => {
  const url = alchemyNftOwnerUrl(
    "https://robinhood-mainnet.g.alchemy.com/v2/test-key",
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
  );
  assert.match(url ?? "", /robinhood-mainnet\.g\.alchemy\.com\/nft\/v3\/test-key\/getNFTsForOwner/);
  assert.match(url ?? "", /contractAddresses%5B%5D=0x0000000000000000000000000000000000000002/);
  assert.equal(alchemyNftOwnerUrl("https://example.com/v2/key", "0x1", "0x2"), null);
});

test("Alchemy NFT fallback filters owned v4 NFTs by contract", () => {
  const contract = "0x0000000000000000000000000000000000000002";
  assert.deepEqual(
    parseAlchemyOwnedNftIds(
      {
        ownedNfts: [
          { contract: { address: contract }, tokenId: "1502601" },
          { contract: { address: "0x0000000000000000000000000000000000000003" }, tokenId: "8" },
          { contract: { address: contract }, tokenId: "not-a-number" },
        ],
      },
      contract,
    ),
    ["1502601"],
  );
});

test("Alchemy NFT fallback accepts items with omitted contract metadata", () => {
  assert.deepEqual(
    parseAlchemyOwnedNftIds({ ownedNfts: [{ tokenId: "1502601" }, { tokenId: "not-a-number" }] }, "0x0000000000000000000000000000000000000002"),
    ["1502601"],
  );
});
