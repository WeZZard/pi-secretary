import { ActuatorError, actionsFor, parseKeyCombo } from "./actuator.ts";
import { BackendError, type BackendAction, type ExecutionBackend, type WindowRead, type WindowTarget } from "./backend/backend.ts";
import type { PermissionCheck, VmUseConfiguration } from "./configuration.ts";
import { DecisionServiceError, type DecisionRequestBody, type DecisionResponse } from "./decision-service-client.ts";
import { ActionHistory, type ActionRecord } from "./history.ts";
import { planCheckState, type ApprovalReason, type PlanCheck, type PlanChecker } from "./online-check.ts";
import { ROLE, normalize, observe, platformView, type ObservedElement, type Observation, type ObservationFailure } from "./observer.ts";
import { decide, type Decision, type EscalationReason, type Prior } from "./policy.ts";
import { buildDecisionRequest, type StepSpec, type UIElementRef } from "./request-builder.ts";
import type { Picture, Telemetry } from "./telemetry.ts";
import { compareWindows, type WindowComparison } from "./window-check.ts";
import { span, spanSync } from "./trace.ts";

/** The executor: the step loop of `vm_run_plan` (design docs/arch/vm-use.md §9 and §10). */

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
  /** The delegated request as written, the vm-use agent's first prompt; the grounder reads it (design §7.1, decision PS-D39). */
  request?: string;
  /** The mode the delegated request chose, which the planner gives in `permission_check`; without it, the configuration's (design §8.1, decision PS-D54). */
  permissionCheck?: PermissionCheck;
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
  /** Names the plan's records under `runs/` (design §12.3). */
  runId: string;
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

/** A person's answer to an approval request (design §8.4). */
export type ApprovalAnswer = "approved" | "declined" | "no_interface" | "timeout" | "cancelled";
/** A step of the plan that needs approval, with what the step says it will do and why it needs approval. */
export interface ApprovalStep { id: string; intent: string; action?: string; ui_element?: string; text?: string; keys?: string; why: ApprovalReason }
/** One request per plan, before its first step (design §8.4). */
export interface ApprovalRequest { goal: string; app: string; window?: string; steps: ApprovalStep[]; failure?: string }
/** Asks a person; the executor never asks the planner or the parent agent (design §8.4). */
export type Approver = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalAnswer>;

export interface ExecutorDependencies {
  backend: ExecutionBackend;
  grounder: Grounder;
  /** The online plan check (design §8.3); the mode `online` needs it. */
  online?: PlanChecker;
  telemetry: Telemetry;
  config: VmUseConfiguration;
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
    if ((step.action === "type" || step.action === "ax_set_value") && step.text === undefined) return problem("needs_text", `step ${step.id}: ${step.action} needs text`);
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
  const wait = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const sleep = (ms: number, signal?: AbortSignal) => span("settle wait", { ms }, () => wait(ms, signal));
  let sequence = 0;
  const nextId = deps.newId ?? (() => `run-${Date.now().toString(36)}`);
  const runId = nextId();
  const history = new ActionHistory();
  const outcomes: StepOutcome[] = plan.steps.map(step => ({ id: step.id, result: "not_run" }));
  let decisions = 0, actions = 0;
  let current: { read: WindowRead; observation: Observation } | undefined;
  let target: WindowTarget = { ...plan.target, single: true };
  // Design §8.1, decision PS-D54: the delegated request chooses the mode; the configuration does when it does not.
  const mode = plan.permissionCheck ?? config.permissionCheck;
  const permissionCheckSource = plan.permissionCheck === undefined ? "configuration" : "request";

  const checkCancelled = () => { if (signal?.aborted) throw new Stop(undefined, true); };
  const escalate = (stepId: string, reason: EscalationReason, detail: string, prior?: Prior): never =>
    { throw new Stop({ stepId, reason, detail, ...(prior ? { prior } : {}) }); };

  async function look(stepId: string, purpose: string): Promise<{ read: WindowRead; observation: Observation }> {
    for (let attempt = 1; ; attempt++) {
      checkCancelled();
      let read: WindowRead;
      try { read = await span("read window", { runId, stepId, purpose }, () => backend.readWindow(target, { screenshot: config.stepPictures, signal, label: `${runId} ${stepId}: ${purpose}` })); }
      catch (error) {
        if (error instanceof BackendError && error.code === "aborted") throw new Stop(undefined, true);
        if (error instanceof BackendError && (error.code === "window_ambiguous" || error.code === "window_not_found")) return escalate(stepId, "window_unclear", error.message);
        if (error instanceof BackendError && error.code === "state_too_large") return escalate(stepId, "state_too_large", error.message);
        return escalate(stepId, "backend_failed", error instanceof Error ? error.message : String(error));
      }
      const outcome = outcomes.find(entry => entry.id === stepId);
      if (outcome && read.evidence?.length) (outcome.evidence ??= []).push(...read.evidence);
      const result: Observation | ObservationFailure = spanSync("observe", { runId, stepId }, () => observe(read, { id: `${runId}-${String(++sequence).padStart(3, "0")}`, maxElements: config.maxElements, maxNameLength: config.maxNameLength }));
      await span("record", { what: "observation", runId, stepId }, () => telemetry.recordObservation(read, result, { attempt, purpose: `${purpose} ${stepId}` }));
      // Every later read and action uses the window this plan started on.
      target = { app: plan.target.app, windowId: read.window.windowId };
      if (result.status === "ready") return { read, observation: result };
      if (result.status === "state_too_large") return escalate(stepId, "state_too_large", result.detail);
      if (attempt > REOBSERVE_LIMIT) return escalate(stepId, "no_progress", result.detail);
      await sleep(config.settleMs, signal);
    }
  }

  try {
    // Design §8: the plan is checked, and approved when it needs it, before anything is read or sent.
    if (mode === "online") await checkPlan();
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
          buildDecisionRequest({ goal: plan.goal, ...(plan.request !== undefined ? { request: plan.request } : {}), step, observation: offeredView, recent, answerReserveTokens: config.answerReserveTokens, fromTrimStep });
        let built = build(0);
        let response: DecisionResponse | undefined;
        // The grounder counts tokens exactly and the estimate does not. A request it finds too long
        // is built again from the next trim step (design §7.3), which is safe because a decision acts on nothing.
        while (!response) {
          checkCancelled();
          try { response = await span("grounder request", { runId, stepId: step.id }, () => grounder.decide(built.body, signal)); }
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
        await span("record", { what: "step", runId, stepId: step.id }, () => telemetry.recordStep({ runId, stepId: step.id, attempt: 1, estimatedTokens: built.estimatedTokens,
          inputTokens: response.inputTokens, outputTokens: response.outputTokens, historyUsed: built.historyUsed, roundTripMs: response.roundTripMs, request: built.body, answers: response.answers, decision: summarize(decision) }));
        if (decision.kind === "reobserve") {
          if (++reobserves > REOBSERVE_LIMIT) escalate(step.id, "no_progress", "the grounder kept asking to look again", decision.prior);
          await sleep(config.settleMs, signal);
          current = await look(step.id, "reobserve");
          continue;
        }
        if (decision.kind === "escalate") escalate(step.id, decision.reason, decision.detail, decision.prior);
        if (decision.kind !== "act") break;

        let backendActions;
        try {
          // Design §7.2 (decision PS-D39): the action is sent as named. A value set keeps the field's
          // value from the read before the step, not the observer's shortened name.
          const request = decision.request.operation === "ax_set_value"
            ? { ...decision.request, value: current.read.elements.find(raw => raw.element_index === decision.element!.index)?.value }
            : decision.request;
          backendActions = actionsFor(request);
        }
        catch (error) {
          if (error instanceof ActuatorError) escalate(step.id, error.code === "untypeable_text" ? "needs_text" : "uncertain", error.message, decision.prior);
          throw error;
        }
        const before = current;
        const label = `${runId} ${step.id}: ${decision.operation}${decision.element ? ` ${JSON.stringify(decision.element.name)}` : ""}`;
        const send = async (action: BackendAction) => {
          const done = await span("act", { runId, stepId: step.id, kind: action.kind, ...(action.kind === "key" ? { key: action.key } : action.kind === "accessibility" ? { tool: action.tool } : {}) }, () => backend.act(before.read.window, { ...action, label }, signal));
          if (done.evidence?.length) (outcome.evidence ??= []).push(...done.evidence);
          // Design §11.4: the path is recorded, and nothing acts on it.
          if (done.path) (outcome.inputPaths ??= []).push(done.path);
        };
        // An action already sent is not replayed (design §11.2); its outcome is uncertain.
        const failed = (error: unknown): never => {
          if (error instanceof BackendError && error.code === "aborted") throw new Stop(undefined, true);
          return escalate(step.id, "backend_failed", error instanceof Error ? error.message : String(error), decision.prior);
        };

        // Design §9, Act: nothing checks the action; the plan was checked before its first step.
        checkCancelled();
        const pictures = { attempt: 1 } as NonNullable<StepOutcome["pictures"]>[number];
        if (before.read.screenshot) pictures.before = await span("record", { what: "picture", runId, stepId: step.id }, () => telemetry.recordPicture(runId, `${step.id}-1-before`, before.read.screenshot!));
        outcome.action = decision.operation;
        if (decision.element) outcome.element = decision.element.name;
        for (const action of backendActions) {
          checkCancelled();
          try { await send(action); }
          catch (error) { failed(error); }
        }
        actions++;
        outcome.result = "acted";
        history.push({ intent: step.intent, action: decision.operation, ...(decision.element ? { element: decision.element.name } : {}) });
        // Design §9, Read: the next step's before-read. It judges nothing.
        await sleep(config.settleMs, signal);
        current = await look(step.id, "after");
        if (current.read.screenshot) pictures.after = await span("record", { what: "picture", runId, stepId: step.id }, () => telemetry.recordPicture(runId, `${step.id}-1-after`, current!.read.screenshot!));
        if (pictures.before || pictures.after) (outcome.pictures ??= []).push(pictures);
        break;
      }
    }
    await telemetry.recordPlan({ runId, outcome: "completed", steps: outcomes, decisions, actions, redact: config.redactTypedText, permissionCheck: mode, permissionCheckSource, plan });
    await review("completed");
    return { runId, outcome: "completed", steps: outcomes, decisions, actions, ...(current ? { last: current.observation } : {}) };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (error.cancelled) {
      await telemetry.recordPlan({ runId, outcome: "cancelled", steps: outcomes, decisions, actions, redact: config.redactTypedText, permissionCheck: mode, permissionCheckSource, plan });
      await review("cancelled");
      return { runId, outcome: "cancelled", steps: outcomes, decisions, actions, ...(current ? { last: current.observation } : {}) };
    }
    const escalation = error.escalation!;
    const stopped = outcomes.find(entry => entry.id === escalation.stepId);
    if (stopped) { stopped.result = "stopped"; stopped.detail = `${escalation.reason}: ${escalation.detail}`; }
    await telemetry.recordPlan({ runId, outcome: "escalated", steps: outcomes, decisions, actions, escalation, redact: config.redactTypedText, permissionCheck: mode, permissionCheckSource, plan });
    await review(`escalated at ${escalation.stepId}: ${escalation.reason}`);
    return { runId, outcome: "escalated", steps: outcomes, escalation, decisions, actions, ...(current ? { last: current.observation } : {}) };
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

  /**
   * Design §8.3 and §8.4: the online API checks the plan, and a person approves or declines it once
   * when a step needs approval. Declined, or nobody to ask, ends the plan before anything is sent.
   */
  async function checkPlan(): Promise<void> {
    checkCancelled();
    if (!deps.online) throw new Error("the permission check mode online needs the online plan check");
    const state = planCheckState({ ...(plan.request !== undefined ? { request: plan.request } : {}), goal: plan.goal, app: plan.target.app,
      ...(plan.target.windowTitle !== undefined ? { window: plan.target.windowTitle } : {}), steps: plan.steps });
    let check: PlanCheck;
    try { check = await span("plan check", { runId }, () => deps.online!.checkPlan(state, signal)); }
    catch (error) {
      if (error instanceof DecisionServiceError && error.code === "aborted") throw new Stop(undefined, true);
      throw error;
    }
    const marked = check.steps.filter(entry => entry.needsApproval);
    let approval: { answer: ApprovalAnswer; ms: number } | undefined;
    if (marked.length) {
      checkCancelled();
      const steps: ApprovalStep[] = marked.map(entry => {
        const step = state.steps.find(candidate => candidate.id === entry.id)!;
        return { ...step, why: entry.why ?? "doubt" };
      });
      const request: ApprovalRequest = { goal: plan.goal, app: state.app, ...(state.window !== undefined ? { window: state.window } : {}), steps, ...(check.failure ? { failure: check.failure } : {}) };
      const started = Date.now();
      const answer = deps.approve ? await deps.approve(request, signal) : "no_interface";
      approval = { answer, ms: Date.now() - started };
    }
    await telemetry.recordPlanCheck({ runId, redact: config.redactTypedText, check, ...(approval ? { approval } : {}) });
    checkCancelled();
    if (!approval || approval.answer === "approved") return;
    const first = marked[0]!;
    const what = `${marked.length === 1 ? "step" : "steps"} ${marked.map(entry => entry.id).join(", ")} (${describeApproval(first.why ?? "doubt", check.failure)})`;
    if (approval.answer === "declined") escalate(first.id, "approval_denied", `a person declined the plan, which needs approval for ${what}. Nothing was sent; do not reach the goal another way`);
    escalate(first.id, "approval_required", `the plan needs a person's approval for ${what}, and ${approval.answer === "timeout" ? "nobody answered in time" : "nobody could be asked in this session"}. Nothing was sent`);
  }
}

/** Why a step needs approval, in the words the escalation and the approval dialog show (design §8.4). */
export function describeApproval(why: ApprovalReason, failure?: string): string {
  if (why === "outside_guest") return "its effect leaves the virtual machine";
  if (why === "requested") return "the task asked for approval before this kind of step";
  return failure ? `the online plan check failed: ${failure}` : "the online plan check gave no usable answer";
}

function summarize(decision: Decision): Record<string, unknown> {
  if (decision.kind === "act") return { kind: "act", operation: decision.operation, element: decision.element?.name, group: decision.group?.name, risk: decision.risk, prior: decision.prior };
  if (decision.kind === "reobserve") return { kind: "reobserve", prior: decision.prior };
  return { kind: "escalate", reason: decision.reason, detail: decision.detail, prior: decision.prior };
}
