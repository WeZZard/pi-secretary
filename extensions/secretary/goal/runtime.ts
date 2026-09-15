/**
 * GoalRuntime — turn lifecycle and accounting application for a thread.
 *
 * Adapts `codex-rs/ext/goal/src/runtime.rs` to pi's event loop. It owns the
 * per-thread `GoalAccountingState` and applies progress accounting between
 * turns, but leaves the actual "start idle continuation" and "inject active
 * steering" side effects to the host event-loop adapter via injected callbacks.
 */

import {
  type BudgetLimitedGoalDisposition,
  type GoalAccountingState,
  type TokenUsage,
} from "./accounting.ts";
import { type ThreadGoal, type ThreadGoalStatus } from "./goal-record.ts";
import { GoalService } from "./goal-service.ts";
import {
  budgetLimitPrompt as budgetLimitPromptRender,
  continuationPrompt as continuationPromptRender,
  objectiveUpdatedPrompt as objectiveUpdatedPromptRender,
} from "./steering.ts";

export type GoalAccountingMode = "active_only" | "active_or_complete" | "active_or_stopped";

export type ActiveGoalStopReason = "turn_error" | "usage_limit" | "empty_response";

export interface AccountedGoalProgress {
  goal: ThreadGoal;
  goalId: string;
}

export interface RuntimeCallbacks {
  /** Start an idle continuation turn with the rendered continuation prompt. */
  continueIfIdle?(prompt: string): void;
  /** Inject a steering fragment into the currently active turn. */
  injectSteering?(prompt: string): void;
  /** Whether goal tools/continuation are currently available for the thread. */
  toolsAvailable?(): boolean;
  /** Whether the host (pi) is currently idle — no turn is streaming. */
  isIdle?(): boolean;
}

const STOP_STATUS_BY_REASON: Record<ActiveGoalStopReason, ThreadGoalStatus> = {
  turn_error: "blocked",
  usage_limit: "usage_limited",
  empty_response: "blocked",
};

export class GoalRuntime {
  private readonly service: GoalService;
  private readonly accounting: GoalAccountingState;
  private readonly enabled: boolean;
  readonly threadId: string;
  callbacks: RuntimeCallbacks;
  /** True while a continuation turn has been requested but not yet admitted. */
  private pendingContinuation = false;
  /** Set when a continuation is admitted; the next started turn is automatic. */
  private nextTurnIsContinuation = false;

  constructor(
    threadId: string,
    service: GoalService,
    accounting: GoalAccountingState,
    callbacks: RuntimeCallbacks = {},
    enabled = true,
  ) {
    this.threadId = threadId;
    this.service = service;
    this.accounting = accounting;
    this.callbacks = callbacks;
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  threadIdOf(): string {
    return this.threadId;
  }

  accountingState(): GoalAccountingState {
    return this.accounting;
  }

  // ---- turn lifecycle --------------------------------------------------------

  startTurn(turnId: string, accountTokens: boolean, usageAtStart: TokenUsage): void {
    this.accounting.startTurn(turnId, accountTokens, usageAtStart);
    const goal = this.service.getGoal(this.threadId);
    if (goal?.status === "active") {
      this.accounting.markTurnGoalActive(turnId, goal.goalId);
    }
    // If this turn is an admitted automatic continuation, mark it so the
    // empty-response audit fires on it (Codex automatic-goal-turn tracking).
    if (this.nextTurnIsContinuation) {
      this.accounting.markGoalContinuation(turnId);
      this.nextTurnIsContinuation = false;
    }
  }

  /** Flag the next started turn as an automatic goal continuation (claim D). */
  markNextTurnAsContinuation(): void {
    this.nextTurnIsContinuation = true;
  }

  recordToolOutcome(
    turnId: string,
    toolName: string,
    outcome: { kind: "completed"; success: boolean } | { kind: "failed"; handlerExecuted: boolean },
  ): void {
    this.accounting.recordToolOutcome(turnId, toolName, outcome);
  }

  recordItem(turnId: string, item: { hasText?: boolean; phase?: string | null }): void {
    this.accounting.recordItem(turnId, item);
  }

  recordTokenUsage(turnId: string, usage: TokenUsage): void {
    this.accounting.recordTokenUsage(turnId, usage);
  }

  recordDescendantTokenUsage(usage: TokenUsage): void {
    this.accounting.recordDescendantTokenUsage(usage);
  }

  finishTurn(turnId: string): void {
    this.accounting.finishTurn(turnId);
  }

  // ---- accounting application ------------------------------------------------

  /** Account progress for the ending turn against the active goal. */
  accountActiveGoalProgress(
    turnId: string,
    reason: string,
    mode: GoalAccountingMode,
    disposition: BudgetLimitedGoalDisposition,
  ): AccountedGoalProgress | null {
    const snapshot = this.accounting.progressSnapshot(turnId, Date.now());
    if (!snapshot) return null;
    const previousStatus = this.service.getGoal(this.threadId)?.status;
    const outcome = this.service.accountGoalUsage(
      this.threadId,
      snapshot.timeDeltaSeconds,
      snapshot.tokenDelta,
      mode,
      snapshot.expectedGoalId,
    );
    if (!outcome) {
      this.accounting.resetIdleProgressBaselineAndClearActiveGoal(Date.now());
      return null;
    }
    this.accounting.markProgressAccountedForStatus(
      turnId,
      snapshot,
      outcome.status,
      disposition,
    );
    void previousStatus;
    return { goal: outcome, goalId: outcome.goalId };
  }

  /** Account idle (no active turn) progress against the active goal. */
  accountIdleGoalProgress(
    reason: string,
    mode: GoalAccountingMode,
    disposition: BudgetLimitedGoalDisposition,
  ): AccountedGoalProgress | null {
    const snapshot = this.accounting.idleProgressSnapshot(Date.now());
    if (!snapshot) {
      this.accounting.resetIdleProgressBaselineAndClearActiveGoal(Date.now());
      return null;
    }
    const outcome = this.service.accountGoalUsage(
      this.threadId,
      snapshot.timeDeltaSeconds,
      snapshot.tokenDelta,
      mode,
      snapshot.expectedGoalId,
    );
    if (!outcome) {
      this.accounting.resetIdleProgressBaselineAndClearActiveGoal(Date.now());
      return null;
    }
    this.accounting.markIdleProgressAccountedForStatus(snapshot, outcome.status, disposition);
    return { goal: outcome, goalId: outcome.goalId };
  }

  // ---- blocked / impasse audits ---------------------------------------------

  /** Non-consuming: true if the turn has hit the exec-failure blocked audit. */
  executionFailureBlocked(turnId: string): boolean {
    return this.accounting.peekExecutionFailureGoal(turnId) !== null;
  }

  /** Non-consuming: true if the turn has hit the empty-response blocked audit. */
  emptyResponseBlocked(turnId: string): boolean {
    return this.accounting.peekEmptyResponseGoal(turnId) !== null;
  }

  /**
   * Stop the active goal for a turn for the given reason. Returns the updated
   * goal, or null if the goal cannot/should not be stopped.
   */
  stopActiveGoalForTurn(turnId: string, reason: ActiveGoalStopReason): ThreadGoal | null {
    const accountingGoalId = this.accounting.currentActiveGoalIdForTurn(turnId);
    if (accountingGoalId === null) return null;

    let status: ThreadGoalStatus;
    let expectedGoalId: string | null = null;
    switch (reason) {
      case "turn_error":
        status = "blocked";
        break;
      case "usage_limit":
        status = "usage_limited";
        break;
      case "empty_response": {
        const emptyGoalId = this.accounting.emptyResponseGoal(turnId);
        if (emptyGoalId === null || emptyGoalId !== accountingGoalId) return null;
        status = "blocked";
        expectedGoalId = emptyGoalId;
        break;
      }
    }

    // Account the ending turn first.
    this.accountActiveGoalProgress(
      turnId,
      `${turnId}:${reason}-progress`,
      "active_only",
      "clear_active",
    );

    const activeGoal = this.service.getGoal(this.threadId);
    if (!activeGoal) {
      this.accounting.clearActiveGoal();
      return null;
    }
    if (expectedGoalId !== null && activeGoal.goalId !== expectedGoalId) return null;
    const canStop =
      activeGoal.status === "active" ||
      (activeGoal.status === "budget_limited" && status === "usage_limited");
    if (!canStop) {
      this.accounting.clearActiveGoal();
      return null;
    }
    const updated = this.service.stopActiveGoal(
      this.threadId,
      status,
      activeGoal.goalId,
    );
    this.pendingContinuation = false;
    this.accounting.clearActiveGoal();
    return updated;
  }

  // ---- continuation ----------------------------------------------------------

  /**
   * After an external set/create, decide whether to continue, stop, or inject
   * steering. Mirrors `apply_external_goal_set`.
   */
  applyExternalGoalSet(goal: ThreadGoal, previousGoal: ThreadGoal | null): void {
    if (!this.enabled) return;
    this.accounting.resetEmptyResponses();
    const replacedExistingGoal =
      previousGoal !== null && previousGoal.goalId !== goal.goalId;
    const previousStatus =
      previousGoal !== null && !replacedExistingGoal ? previousGoal.status : null;
    const objectiveChanged =
      previousGoal !== null && !replacedExistingGoal && previousGoal.objective !== goal.objective;

    switch (goal.status) {
      case "active": {
        if (this.accounting.currentTurnId() !== null) {
          this.accounting.markCurrentTurnGoalActive(goal.goalId);
        } else {
          this.accounting.markIdleGoalActive(goal.goalId);
        }
        if (objectiveChanged) {
          this.callbacks.injectSteering?.(this.objectiveUpdatedPrompt(goal));
        }
        this.tryContinueIfIdle();
        break;
      }
      case "budget_limited": {
        if (this.accounting.currentTurnId() === null) {
          this.accounting.clearActiveGoal();
        }
        break;
      }
      case "paused":
      case "blocked":
      case "usage_limited":
      case "complete":
        this.pendingContinuation = false;
        this.accounting.clearActiveGoal();
        break;
    }
    void previousStatus;
  }

  /**
   * Re-attempt idle continuation after a turn ends (host `agent_settled`).
   * Call whenever the host becomes idle and the goal may still be active.
   */
  attemptContinuationIfIdle(): void {
    if (!this.enabled) return;
    if (this.pendingContinuation) return;
    this.tryContinueIfIdle();
  }

  applyExternalGoalClear(): void {
    if (!this.enabled) return;
    this.pendingContinuation = false;
    this.accounting.clearActiveGoal();
  }

  /** Restore active goal accounting after a resume. */
  restoreAfterResume(): void {
    if (!this.enabled) return;
    const goal = this.service.getGoal(this.threadId);
    if (goal?.status === "active") {
      this.accounting.markIdleGoalActive(goal.goalId);
    } else {
      this.accounting.clearActiveGoal();
    }
  }

  /**
   * Decide whether to admit a continuation turn. Guards: tools available,
   * goal present and active, host idle (a turn is NOT already streaming), and
   * no continuation already pending for this thread (Codex's once-at-a-time
   * admission so repeated goal sets / edits don't enqueue duplicates).
   */
  private tryContinueIfIdle(): void {
    if (this.pendingContinuation) return;
    if (!(this.callbacks.toolsAvailable?.() ?? true)) {
      this.accounting.clearActiveGoal();
      return;
    }
    const goal = this.service.getGoal(this.threadId);
    if (!goal) {
      this.accounting.clearActiveGoal();
      return;
    }
    if (goal.status !== "active") {
      this.accounting.clearActiveGoal();
      return;
    }
    if (this.callbacks.isIdle !== undefined && !this.callbacks.isIdle()) {
      // A turn is streaming; don't queue a duplicate follow-up.
      return;
    }
    this.pendingContinuation = true;
    this.callbacks.continueIfIdle?.(this.continuationPrompt(goal));
  }

  /** Mark that the pending continuation was admitted (a turn started). */
  admitContinuation(): void {
    this.pendingContinuation = false;
  }

  /** Release the pending-continuation guard (e.g. continuation was dropped). */
  releaseContinuation(): void {
    this.pendingContinuation = false;
  }

  /** Whether a continuation is currently queued for this runtime. */
  hasPendingContinuation(): boolean {
    return this.pendingContinuation;
  }

  /**
   * Dispatch budget-limit steering, once per goal. Returns true if a steering
   * prompt was sent this call (i.e. this is the first time the goal crossed).
   */
  dispatchBudgetLimitSteering(goal: ThreadGoal): boolean {
    const first = this.accounting.markBudgetLimitReportedIfNew(goal.goalId);
    if (first) this.callbacks.injectSteering?.(this.budgetLimitPrompt(goal));
    return first;
  }

  // ---- steering prompts ------------------------------------------------------

  continuationPrompt(goal: ThreadGoal): string {
    return continuationPromptRender({
      objective: goal.objective,
      tokensUsed: goal.tokensUsed,
      tokenBudget: goal.tokenBudget,
      remainingTokens:
        goal.tokenBudget !== undefined
          ? Math.max(goal.tokenBudget - goal.tokensUsed, 0)
          : undefined,
    });
  }

  private objectiveUpdatedPrompt(goal: ThreadGoal): string {
    return objectiveUpdatedPromptRender({
      objective: goal.objective,
      tokensUsed: goal.tokensUsed,
      tokenBudget: goal.tokenBudget,
      remainingTokens:
        goal.tokenBudget !== undefined
          ? Math.max(goal.tokenBudget - goal.tokensUsed, 0)
          : undefined,
    });
  }

  budgetLimitPrompt(goal: ThreadGoal): string {
    return budgetLimitPromptRender({
      objective: goal.objective,
      tokensUsed: goal.tokensUsed,
      tokenBudget: goal.tokenBudget,
      timeUsedSeconds: goal.timeUsedSeconds,
    });
  }
}
