import { isScroll } from "./actions.ts";
import { ActuatorError, actionsFor, parseKeyCombo } from "./actuator.ts";
import { BackendError, type ExecutionBackend, type WindowRead, type WindowTarget } from "./backend/backend.ts";
import type { ComputerUseConfiguration } from "./configuration.ts";
import { ExecutorError, type DecisionRequestBody, type DecisionResponse } from "./executor-client.ts";
import { ActionHistory, type ActionRecord } from "./history.ts";
import { observe, platformView, renderPlannerTable, type ObservedElement, type Observation, type ObservationFailure } from "./observer.ts";
import { decide, type Decision, type EscalationReason, type Prior } from "./policy.ts";
import { buildDecisionRequest, type StepSpec } from "./request-builder.ts";
import type { Picture, Telemetry } from "./telemetry.ts";
import { compareWindows, type WindowComparison } from "./window-check.ts";
import { ROLE, evaluatePostcondition, isWeakPostcondition, normalize, validatePostcondition, visibleSignature, type Postcondition } from "./verifier.ts";

/** The step harness (design docs/arch/computer-use.md §9 and §10). */

/**
 * `idempotent` marks a step that changes nothing when it is already done, such as setting a
 * checkbox on. Only such a step may be skipped when its postcondition holds before it runs
 * (fix plan F-1): a stale Calculator display made every step of a plan look done (observed 2026-09-23).
 */
export interface PlanStep extends StepSpec { postcondition: Postcondition; maxAttempts?: number; idempotent?: boolean; control?: ControlRef }

/** The control a step acts on, copied from a line of the observation (design §5.2, decision PS-D4). */
export interface ControlRef { name: string; role?: string; region?: string }

const describeControl = (control: ControlRef) =>
  `${control.role ? `${control.role.replace(/^AX/, "")} ` : ""}${JSON.stringify(control.name)}${control.region ? ` in ${control.region}` : ""}`;

/**
 * The elements of an observation that a step's control names (design §9, control check). Name and
 * role must match. The region only chooses among matches, because group names change with the
 * window's size: a small window is one group named "window", and a large one splits into several.
 */
export function controlMatches(observation: Observation, control: ControlRef): ObservedElement[] {
  const wanted = normalize(control.name);
  const found = observation.groups.flatMap(group => group.elements).filter(element => normalize(element.name) === wanted
    && (control.role === undefined || element.role === control.role || element.role === `AX${control.role}`));
  const inRegion = control.region === undefined ? [] : found.filter(element => normalize(element.group) === normalize(control.region!));
  return inRegion.length ? inRegion : found;
}
export interface Plan {
  target: WindowTarget; goal: string; steps: PlanStep[]; allowDestructive: string[];
  /** The `based_on` observation, which the first read must still match (design §9, start check). */
  basedOn?: WindowComparison;
  /** The last read of the previous plan, when it ran after `basedOn`: a change this harness made itself. */
  previous?: WindowComparison;
}

export interface StepOutcome {
  id: string;
  result: "verified" | "weakly_verified" | "skipped" | "failed" | "not_run";
  action?: string;
  element?: string;
  detail?: string;
  /** Fix plan F-4: window pictures before and after each attempt, when step pictures are on. */
  pictures?: { attempt: number; before?: Picture; after?: Picture }[];
  /** Relay step identifiers of the step's reads and actions, in order, to find its screenshots (design §12.1). */
  evidence?: string[];
  /** The driver's input path of each action the step sent (design §11.4). */
  inputPaths?: string[];
}

export interface Escalation { stepId: string; reason: EscalationReason; detail: string; prior?: Prior; observation?: string }

export interface PlanResult {
  outcome: "completed" | "escalated" | "cancelled";
  steps: StepOutcome[];
  escalation?: Escalation;
  /** Executor decisions kept out of the planner (design §12.2): requests whose answer was acted on or escalated. */
  decisions: number;
  actions: number;
  /** The last read of the plan, which a later plan's start check may accept. */
  last?: Observation;
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
/**
 * An action that changed the screen but missed its postcondition is not repeated unless the step is
 * idempotent: through Pi, a second press of Calculator's Add followed a first press that had taken
 * effect (observed 2026-09-23). A second press of Send would send twice.
 */
const DEFAULT_ATTEMPTS = 1;
const DEFAULT_IDEMPOTENT_ATTEMPTS = 2;
/**
 * A scroll only moves the view, so a repeat cannot act twice. Through Pi, every scroll toward a file
 * below the visible list needed a new plan once scrolls acted only once (observed 2026-09-23); the
 * fixture's target took two pages.
 */
const DEFAULT_SCROLL_ATTEMPTS = 3;

/** A rejected plan and the rule that rejected it, recorded per rule (design §12.1). */
export interface PlanProblem { rule: string; message: string }

/**
 * Returns the first reason the plan cannot run, before any action (design §5.2, decision PS-D3).
 * It rejects only a plan that cannot run, or one that asks to repeat an action that could act twice;
 * it never guesses what the planner meant or what the window will show.
 */
export function validatePlan(plan: Plan, maxSteps: number): PlanProblem | undefined {
  const problem = (rule: string, message: string): PlanProblem => ({ rule, message });
  if (plan.steps.length === 0) return problem("no_steps", "the plan has no steps");
  if (plan.steps.length > maxSteps) return problem("too_many_steps", `the plan has ${plan.steps.length} steps; the limit is ${maxSteps}`);
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) return problem("repeated_step_id", `step id ${JSON.stringify(step.id)} is repeated`);
    ids.add(step.id);
    const invalid = validatePostcondition(step.postcondition);
    if (invalid) return problem("postcondition", `step ${step.id}: ${invalid}`);
    if (step.action === "type" && step.text === undefined) return problem("needs_text", `step ${step.id}: type needs text`);
    if (step.action === "key" && step.keys === undefined) return problem("needs_keys", `step ${step.id}: key needs keys`);
    if (step.text !== undefined && step.keys !== undefined) return problem("text_and_keys", `step ${step.id}: a step has text or keys, not both; split it into two steps`);
    if (step.keys !== undefined) {
      try { parseKeyCombo(step.keys); }
      catch (error) { return problem("keys", `step ${step.id}: ${(error as Error).message}`); }
    }
    if (step.maxAttempts !== undefined && (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 5)) return problem("max_attempts", `step ${step.id}: maxAttempts must be 1 to 5`);
    if ((step.maxAttempts ?? 1) > 1 && step.idempotent !== true && !isScroll(step.action)) {
      return problem("unsafe_repeat", `step ${step.id}: max_attempts above 1 needs idempotent: true or a scroll operation, because repeating an action that took effect could act twice`);
    }
    if (step.idempotent !== undefined && typeof step.idempotent !== "boolean") return problem("idempotent", `step ${step.id}: idempotent must be true or false`);
    if (step.control !== undefined) {
      if (!step.control.name.trim()) return problem("control", `step ${step.id}: control needs a name`);
      if (step.control.role !== undefined && !ROLE.test(step.control.role)) return problem("control", `step ${step.id}: control role ${JSON.stringify(step.control.role)} is not an accessibility role such as Button or TextField`);
    }
  }
  for (const id of plan.allowDestructive) if (!ids.has(id)) return problem("unknown_destructive_step", `allowDestructive names unknown step ${JSON.stringify(id)}`);
  return undefined;
}

/** A key that only moves the insertion point or the selection, which the accessibility tree does not show. */
const isNavigationKey = (keys: string | undefined) => keys !== undefined && NAVIGATION_KEYS.has(keys.toLowerCase().split("+").pop()!.trim());

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
  let target: WindowTarget = { ...plan.target, single: true };

  const checkCancelled = () => { if (signal?.aborted) throw new Stop(undefined, true); };
  const plannerView = () => current ? renderPlannerTable(current.observation) : undefined;
  const escalate = (stepId: string, reason: EscalationReason, detail: string, prior?: Prior): never =>
    { throw new Stop({ stepId, reason, detail, ...(prior ? { prior } : {}) }); };

  async function look(stepId: string, purpose: string): Promise<{ read: WindowRead; observation: Observation }> {
    for (let attempt = 1; ; attempt++) {
      checkCancelled();
      let read: WindowRead;
      try { read = await backend.readWindow(target, { screenshot: config.stepPictures, signal, label: `${runId} ${stepId}: ${purpose}` }); }
      catch (error) {
        if (error instanceof BackendError && error.code === "aborted") throw new Stop(undefined, true);
        if (error instanceof BackendError && (error.code === "window_ambiguous" || error.code === "window_not_found")) return escalate(stepId, "window_unclear", error.message);
        if (error instanceof BackendError && error.code === "state_too_large") return escalate(stepId, "state_too_large", error.message);
        return escalate(stepId, "backend_failed", error instanceof Error ? error.message : String(error));
      }
      const outcome = outcomes.find(entry => entry.id === stepId);
      if (outcome && read.evidence?.length) (outcome.evidence ??= []).push(...read.evidence);
      const result: Observation | ObservationFailure = observe(read, { id: `${runId}-${String(++sequence).padStart(3, "0")}`, maxElements: config.maxElements, maxNameLength: config.maxNameLength });
      await telemetry.recordObservation(read, result, { attempt, purpose: `${purpose} ${stepId}` });
      // Every later read and action uses the window this plan started on.
      target = { app: plan.target.app, windowId: read.window.windowId };
      if (result.status === "ready") return { read, observation: result };
      if (result.status === "state_too_large") return escalate(stepId, "state_too_large", result.detail);
      if (attempt > REOBSERVE_LIMIT) return escalate(stepId, "no_progress", result.detail);
      await sleep(config.settleMs, signal);
    }
  }

  try {
    current = await look(plan.steps[0]!.id, "initial");
    // Start check (design §9): the window must still be the one the plan was written against.
    if (plan.basedOn) {
      const verdict = compareWindows(plan.basedOn, current.observation.comparison);
      if (verdict.stop && !(plan.previous && !compareWindows(plan.previous, current.observation.comparison).stop)) {
        escalate(plan.steps[0]!.id, "window_changed", `the window changed since the observation the plan was based on: ${verdict.reasons.join("; ")}. No action was taken`);
      }
    }
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
        // Control check (design §9): the named control must be in this read before the executor is asked.
        const named = step.control ? controlMatches(observation, step.control) : undefined;
        if (step.control && !named!.length) escalate(step.id, "target_not_found", `the control the step names, ${describeControl(step.control)}, is not in the window; no action was taken`);
        // Design §6.5 and §7.2: iOS actions are not built yet, so a step names only a macOS control,
        // and the executor is offered only macOS elements.
        if (named?.length && named.every(element => element.platform === "ios")) {
          escalate(step.id, "target_not_found", `the control the step names, ${describeControl(step.control!)}, is on the iOS screen, and iOS targets are not supported yet; no action was taken`);
        }
        const offeredView = platformView(observation, "macos");
        const recent = history.recent();
        const build = (fromTrimStep: number) =>
          buildDecisionRequest({ goal: plan.goal, step, observation: offeredView, recent, answerReserveTokens: config.answerReserveTokens, fromTrimStep });
        let built = build(0);
        let response: DecisionResponse | undefined;
        // The executor counts tokens exactly and the estimate does not. A request it finds too long
        // is built again from the next trim step (design §7.3), which is safe because a decision acts on nothing.
        while (!response) {
          checkCancelled();
          try { response = await executor.decide(built.body, signal); }
          catch (error) {
            if (error instanceof ExecutorError && error.code === "aborted") throw new Stop(undefined, true);
            if (error instanceof ExecutorError && error.code === "too_large") {
              if (!built.smallest) { built = build(built.trimStep + 1); continue; }
              escalate(step.id, "state_too_large", `the window is too large for the executor even with everything optional removed (estimated ${built.estimatedTokens} tokens): ${error.message}`);
            }
            return escalateAfter(step.id, "executor_unavailable", error instanceof Error ? error.message : String(error));
          }
        }
        decisions++;
        const decision: Decision = decide({ response, questions: built.questions, observation: offeredView, step,
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
        // The named control cross-checks the executor's choice (decision PS-D4).
        if (named && decision.element && !named.some(element => element.index === decision.element!.index)) {
          escalate(step.id, "uncertain", `the executor chose ${JSON.stringify(decision.element.name)} in ${decision.element.group}, not the control the step names, ${describeControl(step.control!)}; no action was taken`, decision.prior);
        }

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
          const label = `${runId} ${step.id}: ${decision.operation}${decision.element ? ` ${JSON.stringify(decision.element.name)}` : ""}`;
          try {
            const done = await backend.act(before.read.window, { ...action, label }, signal);
            if (done.evidence?.length) (outcome.evidence ??= []).push(...done.evidence);
            if (done.path) (outcome.inputPaths ??= []).push(done.path);
          }
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
          // Advice moved from a removed plan rule (design §5.2): the typed words can land in the wrong place.
          outcome.detail = step.text !== undefined && !checksText(step.postcondition)
            ? `${evaluation.detail}; the typed text itself was not checked, which only a {text} or {value} postcondition does` : evaluation.detail;
          break;
        }
        unchanged = visibleSignature(before.read) === visibleSignature(current.read) ? unchanged + 1 : 0;
        outcome.result = "failed";
        outcome.detail = evaluation.detail;
        if (unchanged >= NO_CHANGE_LIMIT) {
          escalate(step.id, "no_progress", `${described} changed nothing on screen; it was not repeated${isScroll(decision.operation) ? ", because the view has reached its end" : ", because a repeat could act twice"}`
            // Advice moved from a removed plan rule (design §5.2).
            + (decision.operation === "key" && isNavigationKey(step.keys) ? `. ${step.keys} only moves the insertion point, which the accessibility tree does not show; set position on the type step instead` : ""), decision.prior);
        }
        const repeatable = step.idempotent === true || isScroll(decision.operation);
        const limit = repeatable ? step.maxAttempts ?? (isScroll(decision.operation) ? DEFAULT_SCROLL_ATTEMPTS : DEFAULT_IDEMPOTENT_ATTEMPTS) : DEFAULT_ATTEMPTS;
        if (attempts >= limit) {
          escalate(step.id, "postcondition_failed", !repeatable
            ? `${evaluation.detail}. The action changed the screen, so it was not repeated; a repeat could act twice.` : evaluation.detail, decision.prior);
        }
      }
    }
    await telemetry.recordPlan({ runId, outcome: "completed", steps: outcomes, decisions, actions, redact: config.redactTypedText, plan });
    await review("completed");
    return { outcome: "completed", steps: outcomes, decisions, actions, ...(current ? { last: current.observation } : {}) };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (error.cancelled) {
      await telemetry.recordPlan({ runId, outcome: "cancelled", steps: outcomes, decisions, actions, redact: config.redactTypedText, plan });
      await review("cancelled");
      return { outcome: "cancelled", steps: outcomes, decisions, actions, ...(current ? { last: current.observation } : {}) };
    }
    const escalation = { ...error.escalation!, ...(plannerView() ? { observation: plannerView() } : {}) };
    await telemetry.recordPlan({ runId, outcome: "escalated", steps: outcomes, decisions, actions, escalation, redact: config.redactTypedText, plan });
    await review(`escalated at ${escalation.stepId}: ${escalation.reason}`);
    return { outcome: "escalated", steps: outcomes, escalation, decisions, actions, ...(current ? { last: current.observation } : {}) };
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

/** True when a postcondition checks text content somewhere, as a type step must (fix plan F-3). */
function checksText(condition: Postcondition): boolean {
  if ("all" in condition) return condition.all.some(checksText);
  if ("any" in condition) return condition.any.every(checksText);
  return "text" in condition || "value" in condition;
}

function summarize(decision: Decision): Record<string, unknown> {
  if (decision.kind === "act") return { kind: "act", operation: decision.operation, element: decision.element?.name, group: decision.group?.name, risk: decision.risk, prior: decision.prior };
  if (decision.kind === "reobserve") return { kind: "reobserve", prior: decision.prior };
  return { kind: "escalate", reason: decision.reason, detail: decision.detail, prior: decision.prior };
}
