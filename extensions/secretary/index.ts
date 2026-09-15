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

  // Close the SQLite handle when the session ends.
  pi.on("session_shutdown", () => {
    engine.close();
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
 * Wire runtime continuation/steering callbacks into the pi host.
 *
 * Idle continuation: dispatch the continuation prompt as a hidden follow-up
 * message that triggers a new turn (Codex `continue_if_idle`). Active steering:
 * inject the prompt into the running turn (Codex `inject_active_turn_steering`).
 */
export function wireRuntime(pi: ExtensionAPI, engine: GoalEngine): void {
  engine.onContinueIfIdle = (_threadId, prompt) => {
    pi.sendMessage(
      { customType: "secretary:goal", content: prompt, display: false, details: {} },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };
  engine.onInjectSteering = (_threadId, prompt) => {
    pi.sendMessage(
      { customType: "secretary:goal", content: prompt, display: false, details: {} },
      { triggerTurn: false, deliverAs: "steer" },
    );
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
