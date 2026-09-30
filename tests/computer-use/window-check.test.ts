import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawElement, WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { observe, type Observation } from "../../extensions/secretary/computer-use/observer.ts";
import { compareWindows } from "../../extensions/secretary/computer-use/window-check.ts";

/** A window with a menu bar, some buttons, an optional display text, and optional extra UI elements. */
function read(options: { title?: string; windowId?: number; buttons?: string[]; display?: string; extra?: RawElement[] } = {}): WindowRead {
  const elements: RawElement[] = [
    { element_index: 0, role: "AXWindow", label: options.title ?? "Calculator", depth: 0, frame: { x: 0, y: 0, w: 400, h: 600 } },
    { element_index: 1, role: "AXMenuBar", depth: 0, frame: { x: 0, y: 0, w: 1440, h: 24 } },
    { element_index: 2, role: "AXMenuBarItem", label: "Edit", parent_index: 1, depth: 1, frame: { x: 60, y: 0, w: 40, h: 24 } },
    { element_index: 3, role: "AXMenu", label: "Edit", parent_index: 2, depth: 2 },
  ];
  (options.buttons ?? ["7", "Add", "Equals"]).forEach((name, i) => elements.push({ element_index: 10 + i, role: "AXButton", label: name, parent_index: 0, depth: 1, frame: { x: 20 + i * 60, y: 300, w: 50, h: 40 } }));
  elements.push(...(options.extra ?? []));
  return { window: { pid: 1, windowId: options.windowId ?? 7, app: "Calculator", title: options.title ?? "Calculator" }, appActive: true, truncated: false, readMs: 0, elements,
    descendantText: { 0: options.display ?? "0" } };
}
const comparison = (window: WindowRead) => (observe(window, { id: "obs", maxElements: 240, maxNameLength: 48 }) as Observation).comparison;
const verdict = (before: WindowRead, after: WindowRead) => compareWindows(comparison(before), comparison(after));

test("the start check lets a plan through when only values or shown text changed, or a UI element was added", () => {
  assert.equal(verdict(read(), read()).stop, false);
  assert.equal(verdict(read({ display: "0" }), read({ display: "7+3" })).stop, false, "a step is expected to change shown text");
  assert.equal(verdict(read(), read({ buttons: ["7", "Add", "Equals", "Clear"] })).stop, false, "an added UI element cannot make a step act on the wrong element");
});

test("the start check stops on another window, another title, a UI element gone, or something opened over the window", () => {
  assert.match(verdict(read(), read({ windowId: 8 })).reasons.join(), /different window \(7, now 8\)/);
  assert.match(verdict(read(), read({ title: "Converter" })).reasons.join(), /title was "Calculator" and is now "Converter"/);
  assert.match(verdict(read(), read({ buttons: ["7", "Equals"] })).reasons.join(), /1 UI element\(s\) are gone: AXButton "Add"/);
  const sheet: RawElement = { element_index: 50, role: "AXSheet", label: "Save", parent_index: 0, depth: 1, frame: { x: 0, y: 30, w: 400, h: 200 } };
  assert.match(verdict(read(), read({ extra: [sheet] })).reasons.join(), /opened over the window: AXSheet "Save"/);
});

test("the menu bar and its menus are not window content", () => {
  // The menu bar's menus are always in an active application's tree (observed 2026-09-25 in the replay).
  const menu = read();
  const noMenuBar = read();
  noMenuBar.elements = noMenuBar.elements.filter(element => element.element_index === 0 || element.element_index > 3);
  assert.equal(verdict(menu, noMenuBar).stop, false);
  const context: RawElement = { element_index: 60, role: "AXMenu", label: "", parent_index: 0, depth: 1, frame: { x: 100, y: 100, w: 150, h: 200 } };
  assert.equal(verdict(menu, read({ extra: [context] })).stop, true, "a context menu opened over the window");
});
