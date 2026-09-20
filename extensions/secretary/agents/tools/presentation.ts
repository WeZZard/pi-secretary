import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRecord, AgentRun } from "../records.ts";

/** Additive tool-result metadata; legacy AgentRun fields remain at the top level. */
export interface InlinePresentation {
  version: 1;
  agentType: string;
  name?: string;
  model: string;
  cwd: string;
  workspaceLines: string[];
  promptPath?: string;
  messagePath?: string;
  artifactError?: string;
  acknowledgment?: "Message queued." | "Resume accepted.";
}
export type InlineAgentDetails = AgentRun & { presentation?: InlinePresentation };

export function workspaceLines(agent: AgentRecord): string[] {
  const workspace = agent.worktree, plan = agent.requestedWorktree;
  if (workspace?.kind === "directory-snapshot") return [
    `Isolation: directory-snapshot (${workspace.reason}).`, `Workspace: ${workspace.path}`,
    `Source directory: ${workspace.repo}`, `Workspace state: ${workspace.state}`,
    "Current project files were copied without Git metadata. No source repository was initialized or committed.",
    "Workspace isolation is not a security sandbox.",
  ];
  if (workspace) return ["Isolation: git-worktree.", `Worktree: ${workspace.path}`, `Branch: ${workspace.branch}`,
    `Base commit: ${workspace.baseCommit}`, `Worktree state: ${workspace.state}`, "Uncommitted parent changes are excluded.",
    "Workspace isolation is not a security sandbox."];
  if (plan) return [plan.kind === "directory-snapshot"
    ? `Isolation allocation pending: directory-snapshot (${plan.reason}). Source directory: ${plan.repo}`
    : `Worktree allocation is pending. Base commit: ${plan.baseCommit}`, "Workspace isolation is not a security sandbox."];
  return ["Isolation: none (parent working directory)."];
}

/** Operation-boundary retention, never called from a renderer. Names contain no user path input. */
export function retainInlineText(outputPath: string, kind: "prompt" | "message", operationId: string, text: string): string {
  const key = createHash("sha256").update(JSON.stringify([operationId, text])).digest("hex");
  const path = join(dirname(outputPath), `${kind}-${key}.txt`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // An idempotent retry may reuse only a regular file with exactly the saved text.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile() || readFileSync(fd, "utf8") !== text) throw new Error("Retained input artifact does not match this operation");
    } finally { closeSync(fd); }
  }
  return path;
}

/** Capture presentation at the operation boundary rather than resolving live identity at paint time. */
export function capturePresentation(agent: AgentRecord): InlinePresentation {
  return { version: 1, agentType: agent.definition.name, name: agent.name, model: agent.model,
    cwd: agent.cwd, workspaceLines: workspaceLines(agent) };
}
