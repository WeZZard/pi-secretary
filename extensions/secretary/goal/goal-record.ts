/**
 * Codex-faithful goal data model.
 *
 * Mirrors `codex-rs/state/src/model/thread_goal.rs` and
 * `codex-rs/protocol/src/protocol.rs`. One goal per thread.
 */

export type ThreadGoalStatus =
  | "active" // only status that continues
  | "paused" // user-initiated
  | "blocked" // audited model impasse or unrecovered runtime failure
  | "usage_limited" // system usage limit
  | "budget_limited" // system token budget reached
  | "complete"; // verified achievement

export interface ThreadGoal {
  threadId: string;
  goalId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget?: number /** positive, optional */;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number /** epoch ms */;
  updatedAt: number /** epoch ms */;
}

export const MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4000;

export function isTerminalStatus(status: ThreadGoalStatus): boolean {
  return status === "budget_limited" || status === "complete";
}

export function isActiveStatus(status: ThreadGoalStatus): boolean {
  return status === "active";
}

export function validateThreadGoalObjective(
  objective: string,
): { ok: true } | { ok: false; error: string } {
  if (objective.trim().length === 0) {
    return { ok: false, error: "goal objective must not be empty" };
  }
  if (objective.trim().length > MAX_THREAD_GOAL_OBJECTIVE_CHARS) {
    return {
      ok: false,
      error: `goal objective must be at most ${MAX_THREAD_GOAL_OBJECTIVE_CHARS} characters`,
    };
  }
  return { ok: true };
}

export function validateGoalBudget(
  tokenBudget: number | undefined,
  max?: number,
): { ok: true } | { ok: false; error: string } {
  if (tokenBudget !== undefined) {
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
      return { ok: false, error: "goal budgets must be positive when provided" };
    }
    if (max !== undefined && tokenBudget > max) {
      return {
        ok: false,
        error: `goal budget must not exceed the configured maximum of ${max}`,
      };
    }
  }
  return { ok: true };
}

/** Effective status after applying a token budget (immediate limit). */
export function statusAfterBudgetLimit(
  status: ThreadGoalStatus,
  tokenBudget: number | undefined,
  tokensUsed: number,
): ThreadGoalStatus {
  if (
    tokenBudget !== undefined &&
    tokensUsed >= tokenBudget &&
    status !== "complete" &&
    status !== "paused"
  ) {
    return "budget_limited";
  }
  return status;
}
