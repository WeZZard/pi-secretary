import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendError, type RawElement, type WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { FakeBackend } from "../../extensions/secretary/computer-use/backend/fake-backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import { DecisionServiceError, type DecisionRequestBody, type DecisionResponse } from "../../extensions/secretary/computer-use/decision-service-client.ts";
import { runPlan, validatePlan, type Plan } from "../../extensions/secretary/computer-use/executor.ts";
import { observe } from "../../extensions/secretary/computer-use/observer.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";
import { withGuardian, type GuardAnswers } from "./support/guardian-answers.ts";

type Read = Omit<WindowRead, "readMs">;
/** A small window: every listed UI element is a kept UI element in one group, lettered in reading order. */
function window(listed: { role?: string; name: string; value?: string }[]): Read {
  const elements: RawElement[] = [{ element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } }];
  listed.forEach((item, i) => elements.push({ element_index: i + 1, role: item.role ?? "AXButton", label: item.name,
    ...(item.value !== undefined ? { value: item.value } : {}), parent_index: 0, depth: 1, frame: { x: 100, y: 50 + i * 40, w: 80, h: 20 } }));
  return { window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements };
}

/** A scripted grounder: answers name a UI element by its name, which the test maps to a letter. */
function scriptedGrounder(script: (body: DecisionRequestBody, call: number) => { element?: string; operation: string; risk?: string; confidence?: number } | Error,
  guard?: (body: DecisionRequestBody) => GuardAnswers) {
  const bodies: DecisionRequestBody[] = [];
  return withGuardian({ bodies, decide: async (body: DecisionRequestBody): Promise<DecisionResponse> => {
    bodies.push(body);
    const answer = script(body, bodies.length);
    if (answer instanceof Error) throw answer;
    const confidence = answer.confidence ?? 0.9;
    const table = String((body.state as { elements: string }).elements);
    const letter = answer.element ? table.split("\n").find(line => /^ {2}[A-Z] \S+ (".*?")(?: |$)/.exec(line)?.[1] === JSON.stringify(answer.element))?.trim()[0] ?? "none" : "none";
    return { roundTripMs: 1, answers: { element_1: { choice: letter, confidence }, operation: { choice: answer.operation, confidence }, risk: { choice: answer.risk ?? "safe", confidence } } };
  } }, guard);
}

function setup(t: TestContext, reads: (Read | Error)[], overrides: Partial<ReturnType<typeof defaultComputerUseConfiguration>> = {}) {
  const root = mkdtempSync(join(tmpdir(), "secretary-executor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backend = new FakeBackend({ Form: reads });
  const config = { ...defaultComputerUseConfiguration(), settleMs: 0, ...overrides };
  return { backend, root, deps: (grounder: ReturnType<typeof scriptedGrounder>) => ({ backend, grounder, telemetry: new Telemetry(root), config, sleep: async () => {}, newId: () => "run-1" }) };
}

const plan = (steps: Plan["steps"], askBefore?: string): Plan => ({ target: { app: "Form" }, goal: "Fill the form", steps, ...(askBefore ? { askBefore } : {}) });
const submitted = window([{ name: "Done" }]);
const form = window([{ name: "Submit" }, { name: "Cancel" }]);

test("a plan completes: one request per step and a real click at the UI element center; the step acted, and nothing judged it", async (t) => {
  const { backend, deps } = setup(t, [form, submitted]);
  const grounder = scriptedGrounder(() => ({ element: "Submit", operation: "click" }));
  const result = await runPlan(deps(grounder), plan([{ id: "submit", intent: "Submit the form" }]));
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.steps, [{ id: "submit", result: "acted", action: "click", element: "Submit" }]);
  assert.deepEqual([result.decisions, result.actions], [1, 1]);
  assert.deepEqual(backend.actions.map(entry => entry.action), [{ kind: "click", point: { x: 140, y: 60 }, button: "left", count: 1, label: 'run-1 submit: click "Submit"' }]);
  assert.ok(!("depends_on" in grounder.bodies[0]!.questions.operation!));
});

test("each step records the relay steps of its reads and action and the driver's input path, and reads are labelled with the step", async (t) => {
  const { backend, deps } = setup(t, [form, submitted]);
  backend.reportEvidence = true;
  const labels: (string | undefined)[] = [];
  const read = backend.readWindow.bind(backend);
  backend.readWindow = (target, options) => { labels.push(options.label); return read(target, options); };
  const result = await runPlan(deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))),
    plan([{ id: "submit", intent: "Submit the form" }]));
  assert.equal(result.outcome, "completed");
  assert.deepEqual([result.steps[0]!.evidence, result.steps[0]!.inputPaths], [["cu-0001", "cu-0002", "cu-0003"], ["cgevent_hid"]],
    "The initial read, the click and the read after it, in order");
  assert.deepEqual(labels, ["run-1 submit: initial", "run-1 submit: after"]);
});

test("in ordinary input mode, an action the driver performed through accessibility stops the plan and is not repeated (design §11.4)", async (t) => {
  const ordinary = setup(t, [form, form]);
  ordinary.backend.reportEvidence = true;
  ordinary.backend.pointerPath = "ax";
  const step = { id: "submit", intent: "Submit the form" };
  const stopped = await runPlan(ordinary.deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))), plan([step]));
  assert.equal(stopped.escalation?.reason, "input_mode");
  assert.match(stopped.escalation!.detail, /click "Submit" through accessibility \(path ax\)/);
  assert.equal(ordinary.backend.actions.length, 1);
  assert.deepEqual(stopped.steps[0]!.inputPaths, ["ax"]);
  const testing = setup(t, [form, submitted], { inputMode: "accessibility-test" });
  testing.backend.reportEvidence = true;
  testing.backend.pointerPath = "ax";
  const allowed = await runPlan(testing.deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))), plan([step]));
  assert.equal(allowed.outcome, "completed", "An accessibility test may use accessibility input");
});

test("the first read refuses to guess among several windows, and every later read uses the same window", async (t) => {
  const { backend, deps } = setup(t, [form, submitted]);
  await runPlan(deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))), plan([{ id: "submit", intent: "Submit the form" }]));
  assert.deepEqual(backend.reads, [{ app: "Form", single: true }, { app: "Form", windowId: form.window.windowId }]);
  const lost = setup(t, [new BackendError("window_ambiguous", "2 Form windows match")]);
  const result = await runPlan(lost.deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))), plan([{ id: "submit", intent: "Submit" }]));
  assert.equal(result.escalation?.reason, "window_unclear");
  assert.equal(lost.backend.actions.length, 0);
});

test("a step whose intent the window already seems to show still acts: nothing is checked before a step (decision PS-D19)", async (t) => {
  // MacArena, 2026-09-29: the check "text contains Reminders" held on the welcome window, so Continue was never clicked.
  const welcome = window([{ name: "Continue" }, { role: "AXStaticText", name: "Reminders" }]);
  const { backend, deps } = setup(t, [welcome, window([{ name: "New Reminder" }])]);
  const result = await runPlan(deps(scriptedGrounder(() => ({ element: "Continue", operation: "click" }))), plan([{ id: "c", intent: "Dismiss the welcome to reach Reminders" }]));
  assert.deepEqual([result.outcome, result.steps[0]!.result, result.decisions, backend.actions.length], ["completed", "acted", 1, 1]);
});

test("each step acts once: an action that changes nothing is not repeated, and the plan goes on to its next step", async (t) => {
  const field = window([{ role: "AXTextField", name: "Name" }]);
  const { backend, deps } = setup(t, [field]);
  const result = await runPlan(deps(scriptedGrounder((_body, call) => call === 1 ? { element: "Name", operation: "type" } : { operation: "key" })),
    plan([{ id: "t", intent: "Type the name", action: "type", text: "Hello" }, { id: "k", intent: "Go to the end", action: "key", keys: "cmd+down" }]));
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.steps.map(step => step.result), ["acted", "acted"], "acted says input was sent, not that it worked");
  assert.deepEqual([result.actions, backend.actions.filter(entry => entry.action.kind === "key" && entry.action.key === "down").length], [2, 1]);
});

test("a scroll acts once, like any other step", async (t) => {
  const { backend, deps } = setup(t, [form, window([{ name: "Page 2" }]), window([{ name: "Page 3" }])]);
  const result = await runPlan(deps(scriptedGrounder(() => ({ operation: "scroll_down" }))), plan([{ id: "s", intent: "Scroll to Zoning", action: "scroll_down" }]));
  assert.deepEqual([result.outcome, result.actions, backend.actions.length], ["completed", 1, 1]);
});

test("a stopped step names the action it sent, and later steps are not run", async (t) => {
  const { backend, deps } = setup(t, [form, submitted]);
  backend.reportEvidence = true;
  backend.pointerPath = "ax";
  const result = await runPlan(deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))), plan([{ id: "a", intent: "Submit" }, { id: "b", intent: "Close" }]));
  assert.equal(result.escalation?.reason, "input_mode");
  assert.deepEqual(result.steps.map(step => [step.id, step.result, step.action]), [["a", "stopped", "click"], ["b", "not_run", undefined]]);
  assert.match(result.steps[0]!.detail!, /^input_mode: /);
});

test("policy escalations stop the plan with their reason and prior", async (t) => {
  const abstain = setup(t, [form]);
  const notFound = await runPlan(abstain.deps(scriptedGrounder(() => ({ operation: "abstain" }))), plan([{ id: "s", intent: "Open settings" }]));
  assert.equal(notFound.escalation!.reason, "target_not_found");
  const risky = setup(t, [form, submitted]);
  const done = await runPlan(risky.deps(scriptedGrounder(() => ({ element: "Submit", operation: "click", risk: "destructive" }))),
    plan([{ id: "s", intent: "Submit" }]));
  assert.equal(done.outcome, "completed", "The grounder's risk answer is recorded and decides nothing (design §8.6)");
});

const submit = { id: "s", intent: "Submit" };
const clickSubmit = () => ({ element: "Submit", operation: "click" });
const permissionRecords = (root: string) => readdirSync(join(root, "runs", "run-1")).filter(file => file.startsWith("permission-"))
  .map(file => JSON.parse(readFileSync(join(root, "runs", "run-1", file), "utf8")));

test("an action whose effect leaves the machine waits for a person; with nobody to ask it stops before any input (design §8.5)", async (t) => {
  const { backend, root, deps } = setup(t, [form]);
  const grounder = scriptedGrounder(clickSubmit, () => ({ effect: ["change", 0.9], reach: ["outside", 0.9] }));
  const result = await runPlan(deps(grounder), plan([submit]));
  assert.deepEqual([result.escalation?.reason, result.escalation?.prior?.element, backend.actions.length], ["approval_required", "Submit", 0]);
  assert.match(result.escalation!.detail, /leaves this machine.*nobody could be asked in this session\. Nothing was sent/);
  const [record] = permissionRecords(root);
  assert.equal(record.schema, "secretary.computer-use.permission/1");
  assert.deepEqual([record.judgment.verdict, record.judgment.reason, record.judgment.environment, record.approval.answer], ["ask", "guardian", "ephemeral", "no_interface"]);
  assert.deepEqual(record.judgment.requests[0].answers.reach, { choice: "outside", confidence: 0.9 }, "The record holds the guardian's answers");
  assert.deepEqual(grounder.guardBodies[0]!.state, { app: "Form", window: "Form", action: "click", ui_element: 'Button "Submit"' });
  assert.equal(grounder.guardBodies[0]!.think, 256);
});

test("a person's answer decides an action the guardian asks about, and only that action", async (t) => {
  const outside = () => ({ effect: ["change", 0.9], reach: ["outside", 0.9] }) as const;
  const answers: string[] = [];
  const approved = setup(t, [form, submitted]);
  const done = await runPlan({ ...approved.deps(scriptedGrounder(clickSubmit, outside)), approve: async request => { answers.push(request.intent); return "approved"; } }, plan([submit]));
  assert.deepEqual([done.outcome, approved.backend.actions.length, answers], ["completed", 1, ["Submit"]]);
  const declined = setup(t, [form]);
  const refused = await runPlan({ ...declined.deps(scriptedGrounder(clickSubmit, outside)), approve: async () => "declined" }, plan([submit]));
  assert.deepEqual([refused.escalation?.reason, declined.backend.actions.length], ["approval_denied", 0]);
  assert.match(refused.escalation!.detail, /a person declined click "Submit".*do not reach the goal another way/);
  const late = setup(t, [form]);
  const unanswered = await runPlan({ ...late.deps(scriptedGrounder(clickSubmit, outside)), approve: async () => "timeout" }, plan([submit]));
  assert.deepEqual([unanswered.escalation?.reason, late.backend.actions.length], ["approval_required", 0]);
  assert.match(unanswered.escalation!.detail, /nobody answered in time/);
  const safe = setup(t, [form, submitted]);
  let asked = 0;
  await runPlan({ ...safe.deps(scriptedGrounder(clickSubmit)), approve: async () => { asked++; return "approved"; } }, plan([submit]));
  assert.equal(asked, 0, "An action the guardian lets proceed is not shown to a person");
});

test("local destruction proceeds in an ephemeral machine and asks on a persistent one (design §8.3)", async (t) => {
  const destroy = () => ({ effect: ["destroy", 0.9], reach: ["local", 0.9] }) as const;
  const relay = setup(t, [form, submitted]);
  assert.equal((await runPlan(relay.deps(scriptedGrounder(clickSubmit, destroy)), plan([submit]))).outcome, "completed");
  const local = setup(t, [form]);
  Object.defineProperty(local.backend, "kind", { value: "local" });
  const stopped = await runPlan(local.deps(scriptedGrounder(clickSubmit, destroy)), plan([submit]));
  assert.equal(stopped.escalation?.reason, "approval_required");
  assert.match(stopped.escalation!.detail, /destroys data on a machine that persists/);
  assert.equal(permissionRecords(local.root)[0].judgment.environment, "persistent");
});

test("an answer below the gate asks, and so does a guardian that cannot answer", async (t) => {
  const unsure = setup(t, [form]);
  const doubt = await runPlan(unsure.deps(scriptedGrounder(clickSubmit, () => ({ reach: ["local", 0.4] }))), plan([submit]));
  assert.equal(doubt.escalation?.reason, "approval_required");
  assert.match(doubt.escalation!.detail, /could not judge it with confidence/);
  assert.equal(permissionRecords(unsure.root)[0].judgment.reason, "doubt");
  const down = setup(t, [form]);
  const failing = scriptedGrounder(clickSubmit);
  const decide = failing.decide;
  failing.decide = async (body: DecisionRequestBody) => "reach" in body.questions ? Promise.reject(new DecisionServiceError("timeout", "no answer")) : decide(body);
  const failed = await runPlan(down.deps(failing), plan([submit]));
  assert.deepEqual([failed.escalation?.reason, down.backend.actions.length], ["approval_required", 0]);
  assert.match(permissionRecords(down.root)[0].judgment.requests[0].error, /no answer/);
});

test("the task's ask_before adds an approval the guardian would not ask for (decision PS-D16)", async (t) => {
  const { backend, root, deps } = setup(t, [form]);
  const grounder = scriptedGrounder(clickSubmit, body => "listed" in body.questions ? { listed: ["yes", 0.9] } : {});
  const result = await runPlan(deps(grounder), plan([submit], "adding anything to the cart"));
  assert.deepEqual([result.escalation?.reason, backend.actions.length], ["approval_required", 0]);
  assert.match(result.escalation!.detail, /the task asked for approval before this kind of action/);
  const listed = grounder.guardBodies.find(body => "listed" in body.questions)!;
  assert.equal((listed.state as { ask_before: string }).ask_before, "adding anything to the cart");
  assert.equal(permissionRecords(root)[0].judgment.reason, "ask_before");
  const plain = setup(t, [form, submitted]);
  const noList = scriptedGrounder(clickSubmit);
  await runPlan(plain.deps(noList), plan([submit]));
  assert.ok(!noList.guardBodies.some(body => "listed" in body.questions), "Without ask_before the question is not asked");
});

test("bypass sends no guardian request, and a scroll is not judged", async (t) => {
  const bypass = setup(t, [form, submitted], { permissionMode: "bypass" });
  const grounder = scriptedGrounder(clickSubmit, () => ({ reach: ["outside", 0.9] }));
  assert.equal((await runPlan(bypass.deps(grounder), plan([submit]))).outcome, "completed");
  assert.deepEqual([grounder.guardBodies.length, permissionRecords(bypass.root)[0].judgment.reason], [0, "mode"]);
  const scroll = setup(t, [form, window([{ name: "Zoning" }])]);
  const scrolling = scriptedGrounder(() => ({ operation: "scroll_down" }), () => ({ reach: ["outside", 0.9] }));
  const scrolled = await runPlan(scroll.deps(scrolling), plan([{ id: "z", intent: "Scroll to Zoning", action: "scroll_down" }]));
  assert.deepEqual([scrolled.outcome, scrolling.guardBodies.length], ["completed", 0]);
});

test("grounder failure, untypeable text and backend failure escalate without replaying an action", async (t) => {
  const down = setup(t, [form]);
  const unavailable = await runPlan(down.deps(scriptedGrounder(() => new DecisionServiceError("timeout", "the grounder did not answer within 10000 ms"))),
    plan([{ id: "s", intent: "Submit" }]));
  assert.deepEqual([unavailable.escalation!.reason, unavailable.decisions], ["grounder_unavailable", 0]);

  const huge = setup(t, [form]);
  const tooLong = new DecisionServiceError("too_large", "the request does not fit the grounder's model length");
  const oversize = await runPlan(huge.deps(scriptedGrounder(() => tooLong)), plan([{ id: "s", intent: "Submit" }]));
  assert.deepEqual([oversize.escalation!.reason, oversize.decisions], ["state_too_large", 0], "Without history, the grounder's length rejection is final");

  const text = setup(t, [window([{ role: "AXTextField", name: "Email" }])]);
  const needsText = await runPlan(text.deps(scriptedGrounder(() => ({ element: "Email", operation: "type" }))),
    plan([{ id: "s", intent: "Enter the email", text: "a@b.c" }]));
  assert.deepEqual([needsText.escalation!.reason, text.backend.actions.length], ["needs_text", 0], "A refused literal sends no partial input");

  const broken = setup(t, [form, submitted]);
  broken.backend.actionFailures.push(new BackendError("driver_failed", "cua-driver click failed"));
  const failed = await runPlan(broken.deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))), plan([{ id: "s", intent: "Submit" }]));
  assert.deepEqual([failed.escalation!.reason, failed.actions, broken.backend.actions.length], ["backend_failed", 0, 0]);
});

test("a request the grounder finds too long is built again from the next trim step, here without its history record", async (t) => {
  const next = window([{ name: "Next" }]);
  const { deps } = setup(t, [form, next, window([{ name: "Finished" }])]);
  const grounder = scriptedGrounder((body, call) => call === 2 ? new DecisionServiceError("too_large", "the request does not fit the grounder's model length")
    : { element: call === 1 ? "Submit" : "Next", operation: "click" });
  const result = await runPlan(deps(grounder), plan([
    { id: "a", intent: "Submit" },
    { id: "b", intent: "Continue" }]));
  assert.equal(result.outcome, "completed");
  const recent = (body: DecisionRequestBody) => (body.state as { recent?: unknown[] }).recent?.length ?? 0;
  assert.deepEqual(grounder.bodies.map(recent), [0, 1, 0], "The rejected request carried history, and its retry carried none");
  assert.equal(result.decisions, 2, "A rejected request is not a decision");
});

test("cancellation stops before the next request or action", async (t) => {
  const { backend, deps } = setup(t, [form, submitted]);
  const controller = new AbortController();
  const result = await runPlan(deps(scriptedGrounder(() => { controller.abort(); return { element: "Submit", operation: "click" }; })),
    plan([{ id: "s", intent: "Submit" }]), controller.signal);
  assert.deepEqual([result.outcome, backend.actions.length], ["cancelled", 0]);
});

test("a key combination needs no UI element, and the plan record redacts typed text", async (t) => {
  const { backend, root, deps } = setup(t, [form, submitted]);
  const result = await runPlan(deps(scriptedGrounder(() => ({ operation: "key" }))),
    plan([{ id: "s", intent: "Submit with the keyboard", keys: "cmd+return", text: "secret words" }]));
  assert.equal(result.outcome, "completed");
  assert.deepEqual(backend.actions[0]!.action, { kind: "key", key: "return", modifiers: ["cmd"], label: "run-1 s: key" });
  const record = JSON.parse(readFileSync(join(root, "runs", "run-1", "plan.json"), "utf8"));
  assert.equal(record.plan.steps[0].text, "<12 characters>");
  assert.ok(readdirSync(join(root, "runs", "run-1")).some(file => file.startsWith("step-s-1-")));
  assert.ok(!JSON.stringify(readdirSync(join(root, "runs", "run-1")).map(file => readFileSync(join(root, "runs", "run-1", file), "utf8"))).includes("secret words"));
});

test("a plan that cannot run is rejected before any observation or action, and the rejection names its rule", () => {
  const step = { id: "a", intent: "i" };
  const rule = (candidate: Plan, maxSteps = 50) => validatePlan(candidate, maxSteps)?.rule;
  assert.equal(validatePlan(plan([step]), 50), undefined);
  assert.equal(rule(plan([])), "no_steps");
  assert.equal(rule(plan([step, { ...step, id: "b" }]), 1), "too_many_steps");
  assert.equal(rule(plan([step, step])), "repeated_step_id");
  assert.equal(rule(plan([{ ...step, action: "type" }])), "needs_text");
  assert.equal(rule(plan([{ ...step, action: "key" }])), "needs_keys");
  assert.equal(rule(plan([{ id: "b", intent: "Both", text: "a", keys: "cmd+a" }])), "text_and_keys");
  assert.match(validatePlan(plan([{ id: "k", intent: "Erase", keys: "Hyper+x" }]), 50)?.message ?? "", /step k: "Hyper\+x" is not a key combination/);
});

test("no plan is rejected on a guess about what it meant (decision PS-D3)", () => {
  // Each of these was rejected before 2026-09-26 although it can run.
  assert.equal(validatePlan(plan([{ id: "p7", intent: "Press 7" }]), 50), undefined, "a digit that is also a button name");
  assert.equal(validatePlan(plan([{ id: "t", intent: "Type", action: "type", text: "Hello" }]), 50), undefined, "typed text");
  assert.equal(validatePlan(plan([{ id: "k", intent: "End", action: "key", keys: "cmd+Down" }]), 50), undefined, "a navigation key");
});

test("with step pictures on, each action gets a hashed picture before and after, and a review page lists them", async (t) => {
  const picture = (text: string) => ({ data: Buffer.from(text).toString("base64"), mimeType: "image/png" });
  const { root, deps } = setup(t, [{ ...form, screenshot: picture("before") }, { ...submitted, screenshot: picture("after") }], { stepPictures: true });
  const result = await runPlan(deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))),
    plan([{ id: "submit", intent: "Submit the form" }]));
  const pictures = result.steps[0]!.pictures!;
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0]!.before!.file, "pictures/submit-1-before.png");
  assert.equal(readFileSync(join(root, "runs", "run-1", pictures[0]!.after!.file), "utf8"), "after");
  const { createHash } = await import("node:crypto");
  assert.equal(pictures[0]!.after!.sha256, createHash("sha256").update("after").digest("hex"));
  const review = readFileSync(join(root, "runs", "run-1", "review.md"), "utf8");
  assert.match(review, /## submit\n\n- Intent: Submit the form\n- Result: acted, click "Submit"\n/);
  assert.match(review, /Attempt 1, after: !\[submit after\]\(pictures\/submit-1-after\.png\) sha256 `[0-9a-f]{64}`/);
});

test("with step pictures off, no picture or review page is written", async (t) => {
  const { root, deps } = setup(t, [form, submitted]);
  const result = await runPlan(deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))),
    plan([{ id: "submit", intent: "Submit the form" }]));
  assert.equal(result.steps[0]!.pictures, undefined);
  assert.ok(!readdirSync(join(root, "runs", "run-1")).includes("review.md"));
});

test("a step's named UI element goes to the grounder, and the executor acts on the grounder's choice without matching the name (decision PS-D24)", async (t) => {
  const submit = { id: "submit", intent: "Submit the form", ui_element: { region: "window", role: "AXButton", name: "Submit" } };
  const agreed = setup(t, [form, submitted]);
  const grounder = scriptedGrounder(() => ({ element: "Submit", operation: "click" }));
  assert.equal((await runPlan(agreed.deps(grounder), plan([submit]))).outcome, "completed");
  assert.equal((grounder.bodies[0]!.state as Record<string, unknown>).step_ui_element, 'Button "Submit" in window');

  // A name that is not in this read, such as a text area named by its content, does not stop the step.
  const renamed = setup(t, [form, submitted]);
  const result = await runPlan(renamed.deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))), plan([{ ...submit, ui_element: { name: "Send" } }]));
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.steps, [{ id: "submit", result: "acted", action: "click", element: "Submit" }]);

  const unnamed = setup(t, [form, submitted]);
  const plain = scriptedGrounder(() => ({ element: "Submit", operation: "click" }));
  await runPlan(unnamed.deps(plain), plan([{ id: "submit", intent: "Submit the form" }]));
  assert.ok(!("step_ui_element" in (plain.bodies[0]!.state as Record<string, unknown>)));
});

test("when the grounder finds no UI element for a named step, the step stops with target_not_found and nothing is sent", async (t) => {
  const { backend, deps } = setup(t, [form]);
  const result = await runPlan(deps(scriptedGrounder(() => ({ operation: "click" }))),
    plan([{ id: "s", intent: "Send the form", ui_element: { role: "Button", name: "Send" } }]));
  assert.equal(result.escalation!.reason, "target_not_found");
  assert.equal(backend.actions.length, 0);
});

test("a UI element that appears only after an earlier step is found in that step's fresh read", async (t) => {
  const menu = window([{ name: "File" }]);
  const opened = window([{ name: "File" }, { role: "AXMenuItem", name: "Save" }]);
  const { deps } = setup(t, [menu, opened, submitted]);
  const result = await runPlan(deps(scriptedGrounder(body => String((body.state as { elements: string }).elements).includes("Save") ? { element: "Save", operation: "click" } : { element: "File", operation: "click" })),
    plan([{ id: "open", intent: "Open File", ui_element: { name: "File" } },
      { id: "save", intent: "Save", ui_element: { role: "MenuItem", name: "Save" } }]));
  assert.equal(result.outcome, "completed");
});

test("a UI element reference that cannot match anything is rejected before the plan runs", () => {
  const step = { id: "a", intent: "i" };
  assert.equal(validatePlan(plan([{ ...step, ui_element: { name: " " } }]), 50)?.rule, "ui_element");
  assert.match(validatePlan(plan([{ ...step, ui_element: { name: "Save", role: "selected" } }]), 50)?.message ?? "", /element role "selected" is not an accessibility role/);
  assert.equal(validatePlan(plan([{ ...step, ui_element: { name: "Save", role: "MenuItem", region: "anything" } }]), 50), undefined);
});
