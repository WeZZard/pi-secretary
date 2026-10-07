import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFINITIONS, MACOS_ACTIONS } from "../../extensions/secretary/vm-use/actions.ts";
import { DecisionServiceClient, DecisionServiceError, type DecisionResponse, type Fetch } from "../../extensions/secretary/vm-use/decision-service-client.ts";
import { observe, type Observation } from "../../extensions/secretary/vm-use/observer.ts";
import { decide } from "../../extensions/secretary/vm-use/policy.ts";
import { buildDecisionRequest, GROUNDER_MODEL_LENGTH, GROUNDER_REFERENCE, type BuiltRequest, type StepSpec } from "../../extensions/secretary/vm-use/request-builder.ts";
import { finderRead, textEditRead } from "./fixtures/trees.ts";

const finder = () => observe({ ...finderRead(), readMs: 0 }, { id: "o", maxElements: 240, maxNameLength: 48 }) as Observation;
const textEdit = () => observe({ ...textEditRead(), readMs: 0 }, { id: "o", maxElements: 240, maxNameLength: 48 }) as Observation;
const ready = (built: BuiltRequest) => { assert.equal(built.status, "ready"); return built as Extract<BuiltRequest, { status: "ready" }>; };
const recent = Array.from({ length: 5 }, (_, i) => ({ intent: `step ${i}`, action: "click", element: `Item ${i}` }));

test("a grouped window gets a routing question, one UI element question per group, operation and risk, in one stage", () => {
  const built = ready(buildDecisionRequest({ goal: "Find a file", step: { id: "s1", intent: "Search this folder" }, observation: finder(), recent }));
  assert.deepEqual(Object.keys(built.body.questions), ["region", "element_1", "element_2", "element_3", "operation", "risk"]);
  assert.deepEqual(Object.keys(built.body.questions.region!.criteria), ["toolbar", "outline", "list"]);
  assert.equal(built.body.samples, 1);
  assert.ok(Object.values(built.body.questions).every(question => !("depends_on" in question) && !("alone" in question)));
  // Design §7.2 (PS-D39): the candidates of both inputs, each described with its input.
  assert.deepEqual(Object.keys(built.body.questions.operation!.criteria), ["click", "double_click", "right_click", "scroll_up", "scroll_down", "ax_press", "ax_show_menu", "reobserve", "abstain"]);
  assert.equal(built.body.questions.operation!.criteria.double_click, DEFINITIONS.double_click, "the grounder reads the planner's definition");
  assert.match(built.body.questions.operation!.criteria.click!, /^Input events: /);
  assert.match(built.body.questions.operation!.criteria.ax_press!, /^Accessibility action: /);
  assert.match(String((built.body.state as { elements: string }).elements), /^TOOLBAR\n {2}A Button "Back"\n/);
  assert.equal(built.historyUsed, 5);
});

test("no question exceeds the grounder's 26 alternatives, even with none added to full groups", () => {
  const observation = observe({ ...finderRead({ contentItems: 60 }), readMs: 0 }, { id: "o", maxElements: 240, maxNameLength: 48 }) as Observation;
  const built = ready(buildDecisionRequest({ goal: "g", step: { id: "s", intent: "i", text: "t", keys: "cmd+a" }, observation, recent: [] }));
  for (const [id, question] of Object.entries(built.body.questions)) assert.ok(Object.keys(question.criteria).length <= 26, `${id} has ${Object.keys(question.criteria).length} options`);
  assert.equal(Object.keys(built.body.questions.element_3!.criteria).length, 26);
});

test("a small window has no routing question, and the step's literal or action decides the operations offered (design §7.2)", () => {
  const built = ready(buildDecisionRequest({ goal: "g", step: { id: "s", intent: "Type the greeting", text: "Hello" }, observation: textEdit(), recent: [] }));
  assert.equal(built.questions.region, undefined);
  assert.deepEqual(built.offered, ["type", "ax_set_value"], "A step with text is offered both ways to enter it");
  assert.deepEqual(Object.keys(built.body.questions.operation!.criteria), ["type", "ax_set_value", "reobserve", "abstain"]);
  const offered = (step: Omit<StepSpec, "id" | "intent">) => ready(buildDecisionRequest({ goal: "g", step: { id: "s", intent: "i", ...step }, observation: textEdit(), recent: [] }));
  assert.deepEqual(offered({ keys: "delete" }).offered, ["key"], "A step with keys can no longer be answered with a click");
  const typed = offered({ text: "Hello", action: "type" });
  assert.deepEqual(typed.offered, ["type"]);
  assert.equal(typed.body.questions.operation, undefined, "A fixed operation is not asked, so the grounder cannot abstain on it");
  assert.equal(typed.questions.fixedOperation, "type");
  assert.deepEqual(offered({ text: "Hello", action: "ax_set_value" }).offered, ["ax_set_value"]);
  assert.deepEqual(offered({ action: "click" }).offered, ["click"]);
  assert.deepEqual(offered({ action: "ax_press" }).offered, ["ax_press"]);
  assert.ok(!offered({}).offered.includes("type") && !offered({}).offered.includes("key") && !offered({}).offered.includes("ax_set_value"));
  assert.deepEqual(Object.keys(built.body.questions.element_1!.criteria), ["A", "B", "none"], "Every UI element question offers none");
});

test("every request carries the delegated request as written and the reference table (design §7.1, PS-D39)", () => {
  const request = "As an accessibility test, set the TextEdit document's text to Hello through its accessibility functions.";
  const built = ready(buildDecisionRequest({ goal: "Set the text", request, step: { id: "s", intent: "Set the text", text: "Hello" }, observation: textEdit(), recent: [] }));
  const state = built.body.state as Record<string, unknown>;
  assert.equal(state.request, request);
  assert.equal(state.reference, GROUNDER_REFERENCE);
  assert.deepEqual(Object.keys(state).slice(0, 4), ["goal", "step", "request", "reference"]);
  assert.match(GROUNDER_REFERENCE, /An accessibility QA tester\./);
  assert.match(GROUNDER_REFERENCE, /A mention of a disability or of an assistive technology, such as VoiceOver, is not a request for accessibility actions\./);
  const without = ready(buildDecisionRequest({ goal: "g", step: { id: "s", intent: "i" }, observation: textEdit(), recent: [] }));
  assert.equal((without.body.state as Record<string, unknown>).request, undefined);
});

test("history is dropped oldest first to fit the budget, and a request over the estimate is still built without history", () => {
  const build = (history: typeof recent, answerReserveTokens: number) =>
    buildDecisionRequest({ goal: "g", step: { id: "s", intent: "i" }, observation: finder(), recent: history, answerReserveTokens });
  const full = ready(build(recent, 0)).estimatedTokens, bare = ready(build([], 0)).estimatedTokens;
  assert.ok(bare < full);
  const trimmed = ready(build(recent, GROUNDER_MODEL_LENGTH - Math.floor((full + bare) / 2)));
  assert.ok(trimmed.historyUsed > 0 && trimmed.historyUsed < 5, "Older records are dropped first until the request fits");
  const over = ready(build(recent, GROUNDER_MODEL_LENGTH - bare + 1));
  assert.equal(over.historyUsed, 0, "Only the grounder can say that a request without history is too long");
});

test("the whole tree outline marks each offered UI element with its group and letter, and gives way to priority 1 when it does not fit (PS-D28)", () => {
  const observation = finder();
  assert.ok(observation.groups.length > 1);
  const build = (history: typeof recent, answerReserveTokens = 0) =>
    ready(buildDecisionRequest({ goal: "g", step: { id: "s", intent: "i" }, observation, recent: history, answerReserveTokens, elementDetail: "tree" }));
  const elements = (built: BuiltRequest) => String((built.body.state as Record<string, unknown>).elements);
  const full = build(recent);
  const toolbar = observation.groups.find(group => group.name === "toolbar")!.elements[0]!;
  assert.match(elements(full), new RegExp(`\\[toolbar ${toolbar.letter}\\] ${toolbar.role.replace(/^AX/, "")} `));
  assert.equal(full.historyUsed, 5);
  assert.equal(elements(full).split("\n").length, observation.outline.length);

  const bare = build([]);
  const noHistory = build(recent, GROUNDER_MODEL_LENGTH - bare.estimatedTokens);
  assert.equal(noHistory.historyUsed, 0, "History goes first");
  assert.equal(elements(noHistory), elements(full));
  const table = build(recent, GROUNDER_MODEL_LENGTH - bare.estimatedTokens + 1);
  assert.equal(elements(table), elements(ready(buildDecisionRequest({ goal: "g", step: { id: "s", intent: "i" }, observation, recent: [], elementDetail: "roles" }))),
    "Then priority 1 alone");
  assert.ok(table.smallest);
});

function response(answers: Record<string, [string, number]>): DecisionResponse {
  return { answers: Object.fromEntries(Object.entries(answers).map(([id, [choice, confidence]]) => [id, { choice, confidence }])), roundTripMs: 1 };
}

test("a step that fixes its operation acts without an operation answer, and the confidence gate skips the unasked question", () => {
  const observation = finder();
  const step = { id: "s", intent: "Search this folder", action: "click" as const };
  const built = ready(buildDecisionRequest({ goal: "g", step, observation, recent: [] }));
  assert.equal(built.body.questions.operation, undefined);
  const decision = decide({ observation, step, questions: built.questions, confidenceGate: 0.4,
    response: response({ region: ["toolbar", 0.9], element_1: ["F", 0.8], risk: ["safe", 0.9] }) });
  assert.equal(decision.kind, "act");
  assert.equal((decision as { operation: string }).operation, "click");
});

test("the policy routes on the region answer and never uses a confident answer from an unchosen group", () => {
  const observation = finder();
  const built = ready(buildDecisionRequest({ goal: "g", step: { id: "s", intent: "Search this folder" }, observation, recent: [] }));
  const decision = decide({ observation, step: { id: "s", intent: "Search" }, questions: built.questions, confidenceGate: 0.4,
    response: response({ region: ["toolbar", 0.9], element_1: ["F", 0.8], element_2: ["A", 0.99], element_3: ["B", 0.99], operation: ["click", 0.9], risk: ["safe", 0.9] }) });
  assert.equal(decision.kind, "act");
  assert.equal((decision as { element: { name: string } }).element.name, "Search");
});

test("each policy rule produces its outcome", () => {
  const observation = finder();
  const step = { id: "s", intent: "i" };
  const { questions } = ready(buildDecisionRequest({ goal: "g", step, observation, recent: [] }));
  const run = (answers: Record<string, [string, number]>, extra: Partial<Parameters<typeof decide>[0]> = {}) =>
    decide({ observation, step, questions, confidenceGate: 0.4, response: response(answers), ...extra });
  const base = { region: ["toolbar", 0.9], element_1: ["A", 0.9], operation: ["click", 0.9], risk: ["safe", 0.9] } as Record<string, [string, number]>;
  assert.equal(run({ ...base, operation: ["reobserve", 0.9] }).kind, "reobserve");
  assert.equal((run({ ...base, operation: ["abstain", 0.9] }) as { reason: string }).reason, "target_not_found");
  const risky = run({ ...base, risk: ["destructive", 0.9] });
  assert.deepEqual([risky.kind, (risky as { risk: string }).risk], ["act", "destructive"], "The risk answer is recorded and decides nothing (design §8.6)");
  const low = run({ ...base, element_1: ["A", 0.3] });
  assert.deepEqual([low.kind, (low as { reason: string }).reason, low.prior.element], ["escalate", "uncertain", "Back"], "A low-confidence answer is returned as a prior");
  const text = decide({ observation, step: { id: "s", intent: "i", text: "x" }, questions, confidenceGate: 0.4, response: response({ ...base, operation: ["type", 0.9] }) });
  assert.match((text as { detail: string }).detail, /type does not fit Button "Back"/);
  const scroll = run({ ...base, region: ["list", 0.9], operation: ["scroll_down", 0.9], element_3: ["A", 0.1] });
  assert.equal(scroll.kind, "act", "A scroll ignores the UI element answer, including its confidence");
  assert.deepEqual((scroll as { request: unknown }).request, { operation: "scroll_down", frame: { x: 200, y: 80, w: 1000, h: 1500 } });
  assert.equal((run({ ...base, region: ["sidebar", 0.9] }) as { reason: string }).reason, "grounder_unavailable");
});

test("the policy acts with the action the grounder chose, an accessibility action on the UI element's index (design §7.2, PS-D39)", () => {
  const observation = finder();
  const step = { id: "s", intent: "i" };
  const { questions } = ready(buildDecisionRequest({ goal: "g", step, observation, recent: [] }));
  const run = (answers: Record<string, [string, number]>) => decide({ observation, step, questions, confidenceGate: 0.4, response: response(answers) });
  const base = { region: ["toolbar", 0.9], element_1: ["A", 0.9], operation: ["click", 0.9], risk: ["safe", 0.9] } as Record<string, [string, number]>;
  const back = observation.groups[0]!.elements[0]!;
  assert.deepEqual((run(base) as { request: unknown }).request, { operation: "click", frame: back.frame });
  assert.deepEqual((run({ ...base, operation: ["ax_press", 0.9] }) as { request: unknown }).request, { operation: "ax_press", element: back.index });
  assert.deepEqual((run({ ...base, operation: ["ax_show_menu", 0.9] }) as { request: unknown }).request, { operation: "ax_show_menu", element: back.index });
  const text = textEdit();
  const typed = { id: "s", intent: "Set the text", text: "Hello", position: "end" as const };
  const built = ready(buildDecisionRequest({ goal: "g", step: typed, observation: text, recent: [] }));
  const set = decide({ observation: text, step: typed, questions: built.questions, confidenceGate: 0.4, response: response({ element_1: ["B", 0.9], operation: ["ax_set_value", 0.9], risk: ["safe", 0.9] }) });
  assert.deepEqual((set as { request: unknown }).request, { operation: "ax_set_value", element: 5, text: "Hello", position: "end" });
  assert.ok(MACOS_ACTIONS.every(entry => /^(Input events|Accessibility action): /.test(entry.definition)), "Every definition starts with its input");
});

test("the client reports timeout, rejection, malformed answers and usage", async () => {
  const body = { state: {}, questions: { q: { type: "choice" as const, instructions: "", criteria: { A: null, B: null } } }, samples: 1 as const };
  const reply = (status: number, text: string): Fetch => async () => ({ ok: status < 300, status, text: async () => text });
  let clock = 0;
  const ok = new DecisionServiceClient({ baseUrl: "http://jev/", timeoutMs: 1000, now: () => (clock += 250), fetch: reply(200, JSON.stringify({ answers: { q: { choice: "B", confidence: 0.7 } }, usage: { input_tokens: 42 } })) });
  assert.deepEqual(await ok.decide(body), { answers: { q: { choice: "B", confidence: 0.7 } }, inputTokens: 42, roundTripMs: 250 });
  const counted = new DecisionServiceClient({ baseUrl: "http://jev/", timeoutMs: 1000, fetch: reply(200, JSON.stringify({ answers: { q: null }, usage: { input_tokens: 42, output_tokens: 18 } })) });
  assert.equal((await counted.decide(body)).outputTokens, 18);
  // The service's wording on 2026-09-23 for a request one token over the model length.
  const overLength = JSON.stringify({ error: { message: "upstream 400: {\"error\":{\"message\":\"This model's maximum context length is 4096 tokens. However, you requested 8 output tokens and your prompt contains at least 4089 input tokens\"}}", type: "server_error" } });
  await assert.rejects(new DecisionServiceClient({ baseUrl: "http://jev", timeoutMs: 1000, fetch: reply(502, overLength) }).decide(body), (error: DecisionServiceError) => error.code === "too_large");
  await assert.rejects(new DecisionServiceClient({ baseUrl: "http://jev", timeoutMs: 1000, fetch: reply(502, "bad gateway") }).decide(body), (error: DecisionServiceError) => error.code === "failed");
  await assert.rejects(new DecisionServiceClient({ baseUrl: "http://jev", timeoutMs: 1000, fetch: reply(422, "at most 26 alternatives") }).decide(body), (error: DecisionServiceError) => error.code === "rejected");
  await assert.rejects(new DecisionServiceClient({ baseUrl: "http://jev", timeoutMs: 1000, fetch: reply(200, JSON.stringify({ answers: { q: { choice: "Z", confidence: 1 } } })) }).decide(body), (error: DecisionServiceError) => error.code === "malformed");
  const hang: Fetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(new DecisionServiceClient({ baseUrl: "http://jev", timeoutMs: 20, fetch: hang }).decide(body), (error: DecisionServiceError) => error.code === "timeout");
  let seenUrl = "";
  await new DecisionServiceClient({ baseUrl: "http://jev.home.arpa/", timeoutMs: 1000, fetch: async url => { seenUrl = url; return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { q: null } }) }; } }).decide(body);
  assert.equal(seenUrl, "http://jev.home.arpa/v1/systemone");
});

test("the priority table removes closed menus, then history, then inactive UI elements, then shortens shown text", () => {
  const value = textEditRead();
  value.appActive = true;
  value.elements.find(element => element.role === "AXButton")!.enabled = false;
  const window = value.elements.find(element => element.role === "AXWindow")!;
  value.descendantText = { [window.element_index]: `Shown ${"y".repeat(120)}` };
  const observation = observe({ ...value, readMs: 0 }, { id: "o", maxElements: 240, maxNameLength: 48 }) as Observation;
  const build = (answerReserveTokens: number, elementDetail: "names" | "roles" | "priority" = "priority") => ready(buildDecisionRequest({
    goal: "g", step: { id: "s", intent: "i" }, observation, recent, answerReserveTokens, elementDetail }));
  const elements = (built: ReturnType<typeof build>) => (built.body.state as Record<string, unknown>).elements as string;

  const full = build(0);
  assert.match(elements(full), /TextArea "Disposable document text"/);
  assert.match(elements(full), /SHOWN TEXT \(not clickable\)\n {2}"Shown y+"/);
  assert.match(elements(full), /NOT CLICKABLE NOW\n {2}Button \(no name\) disabled/);
  assert.match(elements(full), /CLOSED MENUS \(not clickable until the menu is open\)\n {2}File ▸ Save…/);
  assert.equal(full.historyUsed, 5, "Nothing is removed while the request fits");

  const fitting = (tokens: number) => build(GROUNDER_MODEL_LENGTH - tokens);
  const noMenus = fitting(full.estimatedTokens - 1);
  assert.doesNotMatch(elements(noMenus), /CLOSED MENUS/);
  assert.equal(noMenus.historyUsed, 5, "Closed menus go before any history");
  const noHistory = fitting(noMenus.estimatedTokens - 1);
  assert.ok(noHistory.historyUsed < 5);
  assert.match(elements(noHistory), /NOT CLICKABLE NOW/, "History goes before inactive elements");
  const bare = build(GROUNDER_MODEL_LENGTH - 1);
  assert.equal(bare.historyUsed, 0);
  assert.doesNotMatch(elements(bare), /NOT CLICKABLE NOW/);
  assert.match(elements(bare), /"Shown y{53}…"/, "Shown text is shortened last, and the request is still built");

  assert.doesNotMatch(elements(build(0, "roles")), /SHOWN TEXT|CLOSED MENUS/, "Roles alone is priority 1 only");
  assert.match(elements(build(0, "names")), /^WINDOW\n {2}A /);
});
