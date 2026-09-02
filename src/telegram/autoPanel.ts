export type AutoPanelButton = { text: string; callback_data: string };

export interface AutoPanelState {
  enabled: boolean;
  mode: "single" | "inrange";
  sources: string[];
  tpPct: number;
  slPct: number;
  closeOor: boolean;
}

/** Main Auto-LP controls. Keep labels plain-English; details live in the submenus. */
export function autoPanelKeyboard(a: AutoPanelState): AutoPanelButton[][] {
  return [
    [{ text: a.enabled ? "⏹ Disable Auto-LP" : "▶️ Enable Auto-LP", callback_data: a.enabled ? "auto:disable" : "auto:enable:ask" }],
    [
      { text: "💰 Entry settings", callback_data: "auto:entry" },
      { text: "🛡 Position limits", callback_data: "auto:limits" },
    ],
    [
      { text: "🎯 Entry mode", callback_data: "auto:mode" },
      { text: "🔎 Candidate sources", callback_data: "auto:sources" },
    ],
    [{ text: "📉 Exit rules", callback_data: "auto:exits" }],
    [{ text: "🔄 Refresh", callback_data: "auto:refresh" }],
  ];
}

export function autoBackButton(): AutoPanelButton[] {
  return [{ text: "◀️ Back to Auto-LP", callback_data: "auto:refresh" }];
}
