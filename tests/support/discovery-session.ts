import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";
import { installSecretary } from "../../extensions/secretary/index.ts";

export async function discoverySession(t: TestContext, options: {
  setup?: (root: string, agentDir: string) => Promise<void>;
  respond?: (context: Context, index: number) => Promise<AssistantMessage["content"]>;
  respondChild?: (context: Context, index: number, signal?: AbortSignal) => Promise<AssistantMessage["content"]>;
  mode?: "print" | "rpc";
  extension?: (pi: ExtensionAPI) => void;
  trusted?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "secretary-discovery-"));
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  await options.setup?.(root, agentDir);
  const engine = new GoalEngine({ dbPath: ":memory:", enabled: true });
  const manager = SessionManager.create(root, join(root, "sessions"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  settings.setProjectTrusted(options.trusted ?? true);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  const model: Model<"openai-completions"> = { id: "fixture", provider: "discovery-test", name: "Local discovery fixture",
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/never", reasoning: false, input: ["text", "image"],
    contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const parentCalls: Context[] = [], childCalls: Context[] = [], errors: unknown[] = [];
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPromptOverride: () => "Use only isolated fixtures.",
    extensionFactories: [pi => {
      pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fixture", models: [model],
        streamSimple(m, context, request) {
          const parent = context.tools?.some(tool => tool.name === "Agent") ?? false;
          const calls = parent ? parentCalls : childCalls;
          calls.push({ ...context, messages: structuredClone(context.messages),
            tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) });
          const index = calls.length - 1;
          const stream = createAssistantMessageEventStream();
          void (async () => {
            const message: AssistantMessage = { role: "assistant", api: m.api, model: m.id, provider: m.provider,
              content: parent && options.respond ? await options.respond(context, index)
                : !parent && options.respondChild ? await options.respondChild(context, index, request?.signal)
                : [{ type: "text", text: "Fixture result." }],
              stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            if (message.content.some(block => block.type === "toolCall")) message.stopReason = "toolUse";
            if (request?.signal?.aborted) {
              message.stopReason = "aborted";
              stream.push({ type: "error", reason: "aborted", error: message });
            } else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
            stream.end();
          })().catch(error => { errors.push(error); stream.end(); });
          return stream;
        } });
      installSecretary(pi, engine, { agentsRoot: join(root, "state") });
      options.extension?.(pi);
    }] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, sessionManager: manager,
    settingsManager: settings, modelRuntime: runtime, model, thinkingLevel: "off" });
  await session.bindExtensions({ mode: options.mode ?? "print", onError: error => errors.push(error) });
  t.after(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, [], "No swallowed extension or provider errors");
  });
  return { root, agentDir, session, manager, engine, parentCalls, childCalls };
}
