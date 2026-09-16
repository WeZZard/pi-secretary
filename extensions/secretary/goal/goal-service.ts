/** The synchronous, single-controller mutation boundary for thread goals. */
import { type ThreadGoal, type ThreadGoalStatus } from "./goal-record.ts";
import { GoalDb } from "./storage/goal-db.ts";
import { GoalOrdering, type GoalReceipt } from "./ordering.ts";

export type GoalMutationSource = "user" | "agent" | "system";
export type GoalContinuationEffect = "start_if_idle" | "stop" | "unchanged";
export interface GoalMutationOutcome {
  goal: ThreadGoal | null;
  previousGoal: ThreadGoal | null;
  effect: GoalContinuationEffect;
  steering?: "objective_updated" | "budget_limit" | "complete";
}
export type TerminalUpdateStatus = "complete" | "blocked" | "paused";
const TERMINAL_UPDATE_STATUSES: ReadonlySet<string> = new Set(["complete", "blocked", "paused"]);
export type GoalListener = (goal: ThreadGoal | null) => void;
export interface GoalVersion {
  sessionEpoch: string;
  revision: number;
  controlGeneration: number;
}
export type GoalStopCause = "impasse" | "run_error" | "empty_response" | "usage_limit";
export interface GoalChangedEvent extends GoalVersion {
  threadId: string;
  eventSeq: number;
  occurredAtMs: number;
  acceptedIntentSeq?: number;
  originIntentSeq?: number;
  source: GoalMutationSource;
  reason: "create" | "edit" | "status" | "clear" | "accounting" | "fork";
  previousGoal: ThreadGoal | null;
  goal: ThreadGoal | null;
  turnId?: string;
  stopCause?: GoalStopCause;
}
export type GoalChangedListener = (event: GoalChangedEvent) => void;

function sameControl(a: ThreadGoal | null, b: ThreadGoal | null): boolean {
  if (!a || !b) return a === b;
  return a.threadId === b.threadId && a.goalId === b.goalId &&
    a.objective === b.objective && a.status === b.status && a.tokenBudget === b.tokenBudget;
}
function sameState(a: ThreadGoal | null, b: ThreadGoal | null): boolean {
  return sameControl(a, b) && a?.tokensUsed === b?.tokensUsed &&
    a?.timeUsedSeconds === b?.timeUsedSeconds;
}
function snapshot(goal: ThreadGoal | null): ThreadGoal | null {
  return goal ? Object.freeze({ ...goal }) : null;
}

export class GoalService {
  public readonly ordering: GoalOrdering;
  private readonly intentListeners = new Set<(receipt: GoalReceipt) => void>();
  private readonly intentNotifications: GoalReceipt[] = [];
  private notifyingIntent = false;
  private readonly db: GoalDb;
  private readonly sessionEpoch: string;
  private readonly listeners = new Set<GoalListener>();
  private readonly changeListeners = new Set<GoalChangedListener>();
  private readonly changes = new Map<string, GoalChangedEvent>();
  private focused: string | null = null;
  public onListenerError?: (error: unknown) => void;
  public beforeGoalClear?: (threadId: string, expectedGoalId: string) => void;

  // DatabaseSync and all mutations below do not await. Reads, writes, and
  // publication form a synchronous critical section for a single controller.
  // SQL identity guards protect replacement; this is not a multi-writer lock.
  constructor(db: GoalDb, sessionEpoch: string = crypto.randomUUID(), clock: () => number = Date.now) {
    this.db = db;
    this.sessionEpoch = sessionEpoch;
    this.ordering = new GoalOrdering(sessionEpoch, clock);
  }

  onIntentAccepted(listener: (receipt: GoalReceipt) => void): () => void {
    this.intentListeners.add(listener);
    return () => this.intentListeners.delete(listener);
  }

  private decision<T>(threadId: string, source: GoalMutationSource, receipt: GoalReceipt | undefined,
    synthetic: boolean, operation: (receipt: GoalReceipt | undefined) => T): T {
    const decision = receipt ?? (source === "user" || synthetic
      ? this.ordering.receive(threadId, "command", this.getGoal(threadId)?.goalId ?? null) : undefined);
    try {
      if (decision) this.assertDecision(threadId, decision);
      return operation(decision);
    } finally {
      if (decision) this.ordering.resolve(decision);
      // State publication precedes external intent effects. Nested notifications
      // retain receipt order without allowing a callback to interrupt acceptance.
      if (!this.notifyingIntent) {
        this.notifyingIntent = true;
        try {
          let accepted: GoalReceipt | undefined;
          while ((accepted = this.intentNotifications.shift())) {
            const current = accepted;
            for (const listener of [...this.intentListeners]) this.notify(() => listener(current));
          }
        } finally { this.notifyingIntent = false; }
      }
    }
  }

  private assertDecision(threadId: string, receipt: GoalReceipt): void {
    if (receipt.threadId !== threadId) throw new Error("goal receipt belongs to a different thread");
    this.ordering.assertApplicable(receipt, this.getGoal(threadId)?.goalId ?? null);
  }

  private acceptDecision(receipt: GoalReceipt | undefined, resultingGoalId: string | null): number | undefined {
    if (!receipt) return undefined;
    if (this.ordering.accept(receipt, resultingGoalId)) this.intentNotifications.push(receipt);
    return receipt.sequence;
  }

  onGoalUpdated(listener: GoalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onGoalChanged(listener: GoalChangedListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  getVersion(threadId: string): GoalVersion {
    const change = this.changes.get(threadId);
    return { sessionEpoch: this.sessionEpoch, revision: change?.revision ?? 0,
      controlGeneration: change?.controlGeneration ?? 0 };
  }
  getLastChange(threadId: string): GoalChangedEvent | null {
    return this.changes.get(threadId) ?? null;
  }
  private notify(listener: () => void): void {
    try { listener(); } catch (error) {
      // Error reporting must not turn a committed mutation into a failed write.
      try { this.onListenerError?.(error); } catch { /* isolated observer */ }
    }
  }
  private emit(
    threadId: string, previousGoal: ThreadGoal | null, goal: ThreadGoal | null,
    source: GoalMutationSource, reason: GoalChangedEvent["reason"], stopCause?: GoalStopCause,
    acceptedIntentSeq?: number,
    originIntentSeq?: number,
  ): boolean {
    if (sameState(previousGoal, goal)) return false;
    const version = this.getVersion(threadId);
    const currentCause = stopCause ?? (sameControl(previousGoal, goal) ? this.changes.get(threadId)?.stopCause : undefined);
    const stamp = this.ordering.stamp(threadId);
    const event: GoalChangedEvent = Object.freeze({
      threadId, sessionEpoch: this.sessionEpoch, revision: version.revision + 1,
      eventSeq: stamp.sequence, occurredAtMs: stamp.occurredAtMs,
      ...(acceptedIntentSeq === undefined ? {} : { acceptedIntentSeq }),
      ...(originIntentSeq === undefined ? {} : { originIntentSeq }),
      controlGeneration: version.controlGeneration +
        (!sameControl(previousGoal, goal) || reason === "fork" || reason === "clear" ? 1 : 0),
      source, reason, previousGoal: snapshot(previousGoal), goal: snapshot(goal),
      ...(currentCause === undefined ? {} : { stopCause: currentCause }),
    });
    this.changes.set(threadId, event);
    for (const listener of [...this.changeListeners]) this.notify(() => listener(event));
    for (const listener of [...this.listeners]) this.notify(() => listener(event.goal));
    return true;
  }

  getGoal(threadId: string): ThreadGoal | null { return this.db.getThreadGoal(threadId); }
  getFocusedThreadId(): string | null { return this.focused; }
  setFocusedThreadId(threadId: string | null): void { this.focused = threadId; }

  createGoal(threadId: string, objective: string, tokenBudget?: number,
    source: GoalMutationSource = "agent", receipt?: GoalReceipt): GoalMutationOutcome {
    return this.decision(threadId, source, receipt, source === "agent", (decision) => {
    const previous = this.getGoal(threadId);
    const goal = this.db.insertThreadGoal(threadId, objective, "active", tokenBudget);
    if (!goal) throw new Error("cannot create a new goal because this thread has an unfinished goal; complete the existing goal first");
    this.focused = threadId;
    const acceptedIntentSeq = this.acceptDecision(decision, goal.goalId);
    this.emit(threadId, previous, goal, source, "create", undefined, acceptedIntentSeq);
    return { goal, previousGoal: previous, effect: goal.status === "active" ? "start_if_idle" : "stop",
      steering: goal.status === "budget_limited" ? "budget_limit" : undefined };
    });
  }

  /** Import a fork snapshot verbatim except for its target thread identity. */
  importGoal(sourceGoal: ThreadGoal, targetThreadId: string): ThreadGoal | null {
    const previous = this.getGoal(targetThreadId);
    const goal = this.db.importThreadGoal(sourceGoal, targetThreadId);
    if (!goal) return null;
    this.emit(targetThreadId, previous, goal, "system", "fork");
    return goal;
  }

  /** Objective-only edits preserve status; reactivation requires explicit active. */
  setGoal(threadId: string,
    request: { objective?: string; status?: ThreadGoalStatus; tokenBudget?: number | null },
    source: GoalMutationSource, receipt?: GoalReceipt): GoalMutationOutcome {
    return this.decision(threadId, source, receipt, false, (decision) => {
    const previous = this.getGoal(threadId);
    const goal = this.db.updateThreadGoal(threadId, { ...request, expectedGoalId: previous?.goalId });
    if (!goal) throw new Error("cannot update goal: no goal exists or version changed");
    const reason = request.objective !== undefined || request.tokenBudget !== undefined ? "edit" : "status";
    const acceptedIntentSeq = this.acceptDecision(decision, goal.goalId);
    const changed = this.emit(threadId, previous, goal, source, reason, undefined, acceptedIntentSeq);
    return { goal, previousGoal: previous,
      effect: changed ? (goal.status === "active" ? "start_if_idle" : "stop") : "unchanged",
      steering: !changed ? undefined : request.objective !== undefined && goal.status === "active"
        ? "objective_updated" : goal.status === "budget_limited" ? "budget_limit" : undefined };
    });
  }

  clearGoal(threadId: string, source: GoalMutationSource, expectedGoalId?: string,
    receipt?: GoalReceipt): GoalMutationOutcome {
    return this.decision(threadId, source, receipt, false, (decision) => {
    let previous = this.getGoal(threadId);
    if (!previous || (expectedGoalId !== undefined && previous.goalId !== expectedGoalId)) {
      return { goal: previous, previousGoal: previous, effect: "unchanged" };
    }
    const goalId = previous.goalId;
    // The runtime checkpoints available usage synchronously before deletion.
    // A failed checkpoint propagates without deleting the goal.
    this.beforeGoalClear?.(threadId, goalId);
    previous = this.getGoal(threadId);
    if (!previous || previous.goalId !== goalId) {
      return { goal: previous, previousGoal: previous, effect: "unchanged" };
    }
    if (decision) this.assertDecision(threadId, decision);
    const deleted = this.db.deleteThreadGoal(threadId, goalId);
    if (!deleted) {
      const goal = this.getGoal(threadId);
      return { goal, previousGoal: previous, effect: "unchanged" };
    }
    const acceptedIntentSeq = this.acceptDecision(decision, null);
    this.emit(threadId, deleted, null, source, "clear", undefined, acceptedIntentSeq);
    return { goal: null, previousGoal: deleted, effect: "stop" };
    });
  }

  requestTerminalUpdate(threadId: string, status: TerminalUpdateStatus,
    source: GoalMutationSource, expectedGoalId?: string, receipt?: GoalReceipt, originIntentSeq?: number): GoalMutationOutcome {
    return this.decision(threadId, source, receipt, false, (decision) => {
    if (originIntentSeq !== undefined && originIntentSeq !== this.ordering.intentSeq(threadId)) throw new Error("goal result was superseded by a newer intent");
    if (!TERMINAL_UPDATE_STATUSES.has(status)) throw new Error(
      "update_goal can only mark the existing goal complete, blocked, or paused at the user's explicit request");
    const previous = this.getGoal(threadId);
    if (!previous) throw new Error("cannot update goal: no goal exists");
    if (expectedGoalId !== undefined && previous.goalId !== expectedGoalId) throw new Error("cannot update goal: version changed");
    const goal = this.db.updateThreadGoal(threadId, { status, expectedGoalId: expectedGoalId ?? previous.goalId });
    if (!goal) throw new Error("cannot update goal: version changed");
    const acceptedIntentSeq = source === "user" || (source === "agent" && status === "paused")
      ? this.acceptDecision(decision, goal.goalId) : undefined;
    const changed = this.emit(threadId, previous, goal, source, "status",
      source === "agent" && goal.status === "blocked" ? "impasse" : undefined, acceptedIntentSeq, originIntentSeq);
    return { goal, previousGoal: previous, effect: changed ? "stop" : "unchanged",
      steering: changed && goal.status === "complete" ? "complete" : undefined };
    });
  }

  accountGoalUsage(threadId: string, timeDeltaSeconds: number, tokenDelta: number,
    mode: "active_only" | "active_or_complete" | "active_or_stopped", expectedGoalId?: string): ThreadGoal | null {
    const previous = this.getGoal(threadId);
    const outcome = this.db.accountThreadGoalUsage(threadId, timeDeltaSeconds, tokenDelta, mode, expectedGoalId);
    if (outcome.kind === "unchanged") return null;
    this.emit(threadId, previous, outcome.goal, "system", "accounting");
    return outcome.goal;
  }

  stopActiveGoal(threadId: string, status: "blocked" | "usage_limited" | "complete" | "paused",
    expectedGoalId?: string, stopCause?: GoalStopCause, originIntentSeq?: number): ThreadGoal | null {
    if (originIntentSeq !== undefined && originIntentSeq !== this.ordering.intentSeq(threadId)) return null;
    const previous = this.getGoal(threadId);
    if (!previous || (expectedGoalId !== undefined && previous.goalId !== expectedGoalId)) return null;
    const goal = this.db.updateThreadGoal(threadId, { status, expectedGoalId: expectedGoalId ?? previous.goalId });
    if (!goal) return null;
    this.emit(threadId, previous, goal, "system", "status", stopCause, undefined, originIntentSeq);
    return goal;
  }
}
export { TERMINAL_UPDATE_STATUSES };
