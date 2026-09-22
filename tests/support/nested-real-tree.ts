import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentService, type LaunchSpec } from "../../extensions/secretary/agents/service.ts";
import { defaultAgentUi, type AgentConfiguration } from "../../extensions/secretary/agents/configuration.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { registerLiveChildService } from "../../extensions/secretary/agents/live-services.ts";
import type { AgentRecord, AgentRun, RunningChild } from "../../extensions/secretary/agents/records.ts";
import type { AgentUIPort } from "../../extensions/secretary/agents/ui/effects.ts";

/**
 * Real nested-delegation tree for the failing reproducers in this audit. It composes the
 * production AgentService, repository, live child-session registry, and filesystem session
 * files. Only the language-model transport is deterministic; every component under suspicion
 * (service, storage, tree aggregation, UI port) is the real implementation.
 */
export const nestedConfig: AgentConfiguration = {
  modelFallbackLists: {}, ui: defaultAgentUi(), maxConcurrent: 4, maxQueued: 8, shutdownTimeoutMs: 1000, maxNestingDepth: 3,
};

/** Flush microtasks and pending setImmediate continuations deterministically. */
export const settle = async (times = 8) => { for (let i = 0; i < times; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

type Runner = NonNullable<ConstructorParameters<typeof AgentService>[0]["runner"]>;
export interface NestedRealTree {
  service: AgentService;
  repository: AgentRepository;
  uiPort: AgentUIPort;
  childServices: Map<string, AgentService>;
  /** Settle a launched run as succeeded with output, through the real repository. */
  finish(runId: string, output?: string): void;
  spec(key: string, definition: string, name?: string): LaunchSpec;
  a: { agent: AgentRecord; run?: AgentRun };
  b: { agent: AgentRecord; run?: AgentRun };
  c: { agent: AgentRecord; run?: AgentRun };
  /** Present only when the tree was built with a third level. */
  d?: { agent: AgentRecord; run?: AgentRun };
}

export async function nestedRealTree(t: TestContext, options: { grandchild?: boolean } = {}): Promise<NestedRealTree> {
  const root = mkdtempSync(join(tmpdir(), "secretary-nested-repro-"));
  const db = new DatabaseSync(":memory:");
  const repository = new AgentRepository(db);
  const ctx = { cwd: root, mode: "tui" } as ExtensionContext;
  const childServices = new Map<string, AgentService>();
  const finishers = new Map<string, (output?: string) => void>();

  const runner: Runner = async options => {
    const sessionPath = join(root, `${options.agent.agentId}.jsonl`);
    const nestedText = options.agent.name?.startsWith("nested")
      ? `NESTED_TRANSCRIPT_${(options.agent.name ?? options.agent.agentId).toUpperCase()}` : undefined;
    writeFileSync(sessionPath, '{"type":"session"}\n' + (nestedText
      ? `${JSON.stringify({ type: "message", id: `entry-${options.agent.agentId}`,
          message: { role: "assistant", content: [{ type: "text", text: nestedText }] } })}\n` : ""));
    options.hooks.session(sessionPath);
    let resolve!: (value: Awaited<RunningChild["result"]>) => void;
    const result = new Promise<Awaited<RunningChild["result"]>>(r => { resolve = r; });
    finishers.set(options.run.runId, (output = "done") => resolve({ status: "succeeded", output }));
    if (options.agent.definition.name === "delegator") {
      // The delegated agent's session installs its own agent support, exactly as production does.
      const child = new AgentService({ parentId: `session-${options.agent.agentId}`,
        root: join(root, `child-${options.agent.agentId}`), ctx, config: nestedConfig,
        repository, depth: options.agent.depth, runner });
      const unregister = registerLiveChildService(options.agent.agentId, child);
      childServices.set(options.agent.agentId, child);
      return { result, steer: async () => {},
        abort: async () => { await child.shutdown(); unregister(); resolve({ status: "cancelled", output: "" }); },
        dispose: async () => { await child.shutdown(); unregister(); } };
    }
    return { result, steer: async () => {},
      abort: async () => { resolve({ status: "cancelled", output: "" }); }, dispose: async () => {} };
  };

  const service = new AgentService({ parentId: "p", root, ctx, config: nestedConfig, repository, runner });
  t.after(async () => {
    for (const child of childServices.values()) await child.shutdown().catch(() => {});
    await service.shutdown().catch(() => {});
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  const spec = (key: string, definition: string, name?: string): LaunchSpec => ({ launchKey: key,
    ...(name !== undefined ? { name } : {}),
    definition: { name: definition, description: definition, prompt: "Work", source: "test", hash: "hash", resumable: true },
    model: "test/model", tools: ["read"], prompt: "Do the task", description: `Task ${key}`, background: true });

  const uiPort: AgentUIPort = {
    list: () => service.tree(),
    viewModels: () => service.treeViewModels(),
    subscribe: listener => service.subscribe(listener),
    transcript: id => service.transcript(id),
    message: (id, text, operationId) => service.message(id, text, operationId),
    stop: (id, operationId) => service.stop(id, operationId),
    cleanup: (id, operationId) => service.cleanup(id, operationId),
    receipt: id => service.receipt(id) ? { outcome: "accepted", message: "Operation acceptance is recorded." } : undefined,
  };

  const a = await service.launch(spec("a", "delegator", "delegator"));
  await settle();
  const child = childServices.get(a.agent.agentId);
  assert.ok(child, "the delegating agent's session must register a live child service");
  const b = await child.launch({ ...spec("b", options.grandchild ? "delegator" : "nested-worker", "nested-b"), parentAgentId: a.agent.agentId });
  const c = await child.launch({ ...spec("c", "nested-worker", "nested-c"), parentAgentId: a.agent.agentId });
  await settle();
  let d: { agent: AgentRecord; run?: AgentRun } | undefined;
  if (options.grandchild) {
    const grandchildSession = childServices.get(b.agent.agentId);
    assert.ok(grandchildSession, "a nested delegating agent must register a live child service");
    d = await grandchildSession.launch({ ...spec("d", "nested-worker", "nested-d"), parentAgentId: b.agent.agentId });
    await settle();
  }
  return { service, repository, uiPort, childServices,
    finish: (runId, output) => finishers.get(runId)?.(output), spec, a, b, c, ...(d ? { d } : {}) };
}
