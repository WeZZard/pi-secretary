import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { agentHarness } from "../support/agent-harness.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { Inspector } from "../../extensions/secretary/agents/ui/inspector.ts";
import { initialState } from "../../extensions/secretary/agents/ui/state.ts";
import type { UsageRecord } from "../../extensions/secretary/agents/records.ts";
import { deferred, tick } from "./support.ts";

export interface Reply {
  text?: string;
  input?: number;
  cached?: number;
  output?: number;
  tool?: { name: string; arguments: Record<string, unknown> };
  gate?: ReturnType<typeof deferred<void>>;
}

export async function configurationHarness(t: TestContext) {
  const h = await agentHarness(t, { mode: "rpc" });
  let idle = false;
  h.ctx.isIdle = () => idle;
  const models = ["parent-model", "reviewer-model", "different-model"].map(id => ({ ...h.ctx.model, provider: "test-provider", id, name: id })) as Model<"openai-completions">[];
  const replies: Reply[] = [];
  const calls: Array<{ model: string; context: Context }> = [];
  h.ctx.modelRegistry.registerProvider("test-provider", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/never", apiKey: "fixture-only", models,
    streamSimple(model: Model<"openai-completions">, context: Context, options: any) {
      calls.push({ model: `${model.provider}/${model.id}`, context: { ...context, messages: structuredClone(context.messages), tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) } });
      const reply = replies.shift() ?? {};
      const stream = createAssistantMessageEventStream();
      const release = () => reply.gate?.resolve();
      options?.signal?.addEventListener("abort", release, { once: true });
      void (async () => {
        try {
          if (options?.signal?.aborted) release();
          await reply.gate?.promise;
          const content: AssistantMessage["content"] = [{ type: "text", text: reply.text ?? "Historical child evidence." }];
          if (reply.tool) content.push({ type: "toolCall", id: `call-${calls.length}`, ...reply.tool });
          const input = reply.input ?? 100, cached = reply.cached ?? 40, output = reply.output ?? 20;
          const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
            timestamp: Date.now(), content, stopReason: reply.tool ? "toolUse" : "stop",
            usage: { input, cacheRead: cached, cacheWrite: 0, output, totalTokens: input + output,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: "done", reason: reply.tool ? "toolUse" : "stop", message });
          stream.end();
        } finally { options?.signal?.removeEventListener("abort", release); }
      })();
      return stream;
    },
  });
  h.ctx.model = models[0];
  const repository = new AgentRepository(h.engine.db.connection);
  const put = async (path: string, text: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  const definition = async (name: string, fields = "", scope: "user" | "project" = "user", prompt = "Review the explicit task.") => {
    const path = join(scope === "user" ? join(h.root, "agent") : join(h.root, CONFIG_DIR_NAME), "agents", `${name}.md`);
    await put(path, `---\nname: ${name}\ndescription: ${scope} ${name}\n${fields}\n---\n${prompt}`);
    return path;
  };
  const inspector = (agentId: string) => {
    const state = initialState();
    state.snapshots = [{ agent: repository.getAgent(agentId)!, run: repository.runs("parent").filter(r => r.agentId === agentId).at(-1) }];
    state.navigation = { kind: "inspector", detail: { kind: "loading", agentId, requestId: "inspection" } };
    return new Inspector(() => state, () => {}, () => "inspection", () => 40).render(400).join("\n");
  };
  const usage = () => h.engine.db.connection.prepare("SELECT json FROM secretary_agent_usage ORDER BY rowid").all().map(row => JSON.parse(String(row.json)) as UsageRecord);
  const begin = async (text = "Delegate the explicit task") => {
    await h.emit("input", { text, source: "interactive" });
    await h.emit("before_agent_start", { prompt: text });
    const message = { role: "user", content: text, timestamp: Date.now() };
    await h.emit("message_start", { message });
    await h.emit("turn_start");
    await h.emit("context", { messages: [message] });
    return message;
  };
  const goal = async (budget = 1000) => {
    const record = h.engine.service.createGoal("parent", "Originating objective", budget, "user").goal!;
    await begin();
    return record;
  };
  const finish = async (runId: string) => {
    const result = await h.tool("TaskOutput", { task_id: runId, timeout: 10000 });
    assert.ok(["succeeded", "partial", "failed", "cancelled"].includes(result.details.status), `Child did not settle: ${result.details.status}`);
    return result;
  };
  return { ...h, repository, put, definition, inspector, usage, begin, goal, finish, models, calls, replies,
    setIdle: (value: boolean) => { idle = value; },
    userDir: join(h.root, "agent"),
    launch: (args: Record<string, unknown> = {}) => h.tool("Agent", { description: "Acceptance task", prompt: "Inspect the fixture", ...args }),
  };
}

export async function eventually(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate(), message);
}
