import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentService, type LaunchSpec } from "../../extensions/secretary/agents/service.ts";
import { defaultAgentUi } from "../../extensions/secretary/agents/configuration.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { WorktreeManager } from "../../extensions/secretary/agents/worktrees.ts";
import type { AgentRun, RunningChild, RunnerHooks } from "../../extensions/secretary/agents/records.ts";

function harness(mode = "tui", concurrent = 1, branchDisposition?: (run: AgentRun) => "visible" | "outside" | "unknown") {
  const root = mkdtempSync(join(tmpdir(), "secretary-service-"));
  const db = new DatabaseSync(":memory:");
  const repository = new AgentRepository(db);
  const children = new Map<string, { finish: (out?: string) => void; messages: string[]; hooks: RunnerHooks }>();
  let starts = 0;
  const service = new AgentService({ parentId: "parent", root, repository, branchDisposition,
    ctx: { cwd: root, mode } as ExtensionContext,
    config: { modelFallbackLists: {}, ui: defaultAgentUi(), maxConcurrent: concurrent, maxQueued: 2, shutdownTimeoutMs: 1000, maxNestingDepth: 3 },
    runner: async options => {
      starts++;
      const sessionPath = join(root, `${options.agent.agentId}.jsonl`);
      writeFileSync(sessionPath, '{"type":"session"}\n'); options.hooks.session(sessionPath);
      let resolve!: (value: Awaited<RunningChild["result"]>) => void;
      const result = new Promise<Awaited<RunningChild["result"]>>(r => { resolve = r; });
      const messages: string[] = [];
      children.set(options.run.runId, { finish: (out = "done") => resolve({ status: "succeeded", output: out }), messages, hooks: options.hooks });
      return { result, steer: async text => { messages.push(text); }, abort: async () => { resolve({ status: "cancelled", output: "partial" }); }, dispose: async () => {} };
    },
  });
  const spec = (key: string): LaunchSpec => ({ launchKey: key, definition: { name: "worker", description: "Worker", prompt: "Work", source: "test", hash: "hash", resumable: true },
    model: "test/model", tools: ["read"], prompt: "Do the task", description: "Test task", background: true });
  const tick = () => new Promise<void>(r => setImmediate(r));
  return { service, repository, spec, children, tick, starts: () => starts,
    async close() { await service.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("historical branch inspection never exposes an advanced transcript or descendant roster", async () => {
  const visible = new Set(["initial", "later"]);
  const h = harness("tui", 1, run => visible.has(run.parentEntryId!) ? "visible" : "outside");
  try {
    const a = await h.service.launch({ ...h.spec("one"), name: "reader", parentEntryId: "initial" }); await h.tick();
    h.children.get(a.run!.runId)!.finish("Retained initial output."); await h.tick();
    const later = await h.service.message("reader", "follow up", "resume", undefined, "later"); await h.tick();
    h.children.get(later.runId)!.finish("Future output."); await h.tick();
    h.repository.putAgent({ ...a.agent, agentId: "future-child", parentAgentId: a.agent.agentId, parentId: "child-session", name: "future" });
    h.repository.putRun({ ...later, runId: "future-child-run", agentId: "future-child", parentId: "child-session", status: "succeeded" });
    assert.ok(h.service.tree().some(s => s.agent.agentId === "future-child"));
    visible.delete("later"); await h.service.reconcileBranch();
    assert.equal(h.service.inspectRun("reader").runId, a.run!.runId);
    assert.equal(h.service.inspectRun(later.runId).runId, later.runId, "exact historical run IDs remain accessible");
    assert.deepEqual(h.service.tree().map(s => s.agent.agentId), [a.agent.agentId]);
    assert.deepEqual(h.service.treeViewModels().map(s => s.agentId), [a.agent.agentId]);
    const transcript = JSON.stringify(await h.service.transcript("reader"));
    assert.match(transcript, /Retained initial output/); assert.doesNotMatch(transcript, /Future output/);
    assert.match(transcript, /advanced on another branch/);
  } finally { await h.close(); }
});

test("unknown legacy provenance neither enters current context nor authorizes rewind cancellation", async () => {
  const h = harness("tui", 1, () => "unknown");
  try {
    const a = await h.service.launch(h.spec("legacy")); await h.tick();
    await h.service.reconcileBranch();
    assert.equal(h.service.run(a.run!.runId).status, "running");
    assert.deepEqual(h.service.list(), []);
    assert.equal(h.service.resolve(a.agent.agentId).agentId, a.agent.agentId);
  } finally { await h.close(); }
});

test("service deduplicates launch and admits queued children after settlement", async () => {
  const h = harness();
  try {
    const a = await h.service.launch(h.spec("one"));
    const repeated = await h.service.launch(h.spec("one"));
    assert.equal(a.agent.agentId, repeated.agent.agentId);
    const b = await h.service.launch(h.spec("two")); await h.tick();
    assert.equal(h.starts(), 1); assert.equal(h.service.run(b.run!.runId).status, "queued");
    h.children.get(a.run!.runId)!.finish(); await h.tick();
    assert.equal(h.starts(), 2); assert.equal(h.service.run(a.run!.runId).status, "succeeded");
  } finally { await h.close(); }
});

test("queued cancellation never submits a provider prompt and repeated stop is harmless", async () => {
  const h = harness();
  try {
    await h.service.launch(h.spec("one"));
    const b = await h.service.launch(h.spec("two")); await h.tick();
    await h.service.stop(b.run!.runId, "stop"); await h.service.stop(b.run!.runId, "stop");
    assert.equal(h.service.run(b.run!.runId).status, "cancelled"); assert.equal(h.starts(), 1);
    assert.equal(h.repository.completions("parent").filter(c => c.runId === b.run!.runId).length, 1);
  } finally { await h.close(); }
});

test("guidance receipts deduplicate messages and resumption preserves agent identity", async () => {
  const h = harness();
  try {
    const a = await h.service.launch({ ...h.spec("one"), name: "reviewer" }); await h.tick();
    await h.service.message("reviewer", "check errors", "msg");
    await h.service.message("reviewer", "check errors", "msg");
    assert.deepEqual(h.children.get(a.run!.runId)!.messages, ["check errors"]);
    h.children.get(a.run!.runId)!.finish(); await h.tick();
    const [one, two] = await Promise.all([h.service.message("reviewer", "follow-up", "next"), h.service.message("reviewer", "also tests", "next2")]);
    assert.equal(one.agentId, a.agent.agentId); assert.equal(one.runId, two.runId); assert.notEqual(one.runId, a.run!.runId);
    assert.equal(h.repository.guidance(a.run!.runId)[0].state, "uncertain");
  } finally { await h.close(); }
});

test("cancelling an output wait does not cancel its captured execution", async () => {
  const h = harness();
  try {
    const a = await h.service.launch(h.spec("one")); await h.tick();
    const abort = new AbortController();
    const pending = h.service.wait(a.run!.runId, 10000, abort.signal); abort.abort();
    await assert.rejects(pending, /wait cancelled/);
    assert.equal(h.service.run(a.run!.runId).status, "running");
    const snapshot = await h.service.wait(a.run!.runId, 0); assert.equal(snapshot.status, "running");
  } finally { await h.close(); }
});

test("headless resume fails before creating a new run", async () => {
  const h = harness("print");
  try {
    const a = await h.service.launch({ ...h.spec("one"), background: false }); await h.tick();
    h.children.get(a.run!.runId)!.finish(); await h.tick();
    await assert.rejects(h.service.message(a.agent.agentId, "continue", "next"), /persistent TUI or RPC/);
    assert.equal(h.repository.runs("parent").length, 1);
  } finally { await h.close(); }
});

test("a run ID or name cannot grant another parent's agent control", async () => {
  const h = harness();
  try {
    await assert.rejects(h.service.stop("foreign-run", "stop"), /not found/);
    await assert.rejects(h.service.message("foreign-agent", "continue", "message"), /not found/);
    assert.equal(h.starts(), 0);
  } finally { await h.close(); }
});

test("streamed output is retained when the runner reports only its last message", async () => {
  const h = harness();
  try {
    const a = await h.service.launch(h.spec("one")); await h.tick();
    h.children.get(a.run!.runId)!.hooks.text("Earlier findings.\n");
    h.children.get(a.run!.runId)!.finish("Final answer."); await h.tick();
    assert.match(h.service.run(a.run!.runId).output, /Earlier findings/);
    assert.match(h.service.run(a.run!.runId).output, /Final answer/);
  } finally { await h.close(); }
});

test("inspector-style resume cannot silently discard prior goal attribution", async () => {
  const h = harness();
  try {
    const a = await h.service.launch({ ...h.spec("goal-work"), goal: { threadId: "parent", goalId: "goal", sessionEpoch: "epoch", intentSeq: 1, controlGeneration: 1 } });
    await h.tick(); h.children.get(a.run!.runId)!.finish(); await h.tick();
    await assert.rejects(h.service.message(a.agent.agentId, "continue", "resume"), /current goal authorization/);
    assert.equal(h.repository.runs("parent").length, 1);
  } finally { await h.close(); }
});

test("shutdown waits for an accepted worktree cleanup before releasing storage", async () => {
  const h = harness();
  const original = WorktreeManager.prototype.cleanup;
  let finish!: () => void;
  WorktreeManager.prototype.cleanup = async () => new Promise<void>(resolve => { finish = resolve; });
  try {
    const a = await h.service.launch(h.spec("one")); await h.tick();
    h.children.get(a.run!.runId)!.finish(); await h.tick();
    const agent = h.repository.getAgent(a.agent.agentId)!;
    agent.worktree = { id: "owned", repo: "test", path: "test", branch: "test", baseCommit: "test", state: "allocated" };
    h.repository.putAgent(agent);
    const cleanup = h.service.cleanup(agent.agentId, "cleanup"); await h.tick();
    let stopped = false;
    const shutdown = h.service.shutdown().then(result => { stopped = true; return result; });
    await h.tick(); assert.equal(stopped, false);
    finish(); await cleanup; assert.equal(await shutdown, true);
    assert.equal(h.repository.getAgent(agent.agentId)!.worktree!.state, "removed");
  } finally { WorktreeManager.prototype.cleanup = original; await h.close(); }
});

test("shutdown settles active work before the shared database closes", async () => {
  const h = harness();
  try {
    const a = await h.service.launch(h.spec("one")); await h.tick();
    assert.equal(await h.service.shutdown(), true);
    assert.equal(h.service.run(a.run!.runId).status, "cancelled");
    await assert.rejects(h.service.launch(h.spec("new")), /shutting down/);
  } finally { await h.close(); }
});
