import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createCleanPiEnvironment } from "../../environment/isolation.ts";
import { useGlobalLiteLLM } from "../../environment/global-litellm.ts";
import { useInstalledWidgetExtensions } from "../../environment/widget-extensions.ts";
import { startInteractivePi } from "../../environment/interactive-pi-process.ts";
import { messageText, readTranscript } from "../../environment/transcripts.ts";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtures = join(repository, "tests/e2e/fixtures/subagents");

test("interactive Pi parent spawns an isolated child with real provider and widget extensions", { timeout: 330000 }, async t => {
  const environment = createCleanPiEnvironment({ name: "subagent-spawn-tui", repositoryState: "committed",
    extensionUnderTest: join(repository, "extensions/secretary/index.ts"), projectFixture: join(fixtures, "project") });
  t.after(() => environment.dispose());
  const profile = useGlobalLiteLLM(environment);
  // Observe the child's UI contract before widget startup can fail. Do not change that contract.
  const observerEntry = join(repository, "tests/e2e/environment/ui-observer.ts");
  const settingsPath = join(environment.agentDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.extensions.push(observerEntry); environment.extensions.push(observerEntry);
  settings.enabledModels = [`${profile.provider}/${profile.model}`];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  const widgets = useInstalledWidgetExtensions(environment, profile.globalAgentDir, ["pi-recap", "@juicesharp/rpiv-todo"]);
  // UI extensions may make auxiliary model calls. Keep the real test model, but do not expose
  // unrelated models (in particular Claude routes requiring a different client) to those hooks.
  const catalogPath = join(environment.agentDir, "models-store.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  catalog[profile.provider].models = catalog[profile.provider].models.filter((model: { id: string }) => model.id === profile.model);
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  const overridesPath = join(environment.agentDir, "models.json");
  const overrides = JSON.parse(readFileSync(overridesPath, "utf8"));
  if (Array.isArray(overrides.providers?.[profile.provider]?.models)) {
    overrides.providers[profile.provider].models = overrides.providers[profile.provider].models.filter((model: { id: string }) => model.id === profile.model);
    writeFileSync(overridesPath, JSON.stringify(overrides, null, 2) + "\n");
  }
  environment.env.LITELLM_OFFLINE = "1"; // Disable discovery, not real inference.
  writeFileSync(join(environment.artifacts, "terminal-profile.json"), JSON.stringify({ frontend: "interactive TUI",
    inputTransport: "POSIX PTY", realModelRequests: true, visibleDesktopWindow: false,
    permittedCatalogModels: [`${profile.provider}/${profile.model}`], discoveryDisabled: true,
    widgetModelPreference: widgets.recap?.modelOverride, observer: observerEntry, humanReview: "not performed" }, null, 2) + "\n");
  const observer = join(environment.artifacts, "ui-lifecycle.jsonl");
  const prompt = readFileSync(join(fixtures, "spawn-isolated-prompt.txt"), "utf8").trim();
  const expected = readFileSync(join(fixtures, "project/fixture.txt"), "utf8").trim();
  assert.ok(!prompt.includes(expected), "The parent must not be given the fixture contents");
  const evidence: Record<string, unknown> = {};
  let passed = false, failure: string | undefined;
  const pi = startInteractivePi(environment, { prompt, model: `${profile.provider}/${profile.model}`,
    observer, timeoutMs: 180000, tools: ["read", "Agent"] });
  t.after(() => pi.stop());
  try {
    evidence.process = await pi.result;
    profile.redactArtifacts();
    if (existsSync(join(pi.terminal, "walkthrough.cast"))) {
      execFileSync(process.execPath, ["--experimental-strip-types", join(repository, "scripts/render-tui-recording.ts"), pi.terminal]);
    }
    const terminal = JSON.parse(readFileSync(join(pi.terminal, "result.json"), "utf8"));
    evidence.terminal = terminal;
    const observations = readFileSync(observer, "utf8").trim().split("\n").map(line => JSON.parse(line));
    evidence.uiLifecycle = observations;
    const parentStart = observations.find(entry => entry.event === "session_start" && entry.sessionId === terminal.parentSessionId);
    assert.ok(parentStart); assert.equal(parentStart.mode, "tui"); assert.equal(parentStart.hasUI, true);
    assert.equal(parentStart.setWidget, "function");
    assert.equal(terminal.completedInteraction, true, terminal.failure);
    assert.equal(terminal.exitCode, 0, `Unexpected terminal shutdown: ${terminal.cleanup}`);
    const invocation = JSON.parse(readFileSync(join(environment.artifacts, "invocation.json"), "utf8"));
    assert.ok(!invocation.args.includes("--print") && !invocation.args.includes("--mode"));
    assert.ok(!invocation.args.includes(prompt), "The prompt must be entered through the terminal");
    const ready = readFileSync(join(pi.terminal, "screens/tui-ready.txt"), "utf8");
    assert.ok(ready.includes(profile.model), "The terminal must actually display the selected model");
    const parent = readTranscript(parentStart.sessionFile);
    evidence.parentTranscript = parentStart.sessionFile;
    const messages = parent.flatMap(entry => entry.message ? [entry.message] : []);
    const calls = messages.filter(message => message.role === "assistant").flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === "toolCall") : []);
    assert.equal(calls.length, 1); assert.equal(calls[0].name, "Agent");
    assert.equal(calls[0].arguments?.subagent_type, "spawn-check"); assert.equal(calls[0].arguments?.isolation, "worktree");
    const result = messages.find(message => message.role === "toolResult" && message.toolCallId === calls[0].id);
    assert.ok(result);
    evidence.agentToolResult = { isError: result.isError, details: result.details, text: messageText(result) };
    let childPath = "", childCwd = "";
    const db = new DatabaseSync(join(environment.state, "pi-secretary-goals.sqlite"), { readOnly: true });
    try {
      const agents = db.prepare("SELECT json FROM secretary_agents").all();
      const runs = db.prepare("SELECT json FROM secretary_agent_runs").all();
      assert.equal(agents.length, 1); assert.equal(runs.length, 1);
      const agent = JSON.parse(String(agents[0].json)), run = JSON.parse(String(runs[0].json));
      evidence.child = { agentId: agent.agentId, sessionPath: agent.sessionPath, cwd: agent.cwd, model: agent.model,
        workspace: agent.worktree, status: run.status, error: run.error };
      assert.equal(agent.worktree.kind, "git-worktree");
      assert.ok(messageText(result).includes(`Agent: ${agent.agentId}\n`));
      assert.ok(messageText(result).includes(`Run: ${run.runId}\n`));
      assert.equal(agent.parentId, parent[0].id);
      assert.equal(agent.model, `${profile.provider}/${profile.model}`);
      childPath = agent.sessionPath; childCwd = agent.cwd;
      if (agent.sessionPath && existsSync(agent.sessionPath)) {
        const child = readTranscript(agent.sessionPath);
        evidence.childTranscript = agent.sessionPath;
        evidence.childMessageCount = child.filter(entry => entry.message).length;
      }
    } finally { db.close(); }
    // This remains a success assertion, not an expected-failure test that would hide the bug.
    assert.equal(result.isError, false, messageText(result));
    assert.equal(result.details?.status, "succeeded", messageText(result));
    assert.ok(messageText(result).includes(expected));
    assert.ok(messages.some(message => message.role === "assistant" && messageText(message).includes(expected)));
    const child = readTranscript(childPath);
    const childMessages = child.flatMap(entry => entry.message ? [entry.message] : []);
    const reads = childMessages.filter(message => message.role === "assistant").flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === "toolCall") : []);
    assert.equal(reads.length, 1); assert.equal(reads[0].name, "read");
    assert.equal(realpathSync(resolve(childCwd, String(reads[0].arguments?.path))), realpathSync(join(childCwd, "fixture.txt")));
    const readResult = childMessages.find(message => message.role === "toolResult" && message.toolCallId === reads[0].id);
    assert.ok(readResult); assert.equal(readResult.isError, false); assert.equal(messageText(readResult).trim(), expected);
    assert.equal(readFileSync(join(environment.project, "fixture.txt"), "utf8").trim(), expected);
    const childFinal = childMessages.filter(message => message.role === "assistant").at(-1)!;
    assert.equal(childFinal.stopReason, "stop"); assert.equal(messageText(childFinal).trim(), expected);
    const childEvents = observations.filter(entry => entry.sessionId === child[0].id);
    assert.deepEqual(childEvents.map(entry => entry.event), ["session_start", "agent_end", "session_shutdown"]);
    for (const entry of childEvents) {
      assert.equal(entry.mode, "print"); assert.equal(entry.hasUI, false);
      assert.equal(entry.setWidget, "function"); assert.equal(entry.onTerminalInput, "function");
    }
    for (const entry of observations.filter(entry => entry.sessionId === terminal.parentSessionId)) {
      assert.equal(entry.mode, "tui"); assert.equal(entry.hasUI, true); assert.equal(entry.setWidget, "function");
    }
    passed = true;
  } catch (error) {
    failure = environment.redact(String(error));
    throw new Error(failure);
  } finally {
    profile.redactArtifacts();
    writeFileSync(join(environment.artifacts, "assertion-result.json"), environment.redact(JSON.stringify({ passed, failure,
      profile: { provider: profile.provider, model: profile.model, providerVersion: profile.providerVersion },
      widgets, evidence, mockedModel: false, humanReview: "not performed" }, null, 2)) + "\n");
    t.diagnostic(`Interactive E2E artifacts: ${environment.artifacts}`);
  }
});
