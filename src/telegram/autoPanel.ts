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

/** Percentage choices for the TP/SL submenu, including a free-form value prompt. */
export function exitRuleKeyboard(kind: "tp" | "sl", current: number): AutoPanelButton[][] {
  const values = kind === "tp" ? [0, 50, 100, 200] : [0, 25, 50];
  const custom = current > 0 && !values.includes(current) ? `Custom percentage (${current}%) ✓` : "Custom percentage";
  return [
    ...values.map((value) => [{
      text: value === 0 ? "Off" : `${kind === "tp" ? "+" : "-"}${value}%${current === value ? " ✓" : ""}`,
      callback_data: `auto:${kind}:${value}`,
    }]),
    [{ text: custom, callback_data: `auto:${kind}:custom` }],
  ];
}
