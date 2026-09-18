import type { AgentRecord, AgentRun } from "./records.ts";

/** Describe the actual mechanism; a directory snapshot is never labeled a Git worktree. */
export function formatAgentOutcome(run: AgentRun, agent?: AgentRecord): string {
  const workspace = agent?.worktree;
  const plan = agent?.requestedWorktree;
  let isolation = "Isolation: none (parent working directory).\n";
  if (workspace?.kind === "directory-snapshot") {
    isolation = `Isolation: directory-snapshot (${workspace.reason}).\nWorkspace: ${workspace.path}\nSource directory: ${workspace.repo}\nWorkspace state: ${workspace.state}\nCurrent project files were copied without Git metadata. No source repository was initialized or committed.\n`;
  } else if (workspace) {
    isolation = `Isolation: git-worktree.\nWorktree: ${workspace.path}\nBranch: ${workspace.branch}\nBase commit: ${workspace.baseCommit}\nWorktree state: ${workspace.state}\nUncommitted parent changes are excluded.\n`;
  } else if (plan) {
    isolation = plan.kind === "directory-snapshot"
      ? `Isolation allocation pending: directory-snapshot (${plan.reason}). Source directory: ${plan.repo}\n`
      : `Worktree allocation is pending. Base commit: ${plan.baseCommit}\n`;
  }
  return `Agent: ${run.agentId}\nRun: ${run.runId}\nStatus: ${run.status}\nDescription: ${run.description}\n` +
    (agent ? `Model: ${agent.model}\nWorking directory: ${agent.cwd}\n` : "") + isolation +
    (workspace || plan ? "Workspace isolation is not a security sandbox.\n" : "") +
    `Output: ${run.outputPath}\n${run.error ? `Error: ${run.error}\n` : ""}` +
    `Partial: ${run.status !== "succeeded"}\n\n${run.output}`;
}
