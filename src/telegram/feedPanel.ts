export type FeedPanelState = {
  enabled: boolean;
  newToken: boolean;
  positionMonitor: boolean;
  autoCloseOutOfRange: boolean;
  radar: boolean;
};

export type FeedPanelButton = { text: string; callback_data: string };

/** Inline controls for the real-time feed status panel. */
export function feedPanelKeyboard(state: FeedPanelState): FeedPanelButton[][] {
  return [
    [{ text: state.enabled ? "⏹ Stop feed" : "▶️ Start feed", callback_data: state.enabled ? "feed:off" : "feed:on" }],
    [{ text: `🆕 New-token alerts: ${state.newToken ? "ON" : "OFF"}`, callback_data: "feed:toggle:newtoken" }],
    [{ text: `👁 Position monitoring: ${state.positionMonitor ? "ON" : "OFF"}`, callback_data: "feed:toggle:posmon" }],
    [{ text: `🤖 Radar scoring: ${state.radar ? "ON" : "OFF"}`, callback_data: "feed:toggle:radar" }],
    [{ text: state.autoCloseOutOfRange ? "⚠️ Auto-close OOR: ON" : "⚠️ Auto-close OOR: OFF", callback_data: "feed:toggle:autoclose" }],
    [{ text: "🔄 Refresh", callback_data: "feed:refresh" }],
  ];
}

export function feedAutoCloseConfirmKeyboard(): FeedPanelButton[][] {
  return [
    [{ text: "⚠️ Enable auto-close", callback_data: "feed:autoclose:yes" }],
    [{ text: "Cancel", callback_data: "feed:refresh" }],
  ];
}
