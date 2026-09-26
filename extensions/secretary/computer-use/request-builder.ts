import { DEFINITIONS } from "./actions.ts";
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
export interface StepSpec { id: string; intent: string; action?: Operation; text?: string; keys?: string; position?: TextPosition }

export interface QuestionMap {
  region?: string;
  /** Element question id per group index. */
  elements: string[];
  /** Absent when the step fixes the operation; `fixedOperation` then holds it. */
  operation?: string;
  fixedOperation?: Operation;
  risk: string;
}

/** The executor decides whether a request fits (design §7.3), so the builder always returns a request. */
export interface BuiltRequest { status: "ready"; body: DecisionRequestBody; questions: QuestionMap; offered: Operation[]; estimatedTokens: number; historyUsed: number;
  /** The trim step this request was built at. When the executor finds it too long, build again from the next one (design §7.3). */
  trimStep: number;
  /** No trim step is left; a request the executor finds too long cannot be made smaller. */
  smallest: boolean }

/** The executor's model length (research §2.2). */
export const EXECUTOR_MODEL_LENGTH = 4096;
/**
 * The largest answer one executor read can need. The answer's length depends only on the
 * question ids, so it is fixed by the group count: 18 tokens for one group, 127 for 25, and 26
 * groups split into two reads (research §13).
 */
export const ANSWER_RESERVE_TOKENS = 128;

const hiddenNote = (group: { hidden?: number }) => group.hidden ? `; ${group.hidden} more items are hidden beyond the visible area and need scrolling` : "";
const REOBSERVE = "The window is still changing or loading, so look again before acting.";
const ABSTAIN = "No listed control can carry out the step.";

/**
 * Estimated input tokens. It chooses how much history to send and nothing else, because it was
 * off by -17 to +26 percent against the service's `usage.input_tokens` (research §13).
 */
export const estimateTokens = (body: DecisionRequestBody): number => Math.ceil(JSON.stringify(body).length / 3);

/**
 * The planner decides the operation whenever the step says it: `keys` means key, `text` means
 * type, and a named action is the only one offered. The executor then chooses only the
 * element and the risk. Through Pi, a step with keys was answered with a click, which clicked the
 * text area instead of pressing the key (observed 2026-09-23).
 */
export function offeredOperations(step: StepSpec, observation: Observation): Operation[] {
  const hasElements = observation.groups.some(group => group.elements.length > 0);
  const scrollable = observation.groups.some(group => group.frame);
  if (step.keys !== undefined) return ["key"];
  if (step.text !== undefined) return hasElements ? ["type"] : [];
  const available: Operation[] = [...(hasElements ? ["click", "double_click", "right_click"] as const : []), ...(scrollable ? ["scroll_up", "scroll_down"] as const : [])];
  return step.action ? available.filter(operation => operation === step.action) : available;
}

/**
 * `names`: each region option's description lists its members' names, so a router can find a
 * name even when the group name carries no meaning, such as "content part 2".
 * `none`: region options have no description, as in the 2026-09-22 routing measurement.
 */
export type RegionDescriptions = "none" | "names";

/**
 * How the executor's `elements` field describes the window (design §6.2, decision PS-D5).
 * `names`: letter and name, cut at the name length (the table measured in research §4.5).
 * `roles`: letter, role, name cut at 200 characters, and state: priority 1 alone.
 * `priority`: priority 1, then shown text, controls that cannot be clicked now and closed menus,
 * removed from the lowest priority when the request is too large (design §7.3).
 */
export type ElementDetail = "names" | "roles" | "priority";

/** Priority 1 alone: as accurate as the full priority model and more accurate than names (research §16.7). */
export const DEFAULT_ELEMENT_DETAIL: ElementDetail = "roles";

/** A shown text is shortened to this length when nothing else is left to remove (design §7.3). */
const SHORT_TEXT_LENGTH = 60;

function clickableLine(element: Observation["groups"][number]["elements"][number], detail: ElementDetail): string {
  if (detail === "names") return `  ${element.letter} ${element.name}`;
  const state = [element.selected ? "selected" : "", element.value !== undefined ? `value=${JSON.stringify(element.value)}` : ""].filter(Boolean).join(" ");
  return `  ${element.letter} ${element.role.replace(/^AX/, "")} ${JSON.stringify(element.fullName)}${state ? ` ${state}` : ""}`;
}

/** The executor's view of a read, as the first request for a step would carry it (design §6.2). */
export function renderExecutorTable(observation: Observation, detail: ElementDetail = DEFAULT_ELEMENT_DETAIL): string {
  return renderElements(observation, detail, { menus: true, inactive: true, shortTexts: false });
}

/** The `elements` text. Only the clickable table carries letters; the other sections are context. */
function renderElements(observation: Observation, detail: ElementDetail, parts: { menus: boolean; inactive: boolean; shortTexts: boolean }): string {
  const table = observation.groups.map(group =>
    `${group.name.toUpperCase()}\n${group.elements.map(element => clickableLine(element, detail)).join("\n")}${group.hidden ? `\n  (${group.hidden} more hidden below; scroll to reveal)` : ""}`).join("\n");
  if (detail !== "priority") return table;
  const sections = [table];
  const texts = (observation.texts ?? []).map(text => parts.shortTexts && text.length > SHORT_TEXT_LENGTH ? `${text.slice(0, SHORT_TEXT_LENGTH - 1)}…` : text);
  if (texts.length) sections.push(`SHOWN TEXT (not clickable)\n${texts.map(text => `  ${JSON.stringify(text)}`).join("\n")}`);
  if (parts.inactive && observation.context.inactive.length) sections.push(`NOT CLICKABLE NOW\n${observation.context.inactive.map(line => `  ${line}`).join("\n")}`);
  if (parts.menus && observation.context.menus.length) sections.push(`CLOSED MENUS (not clickable until the menu is open)\n${observation.context.menus.map(line => `  ${line}`).join("\n")}`);
  return sections.join("\n");
}

export function buildDecisionRequest(input: {
  goal: string; step: StepSpec; observation: Observation; recent: ActionRecord[]; answerReserveTokens?: number;
  regionDescriptions?: RegionDescriptions;
  /** Offer "none" in every element question. It is on by default; the switch exists for evaluation. */
  noneOption?: boolean;
  /** How `elements` describes the window (design §6.2); the other values exist for evaluation. */
  elementDetail?: ElementDetail;
  /** The first trim step to try, after the executor found a larger request too long. */
  fromTrimStep?: number;
}): BuiltRequest {
  const { goal, step, observation } = input;
  const offered = offeredOperations(step, observation);
  const multi = observation.groups.length > 1;
  const questions: Record<string, ChoiceQuestion> = {};
  // When the step fixes the operation there is nothing to ask: through Pi, the executor answered
  // abstain to a one-option operation question for a clear text-entry step (observed 2026-09-23).
  // A missing target is still reported through each element question's "none".
  const fixed = offered.length === 1 && (step.keys !== undefined || step.text !== undefined || step.action !== undefined) ? offered[0] : undefined;
  const map: QuestionMap = { elements: [], risk: "risk", ...(fixed ? { fixedOperation: fixed } : { operation: "operation" }) };

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
  if (!fixed) questions.operation = { type: "choice", instructions: `Which action carries out the current step?${step.action ? ` The planner expects ${step.action}.` : ""}`,
    criteria: { ...Object.fromEntries(offered.map(operation => [operation, DEFINITIONS[operation]])), reobserve: REOBSERVE, abstain: ABSTAIN } };
  questions.risk = { type: "choice", instructions: "How risky is carrying out the current step?", criteria: {
    safe: "It only reads, selects, navigates or types, and changes nothing lasting.",
    reversible: "It changes something that can be undone, such as editing text or moving an item.",
    destructive: "It deletes, sends, purchases, overwrites or closes without saving, and cannot easily be undone.",
  } };

  const detail = input.elementDetail ?? DEFAULT_ELEMENT_DETAIL;
  const budget = EXECUTOR_MODEL_LENGTH - (input.answerReserveTokens ?? ANSWER_RESERVE_TOKENS);
  // Remove content from the lowest priority until the estimate fits (design §7.3): closed menus,
  // then history from the oldest, then controls that cannot be clicked now, then shorten shown text.
  // The last candidate is sent even when the estimate is over, because only the executor counts exactly.
  // The estimate undercounts menu paths by about a third (research §16.7), so the caller builds again
  // from the next step when the executor finds a request too long.
  const candidates: { menus: boolean; inactive: boolean; shortTexts: boolean; used: number }[] = [];
  const all = input.recent.length;
  if (detail === "priority") candidates.push({ menus: true, inactive: true, shortTexts: false, used: all });
  for (let used = all; used >= 0; used--) candidates.push({ menus: false, inactive: true, shortTexts: false, used });
  if (detail === "priority") candidates.push({ menus: false, inactive: false, shortTexts: false, used: 0 }, { menus: false, inactive: false, shortTexts: true, used: 0 });
  const first = Math.min(input.fromTrimStep ?? 0, candidates.length - 1);
  for (const [index, candidate] of candidates.entries()) {
    if (index < first) continue;
    const recent = input.recent.slice(all - candidate.used);
    const state: Record<string, unknown> = {
      goal, step: step.intent, app: observation.window.app, window: observation.window.title, elements: renderElements(observation, detail, candidate),
      ...(recent.length ? { recent: recent.map(formatRecord) } : {}),
    };
    const body: DecisionRequestBody = { state, questions, samples: 1 };
    const estimatedTokens = estimateTokens(body);
    if (estimatedTokens <= budget || index === candidates.length - 1) return { status: "ready", body, questions: map, offered, estimatedTokens, historyUsed: recent.length,
      trimStep: index, smallest: index === candidates.length - 1 };
  }
  throw new Error("unreachable");
}
