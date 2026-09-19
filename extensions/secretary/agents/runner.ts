import { access } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { availabilityResetAt, isAvailabilityError } from "./availability.ts";
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

type ChildResult = { status: "succeeded" | "partial" | "failed" | "cancelled"; output: string; error?: string };

interface Attempt {
  readonly session: AgentSession;
  settled: boolean;
  partial?: string;
  output: string;
  last?: AssistantMessage;
  turns: number;
  pendingUsage: Promise<void>[];
  promptSettled?: Promise<void>;
  unsubscribe(): void;
  authorize(): void;
  dispose(): Promise<void>;
}

export async function createChildRunner(options: {
  agent: AgentRecord; run: AgentRun; ctx: ExtensionContext; signal: AbortSignal;
  hooks: RunnerHooks; sessionDir: string;
}): Promise<RunningChild> {
  return runInChildSession(async () => {
    const { agent, run, ctx, signal, hooks, sessionDir } = options;
    signal.throwIfAborted();
    hooks.authorize();
    await access(agent.cwd);
    if (agent.sessionPath) await access(agent.sessionPath);

    let cancelled = false;
    let finished = false;
    let current: Attempt | undefined;
    let resultPromise: RunningChild["result"] | undefined;
    let outerCleanup: Promise<void> | undefined;

    const allowed = () => agent.tools.filter((name) => !forbidden.has(name)
      && (!hooks.allowedTools || hooks.allowedTools().includes(name))
      && (!agent.definition.tools || agent.definition.tools.includes(name))
      && !agent.definition.disallowedTools?.includes(name));

    const onAbort = () => {
      if (finished) return;
      cancelled = true;
      void current?.session.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // Settings and resources are model-independent and load once. Fallback discards only
    // per-candidate provider and session state (architecture §5.3).
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

    async function attemptSetup(candidateId: string): Promise<Attempt> {
      const separator = candidateId.indexOf("/");
      const model = separator > 0 ? ctx.modelRegistry.find(candidateId.slice(0, separator), candidateId.slice(separator + 1)) : undefined;
      if (!model) throw new Error(`Child model unavailable: ${candidateId}`);
      if (ctx.scopedModels.length && !ctx.scopedModels.some((item) =>
        item.model.provider === model.provider && item.model.id === model.id)) {
        throw new Error(`Child model outside parent scope: ${candidateId}`);
      }
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) throw new Error(`Child provider unavailable: ${model.provider}`);
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
        modelsStorePath: join(sessionDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false, signal });
      let session: AgentSession | undefined;
      let enforceProviderIdentity = false;
      let cleanup: Promise<void> | undefined;
      const attempt: Attempt = {
        get session() { return session!; },
        settled: false, output: "", turns: 0, pendingUsage: [], unsubscribe: () => {},
        authorize() {
          if (cancelled || signal.aborted) throw new Error("Child cancelled");
          if (attempt.partial) throw new Error(attempt.partial);
          try {
            if (enforceProviderIdentity && runtime.getRegisteredNativeProvider(parentAuthAdapter.id) !== parentAuthAdapter) {
              throw new Error(`Child parent-authentication adapter was replaced: ${parentAuthAdapter.id}`);
            }
            hooks.authorize();
          } catch (error) { attempt.partial = String(error); throw error; }
        },
        dispose: () => cleanup ??= (async () => {
          if (!session) return;
          if (!attempt.settled) { cancelled = true; await session.abort(); await attempt.promptSettled; }
          attempt.unsubscribe();
          // Five seconds bounds extension shutdown handlers only. Never time out an active tool
          // and pretend it has stopped: abort above waits for actual session settlement.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Child extension shutdown exceeded 5000ms")), 5000); }),
            ]);
          } finally { if (timer) clearTimeout(timer); session.dispose(); }
        })(),
      };
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
        stream: (m, context, request) => { attempt.authorize(); return provider.stream(m, context, request); },
        streamSimple: (m, context, request) => { attempt.authorize(); return provider.streamSimple(m, context, request); },
        ...(provider.fetchDeferred ? { fetchDeferred: provider.fetchDeferred.bind(provider) } : {}),
        ...(provider.cancelDeferred ? { cancelDeferred: provider.cancelDeferred.bind(provider) } : {}),
      };
      runtime.registerNativeProvider(parentAuthAdapter);
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
      // The parent owns the terminal. Keep the SDK's complete headless UI context:
      // supplying any custom context would advertise hasUI=true, even in print mode.
      // Child progress is forwarded by the session subscription, not by UI methods.
      await session.bindExtensions({ mode: "print",
        onError: (error) => { attempt.partial = `Child extension error: ${error.error}`; },
      });
      // Startup hooks may register providers too. Never silently accept a replacement.
      attempt.authorize();
      const availableTools = new Set(session.getAllTools().map((tool) => tool.name));
      const missingTools = allowed().filter((name) => !availableTools.has(name));
      if (missingTools.length) throw new Error(`Approved child tools cannot be loaded: ${missingTools.join(", ")}`);
      // Compose rather than replace SDK permission/extension hooks. This outer guard also
      // covers tools registered or activated after startup.
      const previousStream = session.agent.streamFunction;
      session.agent.streamFunction = (requestModel, context, request) => {
        attempt.authorize();
        return previousStream(requestModel, { ...context,
          tools: context.tools?.filter((tool) => allowed().includes(tool.name)),
        }, request);
      };
      const previousTool = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (event, toolSignal) => {
        try { attempt.authorize(); }
        catch (error) { return { block: true, terminate: true, reason: String(error) }; }
        if (!allowed().includes(event.toolCall.name)) {
          attempt.partial = `Child tool is not authorized: ${event.toolCall.name}`;
          return { block: true, terminate: true, reason: attempt.partial };
        }
        const decision = await previousTool?.(event, toolSignal);
        try { attempt.authorize(); }
        catch (error) { return { block: true, terminate: true, reason: String(error) }; }
        if (!allowed().includes(event.toolCall.name)) {
          attempt.partial = `Child tool permission changed: ${event.toolCall.name}`;
          return { block: true, terminate: true, reason: attempt.partial };
        }
        return decision;
      };
      const previousStop = session.agent.shouldStopAfterTurn;
      session.agent.shouldStopAfterTurn = async (event, turnSignal) => {
        if (agent.definition.maxTurns !== undefined && attempt.turns >= agent.definition.maxTurns) {
          attempt.partial = `Child reached maxTurns (${agent.definition.maxTurns})`;
          return true;
        }
        return attempt.partial !== undefined || cancelled || (await previousStop?.(event, turnSignal) ?? false);
      };
      attempt.unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_start") { attempt.turns++; hooks.turn(); }
        if (event.type === "tool_execution_start") hooks.activity(event.toolName);
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          hooks.text(event.assistantMessageEvent.delta);
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          attempt.last = event.message;
          attempt.output = attempt.last.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
          const message = event.message;
          // SDK listeners run before appendMessage. Wait for that synchronous persistence
          // step, then identify the actual source entry rather than the previous leaf.
          const accounted = Promise.resolve().then(() => {
            const entry = manager.getEntries().find(item => item.type === "message" && item.message === message);
            if (!entry) throw new Error("Persisted assistant usage source is unavailable");
            hooks.usage(`${run.runId}:message:${entry.id}`, usageRecord(message.usage));
          }).catch(error => { attempt.partial = `Child usage accounting failed: ${String(error)}`; });
          attempt.pendingUsage.push(accounted);
        }
        if (event.type === "compaction_end" && event.result?.usage) {
          const usage = event.result.usage;
          const entry = manager.getEntries().reverse().find(item => item.type === "compaction" && item.usage === usage);
          if (!entry) attempt.partial = "Persisted compaction usage source is unavailable";
          else hooks.usage(`${run.runId}:compaction:${entry.id}`, usageRecord(usage));
        }
      });
      attempt.authorize();
      return attempt;
    }

    async function runPrompt(attempt: Attempt): Promise<{ result: ChildResult } | { advance: { reason: string; resetAt?: number } }> {
      try {
        attempt.authorize();
        // Prefix keeps task text out of the SDK slash-command dispatch path.
        const prompt = attempt.session.prompt(`Current child task (plain user text):\n\n${run.prompt}`, { expandPromptTemplates: false });
        attempt.promptSettled = prompt.then(() => {}, () => {});
        await prompt;
        await Promise.all(attempt.pendingUsage);
        const { last, output } = attempt;
        if (cancelled || signal.aborted || last?.stopReason === "aborted") return { result: { status: "cancelled", output } };
        if (attempt.partial || last?.stopReason === "length") return { result: { status: "partial", output, error: attempt.partial ?? "Model output limit reached" } };
        if (!last || last.stopReason === "error") {
          const error = last?.errorMessage ?? "Child produced no assistant response";
          // The chain is evaluated only before the first successful provider response:
          // no output was produced and the failure is an availability failure (§5.3).
          if (!output && isAvailabilityError(error)) return { advance: { reason: error, resetAt: availabilityResetAt(error) } };
          return { result: { status: "failed", output, error } };
        }
        return { result: { status: "succeeded", output } };
      } catch (error) {
        const message = String(error);
        if (cancelled || signal.aborted) return { result: { status: "cancelled", output: attempt.output } };
        if (attempt.partial) return { result: { status: "partial", output: attempt.output, error: message } };
        if (!attempt.output && isAvailabilityError(message)) return { advance: { reason: message, resetAt: availabilityResetAt(message) } };
        return { result: { status: "failed", output: attempt.output, error: message } };
      } finally {
        attempt.settled = true;
      }
    }

    // Resumption retains the recorded model; the candidate chain applies to fresh launches.
    const chain = agent.sessionPath ? [agent.model] : [agent.model, ...(agent.modelCandidates ?? [])];
    const failures: { id: string; reason: string }[] = [];
    let attemptIndex = 0;
    while (attemptIndex < chain.length) {
      try {
        current = await attemptSetup(chain[attemptIndex]!);
        break;
      } catch (error) {
        const message = String(error);
        if (cancelled || signal.aborted || !isAvailabilityError(message)) throw error;
        failures.push({ id: chain[attemptIndex]!, reason: message });
        hooks.availability?.(chain[attemptIndex]!, availabilityResetAt(message));
        attemptIndex++;
      }
    }
    if (!current) throw new Error(`All model candidates failed: ${failures.map(f => `${f.id} (${f.reason})`).join("; ")}`);

    const dispose = () => outerCleanup ??= (async () => {
      signal.removeEventListener("abort", onAbort);
      if (!finished) { cancelled = true; await current?.session.abort(); }
      await resultPromise?.catch(() => {});
      await current?.dispose();
    })();

    // Scheduling separates construction from execution: the service can store the handle,
    // attach cancellation and deliver queued guidance before the prompt's full result settles.
    const result: RunningChild["result"] = resultPromise = new Promise((resolve) => setImmediate(resolve)).then(async (): Promise<ChildResult> => {
      try {
        while (true) {
          const attempt = current!;
          const outcome = await runPrompt(attempt);
          if ("result" in outcome) {
            if (failures.length) hooks.model?.(chain[attemptIndex]!);
            return outcome.result;
          }
          failures.push({ id: chain[attemptIndex]!, reason: outcome.advance.reason });
          hooks.availability?.(chain[attemptIndex]!, outcome.advance.resetAt);
          await attempt.dispose();
          attemptIndex++;
          if (attemptIndex >= chain.length) {
            return { status: "failed", output: "",
              error: `All model candidates failed: ${failures.map(f => `${f.id} (${f.reason})`).join("; ")}` };
          }
          if (cancelled || signal.aborted) return { status: "cancelled", output: "" };
          current = await attemptSetup(chain[attemptIndex]!);
        }
      } catch (error) {
        return { status: cancelled || signal.aborted ? "cancelled" : "failed", output: "", error: String(error) };
      } finally { finished = true; signal.removeEventListener("abort", onAbort); }
    });
    return { result,
      steer: async (text) => {
        if (finished || cancelled || signal.aborted || !current) throw new Error("Child run is no longer accepting guidance");
        current.authorize();
        current.session.agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      },
      abort: async () => { if (!finished) { cancelled = true; await current?.session.abort(); await result; } },
      dispose,
    };
  });
}
