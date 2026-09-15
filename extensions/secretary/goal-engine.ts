/**
 * pi-secretary goal engine wiring.
 *
 * Wires the Codex-faithful goal engine (storage, service, runtime, tools,
 * accounting) into a pi extension: registers the three goal tools, hooks the
 * pi event loop for turn/accounting/blocked audits, and surfaces a dashboard
 * widget + status line. On shutdown it closes the SQLite handle.
 */

import { defineTool, type ExtensionAPI, type ExtensionContext, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GoalDb } from "./goal/storage/goal-db.ts";
import { GoalService } from "./goal/goal-service.ts";
import { GoalAccountingState } from "./goal/accounting.ts";
import { GoalRuntime } from "./goal/runtime.ts";
import {
  executeCreateGoal,
  executeGetGoal,
  executeUpdateGoal,
  GoalToolError,
} from "./goal/tools/goal-tool-executors.ts";

export interface GoalEngineOptions {
  /** Path to the SQLite database holding thread goals. */
  dbPath: string;
  /** Whether goal continuation/steering is enabled. */
  enabled?: boolean;
  /** Ceiling on a goal token budget; budgets above this are rejected. */
  maxGoalTokenBudget?: number;
}

/** Where the goal engine lives for a session. */
export interface GoalEngineContext {
  service: GoalService;
  accounting: GoalAccountingState;
  runtime: GoalRuntime;
  threadId: string | null;
}

export class GoalEngine {
  readonly db: GoalDb;
  readonly service: GoalService;
  /** Accounting state for the current/last-thread runtime (kept for the
   * single-thread common case and for tests that read `engine.accounting`).
   * Each runtime owns its own state for thread isolation (claim N). */
  accounting: GoalAccountingState;
  private readonly options: GoalEngineOptions;
  private readonly runtimes = new Map<string, GoalRuntime>();
  private threadId: string | null = null;

  constructor(options: GoalEngineOptions) {
    this.options = options;
    this.db = GoalDb.open(options.dbPath);
    this.service = new GoalService(this.db);
    this.accounting = new GoalAccountingState();
    this.service.onGoalUpdated((goal) => {
      this.onGoalChanged?.(goal);
    });
  }

  /** Close the SQLite handle. Idempotent. */
  close(): void {
    this.db.close();
  }

  /**
   * Dispose all thread runtimes (cancelling any pending continuation) and
   * clear the shared accounting pointer. Synchronous and idempotent.
   */
  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.releaseContinuation();
    }
    this.runtimes.clear();
    this.accounting = new GoalAccountingState();
  }

  /**
   * Copy the source thread's goal (snapshot) into `targetThreadId`, preserving
   * goal id, status, usage and timestamps (Codex fork inheritance via
   * `flush_thread_goal_progress_for_fork` / deferred deferral). Returns the
   * copied goal, or null if the source has no goal or the copy is rejected.
   */
  copyGoalToThread(sourceThreadId: string, targetThreadId: string): import("./goal/goal-record.ts").ThreadGoal | null {
    const source = this.service.getGoal(sourceThreadId);
    if (!source) return null;
    // Seed the target only if it has no unfinished goal.
    if (this.service.getGoal(targetThreadId) &&
        !Object.is(this.service.getGoal(targetThreadId)!.status, "complete")) {
      return null;
    }
    return this.db.replaceThreadGoal(
      targetThreadId,
      source.objective,
      source.status,
      source.tokenBudget,
    );
  }

  setThreadId(threadId: string | null): void {
    this.threadId = threadId;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  runtimeFor(threadId: string): GoalRuntime {
    let runtime = this.runtimes.get(threadId);
    if (!runtime) {
      // Per-thread accounting state (Codex creates accounting in the thread
      // store rather than sharing one across threads). This keeps interleaved
      // threads' turn baselines, wall-clock, descendant and audit counters from
      // colliding.
      const accounting = new GoalAccountingState();
      runtime = new GoalRuntime(threadId, this.service, accounting, {
        continueIfIdle: (prompt) => this.onContinueIfIdle?.(threadId, prompt),
        injectSteering: (prompt) => this.onInjectSteering?.(threadId, prompt),
        toolsAvailable: () => this.options.enabled !== false,
      });
      // Keep `engine.accounting` pointing at the most recent runtime's state so
      // a single-thread adapter (the common case) continues to read the right
      // state without changes.
      this.accounting = accounting;
      this.runtimes.set(threadId, runtime);
    }
    return runtime;
  }

  /** The configured ceiling on a goal token budget (claim L). */
  maxGoalTokenBudget(): number | undefined {
    return this.options.maxGoalTokenBudget;
  }

  /** Continuation side effect, injected by the host (pi) adapter. */
  onContinueIfIdle?: (threadId: string, prompt: string) => void;
  /** Steering side effect, injected by the host (pi) adapter. */
  onInjectSteering?: (threadId: string, prompt: string) => void;
  /** Called whenever the active goal changes, to update the TUI dashboard. */
  onGoalChanged?: (goal: import("./goal/goal-record.ts").ThreadGoal | null) => void;
}
