import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Value } from "typebox/value";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowRead } from "../../extensions/secretary/vm-use/backend/backend.ts";
import { FakeBackend } from "../../extensions/secretary/vm-use/backend/fake-backend.ts";
import { defaultVmUseConfiguration } from "../../extensions/secretary/vm-use/configuration.ts";
import type { DecisionResponse } from "../../extensions/secretary/vm-use/decision-service-client.ts";
import { Telemetry } from "../../extensions/secretary/vm-use/telemetry.ts";
import { observe, type Observation } from "../../extensions/secretary/vm-use/observer.ts";
import { executeObserve } from "../../extensions/secretary/vm-use/tools/observe.ts";
import { executeRunPlan, formatResult, type RunPlanContext } from "../../extensions/secretary/vm-use/tools/run-plan.ts";
import { runPlanSchema } from "../../extensions/secretary/vm-use/tools/schemas.ts";
import { fakePlanChecker } from "./support/plan-checker.ts";

const form: Omit<WindowRead, "readMs"> = { window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements: [
  { element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
  { element_index: 1, role: "AXButton", label: "Submit", parent_index: 0, depth: 1, frame: { x: 100, y: 50, w: 80, h: 20 } }] };

const formObservation = observe({ ...form, readMs: 0 }, { id: "obs-1", maxElements: 240, maxNameLength: 48 }) as Observation;

function context(t: TestContext, used = 0) {
  const root = mkdtempSync(join(tmpdir(), "secretary-run-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let recorded = 0;
  const remembered: string[] = [];
  const grounder = { decide: async (): Promise<DecisionResponse> => ({ roundTripMs: 1, answers: { operation: { choice: "abstain", confidence: 0.9 } } }) };
  const ctx: RunPlanContext = { deps: { backend: new FakeBackend({ Form: [form] }), grounder, telemetry: new Telemetry(root), config: { ...defaultVmUseConfiguration(), settleMs: 0 }, sleep: async () => {}, newId: () => "run-1" },
    observation: (id: string) => id === "obs-1" ? formObservation : undefined, escalations: { used, limit: 2, record: () => { recorded++; } } };
  // The read after the plan goes through vm_observe's routine, with the backend the test last set.
  ctx.observeAfter = (target, signal) => executeObserve({ backend: ctx.deps.backend, config: ctx.deps.config, telemetry: ctx.deps.telemetry,
    remember: observation => { remembered.push(observation.id); }, newId: () => "obs-after" }, target, true, signal);
  return { root, recorded: () => recorded, remembered, context: ctx };
}

const params = { app: "Form", goal: "Submit the form", steps: [{ id: "submit", intent: "Submit the form" }] };
const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

test("an escalated plan returns the reason, the prior and the window after the plan, and counts toward the limit", async (t) => {
  const { context: ctx, recorded } = context(t);
  const result = await executeRunPlan(ctx, params);
  assert.deepEqual(result.details, { runId: "run-1", outcome: "escalated", decisions: 1, actions: 0, escalation: "target_not_found", observationId: "obs-after" });
  assert.match(text(result), /^Outcome: escalated\. Grounder decisions: 1\. Actions: 0\.\n- submit: stopped\n/);
  assert.match(text(result), /Escalation at step submit: target_not_found\./);
  assert.match(text(result), /The window after the plan\. Judge the result from it; no step above was checked\. The next plan's based_on is its Observation\.\nApplication: Form\nWindow: "Form"\nObservation: obs-after\n/);
  assert.match(text(result), /window:\n {2}A Button "Submit"/);
  assert.equal(recorded(), 1);
});

test("a completed plan carries the window after it, with its screenshot and an observation id a next plan can name (design §5.4)", async (t) => {
  const { context: ctx, remembered } = context(t);
  const screenshot = { data: Buffer.from("after").toString("base64"), mimeType: "image/png" };
  const done: typeof form = { ...form, elements: [form.elements[0]!, { ...form.elements[1]!, label: "Done" }], screenshot, evidence: ["vu-0009"] };
  ctx.deps.backend = new FakeBackend({ Form: [form, done] });
  ctx.deps.grounder = { decide: async () => ({ roundTripMs: 1, answers: { element_1: { choice: "A", confidence: 0.9 }, operation: { choice: "click", confidence: 0.9 } } }) };
  const result = await executeRunPlan(ctx, params);
  assert.deepEqual(result.details, { runId: "run-1", outcome: "completed", decisions: 1, actions: 1, observationId: "obs-after" });
  // The result names its plan record, and the read's record keeps its relay steps, so the trajectory finds both (design §12.3).
  const { root } = ctx.deps.telemetry;
  assert.equal(JSON.parse(readFileSync(join(root, "runs", "run-1", "plan.json"), "utf8")).runId, "run-1");
  assert.deepEqual(JSON.parse(readFileSync(join(root, "observations", "obs-after.json"), "utf8")).evidence, ["vu-0009"]);
  assert.match(text(result), /^Outcome: completed\. Grounder decisions: 1\. Actions: 1\.\n- submit: acted, click "Submit"\n\nThe window after the plan\./);
  assert.match(text(result), /A Button "Done"/);
  assert.deepEqual(result.content[1], { type: "image", ...screenshot });
  assert.deepEqual(remembered, ["obs-after"]);
});

test("a cancelled plan reads nothing more", async (t) => {
  const { context: ctx, remembered } = context(t);
  const controller = new AbortController();
  ctx.deps.grounder = { decide: async () => { controller.abort(); return { roundTripMs: 1, answers: { element_1: { choice: "A", confidence: 0.9 }, operation: { choice: "click", confidence: 0.9 } } }; } };
  const result = await executeRunPlan(ctx, params, controller.signal);
  assert.deepEqual([result.details.outcome, result.content.length, remembered], ["cancelled", 1, []]);
  assert.doesNotMatch(text(result), /The window after the plan/);
});

test("plans are rejected before execution for an unknown observation, a malformed step, or an exhausted escalation budget", async (t) => {
  const unknown = await executeRunPlan(context(t).context, { ...params, based_on: "obs-9" });
  assert.match((unknown.content[0] as { text: string }).text, /observation "obs-9" is unknown or expired/);
  const malformed = await executeRunPlan(context(t).context, { ...params, steps: [{ id: "a", intent: "i", action: "type" }] as never });
  assert.match((malformed.content[0] as { text: string }).text, /^Plan rejected: step a: type needs text/);
  const exhausted = await executeRunPlan(context(t, 2).context, params);
  assert.match((exhausted.content[0] as { text: string }).text, /already returned 2 escalations/);
  assert.equal(exhausted.details.outcome, "rejected");
});

test("every rejection writes a record with the rule that fired", async (t) => {
  const { context: ctx, root } = context(t);
  const typed = { ...params, steps: [{ id: "a", intent: "Type", text: "secret words", keys: "cmd+a" }] };
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

test("a result lists what each step did, and judges none of them", () => {
  assert.equal(formatResult({ runId: "run-1", outcome: "escalated", decisions: 2, actions: 1, steps: [
    { id: "a", result: "acted", action: "click", element: "Submit" },
    { id: "b", result: "stopped", detail: "uncertain: the grounder could not choose" },
    { id: "c", result: "not_run" }], escalation: { stepId: "b", reason: "uncertain", detail: "the grounder could not choose" } }),
  "Outcome: escalated. Grounder decisions: 2. Actions: 1.\n- a: acted, click \"Submit\"\n- b: stopped\n- c: not run\n\nEscalation at step b: uncertain. the grounder could not choose");
});

test("a plan whose window changed since based_on stops with window_changed before any grounder request (design §9)", async (t) => {
  const { context: ctx } = context(t);
  const changed = { ...form, elements: form.elements.filter(element => element.label !== "Submit") };
  ctx.deps.backend = new FakeBackend({ Form: [changed] });
  let asked = 0;
  ctx.deps.grounder = { decide: async () => { asked++; throw new Error("not reached"); } };
  const result = await executeRunPlan(ctx, { ...params, based_on: "obs-1" });
  assert.equal(result.details.escalation, "window_changed");
  assert.match((result.content[0] as { text: string }).text, /window changed since the observation the plan was based on: 1 UI element\(s\) are gone: AXButton "Submit"\. No action was taken/);
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

test("when the window after the plan cannot be read, the result tells the planner to observe first", async (t) => {
  const { context: ctx } = context(t);
  ctx.deps.backend = new FakeBackend({ Form: [form, new Error("driver failed") as never] });
  const result = await executeRunPlan(ctx, params);
  assert.match(text(result), /The window after the plan could not be read, so call vm_observe before the next plan\.\nObservation failed: driver failed/);
  assert.equal(result.details.observationId, undefined);
});

test("a plan may give the mode none or online, and no approval list; the online check reads the delegated request (design §8.1, decisions PS-D53 and PS-D54)", async (t) => {
  for (const extra of [{ permission_check: { level: "none", quote: "without permission checks" } }, { permission_check: "guardian" }, { ask_before: "sending" }]) {
    assert.equal(Value.Check(runPlanSchema, { ...params, ...extra }), false, JSON.stringify(extra));
  }
  for (const extra of [{}, { permission_check: "none" }, { permission_check: "online" }]) assert.equal(Value.Check(runPlanSchema, { ...params, ...extra }), true, JSON.stringify(extra));
  const { context: ctx } = context(t);
  ctx.request = "Submit the form, and ask me first.";
  const checker = fakePlanChecker(() => ({ reach: "guest", requested: "yes" }));
  ctx.deps = { ...ctx.deps, config: { ...ctx.deps.config, permissionCheck: "online", permissionOnline: { url: "http://localhost/v1/chat/completions", model: "test", timeoutMs: 1000 } }, online: checker };
  const result = await executeRunPlan(ctx, params);
  assert.equal(checker.states[0]!.request, "Submit the form, and ask me first.");
  assert.deepEqual([result.details.outcome, (ctx.deps.backend as FakeBackend).reads.length > 0], ["escalated", true], "Only the read after the plan reads the window");
  assert.match(text(result), /approval_required/);
  assert.match(text(result), /the task asked for approval before this kind of step/);
});

test("a plan that asks for the mode online without an online API is rejected before any read (design §5.2, decision PS-D54)", async (t) => {
  const { context: ctx, root } = context(t);
  const result = await executeRunPlan(ctx, { ...params, permission_check: "online" });
  assert.deepEqual([result.details.outcome, result.details.rule, (ctx.deps.backend as FakeBackend).reads.length], ["rejected", "permission_check_unavailable", 0]);
  assert.match(text(result), /no online API is configured for it\. Stop and report that the check cannot run/);
  assert.deepEqual(readdirSync(join(root, "rejections")).length, 1);
  const turnedOff = await executeRunPlan(ctx, { ...params, permission_check: "none" });
  assert.equal(turnedOff.details.outcome, "escalated", "The mode none needs nothing configured");
  assert.equal(JSON.parse(readFileSync(join(root, "runs", "run-1", "plan.json"), "utf8")).permissionCheckSource, "request");
});
