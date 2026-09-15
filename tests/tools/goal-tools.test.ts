/**
 * Core goal tool tests — traceability matrix §1 (tool handlers).
 * Mirrors `codex-rs/ext/goal/tests/goal_extension_backend.rs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalDb } from "../../extensions/secretary/goal/storage/goal-db.ts";
import { GoalService } from "../../extensions/secretary/goal/goal-service.ts";
import {
  executeCreateGoal,
  executeGetGoal,
  executeUpdateGoal,
  GoalToolError,
} from "../../extensions/secretary/goal/tools/goal-tool-executors.ts";

const THREAD = "thread-1";

function svc(): GoalService {
  return new GoalService(GoalDb.open(":memory:"));
}

test("get_goal with no goal returns null", () => {
  const response = executeGetGoal(svc(), THREAD);
  assert.equal(response.goal, null);
  assert.equal(response.remaining_tokens, null);
});

test("create_goal creates a new active goal", () => {
  const response = executeCreateGoal(svc(), THREAD, { objective: "fix the bug" });
  assert.ok(response.goal);
  assert.equal(response.goal.status, "active");
  assert.equal(response.goal.objective, "fix the bug");
  assert.equal(response.remaining_tokens, null);
});

test("create_goal trims objective whitespace", () => {
  const response = executeCreateGoal(svc(), THREAD, { objective: "  fix the bug  " });
  assert.equal(response.goal?.objective, "fix the bug");
});

test("create_goal rejects empty objective", () => {
  assert.throws(
    () => executeCreateGoal(svc(), THREAD, { objective: "   " }),
    GoalToolError,
  );
});

test("create_goal rejects over-length objective", () => {
  assert.throws(
    () => executeCreateGoal(svc(), THREAD, { objective: "x".repeat(4001) }),
    GoalToolError,
  );
});

test("create_goal rejects non-positive budget", () => {
  assert.throws(
    () => executeCreateGoal(svc(), THREAD, { objective: "base", token_budget: 0 }),
    GoalToolError,
  );
  assert.throws(
    () => executeCreateGoal(svc(), THREAD, { objective: "base", token_budget: -1 }),
    GoalToolError,
  );
});

test("create_goal fails if an unfinished goal exists", () => {
  const s = svc();
  executeCreateGoal(s, THREAD, { objective: "first" });
  assert.throws(
    () => executeCreateGoal(s, THREAD, { objective: "second" }),
    /unfinished goal/,
  );
});

test("create_goal replaces a completed goal", () => {
  const s = svc();
  executeCreateGoal(s, THREAD, { objective: "first" });
  executeUpdateGoal(s, THREAD, { status: "complete" });
  const response = executeCreateGoal(s, THREAD, { objective: "second" });
  assert.equal(response.goal?.objective, "second");
});

test("create_goal stays active with a positive budget", () => {
  const s = svc();
  const response = executeCreateGoal(s, THREAD, { objective: "over", token_budget: 100 });
  assert.equal(response.goal?.status, "active");
  assert.equal(response.remaining_tokens, 100);
});

test("create_goal returns remaining_tokens when budgeted", () => {
  const s = svc();
  const response = executeCreateGoal(s, THREAD, { objective: "budgeted", token_budget: 1000 });
  assert.equal(response.remaining_tokens, 1000);
});

test("update_goal marks complete", () => {
  const s = svc();
  executeCreateGoal(s, THREAD, { objective: "base" });
  const response = executeUpdateGoal(s, THREAD, { status: "complete" });
  assert.equal(response.goal?.status, "complete");
  // no budget and no elapsed time => completion report omitted (Codex semantics)
  assert.equal(response.completion_budget_report, undefined);
});

test("update_goal complete includes a completion budget report when budgeted", () => {
  const s = svc();
  executeCreateGoal(s, THREAD, { objective: "base", token_budget: 5000 });
  const response = executeUpdateGoal(s, THREAD, { status: "complete" });
  assert.equal(response.goal?.status, "complete");
  assert.equal(typeof response.completion_budget_report, "string");
  assert.equal(response.remaining_tokens, 5000);
});

test("update_goal marks blocked and paused", () => {
  const s = svc();
  executeCreateGoal(s, THREAD, { objective: "base" });
  assert.equal(executeUpdateGoal(s, THREAD, { status: "blocked" }).goal?.status, "blocked");
  assert.equal(executeUpdateGoal(s, THREAD, { status: "paused" }).goal?.status, "paused");
});

test("update_goal fails if no goal exists", () => {
  assert.throws(() => executeUpdateGoal(svc(), THREAD, { status: "complete" }), /no goal/);
});

test("get_goal returns current goal with budget and usage", () => {
  const s = svc();
  executeCreateGoal(s, THREAD, { objective: "tracked", token_budget: 5000 });
  const response = executeGetGoal(s, THREAD);
  assert.ok(response.goal);
  assert.equal(response.goal.tokenBudget, 5000);
  assert.equal(response.remaining_tokens, 5000);
});
