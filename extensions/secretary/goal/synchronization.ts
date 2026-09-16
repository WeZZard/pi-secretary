import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalEngine } from "../goal-engine.ts";
import type { registerGoalUI } from "../goal-ui.ts";
import type { GoalChangedEvent } from "./goal-service.ts";
import type { GoalReceipt } from "./ordering.ts";
import { CURRENT_GOAL_POLICY, formatGoalSnapshot, objectiveUpdatedPrompt } from "./steering.ts";

export const SNAPSHOT_TYPE = "secretary:goal-state";
export const AUTOMATIC_TYPE = "secretary:goal-automatic";
const BUDGET_RECORD = "secretary:budget-wrap";
export type AutomaticKind = "continuation" | "budget_wrap_up";
export interface WorkBasis {
  threadId: string;
  sessionEpoch: string;
  goalId: string | null;
  intentSeq: number;
  controlGeneration: number;
  receipt?: GoalReceipt;
  automatic?: AutomaticRequest;
  unresolvedInput?: boolean;
  unresolvedAutomatic?: boolean;
}
export interface AutomaticRequest {
  requestId: string;
  threadId: string;
  sessionEpoch: string;
  goalId: string;
  intentSeq: number;
  controlGeneration: number;
  dispatchSeq: number;
  kind: AutomaticKind;
  outcome?: string;
  observed?: boolean;
}
interface InputRecord { receipt: GoalReceipt; text: string; expanded?: string; key?: string }
interface BudgetRecord { threadId: string; goalId: string; budget?: number; state: "ready" | "dispatched" | "settled" | "reset"; requestId?: string }
type UI = ReturnType<typeof registerGoalUI>;
type Message = ContextEvent["messages"][number];
export function threadIdFor(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
}
function userText(message: Message): string | undefined {
  if (message.role !== "user") return undefined;
  return typeof message.content === "string" ? message.content
    : message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

/** Single-controller ordering: dispatch is synchronous; stale work is reconciled, not aborted. */
export class GoalSynchronization {
  private readonly pi: ExtensionAPI;
  private readonly engine: GoalEngine;
  private readonly ui: UI;
  private readonly unsubscribe: Array<() => void>;
  private ctx?: ExtensionContext;
  private threadId?: string;
  private timer?: ReturnType<typeof setImmediate>;
  private disposed = false;
  private suspended = false;
  private uncertain = false;
  private dispatched?: AutomaticRequest;
  private objectiveGeneration?: number;
  private readonly revisions = new Map<string, number>();
  private readonly inputs: InputRecord[] = [];
  private readonly seenInputs = new Set<GoalReceipt>();
  private readonly knownUsers = new Set<string>();
  private readonly turns = new Map<string, WorkBasis>();
  private currentTurn?: string;
  private budget?: BudgetRecord;

  constructor(pi: ExtensionAPI, engine: GoalEngine, ui: UI) {
    this.pi = pi; this.engine = engine; this.ui = ui;
    this.unsubscribe = [
      engine.service.onGoalChanged((event) => this.changed(event)),
      engine.service.onIntentAccepted((receipt) => {
        if (receipt.threadId !== this.threadId || receipt.sequence !== engine.service.ordering.intentSeq(receipt.threadId)) return;
        if (!this.uncertain) this.suspended = false;
        this.engine.runtimeFor(receipt.threadId).accountingState().resetFailureAudit();
        this.cancelTimer();
        this.requestAutomatic();
      }),
    ];
    engine.service.onListenerError = (error) => this.diagnostic(error);
    engine.onContinueIfIdle = () => this.requestAutomatic();
    engine.onInjectSteering = () => {};
    engine.hostIsIdle = () => !!this.ctx?.isIdle() && !this.ctx.hasPendingMessages();
    engine.hostToolsAvailable = () => this.toolsAvailable();
  }

  bind(ctx: ExtensionContext): void {
    if (this.disposed) return;
    const threadId = threadIdFor(ctx);
    if (this.threadId !== threadId) {
      this.cancelTimer(); this.dispatched = undefined; this.budget = undefined;
      this.objectiveGeneration = undefined; this.suspended = false; this.uncertain = false;
      this.currentTurn = undefined; this.turns.clear();
      for (const input of this.inputs) this.engine.service.ordering.resolve(input.receipt);
      this.inputs.length = 0; this.seenInputs.clear(); this.knownUsers.clear();
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "message" && entry.message.role === "user") {
          this.knownUsers.add(JSON.stringify([entry.message.timestamp, entry.message.content]));
        }
      }
      this.threadId = threadId;
    }
    this.ctx = ctx;
    this.engine.setThreadId(threadId);
    this.ui.bind(ctx);
    this.refresh();
  }

  private toolsAvailable(): boolean {
    return ["get_goal", "create_goal", "update_goal"].every((name) => this.pi.getActiveTools().includes(name));
  }
  private diagnostic(error: unknown): void {
    try { if (this.ctx?.hasUI) this.ctx.ui.notify(`Goal synchronization: ${String(error)}`, "error"); } catch { /* isolated UI */ }
  }
  private unavailable(): void { try { this.ui.unavailable(); } catch (error) { this.diagnostic(error); } }
  refresh(): void {
    try {
      this.ui.refresh();
      if (this.ctx?.hasUI && this.threadId) {
        const goal = this.engine.service.getGoal(this.threadId);
        const v = this.engine.service.getVersion(this.threadId);
        this.engine.service.ordering.publish(this.threadId, goal?.goalId ?? null, v.revision, v.controlGeneration);
      } else if (this.threadId) this.engine.service.ordering.clearPublication(this.threadId);
    } catch (error) {
      if (this.threadId) this.engine.service.ordering.clearPublication(this.threadId);
      this.unavailable(); this.diagnostic(error);
    }
  }

  private changed(event: GoalChangedEvent): void {
    if (this.disposed || event.threadId !== this.threadId || event.revision <= (this.revisions.get(event.threadId) ?? -1)) return;
    this.revisions.set(event.threadId, event.revision);
    if (event.previousGoal && event.goal && event.previousGoal.objective !== event.goal.objective) this.objectiveGeneration = event.controlGeneration;
    if (event.goal?.status !== "budget_limited") {
      if (this.budget && this.budget.state !== "reset") this.recordBudget({ ...this.budget, state: "reset" });
    } else if (event.previousGoal?.status !== "budget_limited" || event.previousGoal.goalId !== event.goal.goalId || event.previousGoal.tokenBudget !== event.goal.tokenBudget) {
      this.recordBudget({ threadId: event.threadId, goalId: event.goal.goalId, budget: event.goal.tokenBudget, state: "ready" });
    }
    this.refresh(); this.requestAutomatic();
  }

  receiveInput(text: string, ctx: ExtensionContext): GoalReceipt {
    // Commands use their own entry route; this handles ordinary user messages only.
    const threadId = threadIdFor(ctx);
    if (!ctx.hasUI) this.engine.service.ordering.clearPublication(threadId);
    const receipt = this.engine.service.ordering.receive(threadId, "input", this.engine.service.getGoal(threadId)?.goalId ?? null,
      this.engine.service.getVersion(threadId).controlGeneration);
    // Capture the publication that preceded receipt, not a repaint caused by input.
    this.bind(ctx);
    this.inputs.push({ text, receipt }); this.cancelTimer();
    return receipt;
  }
  expandedInput(prompt: string): void {
    const candidates = this.inputs.filter((r) => !r.key && !r.expanded);
    const exact = candidates.filter((r) => r.text === prompt);
    if (exact.length === 1) exact[0]!.expanded = prompt;
    else if (candidates.length === 1) candidates[0]!.expanded = prompt;
  }
  /** Bind only at actual user-message ingestion, never while scanning historical context. */
  observeUserMessage(message: Message): void {
    if (message.role !== "user") return;
    const key = JSON.stringify([message.timestamp, message.content]);
    if (this.knownUsers.has(key)) return;
    this.knownUsers.add(key);
    const text = userText(message);
    const candidates = this.inputs.filter((r) => !r.key && (r.text === text || r.expanded === text));
    if (candidates.length === 1) candidates[0]!.key = key;
  }
  private receiptFor(message: Message): GoalReceipt | undefined {
    if (message.role !== "user") return undefined;
    const key = JSON.stringify([message.timestamp, message.content]);
    const input = this.inputs.find((r) => r.key === key);
    if (input) this.seenInputs.add(input.receipt);
    return input?.receipt;
  }

  capture(): WorkBasis {
    const threadId = this.threadId!;
    const version = this.engine.service.getVersion(threadId);
    return { threadId, sessionEpoch: version.sessionEpoch, goalId: this.engine.service.getGoal(threadId)?.goalId ?? null,
      intentSeq: this.engine.service.ordering.intentSeq(threadId), controlGeneration: version.controlGeneration };
  }
  beginTurn(turnId: string, ctx: ExtensionContext): void {
    this.bind(ctx); this.currentTurn = turnId; this.turns.set(turnId, this.capture());
  }
  work(turnId?: string): WorkBasis | undefined { return this.turns.get(turnId ?? this.currentTurn ?? ""); }
  finishTurn(turnId: string): void { this.turns.delete(turnId); if (this.currentTurn === turnId) this.currentTurn = undefined; }
  isCurrent(work: WorkBasis): boolean {
    if (this.disposed || work.threadId !== this.threadId || work.unresolvedInput) return false;
    const current = this.capture();
    return current.sessionEpoch === work.sessionEpoch && current.goalId === work.goalId &&
      current.intentSeq === work.intentSeq && current.controlGeneration === work.controlGeneration;
  }
  assertCurrent(work = this.work()): void {
    if (work && !this.isCurrent(work)) throw new Error("Goal work was superseded by a newer decision or state. Read get_goal; do not apply the old result.");
  }
  userDecision(work = this.work()): GoalReceipt | undefined {
    if (!work) return undefined; // Direct tool-executor tests have no producing model request.
    if (work.unresolvedInput || work.automatic) throw new Error("This request cannot establish a new user goal decision.");
    if (work.receipt) {
      this.engine.service.ordering.assertApplicable(work.receipt, this.engine.service.getGoal(work.threadId)?.goalId ?? null);
      return work.receipt;
    }
    this.assertCurrent(work);
    return undefined;
  }

  private requestIsCurrent(request: AutomaticRequest): boolean {
    return this.isCurrent(request) && this.engine.service.getGoal(request.threadId)?.status ===
      (request.kind === "continuation" ? "active" : "budget_limited");
  }
  suspendAutomatic(): void { this.suspended = true; this.cancelTimer(); }
  private recordBudget(record: BudgetRecord): void {
    this.budget = record;
    if (this.ctx && !this.disposed) this.pi.appendEntry(BUDGET_RECORD, record);
  }
  private budgetReady(goalId: string, budget?: number): boolean {
    if (!this.budget) {
      const entries = this.ctx?.sessionManager.getBranch() ?? [];
      for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === BUDGET_RECORD) {
          const data = entry.data as BudgetRecord | undefined;
          if (data?.threadId === this.threadId) this.budget = data;
        }
      }
    }
    if (!this.budget || this.budget.goalId !== goalId || this.budget.budget !== budget || this.budget.state === "reset") {
      this.recordBudget({ threadId: this.threadId!, goalId, budget, state: "ready" });
    }
    return this.budget?.state === "ready";
  }

  /** Only local intent is held while busy. Check and submit synchronously in one event-loop step. */
  requestAutomatic(): void {
    if (this.disposed || !this.ctx || this.timer || this.dispatched || this.suspended || this.uncertain) return;
    this.timer = setImmediate(() => {
      this.timer = undefined;
      if (this.disposed || !this.ctx || this.dispatched || this.suspended || this.uncertain) return;
      let submitted = false;
      try {
        const threadId = this.threadId!;
        if (!this.ctx.isIdle() || this.ctx.hasPendingMessages() || this.engine.service.ordering.hasPending(threadId) || !this.toolsAvailable()) return;
        const goal = this.engine.service.getGoal(threadId);
        if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return;
        const kind: AutomaticKind = goal.status === "active" ? "continuation" : "budget_wrap_up";
        if (kind === "budget_wrap_up" && !this.budgetReady(goal.goalId, goal.tokenBudget)) return;
        const basis = this.capture();
        const request: AutomaticRequest = { ...basis, goalId: goal.goalId, requestId: crypto.randomUUID(), kind,
          dispatchSeq: this.engine.service.ordering.stamp(threadId).sequence };
        if (!this.requestIsCurrent(request)) return;
        this.dispatched = request;
        if (kind === "budget_wrap_up") this.recordBudget({ threadId, goalId: goal.goalId, budget: goal.tokenBudget, state: "dispatched", requestId: request.requestId });
        submitted = true;
        this.pi.sendMessage({ customType: AUTOMATIC_TYPE, content: "Scheduled goal wake-up. Use the current goal state and instruction at the request boundary, not this historical marker.",
          display: false, details: { ...request } }, { triggerTurn: true });
      } catch (error) {
        // The void sendMessage API cannot prove whether a thrown/async failure executed work.
        // Never replay an uncertain dispatch merely because a timer fired again.
        this.uncertain = submitted; this.suspended = true;
        if (!submitted) this.dispatched = undefined;
        this.diagnostic(error);
      }
    });
  }

  context(event: ContextEvent, ctx: ExtensionContext): ContextEvent["messages"] {
    this.bind(ctx);
    const messages = event.messages.filter((message) => !(message.role === "custom" &&
      [SNAPSHOT_TYPE, AUTOMATIC_TYPE, "secretary:goal", "secretary:goal-objective"].includes(message.customType)));
    let content: string;
    try {
      const goal = this.engine.service.getGoal(this.threadId!);
      const version = this.engine.service.getVersion(this.threadId!);
      const last = this.engine.service.getLastChange(this.threadId!);
      content = `${CURRENT_GOAL_POLICY}\n\n${formatGoalSnapshot(goal, last?.stopCause)}\nAccepted intent sequence: ${this.engine.service.ordering.intentSeq(this.threadId!)}.`;
      let basis = this.capture();
      // Actual message ordering, not latest global input, identifies the request's source.
      let source: Message | undefined;
      for (const message of event.messages) {
        if (message.role === "user") { this.receiptFor(message); source = message; }
        if (message.role === "custom" && [AUTOMATIC_TYPE, "secretary:goal"].includes(message.customType)) source = message;
      }
      if (source?.role === "user") {
        basis.receipt = this.receiptFor(source);
        if (basis.receipt && basis.receipt.sequence !== this.engine.service.ordering.intentSeq(this.threadId!)) {
          // Delayed input does not acquire the authority of state published while it waited.
          basis.goalId = basis.receipt.goalId;
          basis.intentSeq = basis.receipt.basisIntentSeq;
          basis.controlGeneration = basis.receipt.basisControlGeneration ?? basis.controlGeneration;
        }
        basis.unresolvedInput = !basis.receipt;
        if (basis.unresolvedInput) content += "\nInput provenance is unresolved. Do not change the goal from this request; ask for an explicit /goal command if a change is required.";
      } else if (source?.role === "custom") {
        const marker = source.details as AutomaticRequest | undefined;
        if (marker?.requestId === this.dispatched?.requestId) {
          const request = this.dispatched!;
          basis = { ...request, automatic: request };
          const runtime = this.engine.runtimeFor(this.threadId!);
          const turnId = runtime.accountingState().currentTurnId();
          // Even a superseded request can consume a final response. Attribute that
          // fact to its original goal, never to a replacement or unrelated user turn.
          if (turnId) runtime.accountingState().markTurnGoalActive(turnId, request.goalId);
          if (this.requestIsCurrent(request)) {
            request.observed = true; // The authorized instruction, not just its marker, was supplied.
            runtime.admitContinuation();
            if (turnId && request.kind === "continuation") runtime.accountingState().markGoalContinuation(turnId);
            content += `\n\n${request.kind === "continuation" ? runtime.continuationPrompt(goal!) : runtime.budgetLimitPrompt(goal!)}`;
          } else content += "\nThis wake-up was superseded. Do not start goal actions, change goal status, or schedule more work from it. Already-started work is historical; the current state above governs subsequent work.";
        } else {
          basis.unresolvedInput = true;
          basis.unresolvedAutomatic = true;
          content += "\nThis historical automatic request is not authorized for replay. Report current state only; do not start goal actions.";
        }
      }
      if (goal?.status === "active" && this.objectiveGeneration === version.controlGeneration && !basis.automatic) {
        content += `\n\n${objectiveUpdatedPrompt(goal)}`; this.objectiveGeneration = undefined;
      }
      const accounting = this.engine.runtimeFor(this.threadId!).accountingState();
      if (basis.unresolvedInput || basis.goalId === null) accounting.clearCurrentTurnGoal();
      else if (this.currentTurn && basis.goalId !== goal?.goalId) accounting.markTurnGoalActive(this.currentTurn, basis.goalId);
      if (this.currentTurn) this.turns.set(this.currentTurn, basis);
    } catch (error) {
      this.suspendAutomatic(); this.unavailable(); this.diagnostic(error);
      const work = this.work(); if (work) work.unresolvedInput = true;
      content = `${CURRENT_GOAL_POLICY}\n\nCurrent goal state could not be read. Do not treat old state as current or infer that the goal was cleared. No automatic goal work is authorized.`;
    }
    messages.push({ role: "custom", customType: SNAPSHOT_TYPE, content, display: false, timestamp: Date.now() });
    return messages;
  }

  noteResult(work: WorkBasis | undefined, outcome: string): void {
    if (this.dispatched && work?.automatic?.requestId === this.dispatched.requestId) this.dispatched.outcome = outcome;
  }
  settled(): void {
    for (const receipt of this.seenInputs) this.engine.service.ordering.resolve(receipt);
    this.seenInputs.clear();
    if (this.dispatched?.kind === "budget_wrap_up" && this.budget?.requestId === this.dispatched.requestId) {
      // A user message may have overtaken the wake-up before it supplied any goal
      // instruction. That is not delivery of a budget summary; reassess it once idle.
      const state = this.dispatched.observed ? "settled" : "ready";
      this.recordBudget({ ...this.budget, state });
    }
    this.dispatched = undefined;
    this.engine.runtimeFor(this.threadId!).releaseContinuation();
    this.requestAutomatic();
  }
  private cancelTimer(): void { if (this.timer) clearImmediate(this.timer); this.timer = undefined; }
  dispose(): void {
    this.disposed = true; this.cancelTimer();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    for (const input of this.inputs) this.engine.service.ordering.resolve(input.receipt);
    this.ui.dispose(); this.ctx = undefined; this.dispatched = undefined; this.turns.clear();
  }
}
