import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { BackendError } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { deliveryFor, LocalDriverBackend, pageNotches, type DriverRunner } from "../../extensions/secretary/computer-use/backend/local-backend.ts";

const windows = { windows: [
  { window_id: 1, pid: 7, app_name: "TextEdit", title: "", is_on_screen: false, z_index: 1 },
  { window_id: 2, pid: 7, app_name: "TextEdit", title: "notes.txt", is_on_screen: true, z_index: 3 },
  { window_id: 3, pid: 7, app_name: "TextEdit", title: "draft.txt", is_on_screen: true, z_index: 5 },
  { window_id: 4, pid: 9, app_name: "Finder", title: "Documents", is_on_screen: true, z_index: 9 },
] };

function recorder(state: Record<string, unknown>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const run: DriverRunner = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "list_windows") return windows;
    if (tool === "list_apps") return [{ pid: 7, active: false }, { pid: 9, active: true }];
    if (typeof args.screenshot_out_file === "string") writeFileSync(args.screenshot_out_file, Buffer.from("png-bytes"));
    return state;
  };
  return { calls, run };
}

test("the frontmost titled window is read tree-only with the configured walk cap", async () => {
  const { calls, run } = recorder({ elements: [{ element_index: 0, role: "AXWindow", depth: 0 }], element_count: 1, snapshot_id: "s1" });
  const backend = new LocalDriverBackend({ run, maxTreeNodes: 500 });
  const read = await backend.readWindow({ app: "textedit" }, { screenshot: false });
  // A lower z_index is nearer the front (observed 2026-09-23), so notes.txt at 3 is in front of draft.txt at 5.
  assert.deepEqual(read.window, { pid: 7, windowId: 2, app: "TextEdit", title: "notes.txt" });
  assert.equal(read.appActive, false, "Finder is the active application");
  assert.deepEqual(calls[2], { tool: "get_window_state", args: { pid: 7, window_id: 2, max_elements: 500, include_screenshot: false } }, "The first read of a window is a warm-up");
  assert.deepEqual(calls[3], { tool: "get_window_state", args: { pid: 7, window_id: 2, max_elements: 500, include_screenshot: false } });
  assert.equal(read.truncated, false);
  assert.equal(read.screenshot, undefined);
  assert.deepEqual(calls.map(call => call.tool), ["list_windows", "list_apps", "get_window_state", "get_window_state"], "Reading never launches, focuses, or clicks");
  await backend.readWindow({ app: "textedit" }, { screenshot: false });
  assert.equal(calls.filter(call => call.tool === "get_window_state").length, 3, "A window already read needs no warm-up");
});

test("a title filter selects the window, and a screenshot is returned as base64 PNG", async () => {
  const { calls, run } = recorder({ elements: [], element_count: 0 });
  const read = await new LocalDriverBackend({ run, maxTreeNodes: 500 }).readWindow({ app: "TextEdit", windowTitle: "NOTES" }, { screenshot: true });
  assert.equal(read.window.windowId, 2);
  const finder = await new LocalDriverBackend({ run, maxTreeNodes: 500 }).readWindow({ app: "Finder" }, { screenshot: false });
  assert.equal(finder.appActive, true);
  assert.equal(typeof calls[3]!.args.screenshot_out_file, "string");
  assert.deepEqual(read.screenshot, { data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" });
});

test("reaching the walk cap marks the read as truncated", async () => {
  const { run } = recorder({ elements: [], element_count: 500 });
  assert.equal((await new LocalDriverBackend({ run, maxTreeNodes: 500 }).readWindow({ app: "Finder" }, { screenshot: false })).truncated, true);
});

test("a closed application and an unmatched title are typed errors that list the available windows", async () => {
  const { run } = recorder({ elements: [] });
  const backend = new LocalDriverBackend({ run, maxTreeNodes: 500 });
  await assert.rejects(backend.readWindow({ app: "Mail" }, { screenshot: false }), (error: BackendError) => error.code === "app_not_running");
  await assert.rejects(backend.readWindow({ app: "TextEdit", windowTitle: "budget" }, { screenshot: false }),
    (error: BackendError) => error.code === "window_not_found" && /"notes.txt", "draft.txt"/.test(error.message));
  const hidden = new LocalDriverBackend({ maxTreeNodes: 500, run: async tool => tool === "list_windows"
    ? { windows: [{ window_id: 5, pid: 7, app_name: "TextEdit", title: "notes.txt", is_on_screen: false }] } : [] });
  await assert.rejects(hidden.readWindow({ app: "TextEdit", windowTitle: "notes" }, { screenshot: false }),
    (error: BackendError) => error.code === "window_not_found" && /exists but is not on screen/.test(error.message));
});

test("a plan names one window: an observed window id wins, a closed one is an error, and several matches are refused", async () => {
  const { run } = recorder({ elements: [] });
  const backend = new LocalDriverBackend({ run, maxTreeNodes: 500 });
  // Observed 2026-09-23: a Finder plan without a title acted on the batch's own "content" window.
  assert.equal((await backend.readWindow({ app: "TextEdit", windowId: 3 }, { screenshot: false })).window.title, "draft.txt");
  assert.equal((await backend.readWindow({ app: "TextEdit", windowTitle: "notes", windowId: 3 }, { screenshot: false })).window.windowId, 3);
  await assert.rejects(backend.readWindow({ app: "TextEdit", windowId: 8 }, { screenshot: false }),
    (error: BackendError) => error.code === "window_not_found" && /observed is closed/.test(error.message));
  await assert.rejects(backend.readWindow({ app: "TextEdit", single: true }, { screenshot: false }),
    (error: BackendError) => error.code === "window_ambiguous" && /2 TextEdit windows match: "notes.txt", "draft.txt"/.test(error.message));
  assert.equal((await backend.readWindow({ app: "TextEdit", windowTitle: "draft", single: true }, { screenshot: false })).window.windowId, 3);
  assert.equal((await backend.readWindow({ app: "Finder", single: true }, { screenshot: false })).window.windowId, 4);
});

test("the active application comes from frontmostPid, and list_apps answers only when it fails or cannot tell", async () => {
  for (const [frontmost, active, listApps] of [[async () => 7, true, 0], [async () => 9, false, 0],
    [async () => undefined, false, 1], [async () => { throw new Error("lsappinfo failed"); }, false, 1]] as const) {
    const { calls, run } = recorder({ elements: [] });
    const read = await new LocalDriverBackend({ run, maxTreeNodes: 500, frontmostPid: frontmost }).readWindow({ app: "TextEdit" }, { screenshot: false });
    assert.equal(read.appActive, active);
    assert.equal(calls.filter(call => call.tool === "list_apps").length, listApps);
  }
});

test("a page scroll sends enough wheel notches to move most of the scrolled region", () => {
  // The Finder list's visible part was 384 points tall; one notch moved it 100 points.
  assert.equal(pageNotches(384), 3);
  assert.equal(pageNotches(40), 1, "A small region still scrolls");
  assert.equal(pageNotches(100_000), 50, "The driver accepts at most 50 notches");
});

test("clicks and modifier shortcuts use foreground delivery, and typed characters and scrolls stay in the background", () => {
  const point = { x: 1, y: 1 };
  assert.equal(deliveryFor({ kind: "click", point, button: "left", count: 1 }, true), "foreground");
  assert.equal(deliveryFor({ kind: "key", key: "a", modifiers: ["cmd"] }, true), "foreground", "Cmd+A did nothing in the background");
  assert.equal(deliveryFor({ kind: "key", key: "a", modifiers: [] }, true), "background");
  assert.equal(deliveryFor({ kind: "key", key: "down", modifiers: ["cmd"] }, true), "background", "Cmd+Down worked in the background");
  assert.equal(deliveryFor({ kind: "key", key: "a", modifiers: ["shift"] }, true), "background");
  assert.equal(deliveryFor({ kind: "scroll", point, direction: "down", by: "page", extent: 400 }, true), "background");
  assert.equal(deliveryFor({ kind: "click", point, button: "left", count: 1 }, false), undefined, "Off, the driver default applies");
  assert.equal(deliveryFor({ kind: "click", point, button: "left", count: 1, delivery: "background" }, true), "background", "An explicit choice wins");
});

test("a window nearer the front covers a point, and the driver's overlay covers nothing", async () => {
  const run: DriverRunner = async (tool) => {
    if (tool === "list_apps") return [{ pid: 7, active: true }];
    return { windows: [
      { window_id: 1, pid: 3, app_name: "Safari", title: "Page", is_on_screen: true, layer: 0, z_index: 13, bounds: { x: 300, y: 40, width: 1300, height: 900 } },
      { window_id: 2, pid: 5, app_name: "cua-driver", title: "", is_on_screen: true, layer: 0, z_index: 20, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { window_id: 3, pid: 7, app_name: "TextEdit", title: "scratch.txt", is_on_screen: true, layer: 0, z_index: 36, bounds: { x: 200, y: 80, width: 670, height: 440 } },
      { window_id: 4, pid: 9, app_name: "Finder", title: "Fixture Folder", is_on_screen: true, layer: 0, z_index: 42, bounds: { x: 500, y: 160, width: 920, height: 436 } }] };
  };
  const backend = new LocalDriverBackend({ run, maxTreeNodes: 10 });
  const window = { pid: 7, windowId: 3, app: "TextEdit", title: "scratch.txt" };
  assert.deepEqual(await backend.foreground(window, { x: 540, y: 300 }), { active: true, coveredBy: ["Safari"] });
  assert.deepEqual(await backend.foreground(window, { x: 250, y: 300 }), { active: true, coveredBy: [] });
});
