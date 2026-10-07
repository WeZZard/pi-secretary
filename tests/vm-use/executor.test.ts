import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendError, type RawElement, type WindowRead } from "../../extensions/secretary/vm-use/backend/backend.ts";
import { FakeBackend } from "../../extensions/secretary/vm-use/backend/fake-backend.ts";
import { defaultVmUseConfiguration } from "../../extensions/secretary/vm-use/configuration.ts";
import { DecisionServiceError, type DecisionRequestBody, type DecisionResponse } from "../../extensions/secretary/vm-use/decision-service-client.ts";
import { runPlan, validatePlan, type ApprovalRequest, type Plan } from "../../extensions/secretary/vm-use/executor.ts";
import { observe } from "../../extensions/secretary/vm-use/observer.ts";
import { Telemetry } from "../../extensions/secretary/vm-use/telemetry.ts";
import { fakePlanChecker } from "./support/plan-checker.ts";

type Read = Omit<WindowRead, "readMs">;
/** A small window: every listed UI element is a kept UI element in one group, lettered in reading order. */
function window(listed: { role?: string; name: string; value?: string }[]): Read {
  const elements: RawElement[] = [{ element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } }];
  listed.forEach((item, i) => elements.push({ element_index: i + 1, role: item.role ?? "AXButton", label: item.name,
    ...(item.value !== undefined ? { value: item.value } : {}), parent_index: 0, depth: 1, frame: { x: 100, y: 50 + i * 40, w: 80, h: 20 } }));
  return { window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements };
}

/** A scripted grounder: answers name a UI element by its name, which the test maps to a letter. */
function scriptedGrounder(script: (body: DecisionRequestBody, call: number) => { element?: string; operation: string; risk?: string; confidence?: number } | Error) {
  const bodies: DecisionRequestBody[] = [];
  return { bodies, decide: async (body: DecisionRequestBody): Promise<DecisionResponse> => {
    bodies.push(body);
    const answer = script(body, bodies.length);
    if (answer instanceof Error) throw answer;
    const confidence = answer.confidence ?? 0.9;
    const table = String((body.state as { elements: string }).elements);
    const letter = answer.element ? table.split("\n").find(line => /^ {2}[A-Z] \S+ (".*?")(?: |$)/.exec(line)?.[1] === JSON.stringify(answer.element))?.trim()[0] ?? "none" : "none";
    return { roundTripMs: 1, answers: { element_1: { choice: letter, confidence }, operation: { choice: answer.operation, confidence }, risk: { choice: answer.risk ?? "safe", confidence } } };
  } };
}

function setup(t: TestContext, reads: (Read | Error)[], overrides: Partial<ReturnType<typeof defaultVmUseConfiguration>> = {}) {
  const root = mkdtempSync(join(tmpdir(), "secretary-executor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backend = new FakeBackend({ Form: reads });
  const config = { ...defaultVmUseConfiguration(), settleMs: 0, ...overrides };
  return { backend, root, deps: (grounder: ReturnType<typeof scriptedGrounder>) => ({ backend, grounder, telemetry: new Telemetry(root), config, sleep: async () => {}, newId: () => "run-1" }) };
}

const plan = (steps: Plan["steps"]): Plan => ({ target: { app: "Form" }, goal: "Fill the form", steps });
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
  assert.deepEqual([result.steps[0]!.evidence, result.steps[0]!.inputPaths], [["vu-0001", "vu-0002", "vu-0003"], ["cgevent_hid"]],
    "The initial read, the click and the read after it, in order");
  assert.deepEqual(labels, ["run-1 submit: initial", "run-1 submit: after"]);
});

test("the driver's reported path is recorded, and nothing acts on it: a click reported as ax goes on to the next step (design §11.4, PS-D39)", async (t) => {
  const { backend, deps } = setup(t, [form, form, submitted]);
  backend.reportEvidence = true;
  backend.pointerPath = "ax";
  const result = await runPlan(deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))), plan([{ id: "a", intent: "Submit" }, { id: "b", intent: "Submit again" }]));
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.steps.map(step => step.inputPaths), [["ax"], ["ax"]]);
  assert.equal(backend.actions.length, 2);
});

test("each action is sent as named: an accessibility action names the UI element by its index, and the next step can send input events (PS-D39)", async (t) => {
  const { backend, deps } = setup(t, [form, form, form, submitted]);
  backend.reportEvidence = true;
  const operations = ["ax_press", "click", "ax_show_menu"];
  const grounder = scriptedGrounder((_body, call) => ({ element: "Submit", operation: operations[call - 1]! }));
  const result = await runPlan(deps(grounder), plan([{ id: "a", intent: "Press Submit" }, { id: "b", intent: "Click Submit" }, { id: "c", intent: "Show Submit's menu" }]));
  assert.equal(result.outcome, "completed");
  assert.deepEqual(backend.actions.map(entry => entry.action), [
    { kind: "accessibility", tool: "click", element: 1, label: 'run-1 a: ax_press "Submit"' },
    { kind: "click", point: { x: 140, y: 60 }, button: "left", count: 1, label: 'run-1 b: click "Submit"' },
    { kind: "accessibility", tool: "right_click", element: 1, label: 'run-1 c: ax_show_menu "Submit"' }]);
  assert.deepEqual(result.steps.map(step => [step.action, step.inputPaths]), [["ax_press", ["ax"]], ["click", ["cgevent_hid"]], ["ax_show_menu", ["ax"]]]);
  assert.ok(grounder.bodies.every(body => !("input" in body.questions)), "No request asks an input question");
});

test("ax_set_value sets the field's value from the read before the step, with any character; no position replaces it", async (t) => {
  const field = window([{ role: "AXTextField", name: "Name", value: "Ada" }]);
  const set = async (position?: "end" | "start" | "replace") => {
    const { backend, deps } = setup(t, [field]);
    await runPlan(deps(scriptedGrounder(() => ({ element: "Name", operation: "ax_set_value" }))),
      plan([{ id: "t", intent: "Set the name", text: " Lovelace!", ...(position ? { position } : {}) }]));
    return backend.actions.map(entry => entry.action);
  };
  assert.deepEqual(await set(), [{ kind: "accessibility", tool: "set_value", element: 1, value: " Lovelace!", label: 'run-1 t: ax_set_value "Name"' }]);
  assert.deepEqual((await set("end")).map(action => action.kind === "accessibility" ? action.value : undefined), ["Ada Lovelace!"]);
  assert.deepEqual((await set("start")).map(action => action.kind === "accessibility" ? action.value : undefined), [" Lovelace!Ada"]);
});

test("the grounder request carries the delegated request as written, at every step (design §7.1, PS-D39)", async (t) => {
  const { deps } = setup(t, [form, form, submitted]);
  const grounder = scriptedGrounder(() => ({ element: "Submit", operation: "click" }));
  const request = "I use VoiceOver. Please submit the form twice.";
  await runPlan(deps(grounder), { ...plan([{ id: "a", intent: "Submit" }, { id: "b", intent: "Submit" }]), request });
  const decisions = grounder.bodies.filter(body => "operation" in body.questions);
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every(body => (body.state as { request?: string }).request === request));
});

test("a plan rejects an ax_set_value step without text", () => {
  assert.equal(validatePlan(plan([{ id: "s", intent: "Set", action: "ax_set_value" }]), 50)?.rule, "needs_text");
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
  backend.actionFailures.push(new Error("driver lost the window"));
  const result = await runPlan(deps(scriptedGrounder(() => ({ element: "Submit", operation: "click" }))), plan([{ id: "a", intent: "Submit" }, { id: "b", intent: "Close" }]));
  assert.equal(result.escalation?.reason, "backend_failed");
  assert.deepEqual(result.steps.map(step => [step.id, step.result, step.action]), [["a", "stopped", "click"], ["b", "not_run", undefined]]);
  assert.match(result.steps[0]!.detail!, /^backend_failed: driver lost the window/);
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
const online = { permissionCheck: "online" as const, permissionOnline: { url: "http://localhost/v1/chat/completions", model: "test", timeoutMs: 1000 } };
const leaves = (step: { id: string }) => step.id === "send" ? { reach: "outside_guest", requested: "no" } : { reach: "guest", requested: "no" };
const runFiles = (root: string) => readdirSync(join(root, "runs", "run-1"));
const planChecks = (root: string) => runFiles(root).filter(file => file.startsWith("permission-"))
  .map(file => JSON.parse(readFileSync(join(root, "runs", "run-1", file), "utf8")));
const planRecord = (root: string) => JSON.parse(readFileSync(join(root, "runs", "run-1", "plan.json"), "utf8"));
const message: Plan["steps"] = [{ id: "body", intent: "Type the message", text: "My order has not arrived" }, { id: "send", intent: "Send it", action: "click", ui_element: { role: "Button", name: "Send" } }];
const contact = window([{ role: "AXTextArea", name: "Message" }, { name: "Send" }]);

test("the mode none checks nothing and asks nobody, and the plan record states the mode (design §8.1, decision PS-D53)", async (t) => {
  const none = setup(t, [form, submitted]);
  const checker = fakePlanChecker(() => ({ reach: "outside_guest", requested: "yes" }));
  let asked = 0;
  const result = await runPlan({ ...none.deps(scriptedGrounder(clickSubmit)), online: checker, approve: async () => { asked++; return "declined"; } }, plan([submit]));
  assert.deepEqual([result.outcome, checker.states.length, asked, none.backend.actions.length], ["completed", 0, 0, 1]);
  assert.deepEqual(runFiles(none.root).filter(file => file.startsWith("permission-")), []);
  assert.deepEqual([planRecord(none.root).permissionCheck, planRecord(none.root).permissionCheckSource], ["none", "configuration"]);
});

test("the mode the delegated request chose overrides the configuration both ways (design §8.1, decision PS-D54)", async (t) => {
  const off = setup(t, [form, submitted], online);
  const marksAll = fakePlanChecker(() => ({ reach: "outside_guest", requested: "yes" }));
  let asked = 0;
  const ran = await runPlan({ ...off.deps(scriptedGrounder(clickSubmit)), online: marksAll, approve: async () => { asked++; return "declined"; } },
    { ...plan([submit]), permissionCheck: "none" });
  assert.deepEqual([ran.outcome, marksAll.states.length, asked, off.backend.actions.length], ["completed", 0, 0, 1], "The request turned off a configured online check");
  assert.deepEqual([planRecord(off.root).permissionCheck, planRecord(off.root).permissionCheckSource], ["none", "request"]);
  assert.deepEqual(runFiles(off.root).filter(file => file.startsWith("permission-")), []);

  const on = setup(t, [contact, contact, submitted]);
  const checker = fakePlanChecker(leaves);
  const stopped = await runPlan({ ...on.deps(scriptedGrounder(clickSubmit)), online: checker, approve: async () => "declined" }, { ...plan(message), permissionCheck: "online" });
  assert.deepEqual([stopped.escalation?.reason, checker.states.length, on.backend.reads.length, on.backend.actions.length], ["approval_denied", 1, 0, 0],
    "The request asked for the check over the configured mode none");
  assert.deepEqual([planRecord(on.root).permissionCheck, planRecord(on.root).permissionCheckSource], ["online", "request"]);
  assert.equal(planChecks(on.root).length, 1);
});

test("online checks the whole plan once before the first read; a plan with no marked step runs without a dialog (design §8.3)", async (t) => {
  const { backend, root, deps } = setup(t, [contact, contact, submitted], online);
  const checker = fakePlanChecker();
  let readsWhenChecked = -1;
  const checkPlan = checker.checkPlan.bind(checker);
  checker.checkPlan = (state, signal) => { readsWhenChecked = backend.reads.length; return checkPlan(state, signal); };
  let asked = 0;
  const grounder = scriptedGrounder((_body, call) => call === 1 ? { element: "Message", operation: "type" } : { element: "Send", operation: "click" });
  const result = await runPlan({ ...deps(grounder), online: checker, approve: async () => { asked++; return "approved"; } },
    { ...plan(message), request: "Tell the support team that my order is late.", target: { app: "Form", windowTitle: "Contact Support" } });
  assert.equal(result.outcome, "completed");
  assert.deepEqual([checker.states.length, readsWhenChecked, asked], [1, 0, 0], "One check, before anything was read, and no dialog");
  assert.deepEqual(checker.states[0], { request: "Tell the support team that my order is late.", goal: "Fill the form", app: "Form", window: "Contact Support",
    steps: [{ id: "body", intent: "Type the message", text: "My order has not arrived" }, { id: "send", intent: "Send it", action: "click", ui_element: 'Button "Send"' }] });
  const [record] = planChecks(root);
  assert.equal(record.schema, "secretary.vm-use.plan-check/1");
  assert.equal(record.check.state.steps[0].text, "<24 characters>", "Typed text is redacted in the record");
  assert.ok(!JSON.stringify(record).includes("My order has not arrived"));
  assert.deepEqual(record.check.steps.map((step: { needsApproval: boolean }) => step.needsApproval), [false, false]);
  assert.equal(record.approval, undefined);
  assert.deepEqual([planRecord(root).permissionCheck, planRecord(root).permissionCheckSource], ["online", "configuration"]);
});

test("a marked step asks a person once for the whole plan; approved, every step runs (design §8.4)", async (t) => {
  const { backend, root, deps } = setup(t, [contact, contact, submitted], online);
  const requests: ApprovalRequest[] = [];
  let readsWhenAsked = -1;
  const grounder = scriptedGrounder((_body, call) => call === 1 ? { element: "Message", operation: "type" } : { element: "Send", operation: "click" });
  const result = await runPlan({ ...deps(grounder), online: fakePlanChecker(leaves),
    approve: async request => { requests.push(request); readsWhenAsked = backend.reads.length; return "approved"; } }, plan(message));
  assert.equal(result.outcome, "completed");
  assert.deepEqual([requests.length, readsWhenAsked, backend.actions.at(-1)?.action.kind, result.steps.map(step => step.result)], [1, 0, "click", ["acted", "acted"]]);
  assert.deepEqual(requests[0], { goal: "Fill the form", app: "Form", steps: [{ id: "send", intent: "Send it", action: "click", ui_element: 'Button "Send"', why: "outside_guest" }] });
  assert.deepEqual(planChecks(root)[0].approval.answer, "approved");
});

test("declined, timed out or nobody to ask: the plan stops before anything is read or sent", async (t) => {
  for (const [answer, reason, detail] of [
    ["declined", "approval_denied", /a person declined the plan, which needs approval for step send \(its effect leaves the virtual machine\)\. Nothing was sent; do not reach the goal another way/],
    ["timeout", "approval_required", /step send \(its effect leaves the virtual machine\), and nobody answered in time\. Nothing was sent/],
    ["no_interface", "approval_required", /nobody could be asked in this session\. Nothing was sent/],
  ] as const) {
    const { backend, root, deps } = setup(t, [contact], online);
    const grounder = scriptedGrounder(clickSubmit);
    const result = await runPlan({ ...deps(grounder), online: fakePlanChecker(leaves), approve: async () => answer }, plan(message));
    assert.deepEqual([result.escalation?.reason, result.escalation?.stepId, backend.reads.length, grounder.bodies.length, backend.actions.length], [reason, "send", 0, 0, 0], answer);
    assert.match(result.escalation!.detail, detail);
    assert.deepEqual(result.steps.map(step => step.result), ["not_run", "stopped"]);
    assert.equal(planChecks(root)[0].approval.answer, answer);
  }
  const absent = setup(t, [contact], online);
  const result = await runPlan({ ...absent.deps(scriptedGrounder(clickSubmit)), online: fakePlanChecker(leaves) }, plan(message));
  assert.deepEqual([result.escalation?.reason, absent.backend.reads.length], ["approval_required", 0], "Without an approver, nobody can be asked");
  assert.equal(planChecks(absent.root)[0].approval.answer, "no_interface");
});

test("a step the request asks approval for, and a step without a usable answer, are marked too", async (t) => {
  const requested = setup(t, [contact], online);
  const asked: ApprovalRequest[] = [];
  await runPlan({ ...requested.deps(scriptedGrounder(clickSubmit)), online: fakePlanChecker(step => step.id === "body" ? { reach: "guest", requested: "yes" } : { reach: "guest", requested: "no" }),
    approve: async request => { asked.push(request); return "declined"; } }, plan(message));
  assert.deepEqual(asked[0]!.steps.map(step => [step.id, step.why]), [["body", "requested"]]);
  const unsure = setup(t, [contact], online);
  const doubt = await runPlan({ ...unsure.deps(scriptedGrounder(clickSubmit)), online: fakePlanChecker(step => step.id === "send" ? undefined : { reach: "guest", requested: "no" }) }, plan(message));
  assert.match(doubt.escalation!.detail, /step send \(the online plan check gave no usable answer\)/);
});

test("a failed check marks every step and says why; cancellation during the check sends nothing", async (t) => {
  const failing = setup(t, [contact], online);
  const asked: ApprovalRequest[] = [];
  const failed = await runPlan({ ...failing.deps(scriptedGrounder(clickSubmit)), online: fakePlanChecker(undefined, { failure: "the online plan check returned HTTP 502: bad gateway" }),
    approve: async request => { asked.push(request); return "no_interface"; } }, plan(message));
  assert.deepEqual([failed.escalation?.reason, failed.escalation?.stepId, failing.backend.reads.length], ["approval_required", "body", 0]);
  assert.deepEqual([asked[0]!.steps.map(step => step.id), asked[0]!.failure], [["body", "send"], "the online plan check returned HTTP 502: bad gateway"]);
  assert.match(failed.escalation!.detail, /steps body, send \(the online plan check failed: the online plan check returned HTTP 502: bad gateway\)/);
  assert.equal(planChecks(failing.root)[0].check.failure, "the online plan check returned HTTP 502: bad gateway");

  const cancelling = setup(t, [contact], online);
  const controller = new AbortController();
  const checker = fakePlanChecker();
  checker.checkPlan = async () => { controller.abort(); throw new DecisionServiceError("aborted", "the online plan check was cancelled"); };
  const cancelled = await runPlan({ ...cancelling.deps(scriptedGrounder(clickSubmit)), online: checker }, plan(message), controller.signal);
  assert.deepEqual([cancelled.outcome, cancelling.backend.reads.length, cancelling.backend.actions.length], ["cancelled", 0, 0]);
  const asking = setup(t, [contact], online);
  const stop = new AbortController();
  const stopped = await runPlan({ ...asking.deps(scriptedGrounder(clickSubmit)), online: fakePlanChecker(leaves),
    approve: async () => { stop.abort(); return "cancelled"; } }, plan(message), stop.signal);
  assert.deepEqual([stopped.outcome, asking.backend.reads.length], ["cancelled", 0], "Cancelled while the dialog was open");
});

test("the plan checks run once per plan, and the grounder's answers are never a permission check", async (t) => {
  const { backend, deps } = setup(t, [form, submitted], online);
  const checker = fakePlanChecker();
  const grounder = scriptedGrounder(() => ({ element: "Submit", operation: "click", risk: "destructive" }));
  const result = await runPlan({ ...deps(grounder), online: checker }, plan([submit]));
  assert.deepEqual([result.outcome, checker.states.length, backend.actions.length], ["completed", 1, 1]);
  assert.ok(grounder.bodies.every(body => !("reach" in body.questions) && !("effect" in body.questions)), "No guardian question goes to the grounder");
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
