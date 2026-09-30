import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeBackend } from "../../extensions/secretary/computer-use/backend/fake-backend.ts";
import { installComputerUse } from "../../extensions/secretary/computer-use/installation.ts";
import { textEditRead } from "./fixtures/trees.ts";
import { withGuardian } from "./support/guardian-answers.ts";

/** Only a delegated session registers the computer-use tools (decision PS-D11). */
const delegatedInstall = (pi: ExtensionAPI, options: Parameters<typeof installComputerUse>[1]) => installComputerUse(pi, { ...options, delegated: true });

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
  const ctx = { cwd: root, hasUI: true, isProjectTrusted: () => false, ui: { notify: (message: string) => notices.push(message) },
    sessionManager: { getSessionId: () => "session-1" }, model: { input: ["text"] } };
  const emit = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
  return { pi, root, agentDir, tools, notices, emit, ctx };
}

test("nothing is registered without a configured backend", async (t) => {
  const h = host(t, undefined);
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir });
  await h.emit("session_start");
  assert.equal(h.tools.length, 0);
  assert.deepEqual(h.notices, []);
});

test("a configured backend registers computer_observe once, and shutdown closes the backend", async (t) => {
  const h = host(t, { computerUse: { backend: "local", allowLocalDesktop: true } });
  const backends: FakeBackend[] = [];
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => {
    const backend = new FakeBackend({ TextEdit: [textEditRead()] });
    backends.push(backend);
    return backend;
  } });
  await h.emit("session_start");
  await h.emit("session_start");
  assert.deepEqual(h.tools.map(tool => tool.name), ["computer_observe"]);
  assert.equal(backends[0]!.closed, true, "A restarted session replaces and closes the previous backend");
  const result = await h.tools[0].execute("call-1", { app: "TextEdit" }, undefined, undefined, h.ctx);
  assert.equal(result.details.status, "ready");
  assert.equal(result.details.screenshot, "omitted_model_text_only");
  await h.emit("session_shutdown");
  assert.equal(backends[1]!.closed, true);
});

test("invalid configuration and a tool-name collision disable computer use with a diagnostic", async (t) => {
  const invalid = host(t, { computerUse: { backend: "local" } });
  delegatedInstall(invalid.pi, { root: invalid.root, agentDir: () => invalid.agentDir });
  await invalid.emit("session_start");
  assert.equal(invalid.tools.length, 0);
  assert.match(invalid.notices[0]!, /computer use is disabled: .*allowLocalDesktop/);

  const collision = host(t, { computerUse: { backend: "local", allowLocalDesktop: true } }, ["computer_observe"]);
  delegatedInstall(collision.pi, { root: collision.root, agentDir: () => collision.agentDir, backendFactory: () => new FakeBackend({}) });
  await collision.emit("session_start");
  assert.equal(collision.tools.length, 0);
  assert.match(collision.notices[0]!, /another extension provides computer_observe/);
});

test("computer_run_plan is registered only when the grounder is configured", async (t) => {
  const h = host(t, { computerUse: { backend: "local", allowLocalDesktop: true, executorUrl: "http://jev.home.arpa" } });
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => new FakeBackend({}),
    grounderFactory: () => ({ decide: async () => { throw new Error("unused"); } }) });
  await h.emit("session_start");
  assert.deepEqual(h.tools.map(tool => tool.name), ["computer_observe", "computer_run_plan"]);
});

test("the start check accepts our previous plan's last read only when that plan ran after the based_on observation", async (t) => {
  const read = (label: string) => ({ window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements: [
    { element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
    { element_index: 1, role: "AXButton", label, parent_index: 0, depth: 1, frame: { x: 100, y: 50, w: 80, h: 20 } }] });
  // Reads in order: observe A; plan 1 before and after its press, then the read after the plan; the same for plan 2; observe B; plan 3's first read.
  const backend = new FakeBackend({ Form: [read("Submit"), read("Submit"), read("Done"), read("Done"), read("Done"), read("Submit"), read("Submit"), read("Submit"), read("Done")] });
  const h = host(t, { computerUse: { backend: "local", allowLocalDesktop: true, executorUrl: "http://jev.home.arpa", settleMs: 0 } });
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => backend,
    grounderFactory: () => withGuardian({ decide: async () => ({ roundTripMs: 1, answers: { element_1: { choice: "A", confidence: 0.99 }, operation: { choice: "click", confidence: 0.99 }, risk: { choice: "safe", confidence: 0.99 } } }) }) });
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
  const h = host(t, { computerUse: { backend: "local", allowLocalDesktop: true, executorUrl: "http://jev.home.arpa", settleMs: 0 } });
  delegatedInstall(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => backend,
    grounderFactory: () => withGuardian({ decide: async () => ({ roundTripMs: 1, answers: { element_1: { choice: "A", confidence: 0.99 }, operation: { choice: "click", confidence: 0.99 }, risk: { choice: "safe", confidence: 0.99 } } }) }) });
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
  const config = { computerUse: { backend: "local", allowLocalDesktop: true, executorUrl: "http://jev.home.arpa" } };
  const grounderFactory = () => ({ decide: async () => { throw new Error("unused"); } });
  let created = 0;
  const parent = host(t, config);
  const offer = installComputerUse(parent.pi, { root: parent.root, agentDir: () => parent.agentDir,
    backendFactory: () => { created++; return new FakeBackend({}); }, grounderFactory });
  await parent.emit("session_start");
  assert.deepEqual(parent.tools.map(tool => tool.name), [], "The main agent cannot observe or act, so it cannot acquire a machine");
  assert.equal(created, 0, "The main session creates no backend");
  assert.deepEqual(offer.childTools(["read"]), ["read", "computer_observe", "computer_run_plan"], "Delegated agents may still be given the tools");

  const child = host(t, config);
  installComputerUse(child.pi, { root: child.root, agentDir: () => child.agentDir, delegated: true,
    backendFactory: () => new FakeBackend({}), grounderFactory });
  await child.emit("session_start");
  assert.deepEqual(child.tools.map(tool => tool.name), ["computer_observe", "computer_run_plan"], "A delegated session registers the tools");
});

test("a delegated agent's approval reaches the main session's dialog, and without an interface nobody is asked (design §8.5)", async (t) => {
  const config = { computerUse: { backend: "local", allowLocalDesktop: true, executorUrl: "http://jev.home.arpa", settleMs: 0, approvalTimeoutMs: 60_000 } };
  const read = (label: string) => ({ window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements: [
    { element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
    { element_index: 1, role: "AXButton", label, parent_index: 0, depth: 1, frame: { x: 100, y: 50, w: 80, h: 20 } }] });
  const dialogs: { title: string; message: string; timeout?: number }[] = [];
  const parent = host(t, config);
  (parent.ctx.ui as Record<string, unknown>).confirm = async (title: string, message: string, opts?: { timeout?: number }) => {
    dialogs.push({ title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) }); return true;
  };
  installComputerUse(parent.pi, { root: parent.root, agentDir: () => parent.agentDir });
  await parent.emit("session_start");

  const backend = new FakeBackend({ Form: [read("Send"), read("Sent"), read("Send")] });
  const child = host(t, config);
  child.ctx.hasUI = false;
  const grounder = withGuardian({ decide: async () => ({ roundTripMs: 1, answers: { element_1: { choice: "A", confidence: 0.99 }, operation: { choice: "click", confidence: 0.99 }, risk: { choice: "safe", confidence: 0.99 } } }) },
    () => ({ effect: ["change", 0.9], reach: ["outside", 0.9] }));
  delegatedInstall(child.pi, { root: child.root, agentDir: () => child.agentDir, backendFactory: () => backend, grounderFactory: () => grounder });
  await child.emit("session_start");
  const runPlanTool = child.tools.find(tool => tool.name === "computer_run_plan");
  const run = () => runPlanTool.execute("r", { app: "Form", goal: "Send the form", steps: [{ id: "send", intent: "Send it" }] }, undefined, undefined, child.ctx);
  assert.equal((await run()).details.outcome, "completed");
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0]!.title, "Computer use needs approval");
  assert.equal(dialogs[0]!.timeout, 60_000);
  assert.match(dialogs[0]!.message, /Action: click Button "Send"\nWhy it asks: the permission guardian judged that its effect leaves this machine\./);

  await parent.emit("session_shutdown");
  const stopped = await run();
  assert.equal(stopped.details.escalation, "approval_required", "After the main session ends, nobody can be asked");
  assert.equal(dialogs.length, 1);
  assert.equal(backend.actions.length, 1);
});
