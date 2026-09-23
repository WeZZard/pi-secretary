import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { actionsFor, ActuatorError, keystrokesFor, parseKeyCombo } from "../../extensions/secretary/computer-use/actuator.ts";
import { LocalDriverBackend, pngWidth, type DriverRunner } from "../../extensions/secretary/computer-use/backend/local-backend.ts";

const frame = { x: 100, y: 200, w: 40, h: 20 };

test("operations become real-input actions at the frame center", () => {
  assert.deepEqual(actionsFor({ operation: "press", frame }), [{ kind: "click", point: { x: 120, y: 210 }, button: "left", count: 1 }]);
  assert.equal((actionsFor({ operation: "double_press", frame })[0] as { count: number }).count, 2);
  assert.equal((actionsFor({ operation: "context_press", frame })[0] as { button: string }).button, "right");
  assert.deepEqual(actionsFor({ operation: "scroll_down", frame }), [{ kind: "scroll", point: { x: 120, y: 210 }, direction: "down", by: "page", extent: frame.h }]);
  assert.deepEqual(actionsFor({ operation: "key_combo", keys: "Cmd+Shift+N" }), [{ kind: "key", key: "n", modifiers: ["cmd", "shift"] }]);
});

test("text entry clicks the field and presses one key per character", () => {
  const actions = actionsFor({ operation: "enter_text", frame, text: "Hi 2\n" });
  assert.deepEqual(actions.map(action => action.kind === "key" ? `${action.modifiers.join("+")}${action.modifiers.length ? "+" : ""}${action.key}` : action.kind),
    ["click", "shift+h", "i", "space", "2", "return"]);
});

test("untypeable characters and malformed key combinations are refused before any input", () => {
  assert.throws(() => actionsFor({ operation: "enter_text", frame, text: "a.b" }), (error: ActuatorError) => error.code === "untypeable_text");
  assert.throws(() => keystrokesFor("é"), /cannot be typed/);
  for (const keys of ["cmd+", "hyper+n", "cmd+shift+plus", ""]) assert.throws(() => parseKeyCombo(keys), (error: ActuatorError) => error.code === "invalid_keys");
  assert.deepEqual(parseKeyCombo("escape"), { kind: "key", key: "escape", modifiers: [] });
});

function pngOfWidth(width: number): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8); png.write("IHDR", 12, "latin1"); png.writeUInt32BE(width, 16); png.writeUInt32BE(10, 20);
  return png;
}

test("the backend converts screen points to window-local screenshot pixels with a learned scale, never an element index", async () => {
  assert.equal(pngWidth(pngOfWidth(1312)), 1312);
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let x = 309;
  const run: DriverRunner = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "list_windows") return { windows: [{ window_id: 3, pid: 7, app_name: "TextEdit", title: "scratch.txt", is_on_screen: true, bounds: { x, y: 103, width: 656, height: 422 } }] };
    if (tool === "get_window_state") { writeFileSync(args.screenshot_out_file as string, pngOfWidth(1312)); return { elements: [] }; }
    return tool === "press_key" ? { effect: "unverifiable" } : { effect: "confirmed" };
  };
  const backend = new LocalDriverBackend({ run, maxTreeNodes: 100 });
  const window = { pid: 7, windowId: 3, app: "TextEdit", title: "scratch.txt" };
  assert.deepEqual(await backend.act(window, { kind: "click", point: { x: 329, y: 113 }, button: "left", count: 1 }), { kind: "completed", detail: "confirmed" });
  assert.deepEqual(calls.find(call => call.tool === "click")!.args, { pid: 7, window_id: 3, x: 40, y: 20 }, "Scale 2 learned from a 1312-pixel screenshot of a 656-point window");
  x = 409;
  await backend.act(window, { kind: "click", point: { x: 429, y: 113 }, button: "right", count: 1 });
  assert.deepEqual(calls.find(call => call.tool === "right_click")!.args, { pid: 7, window_id: 3, x: 40, y: 20 }, "Bounds are re-read, so a moved window is followed");
  assert.equal(calls.filter(call => call.tool === "get_window_state").length, 1, "The scale is learned once per window");
  assert.deepEqual(await backend.act(window, { kind: "key", key: "a", modifiers: [] }), { kind: "unverifiable", detail: "the driver cannot read back this input" });
  await assert.rejects(backend.act(window, { kind: "click", point: { x: 5000, y: 113 }, button: "left", count: 1 }), /outside the TextEdit window/);
  assert.ok(calls.every(call => !("element_index" in call.args) && !("element_token" in call.args)), "Relay decision D3: no accessibility activation");
});

test("text entry places the insertion point with fixed keys after the click when a position is given", () => {
  const frame = { x: 0, y: 0, w: 100, h: 40 };
  const kinds = (position?: "end" | "start" | "replace") => actionsFor({ operation: "enter_text", frame, text: "ab", ...(position ? { position } : {}) })
    .map(action => action.kind === "key" ? `${action.modifiers.join("+")}${action.modifiers.length ? "+" : ""}${action.key}` : action.kind);
  assert.deepEqual(kinds("end"), ["click", "cmd+down", "a", "b"]);
  assert.deepEqual(kinds("start"), ["click", "cmd+up", "a", "b"]);
  assert.deepEqual(kinds("replace"), ["click", "cmd+up", "shift+cmd+down", "a", "b"]);
  assert.deepEqual(kinds(), ["click", "a", "b"]);
});
