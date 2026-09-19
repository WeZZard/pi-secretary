import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentService } from "../../extensions/secretary/agents/service.ts";
import { defaultAgentUi } from "../../extensions/secretary/agents/configuration.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { deriveUsageLabels, formatUsageLabels, formatElapsed } from "../../extensions/secretary/agents/ui/usage-labels.ts";
import { goalTokenDeltaForUsage } from "../../extensions/secretary/goal/accounting.ts";
import type { UsageRecord } from "../../extensions/secretary/agents/records.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const usage = (input: number, output: number, cached = 0) => ({
  inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0,
  outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output,
});
const record = (id: string, runId: string, input: number, output: number, cached = 0): UsageRecord => ({ id, runId, usage: usage(input, output, cached) });

test("context-window label is the latest turn's input plus cache-read tokens", () => {
  const labels = deriveUsageLabels([record("e1", "r", 1000, 200, 300), record("e2", "r", 2400, 100, 1400)]);
  assert.equal(labels.windowTokens, 3800);
  assert.equal(labels.cumulativeTokens, 3700);
});

test("cumulative label accumulates input plus output across persisted events", () => {
  const labels = deriveUsageLabels([record("e1", "r", 1000, 500), record("e2", "r", 2000, 700), record("e3", "r", 0, 50)]);
  assert.equal(labels.cumulativeTokens, 4250);
});

test("unknown usage is omitted rather than displayed as zero", () => {
  assert.deepEqual(deriveUsageLabels([]), {});
  const missing = { id: "e", runId: "r", usage: {} as UsageRecord["usage"] };
  assert.deepEqual(deriveUsageLabels([missing]), {});
  const partial = deriveUsageLabels([{ id: "e", runId: "r", usage: { inputTokens: 900 } as UsageRecord["usage"] }]);
  assert.equal(partial.windowTokens, undefined, "a missing cache-read field omits the window label");
  assert.equal(partial.cumulativeTokens, 900);
  assert.deepEqual(formatUsageLabels({}), []);
  assert.deepEqual(formatUsageLabels({ windowTokens: 3800 }), ["↓ 3.8k window"]);
  assert.deepEqual(formatUsageLabels({ cumulativeTokens: 0 }), ["0 spent"]);
  assert.deepEqual(formatUsageLabels({ windowTokens: 1_200_000, cumulativeTokens: 4250 }), ["↓ 1.2M window", "4.3k spent"]);
});

test("widget labels are display quantities independent of the goal-budget formula", () => {
  // §11.2: max(input - cached, 0) + max(output, 0). The window label instead sums input + cache-read.
  const events = [record("e1", "r", 2000, 500, 1500)];
  const labels = deriveUsageLabels(events);
  assert.equal(labels.windowTokens, 3500);
  assert.equal(labels.cumulativeTokens, 2500);
  assert.equal(goalTokenDeltaForUsage(events[0]!.usage), 1000);
  assert.notEqual(labels.windowTokens, goalTokenDeltaForUsage(events[0]!.usage));
  assert.notEqual(labels.cumulativeTokens, goalTokenDeltaForUsage(events[0]!.usage));
});

test("elapsed rendering uses the injected clock and omits unavailable starts", () => {
  assert.equal(formatElapsed(undefined, 1000), undefined);
  assert.equal(formatElapsed(1000, 6500), "6s");
  assert.equal(formatElapsed(6500, 1000), "0s");
  assert.equal(formatElapsed(Number.NaN, 1000), undefined);
});

test("service view models carry row state and derived labels without widget-side computation", async t => {
  const root = mkdtempSync(join(tmpdir(), "view-models-"));
  const db = new DatabaseSync(":memory:");
  const repository = new AgentRepository(db);
  const service = new AgentService({ parentId: "p", root, repository,
    ctx: { cwd: root, mode: "tui" } as ExtensionContext,
    config: { modelFallbackLists: {}, ui: defaultAgentUi(), maxConcurrent: 1, maxQueued: 2, shutdownTimeoutMs: 100, maxNestingDepth: 3 },
    runner: async options => {
      options.hooks.session(join(root, "session.jsonl"));
      options.hooks.usage("u1", usage(1500, 250, 500));
      return { result: new Promise(() => {}), steer: async () => {}, abort: async () => {}, dispose: async () => {} };
    } });
  t.after(async () => { await service.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const definition = { name: "worker", description: "Test worker", prompt: "p", source: "packaged", hash: "h", resumable: true };
  const launched = await service.launch({ launchKey: "k1", definition, model: "test/model", tools: ["read"], prompt: "Do it", description: "View model check", background: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.run(launched.run!.runId).status, "running");
  const rows = service.viewModels();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.agentId, launched.agent.agentId);
  assert.equal(row.status, "running");
  assert.equal(row.description, "View model check");
  assert.equal(row.model, "test/model");
  assert.equal(row.background, true);
  assert.ok(typeof row.startedAt === "number");
  assert.equal(row.windowTokens, 2000);
  assert.equal(row.cumulativeTokens, 1750);
  // An agent with no run is idle with no usage labels.
  const idle = await service.launch({ launchKey: "k2", definition, model: "test/model", tools: ["read"], prompt: "Wait", description: "Queued behind", background: true });
  assert.equal(idle.run!.status, "queued");
  const idleRow = service.viewModels().find(r => r.agentId === idle.agent.agentId)!;
  assert.equal(idleRow.status, "queued");
  assert.equal(idleRow.windowTokens, undefined);
  assert.equal(idleRow.cumulativeTokens, undefined);
  // Usage events are queryable per run through the repository.
  assert.equal(repository.usage(launched.run!.runId).length, 1);
});
