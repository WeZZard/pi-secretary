import type { ActuatorRequest, Operation } from "./actuator.ts";
import type { ChoiceAnswer, DecisionResponse } from "./executor-client.ts";
import type { ObservedElement, ObservedGroup, Observation } from "./observer.ts";
import type { QuestionMap, StepSpec } from "./request-builder.ts";

/** Decision policy (design §8): rules applied in order after each executor response. */

export type EscalationReason = "needs_text" | "state_too_large" | "uncertain" | "already_satisfied" | "target_not_found" | "postcondition_failed" | "no_progress"
  | "approval_required" | "budget_exhausted" | "executor_unavailable" | "backend_failed" | "window_unclear" | "window_changed";

export interface Prior { region?: string; element?: string; operation?: string; confidences: Record<string, number> }

export type Decision =
  | { kind: "act"; request: ActuatorRequest; operation: Operation; group?: ObservedGroup; element?: ObservedElement; risk: string; prior: Prior }
  | { kind: "reobserve"; prior: Prior }
  | { kind: "escalate"; reason: EscalationReason; detail: string; prior: Prior };

const TEXT_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"]);

export function decide(input: {
  response: DecisionResponse; questions: QuestionMap; observation: Observation; step: StepSpec;
  allowDestructive: boolean; confidenceGate: number;
}): Decision {
  const { response, questions, observation, step } = input;
  const answer = (id: string | undefined): ChoiceAnswer | undefined => (id ? response.answers[id] ?? undefined : undefined);
  const prior: Prior = { confidences: {} };
  const note = (label: string, value: ChoiceAnswer | undefined) => { if (value) prior.confidences[label] = value.confidence; };

  let operation: Operation;
  if (questions.fixedOperation) {
    operation = questions.fixedOperation;
    prior.operation = operation;
  } else {
    const operationAnswer = answer(questions.operation);
    note("operation", operationAnswer);
    if (operationAnswer) prior.operation = operationAnswer.choice;
    if (!operationAnswer) return { kind: "escalate", reason: "executor_unavailable", detail: "the executor gave no operation answer", prior };
    // Rules 2 and 3.
    if (operationAnswer.choice === "reobserve") return { kind: "reobserve", prior };
    if (operationAnswer.choice === "abstain") return { kind: "escalate", reason: "target_not_found", detail: "the executor found no listed control for this step", prior };
    operation = operationAnswer.choice as Operation;
  }

  // Rule 4: route on the region answer; never compare confidences across questions.
  let groupIndex = 0;
  if (questions.region !== undefined) {
    const region = answer(questions.region);
    note("region", region);
    groupIndex = observation.groups.findIndex(group => group.name === region?.choice);
    if (region) prior.region = region.choice;
    if (groupIndex < 0) return { kind: "escalate", reason: "executor_unavailable", detail: "the executor gave no usable region answer", prior };
  }
  const group = observation.groups[groupIndex]!;
  const needsElement = operation !== "key_combo" && operation !== "scroll_up" && operation !== "scroll_down";
  let element: ObservedElement | undefined;
  if (needsElement) {
    const elementAnswer = answer(questions.elements[groupIndex]);
    note("element", elementAnswer);
    element = group.elements.find(candidate => candidate.letter === elementAnswer?.choice);
    if (elementAnswer) prior.element = element?.name ?? elementAnswer.choice;
    if (!element) return { kind: "escalate", reason: "target_not_found", detail: `the executor chose no control in the ${group.name} region`, prior };
  }

  // Rule 5: compatibility.
  if (operation === "enter_text" && (step.text === undefined || !TEXT_ROLES.has(element!.role))) {
    return { kind: "escalate", reason: "uncertain", detail: `enter_text does not fit ${element!.role.replace(/^AX/, "")} ${JSON.stringify(element!.name)}`, prior };
  }
  if ((operation === "scroll_up" || operation === "scroll_down") && !group.frame) {
    return { kind: "escalate", reason: "uncertain", detail: `the ${group.name} region cannot be scrolled`, prior };
  }

  // Rule 6: the risk answer only adds caution.
  const risk = answer(questions.risk);
  note("risk", risk);
  if (risk?.choice === "destructive" && !input.allowDestructive) {
    return { kind: "escalate", reason: "approval_required", detail: "the executor judged this step destructive, and the plan does not allow it", prior };
  }

  // Rule 7: confidence is a safety gate on the answers actually used.
  const used = [...(questions.fixedOperation ? [] : ["operation"]), ...(questions.region !== undefined ? ["region"] : []), ...(needsElement ? ["element"] : [])];
  const low = used.filter(label => (prior.confidences[label] ?? 0) < input.confidenceGate);
  if (low.length > 0) {
    return { kind: "escalate", reason: "uncertain", detail: `confidence below ${input.confidenceGate} for ${low.join(", ")}`, prior };
  }

  // Rule 8.
  const request: ActuatorRequest = operation === "key_combo" ? { operation, keys: step.keys! }
    : operation === "scroll_up" || operation === "scroll_down" ? { operation, frame: group.frame! }
    : operation === "enter_text" ? { operation, frame: element!.frame, text: step.text!, ...(step.position ? { position: step.position } : {}) }
    : { operation, frame: element!.frame };
  return { kind: "act", request, operation, group, ...(element ? { element } : {}), risk: risk?.choice ?? "unknown", prior };
}
