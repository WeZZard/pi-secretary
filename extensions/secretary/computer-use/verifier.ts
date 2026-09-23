import type { RawElement, WindowRead } from "./backend/backend.ts";

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
  | { window: { titleContains: string } }
  | { changed: true }
  | { all: Postcondition[] }
  | { any: Postcondition[] };

export interface Evaluation { holds: boolean; detail: string }

const MAX_DEPTH = 8;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const onScreen = (element: RawElement) => !!element.frame && element.frame.w > 1 && element.frame.h > 1;

function names(read: WindowRead, element: RawElement): string[] {
  return [element.label, element.value, read.descendantText?.[element.element_index]]
    .filter((text): text is string => typeof text === "string" && text.trim() !== "").map(normalize);
}

function matching(read: WindowRead, name: string, role?: string): RawElement[] {
  const wanted = normalize(name);
  return read.elements.filter(element => onScreen(element) && (role === undefined || element.role === role || element.role === `AX${role}`)
    && names(read, element).includes(wanted));
}

/** A signature of what is visible, so an action that changes nothing on screen is detected (design §9). */
export function visibleSignature(read: WindowRead): string {
  return read.elements.filter(onScreen).map(element => {
    const frame = element.frame!;
    return [element.role, element.label ?? "", element.value ?? "", element.selected ? 1 : 0, element.enabled === false ? 0 : 1,
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
      return fields(body, ["name", "role"]) && text(b.name) && (b.role === undefined || text(b.role)) ? undefined : `${key} needs a name and an optional role`;
    }
    case "value": {
      const b = body as { name?: unknown; equals?: unknown };
      return fields(body, ["name", "equals"]) && text(b.name) && typeof b.equals === "string" ? undefined : "value needs a name and an equals string";
    }
    case "window": {
      const b = body as { titleContains?: unknown };
      return fields(body, ["titleContains"]) && text(b.titleContains) ? undefined : "window needs titleContains";
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
  if ("window" in condition) {
    const holds = after.window.title.toLowerCase().includes(condition.window.titleContains.toLowerCase());
    return { holds, detail: `window title is ${JSON.stringify(after.window.title)}` };
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
