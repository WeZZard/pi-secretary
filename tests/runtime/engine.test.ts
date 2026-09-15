/**
 * GoalEngine tests — per-runtime accounting isolation (claim N) and fork
 * snapshot inheritance (claim F).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";

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

test("each runtime owns an isolated accounting state (claim N)", () => {
  const engine = new GoalEngine({ dbPath: ":memory:", enabled: true });
  engine.service.createGoal("thread-a", "goal a", 10000);
  engine.service.createGoal("thread-b", "goal b", 10000);

  const ra = engine.runtimeFor("thread-a");
  const rb = engine.runtimeFor("thread-b");
  assert.notEqual(ra.accountingState(), rb.accountingState());

  // Start a turn on thread-a only; thread-b's runtime must not see it as a
  // current turn.
  ra.startTurn("turn-0", true, usage(0, 0));
  assert.equal(ra.accountingState().currentTurnId(), "turn-0");
  assert.equal(rb.accountingState().currentTurnId(), null);
});

test("engine.accounting follows the most recent runtime (single-thread case)", () => {
  const engine = new GoalEngine({ dbPath: ":memory:", enabled: true });
  const ra = engine.runtimeFor("thread-a");
  assert.equal(engine.accounting, ra.accountingState());
  const rb = engine.runtimeFor("thread-b");
  assert.equal(engine.accounting, rb.accountingState());
});

test("copyGoalToThread inherits a goal snapshot (claim F)", () => {
  const engine = new GoalEngine({ dbPath: ":memory:", enabled: true });
  engine.service.createGoal("source", "the objective", 5000);
  const copied = engine.copyGoalToThread("source", "target");
  assert.ok(copied);
  assert.equal(copied.objective, "the objective");
  assert.equal(copied.status, "active");
  assert.equal(copied.tokenBudget, 5000);
  assert.deepEqual(copied.threadId, "target");
});

test("copyGoalToThread returns null when source has no goal (claim F)", () => {
  const engine = new GoalEngine({ dbPath: ":memory:", enabled: true });
  const copied = engine.copyGoalToThread("source", "target");
  assert.equal(copied, null);
});

test("copyGoalToThread refuses to clobber an unfinished target (claim F)", () => {
  const engine = new GoalEngine({ dbPath: ":memory:", enabled: true });
  engine.service.createGoal("source", "the objective");
  engine.service.createGoal("target", "existing unfinished");
  const copied = engine.copyGoalToThread("source", "target");
  assert.equal(copied, null);
  assert.equal(engine.service.getGoal("target")!.objective, "existing unfinished");
});

test("dispose clears runtimes and resets the shared accounting pointer", () => {
  const engine = new GoalEngine({ dbPath: ":memory:", enabled: true });
  engine.runtimeFor("thread-a");
  engine.dispose();
  // runtimeFor re-creates a fresh runtime with fresh accounting state.
  const ra = engine.runtimeFor("thread-a");
  assert.equal(engine.accounting, ra.accountingState());
});
