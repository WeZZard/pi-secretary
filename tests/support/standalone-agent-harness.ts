import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type Model, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installAgentSupport } from "../../extensions/secretary/agents/installation.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { RequestContextComposer } from "../../extensions/secretary/context/index.ts";
import type { ServiceEvent } from "../../extensions/secretary/agents/service.ts";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export async function standaloneAgentHarness(t: TestContext, options: {
  respondChild?: (context: Context, index: number, signal?: AbortSignal) => Promise<AssistantMessage["content"]>;
  observeEvents?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "secretary-standalone-"));
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const db = new DatabaseSync(":memory:");
  const repository = new AgentRepository(db);
  const errors: unknown[] = [], events: ServiceEvent[] = [];
  const persistedEvents: boolean[] = [];
  const parentCalls: Context[] = [], childCalls: Context[] = [];
  const policyCalls: string[][] = [];
  let pending: ToolCall[] | undefined;
  let sequence = 0;
  const key = `standalone-installer-${randomUUID()}`;
  const global = globalThis as unknown as Record<string, unknown>;
  const install = (pi: ExtensionAPI) => {
    const composer = new RequestContextComposer();
    const handle = installAgentSupport(pi, { repository, root: join(root, "state"), composer,
      childTools: tools => { policyCalls.push([...tools]); return tools.filter(name => name !== "host_only" && name !== "write"); },
      ...(options.observeEvents === false ? {} : { events(event: ServiceEvent) {
        events.push(structuredClone(event));
        persistedEvents.push(event.type === "usage"
          ? repository.usage(event.usage.runId).some(record => record.id === event.usage.id)
          : repository.getRun(event.run.runId)?.agentId === event.run.agentId);
      } }),
    });
    let epoch = 0, request = 0;
    pi.on("session_tree", () => { epoch++; composer.invalidate(); });
    pi.on("context", async (event, ctx) => {
      const prepared = await composer.prepare({ sessionId: ctx.sessionManager.getSessionId(), activationEpoch: epoch,
        requestId: String(++request), signal: ctx.signal ?? new AbortController().signal });
      const messages = composer.compose(event.messages, prepared);
      handle.contextPrepared(prepared);
      return { messages };
    });
    pi.on("session_shutdown", async () => { composer.dispose(); await handle.shutdown(); });
  };
  global[key] = install;
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(agentDir, "agents"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  await writeFile(join(agentDir, "auth.json"), "INVALID: the fixture must use parent runtime credentials");
  await writeFile(join(agentDir, "secretary.json"), JSON.stringify({ agents: { maxNestingDepth: 3 } }));
  await writeFile(join(agentDir, "extensions", "standalone.ts"), `export default function(pi) { globalThis[${JSON.stringify(key)}](pi); }\n`);
  await writeFile(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: Standalone read worker\ntools: [read, write, host_only]\n---\nSTANDALONE_WORKER\n");
  await writeFile(join(agentDir, "agents", "delegator.md"), "---\nname: delegator\ndescription: Standalone nested worker\ntools: [read, Agent, TaskOutput, SendMessage, TaskStop]\n---\nSTANDALONE_DELEGATOR\n");
  const model: Model<"openai-completions"> = { id: "fixture", provider: "standalone-test", name: "Standalone deterministic fixture",
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/never", reasoning: false, input: ["text"], contextWindow: 128000,
    maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  settings.setProjectTrusted(true);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  const manager = SessionManager.create(root, join(root, "sessions"));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    systemPromptOverride: () => "STANDALONE_PARENT",
    extensionFactories: [pi => {
      pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fixture", models: [model],
        streamSimple(m, context, request) {
          const child = /STANDALONE_(WORKER|DELEGATOR)/.test(context.systemPrompt ?? "");
          const calls = child ? childCalls : parentCalls;
          calls.push({ ...context, messages: structuredClone(context.messages), tools: context.tools?.map(tool => ({ ...tool })) });
          const index = calls.length - 1;
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = { role: "assistant", api: m.api, model: m.id, provider: m.provider,
            content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0,
              totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          void (async () => {
            if (child) message.content = await options.respondChild?.(context, index, request?.signal) ?? [{ type: "text", text: "STANDALONE_DONE" }];
            else { message.content = pending ?? [{ type: "text", text: "Parent observed tool results." }]; pending = undefined; }
            message.stopReason = request?.signal?.aborted ? "aborted" : message.content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
            if (message.stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
            else stream.push({ type: "done", reason: message.stopReason, message });
          })().catch(error => {
            errors.push(error); message.stopReason = "error"; message.errorMessage = String(error);
            stream.push({ type: "error", reason: "error", error: message });
          }).finally(() => stream.end());
          return stream;
        } });
      pi.registerTool({ name: "host_only", label: "Host only", description: "Must not be delegated", parameters: Type.Object({}),
        async execute() { throw new Error("Host-only fixture tool must never execute"); } });
      install(pi);
    }] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, sessionManager: manager,
    settingsManager: settings, modelRuntime: runtime, model, thinkingLevel: "off" });
  await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
  t.after(async () => {
    try {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      assert.deepEqual(errors, [], "No provider or extension errors may be swallowed");
    } finally {
      delete global[key]; db.close();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, db, repository, session, manager, events, persistedEvents, parentCalls, childCalls, policyCalls,
    async tool(name: string, args: Record<string, unknown>) {
      await session.waitForIdle();
      const id = `standalone-${++sequence}`;
      pending = [{ type: "toolCall", id, name, arguments: args }];
      await session.prompt(`Execute fixture operation ${id}.`, { source: "rpc" });
      await session.waitForIdle();
      const result = session.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
      assert.ok(result?.role === "toolResult", `Missing result for ${id}`);
      assert.equal(result.isError, false, JSON.stringify(result));
      return result;
    },
  };
}
