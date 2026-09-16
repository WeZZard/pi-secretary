/**
 * Storage layer tests — traceability matrix §3.
 * Mirrors `codex-rs/state/src/runtime/goals.rs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalDb, validateGoalBudget } from "../../extensions/secretary/goal/storage/goal-db.ts";

const THREAD = "thread-1";

function freshDb(): GoalDb {
  return GoalDb.open(":memory:");
}

test("replace/update/get thread goal round-trips", () => {
  const db = freshDb();
  const goal = db.replaceThreadGoal(THREAD, "optimize the benchmark", "active", 100_000);
  assert.ok(goal);
  assert.equal(goal.threadId, THREAD);
  assert.equal(goal.objective, "optimize the benchmark");
  assert.equal(goal.status, "active");
  assert.equal(goal.tokenBudget, 100_000);
  assert.equal(goal.tokensUsed, 0);
  assert.equal(goal.timeUsedSeconds, 0);

  // get returns the same
  assert.deepEqual(db.getThreadGoal(THREAD), goal);

  // update status + budget, identical compare ignores updatedAt? It changes.
  const updated = db.updateThreadGoal(THREAD, {
    status: "paused",
    tokenBudget: 200_000,
    expectedGoalId: goal.goalId,
  });
  assert.ok(updated);
  assert.equal(updated.status, "paused");
  assert.equal(updated.tokenBudget, 200_000);
  assert.equal(updated.objective, "optimize the benchmark");
  assert.equal(updated.createdAt, goal.createdAt); // created_at preserved

  // delete
  const deleted = db.deleteThreadGoal(THREAD);
  assert.ok(deleted);
  assert.equal(db.getThreadGoal(THREAD), null);
  assert.equal(db.deleteThreadGoal(THREAD), null);
});

test("replace applies budget-limit immediately", () => {
  const db = freshDb();
  const goal = db.replaceThreadGoal(THREAD, "stay within budget", "active", 0);
  assert.ok(goal);
  assert.equal(goal.status, "budget_limited");
  assert.equal(goal.tokenBudget, 0);
  assert.equal(goal.tokensUsed, 0);
});

test("insert does not replace an existing goal", () => {
  const db = freshDb();
  const first = db.insertThreadGoal(THREAD, "first goal", "active");
  assert.ok(first);
  const second = db.insertThreadGoal(THREAD, "second goal", "active");
  assert.equal(second, null); // single-goal-per-thread
  assert.equal(db.getThreadGoal(THREAD)!.objective, "first goal");
});

test("insert replaces an existing completed goal", () => {
  const db = freshDb();
  const first = db.insertThreadGoal(THREAD, "first goal", "active");
  assert.ok(first);
  db.updateThreadGoal(THREAD, { status: "complete" });
  const second = db.insertThreadGoal(THREAD, "second goal", "active");
  assert.ok(second);
  assert.equal(second.objective, "second goal");
  assert.equal(second.goalId !== first.goalId, true);
  // usage reset for the new goal
  assert.equal(second.tokensUsed, 0);
});

test("insert applies budget-limit immediately", () => {
  const db = freshDb();
  const goal = db.insertThreadGoal(THREAD, "insert budget", "active", 0);
  assert.ok(goal);
  assert.equal(goal.status, "budget_limited");
});

test("update ignores a replaced goal version (expected_goal_id CAS)", () => {
  const db = freshDb();
  const original = db.insertThreadGoal(THREAD, "original", "active");
  assert.ok(original);
  const staleId = original.goalId;

  // Complete it, then replace the thread with a new goal (real version change).
  db.updateThreadGoal(THREAD, { status: "complete" });
  const replaced = db.replaceThreadGoal(THREAD, "replacement", "active");
  assert.ok(replaced);
  assert.notEqual(replaced.goalId, staleId);

  // Update with the stale expected goal id must be rejected.
  const result = db.updateThreadGoal(THREAD, {
    status: "paused",
    expectedGoalId: staleId,
  });
  assert.equal(result, null);
  assert.equal(db.getThreadGoal(THREAD)!.objective, "replacement");
});

test("usage accounting ignores a replaced goal version", () => {
  const db = freshDb();
  const original = db.insertThreadGoal(THREAD, "original", "active");
  assert.ok(original);
  const staleId = original.goalId;

  // Complete, then replace (real version change).
  db.updateThreadGoal(THREAD, { status: "complete" });
  db.replaceThreadGoal(THREAD, "replacement", "active");

  const outcome = db.accountThreadGoalUsage(THREAD, 10, 100, "active_only", staleId);
  assert.equal(outcome.kind, "unchanged");
  assert.equal(db.getThreadGoal(THREAD)!.tokensUsed, 0);
});

test("objective update preserves usage and created_at", () => {
  const db = freshDb();
  const goal = db.insertThreadGoal(THREAD, "before", "active");
  assert.ok(goal);
  db.accountThreadGoalUsage(THREAD, 5, 42, "active_only");

  const updated = db.updateThreadGoal(THREAD, { objective: "after" });
  assert.ok(updated);
  assert.equal(updated.objective, "after");
  assert.equal(updated.tokensUsed, 42);
  assert.equal(updated.timeUsedSeconds, 5);
  assert.equal(updated.createdAt, goal.createdAt);
});

test("concurrent partial updates preserve independent fields", () => {
  const db = freshDb();
  db.insertThreadGoal(THREAD, "base", "active");

  // Two partial updates on the same thread should both land (last write wins on
  // shared columns, independent fields preserved). Simulate serially.
  const a = db.updateThreadGoal(THREAD, { objective: "from-a" });
  const b = db.updateThreadGoal(THREAD, { tokenBudget: 500 });
  assert.ok(a && b);
  const final = db.getThreadGoal(THREAD)!;
  assert.equal(final.objective, "from-a");
  assert.equal(final.tokenBudget, 500);
});

test("only budget_limited resists pause/block override", () => {
  const db = freshDb();
  db.insertThreadGoal(THREAD, "base", "active", 10);
  // push to budget_limited
  db.accountThreadGoalUsage(THREAD, 0, 20, "active_only");
  assert.equal(db.getThreadGoal(THREAD)!.status, "budget_limited");

  // paused attempt must not clobber budget_limited
  const paused = db.updateThreadGoal(THREAD, { status: "paused" });
  assert.ok(paused);
  assert.equal(paused.status, "budget_limited");

  // blocked attempt must not clobber either
  const blocked = db.updateThreadGoal(THREAD, { status: "blocked" });
  assert.ok(blocked);
  assert.equal(blocked.status, "budget_limited");

  // a complete goal MAY be re-edited to a new active status (Codex protects
  // only budget_limited, not complete, from status override)
  db.replaceThreadGoal(THREAD, "complete goal", "complete");
  const pauseComplete = db.updateThreadGoal(THREAD, { status: "paused" });
  assert.ok(pauseComplete);
  assert.equal(pauseComplete.status, "paused");
});

test("usage accounting mode scoping and concurrent delta addition", () => {
  const db = freshDb();
  db.insertThreadGoal(THREAD, "base", "active", 10_000);

  // active_only accounts an active goal
  const a = db.accountThreadGoalUsage(THREAD, 10, 100, "active_only");
  assert.equal(a.kind, "updated");
  assert.equal(db.getThreadGoal(THREAD)!.tokensUsed, 100);

  // concurrent-adjacent deltas add up (no lost update)
  db.accountThreadGoalUsage(THREAD, 1, 50, "active_only");
  db.accountThreadGoalUsage(THREAD, 1, 25, "active_only");
  assert.equal(db.getThreadGoal(THREAD)!.tokensUsed, 175);

  // make it budget_limited; active_only must no longer update it
  db.accountThreadGoalUsage(THREAD, 0, 20_000, "active_only");
  assert.equal(db.getThreadGoal(THREAD)!.status, "budget_limited");
  const noAccount = db.accountThreadGoalUsage(THREAD, 0, 10, "active_only");
  assert.equal(noAccount.kind, "unchanged");
  assert.equal(db.getThreadGoal(THREAD)!.tokensUsed, 20175);
});

test("completed goal can still be finalized by active_or_complete accounting", () => {
  const db = freshDb();
  db.insertThreadGoal(THREAD, "complete goal", "complete");
  const outcome = db.accountThreadGoalUsage(THREAD, 1, 5, "active_or_complete");
  assert.equal(outcome.kind, "updated");
  assert.equal(db.getThreadGoal(THREAD)!.tokensUsed, 5);
});

test("stopped goal can be finalized by active_or_stopped accounting", () => {
  const db = freshDb();
  db.insertThreadGoal(THREAD, "blocked goal", "blocked");
  const outcome = db.accountThreadGoalUsage(THREAD, 1, 5, "active_or_stopped");
  assert.equal(outcome.kind, "updated");
  assert.equal(db.getThreadGoal(THREAD)!.tokensUsed, 5);
});

test("cascade delete on thread delete", () => {
  const db = freshDb();
  db.insertThreadGoal(THREAD, "to-delete", "active");
  db.deleteThreadGoalsForThread(THREAD);
  assert.equal(db.getThreadGoal(THREAD), null);
});

test("objective validation: empty and over-length rejected", () => {
  const db = freshDb();
  assert.throws(() => db.insertThreadGoal(THREAD, "   ", "active"));
  assert.throws(() => db.insertThreadGoal(THREAD, "x".repeat(4001), "active"));
});

test("budget validation: negative rejected", () => {
  const db = freshDb();
  assert.throws(() => db.insertThreadGoal(THREAD, "base", "active", -5));
});

test("budget max: validateGoalBudget rejects above the configured max (claim L)", () => {
  const ok = validateGoalBudget(100, 200);
  assert.equal(ok.ok, true);
  const over = validateGoalBudget(300, 200);
  assert.equal(over.ok, false);
  assert.match((over as any).error, /maximum/);
  // omitted budget is allowed with no max
  assert.equal(validateGoalBudget(undefined, 200).ok, true);
});

test("conditional delete returns only the actual deleted snapshot", () => {
  const db = freshDb();
  const goal = db.insertThreadGoal(THREAD, "base", "active")!;
  assert.equal(db.deleteThreadGoal(THREAD, "stale"), null);
  assert.deepEqual(db.getThreadGoal(THREAD), goal);
  assert.deepEqual(db.deleteThreadGoal(THREAD, goal.goalId), goal);
  assert.equal(db.deleteThreadGoal(THREAD, goal.goalId), null);
});

test("atomic fork import preserves all snapshot fields and only replaces complete", () => {
  const db = freshDb();
  const source = { ...db.insertThreadGoal(THREAD, "source", "active", 50)!,
    tokensUsed: 25, timeUsedSeconds: 12, createdAt: 100, updatedAt: 200 };
  for (const status of ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"] as const) {
    const target = `target-${status}`;
    const existing = db.insertThreadGoal(target, "target", status)!;
    const imported = db.importThreadGoal(source, target);
    if (status === "complete") {
      assert.deepEqual(imported, { ...source, threadId: target });
    } else {
      assert.equal(imported, null);
      assert.deepEqual(db.getThreadGoal(target), existing);
    }
  }
  assert.deepEqual(db.importThreadGoal(source, "new"), { ...source, threadId: "new" });
});

test("update validates objective and budget without changing storage", () => {
  const db = freshDb();
  const goal = db.insertThreadGoal(THREAD, "base", "active", 100)!;
  for (const objective of ["  ", "x".repeat(4001)]) {
    assert.throws(() => db.updateThreadGoal(THREAD, { objective }));
  }
  for (const tokenBudget of [-1, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => db.updateThreadGoal(THREAD, { tokenBudget }));
  }
  assert.deepEqual(db.getThreadGoal(THREAD), goal);
  assert.equal(db.updateThreadGoal(THREAD, { tokenBudget: null })?.tokenBudget, undefined);
  assert.equal(db.updateThreadGoal(THREAD, { tokenBudget: 0 })?.status, "budget_limited");
});

test("no-op update and zero accounting retain timestamps", () => {
  const db = freshDb();
  const source = { ...db.insertThreadGoal(THREAD, "base", "active")!, updatedAt: 123 };
  db.importThreadGoal(source, "fork");
  assert.deepEqual(db.updateThreadGoal("fork", { objective: "base" }), { ...source, threadId: "fork" });
  assert.equal(db.accountThreadGoalUsage("fork", 0, 0, "active_only").kind, "unchanged");
  assert.deepEqual(db.getThreadGoal("fork"), { ...source, threadId: "fork" });
});

test("budget and usage limited goals accept final in-flight accounting only in stopped mode", () => {
  const db = freshDb();
  for (const status of ["budget_limited", "usage_limited"] as const) {
    const goal = db.insertThreadGoal(status, "base", status)!;
    assert.equal(db.accountThreadGoalUsage(status, 1, 5, "active_only").kind, "unchanged");
    assert.equal(db.accountThreadGoalUsage(status, 1, 5, "active_or_complete").kind, "unchanged");
    assert.equal(db.accountThreadGoalUsage(status, 1, 5, "active_or_stopped", "stale").kind, "unchanged");
    const result = db.accountThreadGoalUsage(status, 2, 7, "active_or_stopped", goal.goalId);
    assert.equal(result.kind, "updated");
    assert.equal(db.getThreadGoal(status)?.tokensUsed, 7);
    assert.equal(db.getThreadGoal(status)?.timeUsedSeconds, 2);
    assert.equal(db.getThreadGoal(status)?.status, status);
  }
});
