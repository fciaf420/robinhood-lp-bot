export type WalletPanelButton = { text: string; callback_data: string };

export interface WalletDisplayBalances {
  address: string;
  eth: string;
  weth: string;
  usdg: string;
  totalUsd: number | null;
}

export function walletBalanceText(b: WalletDisplayBalances, includeHelp = true): string {
  const total = b.totalUsd == null ? "n/a" : `$${b.totalUsd.toFixed(2)}`;
  return [
    `👛 <code>${b.address}</code>`,
    `ETH: ${Number(b.eth).toFixed(5)} · WETH: ${Number(b.weth).toFixed(5)}`,
    `USDG: $${Number(b.usdg).toFixed(2)}`,
    `Total wallet: <b>${total}</b>`,
    includeHelp ? `\n<i>Use the buttons below to swap wallet USDG → ETH or unwrap WETH → ETH.</i>` : "",
  ].filter(Boolean).join("\n");
}

/** Inline actions shown with the wallet balances. */
export function walletKeyboard(): WalletPanelButton[][] {
  return [
    [{ text: "💱 Swap USDG → ETH", callback_data: "wallet:usdg" }],
    [{ text: "🔓 Unwrap all WETH → ETH", callback_data: "unwrap:ask" }],
  ];
}

/** Explicit confirmation is required because this broadcasts a real wallet transaction. */
export function unwrapConfirmationKeyboard(): WalletPanelButton[][] {
  return [[{ text: "✅ Confirm unwrap", callback_data: "unwrap:confirm" }, { text: "Cancel", callback_data: "unwrap:cancel" }]];
}
