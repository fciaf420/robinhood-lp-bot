/**
 * Indexer = the ONE place that knows how to read HISTORY on this chain.
 *
 * The bot needs four things that a plain `eth_call` cannot answer: lifetime capital flow
 * (PnL), which tokens a wallet holds, the logs behind an old transaction (ledger backfill)
 * and when a position NFT was minted. On Robinhood all four come from Blockscout's REST API.
 * Arc's explorer answers JSON-RPC (`/api/eth-rpc`), not Blockscout REST — and until the probe
 * says otherwise the conservative profile assumes exactly that.
 *
 * So each capability has TWO backends, picked by `profile.explorer.kind`:
 *   "blockscout" → today's REST client, byte-for-byte the calls the live bot already makes.
 *   "rpc"        → bounded, chunked `getLogs` against the RPC. Slower and window-limited, but
 *                  it needs nothing but a node.
 *
 * THE NULL CONTRACT — read this before using anything here:
 *   `null`  = "this chain cannot tell me" (no backend, or the backend failed).
 *   `[]`    = "I asked and the answer is genuinely empty."
 * They are NOT interchangeable. A throttled REST call that reads as `[]` is how a wallet full
 * of tokens becomes "no holdings" and a funded wallet becomes "capital in = 0" — a fabricated
 * number in a PnL panel, or worse, a backfill that invents a zero-basis ledger entry. Callers
 * must branch on null and say "unknown", never compute on it. Nothing here throws into a money
 * path: every function resolves, and a missing capability degrades ONE feature with one log line.
 */
import { ethers } from "ethers";
import { CHAIN, quoteAssets } from "./profile.js";
import { provider, logsProvider } from "./client.js";
import { bsFetch, mapLimit } from "./blockscout.js";
import { ERC20_ABI } from "./abis.js";
import { tokenMeta } from "./tokens.js";
import { logger } from "../util/log.js";

const log = logger("indexer");

export type IndexerKind = "blockscout" | "rpc";

/** What a caller asks for before it commits to a feature. */
export type IndexerFeature =
  | "txHistory" // full native tx list — capital in/out, the ledger-backfill driver
  | "tokenTransfers" // ERC-20 transfer history for one address
  | "addressTokens" // "which ERC-20s does this wallet hold"
  | "txLogs" // the logs of one (old) transaction
  | "nftTokenIds" // ERC-721 ids owned by an address
  | "nftMintTimestamp" // when a position NFT was minted
  | "tokenCatalog"; // chain-wide ERC-20 list (scanner / feed seed)

const KIND: IndexerKind = CHAIN.explorer.kind;

/**
 * Capability matrix.
 *
 * `txHistory` is the one thing the RPC backend genuinely cannot do: a native value transfer
 * emits NO LOG, so there is nothing to `getLogs` for. Everything else has a log-shaped
 * equivalent — which is why the wallet/PnL paths must degrade per-capability instead of
 * treating "no Blockscout" as "no history at all".
 */
const CAPS: Record<IndexerFeature, Record<IndexerKind, boolean>> = {
  txHistory: { blockscout: true, rpc: false },
  tokenTransfers: { blockscout: true, rpc: true },
  addressTokens: { blockscout: true, rpc: true },
  txLogs: { blockscout: true, rpc: true },
  nftTokenIds: { blockscout: true, rpc: true },
  nftMintTimestamp: { blockscout: true, rpc: true },
  tokenCatalog: { blockscout: true, rpc: true },
};

export function indexerKind(): IndexerKind {
  return KIND;
}

export function indexerHas(f: IndexerFeature): boolean {
  return CAPS[f][KIND];
}

/**
 * History on the RPC backend is a WINDOW, not a lifetime (see HISTORY_HOURS). Anything that
 * prints a "lifetime" number has to say so instead of quietly reporting a slice as a total.
 */
export function historyIsBounded(): boolean {
  return KIND === "rpc";
}

const noted = new Set<string>();
/** One line per (feature, reason), ever. A degraded feature should be visible, not noisy. */
export function indexerNote(f: IndexerFeature, why: string): void {
  const k = `${f}:${why}`;
  if (noted.has(k)) return;
  noted.add(k);
  log.warn(`feature "${f}" running with limitations on chain ${CHAIN.key} (indexer ${KIND}): ${why}`);
}

export function indexerSummary(): string {
  const off = (Object.keys(CAPS) as IndexerFeature[]).filter((f) => !indexerHas(f));
  return `${KIND}${off.length ? ` · off: ${off.join(",")}` : ""}${historyIsBounded() ? ` · window ${HISTORY_HOURS}h` : ""}`;
}

// ══════════════════════════ row shapes (backend-independent) ══════════════════════════

export interface IndexedTx {
  hash: string;
  from: string; // lowercased
  to: string | null; // lowercased; null = contract creation
  value: bigint; // native wei
  input: string;
  blockNumber: number;
  timeMs: number; // epoch ms (0 when the backend didn't supply one)
  failed: boolean;
}

export interface IndexedTransfer {
  hash: string;
  token: string; // lowercased ERC-20 address
  from: string; // lowercased
  to: string; // lowercased
  value: bigint; // RAW units, at the token's own decimals — never normalised here
  blockNumber: number;
  timeMs: number; // 0 when unknown (the rpc backend only resolves timestamps on request)
}

export interface IndexedTokenBalance {
  address: string; // checksummed
  symbol: string;
  decimals: number;
  raw: bigint;
}

export interface IndexedLog {
  address: string; // lowercased emitter
  topics: string[];
  data: string;
  blockNumber: number;
  txHash: string;
}

export interface IndexedToken {
  address: string; // checksummed
  symbol: string;
}

// ══════════════════════════ block ↔ time ══════════════════════════

/**
 * Blocks that span `ms`, from the profile's real cadence. Sub-second blocks make this number
 * big (24h ≈ 172 800 blocks at 500ms), which is exactly why every scan below is chunked and
 * budgeted rather than issued as one open-ended getLogs.
 */
export function blocksForMs(ms: number): number {
  return Math.max(1, Math.ceil(ms / CHAIN.blockTimeMs));
}

export function msForBlocks(blocks: number): number {
  return blocks * CHAIN.blockTimeMs;
}

/** How far back the rpc backend looks for "history". Tune with RH_INDEX_HOURS. */
const HISTORY_HOURS = Math.max(1, Number(process.env.RH_INDEX_HOURS) || 24 * 7);

export function historyWindowBlocks(): number {
  return blocksForMs(HISTORY_HOURS * 3_600_000);
}

// getBlockNumber() is cheap but this is called in loops; a 2s cache collapses a burst into one read.
let headCache = { n: 0, at: 0 };
export async function headBlock(): Promise<number> {
  const now = Date.now();
  if (headCache.n && now - headCache.at < 2000) return headCache.n;
  const n = await provider.getBlockNumber();
  headCache = { n, at: now };
  return n;
}

const tsCache = new Map<number, number>();
/** Epoch-ms timestamp of a block, or null. Cached forever — a mined block's timestamp is final. */
export async function blockTimestampMs(block: number): Promise<number | null> {
  const hit = tsCache.get(block);
  if (hit !== undefined) return hit;
  try {
    const b = await provider.getBlock(block);
    if (!b) return null;
    const ms = Number(b.timestamp) * 1000;
    tsCache.set(block, ms);
    return ms;
  } catch {
    return null;
  }
}

/** Fill `timeMs` on rows that have none, batching the block reads (bounded, deduped). */
async function withTimestamps<T extends { blockNumber: number; timeMs: number }>(rows: T[]): Promise<T[]> {
  const need = [...new Set(rows.filter((r) => !r.timeMs).map((r) => r.blockNumber))];
  if (!need.length) return rows;
  await mapLimit(need, 8, (b) => blockTimestampMs(b));
  for (const r of rows) if (!r.timeMs) r.timeMs = tsCache.get(r.blockNumber) ?? 0;
  return rows;
}

// ══════════════════════════ chunked getLogs (the rpc backend's only primitive) ══════════════════════════

export interface LogFilter {
  address?: string | string[];
  topics?: Array<string | string[] | null>;
}

export interface LogScan {
  logs: ethers.Log[];
  /** Lowest block actually covered. > `requested from` means the scan was cut short. */
  from: number;
  to: number;
  /** true = the window is INCOMPLETE. Treat the numbers derived from it as "unknown", not "small". */
  partial: boolean;
  calls: number;
}

const DEFAULT_CHUNK = Math.max(100, Number(process.env.RH_LOGS_CHUNK) || 10_000);
const MIN_CHUNK = 500;

/**
 * getLogs over [from, to], NEWEST WINDOW FIRST, with three independent bounds: a per-call block
 * span, a call count and a wall-clock budget.
 *
 * Descending on purpose: when a bound trips, what survives is the RECENT end of the range — the
 * half that every caller here actually cares about (the last hour of volume, the newest holdings).
 * The caller is told via `partial`; a partial scan is "I don't know", never "the answer is small".
 *
 * The chunk shrinks (÷4, floor MIN_CHUNK) when a node rejects a span — public RPCs cap block range
 * or result count and the cap is not discoverable, so adapt instead of guessing once and failing.
 */
export async function getLogsChunked(filter: LogFilter, from: number, to: number, opts: {
  chunk?: number;
  maxCalls?: number;
  budgetMs?: number;
} = {}): Promise<LogScan> {
  const maxCalls = opts.maxCalls ?? 240;
  const deadline = Date.now() + (opts.budgetMs ?? 30_000);
  // The dedicated logs RPC first (see client.ts): these scans are the burstiest reads the bot
  // makes and must not slow the provider a close depends on.
  const provs = logsProvider === provider ? [provider] : [logsProvider, provider];
  let chunk = Math.max(MIN_CHUNK, opts.chunk ?? DEFAULT_CHUNK);
  const out: ethers.Log[] = [];
  let hi = to;
  let lowest = to + 1;
  let calls = 0;
  let partial = false;

  while (hi >= from) {
    if (calls >= maxCalls || Date.now() > deadline) {
      partial = true;
      break;
    }
    const lo = Math.max(from, hi - chunk + 1);
    let got: readonly ethers.Log[] | null = null;
    for (const p of provs) {
      calls++;
      try {
        got = await p.getLogs({ address: filter.address, topics: filter.topics, fromBlock: lo, toBlock: hi });
        break;
      } catch {
        /* next provider, then shrink */
      }
    }
    if (got === null) {
      if (chunk > MIN_CHUNK) {
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 4));
        continue; // retry the SAME window, smaller
      }
      partial = true; // even the floor span failed → stop, keep what we have
      break;
    }
    out.push(...got);
    lowest = lo;
    hi = lo - 1;
  }
  return { logs: out, from: Math.min(lowest, to + 1), to, partial, calls };
}

// ══════════════════════════ topic helpers ══════════════════════════

/** ERC-20 AND ERC-721 share this signature; they differ by topic COUNT (3 vs 4). */
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ZERO_TOPIC = ethers.zeroPadValue("0x0000000000000000000000000000000000000000", 32);

const topicAddr = (a: string): string => ethers.zeroPadValue(ethers.getAddress(a), 32);
const addrFromTopic = (t: string): string => ethers.dataSlice(t, 12).toLowerCase();
const lower = (a: unknown): string => String(a ?? "").toLowerCase();

// ══════════════════════════ txHistory ══════════════════════════

/**
 * Every native transaction of an address, oldest first.
 *
 * `null` on the rpc backend and that is not a gap to paper over: a native transfer emits NO
 * EVENT, so there is no log to scan for and no honest way to reconstruct capital flow from a
 * node. The features built on it (lifetime capital in/out, v3 ledger backfill) must say
 * "unknown on this chain" — a zero there reads as "you deposited nothing", i.e. pure profit.
 */
export async function txHistory(address: string): Promise<IndexedTx[] | null> {
  if (!indexerHas("txHistory")) {
    indexerNote("txHistory", "native transfers do not leave logs — requires explorer/indexer, RPC alone is not enough");
    return null;
  }
  const r = await bsFetch<{ result?: any[] }>(
    `/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=asc`,
  );
  if (!r || !Array.isArray(r.result)) return null;
  return r.result.map((t): IndexedTx => ({
    hash: String(t.hash ?? ""),
    from: lower(t.from),
    to: t.to ? lower(t.to) : null,
    value: BigInt(t.value ?? 0),
    input: String(t.input ?? "0x"),
    blockNumber: Number(t.blockNumber ?? 0),
    timeMs: Number(t.timeStamp ?? 0) * 1000,
    failed: String(t.isError ?? "0") === "1",
  }));
}

// ══════════════════════════ tokenTransfers ══════════════════════════

/**
 * ERC-20 transfers touching `address` (in OR out). `contract` narrows it to one token, which is
 * what the capital-flow scan wants and what keeps the rpc scan cheap.
 *
 * rpc backend: two topic-filtered scans (from=addr, to=addr) over the history window. Bounded, so
 * the result is a WINDOW — historyIsBounded() tells the caller to label it as such.
 */
export async function tokenTransfers(address: string, contract?: string): Promise<IndexedTransfer[] | null> {
  if (KIND === "blockscout") {
    const q = contract ? `&contractaddress=${contract}` : "";
    const r = await bsFetch<{ result?: any[] }>(
      `/api?module=account&action=tokentx&address=${address}${q}&startblock=0&endblock=99999999&sort=asc`,
    );
    if (!r || !Array.isArray(r.result)) return null;
    return r.result.map((t): IndexedTransfer => ({
      hash: String(t.hash ?? ""),
      // Field name varies across Blockscout/Etherscan-compatible builds; an empty token here is
      // not fatal because the QUERY already narrowed by contract — callers filter leniently.
      token: lower(t.contractAddress ?? t.tokenAddress ?? t.token?.address),
      from: lower(t.from),
      to: lower(t.to),
      value: BigInt(t.value ?? 0),
      blockNumber: Number(t.blockNumber ?? 0),
      timeMs: Number(t.timeStamp ?? 0) * 1000,
    }));
  }

  const head = await headBlock().catch(() => 0);
  if (!head) return null;
  const from = Math.max(0, head - historyWindowBlocks());
  const me = topicAddr(address);
  const base: LogFilter = contract ? { address: contract } : {};
  const [out, inc] = await Promise.all([
    getLogsChunked({ ...base, topics: [TRANSFER_TOPIC, me, null] }, from, head, { budgetMs: 25_000 }),
    getLogsChunked({ ...base, topics: [TRANSFER_TOPIC, null, me] }, from, head, { budgetMs: 25_000 }),
  ]);
  // A truncated window is "unknown", not "few transfers" — see the null contract. Strict on
  // purpose: this feeds capital-flow accounting, where a missing deposit reads as pure profit.
  if (out.partial || inc.partial) {
    indexerNote("tokenTransfers", `window ${HISTORY_HOURS}h truncated (RPC rejected range?) — transfer history treated as unreadable`);
    return null;
  }
  const rows: IndexedTransfer[] = [];
  const seen = new Set<string>();
  for (const l of [...out.logs, ...inc.logs]) {
    if (l.topics.length !== 3) continue; // 4 topics = ERC-721, a different asset entirely
    const k = `${l.transactionHash}:${l.index}`;
    if (seen.has(k)) continue; // a self-transfer matches BOTH scans
    seen.add(k);
    rows.push({
      hash: l.transactionHash,
      token: lower(l.address),
      from: addrFromTopic(l.topics[1]!),
      to: addrFromTopic(l.topics[2]!),
      value: ethers.toBigInt(l.data || "0x0"),
      blockNumber: l.blockNumber,
      timeMs: 0,
    });
  }
  rows.sort((a, b) => a.blockNumber - b.blockNumber);
  return withTimestamps(rows);
}

// ══════════════════════════ addressTokens ══════════════════════════

const ERC721_ABI = ["function ownerOf(uint256) view returns (address)"] as const;

/**
 * ERC-20 holdings of an address, non-zero balances only.
 *
 * rpc backend: incoming Transfer logs name every token that ever reached the wallet; the BALANCE
 * then comes from `balanceOf` — authoritative, never summed from the logs (a summed balance drifts
 * the moment a transfer falls outside the window, and this feeds "what is the wallet worth").
 * The candidate list is capped so a wallet airdropped by 500 scam tokens can't fire 500 reads.
 */
export async function addressTokens(address: string): Promise<IndexedTokenBalance[] | null> {
  if (KIND === "blockscout") {
    const r = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${address}/tokens`);
    if (!r || !Array.isArray(r.items)) return null;
    const out: IndexedTokenBalance[] = [];
    for (const it of r.items) {
      const t = it?.token;
      if (!t || t.type !== "ERC-20" || !t.address_hash) continue;
      let raw: bigint;
      try {
        raw = BigInt(it.value ?? 0);
      } catch {
        continue;
      }
      if (raw <= 0n) continue;
      out.push({
        address: ethers.getAddress(t.address_hash),
        symbol: String(t.symbol ?? "?"),
        decimals: Number(t.decimals ?? 18),
        raw,
      });
    }
    return out;
  }

  const head = await headBlock().catch(() => 0);
  if (!head) return null;
  const from = Math.max(0, head - historyWindowBlocks());
  const scan = await getLogsChunked({ topics: [TRANSFER_TOPIC, null, topicAddr(address)] }, from, head, {
    budgetMs: 25_000,
  });
  if (scan.partial) {
    if (!scan.logs.length) return null;
    // Partial here can only make the list SHORT, never a balance wrong (every balance below is a
    // balanceOf). Under-reporting holdings under-states wallet value — the safe direction.
    indexerNote("addressTokens", "transfer scan truncated — token list may be incomplete (readable balances remain accurate)");
  }
  // Newest chunk first (getLogsChunked is descending), so the cap keeps the most RECENT tokens.
  const cands: string[] = [];
  const seen = new Set<string>();
  for (const q of quoteAssets()) {
    // The quote assets are always worth checking even if no transfer landed in the window —
    // on a chain where the stable quote IS the capital, missing it would hide the whole balance.
    const a = q.address.toLowerCase();
    if (seen.has(a)) continue;
    seen.add(a);
    cands.push(a);
  }
  for (const l of scan.logs) {
    if (l.topics.length !== 3) continue; // ERC-721 mints/transfers are not holdings
    const a = lower(l.address);
    if (seen.has(a)) continue;
    seen.add(a);
    cands.push(a);
    if (cands.length >= 120) break;
  }
  const rows = await mapLimit(cands, 8, async (a): Promise<IndexedTokenBalance | null> => {
    try {
      const c = new ethers.Contract(a, ERC20_ABI, provider);
      const raw: bigint = await c.balanceOf!(address);
      if (raw <= 0n) return null;
      const m = await tokenMeta(a).catch(() => ({ symbol: "?", decimals: 18 }));
      return { address: ethers.getAddress(a), symbol: m.symbol, decimals: m.decimals, raw };
    } catch {
      return null; // not an ERC-20 / reverting token → not a holding we can value
    }
  });
  return rows.filter((r): r is IndexedTokenBalance => r !== null);
}

// ══════════════════════════ txLogs ══════════════════════════

/**
 * The logs of one transaction. Works on BOTH backends — a receipt is a plain RPC read — which is
 * why ledger backfill only loses its DRIVER (txHistory) on an indexer-less chain, not its parser.
 */
export async function txLogs(hash: string): Promise<IndexedLog[] | null> {
  if (KIND === "blockscout") {
    const r = await bsFetch<{ items?: any[] }>(`/api/v2/transactions/${hash}/logs`);
    if (!r || !Array.isArray(r.items)) return null;
    return r.items.map((l): IndexedLog => ({
      address: lower(l.address?.hash ?? l.address),
      topics: (l.topics ?? []).filter((t: unknown): t is string => typeof t === "string"),
      data: String(l.data ?? "0x"),
      blockNumber: Number(l.block_number ?? 0),
      txHash: String(l.transaction_hash ?? hash),
    }));
  }
  try {
    const r = await provider.getTransactionReceipt(hash);
    if (!r) return null;
    return r.logs.map((l): IndexedLog => ({
      address: lower(l.address),
      topics: [...l.topics],
      data: l.data,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
    }));
  } catch {
    return null;
  }
}

// ══════════════════════════ NFT (position manager) ══════════════════════════

/**
 * ERC-721 ids of `contract` currently owned by `owner`.
 *
 * rpc backend: incoming Transfer logs give the CANDIDATES, `ownerOf` gives the truth. The
 * ownerOf re-check is not optional — an id that was received and later sold would otherwise be
 * listed as an open position and valued as if the bot still held it.
 */
export async function nftTokenIds(contract: string, owner: string): Promise<string[] | null> {
  if (KIND === "blockscout") {
    const r = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${owner}/nft?type=ERC-721`);
    if (!r || !Array.isArray(r.items)) return null;
    const want = contract.toLowerCase();
    return r.items
      .filter((i) => lower(i?.token?.address_hash ?? i?.token?.address) === want)
      .map((i) => String(i.id))
      .filter(Boolean);
  }

  const head = await headBlock().catch(() => 0);
  if (!head) return null;
  // v4/v3 position NFTs cannot predate the deployment the profile already records.
  const from = Math.max(0, Math.min(CHAIN.discovery.v4FromBlock, head));
  const scan = await getLogsChunked({ address: contract, topics: [TRANSFER_TOPIC, null, topicAddr(owner)] }, from, head, {
    budgetMs: 25_000,
  });
  // Strict: a truncated scan DROPS position NFTs, and a position that vanishes from the list reads
  // as "already closed" — the one wrong answer here that costs money.
  if (scan.partial) return null;
  const ids = [...new Set(scan.logs.filter((l) => l.topics.length === 4).map((l) => ethers.toBigInt(l.topics[3]!).toString()))];
  const c = new ethers.Contract(contract, ERC721_ABI, provider);
  const held = await mapLimit(ids, 8, async (id) => {
    try {
      return lower(await c.ownerOf!(id)) === owner.toLowerCase() ? id : null;
    } catch {
      return null; // burned → not held
    }
  });
  return held.filter((x): x is string => x !== null);
}

/**
 * Epoch-ms of an NFT's MINT (its Transfer from 0x0) — the true "position opened at" for a
 * position the bot didn't open itself (manual web-UI mints have no positions.json record).
 */
export async function nftMintTimestamp(contract: string, tokenId: string): Promise<number | null> {
  if (KIND === "blockscout") {
    const r = await bsFetch<{ items?: any[] }>(`/api/v2/tokens/${contract}/instances/${tokenId}/transfers`, 10_000);
    if (!r || !Array.isArray(r.items)) return null;
    const items = r.items;
    // Blockscout returns newest-first; the MINT is the 0x0-sender row (fall back to the oldest row).
    const mint = items.filter((i) => /^0x0{40}$/i.test(i?.from?.hash || "")).pop() ?? items.pop();
    const ts = mint?.timestamp ? new Date(mint.timestamp).getTime() : NaN;
    return Number.isFinite(ts) ? ts : null;
  }

  const head = await headBlock().catch(() => 0);
  if (!head) return null;
  const from = Math.max(0, Math.min(CHAIN.discovery.v4FromBlock, head));
  let idTopic: string;
  try {
    idTopic = ethers.toBeHex(BigInt(tokenId), 32);
  } catch {
    return null;
  }
  const scan = await getLogsChunked({ address: contract, topics: [TRANSFER_TOPIC, ZERO_TOPIC, null, idTopic] }, from, head, {
    budgetMs: 20_000,
  });
  const mint = scan.logs.sort((a, b) => a.blockNumber - b.blockNumber)[0];
  if (!mint) return null;
  return blockTimestampMs(mint.blockNumber);
}

// ══════════════════════════ token catalog ══════════════════════════

/**
 * Tokens to consider for a volume scan.
 *
 * blockscout → the explorer's ERC-20 catalog, paginated exactly as the scanner did inline.
 * rpc        → the tokens that ACTUALLY TRADED in the last CATALOG_MIN minutes, ranked by transfer
 *              count. That is not the same list, and for a spike scanner it is the better one: a
 *              catalog is mostly dead tokens, while "moved in the last 15 minutes" is the shortlist
 *              a volume spike can only come from. One unfiltered getLogs over a SHORT window pays
 *              for the whole list, which is why the window is minutes and not hours.
 */
const CATALOG_MIN = Math.max(1, Number(process.env.RH_CATALOG_MIN) || 15);

interface CatalogPage {
  items?: any[];
  next_page_params?: Record<string, string> | null;
}

export async function tokenCatalog(max: number): Promise<IndexedToken[] | null> {
  if (KIND === "blockscout") {
    const out: IndexedToken[] = [];
    let next: Record<string, string> | null = null;
    for (let page = 0; page < 10 && out.length < max; page++) {
      const q: string = next ? "?" + new URLSearchParams(next).toString() : "?type=ERC-20";
      // `r` is annotated rather than inferred from the generic: q ← next ← r ← q is a type cycle
      // TS refuses to resolve (TS7022), and the same explicit-annotation shape is what the old
      // inline scanner pagination used.
      const r: CatalogPage | null = await bsFetch<CatalogPage>(`/api/v2/tokens${q}`, 15_000);
      for (const t of r?.items ?? []) {
        const addr = t.address_hash || t.address;
        if (!addr) continue;
        try {
          out.push({ address: ethers.getAddress(addr), symbol: String(t.symbol ?? "?") });
        } catch {
          /* malformed address in the catalog → skip */
        }
      }
      next = r?.next_page_params ?? null;
      if (!next) break;
    }
    // Nothing at all came back → "can't know" (the caller keeps its previous list instead of
    // caching an empty one for half an hour).
    return out.length ? out.slice(0, max) : null;
  }

  const head = await headBlock().catch(() => 0);
  if (!head) return null;
  const from = Math.max(0, head - blocksForMs(CATALOG_MIN * 60_000));
  const scan = await getLogsChunked({ topics: [TRANSFER_TOPIC] }, from, head, { budgetMs: 20_000, maxCalls: 60 });
  if (!scan.logs.length) return null;
  const hits = new Map<string, number>();
  for (const l of scan.logs) {
    if (l.topics.length !== 3) continue; // ERC-721 activity is not a token market
    const a = lower(l.address);
    hits.set(a, (hits.get(a) ?? 0) + 1);
  }
  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
  // Symbols come from the metadata cache; an unreadable one stays "?" rather than dropping the row.
  const rows = await mapLimit(ranked, 8, async ([a]): Promise<IndexedToken> => {
    const m = await tokenMeta(a).catch(() => ({ symbol: "?" }));
    return { address: ethers.getAddress(a), symbol: m.symbol };
  });
  return rows;
}

log.info(`indexer ${indexerSummary()} · ${CHAIN.explorer.api}`);
