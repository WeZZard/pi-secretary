import type { TokenUsage } from "../goal/accounting.ts";

export type RunStatus = "queued" | "starting" | "running" | "cancelling" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted";
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "partial", "failed", "cancelled", "interrupted"]);
export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  source: string;
  hash: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  background?: boolean;
  isolation?: "worktree";
  resumable: boolean;
}
export interface GoalOrigin {
  threadId: string;
  sessionEpoch: string;
  goalId: string;
  intentSeq: number;
  controlGeneration: number;
}
export interface WorktreeRecord {
  id: string;
  repo: string;
  path: string;
  branch: string;
  baseCommit: string;
  state: "allocated" | "cleaning" | "removed" | "uncertain";
}
export interface AgentRecord {
  agentId: string;
  parentId: string;
  name?: string;
  definition: AgentDefinition;
  model: string;
  thinkingLevel?: string;
  tools: string[];
  cwd: string;
  configCwd: string;
  sessionPath?: string;
  worktree?: WorktreeRecord;
  requestedWorktree?: { repo: string; baseCommit: string };
  resumable: boolean;
  createdAt: number;
}
export interface AgentRun {
  runId: string;
  agentId: string;
  parentId: string;
  launchKey: string;
  prompt: string;
  description: string;
  status: RunStatus;
  background: boolean;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outputPath: string;
  output: string;
  error?: string;
  goal?: GoalOrigin;
  toolCount: number;
  turnCount: number;
  activity?: string;
  revision: number;
}
export interface GuidanceRecord {
  id: string;
  runId: string;
  text: string;
  state: "pending" | "transport-accepted" | "consumed" | "undelivered" | "uncertain";
  reason?: string;
}
export interface CompletionRecord {
  id: string;
  runId: string;
  parentId: string;
  state: "pending" | "submitted" | "observed" | "uncertain";
  trigger: boolean;
}
export interface UsageRecord {
  id: string;
  runId: string;
  usage: TokenUsage;
  goal?: GoalOrigin;
}
export interface AgentSnapshot { agent: AgentRecord; run?: AgentRun }
export interface RunnerHooks {
  session(path: string): void;
  text(text: string): void;
  activity(name: string): void;
  turn(): void;
  usage(eventId: string, usage: TokenUsage): void;
  /** Called before each new model/tool action. Throw to refuse obsolete work. */
  authorize(): void;
  /** Current parent-authorized tool names; a saved definition cannot widen them. */
  allowedTools?(): readonly string[];
}
export interface RunningChild {
  result: Promise<{ status: "succeeded" | "partial" | "failed" | "cancelled"; output: string; error?: string }>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
