/**
 * v4 swaps via the UniversalRouter. Encodes V4_SWAP (0x10) →
 * [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]; verified by staticCall on chain 4663.
 *
 * TWO input shapes, because two chains:
 *
 *   native in (Robinhood) — the pool key holds the 0x0 sentinel, msg.value carries the input and
 *     there is NO approval anywhere in the flow. This is the path the live in-range v4 open uses.
 *
 *   ERC-20 in (Arc) — the native sentinel is forbidden in an Arc pool key (18-dec native USDC vs
 *     the 6-dec ERC-20 predeploy), so BOTH sides are ERC-20, msg.value is 0, and the router has to
 *     PULL the input. It pulls through Permit2, which means two approvals:
 *         1. token → Permit2            (a normal ERC-20 allowance)
 *         2. Permit2 → UniversalRouter  (the Permit2 allowance, uint160 + uint48 expiry)
 *     Note the spender in (2). The v4 MINT path approves Permit2 → PositionManager; a swap settles
 *     inside the UniversalRouter, so approving the PositionManager here reverts at SETTLE_ALL with
 *     an opaque error. Same helper shape as v4/mint.ts's approveViaPermit2, different spender —
 *     which is exactly why it is duplicated here rather than imported (importing mint.ts would
 *     also make this module ↔ mint.ts a cycle).
 *
 * Both shapes keep the pre-send eth_call simulation: a v4 swap that would revert never costs gas.
 */
import { ethers } from "ethers";
import { C, cfg } from "../../config.js";
import { wallet, provider, overrides, waitTx } from "../client.js";
import { ERC20_ABI } from "../abis.js";
import { V4QUOTER_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI } from "./abis.js";
import { NATIVE, isNativeCurrency, v4NativeCurrencyAllowed, type PoolKey } from "./poolkey.js";
import { logger } from "../../util/log.js";

const log = logger("v4swap");
const POOLKEY_TYPE = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const coder = ethers.AbiCoder.defaultAbiCoder();

// Permit2: same resolved address v4/mint.ts uses (config.ts owns the profile-or-canonical choice).
// It matters that these are one value: this file approves Permit2 → UniversalRouter while mint.ts
// approves the token → Permit2, and a mismatch reverts inside SETTLE_ALL with no useful message.
const PERMIT2 = C.permit2;
const PERMIT2_MAX = (1n << 160n) - 1n; // uint160 max — Permit2's "unlimited"
const PERMIT2_TTL_S = 30 * 86400;
const PERMIT2_RENEW_S = 3600; // re-approve when the grant expires within the hour

function poolKeyTuple(pk: PoolKey) {
  return [pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks];
}

function universalRouter(): string {
  if (!C.universalRouter) throw new Error("universalRouter belum ada di profil chain — swap v4 nggak bisa jalan.");
  return C.universalRouter;
}

/** Quote an exact-in single-hop v4 swap. Direction is the caller's (`zeroForOne`). */
export async function quoteV4(pk: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  const q = new ethers.Contract(C.v4Quoter!, V4QUOTER_ABI, provider);
  const r = await q.quoteExactInputSingle!.staticCall([poolKeyTuple(pk), zeroForOne, amountIn, "0x"]);
  return r[0] as bigint;
}

/** Build UniversalRouter execute() calldata for a single v4 exact-in swap. */
function buildSwapCalldata(pk: PoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint): string {
  const actions = "0x060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const inCur = zeroForOne ? pk.currency0 : pk.currency1;
  const outCur = zeroForOne ? pk.currency1 : pk.currency0;
  const swapParams = coder.encode(
    [`tuple(${POOLKEY_TYPE} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`],
    [[poolKeyTuple(pk), zeroForOne, amountIn, minOut, "0x"]],
  );
  const settleAll = coder.encode(["address", "uint256"], [inCur, amountIn]);
  const takeAll = coder.encode(["address", "uint256"], [outCur, minOut]);
  const v4Input = coder.encode(["bytes", "bytes[]"], [actions, [swapParams, settleAll, takeAll]]);
  const ur = new ethers.Interface([...UNIVERSAL_ROUTER_ABI]);
  return ur.encodeFunctionData("execute", ["0x10", [v4Input], Math.floor(Date.now() / 1000 + 600)]);
}

/** Slippage floor from cfg.lp.slippagePct — the SAME formula as swaps.ts, never widened. */
function minOutWithSlippage(amountOut: bigint): bigint {
  return (amountOut * BigInt(Math.round((100 - (cfg.lp.slippagePct || 5)) * 100))) / 10_000n;
}

/**
 * Make sure the UniversalRouter can pull `amount` of `token` through Permit2.
 * Only ever called for an ERC-20 input; a native input carries msg.value and needs nothing.
 */
async function ensurePermit2ForRouter(token: string, amount: bigint): Promise<void> {
  const w = wallet();
  const spender = universalRouter();
  const erc = new ethers.Contract(token, ERC20_ABI, w);
  if ((await erc.allowance!(w.address, PERMIT2)) < amount) {
    await waitTx(await erc.approve!(PERMIT2, ethers.MaxUint256, await overrides()), "v4swap-approve-permit2");
  }
  const p2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, w);
  // READ the existing grant instead of re-approving every swap: a Permit2 allowance is
  // (uint160 amount, uint48 expiration) and both can fail independently. Renew when the amount is
  // short OR the expiry is within the hour — an allowance that lapses between the check and
  // inclusion reverts inside SETTLE_ALL, which surfaces as a bare "execution reverted".
  let stale = true;
  try {
    const cur = await p2.allowance!(w.address, token, spender);
    stale = BigInt(cur[0]) < amount || Number(cur[1]) <= Math.floor(Date.now() / 1000) + PERMIT2_RENEW_S;
  } catch {
    stale = true; // can't read it → assume it isn't there (approving twice costs gas, not money)
  }
  if (stale) {
    const exp = Math.floor(Date.now() / 1000) + PERMIT2_TTL_S;
    await waitTx(await p2.approve!(token, spender, PERMIT2_MAX, exp, await overrides()), "v4swap-permit2");
  }
}

export interface V4SwapResult {
  tx: string;
  amountOut: bigint;
}

/**
 * Exact-in swap on ONE v4 pool, either direction, native or ERC-20 input.
 *
 * `quoted` lets a caller that already priced the pool (the router's quote-then-execute flow) skip
 * a duplicate Quoter round-trip. It is only ever used to derive the slippage floor — it can make
 * the floor no LOOSER than a fresh quote would, because it came from the same Quoter moments ago.
 */
export async function swapV4Single(
  pk: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  opts: { quoted?: bigint } = {},
): Promise<V4SwapResult> {
  if (amountIn <= 0n) return { tx: "", amountOut: 0n };
  const w = wallet();
  const to = universalRouter();
  const inCur = zeroForOne ? pk.currency0 : pk.currency1;
  const outCur = zeroForOne ? pk.currency1 : pk.currency0;
  const nativeIn = isNativeCurrency(inCur);
  const nativeOut = isNativeCurrency(outCur);

  const quoted = opts.quoted ?? (await quoteV4(pk, zeroForOne, amountIn).catch(() => 0n));
  // A quote of 0 means the Quoter reverted (dry pool, or a transient node error). minOut is then 0
  // — an UNPROTECTED swap. That is pre-existing behaviour on the live native path and is left
  // alone deliberately: hard-failing here would kill an open every time the Quoter hiccups, and
  // the caller already treats amountOut == 0 as "swap failed". It is logged so it is never silent.
  if (quoted <= 0n) log.warn(`quoter v4 balik 0 untuk pool ${pk.fee} — swap jalan TANPA floor slippage`);
  const minOut = minOutWithSlippage(quoted);
  const data = buildSwapCalldata(pk, zeroForOne, amountIn, minOut);
  const value = nativeIn ? amountIn : 0n;

  // ERC-20 in → the router pulls via Permit2 (spender = UniversalRouter). Native in → msg.value.
  if (!nativeIn) await ensurePermit2ForRouter(inCur, amountIn);

  const outErc = nativeOut ? null : new ethers.Contract(outCur, ERC20_ABI, provider);
  const outBal = async (): Promise<bigint> =>
    nativeOut ? provider.getBalance(w.address) : outErc!.balanceOf!(w.address).catch(() => 0n);
  const before = await outBal();

  // simulate then send — a revert here costs an eth_call, not gas
  await provider.call({ to, data, value, from: w.address });
  const tx = await w.sendTransaction({ to, data, value, ...(await overrides()) });
  const rc = await tx.wait();

  const after = await outBal();
  let delta = after > before ? after - before : 0n;
  // Native OUT is measured on the gas-paying balance, so the delta is (received − gas). Add the
  // fee back from the receipt or every native-out swap under-reports its own proceeds, which the
  // ledger would then book as a loss. Native IN is unaffected: the output is a token balance.
  if (nativeOut && rc) delta += rc.gasUsed * (rc.gasPrice ?? 0n);
  if (delta <= 0n) log.warn(`swap v4 ${tx.hash} delta 0 — cek receipt`);
  return { tx: tx.hash, amountOut: delta };
}

/**
 * Swap NATIVE → token on a v4 pool. Kept under its original name because v4/mint.ts's in-range
 * open calls it; it is now a thin direction-resolver over swapV4Single.
 *
 * Guarded on the profile: where the chain forbids the 0x0 sentinel (Arc) there is no native-paired
 * v4 pool at all, so reaching here means a pool key was built for the wrong chain — fail loudly
 * rather than silently swapping whatever currency happens to sit in the currency0 slot.
 */
export async function swapEthToTokenV4(pk: PoolKey, amountInWei: bigint): Promise<V4SwapResult> {
  if (!v4NativeCurrencyAllowed()) {
    throw new Error("chain ini nggak punya pool v4 ber-currency native — pakai swapV4Single dengan quote ERC-20.");
  }
  const zeroForOne = pk.currency0.toLowerCase() === NATIVE; // native(c0) → token(c1)
  return swapV4Single(pk, zeroForOne, amountInWei);
}
