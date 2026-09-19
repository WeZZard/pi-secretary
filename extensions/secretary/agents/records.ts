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
  isolation?: "none" | "worktree";
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
  kind?: "git-worktree";
  id: string;
  repo: string;
  path: string;
  branch: string;
  baseCommit: string;
  state: "allocated" | "cleaning" | "removed" | "uncertain";
}
export interface DirectorySnapshotRecord {
  kind: "directory-snapshot";
  id: string;
  repo: string;
  path: string;
  reason: "no-git" | "unborn-head";
  branch?: undefined;
  baseCommit?: undefined;
  state: "allocated" | "cleaning" | "removed" | "uncertain";
}
export type WorkspaceRecord = WorktreeRecord | DirectorySnapshotRecord;
export type WorkspacePlan =
  | { kind?: "git-worktree"; repo: string; baseCommit: string; relativeCwd?: string }
  | { kind: "directory-snapshot"; repo: string; reason: "no-git" | "unborn-head"; relativeCwd?: string };

export interface AgentRecord {
  agentId: string;
  parentId: string;
  /** The delegating agent for nested delegation (SA-12); absent for top-level agents. */
  parentAgentId?: string;
  /**
   * Levels below the main session: a top-level agent is 1. Records written before nested
   * delegation lack the field and are treated as depth 1. Launches beyond
   * `agents.maxNestingDepth` are rejected (architecture §7).
   */
  depth?: number;
  name?: string;
  definition: AgentDefinition;
  model: string;
  /** Ordered fallback candidates remaining after `model` (architecture §5.3). Ignored on resumption, which retains the recorded model. */
  modelCandidates?: string[];
  thinkingLevel?: string;
  tools: string[];
  cwd: string;
  configCwd: string;
  sessionPath?: string;
  /** Historical storage key; kind distinguishes a linked worktree from a directory snapshot. */
  worktree?: WorkspaceRecord;
  requestedWorktree?: WorkspacePlan;
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
/**
 * Immutable widget row view model (architecture §12.6.3). Published by AgentService; widgets render it
 * without computing state. Usage labels are display-only and distinct from the §11.2 goal-budget formula.
 */
export interface AgentRowView {
  agentId: string;
  /** The delegating agent for nested rows; absent for top-level rows (§12.6.3). */
  parentAgentId?: string;
  name?: string;
  status: RunStatus | "idle";
  description: string;
  model: string;
  startedAt?: number;
  activity?: string;
  background: boolean;
  windowTokens?: number;
  cumulativeTokens?: number;
}
export interface RunnerHooks {
  session(path: string): void;
  text(text: string): void;
  activity(name: string): void;
  turn(): void;
  usage(eventId: string, usage: TokenUsage): void;
  /** Called before each new model/tool action. Throw to refuse obsolete work. */
  authorize(): void;
  /** Records an availability failure for a candidate, with an absolute reset time when the provider reported one. */
  availability?(id: string, resetAt?: number): void;
  /** Commits the model that actually executed when the chain advanced past the recorded model. */
  model?(id: string): void;
  /** Current parent-authorized tool names; a saved definition cannot widen them. */
  allowedTools?(): readonly string[];
}
export interface RunningChild {
  result: Promise<{ status: "succeeded" | "partial" | "failed" | "cancelled"; output: string; error?: string }>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
