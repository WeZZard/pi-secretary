import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { discoverAgents } from "../../extensions/secretary/agents/registry.ts";
import { loadAgentConfiguration } from "../../extensions/secretary/agents/configuration.ts";
import { GoalService } from "../../extensions/secretary/goal/goal-service.ts";
import { goalTokenDeltaForUsage } from "../../extensions/secretary/goal/accounting.ts";
import { AgentAssociationStore } from "../../extensions/secretary/composition/association-store.ts";
import { AUTOMATIC_TYPE } from "../../extensions/secretary/goal/synchronization.ts";
import { configurationHarness, eventually } from "./configuration-harness.ts";
import { runFeatures, deferred, tick, type ScenarioBindings } from "./support.ts";

async function automaticLaunch(h: Awaited<ReturnType<typeof configurationHarness>>, args: Record<string, unknown> = {}) {
  h.sync.settled(); h.setIdle(true); h.sync.requestAutomatic(); await tick();
  const automatic = h.sent.filter(s => s.message.customType === AUTOMATIC_TYPE).at(-1);
  assert.ok(automatic, "The fixture dispatches a real automatic continuation");
  h.setIdle(false); await h.emit("agent_end", { messages: [] }); await h.emit("turn_start");
  const message = { role: "custom", timestamp: Date.now(), ...automatic.message };
  await h.emit("message_start", { message });
  await h.emit("context", { messages: [message] });
  const id = `automatic-launch-${h.sent.length}`, resumeId = `${id}-resume`;
  const input = { description: "Automatic goal task", prompt: "Inspect the fixture", ...args };
  await h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: [
    { type: "toolCall", id, name: "Agent", arguments: input },
    { type: "toolCall", id: resumeId, name: "SendMessage", arguments: {} },
  ] } });
  const result = await h.tools.get("Agent").execute(id, input, undefined, undefined, h.ctx);
  const association = new AgentAssociationStore(h.engine.db.connection).run(result.details.runId);
  assert.equal(association?.authority, "automatic");
  return { result, staleResume: () => h.tools.get("SendMessage").execute(resumeId,
    { to: result.details.agentId, message: "Follow obsolete automatic instruction" }, undefined, undefined, h.ctx) };
}

const bindings: ScenarioBindings = {
  "ACC-SA-07-01": async ({ t }) => {
    const h = await configurationHarness(t);
    await h.put(join(h.userDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: {
      primary: ["test-provider/reviewer-model", "test-provider/different-model"],
      secondary: ["test-provider/parent-model"],
    } } }));
    await h.start();
    const schema = h.tools.get("Agent").parameters;
    assert.equal(schema.properties.model.enum, undefined);
    assert.equal(schema.properties.model.type, "string");
    assert.ok(!schema.required.includes("model"));
    const view = await h.emit("context", { messages: [] });
    const envelope = view.messages.find((m: any) => m.customType === "secretary:request-context").content;
    const payload = JSON.parse(envelope.slice("<secretary-runtime-state>".length, -"</secretary-runtime-state>".length));
    assert.deepEqual(payload.contributions.find((c: any) => c.id === "secretary.agent-catalog").data.modelFallbackLists, ["primary", "secondary"]);
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
    h.pi.getActiveTools = () => ["write", "get_goal", "create_goal", "update_goal"];
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
  "ACC-SA-07-10": async ({ t }) => {
    const h = await configurationHarness(t);
    await h.definition("reviewer");
    // A provider that declares API-key auth but has no configured credentials.
    const lockedModel = { ...h.models[1]!, provider: "locked-provider", id: "reviewer-model", name: "reviewer-model" } as typeof h.models[number];
    h.ctx.modelRegistry.registerProvider("locked-provider", {
      api: "openai-completions", baseUrl: "http://127.0.0.1:1/never", models: [lockedModel],
      streamSimple() { throw new Error("locked-provider must never receive a request"); },
    });
    await h.put(join(h.userDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { primary: ["locked-provider/reviewer-model", "test-provider/different-model"] } } }));
    await h.start();
    const result = await h.launch({ subagent_type: "reviewer", model: "primary" });
    const finished = await h.finish(result.details.runId);
    assert.equal(finished.details.status, "succeeded");
    assert.deepEqual(h.calls.map(call => call.model), ["test-provider/different-model"], "No provider request is made for the credential-less candidate");
    assert.match(result.content[0].text, /Fallback: skipped locked-provider\/reviewer-model \(authentication unavailable/);
  },
  "ACC-SA-07-11": async ({ t }) => {
    const h = await configurationHarness(t);
    await h.definition("reviewer");
    await h.put(join(h.userDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { primary: ["test-provider/reviewer-model", "test-provider/different-model"] } } }));
    await h.start();
    h.replies.push({ error: 'OpenAI API error (401): {"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}' }, { text: "Recovered evidence." });
    const result = await h.launch({ subagent_type: "reviewer", model: "primary" });
    const finished = await h.finish(result.details.runId);
    assert.equal(finished.details.status, "succeeded");
    assert.deepEqual(h.calls.map(call => call.model), ["test-provider/reviewer-model", "test-provider/different-model"]);
    assert.equal(h.repository.getAgent(result.details.agentId)!.model, "test-provider/different-model");
    assert.match(h.inspector(result.details.agentId), /test-provider\/different-model/);
  },
  "ACC-SA-07-12": async ({ t }) => {
    const h = await configurationHarness(t);
    await h.definition("reviewer");
    // test-provider/ghost-model is not registered, so the second candidate's setup fails.
    await h.put(join(h.userDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { primary: ["test-provider/reviewer-model", "test-provider/ghost-model"] } } }));
    await h.start();
    h.replies.push({ error: "429 usage_limit_reached" });
    const result = await h.launch({ subagent_type: "reviewer", model: "primary" });
    const finished = await h.finish(result.details.runId);
    assert.equal(finished.details.status, "failed");
    assert.match(finished.details.error!, /test-provider\/reviewer-model[\s\S]*429 usage_limit_reached/, "The first candidate's availability failure stays in the report");
    assert.match(finished.details.error!, /test-provider\/ghost-model/, "The candidate whose setup aborted the chain is identified");
    assert.equal(h.calls.length, 1);
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
    assert.equal(new AgentAssociationStore(h.engine.db.connection).run(event.runId)?.goal?.goalId, goal.goalId);
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
    const events = h.usage(); assert.equal(events.length, 1); assert.equal(new AgentAssociationStore(h.engine.db.connection).run(events[0]!.runId)?.goal?.goalId, goal.goalId);
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
    const { result: launch, staleResume } = await automaticLaunch(h); await eventually(() => h.calls.length === 1, "Automatic work starts before pause");
    h.engine.service.requestTerminalUpdate("parent", "paused", "user"); gate.resolve();
    await h.begin("Inspect the stopped automatic execution without resuming its goal.");
    const outcome = await h.finish(launch.details.runId);
    assert.equal(h.engine.service.getGoal("parent")!.goalId, goal.goalId);
    assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, goalTokenDeltaForUsage(h.usage()[0]!.usage));
    assert.equal(h.engine.service.getGoal("parent")!.status, "paused");
    assert.equal(outcome.details.status, "cancelled"); assert.equal(h.calls.length, 1);
    await assert.rejects(access(sideEffect), { code: "ENOENT" });
    await assert.rejects(staleResume(), /superseded|expired/);
    await h.begin("Resume the child to investigate recovery without resuming the goal.");
    const resumed = await h.tool("SendMessage", { to: launch.details.agentId, message: "Investigate recovery" });
    assert.equal((await h.finish(resumed.details.runId)).details.status, "succeeded");
    assert.equal(h.engine.service.getGoal("parent")!.status, "paused");
    assert.equal(new AgentAssociationStore(h.engine.db.connection).run(resumed.details.runId)?.goal, undefined);
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
    await assert.rejects(h.tools.get("update_goal").execute("stale-complete", { status: "complete" }, undefined, undefined, h.ctx), /superseded|newer/);
    assert.equal(h.engine.service.getGoal("parent")!.status, "paused");
  },
  "ACC-SA-08-06": async ({ t, text }) => {
    const h = await configurationHarness(t); await h.start(); const original = await h.goal();
    const activeTools = h.pi.getActiveTools; h.pi.getActiveTools = () => [...activeTools(), "write"];
    const sideEffect = join(h.root, "obsolete-write.txt");
    const gate = deferred<void>(); h.replies.push({ gate, tool: { name: "write", arguments: { path: sideEffect, content: "Forbidden" } } });
    const { result: launch, staleResume } = await automaticLaunch(h); await eventually(() => h.calls.length === 1, "Old automatic provider request starts before newer intent");
    if (text.includes("paused the goal")) h.engine.service.requestTerminalUpdate("parent", "paused", "user");
    else if (text.includes("changed the goal objective")) h.engine.service.setGoal("parent", { objective: "Newer objective" }, "user");
    else {
      h.engine.service.clearGoal("parent", "user");
      if (text.includes("replaced the goal")) h.engine.service.createGoal("parent", "Replacement objective", 1000, "user");
    }
    const newer = h.engine.service.getGoal("parent");
    const start = h.sent.length; gate.resolve();
    await h.begin("Inspect the old execution without following its obsolete instructions.");
    const result = await h.finish(launch.details.runId);
    assert.match(result.content[0].text, /Historical child evidence/);
    assert.equal(result.details.status, "cancelled"); assert.equal(h.calls.length, 1);
    await assert.rejects(access(sideEffect), { code: "ENOENT" });
    const current = h.engine.service.getGoal("parent");
    assert.equal(current?.goalId, newer?.goalId); assert.equal(current?.objective, newer?.objective); assert.equal(current?.status, newer?.status);
    const completion = h.sent.slice(start).find(s => s.message.customType === "secretary:agent-completion");
    assert.ok(completion, "Historical result is delivered");
    assert.deepEqual(completion.delivery, { deliverAs: "nextTurn" });
    assert.equal(h.sent.slice(start).filter(s => s.delivery?.triggerTurn).length, 0);
    assert.equal(new AgentAssociationStore(h.engine.db.connection).run(h.usage()[0]!.runId)?.goal?.goalId, original.goalId);
    await assert.rejects(staleResume(), /superseded|expired/);
    await h.begin("Please give the finished child a new recovery assignment.");
    const resumed = await h.tool("SendMessage", { to: launch.details.agentId, message: "Investigate recovery beyond the old objective" });
    assert.equal((await h.finish(resumed.details.runId)).details.status, "succeeded");
    assert.equal(new AgentAssociationStore(h.engine.db.connection).run(resumed.details.runId)?.authority, "user");
    assert.equal(h.engine.service.getGoal("parent")?.status, newer?.status);
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
    const { result: launched } = await automaticLaunch(h, { run_in_background: true });
    await h.begin("Inspect the captured execution without extending its budget.");
    const result = await h.finish(launched.details.runId);
    assert.equal(h.engine.service.getGoal("parent")!.status, "budget_limited");
    assert.equal(h.engine.service.getGoal("parent")!.tokensUsed, 80, "goal-budget token usage = max(inputTokens - cachedInputTokens, 0) + max(outputTokens, 0)");
    assert.equal(result.details.status, "cancelled"); assert.match(result.content[0].text, /Partial result retained/);
    assert.equal(h.calls.length, 2);
    assert.equal(await readFile(committed, "utf8"), "Already completed side effect");
    await assert.rejects(access(forbidden), { code: "ENOENT" });
    h.sync.settled(); h.setIdle(true); h.sync.requestAutomatic(); await tick();
    const summary = h.sent.find(s => s.message.details?.kind === "budget_wrap_up"); assert.ok(summary);
    h.setIdle(false); await h.emit("agent_end", { messages: [] }); await h.emit("turn_start");
    const summaryMessage = { role: "custom", timestamp: Date.now(), ...summary.message };
    await h.emit("message_start", { message: summaryMessage });
    const context = await h.emit("context", { messages: [summaryMessage] });
    assert.match(JSON.stringify(context), /summary|summari|budget/i);
    const input = { path: forbidden, content: "summary may not write" };
    await h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", usage: { input: 0, output: 0 }, content: [{ type: "toolCall", id: "wrap-write", name: "write", arguments: input }] } });
    assert.equal((await h.emit("tool_call", { toolCallId: "wrap-write", toolName: "write", input })).block, true);
    assert.notEqual((await h.emit("tool_call", { toolName: "get_goal", input: {} }))?.block, true);
    assert.doesNotMatch(result.content[0].text, /(?:changes|effects|files) (?:were |are )?rolled back/i);
  },
  "ACC-SA-08-09": async ({ t }) => {
    const h = await configurationHarness(t); await h.start(); await h.begin("Please delegate this task without creating a goal.");
    assert.equal(h.engine.service.getGoal("parent"), null);
    const result = await h.launch({ run_in_background: false });
    assert.equal(result.details.status, "succeeded");
    assert.equal(new AgentAssociationStore(h.engine.db.connection).run(result.details.runId)?.goal, undefined);
    assert.equal(Object.hasOwn(result.details, "goal"), false);
    assert.equal(h.engine.service.getGoal("parent"), null);
    const event = h.usage()[0]!;
    assert.equal(new AgentAssociationStore(h.engine.db.connection).run(event.runId)?.goal, undefined);
    assert.equal(Object.hasOwn(event, "goal"), false); assert.equal(goalTokenDeltaForUsage(event.usage), 80);
    assert.equal(h.engine.db.connection.prepare("SELECT COUNT(*) AS n FROM secretary_agent_goal_usage").get()!.n, 0);
  },
};

runFeatures(["agent-configuration", "goal-integration"], bindings, {
  "agent-configuration": "aef0656d9235d35d9a7e44324c851007f5daa843c711e113d277131aacb306eb",
  "goal-integration": "e1cc4916ae65639b28a5caa77799c80be3e46b8371859501c0bfc551f63b2370",
});
