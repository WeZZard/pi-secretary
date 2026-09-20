import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";
import { installSecretary } from "../../extensions/secretary/index.ts";

export async function agentHarness(t: TestContext, options: { mode?: string; collision?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "secretary-install-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(join(root, "agent"));
  await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  await writeFile(join(root, "agent", "auth.json"), "INVALID: test must not load user credentials");
  const engine = new GoalEngine({ dbPath: ":memory:", enabled: true });
  const model: Model<"openai-completions"> = { id: "fixture", name: "Fixture", provider: "installer-test", api: "openai-completions", baseUrl: "http://127.0.0.1:1/never", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  const calls: Context[] = [];
  registry.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fake", models: [model], streamSimple(m, context) {
    calls.push({ ...context, messages: structuredClone(context.messages), tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) });
    const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, content: [{ type: "text", text: "Verified fixture child output." }], stopReason: "stop", timestamp: Date.now(), usage: { input: 100, cacheRead: 40, output: 20, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
  } });
  const hooks = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notices: string[] = [], sent: any[] = [], entries: any[] = [];
  let entrySequence = 0;
  const append = (entry: any) => entries.push({ ...entry, id: `entry-${++entrySequence}`, parentId: entries.at(-1)?.id ?? null });
  if (options.collision) tools.set(options.collision, { name: options.collision, foreign: true });
  const ctx: any = { cwd: root, mode: options.mode ?? "print", hasUI: true, model, modelRegistry: registry, scopedModels: [], thinkingLevel: "off", isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "parent", getLeafId: () => entries.at(-1)?.id ?? null, getBranch: () => entries, getEntries: () => entries },
    isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    ui: { setStatus() {}, setWidget() {}, notify: (text: string) => notices.push(text) } };
  const pi: any = { on: (name: string, fn: any) => hooks.set(name, [...(hooks.get(name) ?? []), fn]), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, definition: any) => commands.set(name, definition), getAllTools: () => [...tools.values()], getActiveTools: () => ["read", ...tools.keys(), "SubagentWorkflow"], getSessionName: () => "Fixture", setSessionName() {}, appendEntry: (customType: string, data: any) => append({ type: "custom", customType, data }), sendMessage: (message: any, delivery: any) => sent.push({ message, delivery }) };
  const sync = installSecretary(pi, engine, { agentsRoot: root });
  const emit = async (name: string, event: any = {}) => {
    if (name === "message_end" && event.message.role === "assistant") {
      const calls = event.message.content.filter((block: any) => block.type === "toolCall");
      if (calls.length && !entries.some(entry => entry.type === "message" && entry.message.content.some((block: any) => block.type === "toolCall" && block.id === calls[0].id))) {
        append({ type: "message", message: event.message });
      }
    }
    let result: any;
    for (const fn of hooks.get(name) ?? []) {
      result = await fn(event, ctx) ?? result;
      if (name === "context" && result?.messages) event = { ...event, messages: result.messages };
    }
    return result;
  };
  t.after(async () => {
    try { await emit("session_shutdown"); }
    finally { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; await rm(root, { recursive: true, force: true }); }
  });
  let sequence = 0;
  return { root, engine, sync, ctx, pi, tools, commands, calls, notices, sent, emit,
    start: () => emit("session_start", { reason: "startup" }),
    command: (name: string, args: string) => { assert.ok(commands.has(name), `${name} is registered`); return commands.get(name).handler(args, ctx); },
    tool: async (name: string, args: any, id = `invocation-${++sequence}`) => {
      assert.ok(tools.has(name), `${name} is registered`);
      {
        // Adapter tests simulate host ordering; discovery.test.ts separately proves it in the real SDK.
        await emit("context", { messages: [] });
        await emit("message_end", { message: { role: "assistant", stopReason: "toolUse",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [{ type: "toolCall", id, name, arguments: args }] } });
      }
      try { return await tools.get(name).execute(id, args, undefined, undefined, ctx); }
      finally { await emit("tool_execution_end", { toolCallId: id, toolName: name }); }
    } };
}
