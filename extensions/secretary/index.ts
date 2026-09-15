import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { GoalEngine } from "./goal-engine.ts";
import { registerGoalUI } from "./goal-ui.ts";
import {
  executeCreateGoal,
  executeGetGoal,
  executeUpdateGoal,
  type GoalToolResponse,
} from "./goal/tools/goal-tool-executors.ts";
import {
  createGoalToolSpec,
  getGoalToolSpec,
  updateGoalToolSpec,
} from "./goal/tools/goal-tool-specs.ts";
import { type ThreadGoal } from "./goal/goal-record.ts";

/**
 * pi-secretary.
 *
 * Replicates OpenAI Codex's goal system semantics (get_goal/create_goal/
 * update_goal, 6 statuses, single-goal-per-thread, SQLite persistence,
 * prompt-driven completion audit) presented through the pi-goal-x-style TUI
 * widget + status line.
 *
 * The engine is created eagerly at load so its tool, command, and UI
 * registrations take effect immediately; the SQLite handle is closed on
 * session shutdown.
 */
export default function secretaryExtension(pi: ExtensionAPI): void {
  const engine = createEngine(pi);

  pi.on("session_shutdown", () => {
    engine.dispose();
    engine.close();
  });

  // Resume/start lifecycle: rehydrate active-goal accounting and continue any
  // still-active goal once the session settles. `reason` may be startup,
  // reload, new, resume, or fork.
  pi.on("session_start", (event, ctx) => {
    const threadId = threadIdFor(ctx);
    engine.setThreadId(threadId);
    engine.runtimeFor(threadId).restoreAfterResume();

    // Fork: inherit the source thread's goal snapshot (claim F).
    if (event.reason === "fork" && event.previousSessionFile) {
      const sourceId = event.previousSessionFile;
      const copied = engine.copyGoalToThread(sourceId, threadId);
      if (copied) {
        engine.runtimeFor(threadId).restoreAfterResume();
      }
    }
  });
}

function createEngine(pi: ExtensionAPI): GoalEngine {
  const dbPath = defaultDbPath();
  const eng = new GoalEngine({ dbPath, enabled: true });
  registerGoalTools(pi, eng);
  registerGoalUI(pi, eng);
  wireRuntime(pi, eng);
  return eng;
}

function defaultDbPath(): string {
  const dir =
    process.env.PI_SECRETARY_DB_DIR ??
    path.join(process.env.HOME ?? "", ".pi", "secretary");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "pi-secretary-goals.sqlite");
}

function threadIdFor(ctx: ExtensionContext): string {
  // Prefer the persisted session file; fall back to the session id so goals
  // work in ephemeral sessions that have not yet written a session file.
  return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
}

/**
 * Register the three Codex-faithful goal tools against the engine.
 */
export function registerGoalTools(pi: ExtensionAPI, engine: GoalEngine): void {
  const threadOf = (ctx: ExtensionContext): string => {
    const threadId = threadIdFor(ctx);
    engine.setThreadId(threadId);
    return threadId;
  };

  pi.registerTool(
    defineTool({
      ...getGoalToolSpec,
      execute(_id, _params, _signal, _onUpdate, ctx): Promise<AgentToolResult<GoalToolResponse>> {
        const threadId = threadOf(ctx);
        const response = executeGetGoal(engine.service, threadId);
        return Promise.resolve({
          content: [{ type: "text", text: formatGoal(response.goal, response.remaining_tokens) }],
          details: response,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      ...createGoalToolSpec,
      execute(_id, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<GoalToolResponse>> {
        const threadId = threadOf(ctx);
        const response = executeCreateGoal(engine.service, threadId, {
          objective: params.objective,
          token_budget: params.token_budget,
        }, engine.maxGoalTokenBudget());
        if (response.goal) {
          setThreadPreviewIfEmpty(pi, response.goal);
          engine.runtimeFor(threadId).applyExternalGoalSet(response.goal, null);
        }
        return Promise.resolve({
          content: [{ type: "text", text: formatGoal(response.goal, response.remaining_tokens) }],
          details: response,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      ...updateGoalToolSpec,
      execute(_id, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<GoalToolResponse>> {
        const threadId = threadOf(ctx);
        const response = executeUpdateGoal(engine.service, threadId, {
          status: params.status as "complete" | "blocked" | "paused",
        });
        return Promise.resolve({
          content: [{ type: "text", text: formatGoal(response.goal, response.remaining_tokens) }],
          details: response,
        });
      },
    }),
  );
}

/**
 * Wire runtime continuation/steering callbacks into the pi host.
 *
 * Idle continuation: dispatch the continuation prompt as a hidden follow-up
 * message that triggers a new turn (Codex `continue_if_idle`). Active steering:
 * inject the prompt into the running turn (Codex `inject_active_turn_steering`).
 */
export function wireRuntime(pi: ExtensionAPI, engine: GoalEngine): void {
  engine.onContinueIfIdle = (threadId, prompt) => {
    const runtime = engine.runtimeFor(threadId);
    // The follow-up turn is an automatic continuation, so the empty-response
    // audit applies to it (claim D).
    runtime.markNextTurnAsContinuation();
    pi.sendMessage(
      { customType: "secretary:goal", content: prompt, display: false, details: {} },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    // The continuation is queued on the host; mark it admitted only once the
    // follow-up turn actually starts (claim B/S).
  };
  engine.onInjectSteering = (_threadId, prompt) => {
    pi.sendMessage(
      { customType: "secretary:goal", content: prompt, display: false, details: {} },
      { triggerTurn: false, deliverAs: "steer" },
    );
  };

  wireAccounting(pi, engine);

  // Re-admit idle continuation once a turn settles and the goal is still
  // active (Codex `on_thread_idle` sustained continuation, claim B).
  pi.on("agent_settled", (_event, ctx) => {
    const threadId = threadIdFor(ctx);
    if (engine.service.getGoal(threadId)?.status !== "active") return;
    const runtime = engine.runtimeFor(threadId);
    runtime.admitContinuation();
    runtime.attemptContinuationIfIdle();
  });
}

/**
 * Set the session display name from a freshly created goal objective, but only
 * when no name/preview is already set (Codex `fill_empty_thread_preview_if_possible`).
 */
function setThreadPreviewIfEmpty(pi: ExtensionAPI, goal: ThreadGoal): void {
  const existing = pi.getSessionName();
  if (existing) return;
  // Only seed when there is no already-authored preview; pi's session name is
  // the closest equivalent to Codex's empty thread preview (claim T).
  if (goal.objective.trim().length === 0) return;
  pi.setSessionName(goal.objective.slice(0, 80));
}

/**
 * Charge per-turn token usage to the active goal (Codex goal accounting).
 * On `turn_start` we baseline the turn; on `turn_end` we read the assistant
 * message's `usage`, charge the delta to the active goal, and finish the turn.
 * Plan-mode / usage-less turns are skipped (no charge).
 */
function wireAccounting(pi: ExtensionAPI, engine: GoalEngine): void {
  // Current turn (by thread) so tool-execution events can map to the turn.
  const currentTurn = new Map<string, { turnId: string }>();

  // turn_start: baseline the turn for the active goal (claim G per-turn base).
  pi.on("turn_start", (event, ctx) => {
    const threadId = threadIdFor(ctx);
    const goal = engine.service.getGoal(threadId);
    if (goal?.status !== "active") return;
    const runtime = engine.runtimeFor(threadId);
    const turnId = `turn-${event.turnIndex}`;
    currentTurn.set(threadId, { turnId });
    runtime.startTurn(turnId, true, zeroTokenUsage());
  });

  // tool_execution_end: feed the exec-failure / tool-success audit (claim D).
  pi.on("tool_execution_end", (event, ctx) => {
    const threadId = threadIdFor(ctx);
    const goal = engine.service.getGoal(threadId);
    if (goal?.status !== "active") return;
    const entry = currentTurn.get(threadId);
    if (!entry) return;
    const runtime = engine.runtimeFor(threadId);
    const isExec = event.toolName === "bash" || event.toolName === "powershell";
    runtime.recordToolOutcome(entry.turnId, isExec ? "exec" : event.toolName, {
      // A tool that ran and returned an error DID execute its handler, so
      // handlerExecuted is true for a genuine execution failure (Codex audit).
      kind: event.isError ? "failed" : "completed",
      success: !event.isError,
      handlerExecuted: true,
    } as never);
  });

  // turn_end: classify the assistant message (claims I/J), run the blocked
  // audits, account the turn, dispatch budget-limit steering (claim G/Q), and
  // finish the turn.
  pi.on("turn_end", (event, ctx) => {
    const threadId = threadIdFor(ctx);
    const goal = engine.service.getGoal(threadId);
    if (goal?.status !== "active") return;
    const runtime = engine.runtimeFor(threadId);
    const turnId = `turn-${event.turnIndex}`;
    currentTurn.delete(threadId);
    const assistant = event.message as {
      role?: string;
      usage?: UsageLike;
      stopReason?: string;
      errorMessage?: string;
    };

    if (assistant?.role === "assistant" && assistant.usage) {
      runtime.recordTokenUsage(turnId, convertUsage(assistant.usage));
    }

    // Claim D: run the impasse audits before accounting/finishing. These are
    // non-consuming peeks; the consuming path (stopActiveGoalForTurn) runs once.
    const execBlocked = runtime.executionFailureBlocked(turnId);
    const emptyBlocked = runtime.emptyResponseBlocked(turnId);
    if (execBlocked || emptyBlocked) {
      runtime.stopActiveGoalForTurn(turnId, emptyBlocked ? "empty_response" : "turn_error");
      runtime.finishTurn(turnId);
      return;
    }

    // Claim I: non-retryable terminal error -> blocked / usage_limited.
    if (assistant?.stopReason === "error") {
      runtime.stopActiveGoalForTurn(turnId, "turn_error");
      runtime.finishTurn(turnId);
      return;
    }
    // Claim J: aborted -> account the partial turn and clear without persisting
    // a blocked status (keep_active is the wrong disposition on cancel).
    if (assistant?.stopReason === "aborted") {
      runtime.accountActiveGoalProgress(turnId, "turn-abort", "active_only", "clear_active");
      runtime.releaseContinuation();
      runtime.finishTurn(turnId);
      return;
    }

    const result = runtime.accountActiveGoalProgress(
      turnId,
      "turn-end",
      "active_only",
      "keep_active",
    );
    // Claim G/Q: dispatch budget-limit steering once per crossed goal.
    if (result && result.goal.status === "budget_limited") {
      runtime.dispatchBudgetLimitSteering(result.goal);
    }
    runtime.finishTurn(turnId);
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

function zeroTokenUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function convertUsage(usage: UsageLike) {
  return {
    inputTokens: usage.input ?? 0,
    cachedInputTokens: usage.cacheRead ?? 0,
    cacheWriteInputTokens: usage.cacheWrite ?? 0,
    outputTokens: usage.output ?? 0,
    reasoningOutputTokens: usage.reasoning ?? 0,
    totalTokens:
      usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
  };
}

function formatGoal(
  goal: { status: string; objective: string } | null,
  remaining: number | null,
): string {
  if (!goal) return "No current goal for this thread.";
  const lines = [`Goal [${goal.status}]: ${goal.objective}`];
  if (remaining !== null) lines.push(`Remaining token budget: ${remaining}`);
  return lines.join("\n");
}
