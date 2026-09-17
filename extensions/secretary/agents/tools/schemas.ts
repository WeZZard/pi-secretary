import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { MODEL_ALIASES } from "../configuration.ts";

export const agentSchema = Type.Object({
  description: Type.String(),
  prompt: Type.String(),
  subagent_type: Type.Optional(Type.String()),
  model: Type.Optional(StringEnum(MODEL_ALIASES)),
  run_in_background: Type.Optional(Type.Boolean()),
  name: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", maxLength: 64 })),
  isolation: Type.Optional(StringEnum(["worktree", "remote"])),
  team_name: Type.Optional(Type.String({ deprecated: true, description: "Deprecated; ignored." })),
  mode: Type.Optional({ ...StringEnum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]), deprecated: true, description: "Deprecated; ignored." }),
}, { additionalProperties: false });

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
