export interface GoalStamp {
  threadId: string;
  sessionEpoch: string;
  sequence: number;
  occurredAtMs: number;
}
export interface GoalPublication extends GoalStamp {
  goalId: string | null;
  revision: number;
  controlGeneration: number;
}
export interface GoalReceipt extends GoalStamp {
  kind: "input" | "command" | "dialog";
  goalId: string | null;
  basisIntentSeq: number;
  basisControlGeneration?: number;
  publication?: GoalPublication;
}

/** Controller-local ordering; wall-clock values are diagnostic only. */
export class GoalOrdering {
  private sequence = 0;
  private readonly pending = new Set<GoalReceipt>();
  private readonly owned = new WeakMap<GoalReceipt, { accepted: boolean; target: string | null }>();
  private readonly intents = new Map<string, number>();
  private readonly publications = new Map<string, GoalPublication>();

  public readonly sessionEpoch: string;
  private readonly clock: () => number;

  constructor(sessionEpoch: string = crypto.randomUUID(), clock: () => number = Date.now) {
    this.sessionEpoch = sessionEpoch;
    this.clock = clock;
  }

  stamp(threadId: string): GoalStamp {
    return Object.freeze({ threadId, sessionEpoch: this.sessionEpoch,
      sequence: ++this.sequence, occurredAtMs: this.clock() });
  }
  receive(threadId: string, kind: GoalReceipt["kind"], goalId: string | null, controlGeneration?: number): GoalReceipt {
    const publication = this.publication(threadId);
    const receipt: GoalReceipt = Object.freeze({ ...this.stamp(threadId), kind, goalId,
      basisIntentSeq: this.intentSeq(threadId), basisControlGeneration: controlGeneration ?? publication?.controlGeneration,
      ...(publication ? { publication } : {}) });
    this.pending.add(receipt);
    this.owned.set(receipt, { accepted: false, target: goalId });
    return receipt;
  }
  resolve(receipt: GoalReceipt): void { this.pending.delete(receipt); }
  hasPending(threadId: string): boolean {
    return [...this.pending].some((receipt) => receipt.threadId === threadId);
  }
  intentSeq(threadId: string): number { return this.intents.get(threadId) ?? 0; }
  publish(threadId: string, goalId: string | null, revision: number,
    controlGeneration: number): GoalPublication {
    const publication = Object.freeze({ ...this.stamp(threadId), goalId, revision, controlGeneration });
    this.publications.set(threadId, publication);
    return publication;
  }
  publication(threadId: string): GoalPublication | undefined { return this.publications.get(threadId); }
  clearPublication(threadId: string): void { this.publications.delete(threadId); }

  private assertOwned(receipt: GoalReceipt): { accepted: boolean; target: string | null } {
    const state = this.owned.get(receipt);
    if (receipt.sessionEpoch !== this.sessionEpoch || !state) {
      throw new Error("goal receipt is not pending or accepted in this thread/session epoch");
    }
    if (receipt.sequence < this.intentSeq(receipt.threadId)) {
      throw new Error("goal receipt is older than the latest accepted intent");
    }
    if (!state.accepted && !this.pending.has(receipt)) throw new Error("goal receipt is not pending or accepted");
    return state;
  }
  assertApplicable(receipt: GoalReceipt, currentGoalId: string | null): void {
    const state = this.assertOwned(receipt);
    if (state.target !== currentGoalId) throw new Error("goal receipt target changed");
  }
  accept(receipt: GoalReceipt, resultingGoalId?: string | null): boolean {
    const state = this.assertOwned(receipt);
    const newlyAccepted = !state.accepted;
    state.accepted = true;
    if (resultingGoalId !== undefined) state.target = resultingGoalId;
    this.intents.set(receipt.threadId, receipt.sequence);
    this.resolve(receipt);
    // Older input can still be answered, but can no longer change authorization.
    // Releasing this hold never removes messages from Pi's user queue.
    for (const pending of this.pending) {
      if (pending.threadId === receipt.threadId && pending.sequence < receipt.sequence) this.pending.delete(pending);
    }
    return newlyAccepted;
  }
}
