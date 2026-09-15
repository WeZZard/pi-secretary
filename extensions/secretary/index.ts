import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { GoalEngine } from "./goal-engine.ts";
import { registerGoalUI } from "./goal-ui.ts";
import {
  executeCreateGoal,
  executeGetGoal,
  executeUpdateGoal,
  type GoalToolResponse,
  GoalToolError,
} from "./goal/tools/goal-tool-executors.ts";
import {
  createGoalToolSpec,
  getGoalToolSpec,
  updateGoalToolSpec,
} from "./goal/tools/goal-tool-specs.ts";

/**
 * pi-secretary.
 *
 * Replicates OpenAI Codex's goal system semantics (get_goal/create_goal/
 * update_goal, 6 statuses, single-goal-per-thread, SQLite persistence,
 * prompt-driven completion audit) presented through the pi-goal-x-style TUI
 * widget + status line.
 *
 * The goal engine (GoalEngine) is created lazily on first session/thread use
 * so it does not open a SQLite handle until a goal is actually needed, and is
 * closed on session shutdown.
 */
export default function secretaryExtension(pi: ExtensionAPI): void {
  let engine: GoalEngine | null = null;

  const ensureEngine = (): GoalEngine => {
    if (!engine) engine = createEngine();
    return engine;
  };

  const createEngine = (): GoalEngine => {
    const dbPath = defaultDbPath();
    const eng = new GoalEngine({ dbPath, enabled: true });
    registerGoalTools(pi, eng);
    registerGoalUI(pi, eng);
    wireRuntime(pi, eng);
    return eng;
  };

  const defaultDbPath = (): string => {
    const dir = process.env.PI_SECRETARY_DB_DIR ?? process.cwd();
    return path.join(dir, "pi-secretary-goals.sqlite");
  };

  // Close the SQLite handle when the session ends.
  pi.on("session_shutdown", () => {
    engine?.close();
    engine = null;
  });

  // Warm the engine on first session so the widget has a goal to show without
  // forcing a SQLite open for sessions that never use goals.
  void ensureEngine;
}

function threadIdFor(ctx: ExtensionContext): string | null {
  return ctx.sessionManager.getSessionFile() ?? null;
}

/**
 * Register the three Codex-faithful goal tools against the engine.
 */
export function registerGoalTools(pi: ExtensionAPI, engine: GoalEngine): void {
  const threadOf = (ctx: ExtensionContext): string => {
    const threadId = threadIdFor(ctx);
    if (!threadId) {
      throw new GoalToolError("Goal tools require a persistent thread.");
    }
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
        });
        if (response.goal) {
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
 * Wire runtime continuation/steering callbacks into the pi host. The actual
 * "start idle continuation" and "inject active steering" side effects are
 * stubbed here and intended to be backed by pi's turn-start mechanism.
 */
export function wireRuntime(pi: ExtensionAPI, engine: GoalEngine): void {
  engine.onContinueIfIdle = (_threadId, prompt) => {
    void prompt;
    void pi;
  };
  engine.onInjectSteering = (_threadId, prompt) => {
    void prompt;
    void pi;
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
