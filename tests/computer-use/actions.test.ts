import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION_NAMES, MACOS_ACTIONS, toAction } from "../../extensions/secretary/computer-use/actions.ts";
import { planStepSchema } from "../../extensions/secretary/computer-use/tools/schemas.ts";
import { toPlan } from "../../extensions/secretary/computer-use/tools/run-plan.ts";

/** Plan phase 1.3: one closed allowlist of actions for macOS (design §7.2, decision PS-D7). */

test("the macOS allowlist has the seven actions of the design, and the names before it are aliases", () => {
  assert.deepEqual(ACTION_NAMES, ["click", "double_click", "right_click", "type", "key", "scroll_up", "scroll_down"]);
  assert.deepEqual(["press", "double_press", "context_press", "enter_text", "key_combo"].map(toAction), ["click", "double_click", "right_click", "type", "key"]);
  assert.equal(toAction("scroll_down"), "scroll_down");
  assert.equal(toAction("tap"), undefined, "iOS actions are not built yet");
});

test("the planner reads every action's definition in the tool schema", () => {
  const description = (planStepSchema.properties.action as unknown as { description: string }).description;
  for (const entry of MACOS_ACTIONS) assert.ok(description.includes(`${entry.name}: ${entry.definition}`), entry.name);
});

test("a plan step's action comes from action, or from the older operation field and names", () => {
  const plan = toPlan({ app: "TextEdit", goal: "g", steps: [
    { id: "a", intent: "Open", action: "double_click", postcondition: { changed: true } },
    { id: "b", intent: "Type", operation: "enter_text", text: "Hi", postcondition: { changed: true } },
    { id: "c", intent: "Save", operation: "key", keys: "cmd+s", postcondition: { changed: true } },
    { id: "d", intent: "Look", postcondition: { changed: true } },
  ] } as Parameters<typeof toPlan>[0]);
  assert.deepEqual(plan.steps.map(step => step.action), ["double_click", "type", "key", undefined]);
});
