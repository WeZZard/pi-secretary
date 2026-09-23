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
