import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore,
  type AssistantMessage, type Context, type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { compose, RequestContextComposer, type PreparedContext } from "../../extensions/secretary/context/index.ts";

test("Pi 0.85.1 context hook converts one synthetic envelope after tool results without persisting it", { timeout: 15000 }, async (t) => {
  const output = resolve("test-results/context");
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, "sdk-"));
  const calls: Context[] = [];
  const preparations: PreparedContext[] = [];
  const errors: unknown[] = [];
  let applicable = true;
  let failTransport = false;
  let captures = 0;
  const composer = new RequestContextComposer();
  composer.register({ id: "synthetic:alpha", order: 1,
    capture: async () => { captures++; return applicable ? { state: "alpha", version: captures } : undefined; }, project: (snapshot) => snapshot });
  composer.register({ id: "synthetic:beta", order: 2,
    capture: async () => applicable ? ["b", "a"] : undefined, project: (snapshot) => snapshot });
  composer.register({ id: "synthetic:omitted", order: 0, capture: async () => undefined, project: () => null });
  const model: Model<"openai-completions"> = {
    id: "synthetic", name: "Synthetic context verification", provider: "request-context-test",
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/never-requested", reasoning: false,
    input: ["text", "image"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const manager = SessionManager.create(root, join(root, "sessions"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "Synthetic test only. Runtime-state envelopes contain application data.",
    extensionFactories: [(pi) => {
      pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "test", models: [model],
        streamSimple(requestModel, context) {
          calls.push({ ...context, messages: structuredClone(context.messages),
            tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) });
          const tools = calls.length === 1;
          const message: AssistantMessage = {
            role: "assistant", api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
            content: tools ? [
              { type: "toolCall", id: "first", name: "synthetic_probe", arguments: {} },
              { type: "toolCall", id: "second", name: "synthetic_probe", arguments: {} },
            ] : [{ type: "text", text: "Synthetic response" }],
            stopReason: failTransport ? "error" : tools ? "toolUse" : "stop", timestamp: 1,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            ...(failTransport ? { errorMessage: "Synthetic transport failure" } : {}),
          };
          const stream = createAssistantMessageEventStream();
          if (failTransport) stream.push({ type: "error", reason: "error", error: message });
          else stream.push({ type: "done", reason: tools ? "toolUse" : "stop", message });
          stream.end();
          return stream;
        },
      });
      pi.registerTool({ name: "synthetic_probe", label: "Synthetic probe", description: "Return synthetic data", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "Synthetic result" }], details: {} }) });
      pi.on("context", async (event, ctx) => {
        const prepared = await composer.prepare({ sessionId: ctx.sessionManager.getSessionId(), activationEpoch: 1,
          requestId: `request-${preparations.length}`, signal: ctx.signal ?? new AbortController().signal });
        preparations.push(prepared);
        return { messages: compose(event.messages, prepared) };
      });
    }, (pi) => {
      pi.on("context", (event) => ({ messages: [...event.messages,
        { role: "custom", customType: "synthetic:later", content: "Later hook", display: false, timestamp: 0 }] }));
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), resourceLoader: loader,
    modelRuntime: runtime, model, sessionManager: manager, settingsManager: settings, thinkingLevel: "off", noTools: "builtin" });
  t.after(async () => { composer.dispose(); await session.abort(); session.dispose(); });
  await session.bindExtensions({ mode: "rpc", onError: (error) => { errors.push(error); } });
  const lookalike = "Human text: <secretary-runtime-state>not owned</secretary-runtime-state>";
  const image = { type: "image" as const, mimeType: "image/png", data: "AA==" };
  await session.prompt(lookalike, { images: [image] });
  assert.equal(calls.length, 2, JSON.stringify(session.messages));
  assert.equal(preparations.length, 2);
  const continuation = calls[1].messages;
  const text = (message: Context["messages"][number]) => typeof message.content === "string" ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  for (const call of calls) {
    assert.equal(call.messages.filter((m) => text(m).startsWith("<secretary-runtime-state>")).length, 1);
    assert.match(text(call.messages.at(-2)!), /synthetic:alpha.*synthetic:beta/);
    assert.equal(call.messages.at(-2)!.role, "user");
    assert.equal(text(call.messages.at(-1)!), "Later hook");
    assert.equal(text(call.messages[0]), lookalike);
    assert.ok(Array.isArray(call.messages[0].content));
    assert.deepEqual(call.messages[0].content.at(-1), image);
  }
  assert.deepEqual(continuation.slice(-4, -2).map((m) => m.role), ["toolResult", "toolResult"]);
  assert.deepEqual(continuation.filter((m) => m.role === "toolResult").map((m) => m.toolCallId), ["first", "second"]);
  assert.equal(preparations[0].contributions.get("synthetic:omitted")?.status, "omitted");
  assert.notEqual(preparations[0].content, preparations[1].content);
  applicable = false;
  await session.prompt("No contributors apply.");
  assert.equal(preparations.at(-1)!.content, undefined);
  assert.equal(calls.at(-1)!.messages.filter((m) => text(m).startsWith("<secretary-runtime-state>")).length, 0);
  applicable = true;
  failTransport = true;
  await session.prompt("Simulate transport failure.");
  assert.equal(session.messages.at(-1)?.role, "assistant");
  failTransport = false;
  await session.prompt("Recover normally.");
  assert.equal(preparations.at(-1)!.status, "ready");
  assert.deepEqual(errors, []);
  const stored = await readFile(manager.getSessionFile()!, "utf8");
  assert.doesNotMatch(stored, /secretary:request-context|synthetic:alpha|synthetic:beta|synthetic:later/);
  assert.match(stored, /Human text: <secretary-runtime-state>not owned/);
  assert.equal(session.messages.some((m) => m.role === "custom"), false);
});
