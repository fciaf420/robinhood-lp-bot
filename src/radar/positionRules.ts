/** Per-position exit overrides for positions opened manually or by Auto-LP. */
import { dataPath, readJson, writeJson } from "../util/files.js";

export type PositionRuleKind = "tp" | "sl";
export type PositionExitRule = { tpPct?: number; slPct?: number };

const FILE = dataPath("position-exit-rules.json");

function load(): Record<string, PositionExitRule> {
  return readJson<Record<string, PositionExitRule>>(FILE, {});
}

function save(rules: Record<string, PositionExitRule>): void {
  writeJson(FILE, rules);
}

export function getPositionExitRule(tokenId: string): PositionExitRule | null {
  const rule = load()[String(tokenId)];
  return rule && (Object.prototype.hasOwnProperty.call(rule, "tpPct") || Object.prototype.hasOwnProperty.call(rule, "slPct")) ? rule : null;
}

/** Set a position-specific percentage. A value of 0 explicitly turns that trigger off. */
export function setPositionExitRule(tokenId: string, kind: PositionRuleKind, value: number): PositionExitRule {
  const rules = load();
  const id = String(tokenId);
  const next = { ...(rules[id] ?? {}) };
  next[kind === "tp" ? "tpPct" : "slPct"] = value;
  rules[id] = next;
  save(rules);
  return next;
}

/** Remove one override so that trigger inherits the global Auto-LP setting. */
export function clearPositionExitRule(tokenId: string, kind: PositionRuleKind): PositionExitRule | null {
  const rules = load();
  const id = String(tokenId);
  const next = { ...(rules[id] ?? {}) };
  delete next[kind === "tp" ? "tpPct" : "slPct"];
  if (Object.keys(next).length) rules[id] = next;
  else delete rules[id];
  save(rules);
  return Object.keys(next).length ? next : null;
}

/** True when at least one stored position override can actually close a position. */
export function hasActivePositionExitRules(): boolean {
  return Object.values(load()).some((r) => (r.tpPct ?? 0) > 0 || (r.slPct ?? 0) > 0);
}
