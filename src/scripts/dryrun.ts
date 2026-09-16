/**
 * Dry-run an LP open — READ-ONLY, on the LIVE chain, using the bot's OWN modules.
 *
 * `probe-arc.ts` answers "does this chain look like what we think it is". This answers the
 * question after it: "would THIS BOT, on THIS chain, actually open a position on this token —
 * and what would it pick?" It walks the real decision path (discovery → pool choice → routing
 * quote → range maths → sizing) by importing the same functions `/lp` calls, so an integration
 * bug shows up here instead of half-way through a mint that has already spent money.
 *
 * Importing the real modules is the whole point. A re-implementation would drift from the code
 * it is supposed to be testing, and would prove nothing about it.
 *
 * NOTHING IS SENT. Every call below is eth_call / getLogs / an HTTP quote. The only wallet use
 * is reading balances and allowances. You can run this against a funded production wallet.
 *
 * Run:  npm run dryrun -- 0xToken [amount]            (Robinhood, the default chain)
 *       RH_CHAIN=arc npm run dryrun -- 0xToken 25     (Arc; amount is in native units = USDC)
 */
import { ethers } from "ethers";
import { cfg, C } from "../config.js";
import { CHAIN } from "../chain/profile.js";
import { provider, wallet } from "../chain/client.js";
import {
  natSym, fmtNat, parseNat, nativeUsd, gasReserveNat, budgetForOpen, nativeBalanceWei,
  hasWrapped, stableAddr, stableSym, stableDecimals, fmtStable, nativeIsStableQuote,
} from "../chain/currency.js";
import { tokenMeta } from "../chain/tokens.js";
import { findPools, findStableQuotePools, pickLpPool } from "../chain/pools.js";
import { discoverV4Pools, discoverV4StablePools, pickV4Pool } from "../chain/v4/discover.js";
import { previewRange } from "../chain/positions.js";
import { quoteBest } from "../chain/router.js";
import { ERC20_ABI } from "../chain/abis.js";
import type { PoolInfo } from "../types.js";

const PERMIT2_READ_ABI = ["function allowance(address,address,address) view returns (uint160,uint48,uint48)"];

let failures = 0;
let warnings = 0;

function head(t: string): void {
  console.log(`\n\x1b[1m── ${t}\x1b[0m`);
}
function ok(label: string, detail: string): void {
  console.log(`✅ ${label.padEnd(30)} ${detail}`);
}
function warn(label: string, detail: string): void {
  warnings++;
  console.log(`⚠️  ${label.padEnd(30)} ${detail}`);
}
function bad(label: string, detail: string): void {
  failures++;
  console.log(`❌ ${label.padEnd(30)} ${detail}`);
}
const short = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 130);

/** Bound every read — a dry run must never hang on a flaky node. */
function cap<T>(p: Promise<T>, ms: number, fb: T): Promise<T> {
  return Promise.race([p.catch(() => fb), new Promise<T>((r) => setTimeout(() => r(fb), ms))]);
}

async function main(): Promise<void> {
  const token = (process.argv[2] || "").trim();
  const amountStr = (process.argv[3] || "").trim() || String(cfg.autoLp.sizeEth || 0.001);
  if (!ethers.isAddress(token)) {
    console.error("usage: npm run dryrun -- 0xTokenAddress [amount]   (amount is in native units)");
    process.exit(2);
  }
  const tokenAddr = ethers.getAddress(token);

  console.log(`\n\x1b[1mLP dry run\x1b[0m — ${CHAIN.name} (chainId ${CHAIN.chainId})`);
  console.log(`token ${tokenAddr} · size ${amountStr} ${natSym()}`);
  console.log("read-only: no transaction is sent, nothing is approved\n");

  // ── 1. can we even reach the chain, and is it the chain we think ──────────────
  head("chain");
  try {
    const net = await provider.getNetwork();
    if (Number(net.chainId) === CHAIN.chainId) ok("connected", `chainId ${net.chainId} · block ${await provider.getBlockNumber()}`);
    else bad("chainId mismatch", `node says ${net.chainId}, profile says ${CHAIN.chainId} — WRONG RPC for this RH_CHAIN`);
  } catch (e) {
    bad("rpc", short(e));
    console.log("\nnothing else can run without an RPC.");
    process.exit(1);
  }

  // ── 2. the money that would fund this ────────────────────────────────────────
  head("wallet");
  // The key is only ever used to DERIVE AN ADDRESS here — balances and allowances are per-address
  // reads. Still, a missing key should say so plainly rather than surface as a crash on first run.
  let w: ReturnType<typeof wallet>;
  try {
    w = wallet();
  } catch (e) {
    bad("wallet", `${short(e)} — set RH_WALLET_KEY (in .env, or .env.arc for RH_CHAIN=arc)`);
    process.exit(1);
  }
  console.log(`   ${w.address}`);
  const natWei = await cap(nativeBalanceWei(), 15_000, 0n);
  const px = await cap(nativeUsd(), 12_000, 0);
  ok(`native ${natSym()}`, `${fmtNat(natWei)}${px ? `  ($${(Number(fmtNat(natWei)) * px).toFixed(2)})` : ""}`);

  const stableRaw = await cap(
    (new ethers.Contract(stableAddr(), ERC20_ABI, provider).balanceOf!(w.address)) as Promise<bigint>,
    15_000,
    0n,
  );
  ok(`quote ${stableSym()}`, `${fmtStable(stableRaw)} (${stableDecimals()} dec)`);

  // On a chain where the stable IS the native in another precision, these two lines are the SAME
  // money. Saying so here is the difference between "I have $50" and "I have $25 twice".
  if (nativeIsStableQuote()) {
    const scaled = Number(fmtStable(stableRaw));
    const nativeUi = Number(fmtNat(natWei));
    const parity = Math.abs(scaled - nativeUi) < Math.max(0.01, nativeUi * 0.001);
    (parity ? ok : warn)(
      "native/quote parity",
      parity
        ? "one balance, two precisions — do NOT add them together"
        : `native ${nativeUi} vs quote ${scaled} — they are NOT the same balance; chains/${CHAIN.key}.json native.erc20Parity is wrong`,
    );
  }

  // ── 3. sizing: what the gas reserve actually leaves ──────────────────────────
  head("sizing");
  const want = parseNat(amountStr);
  try {
    const budget = await budgetForOpen(want);
    if (budget === want) ok("budget", `${fmtNat(budget)} ${natSym()} (request passes through)`);
    else warn("budget CLAMPED", `${fmtNat(want)} → ${fmtNat(budget)} ${natSym()} (gas reserve ${gasReserveNat()} ${natSym()})`);
    if (budget === 0n) bad("budget", "nothing spendable after the gas reserve — fund the wallet first");
  } catch (e) {
    bad("budget", short(e));
  }
  const fee = await cap(provider.getFeeData(), 12_000, null);
  const gp = fee?.maxFeePerGas ?? fee?.gasPrice ?? null;
  if (gp) {
    // A v3 mint with a swap leg is ~600k gas end to end; this is the honest "what will the open cost".
    const costNat = Number(ethers.formatUnits(gp * 600_000n, 18));
    ok("est. gas for an open", `~${costNat.toFixed(6)} ${natSym()}${px ? ` ($${(costNat * px).toFixed(4)})` : ""} at ${ethers.formatUnits(gp, "gwei")} gwei`);
    if (gasReserveNat() < costNat) warn("gas reserve", `reserve ${gasReserveNat()} < one open's gas ${costNat.toFixed(6)} — a close may not be affordable`);
  }

  // ── 4. the token itself ──────────────────────────────────────────────────────
  head("token");
  try {
    const m = await tokenMeta(tokenAddr);
    ok("metadata", `${m.symbol} · ${m.decimals} dec · supply ${m.supplyUi.toLocaleString()}`);
  } catch (e) {
    bad("metadata", `${short(e)} — not an ERC-20 at this address?`);
  }

  // ── 5. discovery: exactly what /lp would find ────────────────────────────────
  head("pool discovery (the same calls /lp makes)");
  const [nativePools, stablePools, v4Native, v4Stable] = await Promise.all([
    cap(findPools(tokenAddr), 30_000, [] as PoolInfo[]),
    cap(findStableQuotePools(tokenAddr), 30_000, [] as PoolInfo[]),
    cap(discoverV4Pools(tokenAddr), 40_000, [] as Awaited<ReturnType<typeof discoverV4Pools>>),
    cap(discoverV4StablePools(tokenAddr), 40_000, [] as Awaited<ReturnType<typeof discoverV4StablePools>>),
  ]);
  const label = (n: number) => (n ? `${n} pool${n === 1 ? "" : "s"}` : "none");
  // A chain with no wrapped native CANNOT have a native-quoted v3 pool — reporting 0 there is
  // correct, not a failure, so it must not read as one.
  (hasWrapped() ? ok : (l: string, d: string) => ok(l, `${d}  (expected — no wrapped native)`))(
    `v3 ${natSym()}-quoted`, label(nativePools.length),
  );
  ok(`v3 ${stableSym()}-quoted`, label(stablePools.length));
  ok(`v4 native-quoted`, label(v4Native.length) + (CHAIN.venues.v4NativeCurrency ? "" : "  (disabled on this chain)"));
  ok(`v4 ${stableSym()}-quoted`, label(v4Stable.length));

  const v3pick = pickLpPool([...stablePools, ...nativePools]);
  const v4pick = pickV4Pool([...v4Stable, ...v4Native]);
  if (v3pick) ok("v3 pick", `${v3pick.pool} · fee ${(v3pick.fee / 10000).toFixed(2)}% · quote ${v3pick.quote ?? "eth"}`);
  if (v4pick) ok("v4 pick", `${v4pick.poolId} · fee ${(v4pick.fee / 10000).toFixed(2)}%`);
  if (!v3pick && !v4pick) {
    bad("pool pick", "NOTHING selectable — /lp would refuse this token on this chain");
  }

  // ── 6. routing: can we actually buy the token side, and could we sell it back ─
  head("routing (quote only — nothing is swapped)");
  const payWith = nativeIsStableQuote() || !hasWrapped() ? stableAddr() : C.weth;
  const payAmount = payWith === stableAddr()
    ? BigInt(Math.floor(Number(amountStr) * 10 ** stableDecimals()))
    : want;
  let bought = 0n;
  try {
    const q = await quoteBest(payWith, tokenAddr, payAmount);
    bought = q.amountOut;
    ok("buy quote", `${fmtStable(payAmount)} ${stableSym()} → ${q.amountOut} units via ${q.venue}${q.fee ? ` (fee ${(q.fee / 10000).toFixed(2)}%)` : ""}`);
  } catch (e) {
    bad("buy quote", `${short(e)} — no venue can route this token, so an in-range open would fail`);
  }
  if (bought > 0n) {
    // Buy→sell round trip IS the honeypot test: a token that quotes a buy but cannot quote a sell
    // is one you can enter and never leave.
    try {
      const back = await quoteBest(tokenAddr, payWith, bought);
      const retained = Number(back.amountOut) / Number(payAmount);
      const pct = (retained * 100).toFixed(1);
      if (retained > 0.85) ok("sell-back round trip", `${pct}% retained via ${back.venue} — sellable`);
      else if (retained > 0) warn("sell-back round trip", `${pct}% retained — heavy tax or thin liquidity`);
      else bad("sell-back round trip", "0% — HONEYPOT or unsellable, do not LP this");
    } catch (e) {
      bad("sell-back round trip", `${short(e)} — cannot quote a SELL. Treat as a honeypot.`);
    }
  }

  // ── 7. range maths on the pool the bot would actually use ────────────────────
  if (v3pick) {
    head("range preview (v3 pick)");
    for (const mode of ["single", "inrange"] as const) {
      try {
        const p = await previewRange(tokenAddr, v3pick.pool, mode);
        ok(mode, `ticks ${p.tickLower}…${p.tickUpper} (now ${p.tick}) · mcap $${p.mcapNow.toFixed(0)} → range $${p.rangeMcapLow.toFixed(0)}–$${p.rangeMcapHigh.toFixed(0)}${mode === "inrange" ? ` · swap ${p.swapPct}%` : ""}`);
      } catch (e) {
        bad(`range ${mode}`, short(e));
      }
    }
  }

  // ── 8. approvals the first open will have to pay for (read-only) ─────────────
  head("approval state");
  if (C.permit2) {
    const p2 = new ethers.Contract(C.permit2, PERMIT2_READ_ABI, provider);
    for (const [name, spender] of [
      ["UniversalRouter (swaps)", C.universalRouter],
      ["v4 PositionManager (mints)", C.v4PositionManager],
    ] as const) {
      if (!spender) continue;
      try {
        const a = await p2.allowance!(w.address, stableAddr(), spender);
        const exp = Number(a[1]);
        const live = BigInt(a[0]) > 0n && exp > Math.floor(Date.now() / 1000);
        ok(`permit2 → ${name}`, live ? `granted (expires ${new Date(exp * 1000).toISOString().slice(0, 16)})` : "not granted — the first open pays 2 approval txs");
      } catch (e) {
        warn(`permit2 → ${name}`, short(e));
      }
    }
  } else {
    warn("permit2", "no address in the chain profile — v4 paths cannot approve");
  }

  // ── verdict ──────────────────────────────────────────────────────────────────
  head("verdict");
  if (failures) {
    console.log(`   ❌ ${failures} blocking · ${warnings} warning(s) — do NOT open a position on this token yet.\n`);
    process.exit(1);
  }
  console.log(`   ✅ the full decision path resolves on ${CHAIN.name}${warnings ? ` (${warnings} warning(s) above)` : ""}.`);
  console.log(`   Next: open ONE small position from Telegram and close it before enabling /auto.\n`);
}

main().catch((e) => {
  console.error("dry run crashed:", e);
  process.exit(1);
});
