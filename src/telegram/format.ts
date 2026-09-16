/**
 * Telegram-specific rendering: HTML escaping, monospace blocks, padding, per-token emoji,
 * and the CHAIN-AWARE currency labels every message in src/telegram/ prints.
 *
 * Why the labels live here and not in chain/currency.ts: they are a DISPLAY decision, not a money
 * one. "Ξ" is the ether glyph — it is correct on Robinhood and a lie anywhere else, so it is chosen
 * from the profile's native symbol here, while the maths stays in chain/currency.ts. This module
 * deliberately imports only chain/profile.ts (fs + zod, no provider, no wallet) so calendar.ts and
 * the card renderer can label a chain without pulling the RPC client in.
 */
import { CHAIN, stableQuote } from "../chain/profile.js";

/**
 * Chain display name — "Robinhood Chain" / "Arc". Printed wherever two bots could be confused.
 *
 * radar/openrouter.ts has chainLabel(), which reads the same `CHAIN.name`. They are NOT a
 * duplicated implementation and must not be merged: this one is escaped into Telegram HTML, that
 * one is spliced into an LLM system prompt, and radar/ sits BELOW telegram/ in the import graph,
 * so making either depend on the other trades a shared const for a layering inversion. The single
 * source of truth is the profile field itself — if you need a third spelling, read CHAIN.name.
 */
export const CHAIN_NAME = CHAIN.name;
/** Native (gas) currency symbol: "ETH" on Robinhood, "USDC" on Arc. */
export const NAT_SYM = CHAIN.native.symbol;
/** The dollar quote asset LP pairs against: "USDG" on Robinhood, the 6-dec "USDC" on Arc. */
export const STABLE_SYM = stableQuote().symbol;
/** Wrapped-native symbol, or the native one where no WETH9 exists (Arc) — for "TOKEN/xxx" names. */
export const WRAP_SYM = CHAIN.quotes.find((q) => q.class === "eth")?.symbol ?? NAT_SYM;
/**
 * Suffix after a native amount inside the monospace tables ("0.001234Ξ").
 * Ξ ONLY means ether, so any other native currency prints its symbol with a separating space
 * instead — "1.250000 USDC". padL/padR never truncate, so the wider tag just widens the column.
 */
export const NAT_TAG = NAT_SYM === "ETH" ? "Ξ" : ` ${NAT_SYM}`;
/** true when the native currency is a dollar (Arc) → "· ETH $3200" headers are noise, drop them. */
export const NAT_IS_USD = CHAIN.native.stable;
/** Which aggregator/venue the buy-side actually routes through, for the copy that names it. */
export const ROUTER_LABEL = CHAIN.data.router === "kyber" ? "Kyber" : "Uniswap";

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
