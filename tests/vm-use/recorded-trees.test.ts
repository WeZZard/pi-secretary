import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WindowRead } from "../../extensions/secretary/vm-use/backend/backend.ts";
import { discardSummary, observe, type Observation } from "../../extensions/secretary/vm-use/observer.ts";
import { buildDecisionRequest } from "../../extensions/secretary/vm-use/request-builder.ts";

/**
 * Trees recorded on 2026-09-23 with cua-driver 0.12.6 (plan Phase 2), redacted: closed-menu
 * item labels are replaced, and the test page's file path is neutral. `reminders-new-list` is the
 * read of 2026-09-30 in a relay machine, where nothing needed redacting. They pin how the
 * observer treats real trees; they are not evidence of grounder accuracy.
 */
const load = (name: string): WindowRead => ({ ...JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/trees", `${name}.json`), "utf8")), readMs: 0 });
const observed = (name: string) => {
  const result = observe(load(name), { id: name, maxElements: 240, maxNameLength: 48 });
  assert.equal(result.status, "ready");
  return result as Observation;
};
const names = (observation: Observation) => observation.groups.flatMap(group => group.elements.map(element => element.name));

test("Calculator in programmer mode: 106 buttons without containers split into 25-element parts", () => {
  const result = observed("calculator");
  assert.deepEqual(result.groups.map(group => [group.name, group.elements.length]),
    [["toolbar", 1], ["content part 1", 25], ["content part 2", 25], ["content part 3", 25], ["content part 4", 25], ["content part 5", 7]]);
  for (const target of ["7", "Add", "Equals", "All Clear"]) assert.ok(names(result).includes(target), target);
  assert.equal(discardSummary(result.discards).no_frame, 194, "Closed menu items are discarded");
});

test("Safari test page: the web area's links and form UI elements are kept, and closed menus dominate the raw tree", () => {
  const read = load("safari-support-page");
  const result = observed("safari-support-page");
  assert.deepEqual(result.groups.map(group => [group.name, group.elements.length]), [["toolbar", 8], ["content part 1", 25], ["content part 2", 25], ["content part 3", 25]]);
  for (const target of ["Billing history", "Submit", "Email", "Send me a copy", "Sign out everywhere"]) assert.ok(names(result).includes(target), target);
  assert.ok(discardSummary(result.discards).no_frame > read.elements.length * 0.9, "Over 90 percent of the walked nodes are closed-menu items");
});

test("region descriptions list member names, and every recorded request fits the grounder's limits", () => {
  for (const name of ["calculator", "safari-support-page"]) {
    const built = buildDecisionRequest({ goal: "g", step: { id: "s", intent: "i" }, observation: observed(name), recent: [] });
    assert.equal(built.status, "ready");
    if (built.status !== "ready") continue;
    assert.match(String(built.body.questions.region!.criteria["content part 1"]), /^Contains: /);
    for (const question of Object.values(built.body.questions)) assert.ok(Object.keys(question.criteria).length <= 26);
  }
});

test("Reminders' New List sheet: the name field without a name is offered to the grounder (MacArena 4ff150c8, 2026-09-30)", () => {
  const result = observed("reminders-new-list");
  const field = result.groups.flatMap(group => group.elements).find(element => element.index === 30);
  assert.ok(field, "The sheet's only text field, labelled only by the automatic identifier _NS:146, is kept");
  assert.equal(field.role, "AXTextField");
  const built = buildDecisionRequest({ goal: "Create a list named Project Alpha", step: { id: "s2", intent: "Type the list name Project Alpha", action: "type", text: "Project Alpha" },
    observation: result, recent: [] });
  assert.equal(built.status, "ready");
  if (built.status !== "ready") return;
  assert.match(String((built.body.state as Record<string, unknown>).elements), new RegExp(`${field.letter} TextField \\(no name\\) near "New List Name:"`));
  assert.ok(Object.values(built.body.questions).some(question => field.letter in question.criteria), "The field is an answer the grounder can choose");
});

test("the whole tree outline shows the New List sheet's label beside its field, and what the table leaves out (PS-D28)", () => {
  const result = observed("reminders-new-list");
  const built = buildDecisionRequest({ goal: "Create a list named Project Alpha", step: { id: "s2", intent: "Type the list name Project Alpha", action: "type", text: "Project Alpha" },
    observation: result, recent: [], elementDetail: "tree" });
  const elements = String((built.body.state as Record<string, unknown>).elements);
  assert.match(elements, /\n {2}Sheet \(no name\)\n {4}text "New List Name:"\n {4}\[A\] TextField \(no name\)\n/, "The label precedes the field inside the sheet");
  assert.match(elements, /\n {4}Button "OK" disabled\n/, "A disabled UI element is in the outline, without a letter");
  assert.match(elements, /\n {4}Button "Add List" disabled\n/, "The window behind the sheet is in the outline");
  assert.match(elements, /MenuItem "[^"]+" off screen/, "Closed menu items are in the outline");
  assert.equal(elements.split("\n").length, result.outline.length);
  assert.equal(built.trimStep, 0);
  assert.ok(built.estimatedTokens > 4096, "The outline does not fit the former 4,096-token model length");
});
