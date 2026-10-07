import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { toAction } from "../actions.ts";
import { uiElementMatches, runPlan, validatePlan, type ExecutorDependencies, type Plan, type PlanResult } from "../executor.ts";
import type { Observation } from "../observer.ts";
import type { ObserveDetails } from "./observe.ts";
import type { runPlanSchema } from "./schemas.ts";

/** `vm_run_plan` (design docs/arch/vm-use.md §5.2 and §5.4). */

export interface RunPlanDetails {
  outcome: PlanResult["outcome"] | "rejected"; decisions: number; actions: number; escalation?: string; error?: string; rule?: string;
  /** The plan's run, which names its records (design §12.3); a rejected plan has none. */
  runId?: string;
  /** The observation of the window after the plan, which a next plan can name in `based_on` (design §5.4). */
  observationId?: string;
}

export interface RunPlanContext {
  deps: ExecutorDependencies;
  /** The delegated request as written, which the grounder reads at every step (design §7.1, decision PS-D39). */
  request?: string;
  /** The remembered observation with this id; the plan acts on its window. */
  observation(id: string): Observation | undefined;
  /**
   * The last read of the previous plan in this session, when that plan ran after the observation
   * `basedOn` names; the start check accepts it as a change this executor made itself (design §9).
   */
  previousPlanRead?(basedOn: string): Observation | undefined;
  /** Remembers a plan's last read for the next plan's start check. */
  recordPlanRead?(observation: Observation): void;
  /** Reads the plan's window as `vm_observe` does, for the planner to judge the result (design §5.3 and §5.4). */
  observeAfter?(target: { app: string; window_title?: string; windowId?: number }, signal?: AbortSignal): Promise<AgentToolResult<ObserveDetails>>;
  /** Escalations already returned in this session, and the configured limit. */
  escalations: { used: number; limit: number; record(): void };
}

/** Every rejection is recorded with its rule, so a rule that rejects correct plans shows in the records (design §12.1). */
async function rejected(context: RunPlanContext, params: Static<typeof runPlanSchema>, rule: string, error: string): Promise<AgentToolResult<RunPlanDetails>> {
  await context.deps.telemetry.recordRejection({ rule, message: error, redact: context.deps.config.redactTypedText, plan: params });
  return { content: [{ type: "text", text: `Plan rejected: ${error}` }], details: { outcome: "rejected", decisions: 0, actions: 0, error, rule } };
}

/** A plan made against an observation acts on that observation's window (Pi task batch, 2026-09-23). */
export function toPlan(params: Static<typeof runPlanSchema>, basedOn?: Observation, request?: string): Plan {
  return {
    target: { app: params.app, ...(params.window_title ? { windowTitle: params.window_title } : {}), ...(basedOn ? { windowId: basedOn.window.windowId } : {}) },
    goal: params.goal,
    ...(request !== undefined ? { request } : {}),
    ...(params.permission_check !== undefined ? { permissionCheck: params.permission_check } : {}),
    steps: params.steps.map(step => ({ id: step.id, intent: step.intent,
      ...(toAction(step.action ?? step.operation) ? { action: toAction(step.action ?? step.operation)! } : {}), ...(step.text !== undefined ? { text: step.text } : {}),
      ...(step.keys !== undefined ? { keys: step.keys } : {}),
      ...(step.ui_element !== undefined ? { ui_element: step.ui_element } : {}),
      ...(step.position !== undefined ? { position: step.position } : {}) })),
  };
}

/** What each step did; `acted` says input was sent, not that the step worked (design §5.4). */
export function formatResult(result: PlanResult): string {
  const lines = [`Outcome: ${result.outcome}. Grounder decisions: ${result.decisions}. Actions: ${result.actions}.`];
  for (const step of result.steps) {
    // Design §11.4: each action step names its action, which says its input.
    lines.push(`- ${step.id}: ${step.result.replace("_", " ")}${step.action ? `, ${step.action}${step.element ? ` ${JSON.stringify(step.element)}` : ""}` : ""}${step.detail && step.result !== "stopped" ? ` (${step.detail})` : ""}`);
  }
  // A stopped step's reason is the escalation below.
  if (result.escalation) {
    const { stepId, reason, detail, prior } = result.escalation;
    lines.push("", `Escalation at step ${stepId}: ${reason}. ${detail}`);
    if (prior && (prior.element || prior.region || prior.operation)) {
      lines.push(`Grounder prior: ${[prior.operation, prior.element && JSON.stringify(prior.element), prior.region && `in ${prior.region}`].filter(Boolean).join(" ")}.`);
    }
  }
  return lines.join("\n");
}

export async function executeRunPlan(context: RunPlanContext, params: Static<typeof runPlanSchema>, signal?: AbortSignal): Promise<AgentToolResult<RunPlanDetails>> {
  if (context.escalations.used >= context.escalations.limit) {
    return rejected(context, params, "escalation_limit", `this run already returned ${context.escalations.used} escalations, the configured limit. Report progress to the parent instead of planning again.`);
  }
  const basedOn = params.based_on === undefined ? undefined : context.observation(params.based_on);
  if (params.based_on !== undefined && !basedOn) {
    return rejected(context, params, "unknown_observation", `observation ${JSON.stringify(params.based_on)} is unknown or expired; call vm_observe and plan against the new observation.`);
  }
  const previous = basedOn ? context.previousPlanRead?.(basedOn.id) : undefined;
  const plan = { ...toPlan(params, basedOn, context.request), ...(basedOn ? { basedOn: basedOn.comparison } : {}), ...(previous ? { previous: previous.comparison } : {}) };
  const problem = validatePlan(plan, 50);
  if (problem) return rejected(context, params, problem.rule, problem.message);
  // Design §6.5: until the iOS actions of §7.2 are built, a step may not target the Simulator's device screen.
  const iosStep = basedOn && plan.steps.find(step => {
    const matches = step.ui_element ? uiElementMatches(basedOn, step.ui_element) : [];
    return matches.length > 0 && matches.every(element => element.platform === "ios");
  });
  if (iosStep) {
    return rejected(context, params, "ios_target", `step ${iosStep.id}: ${JSON.stringify(iosStep.ui_element!.name)} is on the iOS screen of the Simulator, and iOS targets are not supported yet. Report this instead of acting another way.`);
  }
  // Design §8.1: a run never believes it is checked when it is not.
  if (plan.permissionCheck === "online" && !context.deps.online) {
    return rejected(context, params, "permission_check_unavailable", "the task asks for the permission check online, and no online API is configured for it. Stop and report that the check cannot run; do not plan without it.");
  }
  const result = await runPlan(context.deps, plan, signal);
  if (result.last) context.recordPlanRead?.(result.last);
  if (result.outcome === "escalated") context.escalations.record();
  const details: RunPlanDetails = { runId: result.runId, outcome: result.outcome, decisions: result.decisions, actions: result.actions, ...(result.escalation ? { escalation: result.escalation.reason } : {}) };
  // Design §5.4: the window after the plan is what the planner judges. A cancelled call reads nothing more.
  if (result.outcome === "cancelled" || !context.observeAfter) return { content: [{ type: "text", text: formatResult(result) }], details };
  const after = await context.observeAfter({ app: params.app, ...(params.window_title ? { window_title: params.window_title } : {}),
    ...(result.last ? { windowId: result.last.window.windowId } : plan.target.windowId !== undefined ? { windowId: plan.target.windowId } : {}) }, signal);
  const [first, ...rest] = after.content as (TextContent | ImageContent)[];
  const window = first?.type === "text" ? first.text : "";
  // Decision PS-D20: this window is the next plan's based_on. When it could not be read, the planner observes first.
  const section = after.details.status === "ready"
    ? `The window after the plan. Judge the result from it; no step above was checked. The next plan's based_on is its Observation.\n${window}`
    : `The window after the plan could not be read, so call vm_observe before the next plan.\n${window}`;
  return { content: [{ type: "text", text: `${formatResult(result)}\n\n${section}` }, ...rest],
    details: { ...details, ...(after.details.status === "ready" ? { observationId: after.details.observationId } : {}) } };
}
