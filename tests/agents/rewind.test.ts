import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { discoverySession } from "../support/discovery-session.ts";
import { AgentBranchScope } from "../../extensions/secretary/agents/branch-scope.ts";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";

const prompt = "Spawn 10 sub-agents to learn random parts of this repository and synthesize a report from what they learned.";

test("rewinding before a ten-agent launch excludes those outcomes from the next provider request", async t => {
  let api!: ExtensionAPI;
  const h = await discoverySession(t, {
    extension: pi => { api = pi; },
    setup: async (_root, dir) => {
      await mkdir(join(dir, "agents"));
      await writeFile(join(dir, "agents", "reader.md"), "---\nname: reader\ndescription: Read a fixture\ntools: [read]\n---\nReturn a fixture observation.");
    },
    respond: async context => {
      // A deterministic provider follows the same evidence path as the reported model:
      // it synthesizes when the prompt contains completed outcomes, otherwise delegates.
      const observed = context.messages.some(message => message.role === "toolResult")
        || JSON.stringify(context.messages).includes(": succeeded; run=");
      if (observed) return [{ type: "text", text: "All 10 sub-agents have finished successfully. Synthesized report." }];
      return Array.from({ length: 10 }, (_, i) => ({ type: "toolCall" as const, name: "Agent", id: `worker-${i}`,
        arguments: { description: `Inspect part ${i}`, prompt: `Read fixture part ${i}`, subagent_type: "reader", name: `worker-${i}`, run_in_background: false } }));
    },
  });
  await h.session.prompt(prompt);
  const repo = new AgentRepository(h.engine.db.connection);
  const parentId = h.manager.getSessionId();
  const firstRuns = repo.runs(parentId);
  assert.equal(firstRuns.length, 10);
  assert.ok(firstRuns.every(run => run.status === "succeeded"));
  assert.equal(h.childCalls.length, 10);
  const originalLeaf = h.manager.getLeafId()!;
  const firstUser = h.manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
  assert.ok(firstUser);

  const rewind = await h.session.navigateTree(firstUser.id, { summarize: false });
  assert.equal(rewind.cancelled, false);
  assert.equal(rewind.editorText, prompt);
  assert.equal(h.manager.getSessionId(), parentId, "tree navigation keeps session ownership");
  assert.ok(!h.manager.getBranch().some(entry => entry.id === originalLeaf));
  assert.ok(!h.session.messages.some(message => message.role === "toolResult"), "pi itself has removed the old results from active history");
  const nextRequest = h.parentCalls.length;
  api.sendMessage({ customType: "secretary:agent-completion", content: `Stale queued completion: ${firstRuns[0]!.runId}`,
    display: true, details: { runId: firstRuns[0]!.runId, deliveryId: `completion:${firstRuns[0]!.runId}` } }, { deliverAs: "nextTurn" });
  await h.session.prompt(rewind.editorText!);
  const received = JSON.stringify(h.parentCalls[nextRequest]!.messages);
  for (const run of firstRuns) {
    assert.ok(!received.includes(run.runId), `abandoned-branch run ${run.runId} leaked into the new provider request`);
    assert.ok(!received.includes(run.outputPath), "abandoned output paths must not be injected as current results");
  }
  const replayResults = h.session.messages.filter(message => message.role === "toolResult" && message.toolName === "Agent");
  assert.ok(replayResults.every(message => message.role === "toolResult" && !message.isError), JSON.stringify(replayResults));
  assert.equal(h.childCalls.length, 20, "the repeated request must execute fresh child sessions");
  const allRuns = repo.runs(parentId);
  assert.equal(allRuns.length, 20);
  assert.ok(allRuns.every(run => run.status === "succeeded"));
  for (const run of firstRuns) assert.deepEqual(repo.getRun(run.runId), run, "rewind preserves physical execution history");
  const secondRuns = allRuns.filter(run => !firstRuns.some(first => first.runId === run.runId));
  assert.ok(secondRuns.every(run => !firstRuns.some(first => first.launchKey === run.launchKey)), "reused tool-call IDs have different admission identities");
  const reopened = new AgentBranchScope(SessionManager.open(h.session.sessionFile!));
  assert.ok(firstRuns.every(run => reopened.disposition(run) === "outside"));
  assert.ok(secondRuns.every(run => reopened.disposition(run) === "visible"));

  const requestsBeforeReturn = h.parentCalls.length;
  await h.session.navigateTree(originalLeaf, { summarize: false });
  assert.equal(h.childCalls.length, 20, "returning to old history does not replay launches");
  await h.session.prompt("Inspect the retained original results.");
  const restored = JSON.stringify(h.parentCalls[requestsBeforeReturn]!.messages);
  for (const run of firstRuns) assert.ok(restored.includes(run.runId));
  for (const run of secondRuns) assert.ok(!restored.includes(run.runId));
});

test("rewind of a resumption shows the retained run and refuses an advanced child conversation", async t => {
  const h = await discoverySession(t, {
    mode: "rpc",
    setup: async (_root, dir) => {
      await mkdir(join(dir, "agents"));
      await writeFile(join(dir, "agents", "reader.md"), "---\nname: reader\ndescription: Resumable reader\ntools: [read]\n---\nRead a fixture.");
    },
    respond: async (_context, index) => {
      if (index === 0) return [{ type: "toolCall", name: "Agent", id: "create", arguments: {
        name: "reader", description: "Read", prompt: "Read", subagent_type: "reader", run_in_background: false } }];
      if (index === 2 || index === 6) return [{ type: "toolCall", name: "SendMessage", id: "resume", arguments: { to: "reader", message: "Read more" } }];
      if (index === 4) return [{ type: "toolCall", name: "TaskOutput", id: "inspect", arguments: { task_id: "reader", block: false } }];
      return [{ type: "text", text: "Observed." }];
    },
    respondChild: async (_context, index, signal) => {
      if (index === 0) return [{ type: "text", text: "Initial retained result." }];
      assert.ok(signal);
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return [];
    },
  });
  const repo = new AgentRepository(h.engine.db.connection), parentId = h.manager.getSessionId();
  await h.session.prompt("Create a reader.");
  const first = repo.runs(parentId)[0]!;
  assert.equal(first.status, "succeeded");
  await h.session.prompt("Resume the reader.");
  await waitFor(() => h.childCalls.length === 2 && repo.runs(parentId)[1]?.status === "running");
  const secondUser = h.manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user")[1]!;
  const resumed = repo.runs(parentId)[1]!;
  await h.session.navigateTree(secondUser.id, { summarize: false });
  await waitFor(() => repo.getRun(resumed.runId)?.status === "cancelled");
  await h.session.prompt("Inspect the retained reader.");
  const result = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "TaskOutput");
  assert.ok(result?.role === "toolResult" && !result.isError);
  assert.equal(result.details.runId, first.runId);
  assert.ok(!JSON.stringify(h.parentCalls[4]!.messages).includes(resumed.runId));
  await h.session.prompt("Try resuming from this branch.");
  const rejected = h.session.messages.filter(message => message.role === "toolResult" && message.toolName === "SendMessage").at(-1);
  assert.ok(rejected?.role === "toolResult" && rejected.isError);
  assert.match(JSON.stringify(rejected.content), /saved conversation.*another branch/);
  assert.equal(h.childCalls.length, 2, "an advanced saved child transcript must not resume as if it were rewound");
});

test("legacy provenance requires unique structured admission and survives compacted ancestry", async t => {
  const h = await discoverySession(t, { respond: async (_context, index) => index === 0 ? [{ type: "toolCall", name: "Agent", id: "legacy-call",
    arguments: { description: "Read", prompt: "Read", subagent_type: "Explore", run_in_background: false } }] : [{ type: "text", text: "Done." }] });
  await h.session.prompt("Read one fixture.");
  const run = new AgentRepository(h.engine.db.connection).runs(h.manager.getSessionId())[0]!;
  const scope = new AgentBranchScope(h.manager);
  const legacy = { ...run, launchKey: "legacy-call", parentEntryId: undefined };
  assert.equal(scope.disposition(legacy), "visible");
  assert.equal(scope.disposition({ ...legacy, launchKey: "missing" }), "unknown");
  const oldLeaf = h.manager.getLeafId()!;
  h.manager.appendCompaction("Fixture summary without launch identifiers.", oldLeaf, 1);
  assert.equal(scope.disposition(run), "visible", "compaction keeps launch ancestry even when provider context omits it");
  assert.equal(scope.disposition(legacy), "visible");
  const user = h.manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user")!;
  await h.session.navigateTree(user.id, { summarize: false });
  assert.equal(scope.disposition(legacy), "outside");
  const originalAdmission = h.manager.getEntries().find(entry => entry.id === run.parentEntryId);
  assert.ok(originalAdmission?.type === "message" && originalAdmission.message.role === "assistant");
  h.manager.appendMessage(originalAdmission.message);
  assert.equal(scope.disposition(legacy), "unknown", "reused legacy call IDs do not prove a unique origin");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture work did not reach the expected lifecycle state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("rewind cancels only abandoned live admissions and suppresses their completion turn", async t => {
  const h = await discoverySession(t, {
    mode: "rpc",
    setup: async (_root, dir) => {
      await mkdir(join(dir, "agents"));
      await writeFile(join(dir, "agents", "reader.md"), "---\nname: reader\ndescription: Waiting fixture\ntools: [read]\n---\nWait for cancellation.");
    },
    respond: async (_context, index) => index === 0 || index === 2 ? [{ type: "toolCall", name: "Agent", id: `call-${index}`,
      arguments: { name: index === 0 ? "retained" : "abandoned", subagent_type: "reader", description: "Wait", prompt: "Wait", run_in_background: true } }]
      : [{ type: "text", text: "Background launch acknowledged." }],
    respondChild: async (_context, _index, signal) => {
      assert.ok(signal);
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return [];
    },
  });
  const repo = new AgentRepository(h.engine.db.connection);
  const parentId = h.manager.getSessionId();
  await h.session.prompt("Start retained work.");
  await waitFor(() => h.childCalls.length === 1 && repo.runs(parentId)[0]?.status === "running");
  await h.session.prompt("Start work that will be abandoned.");
  await waitFor(() => h.childCalls.length === 2 && repo.runs(parentId)[1]?.status === "running");
  const users = h.manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user");
  const [retained, abandoned] = repo.runs(parentId);
  const callsBeforeRewind = h.parentCalls.length;
  await h.session.navigateTree(users[1]!.id, { summarize: false });
  await waitFor(() => repo.getRun(abandoned!.runId)?.status === "cancelled");
  assert.equal(repo.getRun(retained!.runId)?.status, "running");
  assert.equal(h.parentCalls.length, callsBeforeRewind, "abandoned completion must not trigger a new parent turn");
  assert.ok(!h.manager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "secretary:agent-completion"));
  const scope = new AgentBranchScope(h.manager);
  assert.equal(scope.disposition(retained!), "visible");
  assert.equal(scope.disposition(abandoned!), "outside");
  await h.session.prompt("Inspect only retained background work.");
  const current = JSON.stringify(h.parentCalls[callsBeforeRewind]!.messages);
  assert.ok(current.includes(retained!.runId));
  assert.ok(!current.includes(abandoned!.runId));
});
