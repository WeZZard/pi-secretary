import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentService, type LaunchSpec } from "../../extensions/secretary/agents/service.ts";
import { defaultAgentUi, type AgentConfiguration } from "../../extensions/secretary/agents/configuration.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { registerLiveChildService } from "../../extensions/secretary/agents/live-services.ts";
import type { AgentRun, RunningChild } from "../../extensions/secretary/agents/records.ts";

const config: AgentConfiguration = { modelFallbackLists: {}, ui: defaultAgentUi(), maxConcurrent: 4, maxQueued: 8, shutdownTimeoutMs: 1000, maxNestingDepth: 3 };
const tick = () => new Promise<void>(r => setImmediate(r));

type Runner = NonNullable<ConstructorParameters<typeof AgentService>[0]["runner"]>;

/**
 * A two-service composition over one repository: the main session's service plus a service
 * standing in for a delegated agent's child session. The delegating runner mirrors the
 * production shutdown path: cancelling the parent shuts down the child session's service
 * (session_shutdown) before the parent run settles.
 */
async function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "secretary-nested-"));
  const db = new DatabaseSync(":memory:");
  const repository = new AgentRepository(db);
  const ctx = { cwd: root, mode: "tui" } as ExtensionContext;
  const childServices = new Map<string, AgentService>();
  const children = new Map<string, { finish: (out?: string) => void }>();

  const simpleRunner: Runner = async options => {
    const sessionPath = join(root, `${options.agent.agentId}.jsonl`);
    writeFileSync(sessionPath, '{"type":"session"}\n');
    options.hooks.session(sessionPath);
    let resolve!: (value: Awaited<RunningChild["result"]>) => void;
    const result = new Promise<Awaited<RunningChild["result"]>>(r => { resolve = r; });
    children.set(options.run.runId, { finish: (out = "done") => resolve({ status: "succeeded", output: out }) });
    return { result, steer: async () => {}, abort: async () => { resolve({ status: "cancelled", output: "" }); }, dispose: async () => {} };
  };

  const rootRunner: Runner = async options => {
    if (options.agent.definition.name !== "delegator") return simpleRunner(options);
    const sessionPath = join(root, `${options.agent.agentId}.jsonl`);
    writeFileSync(sessionPath, '{"type":"session"}\n');
    options.hooks.session(sessionPath);
    // The delegated agent's session installs its own agent support and registers it live.
    const child = new AgentService({ parentId: `session-${options.agent.agentId}`, root: join(root, `child-${options.agent.agentId}`),
      ctx, config, repository, depth: options.agent.depth, runner: simpleRunner });
    const unregister = registerLiveChildService(options.agent.agentId, child);
    childServices.set(options.agent.agentId, child);
    let resolve!: (value: Awaited<RunningChild["result"]>) => void;
    const result = new Promise<Awaited<RunningChild["result"]>>(r => { resolve = r; });
    const shutdown = async () => { await child.shutdown(); unregister(); };
    return { result, steer: async () => {},
      abort: async () => { await shutdown(); resolve({ status: "cancelled", output: "" }); },
      dispose: shutdown };
  };

  const service = new AgentService({ parentId: "main", root, ctx, config, repository, runner: rootRunner });
  const spec = (key: string, name = "worker"): LaunchSpec => ({ launchKey: key,
    definition: { name, description: name, prompt: "Work", source: "test", hash: "hash", resumable: true },
    model: "test/model", tools: ["read"], prompt: "Do the task", description: `Task ${key}`, background: true });
  t.after(async () => { await service.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { service, repository, spec, children, childServices, tick };
}

test("nested agents join the tree with recorded parentage while the indicator set stays top-level", async (t) => {
  const h = await harness(t);
  const a = await h.service.launch(h.spec("a", "delegator")); await h.tick();
  const child = h.childServices.get(a.agent.agentId)!;
  assert.ok(child, "the delegating agent's session installed agent support");
  const b = await child.launch({ ...h.spec("b"), parentAgentId: a.agent.agentId }); await h.tick();
  assert.equal(b.agent.parentAgentId, a.agent.agentId);
  assert.equal(b.agent.depth, 2);
  const tree = h.service.tree();
  assert.deepEqual(tree.map(s => s.agent.agentId), [a.agent.agentId, b.agent.agentId]);
  assert.deepEqual(h.service.list().map(s => s.agent.agentId), [a.agent.agentId], "the flat list stays top-level");
  const rows = h.service.treeViewModels();
  assert.equal(rows.find(r => r.agentId === b.agent.agentId)?.parentAgentId, a.agent.agentId);
  assert.equal(rows.find(r => r.agentId === b.agent.agentId)?.status, "running");
  assert.equal(h.service.viewModels().some(r => r.agentId === b.agent.agentId), false, "top-level rows exclude nested agents");
  assert.equal(h.service.resolve(b.agent.agentId).agentId, b.agent.agentId, "descendants resolve through the tree");
  assert.equal(h.service.run(b.run!.runId).status, "running", "descendant runs resolve by id");
  assert.deepEqual(await h.service.transcript(b.agent.agentId), [], "descendant transcripts load through the tree");
});

test("tree rows remain inspectable after the owning child session ends", async (t) => {
  const h = await harness(t);
  const a = await h.service.launch(h.spec("a", "delegator")); await h.tick();
  const child = h.childServices.get(a.agent.agentId)!;
  const b = await child.launch({ ...h.spec("b"), parentAgentId: a.agent.agentId }); await h.tick();
  h.children.get(b.run!.runId)!.finish("nested done"); await h.tick();
  assert.equal(child.run(b.run!.runId).status, "succeeded");
  await child.shutdown();
  // The registry entry is gone only when the parent session itself ends; simulate that end.
  await h.service.stop(a.run!.runId, "stop-a"); await h.tick(); await h.tick();
  const tree = h.service.tree();
  const nested = tree.find(s => s.agent.agentId === b.agent.agentId);
  assert.equal(nested?.run?.status, "succeeded", "historical nested rows come from storage");
  assert.equal(h.service.treeViewModels().find(r => r.agentId === b.agent.agentId)?.status, "succeeded");
});

test("stopping a parent cascades into its nested children before the parent settles", async (t) => {
  const h = await harness(t);
  const a = await h.service.launch(h.spec("a", "delegator")); await h.tick();
  const child = h.childServices.get(a.agent.agentId)!;
  const b = await child.launch({ ...h.spec("b"), parentAgentId: a.agent.agentId });
  const c = await child.launch({ ...h.spec("c"), parentAgentId: a.agent.agentId }); await h.tick();
  assert.equal(child.run(b.run!.runId).status, "running");
  const settled = h.service.stop(a.run!.runId, "stop-a");
  await settled; await h.tick(); await h.tick();
  assert.equal(h.service.run(a.run!.runId).status, "cancelled");
  assert.equal(h.service.run(b.run!.runId).status, "cancelled", "the first nested child stopped with its parent");
  assert.equal(h.service.run(c.run!.runId).status, "cancelled", "the second nested child stopped with its parent");
});

test("stopping one branch leaves a parallel sibling branch running", async (t) => {
  const h = await harness(t);
  const a1 = await h.service.launch(h.spec("a1", "delegator"));
  const a2 = await h.service.launch(h.spec("a2", "delegator")); await h.tick();
  const b1 = await h.childServices.get(a1.agent.agentId)!.launch({ ...h.spec("b1"), parentAgentId: a1.agent.agentId });
  const b2 = await h.childServices.get(a2.agent.agentId)!.launch({ ...h.spec("b2"), parentAgentId: a2.agent.agentId }); await h.tick();
  await h.service.stop(a1.run!.runId, "stop-a1"); await h.tick(); await h.tick();
  assert.equal(h.service.run(b1.run!.runId).status, "cancelled");
  assert.equal(h.service.run(a2.run!.runId).status, "running", "the sibling parent is untouched");
  assert.equal(h.service.run(b2.run!.runId).status, "running", "the sibling branch is untouched");
  // Route a direct stop of the live nested agent through its owning session.
  await h.service.stop(b2.run!.runId, "stop-b2"); await h.tick(); await h.tick();
  assert.equal(h.service.run(b2.run!.runId).status, "cancelled");
  assert.equal(h.service.run(a2.run!.runId).status, "running", "stopping the nested child does not stop its parent");
});

test("recovery interrupts unsettled runs across the whole tree", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "secretary-nested-recover-"));
  const db = new DatabaseSync(":memory:");
  const repository = new AgentRepository(db);
  t.after(async () => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const ctx = { cwd: root, mode: "tui" } as ExtensionContext;
  const first = new AgentService({ parentId: "main", root, ctx, config, repository,
    runner: async () => { let resolve!: (v: Awaited<RunningChild["result"]>) => void; const result = new Promise<Awaited<RunningChild["result"]>>(r => { resolve = r; });
      return { result, steer: async () => {}, abort: async () => { resolve({ status: "cancelled", output: "" }); }, dispose: async () => {} }; } });
  const a = await first.launch({ launchKey: "a", definition: { name: "worker", description: "w", prompt: "p", source: "test", hash: "h", resumable: true },
    model: "test/model", tools: ["read"], prompt: "p", description: "a", background: true });
  // A nested run whose owning child session died without settling (process exit).
  repository.putAgent({ agentId: "agent_b", parentId: "session-a", parentAgentId: a.agent.agentId, depth: 2,
    definition: a.agent.definition, model: "test/model", tools: ["read"], cwd: root, configCwd: root, resumable: true, createdAt: 0 });
  repository.putRun({ runId: "run_b", agentId: "agent_b", parentId: "session-a", launchKey: "b", prompt: "p", description: "b",
    status: "running", background: true, createdAt: 0, outputPath: join(root, "b.out"), output: "", toolCount: 0, turnCount: 0, revision: 0 });
  // The crashed owner never shuts down; recovery alone settles its tree's bookkeeping.
  const recovered = new AgentService({ parentId: "main", root, ctx, config, repository });
  await recovered.recover();
  assert.equal(recovered.run(a.run!.runId).status, "interrupted");
  assert.equal(recovered.run("run_b").status, "interrupted", "the orphaned nested run is interrupted by tree recovery");
});

test("launches at the maximum nesting depth fail with an actionable error", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "secretary-nested-depth-"));
  const db = new DatabaseSync(":memory:");
  t.after(async () => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const service = new AgentService({ parentId: "deep", root, ctx: { cwd: root, mode: "tui" } as ExtensionContext,
    config, repository: new AgentRepository(db), depth: 3 });
  await assert.rejects(service.launch({ launchKey: "x", definition: { name: "w", description: "w", prompt: "p", source: "test", hash: "h", resumable: true },
    model: "test/model", tools: ["read"], prompt: "p", description: "d", background: true }), /maximum depth/);
});
