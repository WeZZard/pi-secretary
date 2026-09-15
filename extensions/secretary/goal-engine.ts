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
  readonly accounting: GoalAccountingState;
  private readonly options: GoalEngineOptions;
  private readonly runtimes = new Map<string, GoalRuntime>();
  private threadId: string | null = null;

  constructor(options: GoalEngineOptions) {
    this.options = options;
    this.db = GoalDb.open(options.dbPath);
    this.service = new GoalService(this.db);
    this.accounting = new GoalAccountingState();
  }

  close(): void {
    this.db.close();
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
      runtime = new GoalRuntime(threadId, this.service, this.accounting, {
        continueIfIdle: (prompt) => this.onContinueIfIdle?.(threadId, prompt),
        injectSteering: (prompt) => this.onInjectSteering?.(threadId, prompt),
        toolsAvailable: () => this.options.enabled !== false,
      });
      this.runtimes.set(threadId, runtime);
    }
    return runtime;
  }

  /** Continuation side effect, injected by the host (pi) adapter. */
  onContinueIfIdle?: (threadId: string, prompt: string) => void;
  /** Steering side effect, injected by the host (pi) adapter. */
  onInjectSteering?: (threadId: string, prompt: string) => void;
}
