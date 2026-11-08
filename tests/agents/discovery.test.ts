import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { discoverySession } from "../support/discovery-session.ts";
import { agentHarness } from "../support/agent-harness.ts";

function envelope(context: Context) {
  const text = JSON.stringify(context.messages.at(-1));
  assert.match(text, /<secretary-runtime-state>/, "The first model request must expose the catalog without parent filesystem tools");
  const message = context.messages.at(-1)!;
  assert.equal(message.role, "user");
  const content = typeof message.content === "string" ? message.content : message.content.filter(b => b.type === "text").map(b => b.text).join("");
  return JSON.parse(content.slice("<secretary-runtime-state>".length, -"</secretary-runtime-state>".length));
}
function catalog(context: Context) {
  const value = envelope(context);
  assert.equal(value.status, "ready");
  return value.contributions.find((c: any) => c.id === "secretary.agent-catalog").data;
}
async function definition(directory: string, name: string, description: string, body = "Private child role instructions.") {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\ntools: [read]\n---\n${body}`);
}

test("SA-DISC-01: first real SDK request publishes the resolved catalog without filesystem tool calls or persisted reminders", async t => {
  const h = await discoverySession(t, { setup: async (root, dir) => {
    await definition(join(dir, "agents"), "custom", "User custom definition");
    await definition(join(dir, "agents"), "Explore", "User override");
    await definition(join(root, ".pi", "agents"), "Explore", "Trusted project override");
  } });
  await h.session.prompt("List the available delegation types.");
  assert.ok(h.parentCalls.length, JSON.stringify({ messages: h.session.messages, childCalls: h.childCalls }));
  const data = catalog(h.parentCalls[0]!);
  assert.equal(data.status, "ready");
  assert.deepEqual(data.definitions.map((d: any) => d.type), ["Explore", "Plan", "custom", "general-purpose"]);
  assert.equal(data.definitions[0].description, "Trusted project override");
  assert.doesNotMatch(JSON.stringify(data), /Private child role instructions|packaged:|\.md/);
  assert.equal(h.childCalls.length, 0);
  assert.equal(h.session.messages.filter(m => m.role === "toolResult").length, 0);
  assert.ok(!h.session.messages.some(m => m.role === "custom" && m.customType === "secretary:request-context"));
  const transcript = await readFile(h.session.sessionFile!, "utf8");
  assert.doesNotMatch(transcript, /<secretary-runtime-state>/);
});

test("SA-DISC-05: uncorrelated invocations and old branch bindings cannot launch", async t => {
  const h = await agentHarness(t); await h.start();
  const call = h.tools.get("Agent");
  const args = { description: "Fixture", prompt: "Read fixture" };
  await assert.rejects(call.execute("missing", args, undefined, undefined, h.ctx), /correlation/);
  await h.emit("context", { messages: [] });
  await h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "Agent", id: "old" }] } });
  await h.emit("session_tree", {});
  await assert.rejects(call.execute("old", args, undefined, undefined, h.ctx), /correlation/);
  assert.equal(h.calls.length, 0);
});

const launch = (id: string, type = "custom") => ({ type: "toolCall" as const, name: "Agent", id,
  arguments: { description: "Inspect fixture", prompt: "Return a read-only fixture result.", subagent_type: type, run_in_background: false, name: id } });

test("SA-DISC-02: real parallel launches use their generating catalog, then the next request sees the edit", async t => {
  let path = "";
  const h = await discoverySession(t, { setup: async (_root, dir) => {
    path = join(dir, "agents");
    await definition(path, "custom", "Original description", "ORIGINAL_ROLE");
  }, respond: async (_context, index) => {
    if (index === 0) {
      await definition(path, "custom", "Edited description", "EDITED_ROLE");
      return [launch("first"), launch("sibling")];
    }
    return [{ type: "text", text: "Observed results." }];
  } });
  await h.session.prompt("Delegate twice using the catalog.");
  const results = h.session.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent");
  assert.equal(results.length, 2);
  for (const result of results) { assert.ok(result.role === "toolResult"); assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.status, "succeeded"); }
  assert.equal(h.childCalls.length, 2);
  for (const call of h.childCalls) assert.match(call.systemPrompt ?? "", /ORIGINAL_ROLE/);
  assert.equal(catalog(h.parentCalls[0]!).definitions.find((d: any) => d.type === "custom").description, "Original description");
  assert.equal(catalog(h.parentCalls[1]!).definitions.find((d: any) => d.type === "custom").description, "Edited description");
  const continuation = h.parentCalls[1]!.messages;
  assert.equal(continuation.filter(m => m.role === "toolResult").length, 2);
  assert.ok(continuation.slice(0, -1).filter(m => m.role === "toolResult").length === 2, "The suffix follows all results and the existing instance projection");
});

test("SA-DISC-03: deleting a published definition does not reinterpret its pending launch", async t => {
  let path = "";
  const h = await discoverySession(t, { setup: async (_root, dir) => {
    path = join(dir, "agents"); await definition(path, "custom", "Will be removed");
  }, respond: async (_context, index) => {
    if (index === 0) { await unlink(join(path, "custom.md")); return [launch("removed")]; }
    return [{ type: "text", text: "Done." }];
  } });
  await h.session.prompt("Delegate before removal.");
  const result = h.session.messages.find(m => m.role === "toolResult" && m.toolName === "Agent");
  assert.ok(result?.role === "toolResult" && !result.isError, JSON.stringify(result));
  assert.ok(!catalog(h.parentCalls[1]!).definitions.some((d: any) => d.type === "custom"));
});

test("SA-DISC-05: malformed and oversized catalogs reject fresh calls and recover on the next request", async t => {
  let directory = "";
  const h = await discoverySession(t, { setup: async (_root, dir) => {
    directory = join(dir, "agents"); await mkdir(directory); await writeFile(join(directory, "custom.md"), "invalid source");
  }, respond: async (_context, index) => index % 2 === 0 ? [launch(`attempt-${index}`)] : [{ type: "text", text: "Done." }] });
  await h.session.prompt("Try invalid catalog.");
  assert.equal(catalog(h.parentCalls[0]!).status, "unavailable");
  assert.equal(h.childCalls.length, 0);
  await definition(directory, "custom", "x".repeat(34000));
  await h.session.prompt("Try oversized catalog.");
  assert.equal(envelope(h.parentCalls[2]!).errorCode, "overflow");
  assert.equal(h.childCalls.length, 0);
  await definition(directory, "custom", "Recovered");
  await h.session.prompt("Try corrected catalog.");
  assert.equal(h.childCalls.length, 1);
  const outcomes = h.session.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent");
  assert.deepEqual(outcomes.map(m => m.role === "toolResult" && m.isError), [true, true, false]);
});

test("SA-DISC-04: untrusted project definitions never enter the catalog", async t => {
  const h = await discoverySession(t, { trusted: false, setup: async (root, dir) => {
    await definition(join(dir, "agents"), "custom", "Global");
    await definition(join(root, ".pi", "agents"), "custom", "Untrusted replacement");
  } });
  await h.session.prompt("List types.");
  assert.equal(catalog(h.parentCalls[0]!).definitions.find((d: any) => d.type === "custom").description, "Global");
});

test("SA-DISC-03: fallback-list edits during generation do not change an issued launch", async t => {
  let configPath = "";
  const h = await discoverySession(t, { setup: async (_root, dir) => {
    await definition(join(dir, "agents"), "custom", "Fallback worker");
    configPath = join(dir, "secretary.json");
    await writeFile(configPath, JSON.stringify({ agents: { modelFallbackLists: { primary: ["discovery-test/fixture"] } } }));
  }, respond: async (_context, index) => {
    if (index === 0) {
      await writeFile(configPath, JSON.stringify({ agents: { modelFallbackLists: { primary: ["discovery-test/missing"] } } }));
      return [{ ...launch("fallback"), arguments: { ...launch("fallback").arguments, model: "primary" } }];
    }
    return [{ type: "text", text: "Done." }];
  } });
  await h.session.prompt("Delegate through primary.");
  const result = h.session.messages.find(m => m.role === "toolResult");
  assert.ok(result?.role === "toolResult" && !result.isError, JSON.stringify(result));
  assert.equal(h.childCalls.length, 1);
  assert.equal(Reflect.get(h.parentCalls[0]!.tools!.find(t => t.name === "Agent")!.parameters, "properties").model.enum, undefined);
});

test("SA-DISC-03: invalid startup configuration can recover without extension reload", async t => {
  let configPath = "";
  const h = await discoverySession(t, { setup: async (_root, dir) => {
    await definition(join(dir, "agents"), "custom", "Recoverable worker");
    configPath = join(dir, "secretary.json"); await writeFile(configPath, "{invalid");
  }, respond: async (_context, index) => index % 2 === 0 ? [launch(`startup-${index}`)] : [{ type: "text", text: "Done." }] });
  await h.session.prompt("Try invalid startup configuration.");
  assert.equal(catalog(h.parentCalls[0]!).status, "unavailable");
  assert.equal(h.childCalls.length, 0);
  await writeFile(configPath, "{}");
  await h.session.prompt("Try repaired configuration.");
  assert.equal(h.childCalls.length, 1);
});

test("SA-DISC-04: trust revocation after publication rejects the response's launch", async t => {
  const h = await discoverySession(t, { setup: async (_root, dir) => definition(join(dir, "agents"), "custom", "Worker"),
    respond: async (_context, index) => {
      if (index === 0) { h.session.settingsManager.setProjectTrusted(false); return [launch("revoked")]; }
      return [{ type: "text", text: "Done." }];
    } });
  await h.session.prompt("Delegate only if still trusted.");
  assert.equal(h.childCalls.length, 0);
  const result = h.session.messages.find(m => m.role === "toolResult");
  assert.ok(result?.role === "toolResult" && result.isError);
  assert.match(JSON.stringify(result.content), /trust changed/);
});

test("SA-DISC-04: aborting during model resolution cannot admit a background child", async t => {
  const h = await agentHarness(t, { mode: "tui" }); await h.start();
  const controller = new AbortController();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = h.ctx.modelRegistry.getApiKeyAndHeaders.bind(h.ctx.modelRegistry);
  h.ctx.modelRegistry.getApiKeyAndHeaders = async (...args: unknown[]) => { entered(); await gate; return original(...args); };
  await h.emit("context", { messages: [] });
  await h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "Agent", id: "abort-admission" }] } });
  const pending = h.tools.get("Agent").execute("abort-admission", { description: "Work", prompt: "Work", run_in_background: true }, controller.signal, undefined, h.ctx);
  const rejected = assert.rejects(pending, /abort/i);
  await started; controller.abort(); release(); await rejected;
  assert.equal(h.calls.length, 0);
  assert.deepEqual(new AgentRepository(h.engine.db.connection).agents("parent"), []);
});

test("incident-shaped SDK batch: ten read-only children complete without parent definition reads", async t => {
  const h = await discoverySession(t, { setup: async (_root, dir) => definition(join(dir, "agents"), "custom", "Ten workers"),
    respond: async (_context, index) => index === 0 ? Array.from({ length: 10 }, (_, i) => launch(`worker-${i}`)) : [{ type: "text", text: "All results observed." }] });
  await h.session.prompt("Delegate ten read-only tasks.");
  const results = h.session.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent");
  assert.equal(results.length, 10);
  const repo = new AgentRepository(h.engine.db.connection);
  for (const result of results) {
    assert.ok(result.role === "toolResult");
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.details.status, "succeeded");
    assert.deepEqual(repo.getAgent(result.details.agentId)?.tools, ["read"]);
  }
  assert.equal(h.childCalls.length, 10);
  assert.equal(h.session.messages.filter(m => m.role === "toolResult" && m.toolName !== "Agent").length, 0);
  assert.doesNotMatch(await readFile(h.session.sessionFile!, "utf8"), /<secretary-runtime-state>/);
});
