/**
 * Wallet-level lifetime PnL: net capital deposited vs. total current value.
 *
 * Capital in/out is derived from EOA/bridge transfers. v1 excluded EVERY contract
 * counterparty as "internal" — which wrongly dropped bridge/CEX funding (the way you
 * actually get ETH onto a fresh chain), inflating NET PnL. Here:
 *   • native transfers: only KNOWN LP-machinery contracts are excluded → bridge deposits
 *     (a contract counterparty) correctly count as capital in.
 *   • WETH transfers: any contract counterparty is excluded (those are pools/router).
 */
import { ethers } from "ethers";
import { C, env } from "../config.js";
import { wallet, provider } from "./client.js";
import { quoteTokenToWeth } from "./swaps.js";
import { ethUsd } from "./price.js";
import { listPositions } from "./positions.js";
import { listV4Positions } from "./v4/list.js";
import { alchemyTokenBalances, alchemyTokenMetadata, alchemyTransfers, type AlchemyTransfer } from "./alchemy.js";
import { bsFetch, mapLimit } from "./blockscout.js";

const INTERNAL = new Set(
  [C.positionManager, C.swapRouter02, C.factory, C.quoter, C.weth].map((a) => a.toLowerCase()),
);

const codeCache = new Map<string, boolean>();
async function isContract(addr: string): Promise<boolean> {
  const a = addr.toLowerCase();
  if (codeCache.has(a)) return codeCache.get(a)!;
  let r = false;
  try {
    r = (await provider.getCode(a)) !== "0x";
  } catch {
    /* assume EOA */
  }
  codeCache.set(a, r);
  return r;
}

export interface LifetimePnl {
  px: number;
  capIn: number;
  capOut: number;
  netCapEth: number;
  nativeEth: number;
  wethHeld: number;
  tokensUsd: number;
  graveyardCount: number;
  graveyard: string[];
  openLpEth: number;
  openLpPnlEth: number;
  valueNowEth: number;
  pnlEth: number;
  pnlUsd: number;
  /** Which source supplied wallet history/holdings. Useful when the explorer index is unavailable. */
  historySource: "blockscout" | "alchemy" | "unavailable";
}

// Cache: /pnl scans thousands of txs on a reused wallet — don't re-run on every tap.
let cache: { v: LifetimePnl; at: number } | null = null;
const CACHE_MS = 120_000;

export async function lifetimePnl(force = false): Promise<LifetimePnl> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.v;
  const w = wallet();
  const W = w.address.toLowerCase();
  const wethL = C.weth.toLowerCase();
  const px = await ethUsd().catch(() => 0);

  let [txl, tt] = await Promise.all([
    bsFetch<{ result?: any[] }>(`/api?module=account&action=txlist&address=${w.address}&startblock=0&endblock=99999999&sort=asc`),
    bsFetch<{ result?: any[] }>(`/api?module=account&action=tokentx&address=${w.address}&contractaddress=${C.weth}&startblock=0&endblock=99999999&sort=asc`),
  ]);

  let historySource: LifetimePnl["historySource"] = txl || tt ? "blockscout" : "unavailable";
  let nativeTransfers: AlchemyTransfer[] | null = null;
  let wethTransfers: AlchemyTransfer[] | null = null;
  if (!txl && !tt) {
    // Blockscout's full-history endpoints are occasionally unavailable or rate-limited. Alchemy's
    // Data API is the same chain's indexed history and keeps /pnl from displaying false zero flows.
    const [incomingNative, outgoingNative, incomingWeth, outgoingWeth] = await Promise.all([
      alchemyTransfers(env.rpcUrl, "external", { toAddress: w.address }),
      alchemyTransfers(env.rpcUrl, "external", { fromAddress: w.address }),
      alchemyTransfers(env.rpcUrl, "erc20", { toAddress: w.address, contractAddresses: [C.weth] }),
      alchemyTransfers(env.rpcUrl, "erc20", { fromAddress: w.address, contractAddresses: [C.weth] }),
    ]);
    if (incomingNative && outgoingNative && incomingWeth && outgoingWeth) {
      nativeTransfers = [...incomingNative, ...outgoingNative];
      wethTransfers = [...incomingWeth, ...outgoingWeth];
      historySource = "alchemy";
    }
  }

  let capIn = 0;
  let capOut = 0;
  const transferEth = (t: any): number => historySource === "alchemy" ? Number(t.value) : Number(t.value) / 1e18;
  // native transfers: bridge/CEX (contract) funding counts as capital
  for (const t of txl?.result ?? nativeTransfers ?? []) {
    if (!t.to || !t.from) continue;
    const v = transferEth(t);
    if (v <= 0) continue;
    const incoming = t.to.toLowerCase() === W;
    const other = (incoming ? t.from : t.to).toLowerCase();
    if (INTERNAL.has(other)) continue;
    if (incoming) capIn += v;
    else capOut += v;
  }
  // WETH transfers: only EOA counterparties (pools/router are LP machinery).
  // Warm the isContract cache for all unique counterparties in PARALLEL first, so the
  // loop below hits cache instead of doing sequential getCode round-trips.
  const wethRows = (tt?.result ?? wethTransfers ?? []).filter((t) => Number(t.value) > 0);
  const uniqOthers = [
    ...new Set(
      wethRows
        .map((t) => (t.to.toLowerCase() === W ? t.from : t.to).toLowerCase())
        .filter((o) => !INTERNAL.has(o)),
    ),
  ];
  await Promise.all(uniqOthers.map((a) => isContract(a)));
  for (const t of wethRows) {
    const v = transferEth(t);
    const incoming = t.to.toLowerCase() === W;
    const other = (incoming ? t.from : t.to).toLowerCase();
    if (INTERNAL.has(other)) continue;
    if (await isContract(other)) continue; // cached now
    if (incoming) capIn += v;
    else capOut += v;
  }
  const netCapEth = capIn - capOut;

  // current value: native + WETH + every token valued via real sell quote + open LP
  let tk = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${w.address}/tokens`);
  if (!tk?.items?.length) {
    const balances = await alchemyTokenBalances(env.rpcUrl, w.address);
    if (balances) {
      const nonzero = balances.filter((b) => b.tokenBalance && !/^0x0+$/.test(b.tokenBalance));
      const metas = await mapLimit(nonzero, 8, async (b) => [b.contractAddress, await alchemyTokenMetadata(env.rpcUrl, b.contractAddress)] as const);
      const metaByAddress = new Map(metas.filter(([, m]) => !!m) as Array<[string, { decimals: number; symbol: string; name: string }]>);
      tk = {
        items: nonzero.map((b) => {
          const m = metaByAddress.get(b.contractAddress);
          return { token: { address_hash: b.contractAddress, decimals: m?.decimals ?? 18, symbol: m?.symbol ?? "?" }, value: BigInt(b.tokenBalance).toString() };
        }),
      };
      if (historySource === "unavailable") historySource = "alchemy";
    }
  }
  let wethHeld = 0;
  let tokensEth = 0;
  let graveyardCount = 0;
  const graveyard: string[] = [];
  // Value held tokens with BOUNDED concurrency. The wallet accumulates dozens of dust tokens from
  // churned positions (50+ here); quoting them ALL at once — each hits 4 fee tiers — fired ~200
  // parallel RPC calls that saturated the RPC AND jammed the event loop, so even the per-quote
  // timeout couldn't fire → /pnl hung ~indefinitely. mapLimit(8) keeps the burst small; the 5s
  // per-quote timeout bounds each rug/honeypot (→ treated as unsellable).
  const valued = await mapLimit(tk?.items ?? [], 8, async (it: any) => {
    const t = it.token;
    const dec = Number(t.decimals || 18);
    const rawValue = String(it.value);
    const bal = Number(rawValue) / 10 ** dec;
    if (t.address_hash?.toLowerCase() === wethL) return { weth: bal, sellEth: 0, sym: "WETH", isWeth: true };
    if (bal <= 0) return null;
    let sellEth = 0;
    try {
      const q = await Promise.race([
        quoteTokenToWeth(t.address_hash, BigInt(rawValue)),
        new Promise<{ weth: number }>((_, rej) => setTimeout(() => rej(new Error("quote timeout")), 5000)),
      ]);
      sellEth = q.weth;
    } catch {
      /* rug / honeypot / timeout → unsellable */
    }
    return { weth: 0, sellEth, sym: t.symbol || "?", isWeth: false };
  });
  const graveSeen = new Set<string>();
  for (const r of valued) {
    if (!r) continue;
    if (r.isWeth) {
      wethHeld = r.weth;
      continue;
    }
    tokensEth += r.sellEth;
    // "stuck" = can't be sold for even $1 (rug / no liquidity / honeypot). Dedupe by symbol
    // so two contracts sharing a ticker (e.g. HASH/HASH) count once.
    if (r.sellEth * (px || 0) < 1 && !graveSeen.has(r.sym)) {
      graveSeen.add(r.sym);
      graveyardCount++;
      if (graveyard.length < 12) graveyard.push(r.sym);
    }
  }
  const tokensUsd = tokensEth * px;
  const nativeEth = Number(ethers.formatEther(await provider.getBalance(w.address)));

  let openLpEth = 0;
  let openLpPnlEth = 0;
  // v3 valEth already includes unclaimed fees. v4 valueUsd also includes fees, so do not add them
  // twice. Fetch the two position families independently so one flaky indexer cannot erase both.
  const [v3Rows, v4Rows] = await Promise.all([
    listPositions().catch(() => [] as Awaited<ReturnType<typeof listPositions>>),
    listV4Positions(0).catch(() => [] as Awaited<ReturnType<typeof listV4Positions>>),
  ]);
  openLpEth = v3Rows.reduce((sum, r) => sum + (r.valEth || 0), 0);
  openLpPnlEth += v3Rows.reduce((sum, r) => sum + (r.pnlEth || 0), 0);
  if (px > 0) openLpEth += v4Rows.reduce((sum, r) => sum + ((r.valueUsd || 0) / px), 0);
  if (px > 0) openLpPnlEth += v4Rows.reduce((sum, r) => sum + (r.depEth != null ? (r.valueUsd || 0) / px - r.depEth : 0), 0);
  const valueNowEth = nativeEth + wethHeld + tokensEth + openLpEth;
  const pnlEth = valueNowEth - netCapEth;

  const result: LifetimePnl = {
    px,
    capIn,
    capOut,
    netCapEth,
    nativeEth,
    wethHeld,
    tokensUsd,
    graveyardCount,
    graveyard,
    openLpEth,
    openLpPnlEth,
    valueNowEth,
    pnlEth,
    pnlUsd: pnlEth * px,
    historySource,
  };
  cache = { v: result, at: Date.now() };
  return result;
}
