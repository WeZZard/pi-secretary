import type { Operation } from "./actuator.ts";
import type { ChoiceQuestion, DecisionRequestBody } from "./executor-client.ts";
import { formatRecord, type ActionRecord } from "./history.ts";
import type { Observation } from "./observer.ts";

/**
 * One executor request per step, every question answered in one stage (design §7.1). The
 * request never uses depends_on or alone (research §4.3), and samples is pinned to 1.
 */

/** `position` places the insertion point before text entry with fixed keys (fix plan F-3). */
export type TextPosition = "end" | "start" | "replace";
export interface StepSpec { id: string; intent: string; operation?: Operation; text?: string; keys?: string; position?: TextPosition }

export interface QuestionMap {
  region?: string;
  /** Element question id per group index. */
  elements: string[];
  operation: string;
  risk: string;
}

/** The executor decides whether a request fits (design §7.3), so the builder always returns a request. */
export interface BuiltRequest { status: "ready"; body: DecisionRequestBody; questions: QuestionMap; offered: Operation[]; estimatedTokens: number; historyUsed: number }

/** The executor's model length (research §2.2). */
export const EXECUTOR_MODEL_LENGTH = 4096;
/**
 * The largest answer one executor read can need. The answer's length depends only on the
 * question ids, so it is fixed by the group count: 18 tokens for one group, 127 for 25, and 26
 * groups split into two reads (research §13).
 */
export const ANSWER_RESERVE_TOKENS = 128;

const OPERATION_TEXT: Record<Operation, string> = {
  press: "Click the chosen element once.",
  double_press: "Double-click the chosen element.",
  context_press: "Right-click the chosen element to open its context menu.",
  enter_text: "Click the chosen text field and type the step's text.",
  key_combo: "Press the step's key combination; no element is needed.",
  scroll_up: "Scroll the chosen region up by one page.",
  scroll_down: "Scroll the chosen region down by one page, to reveal controls below the visible part.",
};
const hiddenNote = (group: { hidden?: number }) => group.hidden ? `; ${group.hidden} more items are hidden beyond the visible area and need scrolling` : "";
const REOBSERVE = "The window is still changing or loading, so look again before acting.";
const ABSTAIN = "No listed control can carry out the step.";

/**
 * Estimated input tokens. It chooses how much history to send and nothing else, because it was
 * off by -17 to +26 percent against the service's `usage.input_tokens` (research §13).
 */
export const estimateTokens = (body: DecisionRequestBody): number => Math.ceil(JSON.stringify(body).length / 3);

export function offeredOperations(step: StepSpec, observation: Observation): Operation[] {
  const hasElements = observation.groups.some(group => group.elements.length > 0);
  const operations: Operation[] = hasElements ? ["press", "double_press", "context_press"] : [];
  if (step.text !== undefined && hasElements) operations.push("enter_text");
  if (step.keys !== undefined) operations.push("key_combo");
  if (observation.groups.some(group => group.frame)) operations.push("scroll_up", "scroll_down");
  return operations;
}

/**
 * `names`: each region option's description lists its members' names, so a router can find a
 * name even when the group name carries no meaning, such as "content part 2".
 * `none`: region options have no description, as in the 2026-09-22 routing measurement.
 */
export type RegionDescriptions = "none" | "names";

export function buildDecisionRequest(input: {
  goal: string; step: StepSpec; observation: Observation; recent: ActionRecord[]; answerReserveTokens?: number;
  regionDescriptions?: RegionDescriptions;
  /** Offer "none" in every element question. It is on by default; the switch exists for evaluation. */
  noneOption?: boolean;
}): BuiltRequest {
  const { goal, step, observation } = input;
  const offered = offeredOperations(step, observation);
  const multi = observation.groups.length > 1;
  const questions: Record<string, ChoiceQuestion> = {};
  const map: QuestionMap = { elements: [], operation: "operation", risk: "risk" };

  if (multi) {
    map.region = "region";
    questions.region = { type: "choice", instructions: "Which region of the window holds the control that carries out the current step?",
      criteria: Object.fromEntries(observation.groups.map(group => [group.name,
        (input.regionDescriptions ?? "names") === "names" ? `Contains: ${group.elements.map(element => element.name).join(", ")}${hiddenNote(group)}` : null])) };
  }
  observation.groups.forEach((group, index) => {
    const id = `element_${index + 1}`;
    map.elements.push(id);
    questions[id] = { type: "choice",
      instructions: multi ? `If the answer is the ${group.name} region, which of its controls carries out the current step?`
        : "Which control carries out the current step?",
      criteria: Object.fromEntries(group.elements.map(element => [element.letter, null])) };
  });
  // Every element question offers "none", because the executor otherwise acted on a wrong
  // control in 15 of 18 recorded cases whose target was not listed (research §9). It also
  // gives a one-element group the second option a choice requires.
  for (const id of map.elements) {
    if (input.noneOption !== false || Object.keys(questions[id]!.criteria).length < 2) questions[id]!.criteria["none"] = "None of these controls carries out the step.";
  }
  questions.operation = { type: "choice", instructions: `Which action carries out the current step?${step.operation ? ` The planner expects ${step.operation}.` : ""}`,
    criteria: { ...Object.fromEntries(offered.map(operation => [operation, OPERATION_TEXT[operation]])), reobserve: REOBSERVE, abstain: ABSTAIN } };
  questions.risk = { type: "choice", instructions: "How risky is carrying out the current step?", criteria: {
    safe: "It only reads, selects, navigates or types, and changes nothing lasting.",
    reversible: "It changes something that can be undone, such as editing text or moving an item.",
    destructive: "It deletes, sends, purchases, overwrites or closes without saving, and cannot easily be undone.",
  } };

  const elements = observation.groups.map(group =>
    `${group.name.toUpperCase()}\n${group.elements.map(element => `  ${element.letter} ${element.name}`).join("\n")}${group.hidden ? `\n  (${group.hidden} more hidden below; scroll to reveal)` : ""}`).join("\n");
  const budget = EXECUTOR_MODEL_LENGTH - (input.answerReserveTokens ?? ANSWER_RESERVE_TOKENS);
  // Drop the oldest history first until the estimate fits (design §7.3). Without history the
  // request is sent even when the estimate is over, because only the executor can count exactly.
  for (let used = input.recent.length; used >= 0; used--) {
    const recent = input.recent.slice(input.recent.length - used);
    const state: Record<string, unknown> = {
      goal, step: step.intent, app: observation.window.app, window: observation.window.title, elements,
      ...(recent.length ? { recent: recent.map(formatRecord) } : {}),
    };
    const body: DecisionRequestBody = { state, questions, samples: 1 };
    const estimatedTokens = estimateTokens(body);
    if (estimatedTokens <= budget || used === 0) return { status: "ready", body, questions: map, offered, estimatedTokens, historyUsed: recent.length };
  }
  throw new Error("unreachable");
}
