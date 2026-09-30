import { isScroll } from "./actions.ts";
import { ActuatorError, actionsFor, parseKeyCombo } from "./actuator.ts";
import { BackendError, type ExecutionBackend, type WindowRead, type WindowTarget } from "./backend/backend.ts";
import type { ComputerUseConfiguration } from "./configuration.ts";
import { DecisionServiceError, type DecisionRequestBody, type DecisionResponse } from "./decision-service-client.ts";
import { judgeAction, type Environment, type GuardedAction, type Judgment } from "./guardian.ts";
import { ActionHistory, type ActionRecord } from "./history.ts";
import { ROLE, normalize, observe, platformView, type ObservedElement, type Observation, type ObservationFailure } from "./observer.ts";
import { decide, type Decision, type EscalationReason, type Prior } from "./policy.ts";
import { buildDecisionRequest, type StepSpec, type UIElementRef } from "./request-builder.ts";
import type { Picture, Telemetry } from "./telemetry.ts";
import { compareWindows, type WindowComparison } from "./window-check.ts";

/** The executor: the step loop of `computer_run_plan` (design docs/arch/computer-use.md §9 and §10). */

/**
 * A plan step carries no check: the planner judges the plan's result from the window after it, and
 * each step acts once (design §5.3, decision PS-D19).
 */
export type PlanStep = StepSpec;

/**
 * The UI elements of an observation that a step's UI element names. Only a plan's validation uses it,
 * against the observation the planner copied the name from (design §6.5); the executor never matches
 * a name against a later read (decision PS-D24). Name and role must match. The region only chooses
 * among matches, because group names change with the window's size.
 */
export function uiElementMatches(observation: Observation, ref: UIElementRef): ObservedElement[] {
  const wanted = normalize(ref.name);
  const found = observation.groups.flatMap(group => group.elements).filter(element => normalize(element.name) === wanted
    && (ref.role === undefined || element.role === ref.role || element.role === `AX${ref.role}`));
  const inRegion = ref.region === undefined ? [] : found.filter(element => normalize(element.group) === normalize(ref.region!));
  return inRegion.length ? inRegion : found;
}
export interface Plan {
  target: WindowTarget; goal: string; steps: PlanStep[];
  /** The actions the task says a person must approve first, in the task's words (design §8.4). It only adds approvals. */
  askBefore?: string;
  /** The `based_on` observation, which the first read must still match (design §9, start check). */
  basedOn?: WindowComparison;
  /** The last read of the previous plan, when it ran after `basedOn`: a change this executor made itself. */
  previous?: WindowComparison;
}

export interface StepOutcome {
  id: string;
  /** `acted`: input was sent, which says nothing about whether the step achieved its intent (design §5.4). */
  result: "acted" | "stopped" | "not_run";
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

export interface Escalation { stepId: string; reason: EscalationReason; detail: string; prior?: Prior }

export interface PlanResult {
  outcome: "completed" | "escalated" | "cancelled";
  steps: StepOutcome[];
  escalation?: Escalation;
  /** Grounder decisions kept out of the planner (design §12.2): requests whose answer was acted on or escalated. */
  decisions: number;
  actions: number;
  /** The last read of the plan, which a later plan's start check may accept. */
  last?: Observation;
}

export interface Grounder { decide(body: DecisionRequestBody, signal?: AbortSignal): Promise<DecisionResponse> }

/** A person's answer to an approval request (design §8.5). */
export type ApprovalAnswer = "approved" | "declined" | "no_interface" | "timeout" | "cancelled";
export interface ApprovalRequest { goal: string; intent: string; action: GuardedAction; judgment: Judgment }
/** Asks a person; the executor never asks the planner or the parent agent (design §8.5). */
export type Approver = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalAnswer>;

/** Design §8.2: the environment is a fact of the backend, never a model's judgment. */
export const environmentOf = (backend: ExecutionBackend): Environment => backend.kind === "local" ? "persistent" : "ephemeral";

export interface ExecutorDependencies {
  backend: ExecutionBackend;
  grounder: Grounder;
  telemetry: Telemetry;
  config: ComputerUseConfiguration;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  newId?: () => string;
  /** Absent when no person can be asked, such as in a session without an interface. */
  approve?: Approver;
}

const REOBSERVE_LIMIT = 2;

/** A rejected plan and the rule that rejected it, recorded per rule (design §12.1). */
export interface PlanProblem { rule: string; message: string }

/**
 * Returns the first reason the plan cannot run, before any action (design §5.2, decision PS-D3).
 * It rejects only a plan that cannot run; it never guesses what the planner meant or what the window will show.
 */
export function validatePlan(plan: Plan, maxSteps: number): PlanProblem | undefined {
  const problem = (rule: string, message: string): PlanProblem => ({ rule, message });
  if (plan.steps.length === 0) return problem("no_steps", "the plan has no steps");
  if (plan.steps.length > maxSteps) return problem("too_many_steps", `the plan has ${plan.steps.length} steps; the limit is ${maxSteps}`);
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) return problem("repeated_step_id", `step id ${JSON.stringify(step.id)} is repeated`);
    ids.add(step.id);
    if (step.action === "type" && step.text === undefined) return problem("needs_text", `step ${step.id}: type needs text`);
    if (step.action === "key" && step.keys === undefined) return problem("needs_keys", `step ${step.id}: key needs keys`);
    if (step.text !== undefined && step.keys !== undefined) return problem("text_and_keys", `step ${step.id}: a step has text or keys, not both; split it into two steps`);
    if (step.keys !== undefined) {
      try { parseKeyCombo(step.keys); }
      catch (error) { return problem("keys", `step ${step.id}: ${(error as Error).message}`); }
    }
    if (step.ui_element !== undefined) {
      if (!step.ui_element.name.trim()) return problem("ui_element", `step ${step.id}: UI element needs a name`);
      if (step.ui_element.role !== undefined && !ROLE.test(step.ui_element.role)) return problem("ui_element", `step ${step.id}: UI element role ${JSON.stringify(step.ui_element.role)} is not an accessibility role such as Button or TextField`);
    }
  }
  return undefined;
}

class Stop extends Error {
  readonly escalation?: Escalation;
  readonly cancelled: boolean;
  constructor(escalation: Escalation | undefined, cancelled = false) { super(escalation?.detail ?? "cancelled"); this.escalation = escalation; this.cancelled = cancelled; }
}

export async function runPlan(deps: ExecutorDependencies, plan: Plan, signal?: AbortSignal): Promise<PlanResult> {
  const { backend, grounder, telemetry, config } = deps;
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
      // Design §9: nothing is checked before a step, and the step acts once (decision PS-D19).
      let reobserves = 0;
      for (;;) {
        const observation = current.observation;
        // Design §9: the grounder chooses the UI element, with the step's named UI element as the
        // planner's pointer; no code matches the name against this read (decision PS-D24). It is offered
        // only macOS UI elements, because iOS actions are not built yet (design §6.5).
        const offeredView = platformView(observation, "macos");
        const recent = history.recent();
        const build = (fromTrimStep: number) =>
          buildDecisionRequest({ goal: plan.goal, step, observation: offeredView, recent, answerReserveTokens: config.answerReserveTokens, fromTrimStep });
        let built = build(0);
        let response: DecisionResponse | undefined;
        // The grounder counts tokens exactly and the estimate does not. A request it finds too long
        // is built again from the next trim step (design §7.3), which is safe because a decision acts on nothing.
        while (!response) {
          checkCancelled();
          try { response = await grounder.decide(built.body, signal); }
          catch (error) {
            if (error instanceof DecisionServiceError && error.code === "aborted") throw new Stop(undefined, true);
            if (error instanceof DecisionServiceError && error.code === "too_large") {
              if (!built.smallest) { built = build(built.trimStep + 1); continue; }
              escalate(step.id, "state_too_large", `the window is too large for the grounder even with everything optional removed (estimated ${built.estimatedTokens} tokens): ${error.message}`);
            }
            return escalateAfter(step.id, "grounder_unavailable", error instanceof Error ? error.message : String(error));
          }
        }
        decisions++;
        const decision: Decision = decide({ response, questions: built.questions, observation: offeredView, step, confidenceGate: config.confidenceGate });
        await telemetry.recordStep({ runId, stepId: step.id, attempt: 1, estimatedTokens: built.estimatedTokens,
          inputTokens: response.inputTokens, outputTokens: response.outputTokens, historyUsed: built.historyUsed, roundTripMs: response.roundTripMs, request: built.body, answers: response.answers, decision: summarize(decision) });
        if (decision.kind === "reobserve") {
          if (++reobserves > REOBSERVE_LIMIT) escalate(step.id, "no_progress", "the grounder kept asking to look again", decision.prior);
          await sleep(config.settleMs, signal);
          current = await look(step.id, "reobserve");
          continue;
        }
        if (decision.kind === "escalate") escalate(step.id, decision.reason, decision.detail, decision.prior);
        if (decision.kind !== "act") break;

        // Design §8.6: the chosen action is judged before any input is sent. Scrolls only move the view.
        if (!isScroll(decision.operation)) await permit(step, decision, observation, 1);

        let backendActions;
        try { backendActions = actionsFor(decision.request); }
        catch (error) {
          if (error instanceof ActuatorError) escalate(step.id, error.code === "untypeable_text" ? "needs_text" : "uncertain", error.message, decision.prior);
          throw error;
        }
        // Set before the input, so a step that stops after its input was sent still names it.
        outcome.action = decision.operation;
        if (decision.element) outcome.element = decision.element.name;
        const before = current;
        const pictures = { attempt: 1 } as NonNullable<StepOutcome["pictures"]>[number];
        if (before.read.screenshot) pictures.before = await telemetry.recordPicture(runId, `${step.id}-1-before`, before.read.screenshot);
        for (const action of backendActions) {
          checkCancelled();
          const label = `${runId} ${step.id}: ${decision.operation}${decision.element ? ` ${JSON.stringify(decision.element.name)}` : ""}`;
          try {
            const done = await backend.act(before.read.window, { ...action, label }, signal);
            if (done.evidence?.length) (outcome.evidence ??= []).push(...done.evidence);
            if (done.path) (outcome.inputPaths ??= []).push(done.path);
            // Design §11.4: in ordinary mode an action the driver performed through accessibility is
            // not real input. It may have taken effect, so it is neither repeated nor continued.
            if (done.path === "ax" && config.inputMode === "ordinary") {
              escalate(step.id, "input_mode", `the driver performed ${decision.operation}${decision.element ? ` ${JSON.stringify(decision.element.name)}` : ""} through accessibility (path ax), which ordinary input mode does not allow; it may have taken effect, so it was not repeated`, decision.prior);
            }
          }
          catch (error) {
            if (error instanceof Stop) throw error;
            // An action already sent is not replayed (design §11.2); its outcome is uncertain.
            if (error instanceof BackendError && error.code === "aborted") throw new Stop(undefined, true);
            escalate(step.id, "backend_failed", error instanceof Error ? error.message : String(error), decision.prior);
          }
        }
        actions++;
        outcome.result = "acted";
        history.push({ intent: step.intent, action: decision.operation, ...(decision.element ? { element: decision.element.name } : {}) });
        // Design §9, Read: the next step's before-read. It judges nothing.
        await sleep(config.settleMs, signal);
        current = await look(step.id, "after");
        if (current.read.screenshot) pictures.after = await telemetry.recordPicture(runId, `${step.id}-1-after`, current.read.screenshot);
        if (pictures.before || pictures.after) (outcome.pictures ??= []).push(pictures);
        break;
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
    const escalation = error.escalation!;
    const stopped = outcomes.find(entry => entry.id === escalation.stepId);
    if (stopped) { stopped.result = "stopped"; stopped.detail = `${escalation.reason}: ${escalation.detail}`; }
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
      lines.push(`## ${step.id}`, "", `- Intent: ${step.intent}`,
        `- Result: ${result.result.replace("_", " ")}${result.action ? `, ${result.action}${result.element ? ` ${JSON.stringify(result.element)}` : ""}` : ""}${result.detail ? ` (${result.detail})` : ""}`);
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

  /** Design §8.5, §8.6 and §12.1: judge the action, ask a person when the verdict is ask, and record both. */
  async function permit(step: PlanStep, decision: Extract<Decision, { kind: "act" }>, observation: Observation, attempt: number): Promise<void> {
    const action: GuardedAction = {
      app: observation.window.app, window: observation.window.title ?? "", action: decision.operation as GuardedAction["action"],
      ...(decision.element ? { ui_element: { role: decision.element.role, name: decision.element.fullName, ...(decision.element.value !== undefined ? { value: decision.element.value } : {}) } } : {}),
      ...(decision.operation === "type" && step.text !== undefined ? { text: step.text } : {}),
      ...(decision.operation === "key" && step.keys !== undefined ? { keys: step.keys } : {}),
      ...(observation.texts?.length ? { shownText: observation.texts } : {}),
    };
    let judgment: Judgment;
    try {
      judgment = await judgeAction(grounder, action, { mode: config.permissionMode, environment: environmentOf(backend), gate: config.permissionGate,
        think: config.permissionThink, ...(plan.askBefore ? { askBefore: plan.askBefore } : {}), ...(signal ? { signal } : {}) });
    } catch (error) {
      if (error instanceof DecisionServiceError && error.code === "aborted") throw new Stop(undefined, true);
      throw error;
    }
    let approval: { answer: ApprovalAnswer; ms: number } | undefined;
    if (judgment.verdict === "ask") {
      const started = Date.now();
      checkCancelled();
      const answer = deps.approve ? await deps.approve({ goal: plan.goal, intent: step.intent, action, judgment }, signal) : "no_interface";
      approval = { answer, ms: Date.now() - started };
    }
    await telemetry.recordPermission({ runId, stepId: step.id, attempt, redact: config.redactTypedText, action, judgment, ...(approval ? { approval } : {}) });
    checkCancelled();
    if (!approval || approval.answer === "approved") return;
    const what = `${decision.operation}${decision.element ? ` ${JSON.stringify(decision.element.name)}` : step.keys ? ` ${step.keys}` : ""}`;
    const why = describeJudgment(judgment);
    if (approval.answer === "declined") escalate(step.id, "approval_denied", `a person declined ${what} (${why}). Nothing was sent; do not reach the goal another way`, decision.prior);
    escalate(step.id, "approval_required", `${what} needs a person's approval (${why}), and ${approval.answer === "timeout" ? "nobody answered in time" : "nobody could be asked in this session"}. Nothing was sent`, decision.prior);
  }
}

/** Why a person is asked, in the words the escalation and the approval dialog show (design §8.5). */
export function describeJudgment(judgment: Judgment): string {
  if (judgment.reason === "ask_before") return "the task asked for approval before this kind of action";
  if (judgment.reason === "doubt") return "the permission guardian could not judge it with confidence";
  const answers = judgment.requests.find(request => request.purpose === "with_text")?.answers;
  const effect = answers?.effect?.choice, reach = answers?.reach?.choice;
  if (reach === "outside") return "the permission guardian judged that its effect leaves this machine";
  if (effect === "destroy") return `the permission guardian judged that it destroys data${judgment.environment === "persistent" ? " on a machine that persists" : ""}`;
  return "the permission guardian judged it needs approval";
}

function summarize(decision: Decision): Record<string, unknown> {
  if (decision.kind === "act") return { kind: "act", operation: decision.operation, element: decision.element?.name, group: decision.group?.name, risk: decision.risk, prior: decision.prior };
  if (decision.kind === "reobserve") return { kind: "reobserve", prior: decision.prior };
  return { kind: "escalate", reason: decision.reason, detail: decision.detail, prior: decision.prior };
}
