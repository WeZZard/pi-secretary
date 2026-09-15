/**
 * Codex-faithful SQLite storage layer for thread goals.
 *
 * Mirrors `codex-rs/state/src/runtime/goals.rs`. Backed by Node's built-in
 * `node:sqlite` (DatabaseSync). One goal per thread; transactional writes;
 * `expected_goal_id` compare-and-apply guards against stale/concurrent writes.
 */

import { DatabaseSync } from "node:sqlite";
import {
  type ThreadGoal,
  type ThreadGoalStatus,
  isActiveStatus,
  isTerminalStatus,
  statusAfterBudgetLimit,
  validateGoalBudget,
  validateThreadGoalObjective,
} from "../goal-record.ts";

export const GOALS_DDL = `
CREATE TABLE IF NOT EXISTS thread_goals (
  thread_id        TEXT PRIMARY KEY,
  goal_id          TEXT NOT NULL,
  objective        TEXT NOT NULL,
  status           TEXT NOT NULL,
  token_budget     INTEGER,
  tokens_used      INTEGER NOT NULL DEFAULT 0,
  time_used_seconds INTEGER NOT NULL DEFAULT 0,
  created_at_ms    INTEGER NOT NULL,
  updated_at_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_goals_thread ON thread_goals(thread_id);
`;

export interface GoalUpdate {
  objective?: string;
  status?: ThreadGoalStatus;
  tokenBudget?: number | null;
  expectedGoalId?: string;
}

export type GoalAccountingMode = "active_only" | "active_or_complete" | "active_or_stopped";

export type GoalAccountingOutcome =
  | { kind: "updated"; goal: ThreadGoal }
  | { kind: "unchanged" };

export class GoalDb {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(GOALS_DDL);
  }

  /** Open (or create) a goal database at `path`. Use `:memory:` for tests. */
  static open(path: string): GoalDb {
    const db = new DatabaseSync(path);
    return new GoalDb(db);
  }

  close(): void {
    this.db.close();
  }

  // ---- reads ------------------------------------------------------------------

  getThreadGoal(threadId: string): ThreadGoal | null {
    const row = this.db
      .prepare(
        `SELECT thread_id, goal_id, objective, status, token_budget,
                tokens_used, time_used_seconds, created_at_ms, updated_at_ms
         FROM thread_goals WHERE thread_id = ?`,
      )
      .get(threadId) as row | undefined;
    return row ? rowToGoal(row) : null;
  }

  // ---- writes ----------------------------------------------------------------

  /**
   * Replace the goal for a thread (used by create when none exists, or to
   * replace a completed goal). Returns the new goal, or null if a non-terminal
   * goal already exists.
   */
  replaceThreadGoal(
    threadId: string,
    objective: string,
    status: ThreadGoalStatus,
    tokenBudget?: number,
  ): ThreadGoal | null {
    const validation = validateThreadGoalObjective(objective);
    if (!validation.ok) throw new Error(validation.error);
    if (tokenBudget !== undefined && tokenBudget < 0) {
      throw new Error("goal budgets must not be negative");
    }

    const existing = this.getThreadGoal(threadId);
    if (existing && !isTerminalStatus(existing.status)) {
      return null; // cannot replace an unfinished goal
    }

    const now = Date.now();
    const goalId = crypto.randomUUID();
    const effectiveStatus = statusAfterBudgetLimit(status, tokenBudget, 0);
    this.db
      .prepare(
        `INSERT INTO thread_goals
           (thread_id, goal_id, objective, status, token_budget,
            tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           goal_id = excluded.goal_id,
           objective = excluded.objective,
           status = excluded.status,
           token_budget = excluded.token_budget,
           tokens_used = 0,
           time_used_seconds = 0,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        threadId,
        goalId,
        objective,
        effectiveStatus,
        tokenBudget ?? null,
        now,
        now,
      );
    return this.getThreadGoal(threadId);
  }

  /**
   * Insert a new goal for a thread. Fails (null) if any goal already exists —
   * Codex's single-goal-per-thread invariant.
   */
  insertThreadGoal(
    threadId: string,
    objective: string,
    status: ThreadGoalStatus,
    tokenBudget?: number,
  ): ThreadGoal | null {
    const validation = validateThreadGoalObjective(objective);
    if (!validation.ok) throw new Error(validation.error);
    if (tokenBudget !== undefined && tokenBudget < 0) {
      throw new Error("goal budgets must not be negative");
    }

    if (this.getThreadGoal(threadId)) return null; // never replace on insert

    const now = Date.now();
    const goalId = crypto.randomUUID();
    const effectiveStatus = statusAfterBudgetLimit(status, tokenBudget, 0);
    this.db
      .prepare(
        `INSERT INTO thread_goals
           (thread_id, goal_id, objective, status, token_budget,
            tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(threadId, goalId, objective, effectiveStatus, tokenBudget ?? null, now, now);
    return this.getThreadGoal(threadId);
  }

  /**
   * Update fields of an existing goal. `expectedGoalId` guards against a
   * replaced goal version (compare-and-apply). Returns the updated goal, or
   * null if the goal is missing or the version no longer matches.
   */
  updateThreadGoal(
    threadId: string,
    update: GoalUpdate,
  ): ThreadGoal | null {
    const current = this.getThreadGoal(threadId);
    if (!current) return null;
    if (update.expectedGoalId !== undefined && current.goalId !== update.expectedGoalId) {
      return null; // stale version
    }

    const nextStatus = update.status ?? current.status;
    const nextBudget =
      update.tokenBudget === undefined ? current.tokenBudget : update.tokenBudget ?? undefined;
    const objective = update.objective ?? current.objective;

    let finalStatus = nextStatus;
    // Enforce terminal-status precedence: pause/block cannot override terminal.
    if (
      (nextStatus === "paused" || nextStatus === "blocked") &&
      isTerminalStatus(current.status)
    ) {
      finalStatus = current.status;
    }
    if (!isTerminalStatus(finalStatus)) {
      finalStatus = statusAfterBudgetLimit(finalStatus, nextBudget, current.tokensUsed);
    }

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE thread_goals
         SET objective = ?, status = ?, token_budget = ?, updated_at_ms = ?
         WHERE thread_id = ?`,
      )
      .run(objective, finalStatus, nextBudget ?? null, now, threadId);
    return this.getThreadGoal(threadId);
  }

  deleteThreadGoal(threadId: string): ThreadGoal | null {
    const current = this.getThreadGoal(threadId);
    if (!current) return null;
    this.db.prepare(`DELETE FROM thread_goals WHERE thread_id = ?`).run(threadId);
    return current;
  }

  /** Cascade delete when a thread is deleted. */
  deleteThreadGoalsForThread(threadId: string): void {
    this.db.prepare(`DELETE FROM thread_goals WHERE thread_id = ?`).run(threadId);
  }

  // ---- accounting ------------------------------------------------------------

  /**
   * Add token/time usage to a goal, honoring the accounting mode and the
   * `expectedGoalId` version guard. Applies budget-limit transitions.
   */
  accountThreadGoalUsage(
    threadId: string,
    timeDeltaSeconds: number,
    tokenDelta: number,
    mode: GoalAccountingMode,
    expectedGoalId?: string,
  ): GoalAccountingOutcome {
    const current = this.getThreadGoal(threadId);
    if (!current) return { kind: "unchanged" };
    if (expectedGoalId !== undefined && current.goalId !== expectedGoalId) {
      return { kind: "unchanged" };
    }

    const canAccount = this.canAccountForMode(current.status, mode);
    if (!canAccount) return { kind: "unchanged" };

    const tokensUsed = current.tokensUsed + tokenDelta;
    const timeUsedSeconds = current.timeUsedSeconds + timeDeltaSeconds;

    let finalStatus: ThreadGoalStatus = current.status;
    if (!isTerminalStatus(finalStatus)) {
      finalStatus = statusAfterBudgetLimit(finalStatus, current.tokenBudget, tokensUsed);
    }

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE thread_goals
         SET tokens_used = ?, time_used_seconds = ?, status = ?, updated_at_ms = ?
         WHERE thread_id = ?`,
      )
      .run(tokensUsed, timeUsedSeconds, finalStatus, now, threadId);
    return { kind: "updated", goal: this.getThreadGoal(threadId)! };
  }

  private canAccountForMode(status: ThreadGoalStatus, mode: GoalAccountingMode): boolean {
    switch (mode) {
      case "active_only":
        return isActiveStatus(status);
      case "active_or_complete":
        return isActiveStatus(status) || status === "complete";
      case "active_or_stopped":
        return (
          isActiveStatus(status) ||
          status === "complete" ||
          status === "blocked" ||
          status === "paused"
        );
    }
  }
}

interface row {
  thread_id: string;
  goal_id: string;
  objective: string;
  status: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at_ms: number;
  updated_at_ms: number;
}

function rowToGoal(row: row): ThreadGoal {
  return {
    threadId: row.thread_id,
    goalId: row.goal_id,
    objective: row.objective,
    status: row.status as ThreadGoalStatus,
    tokenBudget: row.token_budget ?? undefined,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

/** Re-export for tests/tooling convenience. */
export { isTerminalStatus, validateGoalBudget, validateThreadGoalObjective };
