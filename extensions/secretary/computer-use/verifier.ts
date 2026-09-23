import type { RawElement, WindowRead } from "./backend/backend.ts";
import { BIDI_MARKS } from "./observer.ts";

/**
 * Postconditions (design docs/arch/computer-use.md §5.3). Code evaluates them against a fresh
 * tree; the executor never judges them. Only on-screen elements count: a closed menu's items
 * are in the tree without frames, so `exists "Save"` would otherwise always hold.
 *
 * The design's `focused` predicate is not supported: cua-driver 0.12.6 reports no focus state.
 */
export type Postcondition =
  | { exists: { name: string; role?: string } }
  | { absent: { name: string; role?: string } }
  | { value: { name: string; equals: string } }
  | { selected: { name: string } }
  | { window: { titleContains: string } }
  | { text: { contains: string } | { endsWith: string } }
  | { changed: true }
  | { all: Postcondition[] }
  | { any: Postcondition[] };

export interface Evaluation { holds: boolean; detail: string }

const MAX_DEPTH = 8;
/** An accessibility role, with or without the AX prefix. */
const ROLE = /^(AX)?[A-Z][A-Za-z]*$/;
const normalize = (text: string) => text.replace(BIDI_MARKS, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The elements a person could see: a frame larger than 1 point, and a center inside the window
 * unless the element belongs to a menu. This is the observer's rule (design §6.1). A frame-only
 * rule counted a Finder icon scrolled 140 points above the window as on screen (observed 2026-09-23).
 */
function visibleElements(read: WindowRead): RawElement[] {
  const byIndex = new Map(read.elements.map(element => [element.element_index, element]));
  const windowFrame = read.elements.find(element => element.role === "AXWindow")?.frame;
  const underMenu = (element: RawElement) => {
    for (let parent = byIndex.get(element.parent_index ?? -1), depth = 0; parent && depth < 64; parent = byIndex.get(parent.parent_index ?? -1), depth++) {
      if (parent.role === "AXMenu" || parent.role === "AXMenuBar") return true;
    }
    return false;
  };
  return read.elements.filter(element => {
    const frame = element.frame;
    if (!frame || frame.w <= 1 || frame.h <= 1) return false;
    if (!windowFrame || underMenu(element)) return true;
    const cx = frame.x + frame.w / 2, cy = frame.y + frame.h / 2;
    return cx >= windowFrame.x && cx <= windowFrame.x + windowFrame.w && cy >= windowFrame.y && cy <= windowFrame.y + windowFrame.h;
  });
}

function names(read: WindowRead, element: RawElement): string[] {
  return [element.label, element.value, read.descendantText?.[element.element_index]]
    .filter((text): text is string => typeof text === "string" && text.trim() !== "").map(normalize);
}

function matching(read: WindowRead, name: string, role?: string): RawElement[] {
  const wanted = normalize(name);
  return visibleElements(read).filter(element => (role === undefined || element.role === role || element.role === `AX${role}`)
    && names(read, element).includes(wanted));
}

/**
 * A signature of what is visible, so an action that changes nothing on screen is detected (design §9).
 * It includes descendant text: Calculator's display is unindexed static text, so a key press
 * that only changes the display changes nothing else (observed 2026-09-23).
 */
export function visibleSignature(read: WindowRead): string {
  return visibleElements(read).map(element => {
    const frame = element.frame!;
    return [element.role, element.label ?? "", element.value ?? "", read.descendantText?.[element.element_index] ?? "",
      element.selected ? 1 : 0, element.enabled === false ? 0 : 1,
      Math.round(frame.x), Math.round(frame.y), Math.round(frame.w), Math.round(frame.h)].join("\u0001");
  }).sort().join("\n");
}

/** Returns the reason a postcondition is malformed, or undefined when it is valid. */
export function validatePostcondition(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return "postcondition nesting is deeper than 8 levels";
  if (!value || typeof value !== "object" || Array.isArray(value)) return "a postcondition must be an object";
  const keys = Object.keys(value);
  if (keys.length !== 1) return `a postcondition must have exactly one predicate, found ${keys.join(", ") || "none"}`;
  const [key] = keys as [string];
  const body = (value as Record<string, unknown>)[key];
  const text = (field: unknown) => typeof field === "string" && field.trim() !== "";
  const fields = (object: unknown, allowed: string[]) =>
    !!object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).every(field => allowed.includes(field));
  switch (key) {
    case "exists": case "absent": {
      const b = body as { name?: unknown; role?: unknown };
      if (!(fields(body, ["name", "role"]) && text(b.name) && (b.role === undefined || text(b.role)))) return `${key} needs a name and an optional role`;
      // Through Pi, a planner wrote role "selected", which no element has (observed 2026-09-23).
      if (typeof b.role === "string" && !ROLE.test(b.role)) {
        return `${key}: role ${JSON.stringify(b.role)} is not an accessibility role such as Button or TextField; to check that an element is selected, use {selected:{name}}`;
      }
      return undefined;
    }
    case "selected": {
      const b = body as { name?: unknown };
      return fields(body, ["name"]) && text(b.name) ? undefined : "selected needs a name";
    }
    case "value": {
      const b = body as { name?: unknown; equals?: unknown };
      return fields(body, ["name", "equals"]) && text(b.name) && typeof b.equals === "string" ? undefined : "value needs a name and an equals string";
    }
    case "window": {
      const b = body as { titleContains?: unknown };
      return fields(body, ["titleContains"]) && text(b.titleContains) ? undefined : "window needs titleContains";
    }
    case "text": {
      const b = body as { contains?: unknown; endsWith?: unknown };
      const one = (b.contains === undefined) !== (b.endsWith === undefined);
      return one && (fields(body, ["contains"]) || fields(body, ["endsWith"])) && text(b.contains ?? b.endsWith)
        ? undefined : "text needs exactly one of contains or endsWith";
    }
    case "changed": return body === true ? undefined : "changed must be true";
    case "all": case "any": {
      if (!Array.isArray(body) || body.length === 0) return `${key} needs a non-empty list`;
      for (const [i, item] of body.entries()) {
        const problem = validatePostcondition(item, depth + 1);
        if (problem) return `${key}[${i}]: ${problem}`;
      }
      return undefined;
    }
    case "focused": return "focused is not supported: the accessibility driver reports no focus state";
    default: return `unknown predicate ${key}`;
  }
}

export function evaluatePostcondition(condition: Postcondition, after: WindowRead, before?: WindowRead): Evaluation {
  if ("exists" in condition) {
    const found = matching(after, condition.exists.name, condition.exists.role);
    return { holds: found.length > 0, detail: `${JSON.stringify(condition.exists.name)} ${found.length > 0 ? "is" : "is not"} on screen` };
  }
  if ("absent" in condition) {
    const found = matching(after, condition.absent.name, condition.absent.role);
    return { holds: found.length === 0, detail: `${JSON.stringify(condition.absent.name)} ${found.length === 0 ? "is not" : "is still"} on screen` };
  }
  if ("value" in condition) {
    const found = matching(after, condition.value.name);
    if (found.length === 0) return { holds: false, detail: `${JSON.stringify(condition.value.name)} is not on screen` };
    const holds = found.some(element => (element.value ?? "") === condition.value.equals);
    return { holds, detail: holds ? `${JSON.stringify(condition.value.name)} has the expected value`
      : `${JSON.stringify(condition.value.name)} has value ${JSON.stringify(found[0]!.value ?? "")}` };
  }
  if ("selected" in condition) {
    const found = matching(after, condition.selected.name);
    const holds = found.some(element => element.selected === true);
    return { holds, detail: found.length === 0 ? `${JSON.stringify(condition.selected.name)} is not on screen`
      : `${JSON.stringify(condition.selected.name)} ${holds ? "is" : "is not"} selected` };
  }
  if ("window" in condition) {
    const holds = after.window.title.toLowerCase().includes(condition.window.titleContains.toLowerCase());
    return { holds, detail: `window title is ${JSON.stringify(after.window.title)}` };
  }
  if ("text" in condition) {
    const ends = "endsWith" in condition.text;
    const target = "endsWith" in condition.text ? condition.text.endsWith : condition.text.contains;
    const wanted = normalize(target);
    // Labels name controls, so they are excluded: the Calculator button labelled "7" satisfied
    // `contains "7"` before anything was typed (observed 2026-09-23). Values and descendant text are content.
    // `endsWith` proves where typed text landed, which `contains` cannot (fix plan F-3).
    const holds = visibleElements(after).some(element => [element.value, after.descendantText?.[element.element_index]]
      .some(text => typeof text === "string" && (ends ? normalize(text).endsWith(wanted) : normalize(text).includes(wanted))));
    const verb = ends ? (holds ? "ends with" : "does not end with") : (holds ? "contains" : "does not contain");
    // A Finder scroll checked text for a file's name, which is a control label, and failed with the
    // file in view (Pi task batch, 2026-09-23). The failure names the control so the plan can switch check.
    const control = holds ? undefined : visibleElements(after).find(element => typeof element.label === "string" && normalize(element.label).includes(wanted));
    return { holds, detail: `on-screen text ${verb} ${JSON.stringify(target)}`
      + (control ? `; a control named ${JSON.stringify(control.label)} is on screen, and text checks do not search control names, so check it with {exists:{name}}` : "") };
  }
  if ("changed" in condition) {
    if (!before) return { holds: false, detail: "no earlier observation to compare with" };
    const holds = visibleSignature(before) !== visibleSignature(after);
    return { holds, detail: holds ? "the visible tree changed" : "the visible tree did not change" };
  }
  const parts = ("all" in condition ? condition.all : condition.any).map(part => evaluatePostcondition(part, after, before));
  const holds = "all" in condition ? parts.every(part => part.holds) : parts.some(part => part.holds);
  return { holds, detail: parts.map(part => part.detail).join("; ") };
}

/** Only `changed` alone is weak verification (design §5.3). */
export const isWeakPostcondition = (condition: Postcondition): boolean => "changed" in condition;
