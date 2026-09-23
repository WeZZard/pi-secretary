import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { Operation } from "../actuator.ts";
import { runPlan, validatePlan, type HarnessDependencies, type Plan, type PlanResult } from "../harness.ts";
import type { Postcondition } from "../verifier.ts";
import type { runPlanSchema } from "./schemas.ts";

/** `computer_run_plan` (design docs/arch/computer-use.md §5.2 and §5.4). */

export interface RunPlanDetails { outcome: PlanResult["outcome"] | "rejected"; decisions: number; actions: number; escalation?: string; error?: string }

export interface RunPlanContext {
  deps: HarnessDependencies;
  knownObservation(id: string): boolean;
  /** Escalations already returned in this session, and the configured limit. */
  escalations: { used: number; limit: number; record(): void };
}

const rejected = (error: string): AgentToolResult<RunPlanDetails> =>
  ({ content: [{ type: "text", text: `Plan rejected: ${error}` }], details: { outcome: "rejected", decisions: 0, actions: 0, error } });

export function toPlan(params: Static<typeof runPlanSchema>): Plan {
  return {
    target: { app: params.app, ...(params.window_title ? { windowTitle: params.window_title } : {}) },
    goal: params.goal,
    allowDestructive: params.allow_destructive ?? [],
    steps: params.steps.map(step => ({ id: step.id, intent: step.intent, postcondition: step.postcondition as Postcondition,
      ...(step.operation ? { operation: step.operation as Operation } : {}), ...(step.text !== undefined ? { text: step.text } : {}),
      ...(step.keys !== undefined ? { keys: step.keys } : {}), ...(step.max_attempts !== undefined ? { maxAttempts: step.max_attempts } : {}) })),
  };
}

export function formatResult(result: PlanResult): string {
  const lines = [`Outcome: ${result.outcome}. Executor decisions: ${result.decisions}. Actions: ${result.actions}.`];
  for (const step of result.steps) {
    lines.push(`- ${step.id}: ${step.result.replace("_", " ")}${step.action ? `, ${step.action}${step.element ? ` ${JSON.stringify(step.element)}` : ""}` : ""}${step.detail ? ` (${step.detail})` : ""}`);
  }
  if (result.escalation) {
    const { stepId, reason, detail, prior, observation } = result.escalation;
    lines.push("", `Escalation at step ${stepId}: ${reason}. ${detail}`);
    if (prior && (prior.element || prior.region || prior.operation)) {
      lines.push(`Executor prior: ${[prior.operation, prior.element && JSON.stringify(prior.element), prior.region && `in ${prior.region}`].filter(Boolean).join(" ")}.`);
    }
    if (observation) lines.push("", "Current window:", observation);
  }
  return lines.join("\n");
}

export async function executeRunPlan(context: RunPlanContext, params: Static<typeof runPlanSchema>, signal?: AbortSignal): Promise<AgentToolResult<RunPlanDetails>> {
  if (context.escalations.used >= context.escalations.limit) {
    return rejected(`this run already returned ${context.escalations.used} escalations, the configured limit. Report progress to the parent instead of planning again.`);
  }
  if (params.based_on !== undefined && !context.knownObservation(params.based_on)) {
    return rejected(`observation ${JSON.stringify(params.based_on)} is unknown or expired; call computer_observe and plan against the new observation.`);
  }
  const plan = toPlan(params);
  const problem = validatePlan(plan, 50);
  if (problem) return rejected(problem);
  const result = await runPlan(context.deps, plan, signal);
  if (result.outcome === "escalated") context.escalations.record();
  return { content: [{ type: "text", text: formatResult(result) }],
    details: { outcome: result.outcome, decisions: result.decisions, actions: result.actions, ...(result.escalation ? { escalation: result.escalation.reason } : {}) } };
}
