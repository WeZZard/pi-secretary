import type { Frame, RawElement, WindowRead, WindowRef } from "./backend/backend.ts";

/**
 * Observation pipeline (design docs/arch/computer-use.md §6): from cua-driver's structured
 * elements to a grouped, lettered element table, with every discard recorded (§6.4).
 */

/** The executor's limit per question (research §2.4). */
export const MAX_ALTERNATIVES = 26;
/** Elements per group: one alternative of every element question is reserved for "none". */
export const MAX_GROUP_ELEMENTS = MAX_ALTERNATIVES - 1;

export type DiscardReason =
  | "container"        // structural role used for grouping, not a target
  | "no_frame"         // not on screen, for example a closed menu's items
  | "collapsed_frame"  // width or height of at most 1 point, for example a virtualized row
  | "disabled"
  | "unnamed"          // no usable label or value
  | "behind_modal"     // outside an open sheet
  | "inactive_menu_bar" // menu bar of a background application; its frames belong to another application
  | "outside_window";   // center outside the window frame, outside any menu

export interface Discard { index: number; role: string; label?: string; reason: DiscardReason }

export interface ObservedElement {
  /** cua-driver element_index, valid only for this observation's snapshot. */
  index: number;
  role: string;
  name: string;
  value?: string;
  /** The end of a text field's or text area's content, for the planner only (design §5.1). */
  contentEnd?: string;
  selected?: boolean;
  frame: Frame;
  group: string;
  /** Single letter, unique within its group. */
  letter: string;
}

/**
 * `frame` is the group's container, or the window for the single-group and content cases; scrolling targets it.
 * `hidden` counts named elements of the group's container that lie outside the window, such as rows below the visible part of a list.
 */
export interface ObservedGroup { name: string; elements: ObservedElement[]; frame?: Frame; hidden?: number }

export interface Observation {
  status: "ready";
  id: string;
  window: WindowRef;
  snapshotId?: string;
  groups: ObservedGroup[];
  /**
   * Text the window shows that is not the name of any kept element, such as Calculator's display,
   * which is static text under the window (fix plan F-6). The planner sees it; the executor does not.
   */
  texts?: string[];
  discards: Discard[];
  rawCount: number;
}

export interface ObservationFailure {
  status: "window_missing" | "state_too_large";
  id: string;
  window: WindowRef;
  detail: string;
  discards: Discard[];
  rawCount: number;
}

const MAX_SHOWN_TEXTS = 8;
const MAX_SHOWN_TEXT_LENGTH = 200;

export interface ObserverOptions { maxElements: number; maxNameLength: number; id: string }

/** Roles that structure a window rather than being acted on. */
const CONTAINER_ROLES = new Set([
  "AXApplication", "AXWindow", "AXGroup", "AXScrollArea", "AXSplitGroup", "AXSplitter", "AXLayoutArea",
  "AXToolbar", "AXMenuBar", "AXMenu", "AXOutline", "AXList", "AXTable", "AXBrowser", "AXTabGroup",
  "AXSheet", "AXPopover", "AXColumn", "AXScrollBar", "AXUnknown",
]);

/** Landmark containers that name a group (design §6.3, rule 3). */
const LANDMARKS: Record<string, string> = {
  AXMenuBar: "menu bar", AXMenu: "menu", AXToolbar: "toolbar", AXOutline: "outline", AXList: "list",
  AXTable: "table", AXBrowser: "browser", AXTabGroup: "tab group", AXSheet: "sheet", AXPopover: "popover",
};

const AUTOMATIC_IDENTIFIER = /^_NS:\d+$/;
const TEXT_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]);
/** Characters of a text field's content shown to the planner, from the end. */
const CONTENT_END_LENGTH = 200;

/** Bidirectional control marks, which Calculator's display text carries (observed 2026-09-23). */
export const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function cleanName(text: string | undefined, maxLength: number): string | undefined {
  if (text === undefined || AUTOMATIC_IDENTIFIER.test(text.trim())) return undefined;
  const collapsed = text.replace(BIDI_MARKS, "").replace(/\s+/g, " ").trim();
  if (collapsed === "") return undefined;
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}

const readingOrder = (a: { frame: Frame }, b: { frame: Frame }): number =>
  Math.round(a.frame.y) - Math.round(b.frame.y) || Math.round(a.frame.x) - Math.round(b.frame.x);

const letterAt = (position: number): string => String.fromCharCode(65 + position);

export function observe(read: WindowRead, options: ObserverOptions): Observation | ObservationFailure {
  const byIndex = new Map(read.elements.map(element => [element.element_index, element]));
  const discards: Discard[] = [];
  const base = { id: options.id, window: read.window, discards, rawCount: read.elements.length };
  const discard = (element: RawElement, reason: DiscardReason) =>
    discards.push({ index: element.element_index, role: element.role, ...(element.label ? { label: cleanName(element.label, options.maxNameLength) } : {}), reason });

  if (read.truncated) {
    return { status: "state_too_large", ...base, detail: `The accessibility tree was truncated after ${read.elements.length} nodes.` };
  }
  // A read taken while a window is still appearing lacks the window element (observed on TextEdit launch).
  if (!read.elements.some(element => element.role === "AXWindow")) {
    return { status: "window_missing", ...base, detail: "The window element is not in the accessibility tree yet." };
  }

  const ancestors = (element: RawElement): RawElement[] => {
    const chain: RawElement[] = [];
    const seen = new Set<number>();
    for (let parent = element.parent_index; parent !== undefined && !seen.has(parent); parent = byIndex.get(parent)?.parent_index) {
      seen.add(parent);
      const found = byIndex.get(parent);
      if (!found) break;
      chain.push(found);
    }
    return chain;
  };
  const visible = (element: RawElement): boolean => !!element.frame && element.frame.w > 1 && element.frame.h > 1;
  const landmarkOf = (element: RawElement): RawElement | undefined =>
    ancestors(element).find(ancestor => LANDMARKS[ancestor.role] !== undefined && (ancestor.role !== "AXMenu" || visible(ancestor)));

  const windowFrame = read.elements.find(element => element.role === "AXWindow")?.frame;
  const underMenu = (element: RawElement) => ancestors(element).some(ancestor => ancestor.role === "AXMenuBar" || ancestor.role === "AXMenu");
  const underMenuBar = (element: RawElement) => ancestors(element).some(ancestor => ancestor.role === "AXMenuBar");
  const insideWindow = (frame: Frame) => !windowFrame || (frame.x + frame.w / 2 >= windowFrame.x && frame.x + frame.w / 2 <= windowFrame.x + windowFrame.w
    && frame.y + frame.h / 2 >= windowFrame.y && frame.y + frame.h / 2 <= windowFrame.y + windowFrame.h);

  // Fix plan F-6: descendant text of containers is content the window shows, such as a display.
  // Container text is never a control's name, so it is listed even when it equals one: Calculator's
  // display read "0" while a button was named "0" (observed through Pi, 2026-09-23).
  const shownTexts = (): { texts?: string[] } => {
    const texts: string[] = [];
    for (const element of read.elements) {
      if (!CONTAINER_ROLES.has(element.role) || !element.frame || !visible(element)) continue;
      if (element.role !== "AXWindow" && !insideWindow(element.frame)) continue;
      const text = cleanName(read.descendantText?.[element.element_index], MAX_SHOWN_TEXT_LENGTH);
      if (text && !texts.includes(text)) texts.push(text);
      if (texts.length >= MAX_SHOWN_TEXTS) break;
    }
    return texts.length ? { texts } : {};
  };

  const hiddenBy = new Map<number | "content", number>();
  const kept: { element: RawElement; name: string; landmark?: RawElement }[] = [];
  for (const element of read.elements) {
    if (CONTAINER_ROLES.has(element.role)) { discard(element, "container"); continue; }
    if (!element.frame) { discard(element, "no_frame"); continue; }
    if (!visible(element)) { discard(element, "collapsed_frame"); continue; }
    if (element.enabled === false) { discard(element, "disabled"); continue; }
    if (!read.appActive && underMenuBar(element)) { discard(element, "inactive_menu_bar"); continue; }
    if (!underMenu(element) && !insideWindow(element.frame!)) {
      discard(element, "outside_window");
      if (!CONTAINER_ROLES.has(element.role) && (cleanName(element.label, options.maxNameLength) ?? cleanName(element.value, options.maxNameLength) ?? cleanName(read.descendantText?.[element.element_index], options.maxNameLength))) {
        const landmark = landmarkOf(element);
        hiddenBy.set(landmark?.element_index ?? "content", (hiddenBy.get(landmark?.element_index ?? "content") ?? 0) + 1);
      }
      continue;
    }
    const name = cleanName(element.label, options.maxNameLength) ?? cleanName(element.value, options.maxNameLength)
      ?? cleanName(read.descendantText?.[element.element_index], options.maxNameLength);
    if (!name) { discard(element, "unnamed"); continue; }
    kept.push({ element, name, landmark: landmarkOf(element) });
  }

  // Rule 1: an open sheet is the only group.
  const inSheet = (entry: typeof kept[number]) => ancestors(entry.element).some(ancestor => ancestor.role === "AXSheet");
  let candidates = kept;
  if (kept.some(inSheet)) {
    candidates = kept.filter(entry => {
      if (inSheet(entry)) return true;
      discard(entry.element, "behind_modal");
      return false;
    });
  }

  if (candidates.length > options.maxElements) {
    return { status: "state_too_large", ...base, detail: `${candidates.length} elements remain after filtering; the limit is ${options.maxElements}.` };
  }

  const toElement = (entry: typeof kept[number], group: string, position: number): ObservedElement => ({
    index: entry.element.element_index, role: entry.element.role, name: entry.name,
    ...(entry.element.value !== undefined && cleanName(entry.element.value, options.maxNameLength) !== entry.name
      ? { value: cleanName(entry.element.value, options.maxNameLength) } : {}),
    ...(entry.element.selected ? { selected: true } : {}),
    ...(TEXT_ROLES.has(entry.element.role) && entry.element.value ? { contentEnd: entry.element.value.replace(BIDI_MARKS, "").slice(-CONTENT_END_LENGTH) } : {}),
    frame: entry.element.frame!, group, letter: letterAt(position),
  });

  const hiddenTotal = () => { const total = [...hiddenBy.values()].reduce((sum, count) => sum + count, 0); return total ? { hidden: total } : {}; };
  // Rule 5: a small window is one group, so the request needs no routing question.
  const ordered = [...candidates].sort((a, b) => readingOrder({ frame: a.element.frame! }, { frame: b.element.frame! }));
  if (ordered.length <= MAX_GROUP_ELEMENTS) {
    const name = "window";
    return { status: "ready", id: options.id, window: read.window, snapshotId: read.snapshotId, discards, rawCount: read.elements.length, ...shownTexts(),
      groups: ordered.length === 0 ? [] : [{ name, elements: ordered.map((entry, position) => toElement(entry, name, position)), ...(windowFrame ? { frame: windowFrame } : {}),
        ...hiddenTotal() }] };
  }

  // Rules 2 and 3: group by the nearest landmark container instance. Groups follow the reading
  // order of their containers' frames; ungrouped content comes last.
  const unsorted = new Map<number | "content", typeof kept>();
  for (const entry of ordered) {
    const key = entry.landmark?.element_index ?? "content";
    const bucket = unsorted.get(key) ?? [];
    bucket.push(entry);
    unsorted.set(key, bucket);
  }
  const containerFrame = (key: number | "content"): Frame | undefined => key === "content" ? undefined : byIndex.get(key)?.frame;
  // A scroll container's frame spans its whole content, which can extend past the window: Finder's
  // icon-view list did, so its center was outside the window (observed 2026-09-23). Scrolling
  // targets the visible part, so a group's frame is clipped to the window.
  const visiblePart = (frame: Frame | undefined): Frame | undefined => {
    if (!frame || !windowFrame) return frame;
    const x = Math.max(frame.x, windowFrame.x), y = Math.max(frame.y, windowFrame.y);
    const w = Math.min(frame.x + frame.w, windowFrame.x + windowFrame.w) - x;
    const h = Math.min(frame.y + frame.h, windowFrame.y + windowFrame.h) - y;
    return w > 1 && h > 1 ? { x, y, w, h } : undefined;
  };
  const buckets = new Map([...unsorted].sort(([a, first], [b, second]) => {
    if (a === "content" || b === "content") return a === "content" ? (b === "content" ? 0 : 1) : -1;
    return readingOrder({ frame: containerFrame(a) ?? first[0]!.element.frame! }, { frame: containerFrame(b) ?? second[0]!.element.frame! });
  }));
  const kindCount = new Map<string, number>();
  const kindTotal = new Map<string, number>();
  for (const key of buckets.keys()) {
    const kind = key === "content" ? "content" : LANDMARKS[byIndex.get(key)!.role]!;
    kindTotal.set(kind, (kindTotal.get(kind) ?? 0) + 1);
  }
  const groups: ObservedGroup[] = [];
  for (const [key, entries] of buckets) {
    const kind = key === "content" ? "content" : LANDMARKS[byIndex.get(key)!.role]!;
    const occurrence = (kindCount.get(kind) ?? 0) + 1;
    kindCount.set(kind, occurrence);
    const baseName = kindTotal.get(kind)! > 1 ? `${kind} ${occurrence}` : kind;
    // Rule 4: split an oversized group in reading order.
    const parts = Math.ceil(entries.length / MAX_GROUP_ELEMENTS);
    for (let part = 0; part < parts; part++) {
      const name = parts > 1 ? `${baseName} part ${part + 1}` : baseName;
      const slice = entries.slice(part * MAX_GROUP_ELEMENTS, (part + 1) * MAX_GROUP_ELEMENTS);
      const frame = visiblePart(containerFrame(key) ?? windowFrame);
      const hidden = part === parts - 1 ? hiddenBy.get(key) ?? 0 : 0;
      groups.push({ name, elements: slice.map((entry, position) => toElement(entry, name, position)), ...(frame ? { frame } : {}), ...(hidden ? { hidden } : {}) });
    }
  }
  // The routing question has one option per group, and the executor accepts at most 26 (research §2.4).
  if (groups.length > MAX_ALTERNATIVES) {
    return { status: "state_too_large", ...base, detail: `the window splits into ${groups.length} groups; the executor can route among at most ${MAX_ALTERNATIVES}.` };
  }
  return { status: "ready", id: options.id, window: read.window, snapshotId: read.snapshotId, groups, discards, rawCount: read.elements.length, ...shownTexts() };
}

/** The executor's view: group headings and name-only lines (design §6.2, research §4.8 format). */
export function renderExecutorTable(observation: Observation): string {
  return observation.groups.map(group =>
    `${group.name.toUpperCase()}\n${group.elements.map(element => `  ${element.letter} ${element.name}`).join("\n")}`).join("\n");
}

/** The planner's view includes role, state, and the text the window shows (design §5.1, fix plan F-6). */
export function renderPlannerTable(observation: Observation): string {
  const table = observation.groups.map(group => `${group.name}:\n${group.elements.map(element => {
    const role = element.role.replace(/^AX/, "");
    // A text area's name is the start of its content, so the planner also sees how the content ends.
    // Through Pi, a planner that could not see its typed line typed probe letters to find it (observed 2026-09-23).
    const state = [element.value !== undefined ? `value=${JSON.stringify(element.value)}` : "",
      element.contentEnd !== undefined && element.contentEnd !== element.name ? `content ends with ${JSON.stringify(element.contentEnd)}` : "",
      element.selected ? "selected" : ""].filter(Boolean).join(" ");
    return `  ${element.letter} ${role} ${JSON.stringify(element.name)}${state ? ` ${state}` : ""}`;
  }).join("\n")}`).join("\n");
  if (!observation.texts?.length) return table;
  return `${table}\ntext shown in the window (not controls; check it with {text:{contains}}):\n${observation.texts.map(text => `  ${JSON.stringify(text)}`).join("\n")}`;
}

export function discardSummary(discards: Discard[]): Record<DiscardReason, number> {
  const summary = { container: 0, no_frame: 0, collapsed_frame: 0, disabled: 0, unnamed: 0, behind_modal: 0, inactive_menu_bar: 0, outside_window: 0 };
  for (const entry of discards) summary[entry.reason]++;
  return summary;
}
