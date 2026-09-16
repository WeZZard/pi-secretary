import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGoalSnapshot, continuationPrompt } from "../../extensions/secretary/goal/steering.ts";
import type { ThreadGoal } from "../../extensions/secretary/goal/goal-record.ts";

const goal: ThreadGoal = { threadId: "test", goalId: "goal-1", objective: "Ship <untrusted> work",
  status: "blocked", tokenBudget: 100, tokensUsed: 40, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2 };

test("goal snapshot includes all promised model-visible quantities and separates cause from status", () => {
  const text = formatGoalSnapshot(goal, "run_error");
  for (const expected of ["Goal [blocked]", "goal-1", "plus output): 40", "Token budget: 100",
    "Remaining token budget: 60", "Elapsed goal time: 12 seconds", "Stop cause: run_error"]) assert.ok(text.includes(expected));
  assert.ok(!text.includes("<untrusted>"));
  assert.match(formatGoalSnapshot(goal), /Stop cause: unavailable/);
  assert.match(formatGoalSnapshot(null), /No current goal/);
});

test("legacy overlength objective cannot grow state or behavioral context without bound", () => {
  const objective = "<".repeat(100_000);
  assert.ok(formatGoalSnapshot({ ...goal, objective }).length < 30_000);
  assert.match(formatGoalSnapshot({ ...goal, objective }), /truncated/);
  assert.ok(continuationPrompt({ objective, tokensUsed: 0 }).length < 30_000);
});
