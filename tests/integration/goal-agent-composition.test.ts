import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Context, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { goalAgentCompositionSession } from "../support/goal-agent-composition-session.ts";
import { flushAutomaticScheduling } from "../support/host-session.ts";

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const text = (value: string) => [{ type: "text" as const, text: value }];
const results = (context: Context) => context.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
const SETUP = "Create a goal to summarize fixture release notes. Delegate the initial summary, then mark the goal blocked because release approval is unavailable.";
const RECOVERY = "Without resuming the goal, launch a new worker to inspect fixture network diagnostics and ask the finished release worker to inventory fixture backup procedures. This recovery work extends beyond the release-notes objective. Do both now and observe both results.";

test("SA-08: fresh user Agent and finished-child SendMessage execute while the goal stays blocked", { timeout: 30000 }, async t => {
  const h = await goalAgentCompositionSession(t, {
    setup: async (_root, dir) => {
      await mkdir(join(dir, "agents"));
      await writeFile(join(dir, "agents", "composition-worker.md"), "---\nname: composition-worker\ndescription: Isolated composition worker\ntools: [read]\n---\nReturn the requested fixture result.\n");
    },
    respond: async context => {
      const seen = results(context);
      const has = (id: string) => seen.some(m => m.toolCallId === id);
      const recovery = context.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes(RECOVERY));
      if (!recovery) {
        if (!has("create")) return [call("create", "create_goal", { objective: "Summarize fixture release notes" })];
        if (!has("initial")) return [call("initial", "Agent", { description: "Release summary", prompt: "INITIAL_RELEASE_SUMMARY", name: "release-worker", subagent_type: "composition-worker", run_in_background: false })];
        if (!has("block")) return [call("block", "update_goal", { status: "blocked" })];
        return text("Release summary observed. Goal blocked pending release approval.");
      }
      if (!has("recover-new")) return [
        call("recover-new", "Agent", { description: "Network recovery", prompt: "NETWORK_DIAGNOSTICS", name: "network-worker", subagent_type: "composition-worker", run_in_background: true }),
        call("recover-existing", "SendMessage", { to: "release-worker", message: "BACKUP_PROCEDURES" }),
      ];
      const pending = ["recover-new", "recover-existing"].flatMap(id => {
        const result = seen.find(m => m.toolCallId === id);
        return result && !result.isError && !has(`observe-${id}`)
          ? [call(`observe-${id}`, "TaskOutput", { task_id: result.details.runId, block: true, timeout: 10000 })] : [];
      });
      return pending.length ? pending : text("Recovery outcomes inspected; leave the goal blocked.");
    },
    respondChild: async context => {
      const transcript = JSON.stringify(context.messages);
      return text(transcript.includes("BACKUP_PROCEDURES") ? "BACKUP_PROCEDURES_DONE"
        : transcript.includes("NETWORK_DIAGNOSTICS") ? "NETWORK_DIAGNOSTICS_DONE" : "INITIAL_RELEASE_SUMMARY_DONE");
    },
  });
  let failure: unknown;
  try {
    await h.session.prompt(SETUP, { source: "rpc" });
    await h.session.waitForIdle();
    await flushAutomaticScheduling();
    const initial = h.repository.runs(h.threadId);
    assert.equal(initial.length, 1, JSON.stringify(h.session.messages));
    assert.equal(initial[0].status, "succeeded");
    const agent = h.repository.getAgent(initial[0].agentId)!;
    assert.equal(agent.resumable, true);
    assert.ok(agent.sessionPath, "The initial child must have a persistent conversation to resume");
    assert.match(await readFile(agent.sessionPath, "utf8"), /INITIAL_RELEASE_SUMMARY_DONE/);
    assert.match(initial[0].output, /INITIAL_RELEASE_SUMMARY_DONE/);
    assert.equal(h.childCalls.length, 1);
    const blocked = h.engine.service.getGoal(h.goalThreadId)!;
    assert.equal(blocked.status, "blocked");
    const automaticBefore = h.session.messages.filter(m => m.role === "custom" && m.customType === "secretary:goal-automatic").length;

    await h.session.prompt(RECOVERY, { source: "rpc" });
    await h.session.waitForIdle();
    await flushAutomaticScheduling();
    const outcomes = h.session.messages.filter((m): m is ToolResultMessage => m.role === "toolResult" && ["recover-new", "recover-existing"].includes(m.toolCallId));
    assert.equal(outcomes.length, 2);
    assert.equal(h.engine.service.getGoal(h.goalThreadId)?.goalId, blocked.goalId);
    assert.equal(h.engine.service.getGoal(h.goalThreadId)?.status, "blocked");
    assert.equal(h.session.messages.filter(m => m.role === "custom" && m.customType === "secretary:goal-automatic").length, automaticBefore);
    assert.deepEqual(h.inputs.map(({ text, source }) => ({ text, source })), [
      { text: SETUP, source: "rpc" }, { text: RECOVERY, source: "rpc" },
    ], "Only fresh user prompts were submitted; no resume or task-classification request was used");
    assert.deepEqual(outcomes.map(m => ({ tool: m.toolName, error: m.isError })), [
      { tool: "Agent", error: false }, { tool: "SendMessage", error: false },
    ], `Fresh user delegation must execute without a goal resume. Actual results: ${JSON.stringify(outcomes)}`);
    for (const outcome of outcomes) {
      const observation = h.session.messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === `observe-${outcome.toolCallId}`);
      assert.ok(observation && !observation.isError, "The parent must observe completion, not only acceptance");
      assert.equal(observation.details.status, "succeeded");
      const run = h.repository.getRun(outcome.details.runId)!;
      assert.equal(run.status, "succeeded");
      assert.match(await readFile(run.outputPath, "utf8"), outcome.toolName === "Agent" ? /NETWORK_DIAGNOSTICS_DONE/ : /BACKUP_PROCEDURES_DONE/);
      if (outcome.toolName === "SendMessage") {
        assert.equal(run.agentId, agent.agentId);
        assert.notEqual(run.runId, initial[0].runId);
      }
    }
    assert.equal(h.childCalls.length, 3);
    assert.ok(h.childCalls.some(c => /INITIAL_RELEASE_SUMMARY_DONE/.test(JSON.stringify(c.messages)) && /BACKUP_PROCEDURES/.test(JSON.stringify(c.messages))), "Resumption must restore the finished child's conversation");
    assert.equal(h.session.pendingMessageCount, 0);
  } catch (error) { failure = error; throw error; }
  finally { await h.retain({ failure: failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure }); }
});
