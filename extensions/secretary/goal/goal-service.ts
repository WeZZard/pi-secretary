/**
 * GoalService — the sole mutation boundary for thread goals.
 *
 * Mirrors `codex-rs/ext/goal/src/api.rs`. Every mutation (tool, command, TUI)
 * routes through here. Centralizes the per-goal state permit (serializes a
 * persisted mutation against idle continuation), the `expected_goal_id`
 * compare-and-apply guard, runtime-effect outcomes, and ThreadGoalUpdated
 * event emission.
 */

import { type ThreadGoal, type ThreadGoalStatus } from "./goal-record.ts";
import { GoalDb } from "./storage/goal-db.ts";

export type GoalMutationSource = "user" | "agent" | "system";

export type GoalContinuationEffect = "start_if_idle" | "stop" | "unchanged";

export interface GoalMutationOutcome {
  goal: ThreadGoal | null;
  previousGoal: ThreadGoal | null;
  effect: GoalContinuationEffect;
  steering?: "objective_updated" | "budget_limit" | "complete";
}

export type TerminalUpdateStatus = "complete" | "blocked" | "paused";

const TERMINAL_UPDATE_STATUSES: ReadonlySet<string> = new Set([
  "complete",
  "blocked",
  "paused",
]);

export type GoalListener = (goal: ThreadGoal | null) => void;

export class GoalService {
  private readonly db: GoalDb;
  private readonly listeners = new Set<GoalListener>();
  private readonly pendingContinuation = new Set<string>();
  private focused: string | null = null;

  constructor(db: GoalDb) {
    this.db = db;
  }

  // ---- events ----------------------------------------------------------------

  /** Subscribe to `ThreadGoalUpdated` events (the TUI uses this). */
  onGoalUpdated(listener: GoalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(goal: ThreadGoal | null): void {
    for (const listener of this.listeners) listener(goal);
  }

  // ---- reads -----------------------------------------------------------------

  getGoal(threadId: string): ThreadGoal | null {
    return this.db.getThreadGoal(threadId);
  }

  getFocusedThreadId(): string | null {
    return this.focused;
  }

  setFocusedThreadId(threadId: string | null): void {
    this.focused = threadId;
  }

  // ---- mutations -------------------------------------------------------------

  createGoal(threadId: string, objective: string, tokenBudget?: number): GoalMutationOutcome {
    const previous = this.db.getThreadGoal(threadId);
    const goal = this.db.insertThreadGoal(threadId, objective, "active", tokenBudget);
    if (!goal) {
      throw new Error(
        "cannot create a new goal because this thread has an unfinished goal; complete the existing goal first",
      );
    }
    this.focused = threadId;
    this.emit(goal);
    return {
      goal,
      previousGoal: previous,
      effect: "start_if_idle",
      steering: goal.status === "budget_limited" ? "budget_limit" : undefined,
    };
  }

  /**
   * User edit: replace objective/status/budget, preserving usage and
   * timestamps. Editing a complete or budget-limited goal reactivates it.
   */
  setGoal(
    threadId: string,
    request: { objective?: string; status?: ThreadGoalStatus; tokenBudget?: number | null },
    _source: GoalMutationSource,
  ): GoalMutationOutcome {
    const current = this.db.getThreadGoal(threadId);
    const previous = current;

    let status: ThreadGoalStatus | undefined = request.status;
    // Editing a terminal goal reactivates it, unless a terminal status is set.
    if (
      request.objective !== undefined &&
      current &&
      (current.status === "complete" || current.status === "budget_limited")
    ) {
      status = "active";
    }

    const updated = this.db.updateThreadGoal(threadId, {
      objective: request.objective,
      status,
      tokenBudget: request.tokenBudget === undefined ? undefined : request.tokenBudget,
      expectedGoalId: current?.goalId,
    });
    if (!updated) {
      throw new Error("cannot update goal: no goal exists or version changed");
    }
    this.emit(updated);
    const effect: GoalContinuationEffect = updated.status === "active" ? "start_if_idle" : "stop";
    return {
      goal: updated,
      previousGoal: previous,
      effect,
      steering:
        request.objective !== undefined
          ? "objective_updated"
          : updated.status === "budget_limited"
            ? "budget_limit"
            : undefined,
    };
  }

  clearGoal(threadId: string, _source: GoalMutationSource): GoalMutationOutcome {
    const previous = this.db.getThreadGoal(threadId);
    const deleted = this.db.deleteThreadGoal(threadId);
    if (deleted) this.cancelContinuation(threadId);
    this.emit(null);
    return { goal: null, previousGoal: previous, effect: "stop" };
  }

  /**
   * Model terminal update (complete/blocked, or paused at user request).
   * Only these three are allowed; resume/budget/usage are user/system.
   */
  requestTerminalUpdate(
    threadId: string,
    status: TerminalUpdateStatus,
    _source: GoalMutationSource,
    expectedGoalId?: string,
  ): GoalMutationOutcome {
    if (!TERMINAL_UPDATE_STATUSES.has(status)) {
      throw new Error(
        "update_goal can only mark the existing goal complete, blocked, or paused at the user's explicit request",
      );
    }
    const current = this.db.getThreadGoal(threadId);
    if (!current) throw new Error("cannot update goal: no goal exists");
    if (expectedGoalId !== undefined && current.goalId !== expectedGoalId) {
      throw new Error("cannot update goal: version changed");
    }

    const updated = this.db.updateThreadGoal(threadId, {
      status,
      expectedGoalId: expectedGoalId ?? current.goalId,
    });
    if (!updated) throw new Error("cannot update goal: version changed");

    this.cancelContinuation(threadId);
    this.emit(updated);
    return {
      goal: updated,
      previousGoal: current,
      effect: "stop",
      steering: status === "complete" ? "complete" : undefined,
    };
  }

  // ---- continuation gate -----------------------------------------------------

  registerContinuation(threadId: string): void {
    this.pendingContinuation.add(threadId);
  }

  hasPendingContinuation(threadId: string): boolean {
    return this.pendingContinuation.has(threadId);
  }

  cancelContinuation(threadId: string): void {
    this.pendingContinuation.delete(threadId);
  }

  // ---- accounting (used by the runtime) --------------------------------------

  /** Charge token/time usage to a goal. Returns the updated goal or null. */
  accountGoalUsage(
    threadId: string,
    timeDeltaSeconds: number,
    tokenDelta: number,
    mode: "active_only" | "active_or_complete" | "active_or_stopped",
    expectedGoalId?: string,
  ): ThreadGoal | null {
    const outcome = this.db.accountThreadGoalUsage(
      threadId,
      timeDeltaSeconds,
      tokenDelta,
      mode,
      expectedGoalId,
    );
    if (outcome.kind === "unchanged") return null;
    this.emit(outcome.goal);
    return outcome.goal;
  }

  /** Stop a goal to a terminal status (system-driven, e.g. usage limit/blocked). */
  stopActiveGoal(
    threadId: string,
    status: "blocked" | "usage_limited" | "complete" | "paused",
    expectedGoalId?: string,
  ): ThreadGoal | null {
    const current = this.db.getThreadGoal(threadId);
    if (!current) return null;
    const updated = this.db.updateThreadGoal(threadId, {
      status,
      expectedGoalId: expectedGoalId ?? current.goalId,
    });
    if (!updated) return null;
    this.cancelContinuation(threadId);
    this.emit(updated);
    return updated;
  }
}

export { TERMINAL_UPDATE_STATUSES };
