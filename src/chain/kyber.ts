/**
 * KyberSwap aggregator client — best-route swaps across ALL of the chain's liquidity (every
 * DEX, fee tier, hooked pool, and multi-hop), so acquiring a token never bleeds fee + price
 * impact from buying on a single thin pool. Adapted from labrinyang/lp-terminal (kyber.ts +
 * kyberExec.ts) for a server-side ethers wallet.
 *
 * SECURITY: kyber calldata is opaque, so every swap passes strict gates before broadcast:
 *   1. build.routerAddress must equal the whitelisted router (tx.to is ALWAYS the whitelist)
 *   2. tx value == amountIn for native ETH, else 0
 *   3. built amountIn == requested amountIn (spend integrity)
 *   4. built amountOut >= fresh quote − slippage (no execution drift)
 *   5. calldata is present, the input balance/allowance is sufficient, and eth_call + estimateGas pass
 *   6. after a hash exists, failures are reported with that hash and are never silently resubmitted
 */
import { ethers } from "ethers";
import { env, cfg } from "../config.js";
import { hasUsableCalldata, wallet, provider, overrides, waitTx, requireCalldata } from "./client.js";
import { logger } from "../util/log.js";

const log = logger("kyber");
export const KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"; // kyber sentinel for native ETH
const HEADERS = { "x-client-id": "robinhood-lp-bot" };

const api = () => `${env.kyberBase}/${env.kyberChain}/api/v1`;
export const kyberEnabled = (): boolean => !!env.kyberBase && !!env.kyberRouter;

interface RouteData {
  routeSummary: any;
  routerAddress: string;
}

const MAX_KYBER_SLIPPAGE_BPS = 2_000; // Kyber's capped API range is 0–20%.

function isKyberAsset(value: unknown): value is string {
  return typeof value === "string" && ethers.isAddress(value);
}

function sameAsset(a: unknown, b: string): boolean {
  return isKyberAsset(a) && a.toLowerCase() === b.toLowerCase();
}

function parseUint(value: unknown, label: string, allowZero = true): bigint {
  const text = typeof value === "bigint" ? value.toString() : typeof value === "number" ? (Number.isSafeInteger(value) ? String(value) : "") : typeof value === "string" ? value : "";
  if (!/^\d+$/.test(text)) throw new Error(`Kyber ${label} is missing or invalid`);
  const parsed = BigInt(text);
  if (!allowZero && parsed === 0n) throw new Error(`Kyber ${label} is zero`);
  return parsed;
}

function shortError(error: unknown, max = 160): string {
  return String((error as any)?.shortMessage || (error as any)?.message || error).slice(0, max);
}

/** A hash was returned, so callers must inspect/reconcile instead of submitting a second swap. */
export class KyberBroadcastUnknownError extends Error {
  readonly kyberBroadcasted = true;
  readonly txHash: string;

  constructor(message: string, txHash: string) {
    super(`${message} — tx ${txHash}`);
    this.name = "KyberBroadcastUnknownError";
    this.txHash = txHash;
  }
}

export function isKyberBroadcastUnknown(error: unknown): boolean {
  return error instanceof KyberBroadcastUnknownError || (error as { kyberBroadcasted?: unknown } | null)?.kyberBroadcasted === true;
}

/** Kyber has returned both a flat `data` field and transaction-shaped data across API versions. */
export function extractKyberCalldata(build: any): string {
  const candidates = [build?.data, build?.callData, build?.transaction?.data, build?.transaction?.input, build?.transaction?.callData, build?.encodedSwapData];
  const data = candidates.find((value): value is string => hasUsableCalldata(value));
  return requireCalldata(data, "Kyber route");
}

/** GET /routes — the optimal route + quote. Returns null on any failure. */
export async function kyberRoute(tokenIn: string, tokenOut: string, amountIn: bigint, origin?: string): Promise<RouteData | null> {
  try {
    if (!isKyberAsset(tokenIn) || !isKyberAsset(tokenOut) || tokenIn.toLowerCase() === tokenOut.toLowerCase() || amountIn <= 0n) return null;
    const u = new URL(`${api()}/routes`);
    u.searchParams.set("tokenIn", tokenIn);
    u.searchParams.set("tokenOut", tokenOut);
    u.searchParams.set("amountIn", amountIn.toString());
    u.searchParams.set("gasInclude", "true");
    if (origin && ethers.isAddress(origin)) u.searchParams.set("origin", origin);
    const r = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || j?.code !== 0 || !j?.data?.routeSummary) {
      log.warn(`routes failed: ${j?.message ?? r.status}`);
      return null;
    }
    const summary = j.data.routeSummary;
    if (!sameAsset(summary.tokenIn, tokenIn) || !sameAsset(summary.tokenOut, tokenOut)) {
      log.warn("routes returned a different asset pair — refusing route");
      return null;
    }
    if (parseUint(summary.amountIn, "route amountIn") !== amountIn || parseUint(summary.amountOut, "route amountOut", false) <= 0n || !isKyberAsset(j.data.routerAddress)) {
      log.warn("routes returned invalid amounts or router — refusing route");
      return null;
    }
    return j.data as RouteData;
  } catch (e) {
    log.warn(`route error: ${shortError(e, 80)}`);
    return null;
  }
}

/** POST /route/build — encode the route into calldata. Returns null on failure. */
async function kyberBuild(routeSummary: any, sender: string, recipient: string, slippageBps: number): Promise<any | null> {
  try {
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const r = await fetch(`${api()}/route/build`, {
      method: "POST",
      headers: { ...HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ routeSummary, sender, recipient, origin: sender, slippageTolerance: slippageBps, deadline, source: "robinhood-lp-bot", enableGasEstimation: false }),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || j?.code !== 0 || !j?.data) {
      log.warn(`route build failed: ${j?.message ?? r.status}`);
      return null;
    }
    // Normalize the documented flat shape and older transaction-shaped responses into one
    // internal shape. Empty data is rejected before any approval or broadcast can happen.
    return { ...j.data, data: extractKyberCalldata(j.data) };
  } catch (e) {
    log.warn(`build error: ${shortError(e, 80)}`);
    return null;
  }
}

export interface KyberSwapResult {
  tx: string;
  amountOut: bigint; // actual tokenOut received (balance delta)
}

/** Approve the Kyber router and verify the allowance before simulating the swap. */
async function ensureKyberAllowance(tokenIn: string, amountIn: bigint, w: ethers.Wallet): Promise<void> {
  const erc = new ethers.Contract(tokenIn, [
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ], w);
  const balance: bigint = await erc.balanceOf!(w.address);
  if (balance < amountIn) {
    throw new Error(`Kyber input balance is ${balance} but the swap needs ${amountIn}`);
  }
  if ((await erc.allowance!(w.address, env.kyberRouter)) >= amountIn) return;

  // Populate and simulate the approval first. This prevents a malformed token transaction from
  // reaching the RPC and makes the empty-calldata guard apply to approvals as well as swaps.
  const request = await erc.approve!.populateTransaction(env.kyberRouter, amountIn);
  const data = requireCalldata(request.data, "Kyber approval");
  await provider.call({ to: request.to ?? tokenIn, data, from: w.address });
  let tx: ethers.TransactionResponse;
  try {
    tx = await w.sendTransaction({ ...request, data, ...(await overrides()) });
  } catch (e) {
    throw new Error(`Kyber token approval failed before broadcast — ${shortError(e, 140)}`);
  }
  try {
    const receipt = await waitTx(tx, "kyber-approve");
    if (!receipt || receipt.status !== 1) throw new Error("approval transaction reverted");
  } catch (e) {
    // A nonce race can occur with another signer using this wallet. If the approval actually
    // landed despite an ambiguous RPC response, do not report failure or submit it again.
    const current = await erc.allowance!(w.address, env.kyberRouter).catch(() => 0n);
    if (current >= amountIn) return;
    throw new KyberBroadcastUnknownError(`Kyber token approval was broadcast but confirmation is unknown (${shortError(e, 120)})`, tx.hash);
  }

  const confirmed = await erc.allowance!(w.address, env.kyberRouter).catch(() => 0n);
  if (confirmed < amountIn) throw new KyberBroadcastUnknownError("Kyber token approval receipt succeeded but allowance is not visible", tx.hash);
}

/**
 * Best-route swap. tokenIn = KYBER_NATIVE for ETH. Returns null if the aggregator can't route
 * (caller can fall back). Throws only on a SECURITY gate failure (never silently unsafe).
 */
export async function kyberSwap(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<KyberSwapResult | null> {
  if (!kyberEnabled() || amountIn <= 0n) return null;
  const w = wallet();
  if (!isKyberAsset(tokenIn) || !isKyberAsset(tokenOut) || tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    throw new Error("Kyber swap has an invalid or identical asset pair");
  }
  if (!isKyberAsset(env.kyberRouter)) throw new Error("Kyber router address is invalid — no swap was submitted");
  const nativeIn = tokenIn.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const configuredSlippage = Number(cfg.lp.slippagePct ?? 5);
  if (!Number.isFinite(configuredSlippage) || configuredSlippage < 0 || configuredSlippage * 100 > MAX_KYBER_SLIPPAGE_BPS) {
    throw new Error("Kyber slippage must be between 0% and 20% (the API cap)");
  }
  const slippageBps = Math.round(configuredSlippage * 100);

  // measure output by balance delta (native ETH out → getBalance; ERC20 → balanceOf)
  const nativeOut = tokenOut.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const outErc = nativeOut ? null : new ethers.Contract(tokenOut, ["function balanceOf(address) view returns (uint256)"], provider);
  const outBal = async (): Promise<bigint> => {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        const balance = nativeOut ? await provider.getBalance(w.address) : await outErc!.balanceOf!(w.address);
        return parseUint(balance, "output balance");
      } catch (e) {
        last = e;
        if (i < 2) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
      }
    }
    throw new Error(`Kyber output balance read failed — ${shortError(last, 120)}`);
  };
  let prepared: { calldata: string; value: bigint; gasLimit: bigint; txOverrides: ethers.Overrides } | null = null;

  // Quote, build, approve, simulate, and estimate are all retried with a fresh route. Once a
  // transaction is broadcast, we never blindly resubmit it: an unknown receipt could otherwise
  // turn a transient RPC error into a double sell.
  for (let attempt = 0; attempt < 3 && !prepared; attempt++) {
    const route = await kyberRoute(tokenIn, tokenOut, amountIn, w.address);
    const built = route ? await kyberBuild(route.routeSummary, w.address, w.address, slippageBps) : null;
    if (!route || !built) {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }

    // ── security gates ──
    if (!isKyberAsset(built.routerAddress) || !sameAsset(built.routerAddress, env.kyberRouter)) {
      throw new Error(`kyber router mismatch: ${built.routerAddress} ≠ whitelist`);
    }
    const value = parseUint(built.transactionValue ?? built.value ?? built.transaction?.value ?? "0", "transaction value");
    if (value !== (nativeIn ? amountIn : 0n)) throw new Error(`kyber value sanity: got ${value}, want ${nativeIn ? amountIn : 0n}`);
    const quotedOut = parseUint(route.routeSummary.amountOut, "route amountOut", false);
    const minOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
    const builtIn = parseUint(built.amountIn, "build amountIn");
    const builtOut = parseUint(built.amountOut, "build amountOut", false);
    if (builtIn !== amountIn || builtOut < minOut) {
      throw new Error(`kyber build deviates (in ${built.amountIn}, out ${built.amountOut} < ${minOut})`);
    }
    const calldata = extractKyberCalldata(built);

    // ERC20 input → exact-amount approve to the router (native in carries value, no approve)
    if (!nativeIn) await ensureKyberAllowance(tokenIn, amountIn, w);

    try {
      await provider.call({ to: env.kyberRouter, data: calldata, value, from: w.address }); // simulate (unbounded gas)
      // Kyber's router can under-estimate hooked/v4 routes, so use a 2× buffer. A failed estimate
      // is not safe to replace with a blind default: refresh the route instead.
      const est = await provider.estimateGas({ to: env.kyberRouter, data: calldata, value, from: w.address });
      const gasLimit = est * 2n;
      const txOverrides = await overrides();
      let feePerGas = 0n;
      if (txOverrides.gasPrice != null) {
        feePerGas = parseUint(txOverrides.gasPrice, "gas price");
      } else {
        const feeData = await provider.getFeeData();
        feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      }
      const nativeBalance = await provider.getBalance(w.address);
      const maxCost = value + gasLimit * feePerGas;
      if (nativeBalance < maxCost) {
        throw new Error(`Kyber native balance insufficient for value + gas: need up to ${ethers.formatEther(maxCost)} ETH, have ${ethers.formatEther(nativeBalance)} ETH`);
      }
      prepared = { calldata, value, gasLimit, txOverrides };
    } catch (e) {
      const msg = shortError(e);
      if (msg.includes("Kyber native balance insufficient")) throw e;
      if (attempt === 2) throw new Error(`Kyber preflight reverted after 3 fresh attempts: ${msg}`);
      log.warn(`Kyber preflight failed (attempt ${attempt + 1}/3): ${msg} — refreshing route`);
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!prepared) return null;

  const before = await outBal();
  let tx: ethers.TransactionResponse;
  try {
    tx = await w.sendTransaction({ to: env.kyberRouter, data: prepared.calldata, value: prepared.value, gasLimit: prepared.gasLimit, ...prepared.txOverrides });
  } catch (e) {
    // No hash means no broadcast was confirmed; ResilientWallet may safely retry nonce/provider
    // conflicts. Once a hash exists, all errors below are explicitly non-retryable.
    throw e;
  }
  let receipt: ethers.TransactionReceipt | null = null;
  try {
    receipt = await waitTx(tx, "kyber-swap");
    if (!receipt) throw new Error("receipt was not returned");
    if (receipt.status !== 1) throw new Error("swap transaction reverted");
  } catch (e) {
    throw new KyberBroadcastUnknownError(`Kyber swap was broadcast but ${receiptErrorText(e)}`, tx.hash);
  }
  let after: bigint;
  try {
    after = await outBal();
  } catch (e) {
    throw new KyberBroadcastUnknownError(`Kyber swap confirmed but output balance could not be read (${shortError(e, 100)})`, tx.hash);
  }
  const gasPaid = nativeOut ? receipt.gasUsed * (receipt.gasPrice ?? prepared.txOverrides.gasPrice ?? 0n) : 0n;
  const amountOut = nativeOut
    ? after + gasPaid > before ? after + gasPaid - before : 0n
    : after > before ? after - before : 0n;
  if (amountOut <= 0n) throw new KyberBroadcastUnknownError("Kyber swap confirmed but no output reached the wallet", tx.hash);
  return { tx: tx.hash, amountOut };
}

function receiptErrorText(error: unknown): string {
  return String((error as any)?.message || error || "confirmation failed").slice(0, 140);
}

/** Human route breakdown: "60% uniswapv3 · 40% up-v3". */
export function routeBreakdown(rs: any): string {
  const amountIn = BigInt(rs?.amountIn || "0");
  if (amountIn === 0n || !Array.isArray(rs?.route)) return "";
  const parts: string[] = [];
  for (const path of rs.route) {
    if (!path?.length) continue;
    const pct = Number((BigInt(path[0].swapAmount || "0") * 1000n) / amountIn) / 10;
    const names = [...new Set(path.map((h: any) => h.exchange))].join("→");
    parts.push(`${pct}% ${names}`);
  }
  return parts.join(" · ");
}
