import assert from "node:assert/strict";
import { test } from "node:test";
import { commandOf, displayScaleOf, pointerOf, type PointerRead } from "../../extensions/secretary/vm-use/viewer/pointer.ts";

/** Where a machine step clicked, and with which button (decision PS-D60, design §12.3, Pointer, ACC-VU-29, ACC-VU-30). */

/** The command as the relay records it: the host script, then `cua <tool> '<json>'` and the timeouts. */
const argv = (tool: string, args: Record<string, unknown>) => ["node", "/var/tmp/run/mcp-host.mjs", "call", "/var/tmp/run/mcp", "cua", tool, JSON.stringify(args), "60000", "60000"];
const snapshot = { width: 2000, height: 1000 };
/** A read of window 60 of process 856 at two pixels per point: a 1000-point menu bar, a button and a text field. */
const read = (more: Partial<PointerRead> = {}): PointerRead => ({ window: { pid: 856, windowId: 60 }, elements: [
  { element_index: 0, role: "AXMenuBar", frame: { x: 0, y: 0, w: 1000, h: 24 } },
  { element_index: 3, role: "AXButton", label: "Save", frame: { x: 100, y: 200, w: 50, h: 20 } },
  { element_index: 12, role: "AXTextField", value: "Phone", frame: { x: 400, y: 300, w: 40, h: 18 } },
  { element_index: 13, role: "AXRow" },
], ...more });
const element = (tool: string, args: Record<string, unknown>, more: { stdout?: string; reads?: PointerRead[] } = {}) =>
  pointerOf({ argv: argv(tool, { pid: 856, window_id: 60, ...args }), snapshot, reads: [read()], ...more });

test("the command is the tool after `cua` and its JSON arguments", () => {
  assert.deepEqual(commandOf(argv("click", { x: 1 })), { tool: "click", args: { x: 1 } });
  assert.equal(commandOf(["node", "script.mjs"]), undefined, "no driver tool");
  assert.equal(commandOf(["cua", "click", "{not json"]), undefined, "unreadable arguments");
});

test("a desktop click gives its button, its count, its modifiers and its point in the snapshot", () => {
  const left = pointerOf({ argv: argv("click", { x: 1546, y: 910, scope: "desktop" }), stdout: "Clicked at screen-point (773, 455).", snapshot });
  assert.deepEqual(left, { kind: "click", tool: "click", button: "left", count: 1, source: "command", points: { x: 773, y: 455 }, point: { x: 1546, y: 910, fx: 0.773, fy: 0.91 } });
  assert.equal(pointerOf({ argv: argv("right_click", { x: 10, y: 10, scope: "desktop" }), snapshot })!.button, "right");
  assert.equal(pointerOf({ argv: argv("click", { x: 10, y: 10, scope: "desktop", button: "right" }), snapshot })!.button, "right");
  assert.equal(pointerOf({ argv: argv("click", { x: 10, y: 10, scope: "desktop", button: "middle" }), snapshot })!.button, "middle");
  const double = pointerOf({ argv: argv("double_click", { x: 10, y: 10, scope: "desktop", modifier: ["cmd", "shift"] }), snapshot })!;
  assert.deepEqual([double.button, double.count, double.modifiers], ["left", 2, ["cmd", "shift"]]);
  assert.equal(pointerOf({ argv: argv("click", { x: 10, y: 10, scope: "desktop", count: 3 }), snapshot })!.count, 3);
});

test("a desktop click's screen points come from the driver, else from the display scale", () => {
  const scaled = pointerOf({ argv: argv("click", { x: 400, y: 100, scope: "desktop" }), snapshot, reads: [read()] })!;
  assert.deepEqual(scaled.points, { x: 200, y: 50 }, "the menu bar gives two pixels per point");
  const recorded = pointerOf({ argv: argv("click", { x: 400, y: 100, scope: "desktop" }), snapshot, reads: [read({ desktopScale: 4 })] })!;
  assert.deepEqual(recorded.points, { x: 100, y: 25 }, "a recorded scale wins over the menu bar");
  assert.equal(pointerOf({ argv: argv("click", { x: 400, y: 100, scope: "desktop" }), snapshot })!.points, undefined, "nothing tells it");
});

test("a point outside the snapshot, or a snapshot of unknown size, has no marker and says why", () => {
  const outside = pointerOf({ argv: argv("click", { x: 2400, y: 10, scope: "desktop" }), snapshot })!;
  assert.deepEqual([outside.kind, outside.reason], ["click", "The point lies outside the snapshot."]);
  const unknown = pointerOf({ argv: argv("click", { x: 10, y: 10, scope: "desktop" }) })!;
  assert.deepEqual([unknown.point, unknown.reason], [{ x: 10, y: 10 }, "The snapshot's size is not known."]);
});

test("a click in the window's own screenshot, or without a point or a UI element, is unplaced", () => {
  const local = pointerOf({ argv: argv("click", { pid: 856, window_id: 60, x: 10, y: 10 }), snapshot, reads: [read()] })!;
  assert.deepEqual([local.kind, local.button, local.reason], ["unplaced", "left", "The command gave a point in the window's own screenshot, whose place on the display was not recorded."]);
  assert.equal(pointerOf({ argv: argv("right_click", { pid: 856, window_id: 60 }), snapshot })!.reason, "The command gave neither a point nor a UI element.");
});

test("an accessibility action on a UI element gives the element's frame in the snapshot's pixels", () => {
  const pressed = element("click", { element_index: 3 }, { stdout: "Pressed [3] AXButton \"Save\"." })!;
  assert.deepEqual(pressed, { kind: "element", tool: "click", action: "press", source: "element",
    frame: { x: 200, y: 400, w: 100, h: 40, fx: 0.1, fy: 0.4, fw: 0.05, fh: 0.04, role: "AXButton", name: "Save" } });
  assert.equal(element("click", { element_index: 3, action: "pick" })!.action, "pick", "the command's own action");
  assert.equal(element("click", { element_index: 3, button: "right" })!.action, "show_menu");
  assert.equal(element("right_click", { element_index: 3 })!.action, "show_menu");
  assert.equal(element("double_click", { element_index: 3 })!.action, "open");
  const set = element("set_value", { element_index: 12, value: "555-1234" })!;
  assert.deepEqual([set.kind, set.action, set.frame!.name, set.frame!.x], ["element", "set_value", "Phone", 800]);
  assert.equal(pointerOf({ argv: argv("set_value", { pid: 856, window_id: 60, value: "x" }), snapshot }), undefined, "a set_value without a UI element is not a click");
});

test("a middle click on a UI element is a click at the element's centre", () => {
  const middle = element("click", { element_index: 3, button: "middle", modifier: ["alt"] })!;
  assert.deepEqual({ kind: middle.kind, button: middle.button, modifiers: middle.modifiers, source: middle.source, point: middle.point, points: middle.points },
    { kind: "click", button: "middle", modifiers: ["alt"], source: "element", point: { x: 250, y: 420, fx: 0.125, fy: 0.42 }, points: { x: 125, y: 210 } });
});

test("the frame comes from the latest read of the step's own window", () => {
  const other: PointerRead = { window: { pid: 856, windowId: 120 }, elements: [{ element_index: 3, role: "AXButton", frame: { x: 0, y: 0, w: 10, h: 10 } }] };
  assert.equal(element("click", { element_index: 3 }, { reads: [read(), other] })!.frame!.x, 200, "a later read of another window is not the step's");
  const moved = read({ elements: [...read().elements.slice(0, 1), { element_index: 3, role: "AXButton", frame: { x: 300, y: 200, w: 50, h: 20 } }] });
  assert.equal(element("click", { element_index: 3 }, { reads: [read(), moved] })!.frame!.x, 600, "the latest read of the window");
  assert.equal(element("click", { element_index: 3 }, { reads: [other] })!.reason, "No read of the step's window was recorded before the step.");
  assert.equal(element("click", { element_index: 13 })!.reason, "The window read before the step has no frame for UI element 13.");
});

test("a UI element the driver names with another role is unplaced", () => {
  const mismatch = element("click", { element_index: 3 }, { stdout: "Pressed [3] AXCheckBox." })!;
  assert.deepEqual([mismatch.kind, mismatch.action, mismatch.reason], ["unplaced", "press", "The driver acted on a AXCheckBox, but the window read before the step has a AXButton at index 3."]);
});

test("without a recorded scale, the widest menu bar gives it, and without either the UI element is unplaced", () => {
  assert.equal(displayScaleOf(2000, read().elements), 2);
  assert.equal(displayScaleOf(2000, [{ element_index: 0, role: "AXMenuBar", frame: { x: 0, y: 0, w: 100, h: 24 } }]), undefined, "twenty pixels per point is not a display scale");
  const bare = read({ elements: read().elements.slice(1) });
  assert.equal(element("click", { element_index: 3 }, { reads: [bare] })!.reason, "The display scale was not recorded, and the window read has no menu bar to measure it by.");
  assert.equal(element("click", { element_index: 3 }, { reads: [{ ...bare, desktopScale: 2 }] })!.frame!.x, 200, "the recorded scale");
  assert.equal(pointerOf({ argv: argv("click", { pid: 856, window_id: 60, element_index: 3 }), reads: [read()] })!.reason, "The snapshot's size is not known.");
});

test("a tool that does not click has no pointer", () => {
  for (const tool of ["type_text", "press_key", "scroll", "get_window_state"]) assert.equal(pointerOf({ argv: argv(tool, { pid: 856, x: 1, y: 1 }), snapshot }), undefined, tool);
  assert.equal(pointerOf({ snapshot }), undefined, "no command");
});
