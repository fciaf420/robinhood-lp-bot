/**
 * ETH/USD spot with a 60s cache and multi-source fallback (survives one API blocking).
 *
 * This is ETHER's price and nothing else. It is NOT the price of "the native currency": on Arc
 * the gas token is USDC, and quoting a position against ether there would be nonsense (and a
 * dead API call that returns 0 on failure → every valuation silently zeroed). Every LP / PnL /
 * sizing path therefore goes through `nativeUsd()` in currency.ts, which returns this on a chain
 * whose native is ether and the constant 1 on a chain whose native is a dollar stable. Keep
 * calling ethUsd() directly ONLY for things genuinely denominated in ether.
 */

let cache = { v: 0, at: 0 };

const SOURCES: Array<[string, (j: any) => number]> = [
  [
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    (j) => j.ethereum?.usd,
  ],
  [
    "https://coins.llama.fi/prices/current/coingecko:ethereum",
    (j) => j.coins?.["coingecko:ethereum"]?.price,
  ],
  ["https://api.coinbase.com/v2/prices/ETH-USD/spot", (j) => Number(j.data?.amount)],
];

export async function ethUsd(): Promise<number> {
  if (cache.v && Date.now() - cache.at < 60_000) return cache.v;
  for (const [url, pick] of SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const p = Number(pick(await res.json()));
      if (p > 0) {
        cache = { v: p, at: Date.now() };
        return p;
      }
    } catch {
      /* try next source */
    }
  }
  return cache.v || 0; // last known, or 0
}
