/**
 * v2 LP open — "zap" a single native deposit into a full-range token/wrapped-native position.
 * v2 has no ranges and no single-side: liquidity is always both-sided 50/50 by value, so we wrap
 * native → wrapped, swap the optimal fraction → token (zap formula, 0.3% fee), then add both sides
 * to the pair (mint LP). Every step is simulated before broadcast.
 *
 * WRAPPED-NATIVE ONLY: the whole zap is built around a WETH side, so this path does not exist on
 * a chain without a WETH9 (Arc) — see v2/pair.ts. It refuses up front rather than wrapping into
 * the zero address.
 */
import { ethers } from "ethers";
import { C } from "../../config.js";
import { wallet, overrides } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { WETH_ABI, ERC20_ABI } from "../abis.js";
import { readV2Pool, pairContract, getAmountOut, zapSwapAmount, v2UnsupportedReason, type V2Pool } from "./pair.js";
import { natSym, chainId, parseNat, fmtNat } from "../currency.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const log = logger("v2mint");
const POS_FILE = dataPath("v2-positions.json");

/** `depositWei` is NATIVE wei (the name is frozen — data/v2-positions.json is never migrated). */
type V2Dep = { depositWei: string; ts: number; token: string; pair: string; nat?: string; chainId?: number };

export function saveV2Deposit(pair: string, rec: V2Dep): void {
  const d = readJson<Record<string, V2Dep>>(POS_FILE, {});
  d[pair.toLowerCase()] = { nat: natSym(), chainId: chainId(), ...rec };
  writeJson(POS_FILE, d);
}
export function loadV2Deposit(pair: string): V2Dep | null {
  return readJson<Record<string, V2Dep>>(POS_FILE, {})[pair.toLowerCase()] ?? null;
}
export function dropV2Deposit(pair: string): void {
  const d = readJson<Record<string, V2Dep>>(POS_FILE, {});
  delete d[pair.toLowerCase()];
  writeJson(POS_FILE, d);
}

export interface V2OpenResult {
  txHash: string; // the mint (add-liquidity) tx
  wrapHash?: string;
  swapHash?: string;
  pair: string;
  lpMinted: string;
  depositEth: string;
  symbol: string;
}

/**
 * Open (zap into) a full-range v2 token/WETH position from `amountEthStr` of ETH.
 * Sequence: wrap → swap zap fraction → transfer both sides → pair.mint.
 */
export async function openV2(token: string, amountEthStr: string): Promise<V2OpenResult> {
  const w = wallet();
  const unsupported = v2UnsupportedReason();
  if (unsupported) throw new Error(unsupported);
  const pool = await readV2Pool(token);
  if (!pool) throw new Error("no v2/WETH pool with liquidity");
  const meta = await tokenMeta(token);
  // No budgetForOpen() clamp here: this path only runs on a chain WITH a wrapped native, where
  // the clamp is a no-op by construction (the budget comes from WETH, not the gas float).
  const deposit = parseNat(amountEthStr);

  const weth = new ethers.Contract(C.weth, WETH_ABI, w);
  const erc = new ethers.Contract(ethers.getAddress(token), ERC20_ABI, w);
  const gas = await overrides();

  // 1) ensure WETH balance ≥ deposit (wrap native ETH if needed)
  let wrapHash: string | undefined;
  const wethBal: bigint = await weth.balanceOf!(w.address);
  if (wethBal < deposit) {
    const need = deposit - wethBal;
    const tx = await weth.deposit!({ value: need, ...gas });
    await tx.wait();
    wrapHash = tx.hash;
  }

  // 2) swap the optimal WETH fraction → token (via the pair directly)
  const swapIn = zapSwapAmount(pool.wethReserve, deposit);
  if (swapIn <= 0n) throw new Error("zap amount 0 — deposit too small / pool abnormal");
  const tokenOut = getAmountOut(swapIn, pool.wethReserve, pool.tokenReserve);
  if (tokenOut <= 0n) throw new Error("swap zap: output 0 (pool dry?)");

  const pair = pairContract(pool.pair, w);
  // transfer WETH into the pair, then swap out the token to our wallet
  await (await weth.transfer!(pool.pair, swapIn, gas)).wait();
  const amount0Out = pool.wethIsToken0 ? 0n : tokenOut;
  const amount1Out = pool.wethIsToken0 ? tokenOut : 0n;
  try {
    await pair.swap!.staticCall(amount0Out, amount1Out, w.address, "0x");
  } catch (e) {
    throw new Error(`v2 swap simulation revert: ${short(e)}`);
  }
  const swapTx = await pair.swap!(amount0Out, amount1Out, w.address, "0x", gas);
  await swapTx.wait();

  // 3) add liquidity: transfer both sides in the CURRENT reserve ratio, then mint
  const fresh = await readV2Pool(token);
  if (!fresh) throw new Error("pool disappeared after swap");
  const wethLeft = deposit - swapIn;
  const tokBal: bigint = await erc.balanceOf!(w.address);
  const tokUse = tokBal < tokenOut ? tokBal : tokenOut; // use what we actually received
  const { addWeth, addTok } = ratioAmounts(wethLeft, tokUse, fresh);
  if (addWeth <= 0n || addTok <= 0n) throw new Error("add-liquidity amount 0");

  await (await weth.transfer!(pool.pair, addWeth, gas)).wait();
  await (await erc.transfer!(pool.pair, addTok, gas)).wait();
  try {
    await pair.mint!.staticCall(w.address);
  } catch (e) {
    throw new Error(`v2 mint simulation revert: ${short(e)}`);
  }
  const mintTx = await pair.mint!(w.address, gas);
  const rc = await mintTx.wait();
  const lpMinted = lpFromReceipt(rc!, pool.pair, w.address);

  saveV2Deposit(pool.pair, { depositWei: deposit.toString(), ts: Date.now(), token: ethers.getAddress(token), pair: pool.pair });
  log.info(`open v2 ${meta.symbol} ${fmtNat(deposit)} ${natSym()} pair ${pool.pair.slice(0, 10)} LP ${lpMinted}`);
  return {
    txHash: mintTx.hash,
    wrapHash,
    swapHash: swapTx.hash,
    pair: pool.pair,
    lpMinted,
    depositEth: amountEthStr,
    symbol: meta.symbol,
  };
}

/** Given held wrapped-native+token and current reserves, the max both-sided amounts in ratio. */
function ratioAmounts(wethHave: bigint, tokHave: bigint, p: V2Pool): { addWeth: bigint; addTok: bigint } {
  // token needed to pair with all our WETH: tokForWeth = wethHave · tokenReserve / wethReserve
  const tokForWeth = (wethHave * p.tokenReserve) / p.wethReserve;
  if (tokForWeth <= tokHave) return { addWeth: wethHave, addTok: tokForWeth };
  const wethForTok = (tokHave * p.wethReserve) / p.tokenReserve;
  return { addWeth: wethForTok, addTok: tokHave };
}

/** Pull the minted LP amount from the pair's Transfer(0x0 → recipient) event. */
function lpFromReceipt(rc: ethers.TransactionReceipt, pair: string, to: string): string {
  const TRANSFER = ethers.id("Transfer(address,address,uint256)");
  const ZERO = "0x" + "0".repeat(64);
  const toTopic = "0x" + to.slice(2).toLowerCase().padStart(64, "0");
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() === pair.toLowerCase() && lg.topics[0] === TRANSFER && lg.topics[1] === ZERO && lg.topics[2] === toTopic) {
      return BigInt(lg.data).toString();
    }
  }
  return "0";
}

function short(e: unknown): string {
  return ((e as any)?.shortMessage || (e as Error)?.message || "").slice(0, 140);
}
