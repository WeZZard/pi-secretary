/**
 * Codex-faithful tool executors for get_goal / create_goal / update_goal.
 *
 * Mirrors `codex-rs/ext/goal/src/tool.rs`. Each executor is a pure function
 * taking the GoalService and thread id, returning the Codex `GoalToolResponse`
 * shape (`goal`, `remaining_tokens`, `completion_budget_report`).
 */

import { type ThreadGoal, validateGoalBudget, validateThreadGoalObjective } from "../goal-record.ts";
import { GoalService } from "../goal-service.ts";
import type { GoalReceipt } from "../ordering.ts";
import {
  CREATE_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
} from "./goal-tool-specs.ts";

export interface GoalToolResponse {
  goal: ThreadGoal | null;
  remaining_tokens: number | null;
  completion_budget_report?: string;
}

export class GoalToolError extends Error {}

/** get_goal: read the current goal. */
export function executeGetGoal(service: GoalService, threadId: string): GoalToolResponse {
  const goal = service.getGoal(threadId);
  return goalResponse(goal, false);
}

/** create_goal: start a new goal (fails if an unfinished goal exists). */
export function executeCreateGoal(
  service: GoalService,
  threadId: string,
  params: { objective: string; token_budget?: number },
  maxBudget?: number,
  receipt?: GoalReceipt,
): GoalToolResponse {
  const objective = params.objective.trim();
  const validation = validateThreadGoalObjective(objective);
  if (!validation.ok) throw new GoalToolError(validation.error);
  const budget = params.token_budget;
  const budgetValidation = validateGoalBudget(budget, maxBudget);
  if (!budgetValidation.ok) throw new GoalToolError(budgetValidation.error);

  const outcome = service.createGoal(threadId, objective, budget, "agent", receipt);
  return goalResponse(outcome.goal, false);
}

/** update_goal: mark complete/blocked/paused. */
export function executeUpdateGoal(
  service: GoalService,
  threadId: string,
  params: { status: "complete" | "blocked" | "paused" },
  receipt?: GoalReceipt,
  originIntentSeq?: number,
): GoalToolResponse {
  const status = params.status;
  const goal = service.getGoal(threadId);
  if (!goal) {
    throw new GoalToolError("cannot update goal because this thread has no goal");
  }
  const outcome = service.requestTerminalUpdate(threadId, status, "agent", goal.goalId, receipt, originIntentSeq);
  return goalResponse(outcome.goal, status === "complete");
}

function goalResponse(goal: ThreadGoal | null, includeCompletionReport: boolean): GoalToolResponse {
  const remaining_tokens =
    goal?.tokenBudget !== undefined ? Math.max(goal.tokenBudget - goal.tokensUsed, 0) : null;
  const completion_budget_report =
    includeCompletionReport && goal?.status === "complete"
      ? completionBudgetReport(goal)
      : undefined;
  return {
    goal,
    remaining_tokens,
    ...(completion_budget_report !== undefined ? { completion_budget_report } : {}),
  };
}

function completionBudgetReport(goal: ThreadGoal): string | undefined {
  if (goal.tokenBudget === undefined && goal.timeUsedSeconds <= 0) {
    return undefined;
  }
  return "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language.";
}

export const TOOL_NAMES = {
  get: "get_goal",
  create: CREATE_GOAL_TOOL_NAME,
  update: UPDATE_GOAL_TOOL_NAME,
} as const;
