/** Merge user-tuned runtime settings over the committed safe baseline. */

const MERGED_SECTIONS = ["contracts", "lp", "watch", "feed", "radar", "autoLp", "scan"] as const;

/** Upgrade the old default hunter ceiling so persisted Railway settings get the new 10% behavior. */
export function migrateRuntimeConfig<T extends Record<string, any>>(runtime: Partial<T> | null | undefined): Partial<T> | null | undefined {
  if (!runtime || typeof runtime !== "object") return runtime;
  const scan = runtime.scan;
  if (scan && typeof scan === "object" && scan.feeMaxPpm === 50_000) {
    return { ...runtime, scan: { ...scan, feeMaxPpm: 100_000 } } as Partial<T>;
  }
  return runtime;
}

export function mergeRuntimeConfig<T extends Record<string, any>>(baseline: T, runtime: Partial<T> | null | undefined): T {
  if (!runtime || typeof runtime !== "object") return baseline;
  const merged: Record<string, any> = { ...baseline, ...runtime };
  for (const section of MERGED_SECTIONS) {
    const baseValue = baseline[section];
    const runtimeValue = runtime[section];
    if (baseValue && typeof baseValue === "object" && runtimeValue && typeof runtimeValue === "object") {
      merged[section] = { ...baseValue, ...runtimeValue };
    }
  }
  return merged as T;
}
