export type PositionPanelButton = { text: string; callback_data: string };

export function totalCloseAllPositions(v3Count: number, v4Count: number): number {
  return v3Count + v4Count;
}

/** Destructive bulk actions require an explicit second tap. */
export function closeAllConfirmationKeyboard(count: number): PositionPanelButton[][] {
  return [
    [{ text: `⚠️ Confirm close all (${count})`, callback_data: "closeall:confirm" }],
    [{ text: "Cancel", callback_data: "closeall:cancel" }],
  ];
}
