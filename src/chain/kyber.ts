/**
 * KyberSwap aggregator client — best-route swaps across ALL of the chain's liquidity (every
 * DEX, fee tier, hooked pool, and multi-hop), so acquiring a token never bleeds fee + price
 * impact from buying on a single thin pool. Adapted from labrinyang/lp-terminal (kyber.ts +
 * kyberExec.ts) for a server-side ethers wallet.
 *
 * SECURITY: kyber calldata is opaque, so every swap passes 4 gates before broadcast:
 *   1. build.routerAddress must equal the whitelisted router (tx.to is ALWAYS the whitelist)
 *   2. tx value == amountIn for native ETH, else 0
 *   3. built amountIn == requested amountIn (spend integrity)
 *   4. built amountOut >= fresh quote − slippage (no execution drift)
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

/** Kyber has returned both a flat `data` field and transaction-shaped data across API versions. */
export function extractKyberCalldata(build: any): string {
  const candidates = [build?.data, build?.transaction?.data, build?.transaction?.input, build?.encodedSwapData];
  const data = candidates.find((value): value is string => hasUsableCalldata(value));
  return requireCalldata(data, "Kyber route");
}

/** GET /routes — the optimal route + quote. Returns null on any failure. */
export async function kyberRoute(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<RouteData | null> {
  try {
    const u = new URL(`${api()}/routes`);
    u.searchParams.set("tokenIn", tokenIn);
    u.searchParams.set("tokenOut", tokenOut);
    u.searchParams.set("amountIn", amountIn.toString());
    u.searchParams.set("gasInclude", "true");
    const r = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || j?.code !== 0 || !j?.data?.routeSummary) {
      log.warn(`routes failed: ${j?.message ?? r.status}`);
      return null;
    }
    return j.data as RouteData;
  } catch (e) {
    log.warn(`route error: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

/** POST /route/build — encode the route into calldata. Returns null on failure. */
async function kyberBuild(routeSummary: any, sender: string, recipient: string, slippageBps: number): Promise<any | null> {
  try {
    const r = await fetch(`${api()}/route/build`, {
      method: "POST",
      headers: { ...HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ routeSummary, sender, recipient, slippageTolerance: slippageBps, source: "robinhood-lp-bot", enableGasEstimation: false }),
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
    log.warn(`build error: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

export interface KyberSwapResult {
  tx: string;
  amountOut: bigint; // actual tokenOut received (balance delta)
}

/**
 * Best-route swap. tokenIn = KYBER_NATIVE for ETH. Returns null if the aggregator can't route
 * (caller can fall back). Throws only on a SECURITY gate failure (never silently unsafe).
 */
export async function kyberSwap(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<KyberSwapResult | null> {
  if (!kyberEnabled() || amountIn <= 0n) return null;
  const w = wallet();
  const nativeIn = tokenIn.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const slippageBps = Math.round((cfg.lp.slippagePct || 5) * 100);

  // measure output by balance delta (native ETH out → getBalance; ERC20 → balanceOf)
  const nativeOut = tokenOut.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const outErc = nativeOut ? null : new ethers.Contract(tokenOut, ["function balanceOf(address) view returns (uint256)"], provider);
  const outBal = async (): Promise<bigint> => (nativeOut ? provider.getBalance(w.address) : outErc!.balanceOf!(w.address).catch(() => 0n));
  let prepared: { calldata: string; value: bigint; gasLimit: bigint } | null = null;

  // Quote, build, approve, simulate, and estimate are all retried with a fresh route. Once a
  // transaction is broadcast, we never blindly resubmit it: an unknown receipt could otherwise
  // turn a transient RPC error into a double sell.
  for (let attempt = 0; attempt < 3 && !prepared; attempt++) {
    const route = await kyberRoute(tokenIn, tokenOut, amountIn);
    const built = route ? await kyberBuild(route.routeSummary, w.address, w.address, slippageBps) : null;
    if (!route || !built) {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }

    // ── security gates ──
    if (ethers.getAddress(built.routerAddress) !== ethers.getAddress(env.kyberRouter)) {
      throw new Error(`kyber router mismatch: ${built.routerAddress} ≠ whitelist`);
    }
    const value = BigInt(built.transactionValue ?? "0");
    if (value !== (nativeIn ? amountIn : 0n)) throw new Error(`kyber value sanity: got ${value}, want ${nativeIn ? amountIn : 0n}`);
    const quotedOut = BigInt(route.routeSummary.amountOut);
    const minOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
    if (BigInt(built.amountIn) !== amountIn || BigInt(built.amountOut) < minOut) {
      throw new Error(`kyber build deviates (in ${built.amountIn}, out ${built.amountOut} < ${minOut})`);
    }
    const calldata = extractKyberCalldata(built);

    // ERC20 input → exact-amount approve to the router (native in carries value, no approve)
    if (!nativeIn) {
      const erc = new ethers.Contract(tokenIn, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], w);
      if ((await erc.allowance!(w.address, env.kyberRouter)) < amountIn) {
        await waitTx(await erc.approve!(env.kyberRouter, amountIn, await overrides()), "kyber-approve");
      }
    }

    try {
      await provider.call({ to: env.kyberRouter, data: calldata, value, from: w.address }); // simulate (unbounded gas)
      // Kyber's router can under-estimate hooked/v4 routes, so use a 2× buffer. A failed estimate
      // is not safe to replace with a blind default: refresh the route instead.
      const est = await provider.estimateGas({ to: env.kyberRouter, data: calldata, value, from: w.address });
      prepared = { calldata, value, gasLimit: est * 2n };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 160);
      if (attempt === 2) throw new Error(`Kyber preflight reverted after 3 fresh attempts: ${msg}`);
      log.warn(`Kyber preflight failed (attempt ${attempt + 1}/3): ${msg} — refreshing route`);
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!prepared) return null;

  const before = await outBal();
  const tx = await w.sendTransaction({ to: env.kyberRouter, data: prepared.calldata, value: prepared.value, gasLimit: prepared.gasLimit, ...(await overrides()) });
  await waitTx(tx, "kyber-swap");
  const after = await outBal();
  return { tx: tx.hash, amountOut: after > before ? after - before : 0n };
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
