/**
 * GoalService tests — traceability matrix §2 service rows.
 * Mirrors `codex-rs/ext/goal/tests/goal_extension_backend.rs` service scenarios.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalDb } from "../../extensions/secretary/goal/storage/goal-db.ts";
import { GoalService, type GoalChangedEvent } from "../../extensions/secretary/goal/goal-service.ts";

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

test("requestTerminalUpdate complete returns stop effect and emits", () => {
  const svc = setup();
  svc.createGoal(THREAD, "base");
  let emitted: string | null = null;
  svc.onGoalUpdated((g) => (emitted = g?.objective ?? null));

  const outcome = svc.requestTerminalUpdate(THREAD, "complete", "agent");
  assert.equal(outcome.goal?.status, "complete");
  assert.equal(outcome.effect, "stop");
  assert.equal(outcome.steering, "complete");
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

test("objective-only edit preserves a complete goal's status; explicit active reactivates it", () => {
  const svc = setup();
  svc.createGoal(THREAD, "original");
  svc.requestTerminalUpdate(THREAD, "complete", "agent");

  // objective-only edit preserves the terminal status (Codex precedence)
  const preserve = svc.setGoal(THREAD, { objective: "revised" }, "user");
  assert.equal(preserve.goal?.status, "complete");
  assert.equal(preserve.goal?.objective, "revised");
  assert.equal(preserve.goal?.tokensUsed, 0);

  // explicit active status reactivates a completed goal
  const reactivated = svc.setGoal(THREAD, { objective: "revised", status: "active" }, "user");
  assert.equal(reactivated.goal?.status, "active");
  assert.equal(reactivated.goal?.objective, "revised");
});

test("setGoal preserves usage and timestamps", () => {
  const svc = setup();
  const created = svc.createGoal(THREAD, "base");
  assert.ok(created.goal);
  svc.accountGoalUsage(THREAD, 8, 12, "active_only");
  const outcome = svc.setGoal(THREAD, { objective: "updated" }, "user");
  assert.equal(outcome.goal?.objective, "updated");
  assert.equal(outcome.goal?.status, "active");
  assert.equal(outcome.goal?.tokensUsed, 12);
  assert.equal(outcome.goal?.timeUsedSeconds, 8);
  assert.equal(outcome.goal?.createdAt, created.goal.createdAt);
});

test("setGoal with a status of paused stops continuation", () => {
  const svc = setup();
  svc.createGoal(THREAD, "base");
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

test("typed events preserve snapshots, clear identity, and per-thread versions", () => {
  const svc = new GoalService(GoalDb.open(":memory:"), "epoch");
  const events: GoalChangedEvent[] = [];
  svc.onGoalChanged((event) => events.push(event));
  assert.deepEqual(svc.getVersion(THREAD), { sessionEpoch: "epoch", revision: 0, controlGeneration: 0 });
  assert.equal(svc.getLastChange(THREAD), null);
  const original = svc.createGoal(THREAD, "base", 10, "user").goal!;
  const charged = svc.accountGoalUsage(THREAD, 1, 4, "active_only")!;
  const edited = svc.setGoal(THREAD, { objective: "edited" }, "user").goal!;
  const limited = svc.accountGoalUsage(THREAD, 1, 6, "active_only")!;
  const finalized = svc.accountGoalUsage(THREAD, 2, 3, "active_or_stopped")!;
  svc.clearGoal(THREAD, "user");
  assert.deepEqual(events.map((e) => [e.revision, e.controlGeneration]), [[1,1],[2,1],[3,2],[4,3],[5,3],[6,4]]);
  assert.deepEqual(events.map((e) => e.reason), ["create", "accounting", "edit", "accounting", "accounting", "clear"]);
  assert.deepEqual(events.map((e) => e.previousGoal), [null, original, charged, edited, limited, finalized]);
  assert.deepEqual(events.map((e) => e.goal), [original, charged, edited, limited, finalized, null]);
  assert.equal(events[0].source, "user");
  assert.equal(events[5].threadId, THREAD);
  assert.equal(events[5].sessionEpoch, "epoch");
  assert.equal(finalized.tokensUsed, 13);
  assert.equal(finalized.status, "budget_limited");
  assert.deepEqual(svc.getLastChange(THREAD), events[5]);
  assert.equal(svc.getVersion("another-thread").revision, 0);
});

test("no-op mutations and stale clears/stops do not emit or advance versions", () => {
  const svc = setup();
  const events: GoalChangedEvent[] = [];
  const legacy: unknown[] = [];
  svc.onGoalChanged((e) => events.push(e));
  svc.onGoalUpdated((g) => legacy.push(g));
  assert.equal(svc.clearGoal(THREAD, "user").effect, "unchanged");
  const goal = svc.createGoal(THREAD, "base").goal!;
  assert.equal(svc.setGoal(THREAD, { objective: "base" }, "user").effect, "unchanged");
  assert.equal(svc.accountGoalUsage(THREAD, 0, 0, "active_only"), null);
  assert.equal(svc.stopActiveGoal(THREAD, "blocked", "stale", "run_error"), null);
  assert.deepEqual(svc.clearGoal(THREAD, "user", "stale").goal, goal);
  assert.equal(events.length, 1);
  assert.equal(legacy.length, 1);
  assert.equal(svc.getVersion(THREAD).revision, 1);
  svc.clearGoal(THREAD, "user", goal.goalId);
  svc.clearGoal(THREAD, "user");
  assert.equal(events.length, 2);
});

test("listeners and error handlers cannot fail committed writes or other listeners", () => {
  const svc = setup();
  let received = 0;
  let errors = 0;
  svc.onListenerError = () => { errors++; throw new Error("reporter failed"); };
  svc.onGoalChanged(() => { throw new Error("renderer failed"); });
  svc.onGoalChanged(() => { received++; });
  svc.onGoalUpdated(() => { throw new Error("legacy failed"); });
  const unsubscribe = svc.onGoalUpdated(() => { received++; });
  assert.doesNotThrow(() => svc.createGoal(THREAD, "base"));
  assert.equal(svc.getGoal(THREAD)?.objective, "base");
  unsubscribe();
  assert.doesNotThrow(() => svc.clearGoal(THREAD, "user"));
  assert.equal(received, 3);
  assert.equal(errors, 4);
});

test("system stop records explicit cause and ignores a repeated status", () => {
  const svc = setup();
  const goal = svc.createGoal(THREAD, "base").goal!;
  svc.stopActiveGoal(THREAD, "blocked", goal.goalId, "empty_response");
  const event = svc.getLastChange(THREAD)!;
  assert.equal(event.reason, "status");
  assert.equal(event.source, "system");
  assert.equal(event.stopCause, "empty_response");
  svc.stopActiveGoal(THREAD, "blocked", goal.goalId, "run_error");
  assert.equal(svc.getLastChange(THREAD), event);
});

test("fork imports exact snapshots and refuses unfinished targets", () => {
  const svc = setup();
  svc.createGoal(THREAD, "source", 100);
  svc.accountGoalUsage(THREAD, 12, 30, "active_only");
  const source = svc.getGoal(THREAD)!;
  const imported = svc.importGoal(source, "fork");
  assert.deepEqual(imported, { ...source, threadId: "fork" });
  assert.deepEqual(svc.getLastChange("fork")?.goal, imported);
  assert.equal(svc.getLastChange("fork")?.reason, "fork");
  assert.equal(svc.getLastChange("fork")?.source, "system");
  assert.equal(svc.importGoal(source, "fork"), null);
  svc.requestTerminalUpdate("fork", "complete", "user");
  svc.importGoal(source, "fork");
  assert.deepEqual(svc.getGoal("fork"), { ...source, threadId: "fork" });
  assert.deepEqual(svc.getGoal(THREAD), source);
});

test("invalid edits leave the goal and event version unchanged", () => {
  const svc = setup();
  const goal = svc.createGoal(THREAD, "base", 20).goal!;
  for (const objective of [" ", "x".repeat(4001)]) {
    assert.throws(() => svc.setGoal(THREAD, { objective }, "user"));
  }
  for (const tokenBudget of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => svc.setGoal(THREAD, { tokenBudget }, "user"));
  }
  assert.deepEqual(svc.getGoal(THREAD), goal);
  assert.equal(svc.getVersion(THREAD).revision, 1);
  assert.equal(svc.setGoal(THREAD, { tokenBudget: null }, "user").goal?.tokenBudget, undefined);
});

test("clear checkpoints usage before deletion and exposes the final snapshot", () => {
  const svc = setup();
  const goal = svc.createGoal(THREAD, "base").goal!;
  let calls = 0;
  svc.beforeGoalClear = (threadId, expectedGoalId) => {
    calls++;
    assert.equal(expectedGoalId, goal.goalId);
    svc.accountGoalUsage(threadId, 2, 7, "active_or_stopped", expectedGoalId);
  };
  svc.clearGoal(THREAD, "user", "stale");
  assert.equal(calls, 0);
  const cleared = svc.clearGoal(THREAD, "user", goal.goalId);
  assert.equal(cleared.previousGoal?.tokensUsed, 7);
  assert.equal(svc.getLastChange(THREAD)?.previousGoal?.timeUsedSeconds, 2);
  assert.equal(svc.getVersion(THREAD).revision, 3);
  svc.clearGoal(THREAD, "user");
  assert.equal(calls, 1);
});

test("failed checkpoint or replacement in checkpoint prevents deletion", () => {
  const svc = setup();
  const original = svc.createGoal(THREAD, "base").goal!;
  svc.beforeGoalClear = () => { throw new Error("checkpoint failed"); };
  assert.throws(() => svc.clearGoal(THREAD, "user"), /checkpoint failed/);
  assert.deepEqual(svc.getGoal(THREAD), original);
  svc.beforeGoalClear = () => {
    svc.requestTerminalUpdate(THREAD, "complete", "system");
    svc.createGoal(THREAD, "replacement");
  };
  const result = svc.clearGoal(THREAD, "user");
  assert.equal(result.effect, "unchanged");
  assert.equal(result.goal?.objective, "replacement");
  assert.equal(svc.getLastChange(THREAD)?.reason, "create");
});
