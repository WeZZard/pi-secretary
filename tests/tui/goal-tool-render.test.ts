/**
 * Goal tool rendering tests — verbatim implementation of the approved designs.
 *
 * create_goal: one line "Create Goal: <goal contents>(, <token budget>)",
 * budget only when set; identical while running, after completion, collapsed,
 * and expanded.
 *
 * update_goal: call "<Complete|Pause|Block> Goal: <objective>"; result
 * compact "<Action> Goal. Consumed <tokens> tokens; Used <elapsed>(; Budget
 * <budget> tokens)" tinted with the widget status color; expanded appends a
 * blank line and "Objective: <objective>"; failures keep the call line above
 * a red "Error: <message>" result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { goalHarness } from "../support/goal-harness.ts";
import { type ThreadGoal } from "../../extensions/secretary/goal/goal-record.ts";

const ANSI_COLORS: Record<string, string> = {
  accent: "\x1b[36m", success: "\x1b[32m", muted: "\x1b[90m", error: "\x1b[31m", warning: "\x1b[33m",
};

const themeStub = () => {
  const calls: Array<{ color: string; text: string }> = [];
  const theme = {
    calls,
    fg(color: string, text: string) { calls.push({ color, text }); return `${ANSI_COLORS[color] ?? "\x1b[37m"}${text}\x1b[39m`; },
    bold: (text: string) => text,
  };
  return theme;
};

const render = (component: { render(width: number): string[] }, width = 80): string =>
  component.render(width).map((line) => line.trimEnd()).join("\n").trimEnd();

/** Text without ANSI styling — the terminal-visible characters. */
const renderPlain = (component: { render(width: number): string[] }, width = 80): string =>
  render(component, width).replace(/\x1b\[[0-9;]*m/g, "");

const contextFor = (toolCallId: string, invalidate: () => void = () => {}) =>
  ({ args: {}, toolCallId, invalidate, lastComponent: undefined, state: {}, cwd: "/tmp" });

const goalFixture = (partial: Partial<ThreadGoal>): ThreadGoal => ({
  threadId: "t",
  goalId: "g",
  objective: "Report format",
  status: "complete",
  tokensUsed: 2700,
  timeUsedSeconds: 100,
  createdAt: Date.UTC(2026, 0, 1),
  updatedAt: 0,
  ...partial,
});

const successResult = (goal: ThreadGoal | null, remaining: number | null = null) =>
  ({ content: [{ type: "text", text: "snapshot" }], details: { goal, remaining_tokens: remaining } });

// ---- create_goal ------------------------------------------------------------

test("C1: create_goal call without a budget renders the design line", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const create = h.tools.get("create_goal");
  assert.equal(render(create.renderCall({ objective: "Ship the widget" }, themeStub(), contextFor("c1"))),
    "Create Goal: Ship the widget");
});

test("C2: create_goal call with a budget appends the raw budget number", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const create = h.tools.get("create_goal");
  assert.equal(render(create.renderCall({ objective: "Ship the widget", token_budget: 25000 }, themeStub(), contextFor("c2"))),
    "Create Goal: Ship the widget, 25000");
});

test("C3: create_goal result renders the same design line, collapsed and expanded", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const create = h.tools.get("create_goal");
  const context = { ...contextFor("c3"), args: { objective: "Ship the widget", token_budget: 25000 } };
  for (const expanded of [false, true]) {
    assert.equal(
      render(create.renderResult(successResult(null), { expanded, isPartial: false }, themeStub(), context)),
      "Create Goal: Ship the widget, 25000", `expanded=${expanded} makes no change`);
  }
});

test("C4: create_goal renders no tint on the design line", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const create = h.tools.get("create_goal");
  const theme = themeStub();
  render(create.renderCall({ objective: "Ship the widget" }, theme, contextFor("c4")));
  render(create.renderResult(successResult(null), { expanded: false, isPartial: false }, theme,
    { ...contextFor("c4"), args: { objective: "Ship the widget" } }));
  assert.deepEqual(theme.calls, [], "the design line carries no theme color");
});

test("C5: after completion the create_goal call collapses and the row is one line", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const create = h.tools.get("create_goal");
  let invalidated = 0;
  const context = { ...contextFor("c5", () => { invalidated++; }), args: { objective: "Ship the widget" } };
  assert.equal(render(create.renderCall({ objective: "Ship the widget" }, themeStub(), context)),
    "Create Goal: Ship the widget");
  await h.emit("tool_execution_end", { toolCallId: "c5", toolName: "create_goal", isError: false });
  assert.equal(invalidated, 1, "completion invalidates the call region");
  assert.deepEqual(create.renderCall({ objective: "Ship the widget" }, themeStub(), context).render(80), [],
    "the call region renders zero lines after completion");
  assert.equal(render(create.renderResult(successResult(null), { expanded: false, isPartial: false }, themeStub(), context)),
    "Create Goal: Ship the widget", "the result keeps the design line");
});

// ---- update_goal ------------------------------------------------------------

test("U1: update_goal call renders '<Action> Goal: <objective>'", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  await h.tool("create_goal", { objective: "Report format" });
  const update = h.tools.get("update_goal");
  assert.equal(render(update.renderCall({ status: "complete" }, themeStub(), contextFor("u1"))),
    "Complete Goal: Report format");
  assert.equal(render(update.renderCall({ status: "paused" }, themeStub(), contextFor("u1b"))),
    "Pause Goal: Report format");
  assert.equal(render(update.renderCall({ status: "blocked" }, themeStub(), contextFor("u1c"))),
    "Block Goal: Report format");
});

test("U2: update_goal result compact without a budget", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const update = h.tools.get("update_goal");
  assert.equal(
    renderPlain(update.renderResult(successResult(goalFixture({}), null),
      { expanded: false, isPartial: false }, themeStub(), contextFor("u2"))),
    "Complete Goal. Consumed 2.7K tokens; Used 1 min 40 sec");
});

test("U3: update_goal result compact with a budget appends the budget segment", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const update = h.tools.get("update_goal");
  assert.equal(
    renderPlain(update.renderResult(successResult(goalFixture({ tokenBudget: 25000 }), 22300),
      { expanded: false, isPartial: false }, themeStub(), contextFor("u3"))),
    "Complete Goal. Consumed 2.7K tokens; Used 1 min 40 sec; Budget 25K tokens");
});

test("U4: update_goal result expanded appends the objective", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const update = h.tools.get("update_goal");
  assert.equal(
    renderPlain(update.renderResult(successResult(goalFixture({}), null),
      { expanded: true, isPartial: false }, themeStub(), contextFor("u4"))),
    "Complete Goal. Consumed 2.7K tokens; Used 1 min 40 sec\n\nObjective: Report format");
});

test("U5: update_goal result is tinted with the widget status color", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const update = h.tools.get("update_goal");
  const cases: Array<[ThreadGoal["status"], string]> = [["complete", "success"], ["paused", "muted"], ["blocked", "error"]];
  for (const [status, color] of cases) {
    const theme = themeStub();
    render(update.renderResult(successResult(goalFixture({ status }), null),
      { expanded: false, isPartial: false }, theme, contextFor(`u5-${status}`)));
    assert.deepEqual(theme.calls.map((call) => call.color), [color], `${status} tints ${color}`);
  }
});

test("U6: after completion the update_goal call collapses and the row is one line", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  await h.tool("create_goal", { objective: "Report format" });
  const update = h.tools.get("update_goal");
  let invalidated = 0;
  const context = contextFor("u6", () => { invalidated++; });
  assert.equal(render(update.renderCall({ status: "complete" }, themeStub(), context)),
    "Complete Goal: Report format");
  await h.emit("tool_execution_end", { toolCallId: "u6", toolName: "update_goal", isError: false });
  assert.equal(invalidated, 1, "completion invalidates the call region");
  assert.deepEqual(update.renderCall({ status: "complete" }, themeStub(), context).render(80), [],
    "the call region renders zero lines after completion");
});

test("U7: a failed update_goal keeps its call line above the red error result", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  await h.tool("create_goal", { objective: "Report format" });
  const update = h.tools.get("update_goal");
  const context = contextFor("u7");
  assert.equal(render(update.renderCall({ status: "complete" }, themeStub(), context)),
    "Complete Goal: Report format");
  await h.emit("tool_execution_end", { toolCallId: "u7", toolName: "update_goal", isError: true });
  assert.equal(render(update.renderCall({ status: "complete" }, themeStub(), context)),
    "Complete Goal: Report format", "a failed call keeps its line");
  const theme = themeStub();
  assert.equal(
    renderPlain(update.renderResult({ content: [{ type: "text", text: "no goal" }], details: undefined },
      { expanded: false, isPartial: false }, theme, context)),
    "Error: no goal");
  assert.deepEqual(theme.calls.map((call) => call.color), ["error"], "the error result renders red");
});
