/** Keep rendered screen output safely below Telegram's 4,096-character message limit. */
export function screenDisplayCount(total: number, withLlm: boolean): number {
  return Math.min(total, withLlm ? 8 : 12);
}
