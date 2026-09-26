import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeBackend } from "../../extensions/secretary/computer-use/backend/fake-backend.ts";
import { installComputerUse } from "../../extensions/secretary/computer-use/installation.ts";
import { textEditRead } from "./fixtures/trees.ts";

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
  installComputerUse(h.pi, { root: h.root, agentDir: () => h.agentDir });
  await h.emit("session_start");
  assert.equal(h.tools.length, 0);
  assert.deepEqual(h.notices, []);
});

test("a configured backend registers computer_observe once, and shutdown closes the backend", async (t) => {
  const h = host(t, { computerUse: { backend: "local", allowLocalDesktop: true } });
  const backends: FakeBackend[] = [];
  installComputerUse(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => {
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
  installComputerUse(invalid.pi, { root: invalid.root, agentDir: () => invalid.agentDir });
  await invalid.emit("session_start");
  assert.equal(invalid.tools.length, 0);
  assert.match(invalid.notices[0]!, /computer use is disabled: .*allowLocalDesktop/);

  const collision = host(t, { computerUse: { backend: "local", allowLocalDesktop: true } }, ["computer_observe"]);
  installComputerUse(collision.pi, { root: collision.root, agentDir: () => collision.agentDir, backendFactory: () => new FakeBackend({}) });
  await collision.emit("session_start");
  assert.equal(collision.tools.length, 0);
  assert.match(collision.notices[0]!, /another extension provides computer_observe/);
});

test("computer_run_plan is registered only when the executor is configured", async (t) => {
  const h = host(t, { computerUse: { backend: "local", allowLocalDesktop: true, executorUrl: "http://jev.home.arpa" } });
  installComputerUse(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => new FakeBackend({}),
    executorFactory: () => ({ decide: async () => { throw new Error("unused"); } }) });
  await h.emit("session_start");
  assert.deepEqual(h.tools.map(tool => tool.name), ["computer_observe", "computer_run_plan"]);
});

test("the start check accepts our previous plan's last read only when that plan ran after the based_on observation", async (t) => {
  const read = (label: string) => ({ window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements: [
    { element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
    { element_index: 1, role: "AXButton", label, parent_index: 0, depth: 1, frame: { x: 100, y: 50, w: 80, h: 20 } }] });
  // Reads in order: observe A; plan 1 before and after its press; plan 2 before and after; observe B; plan 3's first read.
  const backend = new FakeBackend({ Form: [read("Submit"), read("Submit"), read("Done"), read("Done"), read("Submit"), read("Submit"), read("Done")] });
  const h = host(t, { computerUse: { backend: "local", allowLocalDesktop: true, executorUrl: "http://jev.home.arpa", settleMs: 0 } });
  installComputerUse(h.pi, { root: h.root, agentDir: () => h.agentDir, backendFactory: () => backend,
    executorFactory: () => ({ decide: async () => ({ roundTripMs: 1, answers: { element_1: { choice: "A", confidence: 0.99 }, operation: { choice: "click", confidence: 0.99 }, risk: { choice: "safe", confidence: 0.99 } } }) }) });
  await h.emit("session_start");
  const [observeTool, runPlanTool] = h.tools;
  const observation = async () => /Observation: (\S+)/.exec((await observeTool.execute("o", { app: "Form" }, undefined, undefined, h.ctx)).content[0].text)![1]!;
  const run = (basedOn: string, postcondition: unknown) => runPlanTool.execute("r", { app: "Form", goal: "g", based_on: basedOn,
    steps: [{ id: "s", intent: "Press the button", postcondition }] }, undefined);
  const a = await observation();
  assert.equal((await run(a, { exists: { name: "Done" } })).details.outcome, "completed");
  const second = await run(a, { absent: { name: "Done" } });
  assert.notEqual(second.details.escalation, "window_changed", "plan 1 ran after A, so its last read explains the change");
  const b = await observation();
  const third = await run(b, { absent: { name: "Done" } });
  assert.equal(third.details.escalation, "window_changed", "plan 1 ran before B, so it does not explain the change");
});
