/**
 * Accounting state tests — traceability matrix §2.
 * Mirrors `codex-rs/ext/goal/tests/accounting.rs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GoalAccountingState,
  goalTokenDeltaForUsage,
} from "../../extensions/secretary/goal/accounting.ts";

function usage(input = 0, output = 0, cached = 0): any {
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  };
}

test("goal_token_delta_for_usage subtracts cached input and ignores cached write", () => {
  assert.equal(goalTokenDeltaForUsage(usage(100, 50, 0)), 150);
  assert.equal(goalTokenDeltaForUsage(usage(100, 0, 40)), 60);
  assert.equal(goalTokenDeltaForUsage(usage(0, 0, 0)), 0);
});

test("per-turn start baseline gives exact deltas", () => {
  const acc = new GoalAccountingState(0);
  acc.startTurn("t1", true, usage(1000, 0));
  acc.markCurrentTurnGoalActive("g1");
  acc.recordTokenUsage("t1", usage(1500, 200));
  const snap = acc.progressSnapshot("t1", 0);
  assert.ok(snap);
  assert.equal(snap.tokenDelta, 700); // (1500-1000)+(200-0)
  assert.equal(snap.expectedGoalId, "g1");
});

test("plan-mode turns are not accounted", () => {
  const acc = new GoalAccountingState(0);
  acc.startTurn("t1", false, usage(1000, 0)); // accountTokens=false
  acc.markCurrentTurnGoalActive("g1");
  acc.recordTokenUsage("t1", usage(2000, 500));
  assert.equal(acc.progressSnapshot("t1", 0), null);
  assert.equal(acc.currentActiveGoalIdForTurn("t1"), null);
});

test("mark_current_turn_goal_active resets baseline on goal change", () => {
  const acc = new GoalAccountingState(0);
  acc.startTurn("t1", true, usage(1000, 0));
  acc.recordTokenUsage("t1", usage(2000, 0));
  acc.markCurrentTurnGoalActive("g1"); // goal changed -> baseline = current (2000)
  // extra usage after the goal became active: only this is charged
  acc.recordTokenUsage("t1", usage(2300, 100));
  const snap = acc.progressSnapshot("t1", 0)!;
  assert.equal(snap.tokenDelta, 400); // (2300-2000)+(100-0)
});

test("idle progress snapshot uses wall clock", () => {
  const acc = new GoalAccountingState(0);
  acc.markIdleGoalActive("g1");
  const snap = acc.idleProgressSnapshot(5000); // 5s elapsed
  assert.ok(snap);
  assert.equal(snap.expectedGoalId, "g1");
  assert.equal(snap.timeDeltaSeconds, 5);
});

test("budget-limited goal keeps accruing (idle accounting)", () => {
  const acc = new GoalAccountingState(0);
  acc.markIdleGoalActive("g1");
  acc.recordDescendantTokenUsage(usage(100, 0));
  const snap = acc.idleProgressSnapshot(0);
  assert.ok(snap);
  assert.equal(snap.tokenDelta, 100);
});

test("tool-finish accounts active goal and marks progress accounted", () => {
  const acc = new GoalAccountingState(0);
  acc.startTurn("t1", true, usage(10, 0));
  acc.markCurrentTurnGoalActive("g1");
  acc.recordToolOutcome("t1", "exec", { kind: "completed", success: true });
  acc.recordTokenUsage("t1", usage(110, 20));
  const snap = acc.progressSnapshot("t1", 0)!;
  acc.markProgressAccountedForStatus("t1", snap, "active", "keep_active");
  // after accounting, further snapshot should show no new tokens
  const snap2 = acc.progressSnapshot("t1", 0);
  assert.equal(snap2, null);
});

test("3 consecutive exec failures on the same goal -> blocked audit", () => {
  const acc = new GoalAccountingState(0);
  let goalId: string | null = null;
  for (let i = 0; i < 3; i++) {
    acc.startTurn(`t${i}`, true, usage(0, 0));
    acc.markCurrentTurnGoalActive("g1");
    acc.recordToolOutcome(`t${i}`, "exec", { kind: "failed", handlerExecuted: true });
    goalId = acc.executionFailureGoal(`t${i}`);
    acc.finishTurn(`t${i}`);
  }
  assert.equal(goalId, "g1");
});

test("a successful tool resets the exec-failure audit", () => {
  const acc = new GoalAccountingState(0);
  for (let i = 0; i < 2; i++) {
    acc.startTurn(`t${i}`, true, usage(0, 0));
    acc.markCurrentTurnGoalActive("g1");
    acc.recordToolOutcome(`t${i}`, "exec", { kind: "failed", handlerExecuted: true });
    acc.finishTurn(`t${i}`);
  }
  acc.startTurn("t2", true, usage(0, 0));
  acc.markCurrentTurnGoalActive("g1");
  acc.recordToolOutcome("t2", "exec", { kind: "completed", success: true });
  assert.equal(acc.executionFailureGoal("t2"), null); // reset
  acc.finishTurn("t2");
});

test("3 consecutive empty automatic responses -> blocked audit", () => {
  const acc = new GoalAccountingState(0);
  let goalId: string | null = null;
  for (let i = 0; i < 3; i++) {
    const t = `automatic-${i}`;
    acc.startTurn(t, true, usage(0, 0));
    acc.markCurrentTurnGoalActive("g1");
    acc.markGoalContinuation(t);
    acc.recordItem(t, { hasText: false, phase: "final" }); // empty final
    goalId = acc.emptyResponseGoal(t);
    acc.finishTurn(t);
  }
  assert.equal(goalId, "g1");
});

test("a single non-empty turn resets the empty audit", () => {
  const acc = new GoalAccountingState(0);
  acc.startTurn("a0", true, usage(0, 0));
  acc.markCurrentTurnGoalActive("g1");
  acc.markGoalContinuation("a0");
  acc.recordItem("a0", { hasText: false, phase: "final" });
  acc.emptyResponseGoal("a0");
  acc.finishTurn("a0");
  // second turn has activity -> resets counter
  acc.startTurn("a1", true, usage(0, 0));
  acc.markCurrentTurnGoalActive("g1");
  acc.markGoalContinuation("a1");
  acc.recordItem("a1", { hasText: true });
  assert.equal(acc.emptyResponseGoal("a1"), null);
  acc.finishTurn("a1");
});

test("subagent descendant usage rolls up", () => {
  const acc = new GoalAccountingState(0);
  acc.startTurn("t1", true, usage(0, 0));
  acc.markCurrentTurnGoalActive("g1");
  acc.recordDescendantTokenUsage(usage(100, 50));
  const snap = acc.progressSnapshot("t1", 0)!;
  assert.equal(snap.tokenDelta, 150);
});

test("mark_budget_limit_reported_if_new reports once per goal", () => {
  const acc = new GoalAccountingState(0);
  assert.equal(acc.markBudgetLimitReportedIfNew("g1"), true);
  assert.equal(acc.markBudgetLimitReportedIfNew("g1"), false);
  assert.equal(acc.markBudgetLimitReportedIfNew("g2"), true);
});
