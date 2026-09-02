/**
 * Persistent bottom menu (Telegram reply keyboard) so common actions are one tap away —
 * no scrolling. Buttons send their label as text; resolveMenu() maps the label back to a
 * command before routing.
 */

export const MENU_KEYBOARD = {
  keyboard: [
    ["📋 Positions", "📒 Ledger", "💰 PnL"],
    ["🧪 Screen", "🔍 Scan", "📸 Card"],
    ["🔄 Swap", "📡 Feed", "👁 Watch"],
    ["🤖 Auto", "👛 Wallet", "⚙️ Settings"],
    ["🗑 Close All", "💸 Sell", "❔ Help"],
    ["🔒 Revoke"],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const MENU_MAP: Record<string, string> = {
  "📋 Positions": "/list",
  "📒 Ledger": "/ledger",
  "💰 PnL": "/pnl",
  "📡 Feed": "/feed",
  "👁 Watch": "/watch",
  "🤖 Auto": "/auto",
  "🧪 Screen": "/screen",
  "🔍 Scan": "/scan",
  "📸 Card": "/card",
  "🔄 Swap": "/swap",
  "👛 Wallet": "/wallet",
  "⚙️ Settings": "/settings",
  "⚙️ Setting": "/settings",
  "🗑 Close All": "/closeall",
  "💸 Sell": "/sell",
  "❔ Help": "/help",
  "🔒 Revoke": "/revoke",
};

/** Menu label → command, or the text unchanged. */
export function resolveMenu(text: string): string {
  return MENU_MAP[text] ?? text;
}
