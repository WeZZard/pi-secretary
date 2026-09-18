/**
 * `/goal` slash command tests — Codex parity.
 * Mirrors `codex-rs/tui/src/chatwidget/slash_dispatch.rs` goal handling:
 * `/goal <objective>` sets a goal; bare `/goal` views; control verbs act.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";
import { applyGoalCommand, applyGoalEdit } from "../../extensions/secretary/goal-ui.ts";

const THREAD = "thread-1";

function engine(): GoalEngine {
  return new GoalEngine({ dbPath: ":memory:", enabled: true });
}

test("bare /goal with no goal returns a view result (no goal created)", () => {
  const e = engine();
  const result = applyGoalCommand(e, THREAD, "");
  assert.equal(result.kind, "view");
  assert.ok((result as any).body.length === 0 || Array.isArray((result as any).body));
});

test("/goal <objective> creates the goal (Codex parity)", () => {
  const e = engine();
  const result = applyGoalCommand(e, THREAD, "ship the feature");
  assert.equal(result.kind, "notify");
  const goal = e.service.getGoal(THREAD);
  assert.ok(goal);
  assert.equal(goal.objective, "ship the feature");
  assert.equal(goal.status, "active");
});

test("/goal replaces an existing goal's objective", () => {
  const e = engine();
  applyGoalCommand(e, THREAD, "first objective");
  const result = applyGoalCommand(e, THREAD, "second objective");
  assert.equal(result.kind, "notify");
  assert.equal(e.service.getGoal(THREAD)!.objective, "second objective");
});

test("bare /goal views the existing goal", () => {
  const e = engine();
  applyGoalCommand(e, THREAD, "some objective");
  const result = applyGoalCommand(e, THREAD, "");
  assert.equal(result.kind, "view");
  assert.ok((result as any).body.some((l: string) => l.includes("some objective")));
});

test("/goal clear removes the goal", () => {
  const e = engine();
  applyGoalCommand(e, THREAD, "some objective");
  const result = applyGoalCommand(e, THREAD, "clear");
  assert.equal(result.kind, "notify");
  assert.equal(e.service.getGoal(THREAD), null);
});

test("/goal pause transitions to paused; resume back to active", () => {
  const e = engine();
  applyGoalCommand(e, THREAD, "some objective");
  assert.equal(e.service.getGoal(THREAD)!.status, "active");
  applyGoalCommand(e, THREAD, "pause");
  assert.equal(e.service.getGoal(THREAD)!.status, "paused");
  applyGoalCommand(e, THREAD, "resume");
  assert.equal(e.service.getGoal(THREAD)!.status, "active");
});

test("/goal edit with no goal errors instead of setting objective to 'edit'", () => {
  const e = engine();
  const result = applyGoalCommand(e, THREAD, "edit");
  assert.equal(result.kind, "notify");
  assert.equal((result as any).error, true);
  assert.equal(e.service.getGoal(THREAD), null);
});

test("/goal edit returns an edit request prefilled with the current objective", () => {
  const e = engine();
  applyGoalCommand(e, THREAD, "original objective");
  const result = applyGoalCommand(e, THREAD, "edit");
  assert.equal(result.kind, "edit");
  assert.equal((result as any).current.objective, "original objective");
});

test("applyGoalEdit updates the objective (not the literal word 'edit')", () => {
  const e = engine();
  applyGoalCommand(e, THREAD, "original");
  const result = applyGoalEdit(e, THREAD, "revised objective");
  assert.equal(result.kind, "notify");
  assert.equal(e.service.getGoal(THREAD)!.objective, "revised objective");
});

test("applyGoalEdit rejects an empty objective", () => {
  const e = engine();
  applyGoalCommand(e, THREAD, "original");
  const result = applyGoalEdit(e, THREAD, "   ");
  assert.equal(result.kind, "notify");
  assert.equal((result as any).error, true);
  assert.equal(e.service.getGoal(THREAD)!.objective, "original");
});

// --- One-line objective design: the view dialog is the expansion surface ------
// The widget truncates to one line, so bare `/goal` must present the verbatim
// objective; the set-goal notify stays a single line.

test("bare /goal view preserves the verbatim multi-line objective", () => {
  const e = engine();
  const objective = `First sentence explains context.

Second paragraph asks the real question.`;
  applyGoalCommand(e, THREAD, objective);
  const result = applyGoalCommand(e, THREAD, "");
  assert.equal(result.kind, "view");
  assert.ok((result as any).body.join("\n").includes(objective), "the view shows the verbatim objective");
});

test("the set-goal notify normalizes a multi-line objective into one line", () => {
  const e = engine();
  const objective = `First sentence explains context.

Second paragraph asks the real question.`;
  const result = applyGoalCommand(e, THREAD, objective);
  assert.equal(result.kind, "notify");
  const message = (result as any).message as string;
  assert.ok(!message.includes("\n"), "the notify message is a single line");
  assert.ok(message.includes("First sentence explains context. Second paragraph"));
});

test("applyGoalEdit notify normalizes a multi-line objective into one line", () => {
  const e = engine();
  applyGoalCommand(e, THREAD, "original");
  const edited = `revised first part.

revised second part.`;
  const result = applyGoalEdit(e, THREAD, edited);
  assert.equal(result.kind, "notify");
  const message = (result as any).message as string;
  assert.ok(!message.includes("\n"), "the notify message is a single line");
  assert.ok(message.includes("revised first part. revised second part."));
  assert.equal(e.service.getGoal(THREAD)!.objective, edited, "the stored objective stays verbatim");
});
