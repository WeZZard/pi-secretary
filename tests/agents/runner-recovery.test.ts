import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChildRunner } from "../../extensions/secretary/agents/runner.ts";
import type { AgentRecord, AgentRun, RunnerHooks, RunningChild } from "../../extensions/secretary/agents/records.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type Response = "overflow" | "transient" | "summary" | "recovered";
async function fixture(t: TestContext, responses: Response[], holdSummary = false) {
  const root = await mkdtemp(join(tmpdir(), "secretary-recovery-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let child: RunningChild | undefined;
  t.after(async () => {
    await child?.dispose();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "agent"));
  await mkdir(join(root, "sessions"));
  await writeFile(join(root, "agent", "auth.json"), "NOT JSON");
  await writeFile(join(root, "agent", "settings.json"), JSON.stringify({
    compaction: { enabled: true, keepRecentTokens: 256, reserveTokens: 1024 },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  }));
  const model: Model<"openai-completions"> = {
    id: "recovery", name: "Recovery test", provider: "child-recovery-test", api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/never", reasoning: false, input: ["text"], contextWindow: 128000,
    maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const message = (text: string, index: number): AssistantMessage => ({
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text }], stopReason: "stop", timestamp: index,
    usage: { input: 10 + index, output: 4 + index, cacheRead: 3, cacheWrite: 2,
      totalTokens: 19 + 2 * index, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const seed = SessionManager.create(root, join(root, "sessions"));
  seed.appendModelChange(model.provider, model.id);
  seed.appendMessage({ role: "user", content: "Earlier context. ".repeat(2000), timestamp: 1 });
  seed.appendMessage(message("Earlier answer.", 0));
  seed.appendMessage({ role: "user", content: "Recent context. ".repeat(2000), timestamp: 2 });
  seed.appendMessage(message("Recent answer.", 0));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "store.json"), refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const calls: Array<{ response: Response; context: Context; message: AssistantMessage }> = [];
  const summaryStarted = deferred();
  const summaryAborted = deferred();
  registry.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fake", models: [model],
    streamSimple(_model, context, options) {
      const response = responses[calls.length];
      assert.ok(response, "Unexpected provider request after scripted recovery");
      const result = message(response === "summary" ? "Recovery summary sentinel." : response, calls.length + 1);
      if (response === "overflow" || response === "transient") {
        result.stopReason = "error";
        result.errorMessage = response === "overflow" ? "This model's maximum context length is 1000 tokens" : "503 service unavailable";
      }
      calls.push({ response, context: { ...context, messages: structuredClone(context.messages) }, message: result });
      const stream = createAssistantMessageEventStream();
      const emit = () => {
        if (options?.signal?.aborted) result.stopReason = "aborted";
        if (result.stopReason === "aborted" || result.stopReason === "error") stream.push({ type: "error", reason: result.stopReason, error: result });
        else stream.push({ type: "done", reason: "stop", message: result });
        stream.end();
      };
      if (response === "summary" && holdSummary) {
        assert.ok(options?.signal, "Compaction must supply an abort signal");
        const abort = () => { summaryAborted.resolve(); emit(); };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
        summaryStarted.resolve();
      } else emit();
      return stream;
    },
  });
  const agent: AgentRecord = { agentId: "a", parentId: "parent", definition: {
    name: "test", description: "test", prompt: "Recover the explicit task.", source: "test", hash: "h", resumable: true },
    model: `${model.provider}/${model.id}`, tools: [], cwd: root, configCwd: root, resumable: true,
    sessionPath: seed.getSessionFile()!, createdAt: 1 };
  const run: AgentRun = { runId: "recovery-run", agentId: "a", parentId: "parent", launchKey: "k",
    prompt: "Current recovery task sentinel.", description: "recovery", status: "starting", background: false,
    createdAt: 1, outputPath: join(root, "output"), output: "", toolCount: 0, turnCount: 0, revision: 0 };
  const usage: Array<{ id: string; value: Parameters<RunnerHooks["usage"]>[1] }> = [];
  let path = "";
  const hooks: RunnerHooks = { session(value) { path = value; }, text() {}, activity() {}, turn() {},
    usage(id, value) { usage.push({ id, value }); }, assertRunning() {} };
  const controller = new AbortController();
  child = await createChildRunner({ agent, run, ctx: { modelRegistry: registry, model, scopedModels: [],
    isProjectTrusted: () => true } as unknown as ExtensionContext, signal: controller.signal, hooks,
    sessionDir: join(root, "sessions") });
  return { child, calls, usage, controller, summaryStarted, summaryAborted,
    entries: () => SessionManager.open(path).getEntries() };
}

function assertUsageValues(f: Awaited<ReturnType<typeof fixture>>, calls = f.calls) {
  assert.deepEqual(f.usage.map(({ value }) => value), calls.map(({ message: { usage } }) => ({
    inputTokens: usage.input, cachedInputTokens: usage.cacheRead, cacheWriteInputTokens: usage.cacheWrite,
    outputTokens: usage.output, reasoningOutputTokens: 0, totalTokens: usage.totalTokens,
  })));
  assert.equal(new Set(f.usage.map(({ id }) => id)).size, f.usage.length, "Usage must be emitted once per source");
}

function assertUsageSources(f: Awaited<ReturnType<typeof fixture>>) {
  const entries = f.entries();
  assert.equal(new Set(f.usage.map(({ id }) => id)).size, f.usage.length, "Usage source IDs must not collide");
  for (const event of f.usage) {
    const [, kind, id] = event.id.split(":");
    const entry = entries.find((entry) => entry.id === id);
    assert.ok(entry, `Usage must reference a persisted source: ${event.id}`);
    assert.equal(entry.type, kind);
    const usage = entry.type === "compaction" ? entry.usage
      : entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage : undefined;
    assert.ok(usage, `Usage source ${event.id} points to ${entry.type === "message" ? entry.message.role : entry.type}, not its assistant/compaction source`);
    assert.deepEqual(event.value, { inputTokens: usage.input, cachedInputTokens: usage.cacheRead,
      cacheWriteInputTokens: usage.cacheWrite, outputTokens: usage.output, reasoningOutputTokens: 0,
      totalTokens: usage.totalTokens });
  }
}

test("child automatically compacts context overflow and accounts summary plus recovered response once", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, ["overflow", "summary", "recovered"]);
  assert.deepEqual(await f.child.result, { status: "succeeded", output: "recovered" });
  assert.deepEqual(f.calls.map(({ response }) => response), ["overflow", "summary", "recovered"]);
  assert.match(JSON.stringify(f.calls[2]!.context.messages), /Recovery summary sentinel/);
  assert.match(JSON.stringify(f.calls[2]!.context.messages), /Current recovery task sentinel/);
  assert.equal(f.entries().filter((entry) => entry.type === "compaction").length, 1);
  assert.deepEqual(f.usage.map(({ id }) => id.split(":")[1]), ["message", "compaction", "message"]);
  assertUsageValues(f);
  const snapshot = structuredClone(f.usage);
  await f.child.abort();
  await f.child.dispose();
  await f.child.dispose();
  assert.deepEqual(f.usage, snapshot, "Settlement and repeated disposal must not replay usage");
});

test("child waits for automatic transient-error retry and retains both usage sources", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, ["transient", "recovered"]);
  assert.deepEqual(await f.child.result, { status: "succeeded", output: "recovered" });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.usage.map(({ id }) => id.split(":")[1]), ["message", "message"]);
  assertUsageValues(f);
});

test("recovery usage identities reference their actual persisted assistant and compaction entries", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, ["overflow", "summary", "recovered"]);
  assert.equal((await f.child.result).status, "succeeded");
  assertUsageSources(f);
});

for (const cancellation of ["abort", "parent signal"] as const) {
  test(`child cancellation by ${cancellation} during automatic compaction prevents recovery dispatch`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t, ["overflow", "summary", "recovered"], true);
    await f.summaryStarted.promise;
    if (cancellation === "abort") await f.child.abort();
    else f.controller.abort();
    await f.summaryAborted.promise;
    assert.equal((await f.child.result).status, "cancelled");
    assert.deepEqual(f.calls.map(({ response }) => response), ["overflow", "summary"]);
    assert.equal(f.entries().filter((entry) => entry.type === "compaction").length, 0);
    assert.deepEqual(f.usage.map(({ id }) => id.split(":")[1]), ["message"]);
    assertUsageValues(f, f.calls.slice(0, 1));
    await assert.rejects(f.child.steer("No late recovery"), /no longer/);
  });
}
