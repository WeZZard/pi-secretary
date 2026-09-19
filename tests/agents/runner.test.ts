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

async function fixture(t: TestContext, responses: Array<string | { tool: string; args?: Record<string, unknown> } | { error: string }> = ["done"]) {
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
  const secondary: Model<"openai-completions"> = { ...model, id: "secondary", name: "Secondary test" };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "store.json"), refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const calls: Array<Context & { modelId: string }> = [];
  let gate: (() => Promise<void>) | undefined;
  registry.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fake", models: [model, secondary],
    streamSimple(m, context, options) {
      assert.equal(inChildSession(), true);
      assert.equal(options?.apiKey, "fake");
      calls.push({ modelId: m.id, ...context, messages: structuredClone(context.messages), tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) });
      const response = responses.shift() ?? "done";
      const isError = response === "error" || (typeof response === "object" && "error" in response);
      const errorMessage = typeof response === "object" && "error" in response ? response.error : "deterministic failure";
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await gate?.();
        const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id,
          content: typeof response === "string" && response !== "error" ? [{ type: "text", text: response }] : typeof response === "object" && "tool" in response ? [{ type: "toolCall", name: response.tool, id: `call-${calls.length}`, arguments: response.args ?? {} }] : [],
          stopReason: options?.signal?.aborted ? "aborted" : isError ? "error" : typeof response === "string" ? "stop" : "toolUse",
          usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, totalTokens: 19, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          timestamp: Date.now(), ...(isError ? { errorMessage } : {}) };
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

test("runner advances to the next fallback candidate on a first-request availability failure", async (t) => {
  const f = await fixture(t, [{ error: 'OpenAI API error (429): {"code":"model_cooldown","reset_seconds":60} usage_limit_reached' }, "recovered"]);
  f.agent.modelCandidates = ["child-test/secondary"];
  const skipped: Array<{ id: string; resetAt?: number }> = [];
  let committed: string | undefined;
  f.hooks.availability = (id, resetAt) => skipped.push({ id, resetAt });
  f.hooks.model = id => { committed = id; };
  const child = await f.start();
  assert.deepEqual(await child.result, { status: "succeeded", output: "recovered" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.modelId, "child");
  assert.equal(f.calls[1]!.modelId, "secondary");
  assert.deepEqual(skipped.map(s => s.id), ["child-test/child"]);
  assert.equal(skipped[0]!.resetAt! > Date.now(), true, "The provider-reported reset_seconds becomes an absolute reset time");
  assert.equal(committed, "child-test/secondary", "The run record adopts the model that actually executed");
});

test("runner fails the run without advancing when the first-request error is not an availability failure", async (t) => {
  const f = await fixture(t, [{ error: "content policy violation" }, "unused"]);
  f.agent.modelCandidates = ["child-test/secondary"];
  const child = await f.start();
  const outcome = await child.result;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /content policy/);
  assert.equal(f.calls.length, 1, "No second candidate is attempted");
});

test("runner reports every attempted candidate when the whole chain fails", async (t) => {
  const f = await fixture(t, [{ error: "429 quota exhausted" }, { error: "usage_limit_reached" }]);
  f.agent.modelCandidates = ["child-test/secondary"];
  const skipped: string[] = [];
  f.hooks.availability = id => { skipped.push(id); };
  const child = await f.start();
  const outcome = await child.result;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /child-test\/child[\s\S]*child-test\/secondary/, "The failure lists each attempted model and its reason");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(skipped, ["child-test/child", "child-test/secondary"]);
});

test("runner advances to the next fallback candidate on a first-request 401 credential rejection", async (t) => {
  const f = await fixture(t, [{ error: 'OpenAI API error (401): {"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}' }, "recovered"]);
  f.agent.modelCandidates = ["child-test/secondary"];
  const child = await f.start();
  assert.deepEqual(await child.result, { status: "succeeded", output: "recovered" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.modelId, "secondary");
});

test("runner fallback survives extensions that write session state on session_start", async (t) => {
  const f = await fixture(t, [{ error: 'OpenAI API error (429): {"code":"model_cooldown","reset_seconds":60} usage_limit_reached' }, "recovered"]);
  f.agent.modelCandidates = ["child-test/secondary"];
  // Mirrors pi-recap's session_start persistence: pi.appendEntry asserts on the loader's
  // shared extension runtime, which a previous attempt's dispose invalidates when the
  // runner reuses one DefaultResourceLoader across candidates (2026-09-19 incident).
  await mkdir(join(f.root, ".pi", "extensions"), { recursive: true });
  await writeFile(join(f.root, ".pi", "extensions", "persist-probe.js"), `
    export default function(pi) {
      pi.on("session_start", async () => {
        pi.appendEntry("persist-probe", {});
      });
    }
  `);
  const child = await f.start();
  assert.deepEqual(await child.result, { status: "succeeded", output: "recovered" },
    "The second candidate must not inherit an invalidated extension runtime");
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.modelId, "secondary");
});

test("runner reports the attempted candidates when a later candidate's setup aborts the chain", async (t) => {
  const f = await fixture(t, [{ error: "429 quota exhausted" }]);
  // child-test/ghost is not registered, so its setup fails after the first candidate's
  // availability failure; the run error must keep the first candidate's context.
  f.agent.modelCandidates = ["child-test/ghost"];
  const child = await f.start();
  const outcome = await child.result;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /child-test\/child[\s\S]*429/, "The first candidate's availability failure stays in the report");
  assert.match(outcome.error!, /child-test\/ghost/, "The candidate whose setup failed is identified");
  assert.equal(f.calls.length, 1);
});

async function installUIProbe(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(join(f.root, ".pi", "extensions"), { recursive: true });
  const log = join(f.root, "ui-lifecycle.jsonl");
  await writeFile(join(f.root, ".pi", "extensions", "ui-probe.js"), `
    import assert from "node:assert/strict";
    import { appendFileSync } from "node:fs";
    export default function(pi) {
      async function probe(event, ctx) {
        assert.equal(ctx.mode, "print");
        assert.equal(ctx.hasUI, false, "Child must not advertise a terminal it does not own");
        ctx.ui.setWidget("probe", () => { throw new Error("Child rendered a widget"); });
        ctx.ui.notify("Optional child notification");
        const unsubscribe = ctx.ui.onTerminalInput(() => { throw new Error("Child received terminal input"); });
        assert.equal(typeof unsubscribe, "function");
        unsubscribe();
        assert.equal(ctx.ui.getEditorText(), "");
        assert.equal(await ctx.ui.confirm("Approval", "Proceed?"), false);
        assert.equal(await ctx.ui.select("Choose", ["yes"]), undefined);
        assert.equal(await ctx.ui.input("Input"), undefined);
        assert.equal(await ctx.ui.editor("Editor"), undefined);
        assert.equal(await ctx.ui.custom(() => { throw new Error("Child opened a dialog"); }), undefined);
        appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event: event.type, reason: event.reason,
          sessionId: ctx.sessionManager.getSessionId() }) + "\\n");
      }
      pi.on("session_start", probe);
      pi.on("before_agent_start", probe);
      pi.on("session_shutdown", probe);
    }
  `);
  return async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

test("native child UI remains complete and non-interactive through startup, resume, and shutdown", async t => {
  const f = await fixture(t, ["first", "second"]);
  let parentCalls = 0;
  const parentUI = { setWidget() { parentCalls++; }, notify() { parentCalls++; } };
  Object.assign(f.ctx, { mode: "tui", hasUI: true, ui: parentUI });
  const readEvents = await installUIProbe(f);
  const first = await f.start();
  assert.equal((await first.result).status, "succeeded");
  await first.dispose(); await first.dispose();
  f.agent.sessionPath = f.path; f.run.runId = "resumed-ui";
  const second = await f.start();
  assert.equal((await second.result).status, "succeeded");
  await second.dispose();
  const events = await readEvents();
  assert.deepEqual(events.map(e => e.event), ["session_start", "before_agent_start", "session_shutdown",
    "session_start", "before_agent_start", "session_shutdown"]);
  assert.equal(events[0].reason, "startup"); assert.equal(events[3].reason, "resume");
  assert.equal(events[0].sessionId, events[3].sessionId);
  assert.equal(f.ctx.mode, "tui"); assert.equal(f.ctx.hasUI, true); assert.equal(f.ctx.ui, parentUI);
  assert.equal(parentCalls, 0);
});

test("concurrent children retain separate lifecycles without borrowing the parent terminal", { timeout: 10000 }, async t => {
  const f = await fixture(t, ["first", "second"]);
  const readEvents = await installUIProbe(f);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setGate(() => gate);
  const children = await Promise.all([f.start(), f.start()]);
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual((await Promise.all(children.map(child => child.result))).map(result => result.status), ["succeeded", "succeeded"]);
  await Promise.all(children.map(child => child.dispose()));
  const events = await readEvents();
  const ids = new Set(events.map(event => event.sessionId));
  assert.equal(ids.size, 2);
  for (const id of ids) assert.deepEqual(events.filter(event => event.sessionId === id).map(event => event.event),
    ["session_start", "before_agent_start", "session_shutdown"]);
});

test("native child UI remains safe during cancellation and idempotent disposal", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const readEvents = await installUIProbe(f);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setGate(() => gate);
  const child = await f.start();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  const stopped = child.abort(); release(); await stopped;
  assert.equal((await child.result).status, "cancelled");
  await child.dispose(); await child.dispose();
  assert.deepEqual((await readEvents()).map(event => event.event), ["session_start", "before_agent_start", "session_shutdown"]);
});

test("UI-required extension tools reject headless execution without prompting the parent", async t => {
  const f = await fixture(t, [{ tool: "ui_required" }, "Interactive operation unavailable"]);
  f.agent.tools = ["ui_required"];
  await mkdir(join(f.root, ".pi", "extensions"), { recursive: true });
  await writeFile(join(f.root, ".pi", "extensions", "interactive.js"), `
    export default function(pi) {
      pi.registerTool({ name: "ui_required", label: "Interactive operation", description: "Requires user input",
        parameters: { type: "object", properties: {} },
        async execute(_id, _args, _signal, _update, ctx) {
          if (!ctx.hasUI) throw new Error("This operation requires an interactive UI");
          throw new Error("Incorrectly entered the interactive execution path");
        }
      });
    }
  `);
  const child = await f.start();
  assert.equal((await child.result).output, "Interactive operation unavailable");
  const result = f.calls[1].messages.find(message => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /requires an interactive UI/);
  assert.doesNotMatch(JSON.stringify(result.content), /Incorrectly entered/);
});

test("headless UI does not suppress genuine extension startup failures", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".pi", "extensions"), { recursive: true });
  await writeFile(join(f.root, ".pi", "extensions", "failing.js"), `
    export default function(pi) {
      pi.on("session_start", () => { throw new Error("Independent startup failure"); });
    }
  `);
  await assert.rejects(f.start(), /Child extension error: Independent startup failure/);
  assert.equal(f.calls.length, 0);
});

async function installCompetingProvider(f: Awaited<ReturnType<typeof fixture>>, when: "load" | "startup" | "turn") {
  await mkdir(join(f.root, ".pi", "extensions"), { recursive: true });
  const log = join(f.root, "provider-startup.log");
  await writeFile(join(f.root, ".pi", "extensions", "provider.js"), `
    import { appendFileSync } from "node:fs";
    export default function(pi) {
      const provider = {
        id: "child-test", name: "Competing child provider",
        getModels: () => [${JSON.stringify(f.ctx.model)}],
        auth: { apiKey: { name: "No child credentials", resolve: async () => undefined } },
        stream() { throw new Error("Competing provider must not execute"); },
        streamSimple() { throw new Error("Competing provider must not execute"); },
      };
      const replace = () => pi.registerProvider(provider);
      if (${JSON.stringify(when)} === "load") replace();
      if (${JSON.stringify(when)} === "startup") pi.on("session_start", replace);
      if (${JSON.stringify(when)} === "turn") pi.on("before_agent_start", replace);
      if (${JSON.stringify(when)} === "load") pi.on("session_start", async (_, ctx) => {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        if (!auth.ok || auth.apiKey !== "fake") throw new Error("Startup handler cannot use parent authentication");
        appendFileSync(${JSON.stringify(log)}, "parent auth available\\n");
      });
    }
  `);
  return log;
}

test("parent authentication survives constructor-time provider registration and is available at startup", async t => {
  const f = await fixture(t, ["first", "second"]);
  const parentProvider = f.ctx.modelRegistry.getProvider("child-test");
  const log = await installCompetingProvider(f, "load");
  const first = await f.start();
  assert.deepEqual(await first.result, { status: "succeeded", output: "first" });
  await first.dispose();
  f.agent.sessionPath = f.path; f.run.runId = "resumed";
  const second = await f.start();
  assert.deepEqual(await second.result, { status: "succeeded", output: "second" });
  assert.equal(await readFile(log, "utf8"), "parent auth available\nparent auth available\n");
  assert.equal(f.ctx.modelRegistry.getProvider("child-test"), parentProvider);
  assert.equal(f.calls.length, 2);
});

test("startup provider replacement is rejected before child dispatch", async t => {
  const f = await fixture(t);
  await installCompetingProvider(f, "startup");
  await assert.rejects(f.start(), /parent-authentication adapter was replaced/i);
  assert.equal(f.calls.length, 0);
});

test("provider replacement after startup blocks the next model request", async t => {
  const f = await fixture(t);
  await installCompetingProvider(f, "turn");
  const child = await f.start();
  const result = await child.result;
  assert.equal(result.status, "partial");
  assert.match(result.error ?? "", /parent-authentication adapter was replaced/i);
  assert.equal(f.calls.length, 0);
});

test("SDK child permits an empty role prompt while retaining project instructions and task context", async (t) => {
  const f = await fixture(t);
  f.agent.definition.prompt = "";
  const child = await f.start();
  assert.equal((await child.result).status, "succeeded");
  assert.match(f.calls[0]!.systemPrompt!, /Project instruction sentinel/);
  assert.match(f.calls[0]!.systemPrompt!, /You are a child agent/);
  assert.doesNotMatch(f.calls[0]!.systemPrompt!, /Role sentinel/);
  assert.match(JSON.stringify(f.calls[0]!.messages), /Task sentinel/);
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
