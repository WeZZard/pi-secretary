import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore,
  type AssistantMessage, type Context, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";
import { installSecretary } from "../../extensions/secretary/index.ts";

export type Response = "success" | "error" | "overflow" | "create_goal" | "complete_goal" | "sentinel";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
export interface ProviderCall {
  context: Context;
  options?: SimpleStreamOptions;
  abortedAtInvocation: boolean;
}

export async function hostSession(t: TestContext, options: {
  responses?: Response[];
  extension?: (pi: ExtensionAPI) => void;
  beforeResponse?: (call: ProviderCall, index: number) => Promise<void>;
  startupGoal?: string;
  tuiAbortHandler?: boolean;
  compaction?: boolean;
  startReason?: "startup" | "reload" | "new" | "resume" | "fork";
  startupPaused?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "secretary-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = new GoalEngine({ dbPath: ":memory:", enabled: true });
  const manager = SessionManager.inMemory(root);
  const threadId = manager.getSessionId();
  const sourceThread = options.startReason === "fork" ? "fork-source" : threadId;
  if (options.startupGoal) {
    engine.service.createGoal(sourceThread, options.startupGoal, undefined, "user");
    if (options.startupPaused) engine.service.requestTerminalUpdate(sourceThread, "paused", "user");
  }
  const calls: ProviderCall[] = [];
  const responses = [...(options.responses ?? [])];
  const lifecycle: Array<{ event: string; status: string | undefined }> = [];
  const errors: unknown[] = [];
  const notices: Array<{ message: string; type: string | undefined }> = [];
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, string[] | undefined>();
  const uiMethods: Partial<ExtensionUIContext> = {
    notify(message, type) { notices.push({ message, type }); },
    setStatus(key, value) { statuses.set(key, value); },
    setWidget(key: string, value: unknown) {
      assert.ok(value === undefined || Array.isArray(value));
      widgets.set(key, value as string[] | undefined);
    },
    confirm: async () => true,
  };
  // Only the presentation port is stubbed. Missing methods fail loudly rather than hiding host errors.
  const ui = new Proxy(uiMethods, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      return () => { throw new Error(`Unexpected UI call: ${String(key)}`); };
    },
  }) as ExtensionUIContext;
  const settings = SettingsManager.inMemory({
    compaction: { enabled: options.compaction ?? false, keepRecentTokens: 256, reserveTokens: 1024 },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  });
  const model: Model<"openai-completions"> = {
    id: "deterministic", name: "Deterministic local test", provider: "secretary-host-test",
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/never-requested",
    reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  let api!: ExtensionAPI;
  let synchronization!: ReturnType<typeof installSecretary>;
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "Deterministic local host test. Never access external resources.",
    extensionFactories: [(pi) => {
      api = pi;
      pi.registerProvider(model.provider, {
        api: model.api, baseUrl: model.baseUrl, apiKey: "test", models: [model],
        streamSimple(requestModel, context, requestOptions) {
          calls.push({ context: { ...context, messages: structuredClone(context.messages),
            tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) }, options: requestOptions,
            abortedAtInvocation: requestOptions?.signal?.aborted ?? false });
          const current = context.messages.filter((m) => JSON.stringify(m).includes("Authoritative current goal state."));
          const automatic = JSON.stringify(current).includes("Continue working toward the active thread goal.");
          const response = responses.shift() ?? (automatic ? "complete_goal" : "success");
          const toolName = response === "create_goal" ? "create_goal" : response === "complete_goal" ? "update_goal" : response === "sentinel" ? "sentinel" : undefined;
          const aborted = requestOptions?.signal?.aborted ?? false;
          const message: AssistantMessage = {
            role: "assistant", api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
            content: toolName ? [{ type: "toolCall", id: `tool-${calls.length}`, name: toolName,
              arguments: response === "create_goal" ? { objective: "Tool-created objective" } : response === "complete_goal" ? { status: "complete" } : {} }] : [{ type: "text", text: "Local response." }],
            stopReason: aborted ? "aborted" : response === "error" || response === "overflow" ? "error" : toolName ? "toolUse" : "stop",
            usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            timestamp: Date.now(),
            ...(response === "error" ? { errorMessage: "503 service unavailable" }
              : response === "overflow" ? { errorMessage: "This model's maximum context length is 1000 tokens" } : {}),
          };
          const stream = createAssistantMessageEventStream();
          const emit = () => {
            if (message.stopReason === "error" || message.stopReason === "aborted") {
              stream.push({ type: "error", reason: message.stopReason, error: message });
            } else {
              stream.push({ type: "done", reason: toolName ? "toolUse" : "stop", message });
            }
            stream.end();
          };
          if (options.beforeResponse) {
            void options.beforeResponse(calls.at(-1)!, calls.length - 1).then(emit, (error: unknown) => {
              stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } });
              stream.end();
            });
          } else emit();
          return stream;
        },
      });
      synchronization = installSecretary(pi, engine);
      const record = (event: string) => { lifecycle.push({ event, status: engine.service.getGoal(threadId)?.status }); };
      pi.on("session_start", () => { record("session_start"); });
      pi.on("turn_start", () => { record("turn_start"); });
      pi.on("turn_end", () => { record("turn_end"); });
      pi.on("agent_settled", () => { record("agent_settled"); });
      pi.on("session_shutdown", () => { lifecycle.push({ event: "session_shutdown", status: undefined }); });
      options.extension?.(pi);
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root, agentDir: join(root, "agent"), sessionManager: manager, settingsManager: settings,
    resourceLoader: loader, modelRuntime: runtime, model, thinkingLevel: "off", noTools: "builtin",
    sessionStartEvent: { type: "session_start", reason: options.startReason ?? "startup",
      ...(options.startReason === "fork" ? { previousSessionFile: sourceThread } : {}) },
  });
  t.after(async () => {
    synchronization.dispose(); // Cancel pending setImmediate dispatch before abort can settle the session.
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    assert.deepEqual(errors, [], "extension hooks must not silently fail");
  });
  const restoredUserMessages: string[] = [];
  await session.bindExtensions({
    uiContext: ui, mode: options.tuiAbortHandler ? "tui" : "rpc",
    onError: (error) => { errors.push(error); },
    // Mirrors InteractiveMode.restoreQueuedMessagesToEditor({ abort: true }) for
    // an empty editor and no compaction queue. No terminal or InteractiveMode is started.
    ...(options.tuiAbortHandler ? { abortHandler: () => {
      const { steering, followUp } = session.clearQueue();
      restoredUserMessages.push(...steering, ...followUp);
      session.agent.abort();
    } } : {}),
  });
  return { session, engine, threadId, api, calls, responses, lifecycle, notices, statuses, widgets, restoredUserMessages };
}

// Goal synchronization deliberately schedules one setImmediate, not a wall-clock timeout.
export async function flushAutomaticScheduling(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
