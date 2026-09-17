import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChildRunner } from "../../extensions/secretary/agents/runner.ts";
import { inChildSession, runInChildSession } from "../../extensions/secretary/agents/child-context.ts";
import type { AgentRecord, AgentRun, RunnerHooks } from "../../extensions/secretary/agents/records.ts";
import { goalTokenDeltaForUsage } from "../../extensions/secretary/goal/accounting.ts";

async function fixture(t: TestContext, responses: Array<string | { tool: string; args?: Record<string, unknown> }> = ["done"]) {
  const root = await mkdtemp(join(tmpdir(), "secretary-child-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(async () => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "agent"));
  await mkdir(join(root, "sessions"));
  await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  // An invalid auth file makes accidental credential-file loading observable.
  await writeFile(join(root, "agent", "auth.json"), "NOT JSON");
  await writeFile(join(root, "AGENTS.md"), "Project instruction sentinel.");
  const model: Model<"openai-completions"> = { id: "child", name: "Child test", provider: "child-test", api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/never", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "store.json"), refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const calls: Context[] = [];
  let gate: (() => Promise<void>) | undefined;
  registry.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fake", models: [model],
    streamSimple(m, context, options) {
      assert.equal(inChildSession(), true);
      assert.equal(options?.apiKey, "fake");
      calls.push({ ...context, messages: structuredClone(context.messages), tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) });
      const response = responses.shift() ?? "done";
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await gate?.();
        const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id,
          content: typeof response === "string" ? [{ type: "text", text: response }] : [{ type: "toolCall", name: response.tool, id: `call-${calls.length}`, arguments: response.args ?? {} }],
          stopReason: options?.signal?.aborted ? "aborted" : response === "error" ? "error" : typeof response === "string" ? "stop" : "toolUse",
          usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, totalTokens: 19, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          timestamp: Date.now(), ...(response === "error" ? { errorMessage: "deterministic failure" } : {}) };
        if (message.stopReason === "aborted" || message.stopReason === "error") stream.push({ type: "error", reason: message.stopReason, error: message });
        else stream.push({ type: "done", reason: typeof response === "string" ? "stop" : "toolUse", message });
        stream.end();
      })();
      return stream;
    },
  });
  const ctx = { modelRegistry: registry, model, scopedModels: [], isProjectTrusted: () => true } as unknown as ExtensionContext;
  const agent: AgentRecord = { agentId: "a", parentId: "parent", definition: { name: "test", description: "test", prompt: "Role sentinel.", source: "test", hash: "h", resumable: true },
    model: `${model.provider}/${model.id}`, tools: ["read"], cwd: root, configCwd: root, resumable: true, createdAt: 1 };
  const run: AgentRun = { runId: "r", agentId: "a", parentId: "parent", launchKey: "k", prompt: "Task sentinel", description: "task", status: "starting", background: false, createdAt: 1, outputPath: join(root, "output"), output: "", toolCount: 0, turnCount: 0, revision: 0 };
  const usage: Array<{ id: string; value: Parameters<RunnerHooks["usage"]>[1] }> = [];
  let path = "";
  const hooks: RunnerHooks = { session(value) { path = value; }, text() {}, activity() {}, turn() {}, usage(id, value) { usage.push({ id, value }); }, authorize() {} };
  const controller = new AbortController();
  const start = async () => { const child = await createChildRunner({ agent, run, ctx, signal: controller.signal, hooks, sessionDir: join(root, "sessions") }); t.after(() => child.dispose()); return child; };
  return { root, agent, run, ctx, hooks, controller, calls, usage, start, setGate(fn: () => Promise<void>) { gate = fn; }, get path() { return path; } };
}

test("child context is async-local and does not mark its parent", async () => {
  assert.equal(inChildSession(), false);
  await runInChildSession(async () => { await Promise.resolve(); assert.equal(inChildSession(), true); });
  assert.equal(inChildSession(), false);
});

test("SDK child inherits public provider, project instructions, role, tools, and usage without user auth", async (t) => {
  const f = await fixture(t);
  const child = await f.start();
  assert.deepEqual(await child.result, { status: "succeeded", output: "done" });
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.systemPrompt!, /Role sentinel/);
  assert.match(f.calls[0]!.systemPrompt!, /Project instruction sentinel/);
  assert.deepEqual(f.calls[0]!.tools?.map((tool) => tool.name), ["read"]);
  assert.equal(f.calls[0]!.messages.length, 1);
  assert.equal(goalTokenDeltaForUsage(f.usage[0]!.value), 11);
  assert.match(f.usage[0]!.id, /^r:message:/);
  assert.match(await readFile(f.path, "utf8"), /Task sentinel/);
  await child.abort();
  assert.equal((await child.result).status, "succeeded");
  await child.dispose(); await child.dispose();
});

test("resume uses saved conversation but output and usage belong to latest run", async (t) => {
  const f = await fixture(t, ["first", "second"]);
  const first = await f.start(); await first.result; await first.dispose();
  f.agent.sessionPath = f.path; f.run.runId = "r2"; f.run.prompt = "New explicit task";
  const second = await f.start();
  assert.equal((await second.result).output, "second");
  assert.equal(f.calls[1]!.messages.filter((m) => m.role === "assistant").length, 1);
  assert.match(f.usage[1]!.id, /^r2:message:/);
  assert.equal(SessionManager.open(f.path).getSessionId(), SessionManager.open(f.agent.sessionPath).getSessionId());
});

test("turn limit settles as partial without another provider request", async (t) => {
  const f = await fixture(t, [{ tool: "read", args: { path: "AGENTS.md" } }, "unexpected"]);
  f.agent.definition.maxTurns = 1;
  const child = await f.start();
  assert.equal((await child.result).status, "partial");
  assert.equal(f.calls.length, 1);
});

test("abort during provider execution settles cancelled and late steering is rejected", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.setGate(() => gate);
  const child = await f.start();
  while (!f.calls.length) await new Promise((resolve) => setImmediate(resolve));
  const stopped = child.abort(); release(); await stopped;
  assert.equal((await child.result).status, "cancelled");
  await assert.rejects(child.steer("late"), /no longer/);
});

test("guidance is literal user text, not slash-command expansion", async (t) => {
  const f = await fixture(t, ["first", "second"]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.setGate(() => gate);
  const child = await f.start();
  while (!f.calls.length) await new Promise((resolve) => setImmediate(resolve));
  await child.steer("/danger literal guidance"); release();
  assert.equal((await child.result).output, "second");
  assert.match(JSON.stringify(f.calls[1]!.messages), /\/danger literal guidance/);
});

test("authorization revoked at tool boundary blocks filesystem side effects and new calls", async (t) => {
  const f = await fixture(t, [{ tool: "write", args: { path: "forbidden.txt", content: "oops" } }]);
  f.agent.tools = ["write"];
  let permitted = true;
  f.hooks.authorize = () => { if (!permitted) throw new Error("obsolete goal"); };
  f.setGate(async () => { permitted = false; });
  const child = await f.start();
  assert.equal((await child.result).status, "partial");
  await assert.rejects(readFile(join(f.root, "forbidden.txt")));
  assert.equal(f.calls.length, 1);
});

test("trusted extensions start and shut down once; late forbidden tools stay unavailable", async (t) => {
  const f = await fixture(t, [{ tool: "Agent" }]);
  await mkdir(join(f.root, ".pi", "extensions"), { recursive: true });
  const log = join(f.root, "lifecycle.log");
  await writeFile(join(f.root, ".pi", "extensions", "lifecycle.js"), `
    import { appendFileSync } from "node:fs";
    export default function(pi) {
      pi.on("session_start", () => {
        appendFileSync(${JSON.stringify(log)}, "start\\n");
        pi.registerTool({ name: "Agent", label: "nested", description: "forbidden", parameters: { type: "object", properties: {} },
          async execute() { appendFileSync(${JSON.stringify(log)}, "EXECUTED\\n"); return { content: [], details: {} }; } });
        pi.setActiveTools(["Agent", "read"]);
      });
      pi.on("session_shutdown", () => { appendFileSync(${JSON.stringify(log)}, "shutdown\\n"); });
    }
  `);
  const child = await f.start();
  await child.result;
  assert.deepEqual(f.calls[0]!.tools?.map((tool) => tool.name), ["read"]);
  await child.dispose(); await child.dispose();
  assert.equal(await readFile(log, "utf8"), "start\nshutdown\n");
});

test("worktree tools use actual cwd while instructions use configCwd", async (t) => {
  const f = await fixture(t, [{ tool: "read", args: { path: "work.txt" } }, "done"]);
  const worktree = join(f.root, "worktree");
  await mkdir(worktree); await writeFile(join(worktree, "work.txt"), "worktree sentinel");
  f.agent.cwd = worktree;
  const child = await f.start();
  assert.equal((await child.result).status, "succeeded");
  assert.match(f.calls[0]!.systemPrompt!, /Project instruction sentinel/);
  assert.match(JSON.stringify(f.calls[1]!.messages), /worktree sentinel/);
});

test("guidance accepted before initial dispatch survives without command expansion", async (t) => {
  const f = await fixture(t, ["first", "second"]);
  const child = await f.start();
  await child.steer("/plain queued before dispatch");
  await child.result;
  assert.match(JSON.stringify(f.calls), /\/plain queued before dispatch/);
});

test("current parent permissions narrow tools at execution time", async (t) => {
  const f = await fixture(t, [{ tool: "write", args: { path: "forbidden.txt", content: "oops" } }]);
  f.agent.tools = ["write"];
  let allowed = ["write"];
  f.hooks.allowedTools = () => allowed;
  f.setGate(async () => { allowed = []; });
  const child = await f.start();
  assert.equal((await child.result).status, "partial");
  await assert.rejects(readFile(join(f.root, "forbidden.txt")));
});

test("tools removed after model submission cannot execute", async (t) => {
  const f = await fixture(t, [{ tool: "write", args: { path: "forbidden.txt", content: "oops" } }]);
  f.agent.tools = ["write"];
  f.setGate(async () => { f.agent.tools = []; });
  const child = await f.start();
  assert.equal((await child.result).status, "partial");
  await assert.rejects(readFile(join(f.root, "forbidden.txt")));
});

test("untrusted project extensions cannot execute", async (t) => {
  const f = await fixture(t);
  f.ctx.isProjectTrusted = () => false;
  await mkdir(join(f.root, ".pi", "extensions"), { recursive: true });
  await writeFile(join(f.root, ".pi", "extensions", "bad.js"), "export default function() { throw new Error('UNTRUSTED EXECUTION'); }");
  const child = await f.start();
  assert.equal((await child.result).status, "succeeded");
});

test("cancellation before deferred prompt dispatch makes no model call", async (t) => {
  const f = await fixture(t);
  const child = await f.start();
  await child.dispose();
  assert.equal((await child.result).status, "cancelled");
  assert.equal(f.calls.length, 0);
});

test("unrecovered provider errors fail, not empty success", async (t) => {
  const f = await fixture(t, ["error"]);
  const child = await f.start();
  assert.equal((await child.result).status, "failed");
});
