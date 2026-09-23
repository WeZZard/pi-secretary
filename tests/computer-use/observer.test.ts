import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanName, discardSummary, observe, renderExecutorTable, renderPlannerTable, type Observation } from "../../extensions/secretary/computer-use/observer.ts";
import { finderRead, textEditRead } from "./fixtures/trees.ts";

const options = { id: "obs-test", maxElements: 240, maxNameLength: 48 };
const read = (value: ReturnType<typeof textEditRead>) => ({ ...value, readMs: 0 });
const ready = (result: ReturnType<typeof observe>): Observation => { assert.equal(result.status, "ready"); return result as Observation; };

test("a small window is one group without routing, and every other element is a recorded discard", () => {
  const result = ready(observe(read(textEditRead()), options));
  assert.deepEqual(result.groups.map(group => group.name), ["window"]);
  assert.deepEqual(result.groups[0]!.elements.map(element => [element.letter, element.name]), [["A", "Disposable document text"]]);
  assert.deepEqual(discardSummary(result.discards), { container: 3, no_frame: 2, collapsed_frame: 0, disabled: 0, unnamed: 1, behind_modal: 0, inactive_menu_bar: 0, outside_window: 0 });
  assert.equal(result.discards.length + 1, result.rawCount, "Every raw element is either kept or discarded with a reason");
});

test("a window above 25 elements is grouped by landmark container in reading order", () => {
  const result = ready(observe(read(finderRead()), options));
  assert.deepEqual(result.groups.map(group => [group.name, group.elements.length]), [["toolbar", 6], ["outline", 5], ["list", 20]]);
  assert.equal(result.groups[0]!.elements.find(element => element.name === "New Folder")!.letter, "C");
  const reasons = discardSummary(result.discards);
  assert.equal(reasons.collapsed_frame, 1, "A virtualized row with a 1-point frame is discarded");
  assert.equal(reasons.disabled, 1);
  assert.match(renderExecutorTable(result), /^TOOLBAR\n {2}A Back\n/);
});

test("an oversized group is split in reading order, leaving each element question one alternative for none", () => {
  const result = ready(observe(read(finderRead({ contentItems: 60 })), options));
  const list = result.groups.filter(group => group.name.startsWith("list"));
  assert.deepEqual(list.map(group => [group.name, group.elements.length]), [["list part 1", 25], ["list part 2", 25], ["list part 3", 10]]);
  assert.ok(result.groups.every(group => group.elements.length <= 25));
  assert.equal(list[1]!.elements[0]!.name, "File 26");
});

test("an open sheet is the only group and elements behind it are discarded as behind_modal", () => {
  const result = ready(observe(read(finderRead({ sheet: true })), options));
  assert.deepEqual(result.groups.map(group => group.name), ["window"]);
  assert.deepEqual(result.groups[0]!.elements.map(element => element.name), ["Folder name", "Cancel", "Create"]);
  assert.equal(discardSummary(result.discards).behind_modal, 31);
  assert.match(renderPlannerTable(result), /A TextField "Folder name" value="untitled folder"/);
});

test("truncation, a missing window element, and the element limit are failures, not partial tables", () => {
  const truncated = observe({ ...read(finderRead()), truncated: true }, options);
  assert.equal(truncated.status, "state_too_large");
  const noWindow = read(finderRead());
  noWindow.elements = noWindow.elements.filter(element => element.role !== "AXWindow");
  assert.equal(observe(noWindow, options).status, "window_missing");
  const tooMany = observe(read(finderRead({ contentItems: 60 })), { ...options, maxElements: 50 });
  assert.equal(tooMany.status, "state_too_large");
  assert.match((tooMany as { detail: string }).detail, /71 elements remain after filtering; the limit is 50/);
});

test("a background application's framed menu bar is discarded, and a active one is kept", () => {
  // Recorded 2026-09-23: background TextEdit reported menu-bar frames where Orca's menu bar was drawn.
  const background = textEditRead();
  for (const element of background.elements) if (element.role === "AXMenuBarItem") element.frame = { x: 116, y: 0, w: 42, h: 30 };
  const inactive = ready(observe(read(background), options));
  assert.equal(discardSummary(inactive.discards).inactive_menu_bar, 1);
  assert.ok(!inactive.groups.flatMap(group => group.elements).some(element => element.name === "File"));
  const active = ready(observe(read({ ...background, appActive: true }), options));
  assert.ok(active.groups.flatMap(group => group.elements).some(element => element.name === "File"));
});

test("an element whose center lies outside the window is discarded unless it belongs to a menu", () => {
  const value = textEditRead();
  const text = value.elements.find(element => element.role === "AXTextArea")!;
  text.frame = { x: 2000, y: 900, w: 100, h: 50 };
  const result = ready(observe(read(value), options));
  assert.equal(discardSummary(result.discards).outside_window, 1);
});

test("names drop automatic identifiers, collapse whitespace, and are truncated", () => {
  assert.equal(cleanName("_NS:834", 48), undefined);
  assert.equal(cleanName("  Save \n As…  ", 48), "Save As…");
  assert.equal(cleanName("x".repeat(60), 10), `${"x".repeat(9)}…`);
});

test("named elements below the visible part of a container are counted as hidden on that group", () => {
  const small = finderRead();
  small.elements.find(element => element.role === "AXWindow")!.frame = { x: 0, y: 0, w: 1200, h: 400 };
  const single = ready(observe(read(small), options));
  assert.deepEqual(single.groups.map(group => [group.name, group.elements.length, group.hidden]), [["window", 25, 6]], "Rows centered below y = 400 are hidden");

  const large = finderRead({ contentItems: 40 });
  large.elements.find(element => element.role === "AXWindow")!.frame = { x: 0, y: 0, w: 1200, h: 600 };
  const grouped = ready(observe(read(large), options));
  assert.equal(grouped.groups.find(group => group.name === "list")!.hidden, 17);
  assert.equal(grouped.groups.find(group => group.name === "toolbar")!.hidden, undefined);
});
