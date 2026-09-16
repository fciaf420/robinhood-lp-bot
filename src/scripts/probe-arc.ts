/**
 * Arc mainnet preflight probe — READ-ONLY, no keys spent, no tx sent.
 *
 * Why this exists: the Arc address book below comes from first-party SDK packages
 * (@uniswap/sdk-core ARC_ADDRESSES, @uniswap/universal-router-sdk, @circle-fin/bridge-kit),
 * not from a doc page — but an SDK map can list an address before it is deployed, and two
 * Arc facts decide how the LP flow has to be built and cannot be read off any page:
 *
 *   1. NATIVE/ERC-20 PARITY. Arc's gas token is USDC with an 18-decimal native
 *      representation, and there is a 6-decimal ERC-20 predeploy at 0x3600…0000. If both
 *      read the SAME balance (native == erc20 × 1e12) then an LP deposit needs no wrap and
 *      no stable swap — but it also means LP capital and gas money are one pot, so a gas
 *      reserve becomes mandatory or a position can be opened that cannot be closed.
 *   2. WHICH POOLS EXIST. Arc opened 2026-09-16. v3 vs v4, which fee tiers, and whether any
 *      pool uses the native 0x0 sentinel (Uniswap's own Arc playbook says not to) decides
 *      which mint path the bot should take.
 *
 * Run:  npm run probe:arc
 *       npm run probe:arc -- 0xTokenAddress     (also censuses that token's pools + quotes)
 *
 * Address to check balances for: ARC_ADDR, else derived from RH_WALLET_KEY (read-only —
 * the key is never used to sign anything here).
 */
import { ethers } from "ethers";
import { dataPath, writeJson } from "../util/files.js";

const RPC = process.env.ARC_RPC_URL?.trim() || "https://rpc.mainnet.arc.io";
const EXPECT_CHAIN_ID = 5042n;
const FEE_TIERS = [100, 500, 3000, 10000];

/** Arc mainnet address book. Sources in comments — every one is re-verified below. */
const A = {
  // @circle-fin/bridge-kit 1.15.0 chain registry
  usdc: "0x3600000000000000000000000000000000000000", // ERC-20 interface, 6 decimals
  eurc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
  cctpTokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  // @uniswap/sdk-core 7.19.2 → ARC_ADDRESSES
  v3Factory: "0xf0db7b58379503491d857db50ac9ece64c653918",
  v3Quoter: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
  v3PositionManager: "0x39654a85a4c05127f5fd6ed22caec077a0fb1377",
  swapRouter02: "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77",
  multicall: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  tickLens: "0x9eb8600665b55d10c1eb2316ca5127a9ca6e2e76",
  v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  v4PositionManager: "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b",
  v4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  v2Factory: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
  // @uniswap/universal-router-sdk 5.11.5 (V2_1_1, creationBlock 1950059)
  universalRouter: "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3", // canonical, all chains
};

const ERC20 = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];
const FACTORY = ["function getPool(address,address,uint24) view returns (address)"];
const POOL = [
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const QUOTER_V3 = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
];
const QUOTER_V4 = [
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns (uint256 amountOut,uint256 gasEstimate)",
];

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  critical: boolean;
}
const checks: Check[] = [];
const findings: Record<string, unknown> = {};

function record(name: string, ok: boolean, detail: string, critical = false): boolean {
  checks.push({ name, ok, detail, critical });
  const mark = ok ? "✅" : critical ? "❌" : "⚠️ ";
  console.log(`${mark} ${name.padEnd(34)} ${detail}`);
  return ok;
}

const short = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 110);
const provider = new ethers.JsonRpcProvider(RPC);

/** Bound every probe — a dead RPC must not hang the report. */
function cap<T>(p: Promise<T>, ms: number, fb: T): Promise<T> {
  return Promise.race([p.catch(() => fb), new Promise<T>((r) => setTimeout(() => r(fb), ms))]);
}

async function section(title: string): Promise<void> {
  console.log(`\n\x1b[1m── ${title}\x1b[0m`);
}

// ── 1. chain identity, block cadence, fee shape ────────────────────────────────
async function probeChain(): Promise<void> {
  await section("chain identity");
  try {
    const net = await provider.getNetwork();
    record("chainId", net.chainId === EXPECT_CHAIN_ID, `${net.chainId} (expect ${EXPECT_CHAIN_ID})`, true);
    findings.chainId = Number(net.chainId);
  } catch (e) {
    record("chainId", false, `RPC unreachable: ${short(e)}`, true);
    return;
  }

  const head = await cap(provider.getBlockNumber(), 15_000, 0);
  record("head block", head > 0, String(head), true);
  findings.headBlock = head;

  // block cadence over the last 20 blocks — Arc is documented at ~500ms, which is what the
  // tx-polling interval and the "1 confirmation is final" assumption are tuned against.
  const [b1, b0] = await Promise.all([
    cap(provider.getBlock(head), 15_000, null),
    cap(provider.getBlock(Math.max(1, head - 20)), 15_000, null),
  ]);
  if (b1 && b0 && b1.number > b0.number) {
    const secs = (b1.timestamp - b0.timestamp) / (b1.number - b0.number);
    record("block time", secs > 0 && secs < 5, `${secs.toFixed(2)}s avg over ${b1.number - b0.number} blocks`);
    findings.blockTimeSec = secs;
  } else {
    record("block time", false, "could not sample two blocks");
  }

  const fee = await cap(provider.getFeeData(), 15_000, null);
  if (fee) {
    const gwei = (v: bigint | null) => (v == null ? "—" : `${ethers.formatUnits(v, "gwei")} gwei`);
    record("fee data", fee.gasPrice != null || fee.maxFeePerGas != null, `gasPrice ${gwei(fee.gasPrice)} · maxFee ${gwei(fee.maxFeePerGas)} · prio ${gwei(fee.maxPriorityFeePerGas)}`);
    // Gas is paid in USDC on Arc, so a gas cost is directly a dollar cost.
    const gp = fee.maxFeePerGas ?? fee.gasPrice;
    if (gp) {
      const usd = Number(ethers.formatEther(gp * 250_000n));
      record("cost of a 250k-gas tx", usd < 1, `$${usd.toFixed(4)} (native USDC is 18-dec)`);
      findings.gas250kUsd = usd;
    }
    findings.eip1559 = fee.maxFeePerGas != null;
  } else {
    record("fee data", false, "getFeeData failed");
  }
}

// ── 2. every address in the book actually has code ─────────────────────────────
async function probeCode(): Promise<void> {
  await section("contract deployment (eth_getCode)");
  const deployed: Record<string, boolean> = {};
  for (const [name, addr] of Object.entries(A)) {
    const code = await cap(provider.getCode(addr), 15_000, "0x");
    const bytes = code === "0x" ? 0 : (code.length - 2) / 2;
    // A missing v2 factory is survivable (the bot can run v3+v4); a missing v3/v4 core is not.
    const critical = !["v2Factory", "tickLens", "multicall", "cctpTokenMessenger", "eurc"].includes(name);
    deployed[name] = bytes > 0;
    record(name, bytes > 0, bytes > 0 ? `${bytes} bytes  ${addr}` : `NO CODE  ${addr}`, critical);
  }
  findings.deployed = deployed;
}

// ── 3. THE decisive one: native USDC vs the 6-dec ERC-20 predeploy ─────────────
async function probeUsdc(): Promise<void> {
  await section("USDC: native (18-dec gas) vs ERC-20 predeploy (6-dec)");
  const c = new ethers.Contract(A.usdc, ERC20, provider);
  const [sym, dec] = await Promise.all([
    cap(c.symbol!() as Promise<string>, 12_000, "?"),
    cap(c.decimals!() as Promise<bigint | number>, 12_000, -1),
  ]);
  record("USDC predeploy symbol", sym !== "?", String(sym), true);
  record("USDC predeploy decimals", Number(dec) === 6, `${dec} (expect 6)`, true);

  const eurc = new ethers.Contract(A.eurc, ERC20, provider);
  const edec = await cap(eurc.decimals!() as Promise<bigint | number>, 12_000, -1);
  record("EURC decimals", Number(edec) === 6, String(edec));

  const who = (process.env.ARC_ADDR || "").trim() || keyAddress();
  if (!who) {
    record("native/ERC-20 parity", false, "set ARC_ADDR or RH_WALLET_KEY to test — THIS IS THE CHECK THAT MATTERS", true);
    return;
  }
  console.log(`   address: ${who}`);
  const [nativeWei, erc20Raw] = await Promise.all([
    cap(provider.getBalance(who), 15_000, -1n),
    cap(c.balanceOf!(who) as Promise<bigint>, 15_000, -1n),
  ]);
  if (nativeWei < 0n || erc20Raw < 0n) {
    record("native/ERC-20 parity", false, "balance read failed", true);
    return;
  }
  console.log(`   native  : ${ethers.formatEther(nativeWei)} USDC (18-dec repr, ${nativeWei} wei)`);
  console.log(`   erc-20  : ${ethers.formatUnits(erc20Raw, 6)} USDC (6-dec repr, ${erc20Raw} units)`);
  // The scale factor between the two representations is 1e12.
  const scaled = erc20Raw * 1_000_000_000_000n;
  const same = scaled === nativeWei;
  // Allow a sub-1-unit rounding gap: the 6-dec view truncates the last 12 digits of the native value.
  const truncated = nativeWei - (nativeWei / 1_000_000_000_000n) * 1_000_000_000_000n;
  const sameTruncated = scaled === nativeWei - truncated;
  record(
    "native/ERC-20 parity",
    same || sameTruncated,
    same || sameTruncated
      ? "SAME BALANCE → no wrap step, but LP capital and gas share one pot (gas reserve required)"
      : `DIFFERENT balances → ERC-20 USDC is a separate token; a fund/convert step is needed (diff ${scaled - nativeWei})`,
    true,
  );
  findings.usdc = {
    nativeWei: nativeWei.toString(),
    erc20Raw: erc20Raw.toString(),
    parity: same || sameTruncated,
    nativeUi: Number(ethers.formatEther(nativeWei)),
  };
  if (nativeWei === 0n) console.log("   ⓘ  wallet is empty — parity is only conclusive once it holds USDC.");
}

/** Derive the wallet address from the key WITHOUT connecting a provider (nothing can be signed). */
function keyAddress(): string {
  const k = (process.env.RH_WALLET_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) return "";
  try {
    return new ethers.Wallet(k).address;
  } catch {
    return "";
  }
}

// ── 4. v3 pool census ──────────────────────────────────────────────────────────
async function probeV3(token: string): Promise<void> {
  await section(`v3 pools (quote = USDC ERC-20${token ? `, token = ${token}` : ""})`);
  const f = new ethers.Contract(A.v3Factory, FACTORY, provider);
  const pairs: Array<[string, string, string]> = [["USDC/EURC", A.usdc, A.eurc]];
  if (token) pairs.push(["USDC/TOKEN", A.usdc, token]);

  const found: Array<Record<string, unknown>> = [];
  for (const [label, a, b] of pairs) {
    for (const fee of FEE_TIERS) {
      const pool = await cap(f.getPool!(a, b, fee) as Promise<string>, 12_000, ethers.ZeroAddress);
      if (!pool || pool === ethers.ZeroAddress) continue;
      const pc = new ethers.Contract(pool, POOL, provider);
      const liq = await cap(pc.liquidity!() as Promise<bigint>, 12_000, 0n);
      record(`${label} ${fee / 10000}%`, liq > 0n, `${pool} · liquidity ${liq}`);
      found.push({ label, fee, pool, liquidity: liq.toString() });
    }
  }
  if (!found.length) record("v3 pools", false, "none found for the probed pairs (Arc is days old — not necessarily wrong)");
  findings.v3Pools = found;
}

// ── 5. v4 pool census from PoolManager Initialize logs ─────────────────────────
async function probeV4(): Promise<void> {
  await section("v4 pools (PoolManager Initialize logs)");
  const topic = ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
  const head = Number(findings.headBlock || 0);
  let logs: readonly ethers.Log[] = [];
  try {
    logs = await provider.getLogs({ address: A.v4PoolManager, topics: [topic], fromBlock: 0, toBlock: "latest" });
  } catch {
    // Public RPCs cap the range — walk backwards in chunks instead (same fallback the bot uses).
    const CHUNK = 100_000;
    const out: ethers.Log[] = [];
    for (let hi = head; hi > 0 && out.length < 4000; hi -= CHUNK) {
      const lo = Math.max(0, hi - CHUNK + 1);
      const part = await cap(
        provider.getLogs({ address: A.v4PoolManager, topics: [topic], fromBlock: lo, toBlock: hi }),
        25_000,
        [] as ethers.Log[],
      );
      out.push(...part);
      if (lo === 0) break;
    }
    logs = out;
  }
  record("v4 Initialize logs", logs.length > 0, `${logs.length} pools initialized`);

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const feeHist = new Map<number, number>();
  const usdcL = A.usdc.toLowerCase();
  let usdcPools = 0;
  let nativePools = 0;
  let hooked = 0;
  const sample: Array<Record<string, unknown>> = [];

  for (const lg of logs) {
    try {
      const c0 = ("0x" + lg.topics[2]!.slice(26)).toLowerCase();
      const c1 = ("0x" + lg.topics[3]!.slice(26)).toLowerCase();
      const [fee, tickSpacing, hooks] = coder.decode(["uint24", "int24", "address", "uint160", "int24"], lg.data);
      const feeN = Number(fee);
      feeHist.set(feeN, (feeHist.get(feeN) ?? 0) + 1);
      if (c0 === usdcL || c1 === usdcL) usdcPools++;
      if (c0 === ethers.ZeroAddress.toLowerCase() || c1 === ethers.ZeroAddress.toLowerCase()) nativePools++;
      if (hooks !== ethers.ZeroAddress) hooked++;
      if (sample.length < 5) sample.push({ poolId: lg.topics[1], c0, c1, fee: feeN, tickSpacing: Number(tickSpacing), hooks });
    } catch {
      /* malformed log — skip */
    }
  }

  record("v4 pools quoted in USDC", usdcPools > 0, `${usdcPools} of ${logs.length}`);
  // Uniswap's Arc playbook says to reject the native 0x0 sentinel because of the 18/6 decimal
  // mismatch. If pools DO use it, that assumption needs revisiting before minting against them.
  record("v4 pools using native 0x0", nativePools === 0, nativePools === 0 ? "none (matches Uniswap's Arc guidance)" : `${nativePools} pools use the native sentinel — investigate before minting`);
  record("v4 pools with hooks", true, `${hooked} hooked`);
  if (feeHist.size) {
    const tiers = [...feeHist.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${(f / 10000).toFixed(2)}%×${n}`).join("  ");
    console.log(`   fee tiers: ${tiers}`);
    // The farming strategy targets the 3–5% band; report whether it exists on Arc at all.
    const inBand = [...feeHist.entries()].filter(([f]) => f >= 30000 && f <= 50000).reduce((s, [, n]) => s + n, 0);
    record("pools in the 3–5% farm band", inBand > 0, `${inBand} pools`);
    findings.v4FeeTiers = Object.fromEntries(feeHist);
  }
  findings.v4 = { total: logs.length, usdcPools, nativePools, hooked, sample };
}

// ── 6. quoter sanity (the honeypot test primitive) ─────────────────────────────
async function probeQuoters(): Promise<void> {
  await section("quoters");
  const v3pools = (findings.v3Pools as Array<Record<string, unknown>>) ?? [];
  const live = v3pools.find((p) => p.liquidity !== "0");
  if (live) {
    const q = new ethers.Contract(A.v3Quoter, QUOTER_V3, provider);
    const pc = new ethers.Contract(String(live.pool), POOL, provider);
    const [t0, t1] = await Promise.all([
      cap(pc.token0!() as Promise<string>, 12_000, ""),
      cap(pc.token1!() as Promise<string>, 12_000, ""),
    ]);
    try {
      const r = await q.quoteExactInputSingle!.staticCall([t0, t1, 1_000_000n, Number(live.fee), 0n]);
      record("v3 quoter round-trip", (r[0] as bigint) > 0n, `1 unit in → ${r[0]} out (fee ${live.fee})`);
    } catch (e) {
      record("v3 quoter round-trip", false, short(e));
    }
  } else {
    record("v3 quoter round-trip", false, "skipped — no live v3 pool to quote against");
  }

  const v4 = findings.v4 as { sample?: Array<Record<string, unknown>> } | undefined;
  const s = v4?.sample?.[0];
  if (s) {
    const q = new ethers.Contract(A.v4Quoter, QUOTER_V4, provider);
    try {
      const key = [s.c0, s.c1, s.fee, s.tickSpacing, s.hooks];
      const r = await q.quoteExactInputSingle!.staticCall([key, true, 1_000_000n, "0x"]);
      record("v4 quoter round-trip", (r[0] as bigint) >= 0n, `1 unit in → ${r[0]} out`);
    } catch (e) {
      // A revert here is normal for an empty pool; what matters is that the quoter ANSWERS.
      record("v4 quoter round-trip", false, `${short(e)} (empty pool reverts — check a live pool)`);
    }
  } else {
    record("v4 quoter round-trip", false, "skipped — no v4 pool sampled");
  }
}

// ── 7. off-chain dependencies the bot leans on ─────────────────────────────────
async function probeOffchain(): Promise<void> {
  await section("off-chain data sources");
  const get = async (url: string, ms = 12_000): Promise<any> => {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.json();
  };

  // DexScreener — supplies 24h/1h volume, the input to every farm gate.
  try {
    const j = await get(`https://api.dexscreener.com/latest/dex/tokens/${A.usdc}`);
    const chains = [...new Set((j?.pairs ?? []).map((p: any) => String(p.chainId)))];
    const hasArc = chains.some((c) => String(c).toLowerCase().includes("arc"));
    record("DexScreener indexes Arc", hasArc, hasArc ? `slug present: ${chains.filter((c) => String(c).includes("arc")).join(",")}` : `no arc pairs (chains seen: ${chains.slice(0, 6).join(",") || "none"}) → use on-chain volume`);
    findings.dexscreenerArc = hasArc;
  } catch (e) {
    record("DexScreener indexes Arc", false, short(e));
  }

  // KyberSwap — nice to have. If absent, swaps route through Uniswap instead.
  try {
    const u = `https://aggregator-api.kyberswap.com/arc/api/v1/routes?tokenIn=${A.usdc}&tokenOut=${A.eurc}&amountIn=1000000&gasInclude=true`;
    const j = await get(u, 15_000);
    const ok = j?.code === 0 && !!j?.data?.routeSummary;
    record("KyberSwap routes Arc", ok, ok ? "aggregator live → can be used" : `${j?.message ?? "no route"} → Uniswap-only routing`);
    findings.kyberArc = ok;
  } catch (e) {
    record("KyberSwap routes Arc", false, `${short(e)} → Uniswap-only routing`);
  }

  // Explorer — the bot uses Blockscout REST for lifetime PnL, holdings and ledger backfill.
  for (const [label, url] of [
    ["Blockscout v2 API", "https://explorer.arc.io/api/v2/stats"],
    ["Blockscout v1 API", `https://explorer.arc.io/api?module=account&action=eth_get_balance&address=${A.usdc}`],
  ] as const) {
    try {
      const j = await get(url);
      const ok = !!j && typeof j === "object" && !("error" in j);
      record(label, ok, ok ? "responds → indexer features available" : "unexpected shape → RPC fallback needed");
    } catch (e) {
      record(label, false, `${short(e)} → RPC fallback needed`);
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const token = (process.argv[2] || "").trim();
  console.log(`\n\x1b[1mArc mainnet probe\x1b[0m — ${RPC}\n(read-only: no transaction is ever sent)`);

  await probeChain();
  if (findings.chainId !== 5042) {
    console.log("\n❌ wrong chain — nothing else is meaningful. Fix ARC_RPC_URL first.");
    process.exit(1);
  }
  await probeCode();
  await probeUsdc();
  await probeV3(token ? ethers.getAddress(token) : "");
  await probeV4();
  await probeQuoters();
  await probeOffchain();

  const failedCritical = checks.filter((c) => !c.ok && c.critical);
  const failedSoft = checks.filter((c) => !c.ok && !c.critical);
  console.log(`\n\x1b[1m── verdict\x1b[0m`);
  console.log(`   ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  if (failedSoft.length) console.log(`   ⚠️  degraded (feature falls back): ${failedSoft.map((c) => c.name).join(", ")}`);
  if (failedCritical.length) {
    console.log(`   ❌ BLOCKING: ${failedCritical.map((c) => c.name).join(", ")}`);
    console.log("   → do NOT point the bot at Arc until these pass.");
  } else {
    console.log("   ✅ GO — chain, contracts and USDC semantics check out.");
  }

  const out = dataPath("arc-probe.json");
  writeJson(out, { rpc: RPC, checks, findings });
  console.log(`\n   full report → ${out}\n`);
  process.exit(failedCritical.length ? 1 : 0);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
