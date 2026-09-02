/** Telegram-specific rendering: HTML escaping, monospace blocks, padding, per-token emoji. */

/** Escape for Telegram HTML (token symbols can contain < > &). */
export const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Monospace block. Contents MUST be escaped. */
export const pre = (s: string): string => `<pre>${esc(s)}</pre>`;

/** Pad right/left. NEVER truncates — padL(9) once turned "$49.21/jam" into "$49.21/ja". */
export const padR = (s: unknown, n: number): string => {
  const str = String(s);
  return str.length >= n ? str : str + " ".repeat(n - str.length);
};
export const padL = (s: unknown, n: number): string => {
  const str = String(s);
  return str.length >= n ? str : " ".repeat(n - str.length) + str;
};

/** Signed number: "+1.23" / "-0.50". */
export const sg = (n: number, d: number): string => (n >= 0 ? "+" : "") + n.toFixed(d);

/** Signed USD: "+$12.30" / "-$4.00". */
export const money = (v: number): string => (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);

/** Compact visual range for Telegram's monospace position view. */
export function rangeBins(tick: number, tickLower: number, tickUpper: number, count = 18): string {
  const lo = Math.min(tickLower, tickUpper);
  const hi = Math.max(tickLower, tickUpper);
  const n = Math.max(6, Math.min(24, Math.floor(count)));
  if (![tick, lo, hi].every(Number.isFinite) || hi <= lo) return "—";
  if (tick < lo) return "◀" + "🟦".repeat(n);
  if (tick >= hi) return "🟦".repeat(n) + "▶";
  const at = Math.min(n - 1, Math.max(0, Math.floor(((tick - lo) / (hi - lo)) * n)));
  return Array.from({ length: n }, (_, i) => (i < at ? "🟩" : i === at ? "🔹" : "🟦")).join("");
}

/**
 * Stable per-symbol emoji. Telegram button labels are text+emoji only (no real logos), so
 * we hash the symbol into a fixed palette — same token, same emoji, every session.
 */
const EMOJI = [
  "🐻", "🐸", "🐶", "🐱", "🦊", "🐵", "🦁", "🐯", "🐼", "🐨", "🐷", "🐮", "🐔", "🦄", "🐉", "🦋",
  "🍕", "🍔", "🌮", "🍩", "🍪", "🍧", "🍺", "☕", "🍄", "🌶", "🥑", "🍌", "🍉", "🥕",
  "🚀", "🛸", "⚡", "🔥", "💎", "🌙", "⭐", "🎩", "🎲", "🎯", "🧊", "🪙", "👾", "🤖", "👽", "🦴",
];
export function tokenEmoji(sym: string): string {
  let h = 0;
  for (const ch of String(sym || "?")) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return EMOJI[h % EMOJI.length]!;
}
