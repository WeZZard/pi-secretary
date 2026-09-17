import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import secretaryExtension from "../../extensions/secretary/index.ts";
import { runInChildSession } from "../../extensions/secretary/agents/child-context.ts";
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

test("session activation registers canonical schemas once, without background or model defaults", async (t) => {
  const h = await agentHarness(t);
  for (const name of names) assert.equal(h.tools.has(name), false);
  await h.start();
  for (const name of names) assert.equal(h.tools.get(name).parameters.type, "object");
  const agent = h.tools.get("Agent");
  assert.deepEqual(agent.parameters.required, ["description", "prompt"]);
  assert.equal(Object.hasOwn(agent.parameters.properties, "model"), false);
  assert.equal(Object.hasOwn(agent.parameters.properties.run_in_background, "default"), false);
  assert.equal(agent.prepareArguments({ ...task, mode: "manual" }).mode, "default");
  await h.start();
  assert.equal(h.tools.get("Agent"), agent);
  assert.equal(h.calls.length, 0);
});

test("project custom agent uses its configured pi model without exposing Claude aliases", async (t) => {
  const h = await agentHarness(t);
  const directory = join(h.root, ".pi", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "project-worker.md"), "---\nname: project-worker\ndescription: Project task\nmodel: installer-test/fixture\ntools: [read]\n---\n");
  await h.start();
  assert.equal(Object.hasOwn(h.tools.get("Agent").parameters.properties, "model"), false);
  const outcome = await h.tool("Agent", { ...task, subagent_type: "project-worker", run_in_background: false });
  assert.equal(outcome.details.status, "succeeded");
  assert.match(outcome.content[0].text, /Model: installer-test\/fixture/);
  assert.equal(h.calls.length, 1);
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

test("default extension registers no root goals or agents inside child async context", async () => {
  const forbidden = new Proxy({}, { get(_target, name) { throw new Error(`Unexpected child root API access: ${String(name)}`); } });
  await runInChildSession(async () => { await Promise.resolve(); secretaryExtension(forbidden as any); });
});
