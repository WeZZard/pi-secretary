import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalOrdering } from "../../extensions/secretary/goal/ordering.ts";
import { GoalService } from "../../extensions/secretary/goal/goal-service.ts";
import { GoalDb } from "../../extensions/secretary/goal/storage/goal-db.ts";

function setup() { return new GoalService(GoalDb.open(":memory:"), "epoch", () => 7); }

test("one epoch sequence orders threads, tied clocks, and backwards clocks", () => {
  let now = 100;
  const ordering = new GoalOrdering("epoch", () => now);
  const first = ordering.receive("a", "input", null);
  const second = ordering.receive("b", "command", null);
  now = 1;
  const third = ordering.stamp("a");
  assert.deepEqual([first.sequence, second.sequence, third.sequence], [1, 2, 3]);
  assert.deepEqual([first.occurredAtMs, second.occurredAtMs, third.occurredAtMs], [100, 100, 1]);
  assert.equal(ordering.intentSeq("a"), 0);
  ordering.accept(first);
  assert.equal(ordering.intentSeq("a"), 1);
  assert.equal(ordering.intentSeq("b"), 0);
});

test("pending input and successful publications are independent of intent", () => {
  const ordering = new GoalOrdering("epoch");
  const published = ordering.publish("a", "goal", 4, 2);
  const receipt = ordering.receive("a", "input", "goal");
  assert.equal(receipt.publication, published);
  assert.equal(ordering.hasPending("a"), true);
  assert.equal(ordering.hasPending("b"), false);
  const repainted = ordering.publish("a", "goal", 4, 2);
  assert.equal(ordering.publication("a"), repainted);
  assert.equal(receipt.publication, published);
  assert.equal(ordering.intentSeq("a"), 0);
  ordering.resolve(receipt);
  assert.equal(ordering.hasPending("a"), false);
  assert.throws(() => ordering.accept(receipt), /not pending/);
  assert.equal(ordering.intentSeq("a"), 0);
});

test("receipts must be owned and applicable to the epoch and target", () => {
  const ordering = new GoalOrdering("epoch");
  const receipt = ordering.receive("a", "dialog", "goal");
  assert.throws(() => ordering.accept({ ...receipt }), /not pending/);
  assert.throws(() => new GoalOrdering("epoch").accept(receipt), /not pending/);
  assert.throws(() => new GoalOrdering("other").assertApplicable(receipt, "goal"), /epoch/);
  assert.throws(() => ordering.assertApplicable(receipt, "replacement"), /target changed/);
  ordering.assertApplicable(receipt, "goal");
});

test("late earlier decisions cannot overwrite newer accepted intent", () => {
  const svc = setup();
  const goal = svc.createGoal("a", "base").goal!;
  const early = svc.ordering.receive("a", "dialog", goal.goalId);
  const late = svc.ordering.receive("a", "command", goal.goalId);
  svc.setGoal("a", { status: "paused" }, "user", late);
  const version = svc.getVersion("a");
  assert.throws(() => svc.setGoal("a", { status: "active" }, "user", early), /older/);
  assert.equal(svc.getGoal("a")?.status, "paused");
  assert.deepEqual(svc.getVersion("a"), version);
  assert.equal(svc.ordering.intentSeq("a"), late.sequence);
  assert.equal(svc.ordering.hasPending("a"), false);
});

test("replacement and cross-thread receipts are rejected before writes", () => {
  const svc = setup();
  const first = svc.createGoal("a", "base").goal!;
  const receipt = svc.ordering.receive("a", "dialog", first.goalId);
  svc.requestTerminalUpdate("a", "complete", "agent");
  svc.createGoal("a", "replacement", undefined, "system");
  assert.throws(() => svc.setGoal("a", { objective: "stale" }, "user", receipt), /target changed/);
  const cross = svc.ordering.receive("b", "input", svc.getGoal("a")!.goalId);
  assert.throws(() => svc.clearGoal("a", "user", undefined, cross), /different thread/);
  assert.equal(svc.getGoal("a")?.objective, "replacement");
  assert.equal(svc.ordering.hasPending("b"), false);
});

test("no-op resume advances intent without a fake mutation or version", () => {
  const svc = setup();
  const goal = svc.createGoal("a", "base").goal!;
  const version = svc.getVersion("a");
  const previousEvent = svc.getLastChange("a");
  let accepted = 0;
  let changed = 0;
  svc.onIntentAccepted(() => accepted++);
  svc.onGoalChanged(() => changed++);
  const receipt = svc.ordering.receive("a", "command", goal.goalId);
  assert.equal(svc.setGoal("a", { status: "active" }, "user", receipt).effect, "unchanged");
  assert.equal(svc.ordering.intentSeq("a"), receipt.sequence);
  assert.equal(accepted, 1);
  assert.equal(changed, 0);
  assert.deepEqual(svc.getVersion("a"), version);
  assert.equal(svc.getLastChange("a"), previousEvent);
});

test("failed writes and no-target changes release input without accepting intent", () => {
  const svc = setup();
  svc.clearGoal("a", "user");
  assert.equal(svc.ordering.intentSeq("a"), 0);
  assert.equal(svc.ordering.hasPending("a"), false);
  svc.createGoal("a", "base");
  const intent = svc.ordering.intentSeq("a");
  assert.throws(() => svc.createGoal("a", "replacement", undefined, "user"), /unfinished/);
  assert.throws(() => svc.setGoal("a", { objective: " " }, "user"));
  assert.throws(() => svc.requestTerminalUpdate("missing", "paused", "user"), /no goal/);
  svc.clearGoal("a", "user", "stale");
  svc.beforeGoalClear = () => { throw new Error("checkpoint failed"); };
  assert.throws(() => svc.clearGoal("a", "user"), /checkpoint failed/);
  assert.equal(svc.ordering.intentSeq("a"), intent);
  assert.equal(svc.ordering.intentSeq("missing"), 0);
  assert.equal(svc.ordering.hasPending("a"), false);
  assert.equal(svc.ordering.hasPending("missing"), false);
});

test("accepted receipts retain sequence and resulting identity across operations", () => {
  for (const existing of [false, true]) {
    const svc = setup();
    if (existing) {
      svc.createGoal("a", "old");
      svc.requestTerminalUpdate("a", "complete", "agent");
    }
    const receipt = svc.ordering.receive("a", "input", svc.getGoal("a")?.goalId ?? null);
    let notifications = 0;
    svc.onIntentAccepted(() => notifications++);
    const created = svc.createGoal("a", "new", undefined, "agent", receipt).goal!;
    assert.equal(svc.ordering.hasPending("a"), false);
    svc.ordering.resolve(receipt);
    svc.ordering.assertApplicable(receipt, created.goalId);
    svc.requestTerminalUpdate("a", "paused", "agent", created.goalId, receipt);
    assert.equal(svc.getGoal("a")?.status, "paused");
    assert.equal(svc.ordering.intentSeq("a"), receipt.sequence);
    assert.equal(svc.getLastChange("a")?.acceptedIntentSeq, receipt.sequence);
    assert.equal(notifications, 1);
    svc.setGoal("a", { status: "active" }, "user");
    assert.throws(() => svc.requestTerminalUpdate("a", "paused", "agent", created.goalId, receipt), /older/);
    assert.equal(svc.getGoal("a")?.status, "active");
  }
});

test("agent complete and blocked are outcomes, explicit agent pause is intent", () => {
  const svc = setup();
  const goal = svc.createGoal("a", "base").goal!;
  const initialIntent = svc.ordering.intentSeq("a");
  for (const status of ["blocked", "complete"] as const) {
    const receipt = svc.ordering.receive("a", "input", goal.goalId);
    svc.requestTerminalUpdate("a", status, "agent", goal.goalId, receipt);
    assert.equal(svc.ordering.intentSeq("a"), initialIntent);
    assert.equal(svc.getLastChange("a")?.acceptedIntentSeq, undefined);
    assert.equal(svc.ordering.hasPending("a"), false);
  }
  const pause = svc.ordering.receive("a", "input", goal.goalId);
  svc.requestTerminalUpdate("a", "paused", "agent", goal.goalId, pause);
  assert.equal(svc.ordering.intentSeq("a"), pause.sequence);
});

test("accepted-intent observers are isolated and notified after state publication",  () => {
  const svc = setup();
  const observed: string[] = [];
  let errors = 0;
  svc.onListenerError = () => { errors++; throw new Error("reporter"); };
  svc.onIntentAccepted(() => { throw new Error("observer"); });
  const unsubscribe = svc.onIntentAccepted((receipt) => {
    assert.equal(svc.getGoal("a")?.objective, "base");
    assert.equal(svc.ordering.intentSeq("a"), receipt.sequence);
    observed.push("intent");
  });
  svc.onGoalChanged((event) => {
    observed.push("change");
    assert.equal(event.sessionEpoch, svc.ordering.sessionEpoch);
    assert.equal(event.sessionEpoch, svc.getVersion("a").sessionEpoch);
    assert.equal(event.occurredAtMs, 7);
    assert.ok(event.eventSeq > event.acceptedIntentSeq!);
  });
  assert.doesNotThrow(() => svc.createGoal("a", "base"));
  unsubscribe();
  svc.setGoal("a", { status: "active" }, "user");
  assert.deepEqual(observed, ["change", "intent"]);
  assert.equal(errors, 2);
});
