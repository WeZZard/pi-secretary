import type { BackendAction, Frame } from "./backend/backend.ts";

/**
 * Operations (design docs/arch/computer-use.md §7.2) expanded into real-input backend actions.
 * Targets are frames from the latest snapshot; an element index is never sent to the driver.
 */
export type Operation = "press" | "double_press" | "context_press" | "enter_text" | "key_combo" | "scroll_up" | "scroll_down";

export type ActuatorRequest =
  | { operation: "press" | "double_press" | "context_press" | "scroll_up" | "scroll_down"; frame: Frame }
  | { operation: "enter_text"; frame: Frame; text: string }
  | { operation: "key_combo"; keys: string };

export class ActuatorError extends Error {
  readonly code: "untypeable_text" | "invalid_keys";
  constructor(code: ActuatorError["code"], message: string) { super(message); this.name = "ActuatorError"; this.code = code; }
}

const MODIFIERS = new Map([["cmd", "cmd"], ["command", "cmd"], ["shift", "shift"], ["option", "option"], ["alt", "option"], ["ctrl", "ctrl"], ["control", "ctrl"], ["fn", "fn"]]);
const NAMED_KEYS = new Set(["return", "tab", "escape", "up", "down", "left", "right", "space", "delete", "home", "end", "pageup", "pagedown",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);
const center = (frame: Frame) => ({ x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 });

/**
 * One key press per character. The documented cua-driver key vocabulary covers letters, digits,
 * space, return and tab; other characters are refused rather than inserted through accessibility.
 */
export function keystrokesFor(text: string): BackendAction[] {
  const actions: BackendAction[] = [];
  for (const character of text) {
    if (/^[a-z0-9]$/.test(character)) actions.push({ kind: "key", key: character, modifiers: [] });
    else if (/^[A-Z]$/.test(character)) actions.push({ kind: "key", key: character.toLowerCase(), modifiers: ["shift"] });
    else if (character === " ") actions.push({ kind: "key", key: "space", modifiers: [] });
    else if (character === "\n") actions.push({ kind: "key", key: "return", modifiers: [] });
    else if (character === "\t") actions.push({ kind: "key", key: "tab", modifiers: [] });
    else throw new ActuatorError("untypeable_text", `The character ${JSON.stringify(character)} cannot be typed with real key presses by this backend.`);
  }
  return actions;
}

export function parseKeyCombo(keys: string): BackendAction {
  const parts = keys.toLowerCase().split("+").map(part => part.trim()).filter(Boolean);
  const key = parts.pop();
  const modifiers = parts.map(part => MODIFIERS.get(part));
  if (!key || modifiers.some(modifier => modifier === undefined) || !(NAMED_KEYS.has(key) || /^[a-z0-9]$/.test(key))) {
    throw new ActuatorError("invalid_keys", `${JSON.stringify(keys)} is not a key combination such as cmd+shift+n.`);
  }
  return { kind: "key", key, modifiers: modifiers as string[] };
}

export function actionsFor(request: ActuatorRequest): BackendAction[] {
  switch (request.operation) {
    case "press": return [{ kind: "click", point: center(request.frame), button: "left", count: 1 }];
    case "double_press": return [{ kind: "click", point: center(request.frame), button: "left", count: 2 }];
    case "context_press": return [{ kind: "click", point: center(request.frame), button: "right", count: 1 }];
    case "scroll_up": case "scroll_down":
      return [{ kind: "scroll", point: center(request.frame), direction: request.operation === "scroll_up" ? "up" : "down", by: "page",
        extent: request.frame.h }];
    case "key_combo": return [parseKeyCombo(request.keys)];
    case "enter_text": {
      // Validate the whole literal before any input, so a refused character never leaves partial text.
      const keys = keystrokesFor(request.text);
      return [{ kind: "click", point: center(request.frame), button: "left", count: 1 }, ...keys];
    }
  }
}
