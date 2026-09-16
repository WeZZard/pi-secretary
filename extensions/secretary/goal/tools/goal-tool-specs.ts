/**
 * Codex-faithful goal tool definitions for pi's registerTool.
 *
 * Mirrors `codex-rs/ext/goal/src/spec.rs`. Three tools, static install:
 * get_goal, create_goal, update_goal.
 */

import { Type } from "typebox";
import type { StringEnum } from "@earendil-works/pi-ai";

export const GET_GOAL_TOOL_NAME = "get_goal";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";

export const getGoalToolSpec = {
  name: GET_GOAL_TOOL_NAME,
  label: "Get Goal",
  description:
    "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
  promptSnippet: "Get the current goal and its status",
  promptGuidelines: [
    "Use get_goal before answering a question about the current goal status; do not infer status from remaining work or historical assistant messages.",
  ],
  parameters: Type.Object({}),
};

export const createGoalToolSpec = {
  name: CREATE_GOAL_TOOL_NAME,
  label: "Create Goal",
  description:
    "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nSet token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
  promptSnippet: "Start a goal only when explicitly requested",
  promptGuidelines: [
    "Use create_goal only when the user or system/developer instructions explicitly request starting a goal; never infer a goal from an ordinary task.",
    "Set token_budget on create_goal only when an explicit token budget is requested.",
  ],
  parameters: Type.Object({
    objective: Type.String(),
    token_budget: Type.Optional(Type.Integer()),
  }),
  required: ["objective"],
};

export const updateGoalToolSpec = {
  name: UPDATE_GOAL_TOOL_NAME,
  label: "Update Goal",
  description:
    "Update the existing goal.\nSet status to `paused` only at the user's explicit request to pause this goal, never on your own initiative. Ask if unclear; a later resume revokes that request. Report the returned status and stop goal work. Budget limits take precedence over pausing.\nSet status to `complete` only when the objective has actually been achieved and no required work remains.\nSet status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.\nIf the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.\nOnce the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.\nDo not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.\nDo not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.\nYou cannot use this tool to resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.\nWhen marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.",
  promptSnippet: "Mark the goal complete, blocked, or paused",
  promptGuidelines: [
    "Use update_goal only to set status to complete, blocked, or paused.",
    "Set status to complete only when the objective is achieved and no required work remains.",
    "Set status to blocked only when the same blocking condition recurs for at least three consecutive goal turns and the agent is at an impasse.",
    "Set status to paused only at the user's explicit request; never on your own initiative.",
  ],
  parameters: Type.Object({
    status: Type.String({ enum: ["complete", "blocked", "paused"] }),
  }),
  required: ["status"],
};
