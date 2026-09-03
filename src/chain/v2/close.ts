/**
 * v2 close — burn the full LP position back to WETH + token, unwrap the WETH, and (if
 * autoSwapOnClose) sell the token side back through the same pair so the operator ends
 * in ETH. Burn is simulated (staticCall) before broadcast.
 */
import { ethers } from "ethers";
import { C, cfg } from "../../config.js";
import { wallet, overrides } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { WETH_ABI, ERC20_ABI } from "../abis.js";
import { pairContract, getAmountOut } from "./pair.js";
import { loadV2Deposit, dropV2Deposit } from "./mint.js";
import { ethUsd } from "../price.js";
import { appendLedger } from "../ledger.js";
import { unwrapAllWeth } from "../swaps.js";
import { logger } from "../../util/log.js";
import type { CloseReason } from "../../types.js";

const log = logger("v2close");
const WETH_L = C.weth.toLowerCase();

export interface V2CloseResult {
  reason: CloseReason;
  txHash: string;
  swapHash?: string;
  unwrapHash?: string;
  sym: string;
  recvEth: number; // WETH out (before/plus token-swap), pre-unwrap total in ETH
  recvToken: number; // token left in wallet if not auto-swapped
  soldToken: boolean;
  depEth: number | null;
  pnlEth: number | null;
  poolFeePpm: number;
}

export async function closeV2Position(pairAddr: string, opts: { autoSwap?: boolean; reason?: CloseReason } = {}): Promise<V2CloseResult> {
  const w = wallet();
  const gas = await overrides();
  const c = pairContract(pairAddr, w);
  const [t0, t1, bal] = await Promise.all([
    c.token0!() as Promise<string>,
    c.token1!() as Promise<string>,
    c.balanceOf!(w.address) as Promise<bigint>,
  ]);
  if (bal === 0n) throw new Error("LP balance is 0 — there is nothing to close");
  const wethIsT0 = t0.toLowerCase() === WETH_L;
  const tokenAddr = wethIsT0 ? t1 : t0;
  const meta = await tokenMeta(tokenAddr).catch(() => ({ symbol: "?", decimals: 18 }));
  const weth = new ethers.Contract(C.weth, WETH_ABI, w);
  const erc = new ethers.Contract(tokenAddr, ERC20_ABI, w);

  // transfer LP into the pair, then burn to our wallet
  await (await c.transfer!(pairAddr, bal, gas)).wait();
  try {
    await c.burn!.staticCall(w.address);
  } catch (e) {
    throw new Error(`v2 burn simulation reverted: ${((e as any)?.shortMessage || (e as Error)?.message || "").slice(0, 140)}`);
  }
  const wethBefore: bigint = await weth.balanceOf!(w.address);
  const tokBefore: bigint = await erc.balanceOf!(w.address);
  const burnTx = await c.burn!(w.address, gas);
  await burnTx.wait();
  const wethAfter: bigint = await weth.balanceOf!(w.address);
  const tokAfter: bigint = await erc.balanceOf!(w.address);

  let wethOut = wethAfter - wethBefore;
  const tokOut = tokAfter - tokBefore;

  // optionally sell the token side back through the pair → more WETH
  let swapHash: string | undefined;
  let soldToken = false;
  if ((opts.autoSwap ?? (cfg.lp.v2Enabled && cfg.lp.autoSwapOnClose)) && tokOut > 0n) {
    try {
      const res = await c.getReserves!();
      const rToken: bigint = wethIsT0 ? res[1] : res[0];
      const rWeth: bigint = wethIsT0 ? res[0] : res[1];
      const wethBack = getAmountOut(tokOut, rToken, rWeth);
      if (wethBack > 0n) {
        await (await erc.transfer!(pairAddr, tokOut, gas)).wait();
        const a0 = wethIsT0 ? wethBack : 0n;
        const a1 = wethIsT0 ? 0n : wethBack;
        await c.swap!.staticCall(a0, a1, w.address, "0x");
        const st = await c.swap!(a0, a1, w.address, "0x", gas);
        await st.wait();
        swapHash = st.hash;
        wethOut += wethBack;
        soldToken = true;
      }
    } catch (e) {
      log.warn(`v2 token auto-sell failed (token left in wallet): ${(e as Error).message.slice(0, 80)}`);
    }
  }

  // unwrap all WETH → native ETH
  let unwrapHash: string | undefined;
  if (wethOut > 0n) {
    const ut = await weth.withdraw!(wethOut, gas);
    await ut.wait();
    unwrapHash = ut.hash;
  }

  // Also clear any WETH that was already in the wallet before this close.
  try {
    const remaining = await unwrapAllWeth();
    if (remaining) unwrapHash = remaining.tx;
  } catch (e) {
    log.warn(`v2 close WETH unwrap skipped: ${(e as Error).message.slice(0, 100)}`);
  }

  const dep = loadV2Deposit(pairAddr);
  const depEth = dep ? Number(ethers.formatEther(dep.depositWei)) : null;
  const recvEth = Number(ethers.formatEther(wethOut));
  const pnlEth = depEth != null ? recvEth - depEth : null;

  // record to the unified ledger (v2 close → deposit/PnL in /ledger + stats)
  try {
    const px = await ethUsd().catch(() => 0);
    appendLedger({
      tokenId: pairAddr,
      sym: String(meta.symbol),
      version: "v2",
      pair: `${meta.symbol}/WETH`,
      mode: "inrange",
      openedAt: dep?.ts ?? null,
      closedAt: Date.now(),
      heldMs: dep?.ts ? Date.now() - dep.ts : null,
      depEth: depEth ?? 0,
      outEth: recvEth,
      feeEth: 0,
      poolFeePpm: 3000,
      pnlEth,
      pnlPct: pnlEth != null && depEth ? (pnlEth / depEth) * 100 : null,
      pnlUsd: pnlEth != null && px ? pnlEth * px : null,
      ethUsdAtClose: px || null,
      tokenKept: 0,
      tokenRug: 0,
      unsoldEth: 0,
      source: "bot",
      reason: opts.reason ?? "manual",
    });
  } catch (e) {
    log.warn(`failed to write v2 ledger ${pairAddr.slice(0, 10)}: ${(e as Error).message.slice(0, 80)}`);
  }

  dropV2Deposit(pairAddr);
  log.info(`close v2 ${meta.symbol} pair ${pairAddr.slice(0, 10)} → ${recvEth.toFixed(6)}Ξ`);
  return {
    reason: opts.reason ?? "manual",
    txHash: burnTx.hash,
    swapHash,
    unwrapHash,
    sym: String(meta.symbol),
    recvEth,
    recvToken: soldToken ? 0 : Number(ethers.formatUnits(tokOut, meta.decimals)),
    soldToken,
    depEth,
    pnlEth,
    poolFeePpm: 3000,
  };
}
