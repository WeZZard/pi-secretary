import assert from "node:assert/strict";
import { AgentAssociationStore } from "../../extensions/secretary/composition/association-store.ts";
import { AUTOMATIC_TYPE } from "../../extensions/secretary/goal/synchronization.ts";
import { standaloneAgentHarness } from "../support/standalone-agent-harness.ts";
import { configurationHarness } from "./configuration-harness.ts";
import { runFeatures, tick, type ScenarioBindings } from "./support.ts";

const bindings: ScenarioBindings = {
  // This binding exercises installed tools with an adapter parent and real SDK children.
  // tests/integration/goal-agent-composition.test.ts separately proves real parent SDK ingress.
  "ACC-SA-08-10": async ({ t }) => {
    const h = await configurationHarness(t); await h.definition("recovery-worker"); await h.start();
    await h.goal();
    h.replies.push({ text: "ORIGINAL_RELEASE_SUMMARY" });
    const initial = await h.launch({ subagent_type: "recovery-worker", name: "release-worker", run_in_background: false });
    assert.equal(initial.details.status, "succeeded");
    assert.equal(h.repository.getAgent(initial.details.agentId)?.resumable, true);
    h.engine.service.requestTerminalUpdate("parent", "blocked", "user");
    const blocked = structuredClone(h.engine.service.getGoal("parent"));
    assert.equal(blocked?.status, "blocked");
    const automaticBefore = h.sent.filter(item => item.message.customType === AUTOMATIC_TYPE).length;

    await h.begin("Without resuming the goal, delegate network diagnostics and ask the finished release worker to inventory backup procedures. This recovery extends beyond the original objective.");
    h.replies.push({ text: "NETWORK_DIAGNOSTICS_DONE" });
    const fresh = await h.launch({ subagent_type: "recovery-worker", name: "network-worker", prompt: "Inspect network diagnostics", run_in_background: false });
    assert.equal(fresh.details.status, "succeeded");
    assert.match(fresh.details.output, /NETWORK_DIAGNOSTICS_DONE/);
    h.replies.push({ text: "BACKUP_PROCEDURES_DONE" });
    const resumed = await h.tool("SendMessage", { to: initial.details.agentId, message: "Inventory backup procedures beyond the old objective" });
    const observed = await h.finish(resumed.details.runId);
    assert.equal(observed.details.status, "succeeded");
    assert.match(observed.details.output, /BACKUP_PROCEDURES_DONE/);
    assert.equal(resumed.details.agentId, initial.details.agentId);
    assert.notEqual(resumed.details.runId, initial.details.runId);
    assert.notEqual(fresh.details.agentId, initial.details.agentId);
    assert.ok(h.calls.some(call => /ORIGINAL_RELEASE_SUMMARY/.test(JSON.stringify(call.context.messages))
      && /Inventory backup procedures/.test(JSON.stringify(call.context.messages))));
    const associations = new AgentAssociationStore(h.engine.db.connection);
    for (const runId of [fresh.details.runId, resumed.details.runId]) {
      assert.equal(associations.run(runId)?.authority, "user");
      assert.equal(associations.run(runId)?.goal, undefined);
      assert.equal(h.repository.getRun(runId)?.status, "succeeded");
    }
    h.sync.settled(); h.setIdle(true); h.sync.requestAutomatic(); await tick();
    await h.emit("agent_settled"); await tick();
    assert.deepEqual(h.engine.service.getGoal("parent"), blocked);
    assert.equal(h.sent.filter(item => item.message.customType === AUTOMATIC_TYPE).length, automaticBefore);
    assert.equal(h.calls.length, 3, "Both recovery results come from completed child executions");
  },
  "ACC-SA-08-11": async ({ t }) => {
    const h = await standaloneAgentHarness(t, { observeEvents: false });
    const initial = await h.tool("Agent", { description: "Standalone work", prompt: "First assignment", subagent_type: "worker", name: "standalone-worker", run_in_background: false });
    assert.equal(initial.details.status, "succeeded");
    const resumed = await h.tool("SendMessage", { to: initial.details.agentId, message: "A new standalone assignment" });
    const observed = await h.tool("TaskOutput", { task_id: resumed.details.runId, block: true, timeout: 10000 });
    assert.equal(observed.details.status, "succeeded");
    assert.match(observed.details.output, /STANDALONE_DONE/);
    assert.equal(resumed.details.agentId, initial.details.agentId);
    assert.notEqual(resumed.details.runId, initial.details.runId);
    for (const runId of [initial.details.runId, resumed.details.runId]) {
      assert.ok(h.repository.usage(runId).length > 0);
      assert.ok(h.repository.completions(h.manager.getSessionId()).some(completion => completion.runId === runId));
    }
    assert.deepEqual(h.events, []);
    const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name));
    assert.ok(tables.length > 0);
    assert.ok(tables.every(name => name.startsWith("secretary_agent")), JSON.stringify(tables));
    assert.ok(!tables.some(name => /goal|composition/.test(name)));
    assert.equal(h.childCalls.length, 2);
  },
};

runFeatures(["goal-agent-composition"], bindings, {
  "goal-agent-composition": "d5643f622983f99732bcee02fc460d1d32167024d09eaccbc759c8c8a243e147",
});
