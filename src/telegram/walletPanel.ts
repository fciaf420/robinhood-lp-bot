export type WalletPanelButton = { text: string; callback_data: string };

/** Inline actions shown with the wallet balances. */
export function walletKeyboard(): WalletPanelButton[][] {
  return [[{ text: "🔓 Unwrap all WETH → ETH", callback_data: "unwrap:ask" }]];
}

/** Explicit confirmation is required because this broadcasts a real wallet transaction. */
export function unwrapConfirmationKeyboard(): WalletPanelButton[][] {
  return [[{ text: "✅ Confirm unwrap", callback_data: "unwrap:confirm" }, { text: "Cancel", callback_data: "unwrap:cancel" }]];
}
