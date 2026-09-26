/**
 * The closed action allowlist of each platform (design docs/arch/computer-use.md §7.2, decision
 * PS-D7). The planner sees each definition in the tool schema, and the executor's operation
 * question offers the same definitions, so both read one text.
 */

export type Action = "click" | "double_click" | "right_click" | "type" | "key" | "scroll_up" | "scroll_down";

export interface AllowlistEntry {
  name: Action;
  /** What the action does, as the planner and the executor read it. */
  definition: string;
  /** The input the harness sends, for readers of the code and the design. */
  hostInput: string;
}

export const MACOS_ACTIONS: readonly AllowlistEntry[] = [
  { name: "click", definition: "Click the control once with the left button.", hostInput: "A left click at the element's frame centre." },
  { name: "double_click", definition: "Click the control twice quickly, for example to open a file.", hostInput: "Two left clicks at the element's frame centre." },
  { name: "right_click", definition: "Click the control with the right button to open its context menu.", hostInput: "A right click at the element's frame centre." },
  { name: "type", definition: "Click the text field and type the step's text.", hostInput: "A click on the control, then one key event per character, after the position keys." },
  { name: "key", definition: "Press the step's key or key combination, such as return or cmd+down; no control is needed.", hostInput: "Key events to the frontmost window." },
  { name: "scroll_up", definition: "Scroll the chosen region up by one page.", hostInput: "A scroll-wheel event at the centre of the region's visible frame." },
  { name: "scroll_down", definition: "Scroll the chosen region down by one page, to reveal controls below the visible part.", hostInput: "A scroll-wheel event at the centre of the region's visible frame." },
];

export const ACTION_NAMES = MACOS_ACTIONS.map(entry => entry.name);
export const DEFINITIONS = Object.fromEntries(MACOS_ACTIONS.map(entry => [entry.name, entry.definition])) as Record<Action, string>;

/** Names used before the allowlist (2026-09-26), still accepted from planners and recorded plans. */
export const ACTION_ALIASES: Readonly<Record<string, Action>> = {
  press: "click", double_press: "double_click", context_press: "right_click", enter_text: "type", key_combo: "key",
};

export const isScroll = (action: string | undefined) => action === "scroll_up" || action === "scroll_down";

/** The allowlist name for a name or alias, or undefined for anything else. */
export function toAction(name: string | undefined): Action | undefined {
  if (name === undefined) return undefined;
  return (ACTION_NAMES as string[]).includes(name) ? name as Action : ACTION_ALIASES[name];
}
