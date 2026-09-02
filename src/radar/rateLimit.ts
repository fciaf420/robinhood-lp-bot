const DEFAULT_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;
let blockedUntil = 0;

export function retryAfterMs(header: string | null, fallbackMs = DEFAULT_RETRY_MS, maxMs = MAX_RETRY_MS): number {
  if (header == null || header.trim() === "") return Math.min(fallbackMs, maxMs);
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, maxMs);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), maxMs);
  return Math.min(fallbackMs, maxMs);
}

export function noteRateLimit(header: string | null, now = Date.now()): number {
  const wait = retryAfterMs(header);
  blockedUntil = Math.max(blockedUntil, now + wait);
  return wait;
}

export function isRateLimited(now = Date.now()): boolean {
  return now < blockedUntil;
}

export function clearRateLimit(): void {
  blockedUntil = 0;
}
