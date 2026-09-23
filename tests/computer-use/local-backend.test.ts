import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { BackendError } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { LocalDriverBackend, type DriverRunner } from "../../extensions/secretary/computer-use/backend/local-backend.ts";

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
  assert.deepEqual(read.window, { pid: 7, windowId: 3, app: "TextEdit", title: "draft.txt" });
  assert.equal(read.appActive, false, "Finder is the active application");
  assert.deepEqual(calls[2], { tool: "get_window_state", args: { pid: 7, window_id: 3, max_elements: 500, include_screenshot: false } });
  assert.equal(read.truncated, false);
  assert.equal(read.screenshot, undefined);
  assert.deepEqual(calls.map(call => call.tool), ["list_windows", "list_apps", "get_window_state"], "Reading never launches, focuses, or clicks");
});

test("a title filter selects the window, and a screenshot is returned as base64 PNG", async () => {
  const { calls, run } = recorder({ elements: [], element_count: 0 });
  const read = await new LocalDriverBackend({ run, maxTreeNodes: 500 }).readWindow({ app: "TextEdit", windowTitle: "NOTES" }, { screenshot: true });
  assert.equal(read.window.windowId, 2);
  const finder = await new LocalDriverBackend({ run, maxTreeNodes: 500 }).readWindow({ app: "Finder" }, { screenshot: false });
  assert.equal(finder.appActive, true);
  assert.equal(typeof calls[2]!.args.screenshot_out_file, "string");
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
