/**
 * Global wallet-tx serializer. The hot wallet fires MULTI-tx sequences (an in-range open = buy →
 * approve → mint; a close = decrease → collect → burn → sweep). Two sequences running at once grab
 * the SAME nonce → "nonce has already been used" / execution reverted (both fail, token already
 * bought = stuck). This lock serializes the bot's own open/close sequences (open+open, open+close,
 * close+close).
 *
 * NOTE: it does NOT cover the separate arb-bot process that shares the wallet — that's cross-process
 * contention and needs infra-level coordination. This only fixes THIS bot's internal races.
 */
let busy = false;
let kyberTail: Promise<void> = Promise.resolve();

/** True while a wallet-tx sequence is in flight. */
export const walletBusy = (): boolean => busy;

/** Try to take the lock. Returns false if already held (caller should skip / retry later). */
export function acquireWallet(): boolean {
  if (busy) return false;
  busy = true;
  return true;
}

/** Release the lock. Always call in a finally. */
export function releaseWallet(): void {
  busy = false;
}

/** Run one wallet transaction sequence while holding the process-wide lock. */
export async function withWalletLock<T>(work: () => Promise<T>): Promise<T | false> {
  if (!acquireWallet()) return false;
  try {
    return await work();
  } finally {
    releaseWallet();
  }
}

/**
 * Serialize Kyber calls even when a caller is not holding the broader wallet lock.
 *
 * The wallet lock protects the bot's complete open/close sequences. This narrower queue is an
 * additional guard for shared helpers such as wallet swaps and leftover sweeps: only one Kyber
 * quote → approval → broadcast sequence may re-check and spend a balance at a time.
 */
export async function withKyberSwapLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = kyberTail;
  let release!: () => void;
  kyberTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
