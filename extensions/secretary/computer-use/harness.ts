import { ActuatorError, actionsFor, parseKeyCombo } from "./actuator.ts";
import { BackendError, type ExecutionBackend, type WindowRead, type WindowTarget } from "./backend/backend.ts";
import type { ComputerUseConfiguration } from "./configuration.ts";
import { ExecutorError, type DecisionRequestBody, type DecisionResponse } from "./executor-client.ts";
import { ActionHistory, type ActionRecord } from "./history.ts";
import { observe, renderPlannerTable, type Observation, type ObservationFailure } from "./observer.ts";
import { decide, type Decision, type EscalationReason, type Prior } from "./policy.ts";
import { buildDecisionRequest, type StepSpec } from "./request-builder.ts";
import type { Picture, Telemetry } from "./telemetry.ts";
import { evaluatePostcondition, isWeakPostcondition, validatePostcondition, visibleSignature, type Postcondition } from "./verifier.ts";

/** The step harness (design docs/arch/computer-use.md §9 and §10). */

/**
 * `idempotent` marks a step that changes nothing when it is already done, such as setting a
 * checkbox on. Only such a step may be skipped when its postcondition holds before it runs
 * (fix plan F-1): a stale Calculator display made every step of a plan look done (observed 2026-09-23).
 */
export interface PlanStep extends StepSpec { postcondition: Postcondition; maxAttempts?: number; idempotent?: boolean }
export interface Plan { target: WindowTarget; goal: string; steps: PlanStep[]; allowDestructive: string[] }

export interface StepOutcome {
  id: string;
  result: "verified" | "weakly_verified" | "skipped" | "failed" | "not_run";
  action?: string;
  element?: string;
  detail?: string;
  /** Fix plan F-4: window pictures before and after each attempt, when step pictures are on. */
  pictures?: { attempt: number; before?: Picture; after?: Picture }[];
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
/**
 * An action that changes nothing visible is not repeated (fix plan F-7). Through Pi, a click into a
 * text area and Cmd+Down were each sent twice because the tree did not change, and a repeated press
 * of a button such as Send could act twice (observed 2026-09-23).
 */
const NO_CHANGE_LIMIT = 1;
/** Keys that only move the insertion point or the selection; the accessibility tree does not show their effect. */
const NAVIGATION_KEYS = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);
const DEFAULT_ATTEMPTS = 2;

/** Returns the first problem with a plan, before any action (design §5.2). */
export function validatePlan(plan: Plan, maxSteps: number, basedOn?: Observation): string | undefined {
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
    if (step.text !== undefined && step.keys !== undefined) return `step ${step.id}: a step has text or keys, not both; split it into two steps`;
    if (step.keys !== undefined) {
      try { parseKeyCombo(step.keys); }
      catch (error) { return `step ${step.id}: ${(error as Error).message}`; }
    }
    if (step.maxAttempts !== undefined && (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 5)) return `step ${step.id}: maxAttempts must be 1 to 5`;
    if (step.idempotent !== undefined && typeof step.idempotent !== "boolean") return `step ${step.id}: idempotent must be true or false`;
    if (step.text !== undefined && !checksText(step.postcondition)) {
      return `step ${step.id}: an enter_text step must check the typed text with {text:{endsWith}}, {text:{contains}} or {value:{name,equals}}`;
    }
    if (step.operation === "key_combo" && step.keys !== undefined && isWeakPostcondition(step.postcondition)
      && NAVIGATION_KEYS.has(step.keys.toLowerCase().split("+").pop()!.trim())) {
      return `step ${step.id}: ${step.keys} only moves the insertion point, which the accessibility tree does not show, so {changed:true} cannot verify it; set position on the enter_text step instead`;
    }
    if (basedOn) {
      const label = labelUsedAsText(step.postcondition, basedOn);
      if (label) return `step ${step.id}: text ${JSON.stringify(label)} is the name of a control, and text checks search only what the window shows; use {exists:{name:${JSON.stringify(label)}}} to check a control`;
    }
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
      try { read = await backend.readWindow(plan.target, { screenshot: config.stepPictures, signal }); }
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
      // Precheck (design §9, fix plan F-1): a postcondition that already holds cannot show that the
      // step did anything. Only an idempotent step is skipped; any other step stops the plan.
      const precheck = isWeakPostcondition(step.postcondition) ? undefined : evaluatePostcondition(step.postcondition, current.read);
      if (precheck?.holds) {
        if (!step.idempotent) {
          escalate(step.id, "already_satisfied", `the postcondition already held before the step (${precheck.detail}), so it cannot show that the step worked. `
            + "Write a postcondition that is false now, or mark the step idempotent if doing it again changes nothing.");
        }
        outcome.result = "skipped";
        outcome.detail = `idempotent, and the postcondition already held (${precheck.detail})`;
        history.push({ intent: step.intent, action: "none", outcome: "skipped" });
        continue;
      }
      let attempts = 0, reobserves = 0, unchanged = 0;
      for (;;) {
        if (actions >= config.maxActionsPerPlan) escalate(step.id, "budget_exhausted", `the plan used its ${config.maxActionsPerPlan} actions`);
        const observation = current.observation;
        const build = (recent: ReturnType<typeof history.recent>) =>
          buildDecisionRequest({ goal: plan.goal, step, observation, recent, answerReserveTokens: config.answerReserveTokens });
        let built = build(history.recent());
        let response: DecisionResponse | undefined;
        // The executor counts tokens exactly and the estimate does not. A request it finds too long
        // is sent once more without history, which is safe because a decision acts on nothing.
        while (!response) {
          checkCancelled();
          try { response = await executor.decide(built.body, signal); }
          catch (error) {
            if (error instanceof ExecutorError && error.code === "aborted") throw new Stop(undefined, true);
            if (error instanceof ExecutorError && error.code === "too_large") {
              if (built.historyUsed > 0) { built = build([]); continue; }
              escalate(step.id, "state_too_large", `the window is too large for the executor even without history (estimated ${built.estimatedTokens} tokens): ${error.message}`);
            }
            return escalateAfter(step.id, "executor_unavailable", error instanceof Error ? error.message : String(error));
          }
        }
        decisions++;
        const decision: Decision = decide({ response, questions: built.questions, observation: current.observation, step,
          allowDestructive: plan.allowDestructive.includes(step.id), confidenceGate: config.confidenceGate });
        await telemetry.recordStep({ runId, stepId: step.id, attempt: attempts + 1, estimatedTokens: built.estimatedTokens,
          inputTokens: response.inputTokens, outputTokens: response.outputTokens, historyUsed: built.historyUsed, roundTripMs: response.roundTripMs, request: built.body, answers: response.answers, decision: summarize(decision) });
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
        const pictures = { attempt: attempts + 1 } as NonNullable<StepOutcome["pictures"]>[number];
        if (before.read.screenshot) pictures.before = await telemetry.recordPicture(runId, `${step.id}-${attempts + 1}-before`, before.read.screenshot);
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
        if (current.read.screenshot) pictures.after = await telemetry.recordPicture(runId, `${step.id}-${attempts}-after`, current.read.screenshot);
        if (pictures.before || pictures.after) (outcome.pictures ??= []).push(pictures);
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
        if (unchanged >= NO_CHANGE_LIMIT) {
          escalate(step.id, "no_progress", `${described} changed nothing on screen; it was not repeated, because a repeat could act twice`, decision.prior);
        }
        if (attempts >= (step.maxAttempts ?? DEFAULT_ATTEMPTS)) escalate(step.id, "postcondition_failed", evaluation.detail, decision.prior);
      }
    }
    await telemetry.recordPlan({ runId, outcome: "completed", steps: outcomes, decisions, actions, redact: config.redactTypedText, plan });
    await review("completed");
    return { outcome: "completed", steps: outcomes, decisions, actions };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (error.cancelled) {
      await telemetry.recordPlan({ runId, outcome: "cancelled", steps: outcomes, decisions, actions, redact: config.redactTypedText, plan });
      await review("cancelled");
      return { outcome: "cancelled", steps: outcomes, decisions, actions };
    }
    const escalation = { ...error.escalation!, ...(plannerView() ? { observation: plannerView() } : {}) };
    await telemetry.recordPlan({ runId, outcome: "escalated", steps: outcomes, decisions, actions, escalation, redact: config.redactTypedText, plan });
    await review(`escalated at ${escalation.stepId}: ${escalation.reason}`);
    return { outcome: "escalated", steps: outcomes, escalation, decisions, actions };
  }

  /** Fix plan F-4: the review page is written only when pictures were taken. */
  async function review(outcome: string): Promise<void> {
    if (!config.stepPictures) return;
    const lines = [`# Review of ${runId}`, "", `Goal: ${plan.goal}`, "", `Outcome: ${outcome}`, ""];
    for (const [index, step] of plan.steps.entries()) {
      const result = outcomes[index]!;
      lines.push(`## ${step.id}`, "", `- Intent: ${step.intent}`, `- Postcondition: \`${JSON.stringify(step.postcondition)}\``,
        `- Result: ${result.result}${result.detail ? ` (${result.detail})` : ""}`);
      for (const picture of result.pictures ?? []) {
        for (const phase of ["before", "after"] as const) {
          const file = picture[phase];
          if (file) lines.push(`- Attempt ${picture.attempt}, ${phase}: ![${step.id} ${phase}](${file.file}) sha256 \`${file.sha256}\``);
        }
      }
      lines.push("");
    }
    await telemetry.recordReview(runId, lines);
  }

  function escalateAfter(stepId: string, reason: EscalationReason, detail: string): never { return escalate(stepId, reason, detail); }
}

/** True when a postcondition checks text content somewhere, as an enter_text step must (fix plan F-3). */
function checksText(condition: Postcondition): boolean {
  if ("all" in condition) return condition.all.some(checksText);
  if ("any" in condition) return condition.any.every(checksText);
  return "text" in condition || "value" in condition;
}

/** The first `text { contains }` string that equals a control's name in the observation (fix plan F-8). */
export function labelUsedAsText(condition: Postcondition, observation: Observation): string | undefined {
  if ("all" in condition || "any" in condition) {
    for (const part of "all" in condition ? condition.all : condition.any) {
      const found = labelUsedAsText(part, observation);
      if (found) return found;
    }
    return undefined;
  }
  if (!("text" in condition)) return undefined;
  const target = "endsWith" in condition.text ? condition.text.endsWith : condition.text.contains;
  const wanted = target.replace(/\s+/g, " ").trim().toLowerCase();
  const isControl = observation.groups.some(group => group.elements.some(element =>
    element.name.toLowerCase() === wanted && !(element.value !== undefined && element.value.toLowerCase().includes(wanted))));
  const shown = (observation.texts ?? []).some(text => text.toLowerCase().includes(wanted));
  return isControl && !shown ? target : undefined;
}

function summarize(decision: Decision): Record<string, unknown> {
  if (decision.kind === "act") return { kind: "act", operation: decision.operation, element: decision.element?.name, group: decision.group?.name, risk: decision.risk, prior: decision.prior };
  if (decision.kind === "reobserve") return { kind: "reobserve", prior: decision.prior };
  return { kind: "escalate", reason: decision.reason, detail: decision.detail, prior: decision.prior };
}
