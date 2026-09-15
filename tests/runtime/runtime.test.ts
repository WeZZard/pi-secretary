/**
 * GoalRuntime tests — traceability matrix §2 runtime rows.
 * Mirrors `codex-rs/ext/goal/src/runtime.rs` decision logic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalDb } from "../../extensions/secretary/goal/storage/goal-db.ts";
import { GoalService } from "../../extensions/secretary/goal/goal-service.ts";
import { GoalAccountingState } from "../../extensions/secretary/goal/accounting.ts";
import { GoalRuntime } from "../../extensions/secretary/goal/runtime.ts";

const THREAD = "thread-1";

function usage(input = 0, output = 0): any {
  return {
    inputTokens: input,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  };
}

function setup() {
  const service = new GoalService(GoalDb.open(":memory:"));
  const accounting = new GoalAccountingState(0);
  const runtime = new GoalRuntime(THREAD, service, accounting, {});
  return { service, accounting, runtime };
}

test("startTurn marks an active goal active for accounting", () => {
  const { service, accounting, runtime } = setup();
  service.createGoal(THREAD, "do the thing", 1000);
  runtime.startTurn("t1", true, usage(100, 0));
  assert.equal(accounting.currentActiveGoalIdForTurn("t1") !== null, true);
});

test("finishTurn stops charging the goal", () => {
  const { service, accounting, runtime } = setup();
  service.createGoal(THREAD, "do the thing");
  runtime.startTurn("t1", true, usage(0, 0));
  runtime.finishTurn("t1");
  assert.equal(accounting.currentTurnId(), null);
});

test("accountActiveGoalProgress charges usage to the active goal", () => {
  const { service, runtime } = setup();
  service.createGoal(THREAD, "do the thing", 1000);
  runtime.startTurn("t1", true, usage(100, 0));
  runtime.recordTokenUsage("t1", usage(300, 50));
  const result = runtime.accountActiveGoalProgress("t1", "test", "active_only", "keep_active");
  assert.ok(result);
  assert.equal(result.goal.tokensUsed, 250); // (300-100)+(50-0)
  assert.equal(result.goal.status, "active");
});

test("budget-limit transitions the goal when usage crosses the budget", () => {
  const { service, runtime } = setup();
  service.createGoal(THREAD, "do the thing", 100);
  runtime.startTurn("t1", true, usage(0, 0));
  runtime.recordTokenUsage("t1", usage(0, 150));
  const result = runtime.accountActiveGoalProgress("t1", "test", "active_only", "keep_active");
  assert.ok(result);
  assert.equal(result.goal.status, "budget_limited");
});

test("turn_error stops the active goal as blocked", () => {
  const { service, runtime } = setup();
  service.createGoal(THREAD, "do the thing");
  runtime.startTurn("t1", true, usage(0, 0));
  const updated = runtime.stopActiveGoalForTurn("t1", "turn_error");
  assert.equal(updated?.status, "blocked");
});

test("empty_response with 3 consecutive empty turns blocks the goal", () => {
  const { service, runtime, accounting } = setup();
  service.createGoal(THREAD, "do the thing");
  let updated;
  for (let i = 0; i < 3; i++) {
    const t = `auto-${i}`;
    runtime.startTurn(t, true, usage(0, 0));
    accounting.markGoalContinuation(t);
    runtime.recordItem(t, { hasText: false, phase: "final" });
    updated = runtime.stopActiveGoalForTurn(t, "empty_response");
    runtime.finishTurn(t);
  }
  assert.equal(updated?.status, "blocked");
});

test("applyExternalGoalSet on an active goal triggers continuation", () => {
  const { service, runtime } = setup();
  const callbacks: string[] = [];
  runtime.callbacks = {
    continueIfIdle: (p: string) => callbacks.push("continue:" + p.includes("Continue working")),
    injectSteering: (p: string) => callbacks.push("steer:" + p.length),
    toolsAvailable: () => true,
  };
  service.createGoal(THREAD, "the objective");
  const goal = service.getGoal(THREAD)!;
  runtime.applyExternalGoalSet(goal, null);
  assert.equal(callbacks.some((c) => c.startsWith("continue:")), true);
});

test("applyExternalGoalSet on a complete goal does not continue", () => {
  const { service, runtime } = setup();
  const callbacks: string[] = [];
  runtime.callbacks = {
    continueIfIdle: (p: string) => callbacks.push(p),
    toolsAvailable: () => true,
  };
  service.createGoal(THREAD, "the objective");
  service.requestTerminalUpdate(THREAD, "complete", "agent");
  const goal = service.getGoal(THREAD)!;
  runtime.applyExternalGoalSet(goal, service.getGoal(THREAD));
  assert.equal(callbacks.length, 0);
});

test("budget limit prompt is available through the runtime", () => {
  const { service, runtime } = setup();
  service.createGoal(THREAD, "budgeted", 50);
  const goal = service.getGoal(THREAD)!;
  const p = runtime.budgetLimitPrompt(goal);
  assert.ok(p.includes("has reached its token budget"));
});

test("goal token accounting accumulates across turns and budget-limits", () => {
  const { service, runtime, accounting } = setup();
  service.createGoal(THREAD, "do the thing", 300);

  // Turn 1: (input 100 - cacheRead 0) + output 100 = 200
  runtime.startTurn("turn-0", true, usage(0, 0));
  runtime.recordTokenUsage("turn-0", usage(100, 100));
  const r0 = runtime.accountActiveGoalProgress("turn-0", "turn-end", "active_only", "keep_active");
  assert.equal(r0?.goal.tokensUsed, 200);
  assert.equal(r0?.goal.status, "active");
  runtime.finishTurn("turn-0");

  // Turn 2: adds 150 -> 350, but budget is 300 -> budget_limited
  runtime.startTurn("turn-1", true, usage(0, 0));
  runtime.recordTokenUsage("turn-1", usage(50, 100));
  const r1 = runtime.accountActiveGoalProgress("turn-1", "turn-end", "active_only", "keep_active");
  assert.equal(r1?.goal.tokensUsed, 350);
  assert.equal(r1?.goal.status, "budget_limited");
  runtime.finishTurn("turn-1");
});

test("goal token accounting uses input minus cached plus output", () => {
  const { service, runtime } = setup();
  service.createGoal(THREAD, "do the thing", 100000);
  runtime.startTurn("turn-0", true, usage(0, 0));
  runtime.recordTokenUsage("turn-0", {
    inputTokens: 100,
    cachedInputTokens: 30,
    cacheWriteInputTokens: 0,
    outputTokens: 200,
    reasoningOutputTokens: 0,
    totalTokens: 300,
  });
  const r = runtime.accountActiveGoalProgress("turn-0", "turn-end", "active_only", "keep_active");
  assert.equal(r?.goal.tokensUsed, 270); // (100-30) + 200
  runtime.finishTurn("turn-0");
});
