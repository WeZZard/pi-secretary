import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { deferred, standaloneAgentHarness } from "../support/standalone-agent-harness.ts";

function assertAgentOnlySchema(h: Awaited<ReturnType<typeof standaloneAgentHarness>>) {
  const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name));
  assert.ok(tables.length > 0);
  assert.ok(tables.every(name => name.startsWith("secretary_agent")), JSON.stringify(tables));
  assert.ok(!tables.includes("thread_goals"));
}
const launch = (name: string, background = false) => ({ description: "Standalone work", prompt: "Return fixture result.", subagent_type: "worker", name, run_in_background: background });

for (const observeEvents of [true, false]) test(`standalone real SDK launch persists run and usage with event consumer=${observeEvents}`, { timeout: 30000 }, async t => {
  const h = await standaloneAgentHarness(t, { observeEvents });
  const result = await h.tool("Agent", launch("foreground"));
  assert.equal(result.details.status, "succeeded");
  assert.match(result.details.output, /STANDALONE_DONE/);
  assert.equal(h.childCalls.length, 1);
  assert.ok(h.parentCalls.length >= 2);
  assert.deepEqual(h.childCalls[0].tools?.map(tool => tool.name), ["read"]);
  assert.ok(h.policyCalls.some(tools => tools.includes("host_only") && tools.includes("write")));
  const run = h.repository.getRun(result.details.runId)!;
  assert.equal(run.parentId, h.manager.getSessionId());
  assert.equal(h.repository.getAgent(run.agentId)?.agentId, run.agentId);
  const usage = h.repository.usage(run.runId);
  assert.equal(usage.length, 1);
  assert.ok(usage[0].id);
  assert.equal(usage[0].runId, run.runId);
  assert.deepEqual(h.events.map(event => event.type), observeEvents ? ["admitted", "usage"] : []);
  assert.ok(h.persistedEvents.every(Boolean), "Observers must see already-persisted run and usage identities");
  assert.ok(h.repository.completions(run.parentId).some(completion => completion.runId === run.runId));
  assertAgentOnlySchema(h);
});

test("standalone running guidance is consumed and finished-child RPC resumption completes with saved history", { timeout: 30000 }, async t => {
  const entered = deferred(), release = deferred();
  const h = await standaloneAgentHarness(t, { respondChild: async (context, index) => {
    if (index === 0) { entered.resolve(); await release.promise; }
    const history = JSON.stringify(context.messages);
    return [{ type: "text", text: history.includes("FRESH_ASSIGNMENT") ? "RESUMED_DONE" : history.includes("RUNNING_GUIDANCE") ? "GUIDANCE_DONE" : "INITIAL_DONE" }];
  } });
  try {
    const initial = await h.tool("Agent", launch("guided", true));
    await entered.promise;
    const guidance = await h.tool("SendMessage", { to: "guided", message: "RUNNING_GUIDANCE" });
    assert.equal(guidance.details.runId, initial.details.runId);
    release.resolve();
    const observed = await h.tool("TaskOutput", { task_id: initial.details.runId, block: true, timeout: 10000 });
    assert.equal(observed.details.status, "succeeded");
    assert.match(observed.details.output, /GUIDANCE_DONE/);
    assert.ok(h.repository.guidance(initial.details.runId).some(record => record.text === "RUNNING_GUIDANCE"));
    assert.ok(h.childCalls.some(context => JSON.stringify(context.messages).includes("RUNNING_GUIDANCE")),
      "Provider execution, not the transport acknowledgment, establishes that guidance reached the child");
    const agent = h.repository.getAgent(initial.details.agentId)!;
    assert.ok(agent.resumable && agent.sessionPath);
    assert.match(await readFile(agent.sessionPath, "utf8"), /GUIDANCE_DONE/);
    const resumed = await h.tool("SendMessage", { to: "guided", message: "FRESH_ASSIGNMENT" });
    assert.equal(resumed.details.agentId, initial.details.agentId);
    assert.notEqual(resumed.details.runId, initial.details.runId);
    const finished = await h.tool("TaskOutput", { task_id: resumed.details.runId, block: true, timeout: 10000 });
    assert.equal(finished.details.status, "succeeded");
    assert.match(finished.details.output, /RESUMED_DONE/);
    const resumedCall = h.childCalls.find(context => /FRESH_ASSIGNMENT/.test(JSON.stringify(context.messages)));
    assert.ok(resumedCall);
    assert.match(JSON.stringify(resumedCall.messages), /GUIDANCE_DONE/);
    assertAgentOnlySchema(h);
  } finally { release.resolve(); }
});

test("standalone cancellation settles the actual child and records completion without an event consumer", { timeout: 30000 }, async t => {
  const entered = deferred();
  const h = await standaloneAgentHarness(t, { observeEvents: false, respondChild: async (_context, _index, signal) => {
    assert.ok(signal);
    entered.resolve();
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    return [{ type: "text", text: "Cancelled fixture" }];
  } });
  const initial = await h.tool("Agent", launch("cancelled", true));
  await entered.promise;
  await h.tool("TaskStop", { task_id: initial.details.runId });
  const final = await h.tool("TaskOutput", { task_id: initial.details.runId, block: true, timeout: 10000 });
  assert.equal(final.details.status, "cancelled");
  assert.equal(h.repository.activeRun(initial.details.agentId), undefined);
  assert.ok(h.repository.completions(h.manager.getSessionId()).some(record => record.runId === initial.details.runId));
  assert.deepEqual(h.events, []);
  assertAgentOnlySchema(h);
});

test("standalone root guidance reaches a live nested owner with session-local branch entries", { timeout: 30000 }, async t => {
  const delegatorHeld = deferred(), releaseDelegator = deferred(), workerHeld = deferred(), releaseWorker = deferred();
  const h = await standaloneAgentHarness(t, { respondChild: async context => {
    if ((context.systemPrompt ?? "").includes("STANDALONE_DELEGATOR")) {
      const launched = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "nested-guidance-launch");
      if (!launched) return [{ type: "toolCall", id: "nested-guidance-launch", name: "Agent", arguments: {
        description: "Nested guided task", prompt: "NESTED_INITIAL", subagent_type: "worker", name: "nested-guided", run_in_background: false,
      } }];
      assert.ok(launched.role === "toolResult" && !launched.isError, JSON.stringify(launched));
      delegatorHeld.resolve(); await releaseDelegator.promise;
      return [{ type: "text", text: "DELEGATOR_DONE" }];
    }
    const history = JSON.stringify(context.messages);
    if (!history.includes("NESTED_RESUMED") && !history.includes("ROOT_GUIDANCE")) {
      workerHeld.resolve(); await releaseWorker.promise;
    }
    return [{ type: "text", text: history.includes("NESTED_RESUMED") ? "NESTED_RESUME_DONE" : history.includes("ROOT_GUIDANCE") ? "ROOT_GUIDANCE_DONE" : "NESTED_INITIAL_DONE" }];
  } });
  try {
    const parent = await h.tool("Agent", { ...launch("guidance-delegator", true), subagent_type: "delegator" });
    await workerHeld.promise;
    const nested = h.repository.childrenOf(parent.details.agentId)[0];
    assert.ok(nested);
    const initial = h.repository.activeRun(nested.agentId)!;
    const guided = await h.tool("SendMessage", { to: nested.agentId, message: "ROOT_GUIDANCE" });
    assert.equal(guided.details.runId, initial.runId);
    releaseWorker.resolve(); await delegatorHeld.promise;
    const result = await h.tool("TaskOutput", { task_id: initial.runId, block: true, timeout: 10000 });
    assert.equal(result.details.status, "succeeded");
    assert.match(result.details.output, /ROOT_GUIDANCE_DONE/);
    assert.equal(initial.parentId, nested.parentId);
    const rootEntryIds = new Set(h.manager.getEntries().map(entry => entry.id));
    assert.ok(initial.parentEntryId && !rootEntryIds.has(initial.parentEntryId), "The nested run's admission belongs to its owning session, not the root session");
    assert.ok(h.childCalls.some(context => JSON.stringify(context.messages).includes("ROOT_GUIDANCE")), "The nested provider must actually consume root guidance");
    assertAgentOnlySchema(h);
  } finally { releaseWorker.resolve(); releaseDelegator.resolve(); }
});

test("standalone child installer supports real nested delegation under generic host tool policy", { timeout: 30000 }, async t => {
  const h = await standaloneAgentHarness(t, { respondChild: async context => {
    if ((context.systemPrompt ?? "").includes("STANDALONE_DELEGATOR")) {
      const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "nested-launch");
      if (!result) return [{ type: "toolCall", id: "nested-launch", name: "Agent", arguments: {
        description: "Nested standalone work", prompt: "Return nested result", subagent_type: "worker", name: "nested", run_in_background: false,
      } }];
      assert.ok(result.role === "toolResult" && !result.isError, JSON.stringify(result));
      assert.equal(result.details.status, "succeeded");
      return [{ type: "text", text: "NESTED_OBSERVED" }];
    }
    return [{ type: "text", text: "NESTED_DONE" }];
  } });
  const result = await h.tool("Agent", { ...launch("delegator"), subagent_type: "delegator" });
  assert.equal(result.details.status, "succeeded");
  assert.match(result.details.output, /NESTED_OBSERVED/);
  const children = h.repository.childrenOf(result.details.agentId);
  assert.equal(children.length, 1);
  assert.equal(children[0].depth, 2);
  assert.equal(children[0].parentAgentId, result.details.agentId);
  assert.ok(h.repository.runs(children[0].parentId).some(run => run.agentId === children[0].agentId && run.status === "succeeded"));
  assert.ok(h.childCalls.every(context => !context.tools?.some(tool => tool.name === "host_only" || tool.name === "write")));
  assert.ok(h.persistedEvents.every(Boolean));
  assertAgentOnlySchema(h);
});
