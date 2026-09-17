import type { AgentRecord, AgentRun } from "./records.ts";

/** Model-visible outcome formatting, shared with acceptance tests of the tool boundary. */
export function formatAgentOutcome(run: AgentRun, agent?: AgentRecord): string {
  const worktree = agent?.worktree;
  const isolation = worktree
    ? `Worktree: ${worktree.path}\nBranch: ${worktree.branch}\nBase commit: ${worktree.baseCommit}\nWorktree state: ${worktree.state}\n`
    : agent?.requestedWorktree ? `Worktree allocation is pending. Base commit: ${agent.requestedWorktree.baseCommit}\n` : "";
  return `Agent: ${run.agentId}\nRun: ${run.runId}\nStatus: ${run.status}\nDescription: ${run.description}\n` +
    (agent ? `Model: ${agent.model}\n` : "") + isolation +
    (isolation ? "Uncommitted parent changes are excluded. A Git worktree is not a security sandbox.\n" : "") +
    `Output: ${run.outputPath}\n${run.error ? `Error: ${run.error}\n` : ""}` +
    `Partial: ${run.status !== "succeeded"}\n\n${run.output}`;
}
