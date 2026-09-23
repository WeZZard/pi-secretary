import type { AgentRecord, AgentRun } from "./records.ts";
import { isExactModelIdentifier } from "./configuration.ts";

/** Why the recorded model was chosen (architecture §5.3): inheritance, an exact model, or a named list's candidate position. */
function modelProvenance(agent: AgentRecord): string {
  const resolution = agent.modelResolution;
  if (!resolution) return "";
  if (resolution.value === "inherit") return " (inherited from the parent model)";
  const origin = resolution.source === "definition" ? "definition" : resolution.source;
  if (isExactModelIdentifier(resolution.value)) return ` (${origin} model)`;
  return ` (${origin} list '${resolution.value}', candidate ${resolution.selected + 1}/${resolution.chain.length})`;
}

/** Candidates skipped before the selection (architecture §5.3), stated on every result surface. */
function skippedCandidates(agent: AgentRecord): string {
  const skipped = agent.modelResolution?.skipped;
  return skipped?.length ? `Fallback: skipped ${skipped.map(s => `${s.id} (${s.reason})`).join("; ")}\n` : "";
}

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
    (agent ? `Model: ${agent.model}${modelProvenance(agent)}\n${skippedCandidates(agent)}Working directory: ${agent.cwd}\n` : "") + isolation +
    (workspace || plan ? "Workspace isolation is not a security sandbox.\n" : "") +
    `Output: ${run.outputPath}\n${run.error ? `Error: ${run.error}\n` : ""}` +
    `Partial: ${run.status !== "succeeded"}\n\n${run.output}`;
}
