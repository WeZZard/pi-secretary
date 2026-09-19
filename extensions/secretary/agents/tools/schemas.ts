import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentConfiguration } from "../configuration.ts";

const MODEL_DESCRIPTION = "Optional model selection. Name a configured model fallback list to try its models in order, or give an exact provider/modelId available in this session. Normally omit this field to use the agent definition's model or inherit the parent model. Do not override the definition unless the user requests it.";

export const agentSchema = Type.Object({
  description: Type.String(),
  prompt: Type.String(),
  subagent_type: Type.Optional(Type.String()),
  model: Type.Optional(Type.String({ description: MODEL_DESCRIPTION })),
  run_in_background: Type.Optional(Type.Boolean()),
  name: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", maxLength: 64 })),
  isolation: Type.Optional(StringEnum(["none", "worktree"], {
    description: "Optional workspace isolation. Normally omit this field to use the agent definition's setting, which defaults to none (the parent's working directory). Use none to explicitly keep the parent directory. Request worktree only when separate workspace isolation is explicitly needed; projects without Git history receive a reported directory snapshot. Background execution does not require isolation. Remote execution is unavailable.",
  })),
  team_name: Type.Optional(Type.String({ deprecated: true, description: "Deprecated; ignored." })),
  mode: Type.Optional({ ...StringEnum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]), deprecated: true, description: "Deprecated; ignored." }),
}, { additionalProperties: false });

/** Advertise only configured fallback lists. An absent list must not invite model guesses. */
export function createAgentSchema(modelFallbackLists: AgentConfiguration["modelFallbackLists"]): typeof agentSchema {
  const names = Object.keys(modelFallbackLists);
  const properties: Record<string, unknown> = { ...agentSchema.properties };
  properties.model = names.length
    ? Type.Optional(StringEnum(names, { description: MODEL_DESCRIPTION }))
    : Type.Optional(Type.String({ description: MODEL_DESCRIPTION }));
  // The handler accepts the baseline superset; the advertised JSON Schema is narrower.
  return { ...agentSchema, properties } as typeof agentSchema;
}

export const sendMessageSchema = Type.Object({
  to: Type.String({ minLength: 1, maxLength: 300, pattern: "^[^\\r\\n\\u2028\\u2029]+$" }),
  message: Type.String(),
  summary: Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: false });

export const taskStopSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
  shell_id: Type.Optional(Type.String({ deprecated: true })),
}, { additionalProperties: false });

export const taskOutputSchema = Type.Object({
  task_id: Type.String(),
  block: Type.Optional(Type.Boolean({ default: true })),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 600000, default: 30000 })),
}, { additionalProperties: false });

export type AgentInput = Static<typeof agentSchema>;
export type SendMessageInput = Static<typeof sendMessageSchema>;
export type TaskStopInput = Static<typeof taskStopSchema>;
export type TaskOutputInput = Static<typeof taskOutputSchema>;
