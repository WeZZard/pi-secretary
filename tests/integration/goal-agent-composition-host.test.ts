import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { goalAgentCompositionSession } from "../support/goal-agent-composition-session.ts";

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args });

test("composition fixture supports real background launch, saved-child resumption, and observed completion in persistent RPC mode", { timeout: 30000 }, async t => {
  const h = await goalAgentCompositionSession(t, {
    setup: async (_root, dir) => {
      await mkdir(join(dir, "agents"));
      await writeFile(join(dir, "agents", "composition-worker.md"), "---\nname: composition-worker\ndescription: Isolated composition worker\ntools: [read]\n---\nReturn the requested fixture result.\n");
    },
    respond: async context => {
      const seen = context.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
      const has = (id: string) => seen.some(m => m.toolCallId === id);
      if (!has("launch")) return [call("launch", "Agent", { description: "Control launch", prompt: "CONTROL_INITIAL", name: "control-worker", subagent_type: "composition-worker", run_in_background: true })];
      if (!has("observe-launch")) return [call("observe-launch", "TaskOutput", { task_id: "control-worker", block: true, timeout: 10000 })];
      if (!has("resume")) return [call("resume", "SendMessage", { to: "control-worker", message: "CONTROL_RESUMED" })];
      if (!has("observe-resume")) return [call("observe-resume", "TaskOutput", { task_id: "control-worker", block: true, timeout: 10000 })];
      return [{ type: "text", text: "Both control outcomes observed." }];
    },
    respondChild: async context => [{ type: "text", text: JSON.stringify(context.messages).includes("CONTROL_RESUMED") ? "CONTROL_RESUMED_DONE" : "CONTROL_INITIAL_DONE" }],
  });
  let failure: unknown;
  try {
    await h.session.prompt("Exercise background launch and resume without a goal.", { source: "rpc" });
    await h.session.waitForIdle();
    const results = h.session.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
    assert.deepEqual(results.map(m => ({ id: m.toolCallId, error: m.isError })), [
      { id: "launch", error: false }, { id: "observe-launch", error: false },
      { id: "resume", error: false }, { id: "observe-resume", error: false },
    ], JSON.stringify(results));
    for (const id of ["observe-launch", "observe-resume"]) assert.equal(results.find(m => m.toolCallId === id)?.details.status, "succeeded");
    const runs = h.repository.runs(h.threadId);
    assert.equal(runs.length, 2);
    assert.ok(runs.every(run => run.background && run.status === "succeeded"));
    assert.equal(runs[0].agentId, runs[1].agentId);
    assert.notEqual(runs[0].runId, runs[1].runId);
    assert.equal(h.childCalls.length, 2);
    assert.match(JSON.stringify(h.childCalls[1].messages), /CONTROL_INITIAL_DONE/);
    assert.match(runs[1].output, /CONTROL_RESUMED_DONE/);
    assert.equal(h.engine.service.getGoal(h.goalThreadId), null);
  } catch (error) { failure = error; throw error; }
  finally { await h.retain({ failure: failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure }); }
});
