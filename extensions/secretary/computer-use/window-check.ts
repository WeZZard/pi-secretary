/**
 * The plan-start window check (design docs/arch/computer-use.md §9, decision PS-D4). It compares
 * the observation a plan was written against with the plan's first read. It is the comparison that
 * `scripts/computer-use/replay-drift-check.ts` replayed over 61 recorded plans: 3 stops, all on
 * plans that failed when they ran, and no stop of a plan that completed (research §16.1).
 */

/** The parts of a read that the check compares. Values and shown text are left out, because steps change them. */
export interface WindowComparison {
  windowId?: number;
  title: string;
  /** Kept UI elements outside the menu bar, as `role "name"`, sorted. */
  uiElements: string[];
  /** UI elements outside the menu bar that open over the window, as `role "label"`. */
  blocking: string[];
}

/** Roles that open over the window and can block input to the rest of it. */
export const BLOCKING_ROLES = /^AX(Sheet|Dialog|Popover|Menu|SystemDialog)$/;
/** The menu bar belongs to the application and appears only while it is active; it is not window content. */
export const MENU_BAR_ROLES = /^AXMenuBar(Item)?$/;

export interface WindowVerdict { stop: boolean; reasons: string[] }

/** Items of `a` left after removing one match from `b` for each. */
function without(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const key of b) left.set(key, (left.get(key) ?? 0) + 1);
  return a.filter(key => { const n = left.get(key) ?? 0; if (n > 0) { left.set(key, n - 1); return false; } return true; });
}

/**
 * Stops when the window or its title differs, a UI element is gone, or something opened over the
 * window. An added UI element does not stop the plan, because it cannot make a step act on the wrong UI element.
 */
export function compareWindows(baseline: WindowComparison, current: WindowComparison): WindowVerdict {
  const reasons: string[] = [];
  if (baseline.windowId !== undefined && current.windowId !== undefined && baseline.windowId !== current.windowId) reasons.push(`it is a different window (${baseline.windowId}, now ${current.windowId})`);
  if (baseline.title !== current.title) reasons.push(`the window title was ${JSON.stringify(baseline.title)} and is now ${JSON.stringify(current.title)}`);
  const gone = without(baseline.uiElements, current.uiElements);
  if (gone.length) reasons.push(`${gone.length} UI element(s) are gone: ${gone.slice(0, 5).join(", ")}${gone.length > 5 ? ", …" : ""}`);
  const opened = without(current.blocking, baseline.blocking);
  if (opened.length) reasons.push(`opened over the window: ${opened.join(", ")}`);
  return { stop: reasons.length > 0, reasons };
}
