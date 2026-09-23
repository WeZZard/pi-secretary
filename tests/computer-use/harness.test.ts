import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendError, type RawElement, type WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { FakeBackend } from "../../extensions/secretary/computer-use/backend/fake-backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import { ExecutorError, type DecisionRequestBody, type DecisionResponse } from "../../extensions/secretary/computer-use/executor-client.ts";
import { labelUsedAsText, runPlan, validatePlan, type Plan } from "../../extensions/secretary/computer-use/harness.ts";
import { observe } from "../../extensions/secretary/computer-use/observer.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";

type Read = Omit<WindowRead, "readMs">;
/** A small window: every listed control is a kept element in one group, lettered in reading order. */
function window(controls: { role?: string; name: string; value?: string }[]): Read {
  const elements: RawElement[] = [{ element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } }];
  controls.forEach((control, i) => elements.push({ element_index: i + 1, role: control.role ?? "AXButton", label: control.name,
    ...(control.value !== undefined ? { value: control.value } : {}), parent_index: 0, depth: 1, frame: { x: 100, y: 50 + i * 40, w: 80, h: 20 } }));
  return { window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements };
}

/** A scripted executor: answers name an element by its name, which the test maps to a letter. */
function executor(script: (body: DecisionRequestBody, call: number) => { element?: string; operation: string; risk?: string; confidence?: number } | Error) {
  const bodies: DecisionRequestBody[] = [];
  return { bodies, decide: async (body: DecisionRequestBody): Promise<DecisionResponse> => {
    bodies.push(body);
    const answer = script(body, bodies.length);
    if (answer instanceof Error) throw answer;
    const confidence = answer.confidence ?? 0.9;
    const table = String((body.state as { elements: string }).elements);
    const letter = answer.element ? table.split("\n").find(line => line.slice(4) === answer.element)?.trim()[0] ?? "none" : "none";
    return { roundTripMs: 1, answers: { element_1: { choice: letter, confidence }, operation: { choice: answer.operation, confidence }, risk: { choice: answer.risk ?? "safe", confidence } } };
  } };
}

function setup(t: TestContext, reads: (Read | Error)[], overrides: Partial<ReturnType<typeof defaultComputerUseConfiguration>> = {}) {
  const root = mkdtempSync(join(tmpdir(), "secretary-harness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backend = new FakeBackend({ Form: reads });
  const config = { ...defaultComputerUseConfiguration(), settleMs: 0, ...overrides };
  return { backend, root, deps: (exec: ReturnType<typeof executor>) => ({ backend, executor: exec, telemetry: new Telemetry(root), config, sleep: async () => {}, newId: () => "run-1" }) };
}

const plan = (steps: Plan["steps"], allowDestructive: string[] = []): Plan => ({ target: { app: "Form" }, goal: "Fill the form", steps, allowDestructive });
const submitted = window([{ name: "Done" }]);
const form = window([{ name: "Submit" }, { name: "Cancel" }]);

test("a plan completes: one request per step, a real click at the element center, and a verified postcondition", async (t) => {
  const { backend, deps } = setup(t, [form, submitted]);
  const exec = executor(() => ({ element: "Submit", operation: "press" }));
  const result = await runPlan(deps(exec), plan([{ id: "submit", intent: "Submit the form", postcondition: { exists: { name: "Done" } } }]));
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.steps, [{ id: "submit", result: "verified", action: "press", element: "Submit", detail: "\"Done\" is on screen" }]);
  assert.deepEqual([result.decisions, result.actions], [1, 1]);
  assert.deepEqual(backend.actions.map(entry => entry.action), [{ kind: "click", point: { x: 140, y: 60 }, button: "left", count: 1 }]);
  assert.ok(!("depends_on" in exec.bodies[0]!.questions.operation!));
});

test("a postcondition that already holds stops the plan with already_satisfied before any request or action", async (t) => {
  // Observed through Pi on 2026-09-23: "text contains 7" held before the Add step, so Add was skipped.
  const { backend, deps } = setup(t, [submitted]);
  const exec = executor(() => { throw new Error("must not be called"); });
  const result = await runPlan(deps(exec), plan([{ id: "submit", intent: "Submit", postcondition: { exists: { name: "Done" } } }]));
  assert.deepEqual([result.outcome, result.escalation!.reason, result.decisions, backend.actions.length], ["escalated", "already_satisfied", 0, 0]);
  assert.match(result.escalation!.detail, /cannot show that the step worked/);
});

test("an idempotent step whose postcondition already holds is skipped without an executor request", async (t) => {
  const { deps } = setup(t, [submitted]);
  const exec = executor(() => { throw new Error("must not be called"); });
  const result = await runPlan(deps(exec), plan([{ id: "submit", intent: "Submit", idempotent: true, postcondition: { exists: { name: "Done" } } }]));
  assert.deepEqual([result.outcome, result.steps[0]!.result, result.decisions], ["completed", "skipped", 0]);
});

test("a failed postcondition is retried and then escalated as postcondition_failed", async (t) => {
  const { deps } = setup(t, [form, window([{ name: "Submit" }, { name: "Cancel" }, { name: "Error" }]), window([{ name: "Submit" }, { name: "Cancel" }, { name: "Error 2" }])]);
  const result = await runPlan(deps(executor(() => ({ element: "Submit", operation: "press" }))), plan([{ id: "s", intent: "Submit", postcondition: { exists: { name: "Done" } } }]));
  assert.equal(result.outcome, "escalated");
  assert.deepEqual([result.escalation!.reason, result.actions], ["postcondition_failed", 2]);
  assert.match(result.escalation!.observation!, /A Button "Submit"/, "An escalation carries a fresh observation for replanning");
});

test("an action that changes nothing on screen is not repeated and escalates no_progress", async (t) => {
  // Observed through Pi on 2026-09-23: invisible clicks and keys were each sent twice.
  const { backend, deps } = setup(t, [form]);
  const result = await runPlan(deps(executor(() => ({ element: "Submit", operation: "press" }))),
    plan([{ id: "s", intent: "Submit", maxAttempts: 5, postcondition: { exists: { name: "Done" } } }]));
  assert.deepEqual([result.escalation!.reason, result.actions, backend.actions.length], ["no_progress", 1, 1]);
  assert.match(result.escalation!.detail, /changed nothing on screen; it was not repeated/);
});

test("policy escalations stop the plan with their reason and prior", async (t) => {
  const abstain = setup(t, [form]);
  const notFound = await runPlan(abstain.deps(executor(() => ({ operation: "abstain" }))), plan([{ id: "s", intent: "Open settings", postcondition: { exists: { name: "Settings" } } }]));
  assert.equal(notFound.escalation!.reason, "target_not_found");
  const risky = setup(t, [form]);
  const approval = await runPlan(risky.deps(executor(() => ({ element: "Submit", operation: "press", risk: "destructive" }))),
    plan([{ id: "s", intent: "Submit", postcondition: { exists: { name: "Done" } } }]));
  assert.deepEqual([approval.escalation!.reason, approval.escalation!.prior?.element, risky.backend.actions.length], ["approval_required", "Submit", 0]);
  const allowed = setup(t, [form, submitted]);
  const done = await runPlan(allowed.deps(executor(() => ({ element: "Submit", operation: "press", risk: "destructive" }))),
    plan([{ id: "s", intent: "Submit", postcondition: { exists: { name: "Done" } } }], ["s"]));
  assert.equal(done.outcome, "completed", "allowDestructive authorizes the named step");
});

test("executor failure, untypeable text and backend failure escalate without replaying an action", async (t) => {
  const down = setup(t, [form]);
  const unavailable = await runPlan(down.deps(executor(() => new ExecutorError("timeout", "the executor did not answer within 10000 ms"))),
    plan([{ id: "s", intent: "Submit", postcondition: { exists: { name: "Done" } } }]));
  assert.deepEqual([unavailable.escalation!.reason, unavailable.decisions], ["executor_unavailable", 0]);

  const huge = setup(t, [form]);
  const tooLong = new ExecutorError("too_large", "the request does not fit the executor's model length");
  const oversize = await runPlan(huge.deps(executor(() => tooLong)), plan([{ id: "s", intent: "Submit", postcondition: { exists: { name: "Done" } } }]));
  assert.deepEqual([oversize.escalation!.reason, oversize.decisions], ["state_too_large", 0], "Without history, the executor's length rejection is final");

  const text = setup(t, [window([{ role: "AXTextField", name: "Email" }])]);
  const needsText = await runPlan(text.deps(executor(() => ({ element: "Email", operation: "enter_text" }))),
    plan([{ id: "s", intent: "Enter the email", text: "a@b.c", postcondition: { value: { name: "Email", equals: "a@b.c" } } }]));
  assert.deepEqual([needsText.escalation!.reason, text.backend.actions.length], ["needs_text", 0], "A refused literal sends no partial input");

  const broken = setup(t, [form, submitted]);
  broken.backend.actionFailures.push(new BackendError("driver_failed", "cua-driver click failed"));
  const failed = await runPlan(broken.deps(executor(() => ({ element: "Submit", operation: "press" }))), plan([{ id: "s", intent: "Submit", postcondition: { exists: { name: "Done" } } }]));
  assert.deepEqual([failed.escalation!.reason, failed.actions, broken.backend.actions.length], ["backend_failed", 0, 0]);
});

test("a request the executor finds too long is sent once more without history", async (t) => {
  const next = window([{ name: "Next" }]);
  const { deps } = setup(t, [form, next, window([{ name: "Finished" }])]);
  const exec = executor((body, call) => call === 2 ? new ExecutorError("too_large", "the request does not fit the executor's model length")
    : { element: call === 1 ? "Submit" : "Next", operation: "press" });
  const result = await runPlan(deps(exec), plan([
    { id: "a", intent: "Submit", postcondition: { exists: { name: "Next" } } },
    { id: "b", intent: "Continue", postcondition: { exists: { name: "Finished" } } }]));
  assert.equal(result.outcome, "completed");
  const recent = (body: DecisionRequestBody) => (body.state as { recent?: unknown[] }).recent?.length ?? 0;
  assert.deepEqual(exec.bodies.map(recent), [0, 1, 0], "The rejected request carried history, and its retry carried none");
  assert.equal(result.decisions, 2, "A rejected request is not a decision");
});

test("cancellation stops before the next request or action", async (t) => {
  const { backend, deps } = setup(t, [form, submitted]);
  const controller = new AbortController();
  const result = await runPlan(deps(executor(() => { controller.abort(); return { element: "Submit", operation: "press" }; })),
    plan([{ id: "s", intent: "Submit", postcondition: { exists: { name: "Done" } } }]), controller.signal);
  assert.deepEqual([result.outcome, backend.actions.length], ["cancelled", 0]);
});

test("the action budget ends a plan with budget_exhausted", async (t) => {
  const { deps } = setup(t, [form, window([{ name: "Next" }]), window([{ name: "Next" }])], { maxActionsPerPlan: 1 });
  const result = await runPlan(deps(executor((_body, call) => ({ element: call === 1 ? "Submit" : "Next", operation: "press" }))), plan([
    { id: "a", intent: "Submit", postcondition: { exists: { name: "Next" } } },
    { id: "b", intent: "Continue", postcondition: { exists: { name: "Finished" } } }]));
  assert.deepEqual([result.escalation!.reason, result.escalation!.stepId, result.steps[0]!.result], ["budget_exhausted", "b", "verified"]);
});

test("a key combination needs no element, and the plan record redacts typed text", async (t) => {
  const { backend, root, deps } = setup(t, [form, submitted]);
  const result = await runPlan(deps(executor(() => ({ operation: "key_combo" }))),
    plan([{ id: "s", intent: "Submit with the keyboard", keys: "cmd+return", text: "secret words", postcondition: { exists: { name: "Done" } } }]));
  assert.equal(result.outcome, "completed");
  assert.deepEqual(backend.actions[0]!.action, { kind: "key", key: "return", modifiers: ["cmd"] });
  const record = JSON.parse(readFileSync(join(root, "runs", "run-1", "plan.json"), "utf8"));
  assert.equal(record.plan.steps[0].text, "<12 characters>");
  assert.ok(readdirSync(join(root, "runs", "run-1")).some(file => file.startsWith("step-s-1-")));
  assert.ok(!JSON.stringify(readdirSync(join(root, "runs", "run-1")).map(file => readFileSync(join(root, "runs", "run-1", file), "utf8"))).includes("secret words"));
});

test("plans are validated before any observation or action", () => {
  const step = { id: "a", intent: "i", postcondition: { changed: true as const } };
  assert.equal(validatePlan(plan([step]), 50), undefined);
  assert.match(validatePlan(plan([]), 50)!, /no steps/);
  assert.match(validatePlan(plan([step, step]), 50)!, /repeated/);
  assert.match(validatePlan(plan([{ ...step, postcondition: { focused: { name: "x" } } as never }]), 50)!, /not supported/);
  assert.match(validatePlan(plan([{ ...step, operation: "enter_text" }]), 50)!, /needs text/);
  assert.match(validatePlan(plan([step], ["b"]), 50)!, /unknown step "b"/);
  assert.match(validatePlan(plan([step, { ...step, id: "b" }]), 1)!, /limit is 1/);
});

test("a text check for a control's name is rejected against the observation the plan was based on", () => {
  // Observed through Pi on 2026-09-23: "text contains All Clear" checked a button name and failed after a working press.
  const calculator = window([{ name: "All Clear" }, { name: "7" }]);
  calculator.descendantText = { 0: "\u200e0" };
  const observation = observe({ ...calculator, readMs: 0 }, { id: "obs-1", maxElements: 240, maxNameLength: 48 });
  assert.equal(observation.status, "ready");
  if (observation.status !== "ready") return;
  assert.equal(labelUsedAsText({ text: { contains: "All Clear" } }, observation), "All Clear");
  assert.equal(labelUsedAsText({ any: [{ changed: true }, { text: { contains: "7" } }] }, observation), "7");
  assert.equal(labelUsedAsText({ text: { contains: "0" } }, observation), undefined, "The display shows 0, which is content");
  const problem = validatePlan(plan([{ id: "clear", intent: "Clear", postcondition: { text: { contains: "All Clear" } } }]), 50, observation);
  assert.match(problem ?? "", /is the name of a control.*exists/);
  assert.equal(validatePlan(plan([{ id: "clear", intent: "Clear", postcondition: { exists: { name: "All Clear" } } }]), 50, observation), undefined);
});

test("with step pictures on, each action gets a hashed picture before and after, and a review page lists them", async (t) => {
  const picture = (text: string) => ({ data: Buffer.from(text).toString("base64"), mimeType: "image/png" });
  const { root, deps } = setup(t, [{ ...form, screenshot: picture("before") }, { ...submitted, screenshot: picture("after") }], { stepPictures: true });
  const result = await runPlan(deps(executor(() => ({ element: "Submit", operation: "press" }))),
    plan([{ id: "submit", intent: "Submit the form", postcondition: { exists: { name: "Done" } } }]));
  const pictures = result.steps[0]!.pictures!;
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0]!.before!.file, "pictures/submit-1-before.png");
  assert.equal(readFileSync(join(root, "runs", "run-1", pictures[0]!.after!.file), "utf8"), "after");
  const { createHash } = await import("node:crypto");
  assert.equal(pictures[0]!.after!.sha256, createHash("sha256").update("after").digest("hex"));
  const review = readFileSync(join(root, "runs", "run-1", "review.md"), "utf8");
  assert.match(review, /## submit\n\n- Intent: Submit the form\n- Postcondition: `\{"exists":\{"name":"Done"\}\}`\n- Result: verified/);
  assert.match(review, /Attempt 1, after: !\[submit after\]\(pictures\/submit-1-after\.png\) sha256 `[0-9a-f]{64}`/);
});

test("with step pictures off, no picture or review page is written", async (t) => {
  const { root, deps } = setup(t, [form, submitted]);
  const result = await runPlan(deps(executor(() => ({ element: "Submit", operation: "press" }))),
    plan([{ id: "submit", intent: "Submit the form", postcondition: { exists: { name: "Done" } } }]));
  assert.equal(result.steps[0]!.pictures, undefined);
  assert.ok(!readdirSync(join(root, "runs", "run-1")).includes("review.md"));
});

test("text entry must check the text, and a key that only moves the insertion point cannot be verified by a change", () => {
  const typed = { id: "t", intent: "Type", operation: "enter_text" as const, text: "Hello" };
  assert.match(validatePlan(plan([{ ...typed, postcondition: { changed: true } }]), 50) ?? "", /must check the typed text/);
  assert.equal(validatePlan(plan([{ ...typed, postcondition: { text: { endsWith: "Hello" } } }]), 50), undefined);
  assert.match(validatePlan(plan([{ id: "k", intent: "End", operation: "key_combo", keys: "cmd+Down", postcondition: { changed: true } }]), 50) ?? "",
    /only moves the insertion point.*set position on the enter_text step/);
  assert.equal(validatePlan(plan([{ id: "k", intent: "New", operation: "key_combo", keys: "cmd+n", postcondition: { changed: true } }]), 50), undefined);
  assert.match(validatePlan(plan([{ id: "t", intent: "Type", text: "Hello", postcondition: { changed: true } }]), 50) ?? "", /must check the typed text/,
    "A step with text is text entry whether or not it names the operation");
  assert.match(validatePlan(plan([{ id: "k", intent: "Erase", keys: "Hyper+x", postcondition: { changed: true } }]), 50) ?? "", /step k: "Hyper\+x" is not a key combination/);
  assert.match(validatePlan(plan([{ id: "b", intent: "Both", text: "a", keys: "cmd+a", postcondition: { text: { contains: "a" } } }]), 50) ?? "", /text or keys, not both/);
});
