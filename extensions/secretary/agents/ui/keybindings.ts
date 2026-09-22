import { matchesKey } from "@earendil-works/pi-tui";

/**
 * Inspector-level keybinding actions (architecture §12.6.5): the upstream action set minus the
 * plugin and prompt-audit actions. Prompt interactions (composer Enter/Escape) keep fixed keys.
 */
export const INSPECTOR_ACTIONS = [
  "close", "scrollUp", "scrollDown", "selectUp", "selectDown", "selectFirst", "selectLast",
  "pageUp", "pageDown", "refresh", "steer", "stop", "toggleTools", "drillIn", "drillOut", "toggleFinished",
] as const;
export type InspectorAction = (typeof INSPECTOR_ACTIONS)[number];
export type InspectorKeybindingsConfig = Partial<Record<InspectorAction, string[]>>;
export type ResolvedInspectorKeybindings = Record<InspectorAction, readonly string[]>;

/** Upstream defaults for the ported actions (v0.68.0 baseline). */
export const DEFAULT_INSPECTOR_KEYBINDINGS: ResolvedInspectorKeybindings = {
  close: ["escape", "ctrl+c", "q"],
  scrollUp: ["shift+k"],
  scrollDown: ["shift+j"],
  selectUp: ["up", "k"],
  selectDown: ["down", "j"],
  selectFirst: ["home"],
  selectLast: ["end"],
  pageUp: ["pageUp"],
  pageDown: ["pageDown"],
  refresh: ["r", "shift+r"],
  steer: ["s"],
  stop: ["shift+x", "x", "shift+d"],
  toggleTools: ["o", "ctrl+o"],
  drillIn: ["return", "right"],
  drillOut: ["left"],
  toggleFinished: ["a"],
};

export const matchesStopSelected = (data: string): boolean => matchesKey(data, "x") || matchesKey(data, "shift+x");
export const matchesStopAll = (data: string): boolean => matchesKey(data, "ctrl+x");
export const CANCELLATION_HINT = "X stop selected · Ctrl+X stop all";
/** The editor-focused hint while Down enters the indicator. */
export const FOCUS_HINT = "↓ to focus a subagent · Ctrl+X stop all";
/** The editor-focused hint while the caret still has a line below and Down moves it (§2.2). */
export const MOVE_HINT = "↓ to move down · Ctrl+X stop all";

export function resolveInspectorKeybindings(config?: InspectorKeybindingsConfig): ResolvedInspectorKeybindings {
  return Object.fromEntries(INSPECTOR_ACTIONS.map(action => [action, config?.[action] ?? DEFAULT_INSPECTOR_KEYBINDINGS[action]])) as ResolvedInspectorKeybindings;
}

/** Validate a configuration object; unknown actions and malformed bindings fail validation. */
export function validateInspectorKeybindings(value: unknown, label: string): InspectorKeybindingsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result: InspectorKeybindingsConfig = {};
  for (const [action, bindings] of Object.entries(value)) {
    if (!(INSPECTOR_ACTIONS as readonly string[]).includes(action)) throw new Error(`${label}.${action} is not a supported inspector action`);
    if (!Array.isArray(bindings) || !bindings.length || bindings.some(binding => typeof binding !== "string" || !binding.trim())) {
      throw new Error(`${label}.${action} must be a non-empty array of key strings`);
    }
    if (bindings.some(binding => binding.toLowerCase() === "ctrl+x" || (action !== "stop" && ["x", "shift+x"].includes(binding.toLowerCase())))) {
      throw new Error(`${label}.${action} conflicts with the reserved X selected / Ctrl+X fleet cancellation shortcuts`);
    }
    result[action as InspectorAction] = bindings;
  }
  return result;
}

export function matchesInspectorAction(data: string, bindings: ResolvedInspectorKeybindings, action: InspectorAction): boolean {
  return bindings[action].some(binding => {
    try { return matchesKey(data, binding as Parameters<typeof matchesKey>[1]); } catch { return data === binding; }
  });
}

const LABELS: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", escape: "Esc", return: "Enter", enter: "Enter", pageUp: "PgUp", pageDown: "PgDn", home: "Home", end: "End" };

/** The rendered hint for an action; the footer always reflects the resolved keys. */
export function bindingLabel(bindings: ResolvedInspectorKeybindings, action: InspectorAction, options: { firstOnly?: boolean } = {}): string {
  const labels = bindings[action].map(binding => {
    if (/^shift\+[a-z]$/.test(binding)) return binding.slice(6).toUpperCase();
    if (/^ctrl\+[a-z]$/.test(binding)) return `Ctrl+${binding.slice(5).toUpperCase()}`;
    return LABELS[binding] ?? binding;
  });
  return (options.firstOnly ? labels.slice(0, 1) : labels).join("/");
}
