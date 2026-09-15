/**
 * GoalService tests — traceability matrix §2 service rows.
 * Mirrors `codex-rs/ext/goal/tests/goal_extension_backend.rs` service scenarios.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalDb } from "../../extensions/secretary/goal/storage/goal-db.ts";
import { GoalService } from "../../extensions/secretary/goal/goal-service.ts";

const THREAD = "thread-1";

function setup(): GoalService {
  return new GoalService(GoalDb.open(":memory:"));
}

test("service sets, gets, and clears a thread goal", () => {
  const svc = setup();
  const created = svc.createGoal(THREAD, "ship the goal service", 50_000);
  assert.ok(created.goal);
  assert.equal(created.goal.status, "active");
  assert.equal(created.goal.objective, "ship the goal service");
  assert.equal(created.effect, "start_if_idle");

  const got = svc.getGoal(THREAD);
  assert.ok(got);
  assert.equal(got.objective, "ship the goal service");

  const cleared = svc.clearGoal(THREAD, "user");
  assert.equal(cleared.goal, null);
  assert.equal(svc.getGoal(THREAD), null);
  assert.equal(cleared.previousGoal?.objective, "ship the goal service");
  assert.equal(cleared.effect, "stop");
});

test("service enforces single-goal-per-thread on create", () => {
  const svc = setup();
  svc.createGoal(THREAD, "first goal");
  assert.throws(
    () => svc.createGoal(THREAD, "second goal"),
    /unfinished goal/,
  );
});

test("create with a 0 budget immediately budget-limits", () => {
  const svc = setup();
  const created = svc.createGoal(THREAD, "over budget", 0);
  assert.equal(created.goal?.status, "budget_limited");
  assert.equal(created.steering, "budget_limit");
});

test("requestTerminalUpdate only accepts complete/blocked/paused", () => {
  const svc = setup();
  svc.createGoal(THREAD, "base");
  // resume / budget / usage are not agent-settable
  for (const bad of ["active", "budget_limited", "usage_limited"] as const) {
    // @ts-expect-error intentionally invalid status
    assert.throws(() => svc.requestTerminalUpdate(THREAD, bad, "agent"), /update_goal can only/);
  }
});

test("requestTerminalUpdate complete stops continuation and emits", () => {
  const svc = setup();
  svc.createGoal(THREAD, "base");
  svc.registerContinuation(THREAD);
  let emitted: string | null = null;
  svc.onGoalUpdated((g) => (emitted = g?.objective ?? null));

  const outcome = svc.requestTerminalUpdate(THREAD, "complete", "agent");
  assert.equal(outcome.goal?.status, "complete");
  assert.equal(outcome.effect, "stop");
  assert.equal(outcome.steering, "complete");
  assert.equal(svc.hasPendingContinuation(THREAD), false);
  assert.equal(emitted, "base");
});

test("requestTerminalUpdate validates the expected goal id (stale rejection)", () => {
  const svc = setup();
  const created = svc.createGoal(THREAD, "base");
  assert.ok(created.goal);
  const staleId = created.goal.goalId;

  // complete it, then replace with a new goal (version change)
  svc.requestTerminalUpdate(THREAD, "complete", "agent", staleId);
  const replaced = svc.createGoal(THREAD, "replacement");
  assert.ok(replaced.goal);
  assert.notEqual(replaced.goal.goalId, staleId);

  // stale expected id must be rejected
  assert.throws(() => svc.requestTerminalUpdate(THREAD, "complete", "agent", staleId), /version changed/);
});

test("editing a complete goal reactivates it (objective edit)", () => {
  const svc = setup();
  svc.createGoal(THREAD, "original");
  svc.requestTerminalUpdate(THREAD, "complete", "agent");

  const outcome = svc.setGoal(THREAD, { objective: "revised" }, "user");
  assert.equal(outcome.goal?.status, "active");
  assert.equal(outcome.goal?.objective, "revised");
  // usage preserved
  assert.equal(outcome.goal?.tokensUsed, 0);
});

test("setGoal preserves usage and timestamps", () => {
  const svc = setup();
  const created = svc.createGoal(THREAD, "base");
  assert.ok(created.goal);
  // account some usage via the db directly
  void created.goal;
  const outcome = svc.setGoal(THREAD, { objective: "updated" }, "user");
  assert.equal(outcome.goal?.objective, "updated");
  assert.equal(outcome.goal?.status, "active");
});

test("setGoal with a status of paused stops continuation", () => {
  const svc = setup();
  svc.createGoal(THREAD, "base");
  svc.registerContinuation(THREAD);
  const outcome = svc.setGoal(THREAD, { status: "paused" }, "user");
  assert.equal(outcome.goal?.status, "paused");
  assert.equal(outcome.effect, "stop");
});

test("goal_updated event fires on each mutation", () => {
  const svc = setup();
  const events: string[] = [];
  svc.onGoalUpdated((g) => events.push(g?.status ?? "none"));
  svc.createGoal(THREAD, "base");
  svc.requestTerminalUpdate(THREAD, "complete", "agent");
  svc.clearGoal(THREAD, "user");
  assert.deepEqual(events, ["active", "complete", "none"]);
});
