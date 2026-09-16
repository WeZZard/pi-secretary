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
import { type GoalReceipt } from "./goal/ordering.ts";

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
  | { kind: "notify"; message: string; error?: boolean }
  | { kind: "edit"; current: ThreadGoal };

export function applyGoalCommand(
  engine: GoalEngine,
  threadId: string,
  args: string,
  expectedGoalId?: string,
  receipt?: GoalReceipt,
): GoalCommandResult {
  const trimmed = args.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "edit") {
    // Open an editor prefilled with the current objective, if one exists.
    const current = engine.service.getGoal(threadId);
    if (!current) {
      return { kind: "notify", message: "No goal to edit; set one with `/goal <objective>`.", error: true };
    }
    return { kind: "edit", current };
  }
  if (lower === "clear") {
    const outcome = engine.service.clearGoal(threadId, "user", expectedGoalId, receipt);
    return outcome.goal
      ? { kind: "notify", message: "Goal changed; it was not cleared. Inspect it and try again.", error: true }
      : { kind: "notify", message: outcome.previousGoal ? "Goal cleared." : "No current goal to clear." };
  }
  if (lower === "pause") {
    const update = engine.service.requestTerminalUpdate(threadId, "paused", "user", expectedGoalId, receipt);
    return { kind: "notify", message: update.goal?.status === "paused"
      ? "Goal paused." : `Goal remains ${update.goal?.status}; it was not paused.` };
  }
  if (lower === "resume") {
    const update = engine.service.setGoal(threadId, { status: "active" }, "user", receipt);
    return { kind: "notify", message: update.goal?.status === "active"
      ? "Goal resumed." : `Cannot resume: goal remains ${update.goal?.status}; no token budget is available.` };
  }

  if (trimmed === "") {
    const { widget } = renderGoalDashboard(engine.service.getGoal(threadId));
    return { kind: "view", body: widget };
  }

  // `/goal <objective>` sets (create or replace) the goal as Active, matching
  // Codex's draft behavior (a new objective reactivates a completed goal).
  try {
    const existing = engine.service.getGoal(threadId);
    const outcome = existing
      ? engine.service.setGoal(threadId, { objective: trimmed, status: "active" }, "user", receipt)
      : engine.service.createGoal(threadId, trimmed, undefined, "user", receipt);
    return {
      kind: "notify",
      message: outcome.goal ? `Goal [${outcome.goal.status}]: ${outcome.goal.objective}` : "No current goal.",
    };
  } catch (err) {
    return { kind: "notify", message: (err as Error).message, error: true };
  }
}

/**
 * Apply an edited objective from the `/goal edit` dialog. Reactivates a
 * completed goal (explicit active status, matching Codex's draft behavior),
 * validates non-empty text, and re-runs the external-goal-set effect.
 * Returns a notify result describing the outcome.
 */
export function applyGoalEdit(
  engine: GoalEngine,
  threadId: string,
  newObjective: string,
  receipt?: GoalReceipt,
): GoalCommandResult {
  const trimmed = newObjective.trim();
  if (trimmed === "") {
    return { kind: "notify", message: "Goal objective must not be empty.", error: true };
  }
  const previous = engine.service.getGoal(threadId);
  if (!previous) {
    return { kind: "notify", message: "No goal to edit.", error: true };
  }
  try {
    const outcome = engine.service.setGoal(
      threadId,
      { objective: trimmed, status: "active" },
      "user",
      receipt,
    );
    return { kind: "notify", message: `Goal [${outcome.goal?.status}]: ${trimmed}` };
  } catch (err) {
    return { kind: "notify", message: (err as Error).message, error: true };
  }
}

/**
 * Register the goal UI: a `/goal` slash command for view/create/update/clear,
 * and live widget/status updates driven by goal_updated events.
 */
export function registerGoalUI(pi: ExtensionAPI, engine: GoalEngine): {
  bind(ctx: ExtensionContext): void;
  refresh(): void;
  unavailable(): void;
  dispose(): void;
} {
  // Session lifecycle binding is independent of command invocation.
  let disposed = false;
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

  const bind = (ctx: ExtensionContext): void => {
    if (!disposed) latestUi = ctx.hasUI ? ctx.ui : null;
  };
  const unavailable = (): void => {
    latestUi?.setStatus("secretary:goal", "goal status unavailable");
    latestUi?.setWidget("secretary:goal", ["Goal status is unavailable; this does not establish that it was cleared."]);
  };

  pi.registerCommand("goal", {
    description:
      "Set or view the goal for a long-running task. `/goal <objective>` sets a goal; `/goal` views it; `/goal clear|edit|pause|resume` control it.",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const threadId =
        ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
      let receipt: GoalReceipt | undefined;
      try {
        const expected = engine.service.getGoal(threadId);
        receipt = engine.service.ordering.receive(threadId, "command", expected?.goalId ?? null);
        if (disposed) return;
        bind(ctx);
        engine.setThreadId(threadId);
        const isCurrent = () => !disposed && engine.getThreadId() === threadId;
        if (args.trim().toLowerCase() === "clear" && expected) {
          engine.service.ordering.resolve(receipt);
          receipt = undefined;
          if (!await ctx.ui.confirm("Clear goal?", expected.objective)) return;
          receipt = engine.service.ordering.receive(threadId, "dialog", expected.goalId);
          if (!isCurrent()) return;
          if (engine.service.getGoal(threadId)?.goalId !== expected.goalId) {
            ctx.ui.notify("Goal changed while confirmation was open; inspect it and try again.", "warning");
            return;
          }
        }
        const result = applyGoalCommand(engine, threadId, args, expected?.goalId, receipt);
        if (result.kind === "view") {
          if (receipt) engine.service.ordering.resolve(receipt);
          receipt = undefined;
          const body = result.body.length ? result.body : [
            "No goal is currently set.", "",
            "Set one with `/goal <objective>`, or ask the agent (it calls create_goal).",
          ];
          await ctx.ui.input("Goal", body.join("\n"));
          if (!isCurrent()) return;
        } else if (result.kind === "edit") {
          if (receipt) engine.service.ordering.resolve(receipt);
          receipt = undefined;
          const edited = await ctx.ui.editor("Edit goal objective", result.current.objective);
          if (edited === undefined) return;
          receipt = engine.service.ordering.receive(threadId, "dialog", result.current.goalId);
          if (!isCurrent()) return;
          if (engine.service.getGoal(threadId)?.goalId !== result.current.goalId) {
            ctx.ui.notify("Goal changed while the editor was open; inspect it and try again.", "warning");
            return;
          }
          const editResult = applyGoalEdit(engine, threadId, edited, receipt);
          if (editResult.kind === "notify") ctx.ui.notify(editResult.message, editResult.error ? "error" : "info");
        } else {
          ctx.ui.notify(result.message, result.error ? "error" : "info");
        }
        refresh();
      } catch (error) {
        if (disposed) return;
        try { refresh(); } catch { unavailable(); }
        ctx.ui.notify((error as Error).message, "error");
      } finally {
        if (receipt) engine.service.ordering.resolve(receipt);
      }
    },
  });
  return {
    bind,
    refresh,
    unavailable,
    dispose: () => { disposed = true; latestUi = null; },
  };
}
