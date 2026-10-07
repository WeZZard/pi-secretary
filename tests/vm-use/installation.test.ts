import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeBackend } from "../../extensions/secretary/vm-use/backend/fake-backend.ts";
import { CHILD_TASK_PREFIX } from "../../extensions/secretary/agents/child-task.ts";
import { delegatedRequest, installVmUse } from "../../extensions/secretary/vm-use/installation.ts";
import { textEditRead } from "./fixtures/trees.ts";
import { fakePlanChecker } from "./support/plan-checker.ts";

/** Only a delegated session registers the vm-use tools (decision PS-D11). */
const delegatedInstall = (pi: ExtensionAPI, options: Parameters<typeof installVmUse>[1]) => installVmUse(pi, { ...options, delegated: true });

function host(t: TestContext, config: unknown, existingTools: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "secretary-cu-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  if (config !== undefined) writeFileSync(join(agentDir, "secretary.json"), JSON.stringify(config));
  const handlers = new Map<string, ((...args: any[]) => unknown)[]>();
  const tools: any[] = [];
  const notices: string[] = [];
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: any) => tools.push(tool),
    getAllTools: () => [...existingTools.map(name => ({ name })), ...tools],
  } as unknown as ExtensionAPI;
  const entries: unknown[] = [];
  const ctx = { cwd: root, hasUI: true, isProjectTrusted: () => false, ui: { notify: (message: string) => notices.push(message) },
    sessionManager: { getSessionId: () => "session-1", getEntries: () => entries }, model: { input: ["text"] } };
  const emit = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
  return { pi, root, agentDir, tools, notices, emit, ctx, entries };
}

test("nothing is registered without a configured backend", async (t) => {
  const h = host(t, undefined);
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir });
  await h.emit("session_start");
  assert.equal(h.tools.length, 0);
  assert.deepEqual(h.notices, []);
});

test("a configured backend registers vm_observe once, and shutdown closes the backend", async (t) => {
  const h = host(t, { vmUse: { backend: "relay", relayImage: "macos26" } });
  const backends: FakeBackend[] = [];
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => {
    const backend = new FakeBackend({ TextEdit: [textEditRead()] });
    backends.push(backend);
    return backend;
  } });
  await h.emit("session_start");
  await h.emit("session_start");
  assert.deepEqual(h.tools.map(tool => tool.name), ["vm_observe"]);
  assert.equal(backends[0]!.closed, true, "A restarted session replaces and closes the previous backend");
  const result = await h.tools[0].execute("call-1", { app: "TextEdit" }, undefined, undefined, h.ctx);
  assert.equal(result.details.status, "ready");
  assert.equal(result.details.screenshot, "omitted_model_text_only");
  await h.emit("session_shutdown");
  assert.equal(backends[1]!.closed, true);
});

test("invalid configuration and a tool-name collision disable vm-use with a diagnostic", async (t) => {
  const invalid = host(t, { vmUse: { backend: "relay" } });
  delegatedInstall(invalid.pi, { root: invalid.root, agentDir: () => invalid.agentDir });
  await invalid.emit("session_start");
  assert.equal(invalid.tools.length, 0);
  assert.match(invalid.notices[0]!, /vm-use is disabled: .*relayImage/);

  const collision = host(t, { vmUse: { backend: "relay", relayImage: "macos26" } }, ["vm_observe"]);
  delegatedInstall(collision.pi, { root: collision.root, agentDir: () => collision.agentDir, backendFactory: () => new FakeBackend({}) });
  await collision.emit("session_start");
  assert.equal(collision.tools.length, 0);
  assert.match(collision.notices[0]!, /another extension provides vm_observe/);
});

test("vm_run_plan is registered only when the grounder is configured", async (t) => {
  const h = host(t, { vmUse: { backend: "relay", relayImage: "macos26", executorUrl: "http://jev.home.arpa" } });
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => new FakeBackend({}),
    grounderFactory: () => ({ decide: async () => { throw new Error("unused"); } }) });
  await h.emit("session_start");
  assert.deepEqual(h.tools.map(tool => tool.name), ["vm_observe", "vm_run_plan"]);
});

test("the start check accepts our previous plan's last read only when that plan ran after the based_on observation", async (t) => {
  const read = (label: string) => ({ window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements: [
    { element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
    { element_index: 1, role: "AXButton", label, parent_index: 0, depth: 1, frame: { x: 100, y: 50, w: 80, h: 20 } }] });
  // Reads in order: observe A; plan 1 before and after its press, then the read after the plan; the same for plan 2; observe B; plan 3's first read.
  const backend = new FakeBackend({ Form: [read("Submit"), read("Submit"), read("Done"), read("Done"), read("Done"), read("Submit"), read("Submit"), read("Submit"), read("Done")] });
  const h = host(t, { vmUse: { backend: "relay", relayImage: "macos26", executorUrl: "http://jev.home.arpa", settleMs: 0 } });
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => backend,
    grounderFactory: () => ({ decide: async () => ({ roundTripMs: 1, answers: { element_1: { choice: "A", confidence: 0.99 }, operation: { choice: "click", confidence: 0.99 }, risk: { choice: "safe", confidence: 0.99 } } }) }) });
  await h.emit("session_start");
  const [observeTool, runPlanTool] = h.tools;
  const observation = async () => /Observation: (\S+)/.exec((await observeTool.execute("o", { app: "Form" }, undefined, undefined, h.ctx)).content[0].text)![1]!;
  const run = (basedOn: string) => runPlanTool.execute("r", { app: "Form", goal: "g", based_on: basedOn,
    steps: [{ id: "s", intent: "Press the button" }] }, undefined, undefined, h.ctx);
  const a = await observation();
  assert.equal((await run(a)).details.outcome, "completed");
  const second = await run(a);
  assert.notEqual(second.details.escalation, "window_changed", "plan 1 ran after A, so its last read explains the change");
  const b = await observation();
  const third = await run(b);
  assert.equal(third.details.escalation, "window_changed", "plan 1 ran before B, so it does not explain the change");
});

test("the next plan starts from the previous plan's result, with no observation in between (decision PS-D20)", async (t) => {
  const read = (label: string) => ({ window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements: [
    { element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
    { element_index: 1, role: "AXButton", label, parent_index: 0, depth: 1, frame: { x: 100, y: 50, w: 80, h: 20 } }] });
  // Reads in order: observe; plan 1 before and after its press, then the read after the plan; the same three for plan 2.
  const backend = new FakeBackend({ Form: [read("Next"), read("Next"), read("Finish"), read("Finish"), read("Finish"), read("Done")] });
  const h = host(t, { vmUse: { backend: "relay", relayImage: "macos26", executorUrl: "http://jev.home.arpa", settleMs: 0 } });
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => backend,
    grounderFactory: () => ({ decide: async () => ({ roundTripMs: 1, answers: { element_1: { choice: "A", confidence: 0.99 }, operation: { choice: "click", confidence: 0.99 }, risk: { choice: "safe", confidence: 0.99 } } }) }) });
  await h.emit("session_start");
  const [observeTool, runPlanTool] = h.tools;
  const first = /Observation: (\S+)/.exec((await observeTool.execute("o", { app: "Form" }, undefined, undefined, h.ctx)).content[0].text)![1]!;
  const run = (basedOn: string, intent: string) => runPlanTool.execute("r", { app: "Form", goal: "g", based_on: basedOn, steps: [{ id: "s", intent }] }, undefined, undefined, h.ctx);
  const one = await run(first, "Press Next");
  assert.match(one.content[0].text, /Observation: (\S+)\n[^]*A Button "Finish"/);
  const two = await run(one.details.observationId, "Press Finish");
  assert.deepEqual([two.details.outcome, two.details.actions], ["completed", 1], "the result's observation is accepted as based_on");
  assert.equal(backend.reads.length, 7, "one observation, then three reads per plan and none between them");
});

test("the main session registers no computer tools and creates no backend, and offers the tools to delegated agents (PS-D11)", async (t) => {
  const config = { vmUse: { backend: "relay", relayImage: "macos26", executorUrl: "http://jev.home.arpa" } };
  const grounderFactory = () => ({ decide: async () => { throw new Error("unused"); } });
  let created = 0;
  const parent = host(t, config);
  const offer = installVmUse(parent.pi, { root: parent.root, agentDir: () => parent.agentDir,
    backendFactory: () => { created++; return new FakeBackend({}); }, grounderFactory });
  await parent.emit("session_start");
  assert.deepEqual(parent.tools.map(tool => tool.name), [], "The main agent cannot observe or act, so it cannot acquire a machine");
  assert.equal(created, 0, "The main session creates no backend");
  assert.deepEqual(offer.childTools(["read"]), ["read", "vm_observe", "vm_run_plan"], "Delegated agents may still be given the tools");

  const child = host(t, config);
  installVmUse(child.pi, { root: child.root, agentDir: () => child.agentDir, delegated: true,
    backendFactory: () => new FakeBackend({}), grounderFactory });
  await child.emit("session_start");
  assert.deepEqual(child.tools.map(tool => tool.name), ["vm_observe", "vm_run_plan"], "A delegated session registers the tools");
});

test("a delegated agent's plan approval reaches the main session's dialog, and without an interface nobody is asked (design §8.4)", async (t) => {
  const config = { vmUse: { backend: "relay", relayImage: "macos26", executorUrl: "http://jev.home.arpa", settleMs: 0, approvalTimeoutMs: 60_000,
    permissionCheck: "online", permissionOnline: { url: "http://api.home.arpa/v1/chat/completions", model: "deepseek-flash" } } };
  const read = (label: string) => ({ window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements: [
    { element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
    { element_index: 1, role: "AXButton", label, parent_index: 0, depth: 1, frame: { x: 100, y: 50, w: 80, h: 20 } }] });
  const dialogs: { title: string; message: string; timeout?: number }[] = [];
  const parent = host(t, config);
  (parent.ctx.ui as Record<string, unknown>).confirm = async (title: string, message: string, opts?: { timeout?: number }) => {
    dialogs.push({ title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) }); return true;
  };
  installVmUse(parent.pi, { root: parent.root, agentDir: () => parent.agentDir });
  await parent.emit("session_start");

  const backend = new FakeBackend({ Form: [read("Send"), read("Sent"), read("Send")] });
  const child = host(t, config);
  child.ctx.hasUI = false;
  const grounder = { decide: async () => ({ roundTripMs: 1, answers: { element_1: { choice: "A", confidence: 0.99 }, operation: { choice: "click", confidence: 0.99 }, risk: { choice: "safe", confidence: 0.99 } } }) };
  const online = fakePlanChecker(() => ({ reach: "outside_guest", requested: "no" }));
  delegatedInstall(child.pi, { root: child.root, agentDir: () => child.agentDir, backendFactory: () => backend, grounderFactory: () => grounder, onlineFactory: () => online });
  await child.emit("session_start");
  const runPlanTool = child.tools.find(tool => tool.name === "vm_run_plan");
  const run = () => runPlanTool.execute("r", { app: "Form", goal: "Send the form", steps: [{ id: "send", intent: "Send it", action: "click", ui_element: { role: "Button", name: "Send" } }] }, undefined, undefined, child.ctx);
  assert.equal((await run()).details.outcome, "completed");
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0]!.title, "vm-use needs approval");
  assert.equal(dialogs[0]!.timeout, 60_000);
  assert.match(dialogs[0]!.message, /This step needs approval:\n- send: click Button "Send"\n  The agent's step: Send it\n  Why: its effect leaves the virtual machine\./);

  await parent.emit("session_shutdown");
  const stopped = await run();
  assert.equal(stopped.details.escalation, "approval_required", "After the main session ends, nobody can be asked");
  assert.equal(dialogs.length, 1);
  assert.equal(backend.actions.length, 1);
});

test("the grounder reads the delegated request as the parent wrote it, the session's first user message (design §7.1, PS-D39)", async (t) => {
  const task = "As an accessibility test, press Submit through its accessibility functions.";
  const message = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
  assert.equal(delegatedRequest([{ type: "model_change" } as never, message(`${CHILD_TASK_PREFIX}${task}`) as never, message("A later message") as never], CHILD_TASK_PREFIX), task);
  assert.equal(delegatedRequest([{ type: "message", message: { role: "user", content: "Plain text" } } as never]), "Plain text");
  assert.equal(delegatedRequest([]), undefined);

  const read = (label: string) => ({ window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements: [
    { element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
    { element_index: 1, role: "AXButton", label, parent_index: 0, depth: 1, frame: { x: 100, y: 50, w: 80, h: 20 } }] });
  const backend = new FakeBackend({ Form: [read("Submit"), read("Done")] });
  const bodies: Record<string, unknown>[] = [];
  const h = host(t, { vmUse: { backend: "relay", relayImage: "macos26", executorUrl: "http://jev.home.arpa", settleMs: 0 } });
  h.entries.push(message(`${CHILD_TASK_PREFIX}${task}`));
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => backend, taskPrefix: CHILD_TASK_PREFIX,
    grounderFactory: () => ({ decide: async body => { bodies.push(body.state as Record<string, unknown>); return { roundTripMs: 1, answers: { element_1: { choice: "A", confidence: 0.99 }, operation: { choice: "ax_press", confidence: 0.99 }, risk: { choice: "safe", confidence: 0.99 } } }; } }) });
  await h.emit("session_start");
  const runPlanTool = h.tools.find(tool => tool.name === "vm_run_plan");
  const result = await runPlanTool.execute("r", { app: "Form", goal: "Press Submit", steps: [{ id: "s", intent: "Press Submit" }] }, undefined, undefined, h.ctx);
  assert.equal(result.details.outcome, "completed");
  assert.equal(bodies[0]!.request, task);
  assert.deepEqual(backend.actions.map(entry => entry.action.kind), ["accessibility"]);
  assert.match(result.content[0].text, /- s: acted, ax_press "Submit"/);
});

