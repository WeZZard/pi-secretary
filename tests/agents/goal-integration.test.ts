import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";
import { GoalService } from "../../extensions/secretary/goal/goal-service.ts";
import { agentHarness } from "../support/agent-harness.ts";

function fixture(t: import("node:test").TestContext) {
  const engine = new GoalEngine({ dbPath: ":memory:", enabled: true });
  t.after(() => { engine.dispose(); engine.close(); });
  const goal = engine.service.createGoal("parent", "Original objective", 1000, "user").goal!;
  return { engine, service: engine.service, goal };
}

test("attributed public foreground launch uses goal-budget formula once and does not complete the goal", async (t) => {
  const h = await agentHarness(t);
  await h.start();
  const goal = h.engine.service.createGoal("parent", "Inspect fixture", 1000, "user").goal!;
  await h.emit("input", { text: "Delegate inspection", source: "interactive" });
  await h.emit("before_agent_start", { prompt: "Delegate inspection" });
  await h.emit("message_start", { message: { role: "user", content: "Delegate inspection", timestamp: Date.now() } });
  await h.emit("turn_start");
  const result = await h.tool("Agent", { description: "Inspect", prompt: "Inspect fixture" });
  assert.equal(result.details.goal?.goalId, goal.goalId);
  const current = h.engine.service.getGoal("parent")!;
  assert.equal(current.tokensUsed, 80, "goal-budget token usage = max(100 - 40, 0) + max(20, 0)");
  assert.equal(current.status, "active");
  assert.equal(result.usage, undefined, "foreground result must not re-report child usage for a second charge");
});

test("usage application commits before observers and deduplicates across service recreation", (t) => {
  const { engine, service, goal } = fixture(t);
  let events = 0;
  service.onListenerError = error => { throw error; };
  const observed: Array<{ transaction: boolean; duplicate: unknown }> = [];
  service.onGoalChanged(event => {
    if (event.reason !== "accounting") return;
    events++;
    observed.push({ transaction: engine.db.connection.isTransaction, duplicate: service.accountAgentUsage("event-1", "parent", goal.goalId, 80) });
  });
  service.accountAgentUsage("event-1", "parent", goal.goalId, 80);
  assert.equal(events, 1);
  assert.deepEqual(observed, [{ transaction: false, duplicate: null }]);
  const restored = new GoalService(engine.db);
  assert.equal(restored.accountAgentUsage("event-1", "parent", goal.goalId, 80), null);
  assert.equal(restored.getGoal("parent")!.tokensUsed, 80);
});

test("late usage charges paused origin without resuming and retains budget precedence", (t) => {
  const { service, goal } = fixture(t);
  service.requestTerminalUpdate("parent", "paused", "user");
  service.accountAgentUsage("late", "parent", goal.goalId, 80);
  assert.equal(service.getGoal("parent")!.status, "paused");
  assert.equal(service.getGoal("parent")!.tokensUsed, 80);
  service.setGoal("parent", { status: "active" }, "user");
  service.accountAgentUsage("exhausted", "parent", goal.goalId, 920);
  assert.equal(service.getGoal("parent")!.status, "budget_limited");
  service.requestTerminalUpdate("parent", "paused", "user");
  assert.equal(service.getGoal("parent")!.status, "budget_limited");
  assert.equal(service.getGoal("parent")!.tokensUsed, 1000);
});

test("deleted and replaced origins are not recreated or charged to replacement goals", (t) => {
  const { engine, service, goal } = fixture(t);
  service.clearGoal("parent", "user");
  assert.equal(service.accountAgentUsage("deleted", "parent", goal.goalId, 80), null);
  assert.equal(service.getGoal("parent"), null);
  const replacement = service.createGoal("parent", "Replacement", 1000, "user").goal!;
  assert.notEqual(replacement.goalId, goal.goalId);
  assert.equal(service.accountAgentUsage("replaced", "parent", goal.goalId, 80), null);
  assert.equal(service.accountAgentUsage("deleted", "parent", replacement.goalId, 80), null, "a consumed source event cannot be reassigned");
  assert.equal(service.getGoal("parent")!.tokensUsed, 0);
  const markers = engine.db.connection.prepare("SELECT event_id, applied FROM secretary_agent_goal_usage ORDER BY event_id").all();
  assert.deepEqual(markers.map(row => [row.event_id, row.applied]), [["deleted", 0], ["replaced", 0]]);
});

test("failed accounting rolls back the dedup marker so the same source event can be retried", (t) => {
  const { engine, service, goal } = fixture(t);
  engine.db.connection.exec("CREATE TRIGGER reject_child_usage BEFORE UPDATE ON thread_goals BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
  assert.throws(() => service.accountAgentUsage("retry", "parent", goal.goalId, 80), /injected write failure/);
  assert.equal(service.getGoal("parent")!.tokensUsed, 0);
  engine.db.connection.exec("DROP TRIGGER reject_child_usage");
  service.accountAgentUsage("retry", "parent", goal.goalId, 80);
  assert.equal(service.getGoal("parent")!.tokensUsed, 80);
  assert.equal(service.accountAgentUsage("retry", "parent", goal.goalId, 80), null);
});
