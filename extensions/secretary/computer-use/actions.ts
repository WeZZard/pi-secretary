/**
 * The closed action allowlist of each platform (design docs/arch/computer-use.md §7.2, decision
 * PS-D7). The planner sees each definition in the tool schema, and the grounder's operation
 * question offers the same definitions, so both read one text. Each action is sent as named:
 * an input-event action as input events, an accessibility action through the UI element's
 * accessibility functions (decision PS-D39).
 */

export type Action = "click" | "double_click" | "right_click" | "type" | "key" | "scroll_up" | "scroll_down"
  | "ax_press" | "ax_show_menu" | "ax_set_value";

export interface AllowlistEntry {
  name: Action;
  /** What the action does, as the planner and the grounder read it. */
  definition: string;
  /** The input the executor sends, for readers of the code and the design. */
  hostInput: string;
}

export const MACOS_ACTIONS: readonly AllowlistEntry[] = [
  { name: "click", definition: "Input events: click the UI element once with the left button.", hostInput: "A left click at the UI element's frame centre." },
  { name: "double_click", definition: "Input events: click the UI element twice quickly, for example to open a file.", hostInput: "Two left clicks at the UI element's frame centre." },
  { name: "right_click", definition: "Input events: click the UI element with the right button to open its context menu.", hostInput: "A right click at the UI element's frame centre." },
  { name: "type", definition: "Input events: click the text field and type the step's text.", hostInput: "A click on the UI element, then one key event per character, after the position keys." },
  { name: "key", definition: "Input events: press the step's key or key combination, such as return or cmd+down; no UI element is needed.", hostInput: "Key events to the frontmost window." },
  { name: "scroll_up", definition: "Input events: scroll the chosen region up by one page.", hostInput: "A scroll-wheel event at the centre of the region's visible frame." },
  { name: "scroll_down", definition: "Input events: scroll the chosen region down by one page, to reveal UI elements below the visible part.", hostInput: "A scroll-wheel event at the centre of the region's visible frame." },
  { name: "ax_press", definition: "Accessibility action: perform the UI element's press action, with no pointer event.", hostInput: "The driver's click with the UI element's element_index." },
  { name: "ax_show_menu", definition: "Accessibility action: show the UI element's context menu through its show-menu action, with no pointer event.", hostInput: "The driver's right_click with the UI element's element_index." },
  { name: "ax_set_value", definition: "Accessibility action: set the text field's value so that it holds the step's text, with no key events.", hostInput: "The driver's set_value with the UI element's element_index." },
];

export const ACTION_NAMES = MACOS_ACTIONS.map(entry => entry.name);
export const DEFINITIONS = Object.fromEntries(MACOS_ACTIONS.map(entry => [entry.name, entry.definition])) as Record<Action, string>;

/** Design §7.2: the actions carried out through the UI element's accessibility functions. */
export const isAccessibilityAction = (action: string | undefined) => action === "ax_press" || action === "ax_show_menu" || action === "ax_set_value";

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
