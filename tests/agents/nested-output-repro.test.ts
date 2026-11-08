import { test } from "node:test";
import assert from "node:assert/strict";
import { standaloneAgentHarness } from "../support/standalone-agent-harness.ts";
import { nestedRealTree, settle } from "../support/nested-real-tree.ts";

/**
 * Failing reproducers for the nested-subagent output-collection checkpoint, aligned with the
 * documented Claude Code behavior: a nested agent's output is collected by the session that
 * launched it, and a nested outcome that outlives its launcher is surfaced in the main
 * conversation rather than lost with the dead owning session.
 */

test("checkpoint 4 guard: the main session collects a nested agent's output through TaskOutput", { timeout: 30000 }, async t => {
  const h = await standaloneAgentHarness(t, { respondChild: async context => {
    if ((context.systemPrompt ?? "").includes("STANDALONE_DELEGATOR")) {
      const launched = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "nested-output-launch");
      if (!launched) return [{ type: "toolCall", id: "nested-output-launch", name: "Agent", arguments: {
        description: "Nested output work", prompt: "NESTED_OUTPUT_TASK", subagent_type: "worker", name: "nested-output", run_in_background: false } }];
      assert.ok(launched.role === "toolResult" && !launched.isError, JSON.stringify(launched));
      return [{ type: "text", text: "DELEGATOR_DONE" }];
    }
    return [{ type: "text", text: "NESTED_OUTPUT_DONE" }];
  } });
  const parent = await h.tool("Agent", { description: "Nested output work", prompt: "Delegate nested output.",
    subagent_type: "delegator", name: "output-delegator", run_in_background: false });
  assert.equal(parent.details.status, "succeeded");
  const nested = h.repository.childrenOf(parent.details.agentId)[0]!;
  const nestedRun = h.repository.runs(nested.parentId).filter(run => run.agentId === nested.agentId).at(-1)!;
  const byRun = await h.tool("TaskOutput", { task_id: nestedRun.runId, block: true, timeout: 10000 });
  assert.equal(byRun.details.status, "succeeded");
  assert.match(byRun.details.output, /NESTED_OUTPUT_DONE/);
  const byAgent = await h.tool("TaskOutput", { task_id: nested.agentId, block: true, timeout: 10000 });
  assert.match(byAgent.details.output, /NESTED_OUTPUT_DONE/, "TaskOutput must resolve a nested agent by agent id");
  assert.ok(h.repository.completions(nested.parentId).some(completion => completion.runId === nestedRun.runId),
    "the launching session records the nested completion");
});

test("checkpoint 4 repro: a nested run's terminal outcome is surfaced to the main session after its owner ends", async t => {
  const tree = await nestedRealTree(t);
  const nestedRunId = tree.b.run!.runId;
  tree.finish(nestedRunId, "NESTED_LATE_OUTPUT");
  await settle();
  assert.equal(tree.service.run(nestedRunId).status, "succeeded");
  await tree.childServices.get(tree.a.agent.agentId)!.shutdown();
  await settle();
  // The main conversation's context projection reads exactly this list (installation.ts `context` hook).
  assert.ok(tree.service.uninformedOutcomes().some(run => run.runId === nestedRunId),
    "Claude Code surfaces a nested agent's outcome in the main conversation; the main session must see this completion");
});
