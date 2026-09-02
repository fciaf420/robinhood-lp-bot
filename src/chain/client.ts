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
          log.warn(`sequencer submit failed (${(e as Error).message}) → falling back to primary RPC`);
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

export const provider: ethers.JsonRpcProvider = env.fastSubmit
  ? new SequencerRoutingProvider(rpcReq(env.rpcUrl), cfg.chainId)
  : new ethers.JsonRpcProvider(rpcReq(env.rpcUrl), cfg.chainId);

// Robinhood blocks are SUB-SECOND, but ethers' default pollingInterval is 4s → tx.wait() only
// notices a mined receipt on the next 4s poll. A multi-tx close/add/swap (5 txs) then wastes up to
// ~20s just polling, even though each tx lands instantly. Poll fast so tx.wait() returns quickly.
provider.pollingInterval = Number(process.env.RH_POLL_MS) || 350;

if (env.fastSubmit) log.info(`fast-submit ON → ${env.sequencerUrl}${env.sequencerIp ? ` @${env.sequencerIp}` : ""} · poll ${provider.pollingInterval}ms`);

/**
 * Reads use the private RPC first and fail over to Robinhood's public RPC. The wallet and every
 * transaction remain attached to `provider`, so adding the public endpoint cannot broadcast a
 * transaction through an unintended node. FallbackProvider starts the public request only when
 * the primary is slow enough to miss its stall window, keeping normal traffic on Alchemy.
 */
export const usingPublicRpcFallback = !!env.publicRpcUrl && env.publicRpcUrl !== env.rpcUrl;
export const publicProvider = usingPublicRpcFallback
  ? new ethers.JsonRpcProvider(rpcReq(env.publicRpcUrl), cfg.chainId)
  : null;
export const readProvider: ethers.AbstractProvider = publicProvider
  ? new ethers.FallbackProvider(
      [
        { provider, priority: 1, stallTimeout: Number(process.env.RH_RPC_STALL_MS) || 1500, weight: 1 },
        { provider: publicProvider, priority: 2, stallTimeout: Number(process.env.RH_PUBLIC_RPC_STALL_MS) || 2500, weight: 1 },
      ],
      cfg.chainId,
      { quorum: 1 },
    )
  : provider;
if (usingPublicRpcFallback) log.info("RPC read fallback ON — private primary + Robinhood public secondary");

export const usingOwnWatchRpc = !!env.watchRpcUrl;
export const watchProvider = env.watchRpcUrl
  ? new ethers.FallbackProvider(
      [
        { provider: new ethers.JsonRpcProvider(rpcReq(env.watchRpcUrl), cfg.chainId), priority: 1, stallTimeout: 1500, weight: 1 },
        { provider, priority: 2, stallTimeout: 1500, weight: 1 },
        ...(publicProvider ? [{ provider: publicProvider, priority: 3, stallTimeout: 2500, weight: 1 }] : []),
      ],
      cfg.chainId,
      { quorum: 1 },
    )
  : readProvider;

// Dedicated provider for v4 discovery getLogs (see rpcInitLogs). Full-range getLogs is the heaviest,
// burstiest read the bot makes (hunt scans many tokens every 3m); giving it its OWN RPC keeps a burst
// from slowing the main provider that mint/close depend on. Falls back to `provider` when unset.
export const usingOwnLogsRpc = !!env.logsRpcUrl;
export const logsProvider: ethers.JsonRpcProvider = env.logsRpcUrl
  ? new ethers.FallbackProvider(
      [
        { provider: new ethers.JsonRpcProvider(rpcReq(env.logsRpcUrl), cfg.chainId), priority: 1, stallTimeout: 1500, weight: 1 },
        { provider, priority: 2, stallTimeout: 1500, weight: 1 },
        ...(publicProvider ? [{ provider: publicProvider, priority: 3, stallTimeout: 2500, weight: 1 }] : []),
      ],
      cfg.chainId,
      { quorum: 1 },
    ) as unknown as ethers.JsonRpcProvider
  : readProvider as ethers.JsonRpcProvider;
if (usingOwnWatchRpc || usingOwnLogsRpc) log.info(`RPC split — watch:${usingOwnWatchRpc ? "own" : "main"} · logs:${usingOwnLogsRpc ? "own" : "main"}`);

let _wallet: ethers.Wallet | null = null;
export function wallet(): ethers.Wallet {
  if (!_wallet) {
    if (!env.walletKey) throw new Error("RH_WALLET_KEY is not set in .env");
    _wallet = new ethers.Wallet(env.walletKey, provider);
  }
  return _wallet;
}

/**
 * Gas overrides. Robinhood base fee moves per block; if maxFee is too tight the tx is
 * rejected ("max fee < base fee") and hangs → close/mint never lands. Buffer 3×.
 */
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

export async function overrides(): Promise<ethers.Overrides> {
  if (Number(cfg.gasPriceGwei) > 0) {
    return { gasPrice: ethers.parseUnits(String(cfg.gasPriceGwei), "gwei") };
  }
  try {
    const gp = (await provider.getFeeData()).gasPrice;
    if (gp) return { gasPrice: gp * 3n };
  } catch {
    /* fall through to node default */
  }
  return {};
}
