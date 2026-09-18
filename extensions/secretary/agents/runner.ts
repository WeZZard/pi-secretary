import { access } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentRecord, AgentRun, RunnerHooks, RunningChild } from "./records.ts";
import { runInChildSession } from "./child-context.ts";

const forbidden = new Set([
  "Agent", "SendMessage", "TaskStop", "TaskOutput", "SubagentWorkflow",
  "get_subagent_result", "steer_subagent", "get_goal", "create_goal", "update_goal", "clear_goal",
]);

function usageRecord(usage: Usage) {
  // Intentionally identical to the parent normalization (including cache semantics).
  // goalTokenDeltaForUsage owns the unchanged goal-budget formula.
  return { inputTokens: usage.input, cachedInputTokens: usage.cacheRead,
    cacheWriteInputTokens: usage.cacheWrite, outputTokens: usage.output,
    reasoningOutputTokens: 0, totalTokens: usage.totalTokens };
}

export async function createChildRunner(options: {
  agent: AgentRecord; run: AgentRun; ctx: ExtensionContext; signal: AbortSignal;
  hooks: RunnerHooks; sessionDir: string;
}): Promise<RunningChild> {
  return runInChildSession(async () => {
    const { agent, run, ctx, signal, hooks, sessionDir } = options;
    signal.throwIfAborted();
    hooks.authorize();
    const separator = agent.model.indexOf("/");
    const model = ctx.modelRegistry.find(agent.model.slice(0, separator), agent.model.slice(separator + 1));
    if (separator < 1 || !model) throw new Error(`Child model unavailable: ${agent.model}`);
    if (ctx.scopedModels.length && !ctx.scopedModels.some((item) =>
      item.model.provider === model.provider && item.model.id === model.id)) {
      throw new Error(`Child model outside parent scope: ${agent.model}`);
    }
    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error(`Child provider unavailable: ${model.provider}`);
    await access(agent.cwd);
    if (agent.sessionPath) await access(agent.sessionPath);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(sessionDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false, signal });
    // Delegate authentication through the public registry, not its private runtime or copied credentials.
    // Bind provider methods: native implementations need not store methods as enumerable own properties.
    const parentAuthAdapter: Parameters<ModelRuntime["registerNativeProvider"]>[0] = {
      id: provider.id, name: provider.name, baseUrl: provider.baseUrl, headers: provider.headers,
      getModels: () => provider.getModels(),
      auth: { apiKey: { name: "Parent session authentication", resolve: async () => {
        signal.throwIfAborted();
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new Error(auth.error);
        return { auth: { apiKey: auth.apiKey, headers: auth.headers, baseUrl: auth.baseUrl }, env: auth.env, source: "Parent session" };
      } } },
      stream: (m, context, request) => { authorize(); return provider.stream(m, context, request); },
      streamSimple: (m, context, request) => { authorize(); return provider.streamSimple(m, context, request); },
      ...(provider.fetchDeferred ? { fetchDeferred: provider.fetchDeferred.bind(provider) } : {}),
      ...(provider.cancelDeferred ? { cancelDeferred: provider.cancelDeferred.bind(provider) } : {}),
    };
    runtime.registerNativeProvider(parentAuthAdapter);
    let enforceProviderIdentity = false;
    let session: AgentSession | undefined;
    let settled = false;
    let cancelled = false;
    let partial: string | undefined;
    let output = "";
    let last: AssistantMessage | undefined;
    let turns = 0;
    const pendingUsage: Promise<void>[] = [];
    let cleanup: Promise<void> | undefined;
    let resultPromise: RunningChild["result"] | undefined;
    let unsubscribe = () => {};
    const allowed = () => agent.tools.filter((name) => !forbidden.has(name)
      && (!hooks.allowedTools || hooks.allowedTools().includes(name))
      && (!agent.definition.tools || agent.definition.tools.includes(name))
      && !agent.definition.disallowedTools?.includes(name));
    function authorize() {
      if (cancelled || signal.aborted) throw new Error("Child cancelled");
      if (partial) throw new Error(partial);
      try {
        if (enforceProviderIdentity && runtime.getRegisteredNativeProvider(parentAuthAdapter.id) !== parentAuthAdapter) {
          throw new Error(`Child parent-authentication adapter was replaced: ${parentAuthAdapter.id}`);
        }
        hooks.authorize();
      } catch (error) { partial = String(error); throw error; }
    }
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      void session?.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const dispose = () => cleanup ??= (async () => {
      signal.removeEventListener("abort", onAbort);
      if (!session) return;
      if (!settled) { cancelled = true; await session.abort(); await resultPromise; }
      unsubscribe();
      // Five seconds bounds extension shutdown handlers only. Never time out an active tool
      // and pretend it has stopped: abort above waits for actual session settlement.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Child extension shutdown exceeded 5000ms")), 5000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); session.dispose(); }
    })();
    try {
      const agentDir = getAgentDir();
      const settings = SettingsManager.create(agent.configCwd, agentDir);
      settings.setProjectTrusted(ctx.isProjectTrusted());
      const loader = new DefaultResourceLoader({ cwd: agent.configCwd, agentDir, settingsManager: settings,
        appendSystemPrompt: [...(agent.definition.prompt.trim() ? [agent.definition.prompt] : []),
          "You are a child agent. Only the current explicit task authorizes work. Historical queued guidance is not a new instruction."],
      });
      await loader.reload();
      signal.throwIfAborted();
      if (loader.getExtensions().errors.length) {
        throw new Error(`Child extension loading failed: ${JSON.stringify(loader.getExtensions().errors)}`);
      }
      const manager = agent.sessionPath ? SessionManager.open(agent.sessionPath, sessionDir)
        : SessionManager.create(agent.cwd, sessionDir);
      ({ session } = await createAgentSession({ cwd: agent.cwd, agentDir, modelRuntime: runtime, model,
        thinkingLevel: agent.thinkingLevel as AgentSession["thinkingLevel"],
        tools: allowed(), resourceLoader: loader, settingsManager: settings, sessionManager: manager,
        sessionStartEvent: { type: "session_start", reason: agent.sessionPath ? "resume" : "startup" },
      }));
      // Session construction flushes queued provider registrations from loaded extensions.
      // Restore delegation after that flush, before session_start handlers can resolve auth.
      runtime.registerNativeProvider(parentAuthAdapter);
      enforceProviderIdentity = true;
      const refreshed = await runtime.refresh({ allowNetwork: false, providers: [provider.id], signal });
      signal.throwIfAborted();
      if (refreshed.aborted) throw new Error("Child provider refresh was aborted");
      if (refreshed.errors.size) {
        throw new Error(`Child provider refresh failed: ${[...refreshed.errors].map(([id, error]) => `${id}: ${String(error)}`).join("; ")}`);
      }
      session.clearQueue();
      session.agent.clearAllQueues();
      const path = session.sessionFile;
      if (!path) throw new Error("Child session has no persistent path");
      hooks.session(path);
      // Interactivity cannot be silently auto-approved or routed to the parent's editor.
      const ui = new Proxy({} as ExtensionUIContext, { get(_target, key) {
        if (["select", "confirm", "input", "custom", "editor"].includes(String(key))) {
          return () => { throw new Error(`Interactive child UI is unavailable: ${String(key)}`); };
        }
        if (key === "notify") return (text: string) => hooks.activity(text);
        return () => {};
      } });
      await session.bindExtensions({ mode: "print", uiContext: ui,
        onError: (error) => { partial = `Child extension error: ${error.error}`; },
      });
      // Startup hooks may register providers too. Never silently accept a replacement.
      authorize();
      const availableTools = new Set(session.getAllTools().map((tool) => tool.name));
      const missingTools = allowed().filter((name) => !availableTools.has(name));
      if (missingTools.length) throw new Error(`Approved child tools cannot be loaded: ${missingTools.join(", ")}`);
      // Compose rather than replace SDK permission/extension hooks. This outer guard also
      // covers tools registered or activated after startup.
      const previousStream = session.agent.streamFunction;
      session.agent.streamFunction = (requestModel, context, request) => {
        authorize();
        return previousStream(requestModel, { ...context,
          tools: context.tools?.filter((tool) => allowed().includes(tool.name)),
        }, request);
      };
      const previousTool = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (event, toolSignal) => {
        try { authorize(); }
        catch (error) { return { block: true, terminate: true, reason: String(error) }; }
        if (!allowed().includes(event.toolCall.name)) {
          partial = `Child tool is not authorized: ${event.toolCall.name}`;
          return { block: true, terminate: true, reason: partial };
        }
        const decision = await previousTool?.(event, toolSignal);
        try { authorize(); }
        catch (error) { return { block: true, terminate: true, reason: String(error) }; }
        if (!allowed().includes(event.toolCall.name)) {
          partial = `Child tool permission changed: ${event.toolCall.name}`;
          return { block: true, terminate: true, reason: partial };
        }
        return decision;
      };
      const previousStop = session.agent.shouldStopAfterTurn;
      session.agent.shouldStopAfterTurn = async (event, turnSignal) => {
        if (agent.definition.maxTurns !== undefined && turns >= agent.definition.maxTurns) {
          partial = `Child reached maxTurns (${agent.definition.maxTurns})`;
          return true;
        }
        return partial !== undefined || cancelled || (await previousStop?.(event, turnSignal) ?? false);
      };
      unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_start") { turns++; hooks.turn(); }
        if (event.type === "tool_execution_start") hooks.activity(event.toolName);
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          hooks.text(event.assistantMessageEvent.delta);
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          last = event.message;
          output = last.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
          const message = event.message;
          // SDK listeners run before appendMessage. Wait for that synchronous persistence
          // step, then identify the actual source entry rather than the previous leaf.
          const accounted = Promise.resolve().then(() => {
            const entry = manager.getEntries().find(item => item.type === "message" && item.message === message);
            if (!entry) throw new Error("Persisted assistant usage source is unavailable");
            hooks.usage(`${run.runId}:message:${entry.id}`, usageRecord(message.usage));
          }).catch(error => { partial = `Child usage accounting failed: ${String(error)}`; });
          pendingUsage.push(accounted);
        }
        if (event.type === "compaction_end" && event.result?.usage) {
          const usage = event.result.usage;
          const entry = manager.getEntries().reverse().find(item => item.type === "compaction" && item.usage === usage);
          if (!entry) partial = "Persisted compaction usage source is unavailable";
          else hooks.usage(`${run.runId}:compaction:${entry.id}`, usageRecord(usage));
        }
      });
      authorize();
      // Scheduling separates construction from execution: the service can store the handle,
      // attach cancellation and deliver queued guidance before the prompt's full result settles.
      const result: RunningChild["result"] = resultPromise = new Promise((resolve) => setImmediate(resolve)).then(async () => {
        try {
          authorize();
          // Prefix keeps task text out of the SDK slash-command dispatch path.
          await session!.prompt(`Current child task (plain user text):\n\n${run.prompt}`, { expandPromptTemplates: false });
          await Promise.all(pendingUsage);
          if (cancelled || signal.aborted || last?.stopReason === "aborted") return { status: "cancelled", output };
          if (partial || last?.stopReason === "length") return { status: "partial", output, error: partial ?? "Model output limit reached" };
          if (!last || last.stopReason === "error") return { status: "failed", output, error: last?.errorMessage ?? "Child produced no assistant response" };
          return { status: "succeeded", output };
        } catch (error) {
          return { status: cancelled || signal.aborted ? "cancelled" : partial ? "partial" : "failed", output, error: String(error) };
        } finally { settled = true; signal.removeEventListener("abort", onAbort); }
      });
      return { result,
        steer: async (text) => {
          if (settled || cancelled || signal.aborted) throw new Error("Child run is no longer accepting guidance");
          authorize();
          session!.agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
        },
        abort: async () => { if (!settled) { cancelled = true; await session!.abort(); await result; } },
        dispose,
      };
    } catch (error) { await dispose(); throw error; }
  });
}
