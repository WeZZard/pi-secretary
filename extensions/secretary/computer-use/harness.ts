import { ActuatorError, actionsFor } from "./actuator.ts";
import { BackendError, type ExecutionBackend, type WindowRead, type WindowTarget } from "./backend/backend.ts";
import type { ComputerUseConfiguration } from "./configuration.ts";
import { ExecutorError, type DecisionRequestBody, type DecisionResponse } from "./executor-client.ts";
import { ActionHistory, type ActionRecord } from "./history.ts";
import { observe, renderPlannerTable, type Observation, type ObservationFailure } from "./observer.ts";
import { decide, type Decision, type EscalationReason, type Prior } from "./policy.ts";
import { buildDecisionRequest, type StepSpec } from "./request-builder.ts";
import type { Telemetry } from "./telemetry.ts";
import { evaluatePostcondition, isWeakPostcondition, validatePostcondition, visibleSignature, type Postcondition } from "./verifier.ts";

/** The step harness (design docs/arch/computer-use.md §9 and §10). */

export interface PlanStep extends StepSpec { postcondition: Postcondition; maxAttempts?: number }
export interface Plan { target: WindowTarget; goal: string; steps: PlanStep[]; allowDestructive: string[] }

export interface StepOutcome {
  id: string;
  result: "verified" | "weakly_verified" | "skipped" | "failed" | "not_run";
  action?: string;
  element?: string;
  detail?: string;
}

export interface Escalation { stepId: string; reason: EscalationReason; detail: string; prior?: Prior; observation?: string }

export interface PlanResult {
  outcome: "completed" | "escalated" | "cancelled";
  steps: StepOutcome[];
  escalation?: Escalation;
  /** Executor decisions kept out of the planner (design §12.2): requests whose answer was acted on or escalated. */
  decisions: number;
  actions: number;
}

export interface Executor { decide(body: DecisionRequestBody, signal?: AbortSignal): Promise<DecisionResponse> }

export interface HarnessDependencies {
  backend: ExecutionBackend;
  executor: Executor;
  telemetry: Telemetry;
  config: ComputerUseConfiguration;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  newId?: () => string;
}

const REOBSERVE_LIMIT = 2;
const NO_CHANGE_LIMIT = 2;
const DEFAULT_ATTEMPTS = 2;

/** Returns the first problem with a plan, before any action (design §5.2). */
export function validatePlan(plan: Plan, maxSteps: number): string | undefined {
  if (plan.steps.length === 0) return "the plan has no steps";
  if (plan.steps.length > maxSteps) return `the plan has ${plan.steps.length} steps; the limit is ${maxSteps}`;
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) return `step id ${JSON.stringify(step.id)} is repeated`;
    ids.add(step.id);
    const problem = validatePostcondition(step.postcondition);
    if (problem) return `step ${step.id}: ${problem}`;
    if (step.operation === "enter_text" && step.text === undefined) return `step ${step.id}: enter_text needs text`;
    if (step.operation === "key_combo" && step.keys === undefined) return `step ${step.id}: key_combo needs keys`;
    if (step.maxAttempts !== undefined && (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 5)) return `step ${step.id}: maxAttempts must be 1 to 5`;
  }
  for (const id of plan.allowDestructive) if (!ids.has(id)) return `allowDestructive names unknown step ${JSON.stringify(id)}`;
  return undefined;
}

class Stop extends Error {
  readonly escalation?: Escalation;
  readonly cancelled: boolean;
  constructor(escalation: Escalation | undefined, cancelled = false) { super(escalation?.detail ?? "cancelled"); this.escalation = escalation; this.cancelled = cancelled; }
}

export async function runPlan(deps: HarnessDependencies, plan: Plan, signal?: AbortSignal): Promise<PlanResult> {
  const { backend, executor, telemetry, config } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let sequence = 0;
  const nextId = deps.newId ?? (() => `run-${Date.now().toString(36)}`);
  const runId = nextId();
  const history = new ActionHistory();
  const outcomes: StepOutcome[] = plan.steps.map(step => ({ id: step.id, result: "not_run" }));
  let decisions = 0, actions = 0;
  let current: { read: WindowRead; observation: Observation } | undefined;

  const checkCancelled = () => { if (signal?.aborted) throw new Stop(undefined, true); };
  const plannerView = () => current ? renderPlannerTable(current.observation) : undefined;
  const escalate = (stepId: string, reason: EscalationReason, detail: string, prior?: Prior): never =>
    { throw new Stop({ stepId, reason, detail, ...(prior ? { prior } : {}) }); };

  async function look(stepId: string, purpose: string): Promise<{ read: WindowRead; observation: Observation }> {
    for (let attempt = 1; ; attempt++) {
      checkCancelled();
      let read: WindowRead;
      try { read = await backend.readWindow(plan.target, { screenshot: false, signal }); }
      catch (error) {
        if (error instanceof BackendError && error.code === "aborted") throw new Stop(undefined, true);
        return escalate(stepId, "backend_failed", error instanceof Error ? error.message : String(error));
      }
      const result: Observation | ObservationFailure = observe(read, { id: `${runId}-${String(++sequence).padStart(3, "0")}`, maxElements: config.maxElements, maxNameLength: config.maxNameLength });
      await telemetry.recordObservation(read, result, { attempt, purpose: `${purpose} ${stepId}` });
      if (result.status === "ready") return { read, observation: result };
      if (result.status === "state_too_large") return escalate(stepId, "state_too_large", result.detail);
      if (attempt > REOBSERVE_LIMIT) return escalate(stepId, "no_progress", result.detail);
      await sleep(config.settleMs, signal);
    }
  }

  try {
    current = await look(plan.steps[0]!.id, "initial");
    for (const [index, step] of plan.steps.entries()) {
      const outcome = outcomes[index]!;
      // Precheck: a step whose postcondition already holds needs no decision (design §9).
      if (!isWeakPostcondition(step.postcondition) && evaluatePostcondition(step.postcondition, current.read).holds) {
        outcome.result = "skipped";
        outcome.detail = "the postcondition already held";
        history.push({ intent: step.intent, action: "none", outcome: "skipped" });
        continue;
      }
      let attempts = 0, reobserves = 0, unchanged = 0;
      for (;;) {
        if (actions >= config.maxActionsPerPlan) escalate(step.id, "budget_exhausted", `the plan used its ${config.maxActionsPerPlan} actions`);
        const built = buildDecisionRequest({ goal: plan.goal, step, observation: current.observation, recent: history.recent(), answerReserveTokens: config.answerReserveTokens });
        if (built.status === "too_large") escalate(step.id, "state_too_large", `the executor request needs about ${built.estimatedTokens} tokens; ${built.budget} are available`);
        if (built.status !== "ready") break;
        checkCancelled();
        let response: DecisionResponse;
        try { response = await executor.decide(built.body, signal); }
        catch (error) {
          if (error instanceof ExecutorError && error.code === "aborted") throw new Stop(undefined, true);
          return escalateAfter(step.id, "executor_unavailable", error instanceof Error ? error.message : String(error));
        }
        decisions++;
        const decision: Decision = decide({ response, questions: built.questions, observation: current.observation, step,
          allowDestructive: plan.allowDestructive.includes(step.id), confidenceGate: config.confidenceGate });
        await telemetry.recordStep({ runId, stepId: step.id, attempt: attempts + 1, estimatedTokens: built.estimatedTokens,
          inputTokens: response.inputTokens, roundTripMs: response.roundTripMs, request: built.body, answers: response.answers, decision: summarize(decision) });
        if (decision.kind === "reobserve") {
          if (++reobserves > REOBSERVE_LIMIT) escalate(step.id, "no_progress", "the executor kept asking to look again", decision.prior);
          await sleep(config.settleMs, signal);
          current = await look(step.id, "reobserve");
          continue;
        }
        if (decision.kind === "escalate") escalate(step.id, decision.reason, decision.detail, decision.prior);
        if (decision.kind !== "act") break;

        let backendActions;
        try { backendActions = actionsFor(decision.request); }
        catch (error) {
          if (error instanceof ActuatorError) escalate(step.id, error.code === "untypeable_text" ? "needs_text" : "uncertain", error.message, decision.prior);
          throw error;
        }
        const before = current;
        for (const action of backendActions) {
          checkCancelled();
          try { await backend.act(before.read.window, action, signal); }
          catch (error) {
            // An action already sent is not replayed (design §11.2); its outcome is uncertain.
            if (error instanceof BackendError && error.code === "aborted") throw new Stop(undefined, true);
            escalate(step.id, "backend_failed", error instanceof Error ? error.message : String(error), decision.prior);
          }
        }
        actions++;
        attempts++;
        const described = `${decision.operation}${decision.element ? ` ${JSON.stringify(decision.element.name)}` : decision.group ? ` in ${decision.group.name}` : ""}`;
        outcome.action = decision.operation;
        if (decision.element) outcome.element = decision.element.name;
        await sleep(config.settleMs, signal);
        current = await look(step.id, "verify");
        const evaluation = evaluatePostcondition(step.postcondition, current.read, before.read);
        const record: ActionRecord = { intent: step.intent, action: decision.operation, ...(decision.element ? { element: decision.element.name } : {}),
          outcome: evaluation.holds ? (isWeakPostcondition(step.postcondition) ? "weakly_verified" : "verified") : "failed" };
        history.push(record);
        if (evaluation.holds) {
          outcome.result = record.outcome === "weakly_verified" ? "weakly_verified" : "verified";
          outcome.detail = evaluation.detail;
          break;
        }
        unchanged = visibleSignature(before.read) === visibleSignature(current.read) ? unchanged + 1 : 0;
        outcome.result = "failed";
        outcome.detail = evaluation.detail;
        if (unchanged >= NO_CHANGE_LIMIT) escalate(step.id, "no_progress", `${described} changed nothing on screen twice`, decision.prior);
        if (attempts >= (step.maxAttempts ?? DEFAULT_ATTEMPTS)) escalate(step.id, "postcondition_failed", evaluation.detail, decision.prior);
      }
    }
    await telemetry.recordPlan({ runId, outcome: "completed", steps: outcomes, decisions, actions, redact: config.redactTypedText, plan });
    return { outcome: "completed", steps: outcomes, decisions, actions };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (error.cancelled) {
      await telemetry.recordPlan({ runId, outcome: "cancelled", steps: outcomes, decisions, actions, redact: config.redactTypedText, plan });
      return { outcome: "cancelled", steps: outcomes, decisions, actions };
    }
    const escalation = { ...error.escalation!, ...(plannerView() ? { observation: plannerView() } : {}) };
    await telemetry.recordPlan({ runId, outcome: "escalated", steps: outcomes, decisions, actions, escalation, redact: config.redactTypedText, plan });
    return { outcome: "escalated", steps: outcomes, escalation, decisions, actions };
  }

  function escalateAfter(stepId: string, reason: EscalationReason, detail: string): never { return escalate(stepId, reason, detail); }
}

function summarize(decision: Decision): Record<string, unknown> {
  if (decision.kind === "act") return { kind: "act", operation: decision.operation, element: decision.element?.name, group: decision.group?.name, risk: decision.risk, prior: decision.prior };
  if (decision.kind === "reobserve") return { kind: "reobserve", prior: decision.prior };
  return { kind: "escalate", reason: decision.reason, detail: decision.detail, prior: decision.prior };
}
