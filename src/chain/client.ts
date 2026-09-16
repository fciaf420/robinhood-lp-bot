/**
 * Chain clients: providers, the (single) wallet, and gas overrides.
 *
 * Two providers on purpose:
 *   provider      → LP ops (mint/close/quote). RH_RPC_URL, fallback config.rpcUrl.
 *   watchProvider → volume scanner. RH_WATCH_RPC_URL so scan traffic can't rate-limit
 *                   the RPC you need when closing a position. Falls back to `provider`.
 */
import { ethers, type JsonRpcPayload, type JsonRpcResult } from "ethers";
import { cfg, env } from "../config.js";
import { CHAIN } from "./profile.js";
import { seqCall } from "./sequencer.js";
import { logger } from "../util/log.js";

const log = logger("client");

/**
 * A JsonRpcProvider that reads from Alchemy but diverts `eth_sendRawTransaction` to the
 * sequencer (fastest fire). On transport failure it falls back to Alchemy so a tx is
 * never lost. Everything else (nonce, gas, staticCall, logs) stays on Alchemy.
 */
class SequencerRoutingProvider extends ethers.JsonRpcProvider {
  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const items = Array.isArray(payload) ? payload : [payload];
    if (!items.some((p) => p.method === "eth_sendRawTransaction")) {
      return super._send(payload);
    }
    return Promise.all(
      items.map(async (p) => {
        if (p.method !== "eth_sendRawTransaction") {
          return (await super._send([p]))[0]!;
        }
        try {
          const resp = await seqCall({ id: p.id, method: p.method, params: p.params as unknown[] });
          // ethers accepts an error-shaped result object here at runtime
          return (resp.error ? { id: p.id, error: resp.error } : { id: p.id, result: resp.result! }) as JsonRpcResult;
        } catch (e) {
          log.warn(`sequencer submit gagal (${(e as Error).message}) → fallback RPC utama`);
          return (await super._send([p]))[0]!;
        }
      }),
    );
  }
}

// Per-request RPC timeout. ethers' FetchRequest defaults to a 300s (5-minute!) timeout, so when the
// public RPC flaps — 503s, dead sockets that accept but never respond — a single read STALLS for five
// minutes while holding the shared wallet lock → the whole bot wedges (observed repeatedly). A 20s cap
// makes every RPC call (reads AND the tx.wait receipt polls) fast-fail on a hang → the operation throws
// → the caller releases the lock + retries next tick. Pairs with waitTx() (overall confirmation cap).
// Tune via RH_RPC_TIMEOUT_MS.
function rpcReq(url: string): ethers.FetchRequest {
  const req = new ethers.FetchRequest(url);
  req.timeout = Number(process.env.RH_RPC_TIMEOUT_MS) || 20_000;
  return req;
}

// The routing provider only makes sense where a sequencer endpoint exists. Arc is a validator L1
// (Malachite BFT, no sequencer) → profile.sequencer is null and every tx goes out over the RPC.
export const provider: ethers.JsonRpcProvider =
  env.fastSubmit && CHAIN.sequencer
    ? new SequencerRoutingProvider(rpcReq(env.rpcUrl), cfg.chainId)
    : new ethers.JsonRpcProvider(rpcReq(env.rpcUrl), cfg.chainId);

// Blocks here are SUB-SECOND, but ethers' default pollingInterval is 4s → tx.wait() only notices a
// mined receipt on the next 4s poll. A multi-tx close/add/swap (5 txs) then wastes up to ~20s just
// polling, even though each tx lands instantly. Poll fast so tx.wait() returns quickly. The cadence
// is per chain (profile.pollMs ≈ half a block): 350ms on Robinhood, 250ms on Arc's ~500ms blocks.
provider.pollingInterval = Number(process.env.RH_POLL_MS) || CHAIN.pollMs;

if (env.fastSubmit) log.info(`fast-submit ON → ${env.sequencerUrl}${env.sequencerIp ? ` @${env.sequencerIp}` : ""} · poll ${provider.pollingInterval}ms`);

export const usingOwnWatchRpc = !!env.watchRpcUrl;
export const watchProvider = env.watchRpcUrl
  ? new ethers.JsonRpcProvider(rpcReq(env.watchRpcUrl), cfg.chainId)
  : provider;

// Dedicated provider for v4 discovery getLogs (see rpcInitLogs). Full-range getLogs is the heaviest,
// burstiest read the bot makes (hunt scans many tokens every 3m); giving it its OWN RPC keeps a burst
// from slowing the main provider that mint/close depend on. Falls back to `provider` when unset.
export const usingOwnLogsRpc = !!env.logsRpcUrl;
export const logsProvider: ethers.JsonRpcProvider = env.logsRpcUrl
  ? new ethers.JsonRpcProvider(rpcReq(env.logsRpcUrl), cfg.chainId)
  : provider;
if (usingOwnWatchRpc || usingOwnLogsRpc) log.info(`RPC split — watch:${usingOwnWatchRpc ? "own" : "main"} · logs:${usingOwnLogsRpc ? "own" : "main"}`);

let _wallet: ethers.Wallet | null = null;
export function wallet(): ethers.Wallet {
  if (!_wallet) {
    if (!env.walletKey) throw new Error("RH_WALLET_KEY belum diset di .env");
    _wallet = new ethers.Wallet(env.walletKey, provider);
  }
  return _wallet;
}

/**
 * Await a tx receipt with a HARD TIMEOUT. ethers' tx.wait() hangs forever if the RPC flaps (503 /
 * dropped connection / rate-limit) mid-confirmation. Every open/close holds the shared wallet lock
 * while waiting, so ONE hung confirmation deadlocks the WHOLE bot — no further opens/closes — until a
 * manual restart (observed: a 503 during a TP close wedged the bot ~25min). Racing a timeout turns the
 * hang into a throw, which the caller's existing catch converts into a lock-release + next-tick retry
 * (the manage loop re-reads on-chain state, so a retry adapts to whatever actually landed). On the
 * fast-submit sequencer, confirmations arrive in seconds, so this never fires in normal operation.
 * Tune via RH_TX_WAIT_MS.
 */
const TX_WAIT_MS = Number(process.env.RH_TX_WAIT_MS) || 75_000;
export async function waitTx(tx: ethers.TransactionResponse, label = "tx"): Promise<ethers.TransactionReceipt | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tx.wait timeout ${TX_WAIT_MS}ms (${label}) hash=${tx.hash}`)), TX_WAIT_MS);
  });
  try {
    return await Promise.race([tx.wait(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const gweiWei = (g: number): bigint => ethers.parseUnits(g.toFixed(9), "gwei");
/** multiply a wei amount by a fractional factor without leaving bigint math (3 → ×3 exactly). */
const scale = (v: bigint, m: number): bigint => (v * BigInt(Math.round(m * 1000))) / 1000n;

/**
 * Gas overrides, per the chain profile's gas policy.
 *
 * legacy (Robinhood): the base fee moves per block; if maxFee is too tight the tx is rejected
 *   ("max fee < base fee") and hangs → a close/mint never lands. Buffer 3× (gas.multiplier).
 * eip1559 (Arc): type-2 with an explicit tip. Arc's base fee is a CONSTANT 20 gwei, so
 *   base × 1.5 + 5 gwei priority is a real number rather than a guess — and gas there is paid in
 *   USDC, i.e. a gas over-estimate is a direct dollar cost, which is why it isn't blanket-3×'d.
 *
 * Every branch falls back to the legacy read rather than to `{}` (node default): an under-priced
 * tx is the failure mode that strands a position, so a too-generous fee is always preferred.
 */
export async function overrides(): Promise<ethers.Overrides> {
  // Explicit manual override wins on every chain (`/set gasPriceGwei`).
  if (Number(cfg.gasPriceGwei) > 0) {
    return { gasPrice: ethers.parseUnits(String(cfg.gasPriceGwei), "gwei") };
  }
  const gas = CHAIN.gas;
  if (gas.mode === "eip1559") {
    try {
      // Read the base fee from the head block instead of deriving it from getFeeData(), whose
      // maxFeePerGas is ethers' own base×2+tip formula — an internal we shouldn't math against.
      const base = (await provider.getBlock("latest"))?.baseFeePerGas ?? (gas.fixedGwei > 0 ? gweiWei(gas.fixedGwei) : null);
      if (base != null) {
        const prio = gweiWei(gas.priorityGwei);
        return { maxFeePerGas: scale(base, gas.multiplier) + prio, maxPriorityFeePerGas: prio };
      }
    } catch {
      /* pre-1559 node or a flaky RPC → legacy read below */
    }
  }
  try {
    const gp = (await provider.getFeeData()).gasPrice;
    if (gp) return { gasPrice: scale(gp, gas.multiplier) };
  } catch {
    /* fall through to node default */
  }
  return {};
}
