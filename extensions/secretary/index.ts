import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { GoalEngine } from "./goal-engine.ts";
import { registerGoalUI, STATUS_COLORS, abbreviateTokens, elapsedText } from "./goal-ui.ts";
import { executeCreateGoal, executeGetGoal, executeUpdateGoal, type GoalToolResponse } from "./goal/tools/goal-tool-executors.ts";
import { createGoalToolSpec, getGoalToolSpec, updateGoalToolSpec } from "./goal/tools/goal-tool-specs.ts";
import type { ThreadGoal } from "./goal/goal-record.ts";
import { GoalSynchronization, threadIdFor, type WorkBasis } from "./goal/synchronization.ts";
import { formatGoalSnapshot } from "./goal/steering.ts";
import { inChildSession } from "./agents/child-context.ts";
import { installAgentSupport } from "./agents/installation.ts";

export default function secretaryExtension(pi: ExtensionAPI): void {
  if (inChildSession()) return;
  const dir = process.env.PI_SECRETARY_DB_DIR ?? path.join(process.env.HOME ?? "", ".pi", "secretary");
  mkdirSync(dir, { recursive: true });
  installSecretary(pi, new GoalEngine({ dbPath: path.join(dir, "pi-secretary-goals.sqlite"), enabled: true }), { agentsRoot: dir });
}

/** Injectable storage permits tests to exercise the actual installer without touching user goals. */
export function installSecretary(pi: ExtensionAPI, engine: GoalEngine, options: { agentsRoot?: string } = {}): GoalSynchronization {
  const ui = registerGoalUI(pi, engine);
  const sync = new GoalSynchronization(pi, engine, ui);
  registerGoalTools(pi, engine, sync);
  wireRuntime(pi, engine, sync);
  pi.on("session_start", (event, ctx) => {
    const threadId = threadIdFor(ctx);
    sync.bind(ctx);
    if (event.reason === "fork" && event.previousSessionFile) engine.copyGoalToThread(event.previousSessionFile, threadId);
    engine.runtimeFor(threadId).restoreAfterResume();
    sync.refresh();
    sync.requestAutomatic();
  });
  pi.on("context", (event, ctx) => ({ messages: sync.context(event, ctx) }));
  pi.on("input", (event, ctx) => { sync.receiveInput(event.text, ctx); });
  pi.on("before_agent_start", (event) => { sync.expandedInput(event.prompt); });
  pi.on("message_start", (event) => { sync.observeUserMessage(event.message); });
  pi.on("tool_call", (event) => {
    const work = sync.work();
    if (event.toolName !== "get_goal" && work && (work.automatic || work.unresolvedAutomatic) && !sync.isCurrent(work)) {
      return { block: true, reason: "This automatic work was superseded. Use current goal state; do not execute actions from its old intent.", terminate: true };
    }
    if (work?.automatic?.kind === "budget_wrap_up" && !["get_goal", "update_goal", "read", "grep", "find", "ls"].includes(event.toolName)) {
      return { block: true, reason: "Budget wrap-up authorizes reporting and read-only evidence, not new substantive goal work.", terminate: true };
    }
  });
  const agents = options.agentsRoot ? installAgentSupport(pi, engine, sync, options.agentsRoot) : undefined;
  pi.on("session_shutdown", async () => {
    sync.dispose();
    if (agents && !await agents.shutdown()) return; // Do not close storage under a live child.
    engine.dispose();
    engine.close();
  });
  return sync;
}

export function registerGoalTools(pi: ExtensionAPI, engine: GoalEngine, sync: GoalSynchronization): void {
  const threadOf = (ctx: ExtensionContext): string => {
    const threadId = threadIdFor(ctx);
    engine.setThreadId(threadId);
    return threadId;
  };
  const result = (response: GoalToolResponse): AgentToolResult<GoalToolResponse> => ({
    content: [{ type: "text", text: formatGoalSnapshot(response.goal,
      response.goal ? engine.service.getLastChange(response.goal.threadId)?.stopCause : undefined) }],
    details: response,
  });

  // A thrown executor error reaches renderResult without details; success always sets them.
  const errorText = (theme: Theme, result: AgentToolResult<GoalToolResponse | undefined>): Text | undefined => {
    if (result.details !== undefined) return undefined;
    const text = result.content[0];
    return new Text(theme.fg("error", `Error: ${text?.type === "text" ? text.text : ""}`), 0, 0);
  };
  const UPDATE_ACTIONS: Record<string, string> = { complete: "Completed", blocked: "Blocked", paused: "Paused" };
  const updateSummary = (goal: ThreadGoal, nowMs: number): string => {
    const parts = [`Consumed ${abbreviateTokens(goal.tokensUsed)} tokens`, `Used ${elapsedText(goal, nowMs)}`];
    if (goal.tokenBudget !== undefined) parts.push(`Budget ${abbreviateTokens(goal.tokenBudget)} tokens`);
    return parts.join("; ");
  };

  pi.registerTool(defineTool<typeof getGoalToolSpec.parameters, GoalToolResponse>({
    ...getGoalToolSpec,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return result(executeGetGoal(engine.service, threadOf(ctx)));
    },
  }));
  pi.registerTool(defineTool<typeof createGoalToolSpec.parameters, GoalToolResponse>({
    ...createGoalToolSpec,
    renderCall(args, theme) {
      const budget = args.token_budget !== undefined ? `, ${abbreviateTokens(args.token_budget)} tokens` : "";
      return new Text(theme.fg("toolTitle", theme.bold("Create Goal: ")) + theme.fg("text", args.objective + budget), 0, 0);
    },
    renderResult(rendered, options, theme) {
      const failure = errorText(theme, rendered);
      if (failure) return failure;
      const goal = rendered.details?.goal;
      if (!goal) return new Text(theme.fg("muted", "No goal was created."), 0, 0);
      const color = STATUS_COLORS[goal.status];
      let text = theme.fg(color, `Created Goal. ${updateSummary(goal, Date.now())}`);
      if (options.expanded) text += `\n\nObjective: ${goal.objective}`;
      return new Text(text, 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const response = executeCreateGoal(engine.service, threadOf(ctx), params, engine.maxGoalTokenBudget(), sync.userDecision());
      if (response.goal && !pi.getSessionName()) pi.setSessionName(response.goal.objective.slice(0, 80));
      return result(response);
    },
  }));
  pi.registerTool(defineTool<typeof updateGoalToolSpec.parameters, GoalToolResponse>({
    ...updateGoalToolSpec,
    renderCall(args, theme) {
      const action = UPDATE_ACTIONS[args.status] ?? args.status;
      const color = STATUS_COLORS[args.status as ThreadGoal["status"]] ?? "toolTitle";
      return new Text(theme.fg(color, theme.bold(`${action} Goal`)), 0, 0);
    },
    renderResult(rendered, options, theme) {
      const failure = errorText(theme, rendered);
      if (failure) return failure;
      const goal = rendered.details?.goal;
      if (!goal) return new Text(theme.fg("muted", "No current goal."), 0, 0);
      const action = UPDATE_ACTIONS[goal.status] ?? "Updated";
      const color = STATUS_COLORS[goal.status] ?? "text";
      let text = theme.fg(color, `${action} Goal. ${updateSummary(goal, Date.now())}`);
      if (options.expanded) text += `\n\nObjective: ${goal.objective}`;
      return new Text(text, 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const threadId = threadOf(ctx);
      const receipt = params.status === "paused" ? sync.userDecision() : undefined;
      if (params.status !== "paused") sync.assertCurrent();
      engine.runtimeFor(threadId).checkpoint();
      // Recheck after checkpoint observers, which may accept a newer decision.
      if (params.status !== "paused") sync.assertCurrent();
      return result(executeUpdateGoal(engine.service, threadId, {
        status: params.status as "complete" | "blocked" | "paused",
      }, receipt, params.status === "paused" ? undefined : sync.work()?.intentSeq));
    },
  }));
}

/** A failed request is provisional until Pi has finished retry/compaction recovery. */
export function wireRuntime(pi: ExtensionAPI, engine: GoalEngine, sync: GoalSynchronization): void {
  let sequence = 0;
  const turns = new Map<string, { id: string; signal?: AbortSignal }>();
  const failures = new Map<string, WorkBasis>();

  pi.on("turn_start", (_event, ctx) => {
    const threadId = threadIdFor(ctx);
    const id = `goal-turn-${++sequence}`;
    turns.set(threadId, { id, signal: ctx.signal });
    engine.runtimeFor(threadId).startTurn(id, true, zeroUsage());
    sync.beginTurn(id, ctx);
  });

  // Baseline pre-goal tokens before tools create a goal, and make terminal tool results include known usage.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const threadId = threadIdFor(ctx);
    const turn = turns.get(threadId);
    if (!turn) return;
    const runtime = engine.runtimeFor(threadId);
    runtime.recordTokenUsage(turn.id, convertUsage(event.message.usage));
    runtime.checkpoint();
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const threadId = threadIdFor(ctx);
    const turn = turns.get(threadId);
    if (!turn) return;
    engine.runtimeFor(threadId).recordToolOutcome(turn.id,
      event.toolName === "bash" || event.toolName === "powershell" ? "exec" : event.toolName,
      event.isError ? { kind: "failed", handlerExecuted: true } : { kind: "completed", success: true });
  });

  pi.on("turn_end", (event, ctx) => {
    const threadId = threadIdFor(ctx);
    const turn = turns.get(threadId);
    if (!turn) return;
    const runtime = engine.runtimeFor(threadId);
    try {
      const message = event.message;
      if (message.role !== "assistant") return;
      runtime.recordTokenUsage(turn.id, convertUsage(message.usage));
      const cancelled = message.stopReason === "aborted" || turn.signal?.aborted || ctx.signal?.aborted;
      const work = sync.work(turn.id);
      sync.noteResult(work, message.stopReason);
      if (message.stopReason !== "error" && !cancelled && work && sync.isCurrent(work)) {
        runtime.recordItem(turn.id, { phase: "final", hasText: message.content.some((item) => item.type === "text" && item.text.trim().length > 0) });
        const executionFailure = runtime.accountingState().executionFailureGoal(turn.id);
        const emptyResponse = runtime.accountingState().emptyResponseGoal(turn.id);
        if (executionFailure || emptyResponse) {
          engine.service.stopActiveGoal(threadId, "blocked", (emptyResponse ?? executionFailure)!,
            emptyResponse ? "empty_response" : "run_error", work.intentSeq);
        }
      }
      runtime.accountActiveGoalProgress(turn.id, "turn-end", "active_or_stopped", "keep_active");
      const goal = engine.service.getGoal(threadId);
      if (cancelled) {
        // Pi may encode auth/setup cancellation as stopReason=error; use the actual run signal.
        failures.delete(threadId);
        if (work && sync.isCurrent(work)) sync.suspendAutomatic();
        runtime.releaseContinuation();
      } else if (message.stopReason === "error") {
        if (work?.goalId && goal?.goalId === work.goalId && sync.isCurrent(work)) failures.set(threadId, work);
      } else {
        failures.delete(threadId);
        // Successful recovery revokes the provisional error without changing persisted intent.
      }
    } finally {
      turns.delete(threadId);
      runtime.finishTurn(turn.id);
      sync.finishTurn(turn.id);
      sync.refresh();
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const threadId = threadIdFor(ctx);
    const failure = failures.get(threadId);
    failures.delete(threadId);
    if (failure) {
      const goal = engine.service.getGoal(threadId);
      if (goal?.status === "active" && sync.isCurrent(failure)) {
        engine.service.stopActiveGoal(threadId, "blocked", goal.goalId, "run_error", failure.intentSeq);
      }
    }
    // An abort or uncertain submission stays suspended until explicit activation.
    sync.settled();
  });
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
}
function zeroUsage() {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}
function convertUsage(usage: UsageLike) {
  return {
    inputTokens: usage.input ?? 0,
    cachedInputTokens: usage.cacheRead ?? 0,
    cacheWriteInputTokens: usage.cacheWrite ?? 0,
    outputTokens: usage.output ?? 0,
    reasoningOutputTokens: usage.reasoning ?? 0,
    totalTokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
  };
}
