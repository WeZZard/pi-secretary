import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildGuardianRequest, buildGuardianRequests, expectedVerdict, GUARDIAN_QUESTIONS, guardianVerdict, guardianVerdictAll,
  type Effect, type Environment, type GuardedAction, type PermissionMode, type Reach,
} from "../../extensions/secretary/computer-use/guardian.ts";

const deleteDialog: GuardedAction = {
  app: "Finder", window: "Documents", action: "click", control: { role: "AXButton", name: "Delete" },
  shownText: ["Are you sure you want to delete “Q3 report.pdf”?", "You can’t undo this action."],
};
const answers = (effect: string, reach: string, confidence = 0.99) =>
  ({ effect: { choice: effect, confidence }, reach: { choice: reach, confidence } });

test("the same action always gives the same request, byte for byte, with no seed", () => {
  const a = JSON.stringify(buildGuardianRequest(deleteDialog));
  const b = JSON.stringify(buildGuardianRequest(structuredClone(deleteDialog)));
  assert.equal(a, b);
  const body = buildGuardianRequest(deleteDialog);
  assert.equal(body.samples, 1);
  assert.ok(!("seed" in body));
  assert.deepEqual(Object.keys(body.questions), ["effect", "reach"]);
  assert.equal(body.questions.effect, GUARDIAN_QUESTIONS.effect);
});

test("the state keeps the design's key order and omits absent values", () => {
  const typed = buildGuardianRequest({ app: "TextEdit", window: "Draft.txt", action: "type",
    control: { role: "AXTextArea", name: "Draft", value: "Hello" }, text: "world", shownText: [] }).state as Record<string, unknown>;
  assert.deepEqual(Object.keys(typed), ["app", "window", "action", "control", "control_value", "text"]);
  assert.equal(typed.control, 'TextArea "Draft"');
  const key = buildGuardianRequest({ app: "Finder", window: "Documents", action: "key", keys: "cmd+delete",
    control: { role: "AXRow", name: "ignored for keys" } }).state as Record<string, unknown>;
  assert.deepEqual(key, { app: "Finder", window: "Documents", action: "key", keys: "cmd+delete" });
  assert.ok(Object.values(key).every(value => value !== null));
});

test("strings drop bidirectional marks, collapse white space and are cut with an ellipsis", () => {
  const state = buildGuardianRequest({ app: "  Calculator ", window: "‎7+3\n\n 10", action: "click",
    control: { role: "AXButton", name: "x".repeat(300) }, shownText: Array.from({ length: 20 }, (_, i) => `line ${i} ${"y".repeat(200)}`) }).state as Record<string, unknown>;
  assert.equal(state.app, "Calculator");
  assert.equal(state.window, "7+3 10");
  assert.equal(state.control, `Button ${JSON.stringify(`${"x".repeat(199)}…`)}`);
  const shown = state.shown_text as string[];
  assert.equal(shown.length, 12);
  assert.ok(shown.every(text => text.length === 160 && text.endsWith("…")));
});

test("no planner text reaches the guardian", () => {
  const state = buildGuardianRequest(deleteDialog).state as Record<string, unknown>;
  for (const key of ["goal", "step", "intent", "plan"]) assert.ok(!(key in state));
});

test("window text can only raise caution: an action with shown text is also judged without it", () => {
  const [withText, withoutText, ...rest] = buildGuardianRequests(deleteDialog);
  assert.equal(rest.length, 0);
  assert.ok("shown_text" in (withText!.state as object));
  assert.ok(!("shown_text" in (withoutText!.state as object)));
  assert.deepEqual({ ...(withText!.state as object), shown_text: undefined }, { ...(withoutText!.state as object), shown_text: undefined });
  assert.equal(buildGuardianRequests({ ...deleteDialog, shownText: [" "] }).length, 1, "blank text sends one request");
  assert.equal(guardianVerdictAll([answers("none", "local"), answers("destroy", "outside")], "auto", "ephemeral"), "ask");
  assert.equal(guardianVerdictAll([answers("none", "local"), answers("change", "local")], "auto", "persistent"), "proceed");
  assert.equal(guardianVerdictAll([], "auto", "ephemeral"), "ask");
  assert.equal(guardianVerdictAll([undefined], "bypass", "persistent"), "proceed");
});

const table: [Reach, Effect, Environment, "proceed" | "ask"][] = [
  ["outside", "none", "ephemeral", "ask"], ["outside", "destroy", "persistent", "ask"],
  ["local", "destroy", "ephemeral", "proceed"], ["local", "destroy", "persistent", "ask"],
  ["local", "change", "persistent", "proceed"], ["local", "none", "ephemeral", "proceed"],
];
for (const [reach, effect, environment, verdict] of table) {
  test(`auto: ${effect} with reach ${reach} in a ${environment} environment → ${verdict}`, () => {
    assert.equal(guardianVerdict(answers(effect, reach), "auto", environment), verdict);
  });
}

test("doubt goes to ask: a missing guardian, a missing answer, or a low confidence", () => {
  assert.equal(guardianVerdict(undefined, "auto", "ephemeral"), "ask");
  assert.equal(guardianVerdict({ effect: { choice: "none", confidence: 0.99 }, reach: null }, "auto", "ephemeral"), "ask");
  assert.equal(guardianVerdict(answers("none", "local", 0.59), "auto", "ephemeral"), "ask");
  assert.equal(guardianVerdict(answers("none", "local", 0.59), "auto", "ephemeral", 0.4), "proceed");
  // A low-confidence effect with a sure local reach: treated as destroy, which an ephemeral machine allows.
  assert.equal(guardianVerdict({ effect: { choice: "none", confidence: 0.3 }, reach: { choice: "local", confidence: 0.9 } }, "auto", "ephemeral"), "proceed");
  assert.equal(guardianVerdict({ effect: { choice: "none", confidence: 0.3 }, reach: { choice: "local", confidence: 0.9 } }, "auto", "persistent"), "ask");
});

test("ask mode asks for destroy or outside anywhere; bypass never asks", () => {
  assert.equal(guardianVerdict(answers("destroy", "local"), "ask", "ephemeral"), "ask");
  assert.equal(guardianVerdict(answers("change", "local"), "ask", "persistent"), "proceed");
  assert.equal(guardianVerdict(answers("none", "outside"), "ask", "ephemeral"), "ask");
  assert.equal(guardianVerdict(undefined, "bypass", "persistent"), "proceed");
});

interface Case { id: string; set: "development" | "heldout"; category: string; action: GuardedAction; effect: Effect | null; reach: Reach }
const CATEGORIES = ["look", "change", "destroy", "outside", "lookalike", "keys", "injection"];

test("the guardian cases are well formed, unique, and both sets cover every category", () => {
  const cases = JSON.parse(readFileSync(new URL("./fixtures/guardian/cases.json", import.meta.url), "utf8")) as Case[];
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  for (const c of cases) {
    assert.ok(CATEGORIES.includes(c.category), `${c.id}: category ${c.category}`);
    assert.ok(["development", "heldout"].includes(c.set), c.id);
    assert.ok(["local", "outside"].includes(c.reach), c.id);
    assert.ok(c.reach === "outside" ? c.effect === null : ["none", "change", "destroy"].includes(c.effect!), `${c.id}: an outside case has no effect label; a local one has one`);
    assert.ok(["click", "double_click", "right_click", "type", "key"].includes(c.action.action), c.id);
    assert.ok(c.action.action === "key" ? c.action.keys : c.action.control, `${c.id}: a key case has keys; others have a control`);
    if (c.action.action === "type") assert.ok(c.action.text !== undefined, c.id);
    buildGuardianRequest(c.action);
  }
  for (const set of ["development", "heldout"]) for (const category of CATEGORIES) {
    assert.ok(cases.some(c => c.set === set && c.category === category), `${set} has no ${category} case`);
  }
  const modes: PermissionMode[] = ["auto"];
  for (const set of ["development", "heldout"]) for (const mode of modes) for (const environment of ["ephemeral", "persistent"] as Environment[]) {
    const verdicts = new Set(cases.filter(c => c.set === set).map(c => expectedVerdict(c.effect ?? "none", c.reach, mode, environment)));
    assert.deepEqual([...verdicts].sort(), ["ask", "proceed"], `${set} ${environment} needs both verdicts`);
  }
});
