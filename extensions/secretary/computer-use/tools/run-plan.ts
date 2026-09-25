import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { Operation } from "../actuator.ts";
import { runPlan, validatePlan, type HarnessDependencies, type Plan, type PlanResult } from "../harness.ts";
import type { Observation } from "../observer.ts";
import type { Postcondition } from "../verifier.ts";
import type { runPlanSchema } from "./schemas.ts";

/** `computer_run_plan` (design docs/arch/computer-use.md §5.2 and §5.4). */

export interface RunPlanDetails { outcome: PlanResult["outcome"] | "rejected"; decisions: number; actions: number; escalation?: string; error?: string; rule?: string }

export interface RunPlanContext {
  deps: HarnessDependencies;
  /** The remembered observation with this id; the plan acts on its window. */
  observation(id: string): Observation | undefined;
  /** Escalations already returned in this session, and the configured limit. */
  escalations: { used: number; limit: number; record(): void };
}

/** Every rejection is recorded with its rule, so a rule that rejects correct plans shows in the records (design §12.1). */
async function rejected(context: RunPlanContext, params: Static<typeof runPlanSchema>, rule: string, error: string): Promise<AgentToolResult<RunPlanDetails>> {
  await context.deps.telemetry.recordRejection({ rule, message: error, redact: context.deps.config.redactTypedText, plan: params });
  return { content: [{ type: "text", text: `Plan rejected: ${error}` }], details: { outcome: "rejected", decisions: 0, actions: 0, error, rule } };
}

/** A plan made against an observation acts on that observation's window (Pi task batch, 2026-09-23). */
export function toPlan(params: Static<typeof runPlanSchema>, basedOn?: Observation): Plan {
  return {
    target: { app: params.app, ...(params.window_title ? { windowTitle: params.window_title } : {}), ...(basedOn ? { windowId: basedOn.window.windowId } : {}) },
    goal: params.goal,
    allowDestructive: params.allow_destructive ?? [],
    steps: params.steps.map(step => ({ id: step.id, intent: step.intent, postcondition: step.postcondition as Postcondition,
      ...(step.operation ? { operation: step.operation as Operation } : {}), ...(step.text !== undefined ? { text: step.text } : {}),
      ...(step.keys !== undefined ? { keys: step.keys } : {}), ...(step.max_attempts !== undefined ? { maxAttempts: step.max_attempts } : {}),
      ...(step.idempotent !== undefined ? { idempotent: step.idempotent } : {}),
      ...(step.control !== undefined ? { control: step.control } : {}),
      ...(step.position !== undefined ? { position: step.position } : {}) })),
  };
}

/**
 * Fix plan F-9: the result lists exactly what code verified, so the planner can report only that.
 * `plan` supplies each step's postcondition.
 */
export function verifiedFacts(result: PlanResult, plan: Plan): string[] {
  const lines: string[] = [];
  const verified = result.steps.filter(step => step.result === "verified");
  const unverified = result.steps.filter(step => step.result === "weakly_verified");
  if (verified.length) {
    lines.push("", "Verified by code after the step (report only these facts as checked):");
    for (const step of verified) lines.push(`- ${step.id}: ${JSON.stringify(plan.steps.find(candidate => candidate.id === step.id)?.postcondition)} held`);
  }
  if (unverified.length) {
    lines.push("", "Not verified (only a change on screen was seen):");
    for (const step of unverified) lines.push(`- ${step.id}`);
  }
  return lines;
}

export function formatResult(result: PlanResult, plan?: Plan): string {
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
  if (plan) lines.push(...verifiedFacts(result, plan));
  return lines.join("\n");
}

export async function executeRunPlan(context: RunPlanContext, params: Static<typeof runPlanSchema>, signal?: AbortSignal): Promise<AgentToolResult<RunPlanDetails>> {
  if (context.escalations.used >= context.escalations.limit) {
    return rejected(context, params, "escalation_limit", `this run already returned ${context.escalations.used} escalations, the configured limit. Report progress to the parent instead of planning again.`);
  }
  const basedOn = params.based_on === undefined ? undefined : context.observation(params.based_on);
  if (params.based_on !== undefined && !basedOn) {
    return rejected(context, params, "unknown_observation", `observation ${JSON.stringify(params.based_on)} is unknown or expired; call computer_observe and plan against the new observation.`);
  }
  const plan = toPlan(params, basedOn);
  const problem = validatePlan(plan, 50);
  if (problem) return rejected(context, params, problem.rule, problem.message);
  const result = await runPlan(context.deps, plan, signal);
  if (result.outcome === "escalated") context.escalations.record();
  return { content: [{ type: "text", text: formatResult(result, plan) }],
    details: { outcome: result.outcome, decisions: result.decisions, actions: result.actions, ...(result.escalation ? { escalation: result.escalation.reason } : {}) } };
}
