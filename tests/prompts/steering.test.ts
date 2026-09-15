/**
 * Steering prompt tests — traceability matrix §2.
 * Mirrors `codex-rs/ext/goal/tests/steering.rs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  budgetLimitPrompt,
  continuationPrompt,
  objectiveUpdatedPrompt,
} from "../../extensions/secretary/goal/steering.ts";

test("continuation prompt renders objective and budget fields", () => {
  const p = continuationPrompt({
    objective: "ship the goal feature",
    tokensUsed: 1500,
    tokenBudget: 10000,
  });
  assert.ok(p.includes("ship the goal feature"));
  assert.ok(p.includes("Tokens used: 1500"));
  assert.ok(p.includes("Token budget: 10000"));
  assert.ok(p.includes("Tokens remaining: 8500"));
  assert.ok(p.includes("Continue working toward the active thread goal."));
});

test("continuation prompt with no budget reports unbounded", () => {
  const p = continuationPrompt({ objective: "o", tokensUsed: 10 });
  assert.ok(p.includes("Token budget: none"));
  assert.ok(p.includes("Tokens remaining: unbounded"));
});

test("budget limit prompt renders time and budget", () => {
  const p = budgetLimitPrompt({
    objective: "reach the budget",
    tokensUsed: 100,
    tokenBudget: 100,
    timeUsedSeconds: 42,
  });
  assert.ok(p.includes("Time spent pursuing goal: 42 seconds"));
  assert.ok(p.includes("Tokens used: 100"));
  assert.ok(p.includes("Token budget: 100"));
  assert.ok(p.includes("has reached its token budget"));
});

test("objective updated prompt renders new objective", () => {
  const p = objectiveUpdatedPrompt({
    objective: "the new target",
    tokensUsed: 20,
    tokenBudget: 500,
  });
  assert.ok(p.includes("the new target"));
  assert.ok(p.includes("Tokens remaining: 480"));
});

test("prompts XML-escape the objective", () => {
  const p = continuationPrompt({ objective: "a <tag> & b", tokensUsed: 0 });
  assert.ok(p.includes("&lt;tag&gt;"));
  assert.ok(!p.includes("<tag>"));
  assert.ok(p.includes("&amp;"));
});
