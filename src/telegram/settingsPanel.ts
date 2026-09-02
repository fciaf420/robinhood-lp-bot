export type SettingsButton = { text: string; callback_data: string };

/** Plain-English top-level settings navigation. */
export function settingsPanelKeyboard(): SettingsButton[][] {
  return [
    [
      { text: "📐 LP settings", callback_data: "settings:lp" },
      { text: "⛽ Gas target", callback_data: "settings:gas" },
    ],
    [
      { text: "🧠 Radar & GMGN", callback_data: "settings:radar" },
      { text: "📡 Feed settings", callback_data: "settings:feed" },
    ],
    [
      { text: "🤖 Auto-LP panel", callback_data: "settings:auto" },
      { text: "🎯 Hunter settings", callback_data: "settings:hunt" },
    ],
    [{ text: "👁 Watch settings", callback_data: "settings:watch" }],
    [{ text: "🔄 Refresh", callback_data: "settings:refresh" }],
  ];
}
