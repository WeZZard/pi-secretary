import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentService, type LaunchSpec } from "../../extensions/secretary/agents/service.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { defaultAgentUi } from "../../extensions/secretary/agents/configuration.ts";
import type { RunningChild } from "../../extensions/secretary/agents/records.ts";

// The production service, SQLite repository, queue, and commit notifications are real.
// Only the child execution boundary is controlled; no provider is contacted.
function harness(abortFails = false) {
  const root = mkdtempSync(join(tmpdir(), "fleet-stop-many-"));
  const db = new DatabaseSync(":memory:"); const repository = new AgentRepository(db);
  const started: string[] = [], diagnostics: unknown[] = [];
  const finishers: (() => void)[] = [];
  const service = new AgentService({ parentId: "parent", root, repository, diagnostic: error => { diagnostics.push(error); },
    ctx: { cwd: root, mode: "tui" } as ExtensionContext,
    config: { modelFallbackLists: {}, subagentModels: {}, ui: defaultAgentUi(), maxConcurrent: 1, maxQueued: 10, shutdownTimeoutMs: 1000, maxNestingDepth: 3 },
    runner: async options => {
      started.push(options.run.runId);
      let finish!: () => void;
      const result: RunningChild["result"] = new Promise(resolve => { finish = () => resolve({ status: "cancelled", output: "partial" }); });
      finishers.push(finish);
      // Aborting deliberately does not settle. This proves cancelling is not completion.
      return { result, steer: async () => {}, abort: async () => { if (abortFails) throw new Error("Child did not acknowledge abort"); }, dispose: async () => {} };
    },
  });
  const spec = (key: string): LaunchSpec => ({ launchKey: key, definition: { name: "worker", description: "Worker", prompt: "Work", source: "test", hash: "h", resumable: true }, model: "test/model", tools: ["read"], prompt: "Task", description: key, background: true });
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  return { service, repository, started, diagnostics, finishers, spec, tick,
    async close() { finishers.forEach(finish => finish()); await service.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("batch cancellation commits all captured queue states before notification and never starts captured queued runs", async () => {
  const h = harness(true);
  try {
    const a = await h.service.launch(h.spec("a")); await h.tick();
    const b = await h.service.launch(h.spec("b")); const c = await h.service.launch(h.spec("c"));
    const ids = [a, b, c].map(s => s.run!.runId);
    const observations: string[][] = [];
    const off = h.service.subscribe(() => observations.push(ids.map(id => h.service.run(id).status)));
    // The fallback reproduces the pre-batch commit boundary without mocking the service.
    if (h.service.stopMany) await h.service.stopMany(ids, "all");
    else await Promise.all(ids.map(id => h.service.stop(id, `all:${id}`)));
    off();
    assert.ok(observations.length > 0);
    assert.ok(observations.every(statuses => statuses.every(status => status === "cancelling" || status === "cancelled")), "no listener may see a partially cancelled batch with queued work");
    assert.equal(h.service.run(a.run!.runId).status, "cancelling");
    assert.match(String(h.diagnostics[0]), /did not acknowledge abort/);
    assert.ok(h.service.receipt("all"), "a child abort failure does not erase accepted cancellation or abandon the remaining batch");
    assert.equal(h.service.run(b.run!.runId).status, "cancelled");
    const later = await h.service.launch(h.spec("later"));
    await h.service.stopMany(ids, "all"); // Receipt replay does not broaden the captured set.
    assert.equal(h.service.run(later.run!.runId).status, "queued");
    h.finishers[0]!(); await h.tick();
    assert.deepEqual(h.started, [a.run!.runId, later.run!.runId]);
    assert.ok(h.service.receipt("all"));
  } finally { await h.close(); }
});

test("batch cancellation validates exact parent-owned IDs before changing any target", async () => {
  const h = harness();
  try {
    const a = await h.service.launch(h.spec("a")); await h.tick();
    h.repository.putAgent({ ...a.agent, agentId: "foreign-agent", parentId: "foreign" });
    h.repository.putRun({ ...a.run!, runId: "foreign-run", agentId: "foreign-agent", parentId: "foreign" });
    await assert.rejects(h.service.stopMany([a.run!.runId, "foreign-run"], "bad"), /parent|session/);
    assert.equal(h.service.run(a.run!.runId).status, "running");
    await assert.rejects(h.service.stopMany([a.agent.agentId], "not-exact"), /Run/);
    assert.equal(h.service.receipt("bad"), undefined);
  } finally { await h.close(); }
});
