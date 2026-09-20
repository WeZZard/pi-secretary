import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry, createReadTool } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";
import { installSecretary } from "../../extensions/secretary/index.ts";
import { AgentService, type LaunchSpec } from "../../extensions/secretary/agents/service.ts";
import { defaultAgentUi } from "../../extensions/secretary/agents/configuration.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { TERMINAL_STATUSES, type RunningChild } from "../../extensions/secretary/agents/records.ts";
import type { createChildRunner } from "../../extensions/secretary/agents/runner.ts";
import { deferred } from "./support.ts";

export const task = { description: "Inspect fixture", prompt: "Return a fixture result" };
export const turn = () => new Promise<void>(resolve => setImmediate(resolve));

export function serviceHarness(t: TestContext, options: { mode?: string; concurrent?: number; queued?: number; cooperative?: boolean; initialize?: ReturnType<typeof deferred<void>>; failInitialization?: boolean; shutdownTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "secretary-accept-service-"));
  const db = new DatabaseSync(join(root, "agents.sqlite"));
  const repository = new AgentRepository(db);
  type RunnerOptions = Parameters<typeof createChildRunner>[0];
  const children = new Map<string, { options: RunnerOptions; messages: string[]; consumed: string[]; aborts: number; finish(output?: string, status?: "succeeded" | "cancelled"): void; boundary(): void }>();
  const starts: RunnerOptions[] = [];
  const services: AgentService[] = [];
  const runner: typeof createChildRunner = async options => {
    starts.push(options);
    const outcome = deferred<Awaited<RunningChild["result"]>>();
    const messages: string[] = [], consumed: string[] = [];
    const child = { options, messages, consumed, aborts: 0,
      finish(output = "finished", status: "succeeded" | "cancelled" = "succeeded") { outcome.resolve({ status, output }); },
      boundary() { consumed.push(...messages.splice(0)); },
    };
    children.set(options.run.runId, child);
    await (optionsForRunner.initialize?.promise ?? Promise.resolve());
    if (optionsForRunner.failInitialization) throw new Error("Controlled initialization failure");
    const sessionPath = options.agent.sessionPath ?? join(root, `${options.agent.agentId}.jsonl`);
    if (!options.agent.sessionPath) writeFileSync(sessionPath, '{"type":"session"}\n');
    options.hooks.session(sessionPath);
    return { result: outcome.promise, steer: async text => { messages.push(text); },
      abort: async () => { child.aborts++; if (optionsForRunner.cooperative !== false) child.finish("partial", "cancelled"); }, dispose: async () => {} };
  };
  const optionsForRunner = options;
  const makeService = (parentId = "parent") => {
    const service = new AgentService({ parentId, root, repository, ctx: { cwd: root, mode: options.mode ?? "tui" } as any,
      config: { modelFallbackLists: {}, ui: defaultAgentUi(), maxConcurrent: options.concurrent ?? 1, maxQueued: options.queued ?? 3, shutdownTimeoutMs: options.shutdownTimeoutMs ?? 1000, maxNestingDepth: 3 }, runner });
    services.push(service); return service;
  };
  const service = makeService();
  const spec = (launchKey: string): LaunchSpec => ({ launchKey, definition: { name: "worker", description: "Worker", prompt: "Work", source: "acceptance", hash: "fixture", resumable: true }, model: "fixture/model", tools: ["read"], ...task, background: true });
  const until = (predicate: () => boolean, owner = service) => new Promise<void>(resolve => {
    if (predicate()) return resolve();
    const off = owner.subscribe(() => { if (predicate()) { off(); resolve(); } });
  });
  const running = async (id: string) => { await until(() => service.run(id).status === "running"); return children.get(id)!; };
  const terminal = async (id: string) => { await until(() => TERMINAL_STATUSES.has(service.run(id).status)); return service.run(id); };
  t.after(async () => {
    optionsForRunner.initialize?.resolve();
    optionsForRunner.cooperative = true;
    optionsForRunner.failInitialization = false;
    for (const child of children.values()) child.finish("cleanup", "cancelled");
    for (const controller of services) assert.equal(await controller.shutdown(), true, "All fixture runners settle before database closure");
    db.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, repository, service, makeService, spec, children, starts, running, terminal, until, runnerOptions: optionsForRunner };
}

export async function publicHarness(t: TestContext, options: { mode?: string; collision?: string; automatic?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "secretary-accept-public-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(join(root, "agent"));
  writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  writeFileSync(join(root, "agent", "auth.json"), "INVALID: test must not load user credentials");
  const engine = new GoalEngine({ dbPath: join(root, "state.sqlite"), enabled: true });
  const repository = new AgentRepository(engine.db.connection);
  const model: Model<"openai-completions"> = { id: "fixture", name: "Fixture", provider: "acceptance-runtime", api: "openai-completions", baseUrl: "http://127.0.0.1:1/never", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  const calls: Context[] = [], streams: Array<{ finish(text?: string): void; partial(text: string): void }> = [];
  const arrivals = new Map<number, ReturnType<typeof deferred<void>>>();
  const call = async (index = 0) => { if (!streams[index]) { const event = arrivals.get(index) ?? deferred<void>(); arrivals.set(index, event); await event.promise; } return streams[index]!; };
  registry.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fake", models: [model], streamSimple(m, context, request) {
    calls.push({ ...context, messages: structuredClone(context.messages), tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) });
    const stream = createAssistantMessageEventStream();
    const base = (text: string): AssistantMessage => ({ role: "assistant", api: m.api, provider: m.provider, model: m.id, content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(), usage: { input: 100, cacheRead: 0, output: 20, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    let ended = false;
    const finish = (text = "Verified fixture child output.") => { if (ended) return; ended = true; request?.signal?.removeEventListener("abort", abort); stream.push({ type: "done", reason: "stop", message: base(text) }); stream.end(); };
    const abort = () => { if (ended) return; ended = true; const error = { ...base("retained partial"), stopReason: "aborted" as const }; stream.push({ type: "error", reason: "aborted", error }); stream.end(); };
    request?.signal?.addEventListener("abort", abort, { once: true });
    const partial = (text: string) => { const message = base(text); stream.push({ type: "start", partial: message }); stream.push({ type: "text_start", contentIndex: 0, partial: message }); stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message }); };
    streams.push({ finish, partial }); arrivals.get(streams.length - 1)?.resolve();
    if (options.automatic) finish();
    if (request?.signal?.aborted) abort();
    return stream;
  } });
  const hooks = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>(), commands = new Map<string, any>();
  const notices: string[] = [], sent: any[] = [], entries: any[] = [], widgets: any[] = [];
  if (options.collision) tools.set(options.collision, { name: options.collision, foreign: true });
  let parentId = "parent", stopped = false;
  const ctx: any = { cwd: root, mode: options.mode ?? "tui", hasUI: options.mode !== "rpc", model, modelRegistry: registry, scopedModels: [], thinkingLevel: "off", isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => parentId, getBranch: () => entries, getEntries: () => entries },
    isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    ui: { setStatus() {}, setWidget: (...args: any[]) => widgets.push(args), notify: (text: string) => notices.push(text), confirm: () => { throw new Error("Unexpected interactive confirmation"); }, custom: () => { throw new Error("Unexpected terminal component"); } } };
  const pi: any = { on: (name: string, fn: any) => hooks.set(name, [...(hooks.get(name) ?? []), fn]), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), getAllTools: () => [...tools.values()], getActiveTools: () => ["read", ...tools.keys(), "SubagentWorkflow"], getSessionName: () => "Fixture", setSessionName() {}, appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }), sendMessage: (message: any, delivery: any) => sent.push({ message, delivery }) };
  const sync = installSecretary(pi, engine, { agentsRoot: root });
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const fn of hooks.get(name) ?? []) {
      result = await fn(event, ctx) ?? result;
      if (name === "context" && result?.messages) event = { ...event, messages: result.messages };
    }
    if (name === "session_shutdown") stopped = true;
    return result;
  };
  t.after(async () => {
    try { if (!stopped) await emit("session_shutdown", { reason: "quit" }); }
    finally { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; rmSync(root, { recursive: true, force: true }); }
  });
  let sequence = 0;
  const tool = async (name: string, args: any, signal?: AbortSignal, id = `invocation-${++sequence}`, update?: (value: any) => void) => {
    assert.ok(tools.has(name), `${name} is registered`);
    const definition = tools.get(name);
    if (!Value.Check(definition.parameters, args)) throw new Error(`Invalid ${name} input`);
    if (name === "Agent" && !stopped) {
      await emit("context", { messages: [] });
      await emit("message_end", { message: { role: "assistant", stopReason: "toolUse",
        content: [{ type: "toolCall", id, name, arguments: args }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } });
    }
    try { return await definition.execute(id, args, signal, update, ctx); }
    finally { await emit("tool_execution_end", { toolCallId: id, toolName: name }); }
  };
  return { root, engine, repository, sync, ctx, pi, tools, commands, calls, streams, call, notices, sent, entries, widgets, emit, tool,
    setParent(id: string) { parentId = id; },
    read: (path: string) => createReadTool(root).execute("acceptance-read", { path }, undefined),
    start: () => emit("session_start", { reason: "startup" }),
    outcome: (id: string) => tool("TaskOutput", { task_id: id, block: true, timeout: 10000 }),
  };
}
