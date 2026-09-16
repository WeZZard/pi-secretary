/**
 * Per-thread goal accounting state.
 *
 * Ports `codex-rs/ext/goal/src/accounting.rs`. Tracks per-turn token baselines,
 * wall-clock time, descendant token usage, the blocked audit (3 consecutive
 * execution failures), and the empty-response audit (3 consecutive empty goal
 * turns), and produces progress snapshots charged to the active goal.
 */

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export function goalTokenDeltaForUsage(usage: TokenUsage): number {
  return Math.max(usage.inputTokens - usage.cachedInputTokens, 0) + Math.max(usage.outputTokens, 0);
}

export type ToolCallOutcome =
  | { kind: "completed"; success: boolean }
  | { kind: "failed"; handlerExecuted: boolean }
  | { kind: "blocked" }
  | { kind: "aborted" };

export type BudgetLimitedGoalDisposition = "keep_active" | "clear_active";

export interface GoalProgressSnapshot {
  currentTokenUsage: TokenUsage;
  currentDescendantTokenUsage: number;
  expectedGoalId: string;
  timeDeltaSeconds: number;
  tokenDelta: number;
}

export interface IdleGoalProgressSnapshot {
  currentDescendantTokenUsage: number;
  expectedGoalId: string;
  timeDeltaSeconds: number;
  tokenDelta: number;
}

interface TurnAccounting {
  currentTokenUsage: TokenUsage;
  lastAccountedTokenUsage: TokenUsage;
  activeGoalId: string | null;
  accountTokens: boolean;
  failedExecution: boolean;
  successfulTool: boolean;
  emptyFinal: boolean;
  hasActivity: boolean;
}

interface WallClockAccounting {
  lastAccountedAt: number; // epoch ms
  activeGoalId: string | null;
}

interface Inner {
  currentTurnId: string | null;
  turns: Map<string, TurnAccounting>;
  wallClock: WallClockAccounting;
  budgetLimitReportedGoalId: string | null;
  executionFailureGoalId: string | null;
  consecutiveExecutionFailureTurns: number;
  automaticGoalTurnId: string | null;
  consecutiveEmptyTurns: number;
  lastAccountedDescendantTokenUsage: number;
}

export class GoalAccountingState {
  readonly #inner: Inner;
  #descendantTokenUsage = 0;

  constructor(now: number = Date.now()) {
    this.#inner = {
      currentTurnId: null,
      turns: new Map(),
      wallClock: { lastAccountedAt: now, activeGoalId: null },
      budgetLimitReportedGoalId: null,
      executionFailureGoalId: null,
      consecutiveExecutionFailureTurns: 0,
      automaticGoalTurnId: null,
      consecutiveEmptyTurns: 0,
      lastAccountedDescendantTokenUsage: 0,
    };
  }

  startTurn(turnId: string, accountTokens: boolean, tokenUsageAtTurnStart: TokenUsage): void {
    this.#inner.currentTurnId = turnId;
    this.#inner.turns.set(turnId, {
      currentTokenUsage: tokenUsageAtTurnStart,
      lastAccountedTokenUsage: tokenUsageAtTurnStart,
      activeGoalId: null,
      accountTokens,
      failedExecution: false,
      successfulTool: false,
      emptyFinal: false,
      hasActivity: false,
    });
  }

  currentTurnId(): string | null {
    return this.#inner.currentTurnId;
  }

  recordToolOutcome(turnId: string, toolName: string, outcome: ToolCallOutcome): void {
    const inner = this.#inner;
    inner.consecutiveEmptyTurns = 0;
    const turn = inner.turns.get(turnId);
    if (!turn) return;
    turn.hasActivity = true;
    if (turn.activeGoalId === null) return;

    switch (outcome.kind) {
      case "completed":
        if (outcome.success) {
          turn.successfulTool = true;
          inner.executionFailureGoalId = null;
          inner.consecutiveExecutionFailureTurns = 0;
        }
        break;
      case "failed":
        if (outcome.handlerExecuted && toolName === "exec") {
          turn.failedExecution = true;
        }
        break;
      case "blocked":
      case "aborted":
        break;
    }
  }

  /** 3 consecutive exec-failure turns on the same goal → impasse. */
  executionFailureGoal(turnId: string): string | null {
    const inner = this.#inner;
    const turn = inner.turns.get(turnId);
    if (!turn) return null;
    const goalId = turn.activeGoalId;
    if (goalId === null) return null;
    if (turn.successfulTool) return null;
    if (!turn.failedExecution) return null;

    if (inner.executionFailureGoalId !== goalId) {
      inner.executionFailureGoalId = goalId;
      inner.consecutiveExecutionFailureTurns = 0;
    }
    inner.consecutiveExecutionFailureTurns += 1;
    return inner.consecutiveExecutionFailureTurns >= 3 ? goalId : null;
  }

  /**
   * Non-consuming version of `executionFailureGoal`: does not mutate the
   * consecutive-failure counter, so callers can probe the audit without
   * advancing it. The operational path (`stopActiveGoalForTurn`) still uses
   * the consuming `executionFailureGoal` exactly once.
   */
  peekExecutionFailureGoal(turnId: string): string | null {
    const inner = this.#inner;
    const turn = inner.turns.get(turnId);
    if (!turn) return null;
    const goalId = turn.activeGoalId;
    if (goalId === null) return null;
    if (turn.successfulTool) return null;
    if (!turn.failedExecution) return null;
    const sameGoal = inner.executionFailureGoalId === goalId;
    const count = sameGoal ? inner.consecutiveExecutionFailureTurns : 0;
    return count + 1 >= 3 ? goalId : null;
  }

  /** Nested `recordItem` port: mark activity / empty final. */
  recordItem(turnId: string, item: { hasText?: boolean; phase?: string | null }): void {
    const inner = this.#inner;
    const turn = inner.turns.get(turnId);
    if (!turn) return;

    const hasText = item.hasText ?? false;
    if (item.phase !== undefined && item.phase !== null) {
      // a message carries a phase; treat non-commentary empty as empty-final
      turn.hasActivity ||= hasText;
      turn.emptyFinal ||= !hasText && item.phase !== "commentary";
    } else {
      turn.hasActivity = true;
    }
    if (turn.hasActivity) inner.consecutiveEmptyTurns = 0;
  }

  markGoalContinuation(turnId: string): void {
    this.#inner.automaticGoalTurnId = turnId;
  }

  resetEmptyResponses(): void {
    this.#inner.automaticGoalTurnId = null;
    this.#inner.consecutiveEmptyTurns = 0;
  }

  /** 3 consecutive empty automatic goal turns → impasse. */
  emptyResponseGoal(turnId: string): string | null {
    const inner = this.#inner;
    const automatic = inner.automaticGoalTurnId === turnId;
    const turn = inner.turns.get(turnId);
    if (!turn) return null;
    const goalId = turn.activeGoalId;
    if (goalId === null) return null;
    const empty = automatic && turn.emptyFinal && !turn.hasActivity;
    turn.emptyFinal = false;
    if (!empty) {
      inner.consecutiveEmptyTurns = 0;
      return null;
    }
    inner.consecutiveEmptyTurns += 1;
    return inner.consecutiveEmptyTurns >= 3 ? goalId : null;
  }

  /**
   * Non-consuming version of `emptyResponseGoal`: returns the goal id when the
   * audit would trip, without clearing `emptyFinal` or advancing the counter.
   * Use before the operational `stopActiveGoalForTurn` consumes it exactly once.
   */
  peekEmptyResponseGoal(turnId: string): string | null {
    const inner = this.#inner;
    const automatic = inner.automaticGoalTurnId === turnId;
    const turn = inner.turns.get(turnId);
    if (!turn) return null;
    const goalId = turn.activeGoalId;
    if (goalId === null) return null;
    const empty = automatic && turn.emptyFinal && !turn.hasActivity;
    if (!empty) return null;
    return inner.consecutiveEmptyTurns + 1 >= 3 ? goalId : null;
  }

  currentActiveGoalIdForTurn(turnId: string): string | null {
    const inner = this.#inner;
    if (inner.currentTurnId !== turnId) return null;
    const turn = inner.turns.get(turnId);
    if (!turn) return null;
    if (!turn.accountTokens) return null;
    return turn.activeGoalId;
  }

  recordTokenUsage(turnId: string, totalUsage: TokenUsage): number | null {
    const inner = this.#inner;
    const turn = inner.turns.get(turnId);
    if (!turn) return null;
    turn.currentTokenUsage = totalUsage;
    if (!turn.accountTokens) return null;
    const delta = tokenDeltaSinceLastAccounting(turn.lastAccountedTokenUsage, totalUsage);
    return delta > 0 ? delta : null;
  }

  recordDescendantTokenUsage(usage: TokenUsage): void {
    const delta = goalTokenDeltaForUsage(usage);
    if (delta > 0) this.#descendantTokenUsage += delta;
  }

  markTurnGoalActive(turnId: string, goalId: string): void {
    const inner = this.#inner;
    if (inner.budgetLimitReportedGoalId !== goalId) inner.budgetLimitReportedGoalId = null;
    const turn = inner.turns.get(turnId);
    if (turn) {
      turn.activeGoalId = goalId;
      if (inner.currentTurnId === turnId) {
        if (inner.wallClock.activeGoalId !== goalId) {
          inner.consecutiveEmptyTurns = 0;
          inner.lastAccountedDescendantTokenUsage = this.#descendantTokenUsage;
        }
        inner.wallClock.activeGoalId = goalId;
      }
    }
  }

  markCurrentTurnGoalActive(goalId: string): string | null {
    const inner = this.#inner;
    const turnId = inner.currentTurnId;
    if (turnId === null) return null;
    if (inner.budgetLimitReportedGoalId !== goalId) inner.budgetLimitReportedGoalId = null;
    const goalChanged = inner.wallClock.activeGoalId !== goalId;
    const turn = inner.turns.get(turnId);
    if (turn) {
      if (turn.activeGoalId !== goalId) {
        turn.failedExecution = false;
        turn.successfulTool = false;
      }
      turn.activeGoalId = goalId;
      if (goalChanged) {
        turn.lastAccountedTokenUsage = turn.currentTokenUsage;
        inner.automaticGoalTurnId = null;
        inner.consecutiveEmptyTurns = 0;
        inner.lastAccountedDescendantTokenUsage = this.#descendantTokenUsage;
      }
    }
    inner.wallClock.activeGoalId = goalId;
    return turnId;
  }

  markIdleGoalActive(goalId: string): void {
    const inner = this.#inner;
    if (inner.budgetLimitReportedGoalId !== goalId) inner.budgetLimitReportedGoalId = null;
    if (inner.wallClock.activeGoalId !== goalId) {
      inner.consecutiveEmptyTurns = 0;
      inner.lastAccountedDescendantTokenUsage = this.#descendantTokenUsage;
    }
    inner.wallClock.activeGoalId = goalId;
  }

  clearCurrentTurnGoal(): string | null {
    const inner = this.#inner;
    const turnId = inner.currentTurnId;
    if (turnId === null) return null;
    const turn = inner.turns.get(turnId);
    if (turn) turn.activeGoalId = null;
    inner.wallClock.activeGoalId = null;
    inner.budgetLimitReportedGoalId = null;
    inner.executionFailureGoalId = null;
    inner.consecutiveExecutionFailureTurns = 0;
    inner.automaticGoalTurnId = null;
    inner.consecutiveEmptyTurns = 0;
    return turnId;
  }

  clearActiveGoal(): void {
    const inner = this.#inner;
    const turnId = inner.currentTurnId;
    if (turnId !== null) {
      const turn = inner.turns.get(turnId);
      if (turn) turn.activeGoalId = null;
    }
    inner.wallClock.activeGoalId = null;
    inner.budgetLimitReportedGoalId = null;
    inner.executionFailureGoalId = null;
    inner.consecutiveExecutionFailureTurns = 0;
    inner.automaticGoalTurnId = null;
    inner.consecutiveEmptyTurns = 0;
  }

  resetFailureAudit(): void {
    const inner = this.#inner;
    inner.executionFailureGoalId = null;
    inner.consecutiveExecutionFailureTurns = 0;
    this.resetEmptyResponses();
    const turn = inner.currentTurnId ? inner.turns.get(inner.currentTurnId) : undefined;
    if (turn) { turn.failedExecution = false; turn.successfulTool = false; turn.emptyFinal = false; }
  }

  /** Stop idle charging without losing the identity of an in-flight turn. */
  suspendGoal(): void {
    this.#inner.wallClock.activeGoalId = null;
    this.#inner.wallClock.lastAccountedAt = Date.now();
    this.#inner.executionFailureGoalId = null;
    this.#inner.consecutiveExecutionFailureTurns = 0;
    this.resetEmptyResponses();
  }

  /** Preserve the originating turn for late usage after a terminal update. */
  markProgressAccountedPreservingTurn(turnId: string, snapshot: GoalProgressSnapshot, status: string): void {
    this.markProgressAccountedForStatus(turnId, snapshot, "active", "keep_active");
    if (status !== "active") this.suspendGoal();
  }

  progressSnapshot(turnId: string, now: number): GoalProgressSnapshot | null {
    const inner = this.#inner;
    const turn = inner.turns.get(turnId);
    if (!turn) return null;
    if (!turn.accountTokens) return null;
    const expectedGoalId = turn.activeGoalId;
    if (expectedGoalId === null) return null;
    const currentDescendantTokenUsage = this.#descendantTokenUsage;
    const descendantTokenDelta = Math.max(
      currentDescendantTokenUsage - inner.lastAccountedDescendantTokenUsage,
      0,
    );
    const tokenDelta =
      tokenDeltaSinceLastAccounting(turn.lastAccountedTokenUsage, turn.currentTokenUsage) +
      descendantTokenDelta;
    const timeDeltaSeconds =
      inner.wallClock.activeGoalId === expectedGoalId
        ? Math.max(Math.floor((now - inner.wallClock.lastAccountedAt) / 1000), 0)
        : 0;
    if (timeDeltaSeconds === 0 && tokenDelta <= 0) return null;
    return {
      currentTokenUsage: turn.currentTokenUsage,
      currentDescendantTokenUsage,
      expectedGoalId,
      timeDeltaSeconds,
      tokenDelta,
    };
  }

  idleProgressSnapshot(now: number): IdleGoalProgressSnapshot | null {
    const inner = this.#inner;
    const expectedGoalId = inner.wallClock.activeGoalId;
    if (expectedGoalId === null) return null;
    const timeDeltaSeconds = Math.max(
      Math.floor((now - inner.wallClock.lastAccountedAt) / 1000),
      0,
    );
    const currentDescendantTokenUsage = this.#descendantTokenUsage;
    const tokenDelta = Math.max(
      currentDescendantTokenUsage - inner.lastAccountedDescendantTokenUsage,
      0,
    );
    if (timeDeltaSeconds === 0 && tokenDelta <= 0) return null;
    return {
      currentDescendantTokenUsage,
      expectedGoalId,
      timeDeltaSeconds,
      tokenDelta,
    };
  }

  markProgressAccountedForStatus(
    turnId: string,
    snapshot: GoalProgressSnapshot,
    status: string,
    disposition: BudgetLimitedGoalDisposition,
  ): void {
    const inner = this.#inner;
    const clearActive = shouldClearActiveGoal(status, disposition);
    const turn = inner.turns.get(turnId);
    if (turn) {
      turn.lastAccountedTokenUsage = snapshot.currentTokenUsage;
      if (clearActive) turn.activeGoalId = null;
    }
    inner.lastAccountedDescendantTokenUsage = snapshot.currentDescendantTokenUsage;
    inner.wallClock.lastAccountedAt += snapshot.timeDeltaSeconds * 1000;
    if (clearActive) inner.wallClock.activeGoalId = null;
    if (status !== "budget_limited") inner.budgetLimitReportedGoalId = null;
  }

  finishTurn(turnId: string): void {
    const inner = this.#inner;
    inner.turns.delete(turnId);
    if (inner.currentTurnId === turnId) inner.currentTurnId = null;
  }

  markIdleProgressAccountedForStatus(
    snapshot: IdleGoalProgressSnapshot,
    status: string,
    disposition: BudgetLimitedGoalDisposition,
  ): void {
    const inner = this.#inner;
    const clearActive = shouldClearActiveGoal(status, disposition);
    inner.lastAccountedDescendantTokenUsage = snapshot.currentDescendantTokenUsage;
    inner.wallClock.lastAccountedAt += snapshot.timeDeltaSeconds * 1000;
    if (clearActive) inner.wallClock.activeGoalId = null;
    if (status !== "budget_limited") inner.budgetLimitReportedGoalId = null;
  }

  resetIdleProgressBaselineAndClearActiveGoal(now: number): void {
    const inner = this.#inner;
    inner.wallClock.lastAccountedAt = now;
    inner.wallClock.activeGoalId = null;
    inner.budgetLimitReportedGoalId = null;
  }

  markBudgetLimitReportedIfNew(goalId: string): boolean {
    const inner = this.#inner;
    if (inner.budgetLimitReportedGoalId === goalId) return false;
    inner.budgetLimitReportedGoalId = goalId;
    return true;
  }
}

function tokenDeltaSinceLastAccounting(last: TokenUsage, current: TokenUsage): number {
  return goalTokenDeltaForUsage({
    inputTokens: Math.max(current.inputTokens - last.inputTokens, 0),
    cachedInputTokens: Math.max(current.cachedInputTokens - last.cachedInputTokens, 0),
    cacheWriteInputTokens: Math.max(
      current.cacheWriteInputTokens - last.cacheWriteInputTokens,
      0,
    ),
    outputTokens: Math.max(current.outputTokens - last.outputTokens, 0),
    reasoningOutputTokens: Math.max(
      current.reasoningOutputTokens - last.reasoningOutputTokens,
      0,
    ),
    totalTokens: Math.max(current.totalTokens - last.totalTokens, 0),
  });
}

function shouldClearActiveGoal(
  status: string,
  disposition: BudgetLimitedGoalDisposition,
): boolean {
  switch (status) {
    case "active":
      return false;
    case "budget_limited":
      return disposition === "clear_active";
    case "paused":
    case "blocked":
    case "usage_limited":
    case "complete":
      return true;
    default:
      return false;
  }
}
