import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";
import { AgentAssociationStore } from "../../extensions/secretary/composition/association-store.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
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
  const association = new AgentAssociationStore(h.engine.db.connection).run(result.details.runId);
  assert.equal(association?.goal?.goalId, goal.goalId);
  assert.equal(association?.authority, "user");
  assert.equal(Object.hasOwn(result.details, "goal"), false);
  const current = h.engine.service.getGoal("parent")!;
  assert.equal(current.tokensUsed, 80, "goal-budget token usage = max(100 - 40, 0) + max(20, 0)");
  assert.equal(current.status, "active");
  assert.equal(result.usage, undefined, "foreground result must not re-report child usage for a second charge");
});

test("a failed association observer retains request and source usage for session-start replay", async (t) => {
  const h = await agentHarness(t); await h.start();
  const goal = h.engine.service.createGoal("parent", "Replay captured attribution", 1000, "user").goal!;
  await h.emit("input", { text: "Delegate inspection", source: "interactive" });
  await h.emit("before_agent_start", { prompt: "Delegate inspection" });
  await h.emit("message_start", { message: { role: "user", content: "Delegate inspection", timestamp: Date.now() } });
  await h.emit("turn_start");
  h.engine.db.connection.exec("CREATE TRIGGER interrupt_association BEFORE INSERT ON secretary_composition_runs BEGIN SELECT RAISE(ABORT, 'mapping unavailable'); END");
  const result = await h.tool("Agent", { description: "Inspect", prompt: "Inspect fixture" });
  const store = new AgentAssociationStore(h.engine.db.connection);
  assert.equal(store.run(result.details.runId), undefined);
  assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, 0);
  const row = h.engine.db.connection.prepare("SELECT json FROM secretary_agent_runs WHERE id = ?").get(result.details.runId)!;
  const run = JSON.parse(String(row.json));
  assert.equal(store.request(run.requestId)?.goal?.goalId, goal.goalId, "Request attribution survives a failed run-mapping observer");
  assert.equal(h.engine.db.connection.prepare("SELECT COUNT(*) AS n FROM secretary_agent_usage WHERE run_id = ?").get(run.runId)!.n, 1);
  h.engine.db.connection.exec("DROP TRIGGER interrupt_association");
  await h.emit("session_start", { reason: "resume" });
  assert.equal(store.run(run.runId)?.goal?.goalId, goal.goalId);
  assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, 80, "Replay applies goal-budget token usage = max(100 - 40, 0) + max(20, 0)");
  await h.emit("session_start", { reason: "resume" });
  assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, 80, "Repeated replay does not charge the source event twice");
});

test("root session replay recovers failed descendant mappings across owner sessions without charging unrelated owners", async (t) => {
  const h = await agentHarness(t); await h.start();
  const goal = h.engine.service.createGoal("parent", "Recover nested accounting", 1000, "user").goal!;
  await h.emit("input", { text: "Delegate nested inspection", source: "interactive" });
  await h.emit("before_agent_start", { prompt: "Delegate nested inspection" });
  await h.emit("message_start", { message: { role: "user", content: "Delegate nested inspection", timestamp: Date.now() } });
  await h.emit("turn_start");
  const result = await h.tool("Agent", { description: "Inspect", prompt: "Inspect fixture" });
  const repository = new AgentRepository(h.engine.db.connection);
  const store = new AgentAssociationStore(h.engine.db.connection);
  const rootRun = repository.getRun(result.details.runId)!;
  const rootAgent = repository.getAgent(rootRun.agentId)!;
  assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, 80);
  h.engine.db.connection.exec("CREATE TRIGGER interrupt_descendant_mapping BEFORE INSERT ON secretary_composition_runs BEGIN SELECT RAISE(ABORT, 'descendant mapping unavailable'); END");
  const sources = [
    { agentId: "nested-child", parentId: "child-owner", parentAgentId: rootAgent.agentId, outputTokens: 7 },
    { agentId: "nested-grandchild", parentId: "grandchild-owner", parentAgentId: "nested-child", outputTokens: 9 },
    { agentId: "unrelated-child", parentId: "unrelated-owner", parentAgentId: undefined, outputTokens: 13 },
  ];
  for (const source of sources) {
    const runId = `${source.agentId}-run`;
    repository.putAgent({ ...rootAgent, agentId: source.agentId, parentId: source.parentId, parentAgentId: source.parentAgentId, name: undefined });
    repository.putRun({ ...rootRun, agentId: source.agentId, parentId: source.parentId, runId, launchKey: runId });
    repository.recordUsage({ id: `${runId}-usage`, runId, usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, outputTokens: source.outputTokens, totalTokens: source.outputTokens } });
    assert.throws(() => store.associateRun(runId, rootRun.requestId!), /descendant mapping unavailable/);
    assert.equal(store.run(runId), undefined);
  }
  h.engine.db.connection.exec("DROP TRIGGER interrupt_descendant_mapping");
  await h.emit("session_start", { reason: "resume" });
  for (const source of sources.slice(0, 2)) {
    assert.equal(store.run(`${source.agentId}-run`)?.goal?.goalId, goal.goalId);
    assert.equal(repository.usage(`${source.agentId}-run`).length, 1);
  }
  assert.equal(store.run("unrelated-child-run"), undefined);
  assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, 96,
    "Goal-budget token usage = root 80 + max(0 - 0, 0) + max(7, 0) + max(0 - 0, 0) + max(9, 0)");
  await h.emit("session_start", { reason: "resume" });
  assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, 96, "Descendant source-event markers prevent replay charges");
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
