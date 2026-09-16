/**
 * Chain profile = everything that differs between chains, in ONE validated place.
 *
 * Why this exists: the bot was written against Robinhood Chain with its facts baked in —
 * ETH is native, WETH wraps it, USDG is the stable quote, there's a sequencer, Blockscout
 * indexes everything, KyberSwap routes swaps, GMGN + DexScreener supply the candidate feed.
 * NONE of that is true on Arc (Circle's L1): the gas token IS USDC, there is no wrapped
 * native at all, there is no sequencer, and every third-party data source is unverified.
 *
 * Each of those is a FLAG here with a fallback, never a hard assumption — a missing
 * third party has to degrade one signal, not break a bot that is holding positions.
 *
 * The profile is selected by RH_CHAIN (see util/files.ts CHAIN_KEY). Unset = "robinhood",
 * which loads chains/robinhood.json whose values are identical to the old hardcoded ones,
 * so the live bot's behaviour is bit-for-bit unchanged.
 *
 * Money-safety note: profiles hold ADDRESSES. A wrong file here means signing against the
 * wrong contracts, so load() validates the shape AND asserts profile.key === CHAIN_KEY
 * (a copy-pasted chains/arc.json that still says "robinhood" would otherwise silently point
 * the Arc process at Robinhood's PositionManager).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CHAIN_KEY, ROOT } from "../util/files.js";
import { logger } from "../util/log.js";

const log = logger("profile");

/** EVM address, validated but NOT normalised — the strings are compared with .toLowerCase()
 *  all over the codebase and are passed to ethers.getAddress() where a checksum is needed. */
const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "not an EVM address (0x + 40 hex)");

const ExplorerSchema = z.object({
  url: z.string().url(), // human link base: `${url}/tx/${hash}`
  api: z.string().url(), // REST/JSON-RPC base used by the indexer layer
  // "blockscout" = the Blockscout REST API (lifetime PnL, holdings, ledger backfill, mint ts).
  // "rpc"        = no indexer; those features fall back to bounded getLogs on the archival RPC.
  kind: z.enum(["blockscout", "rpc"]),
});

const NativeSchema = z.object({
  symbol: z.string().min(1), // "ETH" on Robinhood, "USDC" on Arc
  decimals: z.number().int().positive(), // 18 on BOTH chains (Arc's native USDC is an 18-dec repr)
  stable: z.boolean(), // true = native is worth $1, so nativeUsd() is a constant, not a price feed
  // Wrapped native (WETH9). null on Arc: no WETH9 exists, so every wrap/unwrap path is a no-op
  // there and v3 pools CANNOT be native-paired → every Arc pool is token/stable-ERC20.
  wrapped: Addr.nullable(),
  // Native units held back from every position size. On Arc gas and LP capital are the SAME
  // balance, so this is a FLOOR (never a cap): without it the bot can open a position it
  // cannot afford the gas to close.
  gasReserve: z.number().min(0),
  // Does the ERC-20 view of the native token report the SAME balance as eth_getBalance?
  // Arc: yes — native USDC (18-dec) and the 6-dec ERC-20 predeploy are two precisions over ONE
  // balance, so counting both would double-count the wallet and sizing off either is equivalent.
  // Robinhood: no — WETH is a genuinely separate balance from native ETH. Verified per chain by
  // `npm run probe:arc` (the native/ERC-20 parity check); default false is the safe assumption
  // because treating two real balances as one would UNDER-count, never over-spend.
  erc20Parity: z.boolean().default(false),
});

const QuoteSchema = z.object({
  kind: z.enum(["erc20", "native"]),
  address: Addr,
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  // "eth" = priced in native, "usd" = a dollar stable. stableQuote() picks the first "usd";
  // that is the asset the token/stable LP path quotes against (USDG here, USDC on Arc).
  class: z.enum(["eth", "usd"]),
});

/**
 * Contracts. v3 core is required (factory/positionManager/swapRouter02/quoter — the bot
 * cannot mint without them); everything else is optional so a chain that lacks a venue
 * simply has the key missing and the caller's `C.x!` guard trips loudly.
 * `weth` is optional HERE (Arc has none) but config.ts always exposes a string — see NO_WETH.
 */
export const ProfileContractsSchema = z.object({
  factory: Addr, // v3 factory
  positionManager: Addr, // v3 NonfungiblePositionManager
  swapRouter02: Addr,
  quoter: Addr,
  weth: Addr.optional(), // absent on Arc
  v2Factory: Addr.optional(),
  v4PoolManager: Addr.optional(),
  v4PositionManager: Addr.optional(),
  v4StateView: Addr.optional(),
  v4Quoter: Addr.optional(),
  universalRouter: Addr.optional(), // routes v2/v3/v4
  permit2: Addr.optional(), // canonical on every chain; v4/mint.ts still uses its own const
  multicall: Addr.optional(),
  tickLens: Addr.optional(),
  cctpTokenMessenger: Addr.optional(), // Arc funding/drain path (CCTP v2, domain 26)
  // Additional V3 factory contracts (forks like Lunya on Arc). Pool lookups, event scans and
  // position resolution query EVERY factory — the canonical one (factory) and these.
  extraV3Factories: z.array(Addr).optional(),
});

const GasSchema = z.object({
  // "legacy"  = today's Robinhood policy: gasPrice × multiplier (base fee floats per block and a
  //             tight maxFee gets the tx rejected → a close that never lands).
  // "eip1559" = type-2: maxFee = baseFee × multiplier + priority. Arc's base fee is a CONSTANT
  //             20 gwei, so this is exact rather than a guess.
  mode: z.enum(["eip1559", "legacy"]),
  priorityGwei: z.number().min(0), // tip; ignored in legacy mode
  multiplier: z.number().positive(), // buffer on the base/gas price (3 = Robinhood's live value)
  // Fallback base fee (gwei) used ONLY when the node won't give one. 0 = no fallback (then the
  // legacy gasPrice path is used instead — never return an under-priced tx).
  fixedGwei: z.number().min(0).default(0),
});

const VenuesSchema = z.object({
  v2: z.boolean(),
  v3: z.boolean(),
  v4: z.boolean(),
  // Can a v4 pool key use the native 0x0 sentinel? false on Arc: native USDC is 18-dec while the
  // pool currency is the 6-dec ERC-20, and Uniswap's own Arc guidance is to reject 0x0 there.
  v4NativeCurrency: z.boolean(),
});

const DataSchema = z.object({
  dexscreener: z.string().min(1), // chainId slug in the DexScreener API
  kyberChain: z.string().min(1).nullable(), // null = aggregator has no route API for this chain
  gmgn: z.boolean(), // GMGN covers this chain (candidate source + tax/holder gates)
  // Where 1h/24h pool volume comes from. "onchain" = derive from Swap events (slower, always works).
  volumeSource: z.enum(["dexscreener", "onchain"]),
  // Which venue buys the token side before an in-range LP. "kyber" = aggregator best-route,
  // "uniswap" = the built-in per-fee-tier SwapRouter02/UniversalRouter fallback.
  router: z.enum(["kyber", "uniswap"]),
});

const DiscoverySchema = z.object({
  // Earliest block worth scanning for v4 Initialize logs. 0 = from genesis. On a chain whose
  // Uniswap deploys are far from genesis this saves a full-range getLogs on every scan.
  v4FromBlock: z.number().int().min(0),
});

export const ChainProfileSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9-]+$/), // also the data/<key>/ directory name
    name: z.string().min(1), // display name in Telegram
    chainId: z.number().int().positive(),
    rpcUrl: z.string().url(),
    blockTimeMs: z.number().int().positive(), // real cadence — used for block↔time math (log windows)
    // tx-receipt polling cadence (~half a block). ethers' 4s default wastes ~20s on a 5-tx close
    // when blocks are sub-second, which is why this is tuned per chain and not left alone.
    pollMs: z.number().int().positive(),
    explorer: ExplorerSchema,
    // Direct tx-submission endpoint (Robinhood). null = no sequencer; fast-submit is refused and
    // the plain JsonRpcProvider is used. Arc is a validator L1 — there is nothing to submit to.
    sequencer: z.string().url().nullable(),
    native: NativeSchema,
    quotes: z.array(QuoteSchema).nonempty(),
    contracts: ProfileContractsSchema,
    gas: GasSchema,
    venues: VenuesSchema,
    data: DataSchema,
    discovery: DiscoverySchema,
  })
  .superRefine((p, ctx) => {
    // The token/stable path is the ONLY path that works on a chain without a wrapped native,
    // so a profile with no usd quote would leave Arc unable to open anything.
    if (!p.quotes.some((q) => q.class === "usd")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["quotes"], message: "need at least 1 quote with class 'usd'" });
    }
    if (p.native.wrapped && p.contracts.weth && p.native.wrapped.toLowerCase() !== p.contracts.weth.toLowerCase()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["native", "wrapped"], message: "native.wrapped != contracts.weth" });
    }
    // v4NativeCurrency means "a pool key may hold the 0x0 sentinel". Without a wrapped native the
    // 18-vs-6 decimal mismatch is exactly what Uniswap's Arc playbook says to avoid.
    if (p.venues.v4NativeCurrency && !p.native.wrapped) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["venues", "v4NativeCurrency"], message: "must not be true on a chain without wrapped native" });
    }
  });

export type ChainProfile = z.infer<typeof ChainProfileSchema>;
export type NativeSpec = ChainProfile["native"];
export type QuoteAsset = ChainProfile["quotes"][number];
export type ProfileContracts = z.infer<typeof ProfileContractsSchema>;

function load(): ChainProfile {
  const file = path.join(ROOT, "chains", `${CHAIN_KEY}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`chain profile "${CHAIN_KEY}" could not be read (${file}): ${(e as Error).message}`);
  }
  const parsed = ChainProfileSchema.safeParse(raw);
  if (!parsed.success) {
    log.error(`chains/${CHAIN_KEY}.json invalid`, parsed.error.flatten().fieldErrors);
    throw new Error(`chains/${CHAIN_KEY}.json failed validation — check the fields above.`);
  }
  // RH_CHAIN picks the file AND the data/ dir; the key inside must agree or the process would
  // write chain A's positions into chain B's directory (or worse, sign with B's addresses).
  if (parsed.data.key !== CHAIN_KEY) {
    throw new Error(`chains/${CHAIN_KEY}.json has key "${parsed.data.key}" — must be "${CHAIN_KEY}".`);
  }
  return parsed.data;
}

/** The loaded profile. One per process; RH_CHAIN cannot change at runtime. */
export const CHAIN: ChainProfile = load();

log.info(
  `chain ${CHAIN.name} (${CHAIN.key}/${CHAIN.chainId}) · native ${CHAIN.native.symbol}` +
    `${CHAIN.native.wrapped ? "" : " (no wrapped)"} · quote ${CHAIN.quotes.map((q) => q.symbol).join("/")}` +
    ` · router ${CHAIN.data.router} · vol ${CHAIN.data.volumeSource}${CHAIN.sequencer ? " · sequencer" : ""}`,
);

export function profile(): ChainProfile {
  return CHAIN;
}

export function nativeCurrency(): NativeSpec {
  return CHAIN.native;
}

export function quoteAssets(): QuoteAsset[] {
  return CHAIN.quotes;
}

/** The dollar quote asset (USDG on Robinhood, the 6-dec USDC ERC-20 on Arc). Guaranteed to
 *  exist by the schema refinement, so callers don't need a null branch. */
export function stableQuote(): QuoteAsset {
  const q = CHAIN.quotes.find((x) => x.class === "usd");
  if (!q) throw new Error(`profile ${CHAIN.key} missing 'usd' quote`); // unreachable: see superRefine
  return q;
}

/** false on Arc → skip every wrap/unwrap step, WETH balance read and WETH-paired pool lookup. */
export function hasWrappedNative(): boolean {
  return CHAIN.native.wrapped !== null;
}
