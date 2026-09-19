import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadAgentConfiguration, saveModelFallbackLists } from "../../extensions/secretary/agents/configuration.ts";
import { ModelAvailability } from "../../extensions/secretary/agents/availability.ts";
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
  assert.deepEqual(loadAgentConfiguration(cwd, agentDir, false), { modelFallbackLists: {}, maxConcurrent: 4, maxQueued: 16, shutdownTimeoutMs: 5000, ui: { inlineToolDisplay: "rich", fleetViewPlacement: "belowEditor", asyncWidget: true, fleetKeybindings: {} } });
  const global = join(agentDir, "secretary.json"), project = join(cwd, CONFIG_DIR_NAME, "secretary.json");
  const content = JSON.stringify({ unrelated: true, agents: { modelFallbackLists: { fast: ["p/one", "p/two"], cheap: [] }, maxConcurrent: 2 } });
  put(global, content);
  put(project, JSON.stringify({ agents: { modelFallbackLists: { fast: ["q/three"] }, maxQueued: 0 } }));
  assert.deepEqual(loadAgentConfiguration(cwd, agentDir, false).modelFallbackLists.fast, ["p/one", "p/two"]);
  const resolved = loadAgentConfiguration(cwd, agentDir, true);
  assert.deepEqual(resolved.modelFallbackLists, { fast: ["q/three"], cheap: [] }, "A project list replaces the same-named global list entirely; sibling lists are retained");
  assert.equal(resolved.maxQueued, 0);
  (resolved.modelFallbackLists as Record<string, string[]>).cheap!.push("mutated/value");
  assert.equal(readFileSync(global, "utf8"), content);
  assert.deepEqual(loadAgentConfiguration(cwd, agentDir, true).modelFallbackLists.cheap, []);
  put(project, "invalid JSON");
  assert.doesNotThrow(() => loadAgentConfiguration(cwd, agentDir, false));
  assert.throws(() => loadAgentConfiguration(cwd, agentDir, true));
});

test("configuration rejects unsupported fields and invalid values", (t) => {
  const { cwd, agentDir, put } = fixture(t);
  for (const agents of [null, [], { extra: 1 }, { maxConcurrent: 0 }, { maxQueued: -1 }, { shutdownTimeoutMs: 1.2 }, { modelAliases: { sonnet: "p/id" } }, { modelFallbackLists: null }, { modelFallbackLists: [] }, { modelFallbackLists: { "bad name": ["p/id"] } }, { modelFallbackLists: { inherit: ["p/id"] } }, { modelFallbackLists: { fast: "p/id" } }, { modelFallbackLists: { fast: ["no-slash"] } }, { modelFallbackLists: { fast: ["p/id", "p/id"] } }, { modelFallbackLists: { fast: [42] } },
    { ui: null }, { ui: { unknown: true } }, { ui: { inlineToolDisplay: "fancy" } }, { ui: { fleetViewPlacement: "sidebar" } }, { ui: { asyncWidget: "yes" } },
    { ui: { fleetKeybindings: [] } }, { ui: { fleetKeybindings: { frobnicate: ["f"] } } }, { ui: { fleetKeybindings: { stop: [] } } }, { ui: { fleetKeybindings: { stop: [42] } } }]) {
    put(join(agentDir, "secretary.json"), JSON.stringify({ agents }));
    assert.throws(() => loadAgentConfiguration(cwd, agentDir, false));
  }
  put(join(agentDir, "secretary.json"), JSON.stringify({ agents: { modelAliases: { sonnet: "p/id" } } }));
  assert.throws(() => loadAgentConfiguration(cwd, agentDir, false), /modelFallbackLists/, "The removed key's error names the replacement");
  put(join(agentDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { empty: [] } } }));
  assert.deepEqual(loadAgentConfiguration(cwd, agentDir, false).modelFallbackLists, { empty: [] }, "An empty list is valid configuration");
});

test("ui configuration accepts documented values and project overrides merge over global", (t) => {
  const { cwd, agentDir, put } = fixture(t);
  const global = join(agentDir, "secretary.json"), project = join(cwd, CONFIG_DIR_NAME, "secretary.json");
  put(global, JSON.stringify({ agents: { ui: { inlineToolDisplay: "summary", asyncWidget: false, fleetKeybindings: { stop: ["shift+t"], close: ["ctrl+q"] } } } }));
  const base = loadAgentConfiguration(cwd, agentDir, false);
  assert.equal(base.ui.inlineToolDisplay, "summary");
  assert.equal(base.ui.asyncWidget, false);
  assert.equal(base.ui.fleetViewPlacement, "belowEditor");
  assert.deepEqual(base.ui.fleetKeybindings, { stop: ["shift+t"], close: ["ctrl+q"] });
  put(project, JSON.stringify({ agents: { ui: { fleetViewPlacement: "aboveEditor", fleetKeybindings: { stop: ["shift+w"] } } } }));
  const trusted = loadAgentConfiguration(cwd, agentDir, true);
  assert.equal(trusted.ui.inlineToolDisplay, "summary", "project omission inherits the global value");
  assert.equal(trusted.ui.fleetViewPlacement, "aboveEditor");
  assert.deepEqual(trusted.ui.fleetKeybindings, { stop: ["shift+w"], close: ["ctrl+q"] }, "action-level overrides merge; sibling actions are retained");
  const untrusted = loadAgentConfiguration(cwd, agentDir, false);
  assert.equal(untrusted.ui.fleetViewPlacement, "belowEditor", "untrusted project configuration is ignored");
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

for (const scope of ["user", "project"] as const) {
  test(`${scope} agent definitions can override general-purpose without a role prompt`, (t) => {
    const { cwd, agentDir, put } = fixture(t);
    const path = scope === "user" ? join(agentDir, "agents", "general-purpose.md")
      : join(cwd, CONFIG_DIR_NAME, "agents", "general-purpose.md");
    for (const suffix of ["", "\n", "\n\n  \t\n"]) {
      put(path, `---\nname: general-purpose\ndescription: General-purpose work without an extra role prompt.\nmodel: inherit\n---${suffix}`);
      const agent = discoverAgents(cwd, agentDir, scope === "project").get("general-purpose")!;
      assert.equal(agent.prompt, "");
      assert.equal(agent.source, path);
      assert.equal(agent.model, "inherit");
      assert.equal(agent.resumable, true);
    }
  });
}

test("discovery rejects duplicate names, bad YAML, unsupported behaviors", (t) => {
  const { cwd, agentDir, put } = fixture(t);
  const path = join(agentDir, "agents", "one.md");
  for (const extra of ["hooks: {}", "isolation: remote", "maxTurns: 0", "background: yes", "model: 42", "tools: [read, 2]", "name: duplicate"]) {
    put(path, `---\nname: Custom\ndescription: Test\n${extra}\n---\nPrompt`);
    assert.throws(() => discoverAgents(cwd, agentDir, false));
  }
  put(path, "---\nname: Custom\ndescription: Test\n---\nPrompt");
  put(join(agentDir, "agents", "two.md"), readFileSync(path, "utf8"));
  assert.throws(() => discoverAgents(cwd, agentDir, false), /duplicate agent/);
});

test("model resolution matches available models first, then fallback lists in order", async (t) => {
  const { cwd, agentDir } = fixture(t);
  const definition = discoverAgents(cwd, agentDir, false).get("general-purpose")!;
  const parent = { provider: "provider", id: "org/parent" } as Model<Api>;
  const listed = { provider: "provider", id: "org/listed" } as Model<Api>;
  const models = new Map<string, Model<Api>>([[`${parent.provider}/${parent.id}`, parent], [`${listed.provider}/${listed.id}`, listed]]);
  let authOK = true;
  const ctx = { model: parent, scopedModels: [], modelRegistry: {
    find(provider: string, id: string) { return models.get(`${provider}/${id}`); },
    async getApiKeyAndHeaders() { return authOK ? { ok: true } : { ok: false, error: "missing credentials" }; },
  } } as unknown as Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels">;
  const config = loadAgentConfiguration(cwd, agentDir, false);
  config.modelFallbackLists.fast = ["provider/org/missing", "provider/org/listed"];
  config.modelFallbackLists.scoped = ["provider/org/parent", "provider/org/listed"];
  assert.equal((await resolveAgentModel(definition, undefined, config, ctx)).id, "provider/org/parent", "Omission inherits the parent model");
  const exact = await resolveAgentModel({ ...definition, model: "provider/org/listed" }, undefined, config, ctx);
  assert.equal(exact.model, listed, "An exact identifier forms a single-candidate chain");
  assert.deepEqual(exact.skipped, []);
  const viaList = await resolveAgentModel({ ...definition, model: "fast" }, undefined, config, ctx);
  assert.equal(viaList.id, "provider/org/listed", "The list's members are tried in configured order");
  assert.deepEqual(viaList.chain, ["provider/org/missing", "provider/org/listed"]);
  assert.equal(viaList.skipped.length, 1);
  assert.match(viaList.skipped[0]!.reason, /unavailable/);
  assert.equal((await resolveAgentModel({ ...definition, model: "provider/org/parent" }, "fast", config, ctx)).id, "provider/org/listed", "An explicit invocation value wins over the definition");
  const scoped = { ...ctx, scopedModels: [{ model: listed }] } as unknown as typeof ctx;
  const viaScoped = await resolveAgentModel({ ...definition, model: "scoped" }, undefined, config, scoped);
  assert.equal(viaScoped.id, "provider/org/listed", "A scoped-out candidate is skipped, not fatal");
  assert.match(viaScoped.skipped[0]!.reason, /scoped/i);
  await assert.rejects(resolveAgentModel(definition, "absent", config, ctx), /Unknown model fallback list: absent/);
  config.modelFallbackLists.empty = [];
  await assert.rejects(resolveAgentModel(definition, "empty", config, ctx), /empty/);
  await assert.rejects(resolveAgentModel({ ...definition, model: "provider/absent" }, undefined, config, ctx), /provider\/absent/, "A slash value is never treated as a list name");
  authOK = false;
  await assert.rejects(resolveAgentModel({ ...definition, model: "scoped" }, undefined, config, ctx), /provider\/org\/parent[\s\S]*provider\/org\/listed/, "An all-failed chain lists each attempted model and its reason");
  authOK = true;
  const availability = new ModelAvailability();
  availability.record("provider/org/listed", Date.now() + 60000);
  config.modelFallbackLists.cached = ["provider/org/listed", "provider/org/parent"];
  const viaCache = await resolveAgentModel({ ...definition, model: "cached" }, undefined, config, ctx, availability);
  assert.equal(viaCache.id, "provider/org/parent", "A cooling-down candidate is skipped without a provider request");
  assert.match(viaCache.skipped[0]!.reason, /cooling/i);
  await assert.rejects(resolveAgentModel(definition, undefined, config, { ...ctx, model: undefined } as typeof ctx), /parent model/);
});

test("saveModelFallbackLists validates before writing, preserves other keys, and reloads", (t) => {
  const { agentDir, put } = fixture(t);
  const path = join(agentDir, "secretary.json");
  saveModelFallbackLists(agentDir, { fast: ["p/one", "p/two"], empty: [] });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { agents: { modelFallbackLists: { fast: ["p/one", "p/two"], empty: [] } } }, "A missing file is created");
  assert.deepEqual(loadAgentConfiguration(agentDir, agentDir, false).modelFallbackLists.fast, ["p/one", "p/two"], "Saved lists take effect on the next read");
  put(path, JSON.stringify({ unrelated: true, agents: { maxConcurrent: 2, modelFallbackLists: { old: ["q/three"] } } }));
  saveModelFallbackLists(agentDir, { fast: ["p/one"] });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { unrelated: true, agents: { maxConcurrent: 2, modelFallbackLists: { fast: ["p/one"] } } }, "Unrelated root keys and other agents fields are preserved");
  const before = readFileSync(path, "utf8");
  assert.throws(() => saveModelFallbackLists(agentDir, { "bad name": [] }), /modelFallbackLists/, "An invalid candidate is rejected before writing");
  assert.throws(() => saveModelFallbackLists(agentDir, { inherit: ["p/one"] }), /inherit/);
  assert.equal(readFileSync(path, "utf8"), before, "A rejected change leaves the previous configuration in effect");
  put(path, JSON.stringify({ agents: { modelAliases: { sonnet: "p/one" }, modelFallbackLists: {} } }));
  assert.throws(() => saveModelFallbackLists(agentDir, { fast: ["p/one"] }), /modelFallbackLists/, "A file with a removed key is reported rather than rewritten");
  assert.match(readFileSync(path, "utf8"), /modelAliases/, "The unreadable configuration is not rewritten");
});
