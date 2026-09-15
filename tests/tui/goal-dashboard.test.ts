/**
 * Goal UI dashboard rendering tests.
 * Ports the pi-goal-x presentation for the single-thread goal model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderGoalDashboard } from "../../extensions/secretary/goal-ui.ts";
import { type ThreadGoal } from "../../extensions/secretary/goal/goal-record.ts";

function goal(partial: Partial<ThreadGoal>): ThreadGoal {
  return {
    threadId: "t",
    goalId: "g",
    objective: "default",
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

test("no goal clears the dashboard and status", () => {
  const d = renderGoalDashboard(null);
  assert.equal(d.status, undefined);
  assert.deepEqual(d.widget, []);
});

test("active goal renders objective and status", () => {
  const d = renderGoalDashboard(goal({ objective: "ship the feature" }));
  assert.ok(d.status?.includes("goal active"));
  assert.ok(d.widget.some((l) => l.includes("ship the feature")));
});

test("budgeted goal renders usage and remaining", () => {
  const d = renderGoalDashboard(
    goal({ tokenBudget: 1000, tokensUsed: 300, status: "active" }),
  );
  assert.ok(d.widget.some((l) => l.includes("tokens 300/1000")));
  assert.ok(d.widget.some((l) => l.includes("remaining 700")));
});

test("elapsed time is rendered when positive", () => {
  const d = renderGoalDashboard(goal({ timeUsedSeconds: 42 }));
  assert.ok(d.widget.some((l) => l.includes("42s")));
});

test("budget_limited status propagates", () => {
  const d = renderGoalDashboard(goal({ status: "budget_limited", tokenBudget: 10, tokensUsed: 10 }));
  assert.ok(d.status?.includes("budget_limited"));
  assert.ok(d.widget.some((l) => l.includes("remaining 0")));
});
