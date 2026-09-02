/**
 * Approval hygiene for the single Robinhood hot wallet.
 *
 * This command discovers wallet ERC-20s, checks only protocol spenders used by
 * the bot, and zeros active allowances. It never sends a token transfer.
 */
import { ethers } from "ethers";
import { C, env } from "../config.js";
import { ERC20_ABI } from "./abis.js";
import { bsFetch } from "./blockscout.js";
import { overrides, provider, waitTx, wallet } from "./client.js";
import { USDG } from "./pools.js";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export type RevokeResult = {
  tokensScanned: number;
  allowancesFound: number;
  revoked: number;
  failed: number;
  failures: string[];
};

function knownSpenders(): string[] {
  return [...new Set([
    C.swapRouter02,
    C.positionManager,
    C.v4PositionManager,
    C.universalRouter,
    PERMIT2,
    env.kyberRouter,
  ].filter((x): x is string => typeof x === "string" && ADDRESS_RE.test(x)))];
}

type TokenPage = {
  items?: any[];
  next_page_params?: Record<string, string | number | null> | null;
};

async function walletTokenAddresses(owner: string): Promise<string[]> {
  const tokens = new Set<string>([C.weth, USDG]);
  let path = `/api/v2/addresses/${owner}/tokens?type=ERC-20`;
  for (let page = 0; page < 100; page++) {
    const body = await bsFetch<TokenPage>(path);
    if (!body || !Array.isArray(body.items)) {
      throw new Error("Blockscout token scan unavailable or incomplete; refusing to claim approvals are revoked");
    }
    for (const item of body.items) {
      const address = item?.token?.address_hash;
      if (typeof address === "string" && ADDRESS_RE.test(address)) {
        tokens.add(ethers.getAddress(address));
      }
    }
    const next = body.next_page_params;
    if (!next || typeof next !== "object") return [...tokens];
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) {
      if (value !== null && value !== undefined) query.set(key, String(value));
    }
    path = `/api/v2/addresses/${owner}/tokens?${query.toString()}`;
  }
  throw new Error("Blockscout token scan exceeded the safety page limit");
}

export async function revokeKnownApprovals(): Promise<RevokeResult> {
  const owner = wallet().address;
  const tokens = await walletTokenAddresses(owner);
  const spenders = knownSpenders();
  const result: RevokeResult = {
    tokensScanned: tokens.length,
    allowancesFound: 0,
    revoked: 0,
    failed: 0,
    failures: [],
  };

  for (const token of tokens) {
    const erc = new ethers.Contract(token, ERC20_ABI, provider);
    for (const spender of spenders) {
      try {
        const amount: bigint = await erc.allowance!(owner, spender);
        if (amount <= 0n) continue;
        result.allowancesFound++;
        const tx = await erc.approve!(spender, 0n, await overrides());
        await waitTx(tx, `revoke ${token.slice(0, 10)}→${spender.slice(0, 10)}`);
        result.revoked++;
      } catch (e) {
        result.failed++;
        result.failures.push(
          `${token.slice(0, 10)}→${spender.slice(0, 10)}: ${(e as Error).message.slice(0, 100)}`,
        );
      }
    }
  }

  return result;
}
