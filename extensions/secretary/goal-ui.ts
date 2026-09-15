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
      "Show or manage the current thread goal (view | create <text> | clear | complete | blocked | paused).",
    handler: async (args, ctx: ExtensionCommandContext) => {
      latestUi = ctx.ui;
      const threadId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
      engine.setThreadId(threadId);
      const [verb, ...rest] = args.trim().split(/\s+/);
      const target = rest.join(" ");

      switch (verb) {
        case "": {
          const goal = engine.service.getGoal(threadId);
          const { widget } = renderGoalDashboard(goal);
          const help = widget.length
            ? widget
            : [
                "No goal for this thread.",
                "",
                "Create one by asking the agent (it calls create_goal), or:",
                "  /goal create <objective>   ",
              ];
          await ctx.ui.input("Goal", help.join("\n"));
          break;
        }
        case "create": {
          if (!target) {
            ctx.ui.notify("Usage: /goal create <objective>", "warning");
            return;
          }
          try {
            engine.service.createGoal(threadId, target);
            ctx.ui.notify("Goal created.", "info");
          } catch (err) {
            ctx.ui.notify((err as Error).message, "error");
          }
          break;
        }
        case "clear":
          engine.service.clearGoal(threadId, "user");
          ctx.ui.notify("Goal cleared.", "info");
          break;
        case "complete":
        case "blocked":
        case "paused":
          engine.service.requestTerminalUpdate(threadId, verb, "user");
          ctx.ui.notify(`Goal ${verb}.`, "info");
          break;
        default:
          ctx.ui.notify(
            "Usage: /goal [create <text> | clear | complete | blocked | paused]",
            "warning",
          );
      }
    },
  });
}
