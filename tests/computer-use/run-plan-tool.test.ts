import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { FakeBackend } from "../../extensions/secretary/computer-use/backend/fake-backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import type { DecisionResponse } from "../../extensions/secretary/computer-use/executor-client.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";
import { observe, type Observation } from "../../extensions/secretary/computer-use/observer.ts";
import { executeRunPlan, formatResult } from "../../extensions/secretary/computer-use/tools/run-plan.ts";

const form: Omit<WindowRead, "readMs"> = { window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements: [
  { element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
  { element_index: 1, role: "AXButton", label: "Submit", parent_index: 0, depth: 1, frame: { x: 100, y: 50, w: 80, h: 20 } }] };

const formObservation = observe({ ...form, readMs: 0 }, { id: "obs-1", maxElements: 240, maxNameLength: 48 }) as Observation;

function context(t: TestContext, used = 0) {
  const root = mkdtempSync(join(tmpdir(), "secretary-run-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let recorded = 0;
  const executor = { decide: async (): Promise<DecisionResponse> => ({ roundTripMs: 1, answers: { operation: { choice: "abstain", confidence: 0.9 } } }) };
  return {
    root,
    recorded: () => recorded,
    context: { deps: { backend: new FakeBackend({ Form: [form] }), executor, telemetry: new Telemetry(root), config: { ...defaultComputerUseConfiguration(), settleMs: 0 }, sleep: async () => {} },
      observation: (id: string) => id === "obs-1" ? formObservation : undefined, escalations: { used, limit: 2, record: () => { recorded++; } } },
  };
}

const params = { app: "Form", goal: "Submit the form", steps: [{ id: "submit", intent: "Submit the form", postcondition: { exists: { name: "Done" } } }] };

test("an escalated plan returns the reason, the prior and the current window, and counts toward the limit", async (t) => {
  const { context: ctx, recorded } = context(t);
  const result = await executeRunPlan(ctx, params);
  assert.deepEqual(result.details, { outcome: "escalated", decisions: 1, actions: 0, escalation: "target_not_found" });
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /^Outcome: escalated\. Executor decisions: 1\. Actions: 0\./);
  assert.match(text, /Escalation at step submit: target_not_found\./);
  assert.match(text, /Current window:\nwindow:\n {2}A Button "Submit"/);
  assert.equal(recorded(), 1);
});

test("plans are rejected before execution for an unknown observation, a malformed step, or an exhausted escalation budget", async (t) => {
  const unknown = await executeRunPlan(context(t).context, { ...params, based_on: "obs-9" });
  assert.match((unknown.content[0] as { text: string }).text, /observation "obs-9" is unknown or expired/);
  const malformed = await executeRunPlan(context(t).context, { ...params, steps: [{ id: "a", intent: "i", postcondition: { focused: { name: "x" } } }] });
  assert.match((malformed.content[0] as { text: string }).text, /^Plan rejected: step a: focused is not supported/);
  const exhausted = await executeRunPlan(context(t, 2).context, params);
  assert.match((exhausted.content[0] as { text: string }).text, /already returned 2 escalations/);
  assert.equal(exhausted.details.outcome, "rejected");
});

test("every rejection writes a record with the rule that fired", async (t) => {
  const { context: ctx, root } = context(t);
  const typed = { ...params, steps: [{ id: "a", intent: "Type", text: "secret words", keys: "cmd+a", postcondition: { changed: true } }] };
  const result = await executeRunPlan(ctx, typed);
  assert.equal(result.details.rule, "text_and_keys");
  await executeRunPlan(ctx, { ...params, based_on: "obs-9" });
  const files = readdirSync(join(root, "rejections"));
  const records = files.map(file => JSON.parse(readFileSync(join(root, "rejections", file), "utf8")));
  assert.deepEqual(records.map(record => record.rule).sort(), ["text_and_keys", "unknown_observation"]);
  assert.equal(records.find(record => record.rule === "text_and_keys").plan.steps[0].text, "<12 characters>", "Typed text is redacted as in plan records");
});

test("a plan based on an observation acts on that observation's window", async (t) => {
  const { context: ctx } = context(t);
  await executeRunPlan(ctx, { ...params, based_on: "obs-1" });
  assert.deepEqual((ctx.deps.backend as FakeBackend).reads[0], { app: "Form", windowId: form.window.windowId, single: true });
});

test("a completed result lists each step compactly", () => {
  assert.equal(formatResult({ outcome: "completed", decisions: 1, actions: 1, steps: [
    { id: "a", result: "verified", action: "click", element: "Submit", detail: "\"Done\" is on screen" },
    { id: "b", result: "skipped", detail: "the postcondition already held" }] }),
  "Outcome: completed. Executor decisions: 1. Actions: 1.\n- a: verified, click \"Submit\" (\"Done\" is on screen)\n- b: skipped (the postcondition already held)");
});

test("a text check for a string that is also a control's name reaches the runtime (decision PS-D3)", async (t) => {
  const result = await executeRunPlan(context(t).context, { ...params, based_on: "obs-1",
    steps: [{ id: "submit", intent: "Submit", postcondition: { text: { contains: "Submit" } } }] });
  assert.equal(result.details.outcome, "escalated", "The plan ran; the scripted executor abstained");
});

test("the result lists what code verified, separately from steps that only changed the screen", () => {
  const plan = { target: { app: "Form" }, goal: "g", allowDestructive: [], steps: [
    { id: "a", intent: "i", postcondition: { text: { contains: "10" } } }, { id: "b", intent: "i", postcondition: { changed: true as const } }] };
  const text = formatResult({ outcome: "completed", decisions: 2, actions: 2, steps: [
    { id: "a", result: "verified", action: "click" }, { id: "b", result: "weakly_verified", action: "click" }] }, plan);
  assert.match(text, /Verified by code after the step \(report only these facts as checked\):\n- a: \{"text":\{"contains":"10"\}\} held/);
  assert.match(text, /Not verified \(only a change on screen was seen\):\n- b$/);
});

test("a plan whose window changed since based_on stops with window_changed before any executor request (design §9)", async (t) => {
  const { context: ctx } = context(t);
  const changed = { ...form, elements: form.elements.filter(element => element.label !== "Submit") };
  ctx.deps.backend = new FakeBackend({ Form: [changed] });
  let asked = 0;
  ctx.deps.executor = { decide: async () => { asked++; throw new Error("not reached"); } };
  const result = await executeRunPlan(ctx, { ...params, based_on: "obs-1" });
  assert.equal(result.details.escalation, "window_changed");
  assert.match((result.content[0] as { text: string }).text, /window changed since the observation the plan was based on: 1 control\(s\) are gone: AXButton "Submit"\. No action was taken/);
  assert.equal(asked, 0);
});

test("the start check accepts the window our previous plan left, when that plan ran after based_on", async (t) => {
  const { context: ctx } = context(t);
  const done: typeof form = { ...form, elements: [form.elements[0]!, { ...form.elements[1]!, label: "Done" }] };
  ctx.deps.backend = new FakeBackend({ Form: [done] });
  const doneObservation = observe({ ...done, readMs: 0 }, { id: "run-1-003", maxElements: 240, maxNameLength: 48 }) as Observation;
  const stopped = await executeRunPlan(ctx, { ...params, based_on: "obs-1" });
  assert.equal(stopped.details.escalation, "window_changed", "without a later plan read, the change is unexplained");
  const accepted = await executeRunPlan({ ...ctx, deps: { ...ctx.deps, backend: new FakeBackend({ Form: [done] }) }, previousPlanRead: () => doneObservation }, { ...params, based_on: "obs-1" });
  assert.notEqual(accepted.details.escalation, "window_changed");
});
