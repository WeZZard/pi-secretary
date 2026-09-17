import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadAgentConfiguration } from "../../extensions/secretary/agents/configuration.ts";
import { discoverAgents, resolveAgentModel } from "../../extensions/secretary/agents/registry.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "secretary-agents-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), agentDir = join(root, "user");
  function put(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
  return { cwd, agentDir, put };
}

test("configuration defaults, trusted overlay, and nonmutation", (t) => {
  const { cwd, agentDir, put } = fixture(t);
  assert.deepEqual(loadAgentConfiguration(cwd, agentDir, false), { modelAliases: {}, maxConcurrent: 4, maxQueued: 16, shutdownTimeoutMs: 5000 });
  const global = join(agentDir, "secretary.json"), project = join(cwd, CONFIG_DIR_NAME, "secretary.json");
  const content = JSON.stringify({ unrelated: true, agents: { modelAliases: { sonnet: "p/one", haiku: "p/two" }, maxConcurrent: 2 } });
  put(global, content);
  put(project, JSON.stringify({ agents: { modelAliases: { sonnet: "q/three" }, maxQueued: 0 } }));
  assert.equal(loadAgentConfiguration(cwd, agentDir, false).modelAliases.sonnet, "p/one");
  const resolved = loadAgentConfiguration(cwd, agentDir, true);
  assert.deepEqual(resolved.modelAliases, { sonnet: "q/three", haiku: "p/two" });
  assert.equal(resolved.maxQueued, 0);
  resolved.modelAliases.haiku = "mutated/value";
  assert.equal(readFileSync(global, "utf8"), content);
  assert.equal(loadAgentConfiguration(cwd, agentDir, true).modelAliases.haiku, "p/two");
  put(project, "invalid JSON");
  assert.doesNotThrow(() => loadAgentConfiguration(cwd, agentDir, false));
  assert.throws(() => loadAgentConfiguration(cwd, agentDir, true));
});

test("configuration rejects unsupported fields and invalid values", (t) => {
  const { cwd, agentDir, put } = fixture(t);
  for (const agents of [null, [], { extra: 1 }, { maxConcurrent: 0 }, { maxQueued: -1 }, { shutdownTimeoutMs: 1.2 }, { modelAliases: null }, { modelAliases: { unknown: "p/id" } }, { modelAliases: { sonnet: "inherit" } }]) {
    put(join(agentDir, "secretary.json"), JSON.stringify({ agents }));
    assert.throws(() => loadAgentConfiguration(cwd, agentDir, false));
  }
});

test("discovery precedence, capabilities, and stable independent snapshots", (t) => {
  const { cwd, agentDir, put } = fixture(t);
  const packaged = discoverAgents(cwd, agentDir, false);
  assert.deepEqual([...packaged.keys()], ["general-purpose", "Explore", "Plan"]);
  assert.equal(packaged.get("Explore")!.resumable, false);
  assert.deepEqual(packaged.get("Plan")!.tools, ["read", "grep", "find", "ls"]);
  const user = "---\nname: Explore\ndescription: User\ntools: [read, grep]\ndisallowedTools: bash, write\nmodel: inherit\nmaxTurns: 2\nbackground: true\nisolation: worktree\n---\nUser prompt";
  put(join(agentDir, "agents", "explore.md"), user);
  put(join(cwd, CONFIG_DIR_NAME, "agents", "override.md"), "---\nname: Explore\ndescription: Project\n---\nProject prompt");
  const old = discoverAgents(cwd, agentDir, false).get("Explore")!;
  assert.equal(old.resumable, true);
  assert.deepEqual(old.disallowedTools, ["bash", "write"]);
  assert.match(old.hash, /^[a-f0-9]{64}$/);
  assert.equal(discoverAgents(cwd, agentDir, true).get("Explore")!.description, "Project");
  put(join(agentDir, "agents", "explore.md"), user + " changed");
  assert.notEqual(discoverAgents(cwd, agentDir, false).get("Explore")!.hash, old.hash);
  assert.equal(old.prompt, "User prompt");
});

test("discovery rejects duplicate names, bad YAML, unsupported behaviors", (t) => {
  const { cwd, agentDir, put } = fixture(t);
  const path = join(agentDir, "agents", "one.md");
  for (const extra of ["hooks: {}", "isolation: remote", "maxTurns: 0", "background: yes", "model: fuzzy", "tools: [read, 2]", "name: duplicate"]) {
    put(path, `---\nname: Custom\ndescription: Test\n${extra}\n---\nPrompt`);
    assert.throws(() => discoverAgents(cwd, agentDir, false));
  }
  put(path, "---\nname: Custom\ndescription: Test\n---\nPrompt");
  put(join(agentDir, "agents", "two.md"), readFileSync(path, "utf8"));
  assert.throws(() => discoverAgents(cwd, agentDir, false), /duplicate agent/);
});

test("model resolution uses exact registry IDs, aliases, scope and authentication", async (t) => {
  const { cwd, agentDir } = fixture(t);
  const definition = discoverAgents(cwd, agentDir, false).get("general-purpose")!;
  const config = loadAgentConfiguration(cwd, agentDir, false);
  const model = { provider: "provider", id: "org/model" } as Model<Api>;
  let authOK = true;
  const ctx = { model, scopedModels: [], modelRegistry: {
    find(provider: string, id: string) { return provider === model.provider && id === model.id ? model : undefined; },
    async getApiKeyAndHeaders() { return authOK ? { ok: true } : { ok: false, error: "missing credentials" }; },
  } } as unknown as Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels">;
  assert.equal(await resolveAgentModel(definition, undefined, config, ctx), model);
  await assert.rejects(resolveAgentModel(definition, "sonnet", config, ctx), /modelAliases.sonnet/);
  config.modelAliases.sonnet = "provider/org/model";
  assert.equal(await resolveAgentModel({ ...definition, model: "unavailable/model" }, "sonnet", config, ctx), model);
  assert.equal(await resolveAgentModel({ ...definition, model: "sonnet" }, undefined, config, ctx), model);
  await assert.rejects(resolveAgentModel({ ...definition, model: "provider/model" }, undefined, config, ctx), /unavailable/);
  await assert.rejects(resolveAgentModel(definition, undefined, config, { ...ctx, scopedModels: [{ model: { ...model, id: "different" } }] }), /scoped/);
  authOK = false;
  await assert.rejects(resolveAgentModel(definition, undefined, config, ctx), /Authentication/);
  await assert.rejects(resolveAgentModel(definition, undefined, config, { ...ctx, model: undefined }), /parent model/);
});
