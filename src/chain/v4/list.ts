/**
 * List the wallet's v4 LP positions — ANY pair (token/native, token/stable, token/token), not
 * just native-paired. The v4 PositionManager isn't enumerable, so tokenIds come from chain/
 * indexer.ts's NFT-holdings lookup (catches manual Uniswap positions too) — the explorer's
 * enum where the chain has one, an ownerOf-verified Transfer-log scan where it doesn't. Amounts are built from the REAL pool
 * currencies (earlier bug: forced native ETH → garbage $100M values). Unclaimed fees are
 * computed from feeGrowthInside deltas. Value is estimated in USD.
 *
 * On a chain that forbids the 0x0 native sentinel (Arc) every row is a two-ERC-20 pool, and
 * isNativeCurrency() is false everywhere — so the Ether.onChain() / 18-decimal branches below
 * are simply never taken there, which is the whole point: a 0x0 currency read as 18-dec native
 * when the real asset is the 6-dec ERC-20 would be off by 1e12.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { nativeUsd, natSym, natDecimals, chainId, fmtNat, isWrappedNative, isStableQuote } from "../currency.js";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { isNativeCurrency } from "./poolkey.js";
import { mapLimit } from "../blockscout.js";
import { nftTokenIds, nftMintTimestamp } from "../indexer.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const { Ether, Token, CurrencyAmount } = sdkCore as any;
const { Pool, Position } = v4sdk as any;
const log = logger("v4list");

const MASK256 = (1n << 256n) - 1n;
/** Native-side meta for a pool currency slot holding the 0x0 sentinel. */
const nativeMeta = () => ({ symbol: natSym(), decimals: natDecimals() });
/** "This side is a quote asset, not the volatile token." */
const isQuoteSide = (a: string): boolean => isNativeCurrency(a) || isWrappedNative(a) || isStableQuote(a);

export interface V4Row {
  tokenId: string;
  pair: string; // "WOLVES/USDG"
  sym: string; // primary (non-quote) symbol for the emoji/label
  fee: number;
  inRange: boolean;
  tick: number;
  tickLower: number;
  tickUpper: number;
  amount0: string;
  sym0: string;
  amount1: string;
  sym1: string;
  feeUsd: number;
  valueUsd: number;
  depEth: number | null;
  ethPaired: boolean; // true if one side is the native currency (bot-manageable close)
  ageMs: number | null;
  tokenAddr: string; // the volatile (non-quote) side — for OOR-cooldown keying
  poolId: string; // v4 poolId — to match DexScreener volume for the #3 volume-fade check
  nat?: string; // native currency symbol depEth is denominated in ("ETH" | "USDC")
  chainId?: number; // chain this row came from
}

const signed24 = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);

/** Retry a flaky read a couple times before giving up (transient RPC errors dropped rows). */
async function retry<T>(fn: () => Promise<T>, n = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw last;
}

export interface V4ClosedRow {
  tokenId: string;
  pair: string;
  fee: number;
  depEth: number | null; // basis only if bot-minted
  closedAt: number | null; // latest NFT transfer ts (for recent-first sort)
}

/** v4 NFTs the wallet still holds but with 0 liquidity = closed positions (for /ledger). */
export async function listClosedV4Positions(): Promise<V4ClosedRow[]> {
  if (!C.v4PositionManager) return [];
  const w = wallet();
  const deps = readJson<Record<string, { depositWei?: string }>>(dataPath("v4-positions.json"), {});
  // null ("couldn't enumerate") and [] ("holds none") both mean "nothing to list" HERE, because
  // this is a read-only ledger view — unlike listV4Positions below, where the difference matters.
  const ids = (await nftTokenIds(C.v4PositionManager, w.address).catch(() => null)) ?? [];
  if (!ids.length) return [];
  const posm = new ethers.Contract(C.v4PositionManager, V4_POSM_ABI, provider);
  const rows = await mapLimit(ids, 8, async (tokenId): Promise<V4ClosedRow | null> => {
    try {
      const liq: bigint = await posm.getPositionLiquidity!(tokenId).catch(() => 0n);
      if (liq > 0n) return null; // still open → shown in /list, not ledger
      const [pk] = await posm.getPoolAndPositionInfo!(tokenId);
      const [m0, m1] = await Promise.all([
        isNativeCurrency(pk.currency0) ? Promise.resolve({ symbol: natSym() }) : tokenMeta(pk.currency0).catch(() => ({ symbol: "?" })),
        isNativeCurrency(pk.currency1) ? Promise.resolve({ symbol: natSym() }) : tokenMeta(pk.currency1).catch(() => ({ symbol: "?" })),
      ]);
      const dep = deps[tokenId];
      // closedAt: use the bot's local deposit ts if we have it, else null. We DROPPED the per-NFT
      // Blockscout `transfers` lookup — that was 1 rate-limited round-trip PER closed NFT (35+),
      // which froze /ledger. Sorting falls back to tokenId order (higher = newer), good enough.
      const depTs = (deps[tokenId] as { ts?: number } | undefined)?.ts ?? null;
      return {
        tokenId,
        pair: `${m0.symbol}/${m1.symbol}`,
        fee: Number(pk.fee),
        depEth: dep?.depositWei ? Number(fmtNat(dep.depositWei)) : null,
        closedAt: depTs,
      };
    } catch {
      return null;
    }
  });
  return rows.filter((r): r is V4ClosedRow => r !== null);
}

/**
 * Original mint timestamp of a v4 position NFT (for positions added manually on the web UI,
 * where we have no local deposit record → age showed "?"). Read from Blockscout's NFT
 * instance transfers (the Transfer from 0x0), cached back into v4-positions.json.
 */
const v4MintTsCache = new Map<string, number | null>();
export async function v4MintTs(tokenId: string): Promise<number | null> {
  const key = String(tokenId);
  if (v4MintTsCache.has(key)) return v4MintTsCache.get(key)!;
  const deps = readJson<Record<string, { mintTs?: number }>>(dataPath("v4-positions.json"), {});
  if (deps[key]?.mintTs) {
    v4MintTsCache.set(key, deps[key]!.mintTs!);
    return deps[key]!.mintTs!;
  }
  const ts = await nftMintTimestamp(C.v4PositionManager!, key).catch(() => null);
  v4MintTsCache.set(key, ts);
  if (ts) {
    const d = readJson<Record<string, any>>(dataPath("v4-positions.json"), {});
    d[key] = { ...(d[key] ?? {}), mintTs: ts };
    writeJson(dataPath("v4-positions.json"), d);
  }
  return ts;
}

function sdkCurrency(addr: string, dec: number, sym: string): any {
  return isNativeCurrency(addr) ? Ether.onChain(cfg.chainId) : new Token(cfg.chainId, ethers.getAddress(addr), dec, sym);
}

/**
 * USD per 1 unit of a currency, or null if unknown (then value via the pool's other side).
 * `px` is the USD price of ONE NATIVE unit (nativeUsd()), so on a stable-native chain the native
 * and stable branches agree at 1 instead of fighting over a stale ether quote.
 */
function usdOfCurrency(addr: string, sym: string, px: number): number | null {
  if (isNativeCurrency(addr) || isWrappedNative(addr)) return px;
  if (isStableQuote(addr) || /^usd|usd$/i.test(sym)) return 1;
  return null;
}

// Last computed position snapshot. /list serves this instantly (staleOkMs) instead of racing the RPC
// against the hunt scanner — the manage loop + autolp + hunt already refresh it every 90s-3m, so it's
// always warm. Callers that need FRESH state (manage TP/SL/OOR, autolp gate) pass staleOkMs=0 (default).
let posCache: { rows: V4Row[]; at: number } | null = null;

export async function listV4Positions(staleOkMs = 0): Promise<V4Row[]> {
  if (!C.v4PositionManager || !C.v4StateView) return [];
  if (staleOkMs > 0 && posCache && Date.now() - posCache.at < staleOkMs) return posCache.rows;
  const w = wallet();
  const deps = readJson<Record<string, { depositWei?: string; ts?: number; mintTs?: number }>>(dataPath("v4-positions.json"), {});
  // null vs [] is load-bearing here and is exactly why this goes through the indexer: positions
  // opened OUTSIDE the bot (web UI) live ONLY in this enum, so a FAILED enum read as "holds none"
  // makes them vanish from /list. Bot-opened ones still show via the local deps union below.
  const owned = await nftTokenIds(C.v4PositionManager, w.address).catch(() => null);
  let ids: string[] = owned ?? [];
  if (owned === null) {
    log.warn("/list: NFT enumeration failed (rate-limit / no indexer?) — relying on local deps (web-UI positions may be temporarily skipped)");
  }
  ids = [...new Set([...ids, ...Object.keys(deps)])];
  // Drop tokenIds the ledger already knows are CLOSED — deps accumulates every historical mint
  // (incl. burned positions), so without this /list pays 2 RPC reads per dead position, every time.
  try {
    const { readLedger } = await import("../ledger.js");
    const closed = new Set(readLedger().filter((e) => e.version === "v4").map((e) => e.tokenId));
    if (closed.size) ids = ids.filter((id) => !closed.has(id));
  } catch {
    /* ledger optional — just skip the prune */
  }
  if (!ids.length) return [];

  const posm = new ethers.Contract(C.v4PositionManager, V4_POSM_ABI, provider);
  const sv = new ethers.Contract(C.v4StateView, STATEVIEW_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const px = await nativeUsd().catch(() => 0);

  // Pre-filter via Multicall3: read getPositionLiquidity for ALL ids in ONE eth_call and drop the
  // CLOSED (0-liq) NFTs the wallet accumulates (30+). Otherwise /list pays 2 reads PER dead NFT — that
  // is what made "Loading positions" crawl. Only the surviving OPEN ids get the full per-position read below.
  let openIds = ids;
  try {
    // Multicall3 address resolved in config.ts (profile, else canonical CREATE2).
    const mc = new ethers.Contract(C.multicall, ["function aggregate3((address,bool,bytes)[]) view returns ((bool,bytes)[])"], provider);
    const calls = ids.map((id) => ({ target: C.v4PositionManager, allowFailure: true, callData: posm.interface.encodeFunctionData("getPositionLiquidity", [id]) }));
    const res: Array<{ success: boolean; returnData: string }> = await mc.aggregate3!(calls);
    openIds = ids.filter((id, i) => {
      const r = res[i];
      if (!r?.success) return true; // couldn't read → keep, let the full read decide
      try {
        const liq = BigInt(posm.interface.decodeFunctionResult("getPositionLiquidity", r.returnData)[0]);
        const fresh = !!deps[id]?.ts && Date.now() - deps[id]!.ts! < 15 * 60_000;
        return liq > 0n || fresh; // keep open, or freshly-opened (liq may lag the mint block)
      } catch {
        return true;
      }
    });
  } catch {
    /* multicall unavailable → fall through with all ids (the per-position read still filters 0-liq) */
  }
  if (!openIds.length) return [];

  const rows = await mapLimit(openIds, 10, async (tokenId): Promise<V4Row | null> => {
    try {
      const [owner, liq0] = await Promise.all([
        retry(() => posm.ownerOf!(tokenId) as Promise<string>).catch(() => ethers.ZeroAddress),
        retry(() => posm.getPositionLiquidity!(tokenId) as Promise<bigint>).catch(() => 0n),
      ]);
      let liquidity = liq0;
      // A just-opened position can momentarily read liquidity 0 if the RPC node lags the mint block —
      // for RECENTLY-opened (local deposit ts < 15m) positions, re-read a few times before dropping so a
      // fresh manual open reliably appears in /list instead of intermittently vanishing.
      const freshTs = deps[tokenId]?.ts;
      const isFresh = !!freshTs && Date.now() - freshTs < 15 * 60_000;
      if (liquidity === 0n && isFresh) {
        for (let i = 0; i < 3 && liquidity === 0n; i++) {
          await new Promise((r) => setTimeout(r, 600));
          liquidity = await (posm.getPositionLiquidity!(tokenId) as Promise<bigint>).catch(() => 0n);
        }
      }
      if (owner.toLowerCase() !== w.address.toLowerCase() || liquidity === 0n) {
        if (isFresh) log.info(`/list: skip fresh #${tokenId} (liq ${liquidity} owner ${owner.slice(0, 10)}) — just opened but empty/lagging`);
        return null;
      }

      const [pk, infoRaw] = await retry(() => posm.getPoolAndPositionInfo!(tokenId));
      const info = BigInt(infoRaw);
      const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
      const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));
      const fee = Number(pk.fee);
      const tickSpacing = Number(pk.tickSpacing);
      const c0 = pk.currency0 as string;
      const c1 = pk.currency1 as string;

      const [m0, m1] = await Promise.all([
        isNativeCurrency(c0) ? Promise.resolve(nativeMeta()) : tokenMeta(c0).catch(() => ({ symbol: "?", decimals: 18 })),
        isNativeCurrency(c1) ? Promise.resolve(nativeMeta()) : tokenMeta(c1).catch(() => ({ symbol: "?", decimals: 18 })),
      ]);

      const poolId = ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [c0, c1, fee, tickSpacing, pk.hooks]));
      const positionId = ethers.solidityPackedKeccak256(
        ["address", "int24", "int24", "bytes32"],
        [C.v4PositionManager, tickLower, tickUpper, ethers.toBeHex(BigInt(tokenId), 32)],
      );
      const [s0, fgInside, posInfo] = await Promise.all([
        retry(() => sv.getSlot0!(poolId)),
        sv.getFeeGrowthInside!(poolId, tickLower, tickUpper).catch(() => [0n, 0n]),
        sv.getPositionInfo!(poolId, positionId).catch(() => [0n, 0n, 0n]),
      ]);
      const tick = Number(s0.tick);

      const cur0 = sdkCurrency(c0, m0.decimals, m0.symbol);
      const cur1 = sdkCurrency(c1, m1.decimals, m1.symbol);
      const pool = new Pool(cur0, cur1, fee, tickSpacing, pk.hooks, s0.sqrtPriceX96.toString(), "0", tick);
      const pos = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });

      // unclaimed fees from feeGrowthInside delta (uint256 wrap-safe) × liquidity >> 128
      const fee0raw = (((BigInt(fgInside[0]) - BigInt(posInfo[1])) & MASK256) * liquidity) >> 128n;
      const fee1raw = (((BigInt(fgInside[1]) - BigInt(posInfo[2])) & MASK256) * liquidity) >> 128n;
      const fee0 = CurrencyAmount.fromRawAmount(cur0, fee0raw.toString());
      const fee1 = CurrencyAmount.fromRawAmount(cur1, fee1raw.toString());

      const u0 = usdOfCurrency(c0, m0.symbol, px);
      const u1 = usdOfCurrency(c1, m1.symbol, px);
      const sideUsd = (amt: any, thisUsd: number | null, otherUsd: number | null): number => {
        try {
          let v = 0;
          if (thisUsd != null) v = Number(amt.toExact()) * thisUsd;
          else if (otherUsd != null) v = Number(pool.priceOf(amt.currency).quote(amt).toExact()) * otherUsd;
          // SANITY: pool.priceOf on a thin / extreme-tick pool can explode to 1e50+, poisoning valueUsd
          // (→ automanage pnlPct → a spurious SL close) + feeUsd (→ compound) + the close ledger (pre).
          // No single farming-position leg is near $1M, so treat a blown-up value as unvaluable (0).
          return Number.isFinite(v) && Math.abs(v) < 1e6 ? v : 0;
        } catch {
          /* price edge */
        }
        return 0;
      };
      const total0 = pos.amount0.add(fee0);
      const total1 = pos.amount1.add(fee1);
      const valueUsd = sideUsd(total0, u0, u1) + sideUsd(total1, u1, u0);
      const feeUsd = sideUsd(fee0, u0, u1) + sideUsd(fee1, u1, u0);

      const ethPaired = isNativeCurrency(c0) || isNativeCurrency(c1);
      const tokenAddr = isQuoteSide(c0) ? c1 : c0; // volatile side (non-quote)
      const dep = deps[tokenId];
      // age: bot deposit ts, else the position's on-chain mint time (manual web adds)
      const openedAt = dep?.ts ?? dep?.mintTs ?? (await v4MintTs(tokenId).catch(() => null));
      // primary token = the non-stable / non-eth side (for the emoji/label)
      const primary = u0 != null && u1 == null ? m1.symbol : u1 != null && u0 == null ? m0.symbol : m0.symbol;

      // PnL basis = LP-vs-HODL (SAME as closeV4Position's ledger): value the DEPOSITED amounts
      // (dep0/dep1) at the CURRENT price. The old basis (gross ETH budget = depositWei) wrongly
      // counted the entry swap-fee + the leftover swept BACK to the wallet as "loss", so /list showed
      // a phantom minus that disagreed with the realized close PnL. Now they match.
      let basisEth = dep?.depositWei ? Number(fmtNat(dep.depositWei)) : null;
      const depAmts = dep as { dep0?: string; dep1?: string } | undefined;
      if (depAmts?.dep0 && depAmts?.dep1 && px > 0) {
        try {
          const hodlUsd = sideUsd(CurrencyAmount.fromRawAmount(cur0, depAmts.dep0), u0, u1) + sideUsd(CurrencyAmount.fromRawAmount(cur1, depAmts.dep1), u1, u0);
          if (hodlUsd > 0) basisEth = hodlUsd / px;
        } catch {
          /* keep gross-budget basis on a valuation edge */
        }
      }

      return {
        tokenId,
        pair: `${m0.symbol}/${m1.symbol}`,
        sym: primary,
        fee,
        inRange: tick >= tickLower && tick < tickUpper,
        tick,
        tickLower,
        tickUpper,
        amount0: pos.amount0.toSignificant(6),
        sym0: m0.symbol,
        amount1: pos.amount1.toSignificant(6),
        sym1: m1.symbol,
        feeUsd,
        valueUsd,
        depEth: basisEth,
        ethPaired,
        ageMs: openedAt ? Date.now() - openedAt : null,
        tokenAddr: ethers.getAddress(tokenAddr),
        poolId,
        nat: natSym(),
        chainId: chainId(),
      };
    } catch (e) {
      log.warn(`skip v4 #${tokenId}: ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  });
  const out = rows.filter((r): r is V4Row => r !== null);
  posCache = { rows: out, at: Date.now() };
  return out;
}
