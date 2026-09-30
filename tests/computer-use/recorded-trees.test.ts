import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { discardSummary, observe, type Observation } from "../../extensions/secretary/computer-use/observer.ts";
import { buildDecisionRequest } from "../../extensions/secretary/computer-use/request-builder.ts";

/**
 * Trees recorded on 2026-09-23 with cua-driver 0.12.6 (plan Phase 2), redacted: closed-menu
 * item labels are replaced, and the test page's file path is neutral. They pin how the
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
    [["toolbar", 1], ["content part 1", 25], ["content part 2", 25], ["content part 3", 25], ["content part 4", 25], ["content part 5", 5]]);
  for (const target of ["7", "Add", "Equals", "All Clear"]) assert.ok(names(result).includes(target), target);
  assert.equal(discardSummary(result.discards).no_frame, 194, "Closed menu items are discarded");
});

test("Safari test page: the web area's links and form UI elements are kept, and closed menus dominate the raw tree", () => {
  const read = load("safari-support-page");
  const result = observed("safari-support-page");
  assert.deepEqual(result.groups.map(group => [group.name, group.elements.length]), [["toolbar", 8], ["content part 1", 25], ["content part 2", 25], ["content part 3", 22]]);
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
