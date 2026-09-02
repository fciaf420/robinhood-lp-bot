/** Merge user-tuned runtime settings over the committed safe baseline. */

const MERGED_SECTIONS = ["contracts", "lp", "watch", "feed", "radar", "autoLp", "scan"] as const;

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
