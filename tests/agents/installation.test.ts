import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runInChildSession } from "../../extensions/secretary/agents/child-context.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { agentHarness } from "../support/agent-harness.ts";

const names = ["Agent", "SendMessage", "TaskStop", "TaskOutput"];
const task = { description: "Inspect fixture", prompt: "Return a fixture result" };

test("root installer delays delegation schemas until session_start and preserves goal tools on collision", async (t) => {
  const h = await agentHarness(t, { collision: "SendMessage" });
  assert.equal(h.tools.has("Agent"), false);
  assert.equal(h.tools.has("get_goal"), true);
  await h.start();
  assert.equal(h.tools.get("SendMessage").foreign, true);
  assert.equal(h.tools.has("Agent"), false);
  assert.match(h.notices.join("\n"), /another extension provides/);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.tool("get_goal", {})).details.goal, null);
});

test("session activation registers canonical schemas once, without background defaults and with a free-form model field", async (t) => {
  const h = await agentHarness(t);
  for (const name of names) assert.equal(h.tools.has(name), false);
  await h.start();
  for (const name of names) assert.equal(h.tools.get(name).parameters.type, "object");
  const agent = h.tools.get("Agent");
  assert.deepEqual(agent.parameters.required, ["description", "prompt"]);
  assert.equal(agent.parameters.properties.model.type, "string");
  assert.equal(agent.parameters.properties.model.enum, undefined, "No fallback lists are configured, so no enum is advertised");
  assert.equal(Object.hasOwn(agent.parameters.properties.run_in_background, "default"), false);
  assert.equal(agent.prepareArguments({ ...task, mode: "manual" }).mode, "default");
  await h.start();
  assert.equal(h.tools.get("Agent"), agent);
  assert.equal(h.calls.length, 0);
});

test("project custom agent uses its configured pi model without advertising fallback lists", async (t) => {
  const h = await agentHarness(t);
  const directory = join(h.root, ".pi", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "project-worker.md"), "---\nname: project-worker\ndescription: Project task\nmodel: installer-test/fixture\ntools: [read]\n---\n");
  await h.start();
  assert.equal(h.tools.get("Agent").parameters.properties.model.enum, undefined);
  const outcome = await h.tool("Agent", { ...task, subagent_type: "project-worker", run_in_background: false });
  assert.equal(outcome.details.status, "succeeded");
  assert.match(outcome.content[0].text, /Model: installer-test\/fixture/);
  assert.equal(h.calls.length, 1);
});

test("/secretary in headless mode returns the configuration summary and opens no terminal component", async (t) => {
  const h = await agentHarness(t);
  await writeFile(join(h.root, "agent", "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { primary: ["installer-test/fixture"] } } }));
  await h.start();
  await h.command("secretary", "");
  const message = h.sent.find((s: any) => s.message.customType === "secretary-config");
  assert.ok(message, "The command responds with a text message");
  assert.match(message.message.content, /secretary\.json/);
  assert.match(message.message.content, /primary: installer-test\/fixture/);
  assert.deepEqual(message.delivery, { triggerTurn: false });
});

test("headless background and unsupported launches reject before provider execution", async (t) => {
  const h = await agentHarness(t);
  await h.start();
  for (const mode of ["print", "json"]) {
    h.ctx.mode = mode;
    await assert.rejects(h.tool("Agent", { ...task, run_in_background: true }), /persistent TUI\/RPC/);
  }
  await assert.rejects(h.tool("Agent", { ...task, isolation: "remote" }), /Remote execution/);
  await assert.rejects(h.tool("Agent", { ...task, subagent_type: "fork" }), /Unknown or unsupported/);
  await assert.rejects(h.tool("Agent", { ...task, name: "main" }), /reserved agent name/);
  assert.equal(h.calls.length, 0);
  const context = await h.emit("context", { messages: [] });
  assert.doesNotMatch(JSON.stringify(context), /run_[a-f0-9]/);
});

test("foreground public tools run a real SDK child, retain output, deduplicate launch and enforce names", async (t) => {
  const h = await agentHarness(t);
  await h.start();
  const result = await h.tool("Agent", { ...task, name: "reader" }, "stable-launch");
  assert.equal(result.details.status, "succeeded");
  assert.equal(result.details.background, false);
  assert.equal(result.details.output, "Verified fixture child output.");
  assert.equal(await readFile(result.details.outputPath, "utf8"), result.details.output);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]!.tools?.map(tool => tool.name), ["read"]);
  assert.equal(h.engine.service.getGoal("parent"), null);
  assert.equal(h.sent.length, 0, "foreground completion must not request a parent turn");
  assert.equal((await h.tool("Agent", { ...task, name: "reader" }, "stable-launch")).details.runId, result.details.runId);
  assert.equal(h.calls.length, 1);
  assert.equal((await h.tool("TaskOutput", { task_id: "reader", block: false })).details.runId, result.details.runId);
  assert.equal((await h.tool("TaskStop", { shell_id: result.details.runId })).details.status, "succeeded");
  await assert.rejects(h.tool("SendMessage", { to: "reader", message: "Resume" }), /persistent TUI or RPC/);
  await assert.rejects(h.tool("Agent", { ...task, name: "reader" }), /already exists/);
  await assert.rejects(h.tool("TaskStop", { task_id: "unrelated-shell" }), /not found in this parent/);
});

test("child sessions at the maximum nesting depth register no delegation tools", async (t) => {
  await runInChildSession({ agentId: "agent_deepest", depth: 3 }, async () => {
    const h = await agentHarness(t);
    await h.start();
    for (const name of names) assert.equal(h.tools.has(name), false, `${name} is not registered at the maximum depth`);
    assert.equal(h.tools.has("get_goal"), true, "goal support still installs; the session allowlist gates it out");
  });
});

test("child sessions below the maximum depth delegate with recorded parentage", async (t) => {
  await runInChildSession({ agentId: "agent_parent", depth: 1 }, async () => {
    const h = await agentHarness(t);
    await h.start();
    for (const name of names) assert.equal(h.tools.has(name), true, `${name} is available to a nested session`);
    const outcome = await h.tool("Agent", { ...task, run_in_background: false });
    assert.equal(outcome.details.status, "succeeded");
    const record = new AgentRepository(h.engine.db.connection).getAgent(outcome.details.agentId);
    assert.equal(record?.parentAgentId, "agent_parent", "the nested launch records the delegating agent");
    assert.equal(record?.depth, 2, "the nested launch records its depth below the main session");
    assert.ok(record?.tools.includes("Agent"), "a child below the maximum depth keeps the delegation contract for its own children");
    assert.ok(!record?.tools.includes("create_goal"), "goal tools stay out of delegated sessions");
  });
});

test("a child at depth two issues no delegation tools to its own children", async (t) => {
  await runInChildSession({ agentId: "agent_middle", depth: 2 }, async () => {
    const h = await agentHarness(t);
    await h.start();
    const outcome = await h.tool("Agent", { ...task, run_in_background: false });
    assert.equal(outcome.details.status, "succeeded");
    const record = new AgentRepository(h.engine.db.connection).getAgent(outcome.details.agentId);
    assert.equal(record?.depth, 3);
    assert.equal(record?.tools.includes("Agent"), false, "a child at the maximum depth cannot delegate further");
  });
});
