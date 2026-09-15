/**
 * pi-secretary goal UI wiring.
 *
 * Ports the pi-goal-x presentation to the goal engine: an above-editor widget,
 * a status-line entry, and a `/goal` slash command. The goal dashboard shows
 * the single active thread goal (Codex single-goal-per-thread semantics).
 */

import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type ThreadGoal } from "./goal/goal-record.ts";
import { type GoalEngine } from "./goal-engine.ts";

export interface GoalStatusLine {
  /** Status-bar text (short). */
  status: string | undefined;
  /** Above-editor widget lines. */
  widget: string[];
}

/**
 * Render goal dashboard + status from a single goal. Pure and unit-testable.
 * No goal → no widget/status (cleared).
 */
export function renderGoalDashboard(goal: ThreadGoal | null): GoalStatusLine {
  if (!goal) return { status: undefined, widget: [] };

  const remaining =
    goal.tokenBudget !== undefined
      ? Math.max(goal.tokenBudget - goal.tokensUsed, 0)
      : undefined;

  const lines = [`▨ goal: ${goal.status}`, `   ${goal.objective}`];
  const usage: string[] = [];
  if (goal.tokenBudget !== undefined) {
    usage.push(`tokens ${goal.tokensUsed}/${goal.tokenBudget}`);
    usage.push(`remaining ${remaining}`);
  } else {
    usage.push(`tokens ${goal.tokensUsed}`);
  }
  if (goal.timeUsedSeconds > 0) {
    usage.push(`${goal.timeUsedSeconds}s`);
  }
  if (usage.length > 0) lines.push(`   ${usage.join(" · ")}`);

  return { status: `goal ${goal.status}`, widget: lines };
}

/**
 * Apply a `/goal` command argument string to the engine, matching Codex's
 * slash command behavior:
 *   - `/goal <objective>`    set (create or replace) the goal
 *   - `/goal`                view the goal
 *   - `/goal clear`          clear the goal
 *   - `/goal pause|resume`   transition the goal status
 * Pure and unit-testable; returns a describe result.
 */
export type GoalCommandResult =
  | { kind: "view"; body: string[] }
  | { kind: "notify"; message: string; error?: boolean };

export function applyGoalCommand(
  engine: GoalEngine,
  threadId: string,
  args: string,
): GoalCommandResult {
  const trimmed = args.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "clear") {
    const prev = engine.service.getGoal(threadId);
    engine.service.clearGoal(threadId, "user");
    if (prev) engine.runtimeFor(threadId).applyExternalGoalClear();
    return { kind: "notify", message: "Goal cleared." };
  }
  if (lower === "pause") {
    const update = engine.service.requestTerminalUpdate(threadId, "paused", "user");
    if (update.goal) engine.runtimeFor(threadId).applyExternalGoalSet(update.goal, update.previousGoal);
    return { kind: "notify", message: "Goal paused." };
  }
  if (lower === "resume") {
    const update = engine.service.setGoal(threadId, { status: "active" }, "user");
    if (update.goal) engine.runtimeFor(threadId).applyExternalGoalSet(update.goal, update.previousGoal);
    return { kind: "notify", message: "Goal resumed." };
  }

  if (trimmed === "") {
    const { widget } = renderGoalDashboard(engine.service.getGoal(threadId));
    return { kind: "view", body: widget };
  }

  // `/goal <objective>` sets (create or replace) the goal.
  try {
    const existing = engine.service.getGoal(threadId);
    const outcome = existing
      ? engine.service.setGoal(threadId, { objective: trimmed }, "user")
      : engine.service.createGoal(threadId, trimmed);
    if (outcome.goal) {
      engine.runtimeFor(threadId).applyExternalGoalSet(outcome.goal, outcome.previousGoal);
    }
    return {
      kind: "notify",
      message: outcome.goal ? `Goal set: ${outcome.goal.objective}` : "Goal set.",
    };
  } catch (err) {
    return { kind: "notify", message: (err as Error).message, error: true };
  }
}

/**
 * Register the goal UI: a `/goal` slash command for view/create/update/clear,
 * and live widget/status updates driven by goal_updated events.
 */
export function registerGoalUI(pi: ExtensionAPI, engine: GoalEngine): void {
  // Stash the latest UI so goal_updated events can refresh the dashboard
  // without each having its own ExtensionContext.
  let latestUi: {
    setStatus(key: string, text: string | undefined): void;
    setWidget(key: string, content: string[] | undefined): void;
  } | null = null;

  const refresh = (): void => {
    const goal = engine.getThreadId()
      ? engine.service.getGoal(engine.getThreadId()!) ?? null
      : null;
    const { status, widget } = renderGoalDashboard(goal);
    if (!latestUi) return;
    latestUi.setStatus("secretary:goal", status);
    latestUi.setWidget("secretary:goal", widget.length ? widget : undefined);
  };

  engine.onGoalChanged = () => refresh();

  pi.registerCommand("goal", {
    description:
      "Set or view the goal for a long-running task. `/goal <objective>` sets a goal; `/goal` views it; `/goal clear|edit|pause|resume` control it.",
    handler: async (args, ctx: ExtensionCommandContext) => {
      latestUi = ctx.ui;
      const threadId =
        ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
      engine.setThreadId(threadId);

      const result = applyGoalCommand(engine, threadId, args);
      if (result.kind === "view") {
        const body = result.body.length
          ? result.body
          : [
              "No goal is currently set.",
              "",
              "Set one with `/goal <objective>`, or ask the agent (it calls create_goal).",
            ];
        await ctx.ui.input("Goal", body.join("\n"));
      } else {
        ctx.ui.notify(result.message, result.error ? "error" : "info");
      }
    },
  });
}
