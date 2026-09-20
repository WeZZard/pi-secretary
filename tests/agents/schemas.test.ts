import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { agentSchema, createAgentSchema, sendMessageSchema, taskStopSchema, taskOutputSchema } from "../../extensions/secretary/agents/tools/schemas.ts";

test("Agent contract is strict without resume or turn-limit inputs", () => {
  const valid = { prompt: "Do work", description: "Task" };
  assert.equal(Value.Check(agentSchema, valid), true);
  for (const model of ["fast", "provider/model", "inherit"]) assert.equal(Value.Check(agentSchema, { ...valid, model }), true);
  for (const extra of [{ resume: "id" }, { max_turns: 2 }, { model: 42 }, { unknown: true }, { name: "../bad" }, { name: "a".repeat(65) }]) assert.equal(Value.Check(agentSchema, { ...valid, ...extra }), false);
  assert.equal(Value.Check(agentSchema, { prompt: "Do work" }), false);
  assert.equal(Value.Check(agentSchema, { ...valid, isolation: "worktree", team_name: "unused", mode: "plan" }), true);
  assert.equal(Value.Check(agentSchema, { ...valid, isolation: "remote" }), false);
  assert.equal((agentSchema.required as readonly string[]).includes("isolation"), false);
  assert.equal(Value.Check(agentSchema, { ...valid, name: "a-1_A" }), true);
  assert.equal(Object.hasOwn(agentSchema.properties.model, "default"), false);
  assert.equal(Object.hasOwn(agentSchema.properties.run_in_background, "default"), false);
});

test("Agent exposes a free-form model field when no fallback lists are configured", () => {
  const schema = createAgentSchema({});
  assert.equal(Object.hasOwn(schema.properties, "model"), true);
  assert.equal(Object.hasOwn(schema.properties.model, "enum"), false);
  assert.equal(Value.Check(schema, { prompt: "Do work", description: "Task", model: "provider/anything" }), true);
  assert.equal(Object.hasOwn(agentSchema.properties, "model"), true, "The baseline schema is not mutated");
});

test("Agent schemas stay stable while runtime context publishes fallback list names", () => {
  const schema = createAgentSchema({ fast: ["test/configured-model"] });
  assert.deepEqual(schema, createAgentSchema({ renamed: ["test/different"] }));
  assert.equal(Reflect.get(schema.properties.model, "enum"), undefined);
  assert.match(Reflect.get(schema.properties.model, "description"), /secretary\.agent-catalog/);
  assert.match(Reflect.get(schema.properties.subagent_type, "description"), /general-purpose/);
  assert.equal(Value.Check(schema, { prompt: "Do work", description: "Task", model: "fast" }), true);
  assert.equal(Value.Check(schema, { prompt: "Do work", description: "Task", model: "other" }), true, "Unknown strings are rejected at runtime, not through a stale enum");
});

test("SendMessage enforces string-only profile and display bounds", () => {
  assert.equal(Value.Check(sendMessageSchema, { to: "worker", message: "Continue" }), true);
  for (const input of [{ to: "x\ny", message: "Continue" }, { to: "x".repeat(301), message: "Continue" }, { to: "x", message: {} }, { to: "x", message: "Go", summary: "s".repeat(201) }, { to: "x", message: "Go", notify_when_idle: true }]) assert.equal(Value.Check(sendMessageSchema, input), false);
});

test("TaskStop supports deprecated spelling; target requirement stays runtime", () => {
  assert.equal(Value.Check(taskStopSchema, {}), true);
  assert.equal(Value.Check(taskStopSchema, { shell_id: "owned-run" }), true);
  assert.equal(Value.Check(taskStopSchema, { task_id: "owned-run", shell_id: "old" }), true);
  assert.equal(Value.Check(taskStopSchema, { other: "run" }), false);
});

test("TaskOutput has optional defaults and numeric timeout bounds", () => {
  assert.equal(Value.Check(taskOutputSchema, { task_id: "run" }), true);
  for (const timeout of [0, 0.5, 600000]) assert.equal(Value.Check(taskOutputSchema, { task_id: "run", timeout }), true);
  for (const timeout of [-1, 600001, "30000"]) assert.equal(Value.Check(taskOutputSchema, { task_id: "run", timeout }), false);
  assert.equal(Value.Check(taskOutputSchema, { task_id: "run", extra: true }), false);
  assert.equal(Reflect.get(taskOutputSchema.properties.block, "default"), true);
  assert.equal(Reflect.get(taskOutputSchema.properties.timeout, "default"), 30000);
});
