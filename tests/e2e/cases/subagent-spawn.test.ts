import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createCleanPiEnvironment } from "../environment/isolation.ts";
import { useGlobalLiteLLM } from "../environment/global-litellm.ts";
import { useInstalledWidgetExtensions } from "../environment/widget-extensions.ts";
import { startPi } from "../environment/pi-process.ts";
import { readTranscript, sessionFiles, messageText } from "../environment/transcripts.ts";

// Run explicitly with npm run test:e2e. This case uses the real provider and may incur charges.
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = join(repository, "tests/e2e/fixtures/subagents");

for (const repositoryState of ["none", "unborn", "committed"] as const) {
for (const isolated of [false, true]) {
test(`subagent-spawn: ${repositoryState} project, ${isolated ? "requested isolation" : "default shared directory"}`, { timeout: 240000 }, async t => {
  const environment = createCleanPiEnvironment({ name: "subagent-spawn",
    extensionUnderTest: join(repository, "extensions/secretary/index.ts"),
    projectFixture: join(fixtures, "project"), repositoryState });
  t.after(() => environment.dispose());
  const profile = useGlobalLiteLLM(environment);
  const widgets = useInstalledWidgetExtensions(environment, profile.globalAgentDir);
  const expected = readFileSync(join(fixtures, "project/fixture.txt"), "utf8").trim();
  const prompt = readFileSync(join(fixtures, isolated ? "spawn-isolated-prompt.txt" : "spawn-prompt.txt"), "utf8").trim();
  let passed = false;
  let failure: string | undefined;
  let outcome: Awaited<ReturnType<typeof startPi>["result"]> | undefined;
  const evidence: Record<string, unknown> = {};
  try {
    const settings = JSON.parse(readFileSync(join(environment.agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settings.extensions, [environment.extension, profile.providerEntry, ...widgets.extensions]);
    assert.deepEqual(settings.packages, []);
    assert.equal(settings.defaultProvider, profile.provider);
    assert.equal(settings.defaultModel, profile.model);
    assert.ok(!prompt.includes(expected), "The parent must not be given the fixture contents");
    const pi = startPi(environment, { prompt, model: `${profile.provider}/${profile.model}`,
      offline: false, timeoutMs: 180000, tools: ["read", "Agent"] });
    t.after(() => pi.stop());
    outcome = await pi.result;
    profile.redactArtifacts();
    const stderr = readFileSync(join(environment.artifacts, "stderr.log"), "utf8");
    assert.equal(outcome.timedOut, false, "Live provider test exceeded its process deadline");
    assert.equal(outcome.code, 0, stderr);
    const parentFiles = sessionFiles(environment.sessions);
    assert.equal(parentFiles.length, 1, "Expected one persisted parent conversation");
    const parent = readTranscript(parentFiles[0]);
    evidence.parentTranscript = parentFiles[0];
    const messages = parent.flatMap(entry => entry.message ? [entry.message] : []);
    const calls = messages.filter(message => message.role === "assistant").flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === "toolCall") : []);
    assert.equal(calls.length, 1, "The live parent must make exactly one delegation call, not do the child's task or retry it");
    const call = calls[0];
    assert.equal(call.name, "Agent");
    assert.equal(call.arguments?.subagent_type, "spawn-check");
    assert.equal(call.arguments?.run_in_background, false);
    assert.equal(call.arguments?.model, undefined);
    if (isolated) assert.equal(call.arguments?.isolation, "worktree");
    else assert.ok(call.arguments?.isolation === undefined || call.arguments?.isolation === "none", "Default spawning must not request a separate workspace");
    const result = messages.find(message => message.role === "toolResult" && message.toolCallId === call.id);
    assert.ok(result, "The parent's launch statement is not sufficient evidence");
    evidence.agentToolResult = { isError: result.isError, details: result.details, text: messageText(result) };
    assert.equal(result.isError, false, messageText(result));
    assert.equal(result.details?.status, "succeeded", messageText(result));
    assert.ok(messageText(result).includes(expected), "Parent tool result must contain the child's actual file contents");

    const db = new DatabaseSync(join(environment.state, "pi-secretary-goals.sqlite"), { readOnly: true });
    let childPath = "";
    let childCwd = "";
    try {
      const agents = db.prepare("SELECT json FROM secretary_agents").all();
      const runs = db.prepare("SELECT json FROM secretary_agent_runs").all();
      assert.equal(agents.length, 1); assert.equal(runs.length, 1);
      const agent = JSON.parse(String(agents[0].json)); const run = JSON.parse(String(runs[0].json));
      assert.equal(agent.agentId, result.details!.agentId); assert.equal(agent.parentId, parent[0].id);
      assert.equal(agent.model, `${profile.provider}/${profile.model}`);
      assert.equal(realpathSync(agent.definition.source), realpathSync(join(environment.project, ".pi/agents/spawn-check.md")));
      assert.equal(run.runId, result.details!.runId); assert.equal(run.status, "succeeded");
      childPath = agent.sessionPath;
      childCwd = agent.cwd;
      if (isolated) {
        assert.notEqual(realpathSync(childCwd), realpathSync(environment.project));
        assert.ok(agent.worktree, "An explicitly isolated run must record its actual workspace");
        assert.equal(agent.worktree.kind, repositoryState === "committed" ? "git-worktree" : "directory-snapshot");
        if (repositoryState !== "committed") {
          assert.equal(agent.worktree.reason, repositoryState === "none" ? "no-git" : "unborn-head");
          assert.equal(agent.worktree.branch, undefined);
          assert.equal(agent.worktree.baseCommit, undefined);
          assert.match(messageText(result), /Isolation: directory-snapshot/);
        } else assert.match(messageText(result), /Isolation: git-worktree/);
      } else {
        assert.equal(realpathSync(childCwd), realpathSync(environment.project));
        assert.equal(agent.worktree, undefined);
        assert.equal(agent.requestedWorktree, undefined);
        assert.match(messageText(result), /Isolation: none/);
      }
      evidence.workspace = agent.worktree ?? null;
    } finally { db.close(); }
    const child = readTranscript(childPath);
    evidence.childTranscript = childPath;
    assert.notEqual(child[0].id, parent[0].id);
    assert.equal(realpathSync(child[0].cwd!), realpathSync(childCwd));
    const childMessages = child.flatMap(entry => entry.message ? [entry.message] : []);
    assert.ok(childMessages.some(message => message.role === "user" && messageText(message).includes("fixture.txt")));
    const reads = childMessages.filter(message => message.role === "assistant").flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === "toolCall") : []);
    assert.equal(reads.length, 1); assert.equal(reads[0].name, "read");
    assert.equal(realpathSync(resolve(childCwd, String(reads[0].arguments?.path))), realpathSync(join(childCwd, "fixture.txt")));
    assert.equal(readFileSync(join(environment.project, "fixture.txt"), "utf8").trim(), expected, "The parent project remains unchanged");
    const readResult = childMessages.find(message => message.role === "toolResult" && message.toolCallId === reads[0].id);
    assert.ok(readResult); assert.equal(readResult.isError, false);
    assert.equal(messageText(readResult).trim(), expected);
    const childFinal = childMessages.filter(message => message.role === "assistant").at(-1)!;
    assert.equal(childFinal.stopReason, "stop"); assert.equal(messageText(childFinal).trim(), expected);
    const parentFinal = messages.filter(message => message.role === "assistant").at(-1)!;
    assert.equal(parentFinal.stopReason, "stop"); assert.ok(messageText(parentFinal).includes(expected));
    assert.doesNotMatch(stderr, /Child extension error|setWidget is not a function/i);
    passed = true;
  } catch (error) {
    failure = environment.redact(String(error));
    throw new Error(failure);
  } finally {
    profile.redactArtifacts();
    writeFileSync(join(environment.artifacts, "assertion-result.json"), environment.redact(JSON.stringify({ passed, failure,
      profile: { provider: profile.provider, model: profile.model, api: profile.api, providerVersion: profile.providerVersion },
      repositoryState, isolated, widgets, outcome, evidence, mockedModel: false }, null, 2)) + "\n");
    t.diagnostic(`E2E artifacts (${repositoryState}, isolated=${isolated}): ${environment.artifacts}`);
  }
});
}
}
