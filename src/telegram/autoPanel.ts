export type AutoPanelButton = { text: string; callback_data: string };
export type AutoAction = "ape" | "watch" | "skip";

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

export interface AutoEntryState {
  sizeEth: number;
  minScore: number;
  minLiqUsd: number;
  maxTaxPct: number;
  requireAction: AutoAction;
  requireLlm: boolean;
  requireGmgn: boolean;
}

/** Detailed entry filters. Each button maps to a real Auto-LP gate or a custom prompt. */
export function autoEntryButtons(a: AutoEntryState): AutoPanelButton[] {
  return [
    ...[0.001, 0.002, 0.005].map((v) => ({ text: `${v} ETH${a.sizeEth === v ? " ✓" : ""}`, callback_data: `auto:size:${v}` })),
    { text: `Size ${a.sizeEth} ETH · custom`, callback_data: "auto:size:custom" },
    ...[55, 65, 75, 85].map((v) => ({ text: `Score ≥ ${v}${a.minScore === v ? " ✓" : ""}`, callback_data: `auto:score:${v}` })),
    { text: `Score ≥ ${a.minScore} · custom`, callback_data: "auto:score:custom" },
    ...[5_000, 20_000, 50_000].map((v) => ({ text: `Liquidity ≥ $${v / 1000}k${a.minLiqUsd === v ? " ✓" : ""}`, callback_data: `auto:minliq:${v}` })),
    { text: `Liquidity ≥ $${a.minLiqUsd} · custom`, callback_data: "auto:minliq:custom" },
    ...[0, 2, 5, 10].map((v) => ({ text: `Max tax ${v}%${a.maxTaxPct === v ? " ✓" : ""}`, callback_data: `auto:maxtax:${v}` })),
    { text: `Max tax ${a.maxTaxPct}% · custom`, callback_data: "auto:maxtax:custom" },
    { text: `Trigger: APE only${a.requireAction === "ape" ? " ✓" : ""}`, callback_data: "auto:action:ape" },
    { text: `Trigger: APE or WATCH${a.requireAction === "watch" ? " ✓" : ""}`, callback_data: "auto:action:watch" },
    { text: `Trigger: any verdict${a.requireAction === "skip" ? " ✓" : ""}`, callback_data: "auto:action:skip" },
    { text: `${a.requireLlm ? "✅" : "⬜"} Require trusted LLM verdict`, callback_data: "auto:require:llm" },
    { text: `${a.requireGmgn ? "✅" : "⬜"} Require GMGN safety data`, callback_data: "auto:require:gmgn" },
  ];
}

export interface AutoAdvancedState {
  compound: boolean;
  compoundMinUsd: number;
  volFadeX: number;
  vfadeMinAgeMin: number;
  minFeePerHourUsd: number;
  feeGraceMin: number;
}

export function autoAdvancedButtons(a: AutoAdvancedState): AutoPanelButton[] {
  return [
    { text: `Compound fees: ${a.compound ? "on" : "off"}`, callback_data: "auto:compound:toggle" },
    { text: `Compound minimum: $${a.compoundMinUsd}`, callback_data: "auto:compound:min" },
    { text: `Volume fade: ${a.volFadeX > 0 ? a.volFadeX + "×" : "off"}`, callback_data: "auto:advanced:vol" },
    { text: `Volume-fade minimum age: ${a.vfadeMinAgeMin}m`, callback_data: "auto:vfade:age" },
    { text: `Fee-rate exit: ${a.minFeePerHourUsd > 0 ? "$" + a.minFeePerHourUsd + "/h" : "off"}`, callback_data: "auto:advanced:fee" },
    { text: `Fee-rate minimum age: ${a.feeGraceMin}m`, callback_data: "auto:fee:age" },
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
