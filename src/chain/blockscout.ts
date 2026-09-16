/**
 * Blockscout REST helpers. Used for anything getLogs can't do on the free RPC tier:
 * lifetime PnL, wallet token holdings, ledger backfill, mint timestamps.
 *
 * NOTE: v4 pool DISCOVERY moved OFF this API to the RPC (see v4/discover.ts) — the public endpoint
 * rate-limits ("Too many requests") under the bot's scan load, and a throttled getLogs read as an
 * empty result = a false "no pool". bsFetch now detects that rate-limit and retries with backoff
 * instead of returning null on the first throttle. Set RH_BLOCKSCOUT_KEY to raise the limit.
 *
 * NOT EVERY CHAIN HAS ONE. The base URL is the profile's `explorer.api`, and `explorer.kind` says
 * whether that URL actually speaks Blockscout. Arc's explorer exposes JSON-RPC (/api/eth-rpc), so
 * `${api}/api/v2/…` there isn't a REST call that comes back empty — it is a request in the WRONG
 * PROTOCOL whose 404/HTML body would parse as "no data", i.e. an empty wallet, a zero deposit, a
 * position with no mint time. So bsFetch refuses outright when kind !== "blockscout" and returns
 * null ("can't know"). chain/indexer.ts is the layer that turns that null into an RPC fallback —
 * new code should call the indexer, not this file.
 */
import { CHAIN } from "./profile.js";
import { logger } from "../util/log.js";

const log = logger("blockscout");

const BASE = CHAIN.explorer.api;
const ENABLED = CHAIN.explorer.kind === "blockscout";
const API_KEY = (process.env.RH_BLOCKSCOUT_KEY || "").trim();

/** Does this chain have a Blockscout REST API? false on Arc until the probe proves otherwise. */
export const blockscoutEnabled = (): boolean => ENABLED;

/** True if the HTTP status or response body says we were rate-limited (v1 API returns 200 + a JSON
 *  {status:"0", message:"Too many requests…"}; v2 endpoints return HTTP 429). */
const isRateLimited = (httpStatus: number, body: unknown): boolean =>
  httpStatus === 429 ||
  (!!body && typeof body === "object" && String((body as { message?: unknown }).message ?? "").toLowerCase().includes("too many"));

let warnedDisabled = false;

export async function bsFetch<T = any>(pathq: string, timeoutMs = 20_000, tries = 3): Promise<T | null> {
  if (!ENABLED) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      log.warn(`explorer chain ${CHAIN.key} bukan Blockscout (kind=${CHAIN.explorer.kind}) — fitur REST pakai fallback RPC (chain/indexer.ts).`);
    }
    return null;
  }
  const url = API_KEY ? `${BASE}${pathq}${pathq.includes("?") ? "&" : "?"}apikey=${API_KEY}` : `${BASE}${pathq}`;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const body = (await r.json().catch(() => null)) as T | null;
      if (!isRateLimited(r.status, body)) return body; // real answer (incl. a genuine empty) → done
      // else: rate-limited → back off + retry below
    } catch {
      return null; // network / TIMEOUT → fail FAST. A heavy query (e.g. full-history txlist) that times
      // out won't succeed on retry; retrying a 20s call 3× is what froze /pnl for ~60s. Retry ONLY on
      // rate-limit (transient), never on timeout.
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 400 * 2 ** i)); // 400ms · 800ms (rate-limit only)
  }
  return null;
}

export const blockscout = BASE;

/** Bounded-concurrency map — keeps us from hammering the API with N parallel requests. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!, k);
      }
    }),
  );
  return out;
}
