export type FastQuote = "eth" | "usd";

export type FastPresetButton = {
  text: string;
  callback_data: string;
};

export const FAST_PRESET_AMOUNTS = ["0.1", "0.05", "0.01"] as const;

export function isFastPresetAmount(value: string): boolean {
  return (FAST_PRESET_AMOUNTS as readonly string[]).includes(value);
}

export function fastMintCallback(version: "v3" | "v4", quote: FastQuote): string {
  if (version === "v4") return quote === "usd" ? "mint:v4us" : "mint:v4";
  return quote === "usd" ? "mint:v3us" : "mint:single";
}

function widthLabel(widthPct: number): string {
  return Number.isInteger(widthPct) ? String(widthPct) : String(Number(widthPct.toFixed(2)));
}

/** Build the fixed, gas-safe single-side buttons shown after a pool is selected. */
export function fastSingleSideButtons({
  quote,
  availableEth,
  widthPct,
}: {
  quote: FastQuote;
  availableEth?: number;
  widthPct: number;
}): FastPresetButton[][] {
  const amounts = FAST_PRESET_AMOUNTS.filter((amount) => availableEth == null || Number(amount) <= availableEth + 1e-9);
  const side = quote === "usd" ? "Single-side USDG" : "Single-side ETH";
  const range = `Auto ${widthLabel(widthPct)}%`;
  return amounts.map((amount) => [{ text: `⚡ ${amount} ETH · ${side} · ${range}`, callback_data: `fast:${amount}` }]);
}
