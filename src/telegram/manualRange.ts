/** Width controls for manual LP entry. Auto means the configured bot default. */
export const MANUAL_RANGE_PRESETS = [10, 25, 50, 100, 200] as const;
export const MIN_MANUAL_RANGE_PCT = 1;
export const MAX_MANUAL_RANGE_PCT = 1000;

export function normalizeManualRangePct(text: string): number | null {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value < MIN_MANUAL_RANGE_PCT || value > MAX_MANUAL_RANGE_PCT) return null;
  return Math.round(value * 100) / 100;
}
