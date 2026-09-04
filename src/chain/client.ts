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

/** Provider errors that mean the locally selected nonce was already consumed elsewhere. */
export function isNonceConflict(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = String(e?.code ?? "").toLowerCase();
  const message = String(e?.message ?? error ?? "").toLowerCase();
  return (
    code === "nonce_expired" ||
    code === "nonce_too_low" ||
    message.includes("nonce has already been used") ||
    message.includes("nonce too low") ||
    message.includes("nonce is too low") ||
    message.includes("invalid transaction nonce") ||
    message.includes("invalid nonce") ||
    message.includes("already used")
  );
}

/**
 * Only an explicit nonce-conflict response is safe to retry automatically.
 *
 * A generic `sendTransaction` / `transaction execution reverted` response with an
 * empty payload is ambiguous on Robinhood: the node may have accepted the raw
 * transaction and failed while returning its response. Retrying the same calldata
 * with a fresh nonce can execute a swap twice (the first one succeeds, the second
 * one then fails because the input balance/allowance was already spent).
 */
export function isRetryableSendError(error: unknown): boolean {
  return isNonceConflict(error);
}

/** A contract transaction must contain at least a valid function selector. */
export function hasUsableCalldata(data: unknown): data is string {
  return typeof data === "string" && /^0x[0-9a-f]+$/i.test(data) && data.length >= 10;
}

export function requireCalldata(data: unknown, label: string): string {
  if (!hasUsableCalldata(data)) {
    throw new Error(`${label} returned empty transaction data — nothing was submitted; retry shortly`);
  }
  return data;
}

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
const publicFallbackUrls = env.publicRpcUrls.filter((url) => url && url !== env.rpcUrl);
export const usingPublicRpcFallback = publicFallbackUrls.length > 0;
export const publicProviders = publicFallbackUrls.map((url) => new ethers.JsonRpcProvider(rpcReq(url), cfg.chainId));
// Compatibility alias for callers that only need one public provider.
export const publicProvider = publicProviders[0] ?? null;
export const readProvider: ethers.AbstractProvider = usingPublicRpcFallback
  ? new ethers.FallbackProvider(
      [
        { provider, priority: 1, stallTimeout: Number(process.env.RH_RPC_STALL_MS) || 1500, weight: 1 },
        ...publicProviders.map((p, i) => ({
          provider: p,
          priority: i + 2,
          stallTimeout: Number(process.env.RH_PUBLIC_RPC_STALL_MS) || 2500,
          weight: 1,
        })),
      ],
      cfg.chainId,
      { quorum: 1 },
    )
  : provider;
if (usingPublicRpcFallback) log.info(`RPC read fallback ON — private primary + ${publicProviders.length} public secondary endpoint(s)`);

export const usingOwnWatchRpc = !!env.watchRpcUrl;
export const watchProvider = env.watchRpcUrl
  ? new ethers.FallbackProvider(
      [
        { provider: new ethers.JsonRpcProvider(rpcReq(env.watchRpcUrl), cfg.chainId), priority: 1, stallTimeout: 1500, weight: 1 },
        { provider, priority: 2, stallTimeout: 1500, weight: 1 },
        ...publicProviders.map((p, i) => ({ provider: p, priority: i + 3, stallTimeout: 2500, weight: 1 })),
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
        ...publicProviders.map((p, i) => ({ provider: p, priority: i + 3, stallTimeout: 2500, weight: 1 })),
      ],
      cfg.chainId,
      { quorum: 1 },
    ) as unknown as ethers.JsonRpcProvider
  : readProvider as ethers.JsonRpcProvider;
if (usingOwnWatchRpc || usingOwnLogsRpc) log.info(`RPC split — watch:${usingOwnWatchRpc ? "own" : "main"} · logs:${usingOwnLogsRpc ? "own" : "main"}`);

/**
 * Wallet with a small nonce coordinator for multi-transaction LP sequences.
 *
 * The bot already serializes its own sequences, but a stale RPC nonce (or a transaction from a
 * second signer using the same wallet) can still make a send fail. Reserve nonces locally for the
 * normal case, and resync/retry up to three times when the node explicitly reports a consumed nonce.
 * A rejected send never gets a response/hash, so retrying with a fresh nonce is safe here.
 */
const MAX_NONCE_RETRIES = 3;

class ResilientWallet extends ethers.Wallet {
  private nextNonce: number | null = null;
  private nonceLoad: Promise<number> | null = null;
  private nonceGeneration = 0;
  private nonceFloor = 0;

  private resetNonce(minNextNonce?: number): void {
    this.nextNonce = null;
    this.nonceLoad = null;
    this.nonceGeneration++;
    if (minNextNonce != null && Number.isSafeInteger(minNextNonce) && minNextNonce >= 0) {
      this.nonceFloor = Math.max(this.nonceFloor, minNextNonce);
    }
  }

  private async reserveNonce(): Promise<number> {
    while (true) {
      if (this.nextNonce == null) {
        const generation = this.nonceGeneration;
        const load = this.nonceLoad ?? (this.nonceLoad = this.loadNetworkNonce());
        const base = await load;
        // A nonce conflict may invalidate a read that was already in flight. Never seed the
        // coordinator from that stale response after a reset.
        if (generation !== this.nonceGeneration) continue;
        if (this.nextNonce == null) this.nextNonce = Math.max(base, this.nonceFloor);
        if (this.nonceLoad === load) this.nonceLoad = null;
      }
      const nonce = this.nextNonce;
      this.nextNonce++;
      return nonce;
    }
  }

  private async loadNetworkNonce(): Promise<number> {
    // `pending` is normally authoritative, while `latest` catches a private RPC that has not
    // yet indexed a just-mined transaction. Taking the greater value avoids reusing a nonce
    // after an external signer advanced the same wallet.
    const [pending, latest] = await Promise.all([this.getNonce("pending"), this.getNonce("latest")]);
    return Math.max(pending, latest);
  }

  override async sendTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
    for (let attempt = 0; attempt <= MAX_NONCE_RETRIES; attempt++) {
      const nonce = tx.nonce == null || attempt > 0 ? await this.reserveNonce() : tx.nonce;
      try {
        const sent = await super.sendTransaction({ ...tx, nonce });
        const sentNext = sent.nonce + 1;
        this.nonceFloor = Math.max(this.nonceFloor, sentNext);
        if (this.nextNonce != null) this.nextNonce = Math.max(this.nextNonce, sentNext);
        return sent;
      } catch (e) {
        // Any rejected send did not consume the reserved nonce; resync before the next operation.
        const selectedNonce = Number(nonce);
        this.resetNonce(isRetryableSendError(e) && Number.isSafeInteger(selectedNonce) ? selectedNonce + 1 : undefined);
        if (attempt < MAX_NONCE_RETRIES && isRetryableSendError(e)) {
          log.warn(`nonce/provider conflict — resyncing pending nonce and retrying transaction (${attempt + 1}/${MAX_NONCE_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw new Error("unreachable nonce retry");
  }
}

let _wallet: ethers.Wallet | null = null;
export function wallet(): ethers.Wallet {
  if (!_wallet) {
    if (!env.walletKey) throw new Error("RH_WALLET_KEY is not set in .env");
    _wallet = new ResilientWallet(env.walletKey, provider);
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

/**
 * Reconcile a transaction after a provider reports an ambiguous send/wait failure.
 *
 * Robinhood RPCs have returned `transaction execution reverted` from `tx.wait()` for
 * transactions that were actually mined successfully. A receipt lookup by hash is the
 * authoritative answer, so callers must reconcile before telling the user to retry.
 * Reads try the private provider first and then the configured read fallback; this helper
 * never submits or resubmits a transaction.
 */
const TX_RECONCILE_MS = Number(process.env.RH_TX_RECONCILE_MS) || 15_000;
const TX_RECONCILE_POLL_MS = Number(process.env.RH_TX_RECONCILE_POLL_MS) || 350;

export async function reconcileTransactionReceipt(
  hash: string,
  timeoutMs = TX_RECONCILE_MS,
): Promise<ethers.TransactionReceipt | null> {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) return null;
  const readers: ethers.AbstractProvider[] = [provider];
  if (readProvider !== provider) readers.push(readProvider);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastError: unknown;

  do {
    for (const reader of readers) {
      try {
        const receipt = await reader.getTransactionReceipt(hash);
        if (receipt) return receipt;
      } catch (e) {
        lastError = e;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(TX_RECONCILE_POLL_MS, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);

  if (lastError) log.warn(`receipt reconciliation failed for ${hash}: ${checkedTxError(lastError)}`);
  return null;
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

function checkedTxError(error: unknown): string {
  const e = error as { shortMessage?: unknown; reason?: unknown; message?: unknown } | null;
  return String(e?.shortMessage ?? e?.reason ?? e?.message ?? error).replace(/\s+/g, " ").slice(0, 180);
}

/**
 * Preflight a contract transaction with the same sender, then submit it with an explicit gas
 * limit. Calling sendTransaction without gasLimit makes ethers run an implicit estimate and turns
 * Robinhood's empty `require(false)` response into an opaque error. Keeping the call and estimate
 * here also makes every close step identify itself before anything is broadcast.
 */
export async function sendCheckedTransaction(
  request: ethers.TransactionRequest,
  label: string,
): Promise<ethers.TransactionResponse> {
  const w = wallet();
  const data = requireCalldata(request.data, label);
  const simulation = { ...request, data, from: w.address };

  try {
    await provider.call(simulation);
  } catch (e) {
    throw new Error(`${label} simulation reverted: ${checkedTxError(e)}`);
  }

  let estimated: bigint;
  try {
    estimated = await provider.estimateGas(simulation);
  } catch (primaryError) {
    // A transient private-RPC estimate failure should not prevent a close when the read fallback
    // can independently validate the exact same calldata. This is still a simulation/estimate,
    // never a blind send.
    try {
      estimated = await readProvider.estimateGas(simulation);
      log.warn(`${label}: primary gas estimate failed; read fallback supplied the estimate`);
    } catch (fallbackError) {
      throw new Error(
        `${label} gas estimate reverted: ${checkedTxError(primaryError)}; fallback: ${checkedTxError(fallbackError)}`,
      );
    }
  }

  const sendRequest: ethers.TransactionRequest = {
    ...request,
    data,
    gasLimit: estimated > 0n ? estimated * 2n : 1_000_000n,
    ...(await overrides()),
  };
  // populateTransaction may carry a `from`; the signer supplies the authoritative sender.
  delete sendRequest.from;
  return w.sendTransaction(sendRequest);
}
