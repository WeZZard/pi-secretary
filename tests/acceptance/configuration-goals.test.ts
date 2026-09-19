import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { discoverAgents } from "../../extensions/secretary/agents/registry.ts";
import { loadAgentConfiguration } from "../../extensions/secretary/agents/configuration.ts";
import { GoalService } from "../../extensions/secretary/goal/goal-service.ts";
import { goalTokenDeltaForUsage } from "../../extensions/secretary/goal/accounting.ts";
import { AUTOMATIC_TYPE } from "../../extensions/secretary/goal/synchronization.ts";
import { configurationHarness, eventually } from "./configuration-harness.ts";
import { runFeatures, deferred, tick, type ScenarioBindings } from "./support.ts";

const bindings: ScenarioBindings = {
  "ACC-SA-07-01": async ({ t }) => {
    const h = await configurationHarness(t);
    await h.put(join(h.userDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: {
      primary: ["test-provider/reviewer-model", "test-provider/different-model"],
      secondary: ["test-provider/parent-model"],
    } } }));
    await h.start();
    const schema = h.tools.get("Agent").parameters;
    assert.deepEqual(schema.properties.model.enum, ["primary", "secondary"]);
    assert.ok(!schema.required.includes("model"));
    assert.ok(!schema.properties.model.enum.includes("test-provider/reviewer-model"));
    assert.ok(!Object.hasOwn(schema.properties, "modelAliases"));
    await h.put(join(h.userDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { secondary: ["test-provider/reviewer-model"] } } }));
    assert.deepEqual(loadAgentConfiguration(h.root, h.userDir, true).modelFallbackLists.secondary, ["test-provider/reviewer-model"]);
    await assert.rejects(h.launch({ model: "unknown-list" }), /Unknown model fallback list: unknown-list/);
    assert.equal(h.calls.length, 0);
  },
  "ACC-SA-07-02": async ({ t }) => {
    const h = await configurationHarness(t);
    await h.definition("reviewer", "model: test-provider/different-model");
    await h.put(join(h.userDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { primary: ["test-provider/reviewer-model"] } } }));
    await h.start();
    const result = await h.launch({ subagent_type: "reviewer", model: "primary" });
    await h.finish(result.details.runId);
    assert.equal(h.calls[0]!.model, "test-provider/reviewer-model");
    assert.match(result.content[0].text, /Model: test-provider\/reviewer-model/);
    assert.match(h.inspector(result.details.agentId), /test-provider\/reviewer-model/);
  },
  "ACC-SA-07-03": async ({ t }) => {
    const h = await configurationHarness(t); await h.start();
    await assert.rejects(h.launch({ model: "unconfigured" }), /Unknown model fallback list: unconfigured/);
    await h.put(join(h.userDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { empty: [] } } }));
    await assert.rejects(h.launch({ model: "empty" }), /Model fallback list is empty: empty/);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.repository.agents("parent"), []);
  },
  "ACC-SA-07-04": async ({ t }) => {
    const h = await configurationHarness(t); await h.definition("reviewer"); await h.start();
    const gate = deferred<void>(); h.replies.push({ gate });
    const result = await h.launch({ subagent_type: "reviewer" });
    await eventually(() => h.calls.length === 1, "The child reached its provider boundary");
    h.ctx.model = h.models[2]; gate.resolve(); await h.finish(result.details.runId);
    assert.equal(h.calls[0]!.model, "test-provider/parent-model");
    assert.equal(h.repository.getAgent(result.details.agentId)!.model, "test-provider/parent-model");
    assert.match(h.inspector(result.details.agentId), /test-provider\/parent-model/);
  },
  "ACC-SA-07-05": async ({ t, text }) => {
    const h = await configurationHarness(t);
    const packaged = discoverAgents(h.root, h.userDir, false);
    const user = await h.definition("general-purpose", "", "user");
    const project = await h.definition("general-purpose", "", "project");
    const trusted = text.includes("in a trusted project");
    h.ctx.isProjectTrusted = () => trusted;
    await h.start();
    const result = await h.launch({ subagent_type: "general-purpose" }); await h.finish(result.details.runId);
    const source = trusted ? project : user;
    assert.equal(h.repository.getAgent(result.details.agentId)!.definition.source, source);
    assert.ok(h.inspector(result.details.agentId).includes(source));
    assert.ok(packaged.has("general-purpose"), "The precedence fixture overrides a real packaged definition");
  },
  "ACC-SA-07-06": async ({ t }) => {
    const h = await configurationHarness(t);
    const forbidden = ["write", "Agent", "SendMessage", "SubagentWorkflow", "get_goal", "create_goal", "update_goal", "clear_goal"];
    await h.definition("reviewer", `tools: [read, ${forbidden.join(", ")}]`);
    const marker = join(h.root, "unauthorized-execution.log");
    await h.put(join(h.userDir, "extensions", "late-tools.js"), `
      import { appendFileSync } from "node:fs";
      export default function(pi) {
        pi.on("session_start", () => {
          for (const name of ${JSON.stringify(forbidden.filter(n => n !== "write"))}) {
            pi.registerTool({ name, label: name, description: name, parameters: {type:"object", properties:{}},
              async execute() { appendFileSync(${JSON.stringify(marker)}, name); return {content:[],details:{}}; } });
          }
          pi.setActiveTools(${JSON.stringify(["read", ...forbidden])});
        });
      }
    `);
    await h.start();
    for (const name of forbidden) {
      h.replies.push({ tool: { name, arguments: name === "write" ? { path: marker, content: "unauthorized" } : {} } });
      const result = await h.launch({ subagent_type: "reviewer", run_in_background: false });
      const session = h.repository.getAgent(result.details.agentId)!.sessionPath!;
      assert.match(await readFile(session, "utf8"), /not authorized|not found|not available/i, `${name} must be rejected even when the provider requests it`);
    }
    for (const call of h.calls) assert.deepEqual(call.context.tools?.map(tool => tool.name), ["read"]);
    await assert.rejects(access(marker), { code: "ENOENT" });
  },
  "ACC-SA-07-07": async ({ t }) => {
    const h = await configurationHarness(t);
    await h.definition("reviewer", "model: test-provider/reviewer-model", "user", "Saved definition sentinel."); await h.start();
    const first = await h.launch({ subagent_type: "reviewer", run_in_background: false });
    const saved = h.repository.getAgent(first.details.agentId)!;
    await h.definition("reviewer", "model: test-provider/different-model", "user", "Edited definition sentinel.");
    const resume = await h.tool("SendMessage", { to: saved.agentId, message: "Continue explicitly." });
    await h.finish(resume.details.runId);
    assert.equal(h.calls[1]!.model, saved.model);
    assert.match(h.calls[1]!.context.systemPrompt!, /Saved definition sentinel/);
    assert.doesNotMatch(h.calls[1]!.context.systemPrompt!, /Edited definition sentinel/);
    assert.deepEqual(h.repository.getAgent(saved.agentId)!.definition, saved.definition);
    const fresh = await h.launch({ subagent_type: "reviewer", run_in_background: false });
    assert.equal(h.repository.getAgent(fresh.details.agentId)!.model, "test-provider/different-model");
    assert.match(h.calls[2]!.context.systemPrompt!, /Edited definition sentinel/);
    h.pi.getActiveTools = () => ["write", "Agent", "SendMessage", "TaskOutput", "get_goal", "create_goal", "update_goal"];
    const denied = await h.tool("SendMessage", { to: saved.agentId, message: "Recheck current permissions." });
    const outcome = await h.finish(denied.details.runId);
    assert.equal(outcome.details.status, "failed");
    assert.match(outcome.details.error, /no longer has tools permitted/);
    assert.equal(h.calls.length, 3);
  },
  "ACC-SA-07-08": async ({ t }) => {
    const h = await configurationHarness(t); await h.start();
    for (const field of ["nestedDelegation", "permissionMode"]) {
      await h.definition("reviewer", `${field}: true`);
      assert.throws(() => discoverAgents(h.root, h.userDir, true), new RegExp(`unsupported agent field ${field}`));
      await assert.rejects(h.launch({ subagent_type: "reviewer" }), new RegExp(`unsupported agent field ${field}`));
    }
    assert.equal(h.calls.length, 0); assert.equal(h.repository.agents("parent").length, 0);
  },
  "ACC-SA-07-09": async ({ t }) => {
    const h = await configurationHarness(t);
    await h.definition("reviewer");
    await h.put(join(h.userDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { primary: ["test-provider/reviewer-model", "test-provider/different-model"] } } }));
    await h.start();
    h.replies.push({ error: '429 usage_limit_reached {"reset_seconds":30}' }, { text: "Recovered evidence." });
    const result = await h.launch({ subagent_type: "reviewer", model: "primary" });
    const finished = await h.finish(result.details.runId);
    assert.equal(finished.details.status, "succeeded");
    assert.deepEqual(h.calls.map(call => call.model), ["test-provider/reviewer-model", "test-provider/different-model"]);
    assert.equal(h.repository.getAgent(result.details.agentId)!.model, "test-provider/different-model", "The run record adopts the model that actually executed");
    assert.match(finished.content[0].text, /Model: test-provider\/different-model/);
    assert.match(h.inspector(result.details.agentId), /test-provider\/different-model/);
    h.replies.push({ text: "Later evidence." });
    const later = await h.launch({ subagent_type: "reviewer", model: "primary" });
    await h.finish(later.details.runId);
    assert.equal(h.calls[2]!.model, "test-provider/different-model", "The recorded cooldown skips the failed candidate before any provider request");
    assert.match(later.content[0].text, /Fallback: skipped test-provider\/reviewer-model \(cooling down/);
  },
  "ACC-SA-08-01": async ({ t, scenario, text }) => {
    const h = await configurationHarness(t); await h.start(); const goal = await h.goal();
    const table = scenario.steps.find(s => s.argument?.dataTable)?.argument?.dataTable;
    assert.ok(table);
    const values = Object.fromEntries(table.rows.map(row => row.cells.map(cell => cell.value)));
    const input = Number(values.inputTokens), cached = Number(values.cachedInputTokens), output = Number(values.outputTokens);
    const expected = Number(text.match(/usage is (\d+) tokens/)![1]);
    h.replies.push({ input, cached, output });
    const result = await h.launch({ run_in_background: false });
    const event = h.usage()[0]!;
    assert.equal(event.goal!.goalId, goal.goalId);
    assert.deepEqual([event.usage.inputTokens, event.usage.cachedInputTokens, event.usage.outputTokens], [input, cached, output]);
    assert.equal(goalTokenDeltaForUsage(event.usage), expected);
    assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, expected, "goal-budget token usage = max(inputTokens - cachedInputTokens, 0) + max(outputTokens, 0)");
    assert.equal(result.usage, undefined);
  },
  "ACC-SA-08-02": async ({ t }) => {
    const h = await configurationHarness(t); await h.start(); const goal = await h.goal();
    const result = await h.launch({ run_in_background: false }); const event = h.usage()[0]!;
    const delta = goalTokenDeltaForUsage(event.usage);
    assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, delta);
    assert.equal(h.engine.service.accountAgentUsage(event.id, "parent", goal.goalId, delta), null);
    const restored = new GoalService(h.engine.db);
    assert.equal(restored.accountAgentUsage(event.id, "parent", goal.goalId, delta), null);
    assert.equal(restored.getGoal("parent")!.tokensUsed, delta);
    assert.equal(result.usage, undefined, "Foreground reporting must not return child usage for a second charge");
    await h.emit("tool_execution_end", { toolName: "Agent", result, isError: false });
    await h.emit("turn_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Observed" }], usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 } } });
    assert.equal(restored.getGoal("parent")!.tokensUsed, delta);
  },
  "ACC-SA-08-03": async ({ t }) => {
    const h = await configurationHarness(t); await h.start(); const goal = await h.goal();
    const gate = deferred<void>(); h.replies.push({ gate }); const launch = await h.launch();
    await eventually(() => h.calls.length === 1, "Old child has already started");
    h.engine.service.clearGoal("parent", "user");
    const replacement = h.engine.service.createGoal("parent", "Replacement objective", 1000, "user").goal!;
    gate.resolve(); await h.finish(launch.details.runId);
    const events = h.usage(); assert.equal(events.length, 1); assert.equal(events[0]!.goal!.goalId, goal.goalId);
    assert.equal(goalTokenDeltaForUsage(events[0]!.usage), 80);
    assert.equal(h.engine.service.getGoal("parent")!.goalId, replacement.goalId);
    assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, 0);
    assert.equal(h.engine.db.connection.prepare("SELECT COUNT(*) AS n FROM thread_goals WHERE goal_id = ?").get(goal.goalId)!.n, 0);
  },
  "ACC-SA-08-04": async ({ t }) => {
    const h = await configurationHarness(t); await h.start(); const goal = await h.goal();
    const activeTools = h.pi.getActiveTools; h.pi.getActiveTools = () => [...activeTools(), "write"];
    const sideEffect = join(h.root, "paused-write.txt");
    const gate = deferred<void>(); h.replies.push({ gate, tool: { name: "write", arguments: { path: sideEffect, content: "Forbidden" } } });
    const launch = await h.launch(); await eventually(() => h.calls.length === 1, "Work starts before pause");
    h.engine.service.requestTerminalUpdate("parent", "paused", "user"); gate.resolve();
    const outcome = await h.finish(launch.details.runId);
    assert.equal(h.engine.service.getGoal("parent")!.goalId, goal.goalId);
    assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, goalTokenDeltaForUsage(h.usage()[0]!.usage));
    assert.equal(h.engine.service.getGoal("parent")!.status, "paused");
    assert.equal(outcome.details.status, "partial"); assert.match(outcome.details.error, /superseded|budget/); assert.equal(h.calls.length, 1);
    await assert.rejects(access(sideEffect), { code: "ENOENT" });
    await assert.rejects(h.tool("SendMessage", { to: launch.details.agentId, message: "Unauthorized resumption" }), /superseded|paused|authorize/);
  },
  "ACC-SA-08-05": async ({ t }) => {
    const h = await configurationHarness(t); await h.start(); const goal = await h.goal();
    const result = await h.launch({ run_in_background: false });
    assert.equal(result.details.status, "succeeded"); assert.match(result.content[0].text, /Historical child evidence/);
    assert.equal(h.engine.service.getGoal("parent")!.goalId, goal.goalId);
    assert.equal(h.engine.service.getGoal("parent")!.status, "active");
    const context = await h.emit("context", { messages: [] });
    assert.match(JSON.stringify(context), /complete|objective|completion/);
    h.engine.service.requestTerminalUpdate("parent", "paused", "user");
    await assert.rejects(h.tool("update_goal", { status: "complete" }), /superseded|newer/);
    assert.equal(h.engine.service.getGoal("parent")!.status, "paused");
  },
  "ACC-SA-08-06": async ({ t, text }) => {
    const h = await configurationHarness(t); await h.start(); const original = await h.goal();
    const activeTools = h.pi.getActiveTools; h.pi.getActiveTools = () => [...activeTools(), "write"];
    const sideEffect = join(h.root, "obsolete-write.txt");
    const gate = deferred<void>(); h.replies.push({ gate, tool: { name: "write", arguments: { path: sideEffect, content: "Forbidden" } } });
    const launch = await h.launch(); await eventually(() => h.calls.length === 1, "Old provider request starts before newer intent");
    if (text.includes("paused the goal")) h.engine.service.requestTerminalUpdate("parent", "paused", "user");
    else if (text.includes("changed the goal objective")) h.engine.service.setGoal("parent", { objective: "Newer objective" }, "user");
    else {
      h.engine.service.clearGoal("parent", "user");
      if (text.includes("replaced the goal")) h.engine.service.createGoal("parent", "Replacement objective", 1000, "user");
    }
    const newer = h.engine.service.getGoal("parent");
    const start = h.sent.length; gate.resolve(); const result = await h.finish(launch.details.runId);
    assert.match(result.content[0].text, /Historical child evidence/);
    assert.equal(result.details.status, "partial"); assert.match(result.details.error, /superseded|budget/); assert.equal(h.calls.length, 1);
    await assert.rejects(access(sideEffect), { code: "ENOENT" });
    const current = h.engine.service.getGoal("parent");
    assert.equal(current?.goalId, newer?.goalId); assert.equal(current?.objective, newer?.objective); assert.equal(current?.status, newer?.status);
    const completion = h.sent.slice(start).find(s => s.message.customType === "secretary:agent-completion");
    assert.ok(completion, "Historical result is delivered");
    assert.deepEqual(completion.delivery, { deliverAs: "nextTurn" });
    assert.equal(h.sent.slice(start).filter(s => s.delivery?.triggerTurn).length, 0);
    assert.equal(h.usage()[0]!.goal!.goalId, original.goalId);
    await assert.rejects(h.tool("SendMessage", { to: launch.details.agentId, message: "Follow obsolete instruction" }), /superseded|paused|replaced|authorize/);
  },
  "ACC-SA-08-07": async ({ t }) => {
    const h = await configurationHarness(t); await h.start(); await h.goal();
    const gate = deferred<void>(); h.replies.push({ gate }); const launch = await h.launch();
    await eventually(() => h.calls.length === 1, "Outstanding child is running");
    h.sync.settled(); h.setIdle(true); h.sync.requestAutomatic(); await tick();
    const automatic = h.sent.filter(s => s.message.customType === AUTOMATIC_TYPE);
    assert.equal(automatic.length, 1, "Parent receives one continuation for outstanding work");
    h.setIdle(false); await h.emit("turn_start");
    await h.emit("context", { messages: [{ role: "custom", timestamp: Date.now(), ...automatic[0]!.message }] });
    h.setIdle(true); await h.emit("agent_settled"); await tick();
    for (let i = 0; i < 4; i++) { await h.emit("agent_settled"); await tick(); }
    assert.equal(h.sent.filter(s => s.message.customType === AUTOMATIC_TYPE).length, 1);
    assert.equal(h.repository.runs("parent").length, 1);
    h.setIdle(false); await h.begin("Please answer this unrelated explicit question.");
    assert.notEqual((await h.emit("tool_call", { toolName: "read", input: { path: "README.md" } }))?.block, true);
    gate.resolve(); await h.finish(launch.details.runId);
  },
  "ACC-SA-08-08": async ({ t }) => {
    const h = await configurationHarness(t);
    const previousTools = h.pi.getActiveTools; h.pi.getActiveTools = () => [...previousTools(), "write"];
    await h.start(); await h.goal(80);
    const committed = join(h.root, "committed.txt"), forbidden = join(h.root, "after-budget.txt");
    h.replies.push(
      { input: 0, cached: 0, output: 40, text: "First action", tool: { name: "write", arguments: { path: committed, content: "Already completed side effect" } } },
      { input: 0, cached: 0, output: 40, text: "Partial result retained", tool: { name: "write", arguments: { path: forbidden, content: "Must not execute" } } },
    );
    const result = await h.launch({ run_in_background: false });
    assert.equal(h.engine.service.getGoal("parent")!.status, "budget_limited");
    assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, 80, "goal-budget token usage = max(inputTokens - cachedInputTokens, 0) + max(outputTokens, 0)");
    assert.equal(result.details.status, "partial"); assert.match(result.content[0].text, /Partial result retained/);
    assert.equal(h.calls.length, 2); assert.match(result.details.error, /superseded|budget/);
    assert.equal(await readFile(committed, "utf8"), "Already completed side effect");
    await assert.rejects(access(forbidden), { code: "ENOENT" });
    h.sync.settled(); h.setIdle(true); h.sync.requestAutomatic(); await tick();
    const summary = h.sent.find(s => s.message.details?.kind === "budget_wrap_up"); assert.ok(summary);
    h.setIdle(false); await h.emit("turn_start");
    const context = await h.emit("context", { messages: [{ role: "custom", timestamp: Date.now(), ...summary.message }] });
    assert.match(JSON.stringify(context), /summary|summari|budget/i);
    assert.equal((await h.emit("tool_call", { toolName: "write", input: { path: forbidden, content: "summary may not write" } })).block, true);
    assert.notEqual((await h.emit("tool_call", { toolName: "get_goal", input: {} }))?.block, true);
    assert.doesNotMatch(result.content[0].text, /(?:changes|effects|files) (?:were |are )?rolled back/i);
  },
  "ACC-SA-08-09": async ({ t }) => {
    const h = await configurationHarness(t); await h.start(); await h.begin("Please delegate this task without creating a goal.");
    assert.equal(h.engine.service.getGoal("parent"), null);
    const result = await h.launch({ run_in_background: false });
    assert.equal(result.details.status, "succeeded"); assert.equal(result.details.goal, undefined);
    assert.equal(h.engine.service.getGoal("parent"), null);
    const event = h.usage()[0]!; assert.equal(event.goal, undefined); assert.equal(goalTokenDeltaForUsage(event.usage), 80);
    assert.equal(h.engine.db.connection.prepare("SELECT COUNT(*) AS n FROM secretary_agent_goal_usage").get()!.n, 0);
  },
};

runFeatures(["agent-configuration", "goal-integration"], bindings, {
  "agent-configuration": "33e453d41e8473ed153b54e858230e530f0029108c12b248401add7af145c3ce",
  "goal-integration": "2a1badb878287c3d944eb8919e710c267461692dc210df7165d9f3e6273b84b3",
});
