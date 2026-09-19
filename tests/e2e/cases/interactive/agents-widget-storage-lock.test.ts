import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createCleanPiEnvironment } from "../../environment/isolation.ts";
import { useGlobalLiteLLM } from "../../environment/global-litellm.ts";
import { startAgentsLockPi } from "../../environment/agents-lock-pi-process.ts";
import {
  createStorageLockControl, externalWriterLocked, goalsDbPath, holdExternalWriteLock, killQuietly,
} from "../../environment/storage-lock-extensions.ts";

/**
 * Cross-process storage-lock reproduction for the async-agents widget
 * (production crash of 2026-09-19, "Fix agent tools wildcard parsing"
 * session): pi exited with "pi exiting due to uncaughtException: Error:
 * database is locked" from AgentRepository.many via AgentService.viewModels,
 * reached through the AsyncWidget render inside TuiMainScreen.render.
 *
 * The goals database is shared by every pi session on the machine. Before the
 * §5.1.1 fix it opened with node:sqlite defaults (rollback journal,
 * busy_timeout 0): any other session's write excluded every read in this
 * session, and the agents widget's 500 ms render tick called
 * AgentRepository.usage with no guard, so the SQLITE_BUSY escaped pi's TUI
 * render timer and exited the process.
 *
 * This test drives the genuine production flow: a live model turn launches a
 * real child agent through the Agent tool, the TUI idles with the
 * async-agents widget ticking, and an external process then holds a write
 * transaction on the same database file — exactly the concurrent-session
 * window. The Agent tool call is verified in the parent's session transcript
 * before the lock is taken, so the launch cannot be misread.
 */
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtureRoot = join(repository, "tests/e2e/fixtures/agents-lock");
const fixtures = join(fixtureRoot, "project");
const observerEntry = join(repository, "tests/e2e/environment/ui-observer.ts");
const probeEntry = join(repository, "tests/e2e/environment/agents-lock-probe.ts");

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test("agents widget render survives a concurrent session's write lock (interactive)", { timeout: 420000 }, async t => {
  const environment = createCleanPiEnvironment({ name: "agents-widget-storage-lock",
    extensionUnderTest: join(repository, "extensions/secretary/index.ts"),
    projectFixture: fixtures, repositoryState: "none" });
  t.after(() => environment.dispose());
  // All e2e cases select the same catalog model explicitly (recorded in
  // provider-profile.json) rather than inheriting the rate-limited global default.
  const profile = useGlobalLiteLLM(environment, undefined, { model: "kimi-k3-256k" });
  const settings = JSON.parse(readFileSync(join(environment.agentDir, "settings.json"), "utf8"));
  settings.extensions.push(observerEntry, probeEntry);
  environment.extensions.push(observerEntry, probeEntry);
  settings.enabledModels = [`${profile.provider}/${profile.model}`];
  writeFileSync(join(environment.agentDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  const control = createStorageLockControl(environment.artifacts);
  environment.env.PI_E2E_STORAGE_LOCK = control.dir;
  environment.env.LITELLM_OFFLINE = "1"; // Disable discovery, not real inference.
  writeFileSync(join(environment.artifacts, "terminal-profile.json"), JSON.stringify({ frontend: "interactive TUI",
    inputTransport: "POSIX PTY", realModelRequests: true, visibleDesktopWindow: false,
    permittedCatalogModels: [`${profile.provider}/${profile.model}`], discoveryDisabled: true,
    observer: observerEntry, probe: probeEntry,
    concurrency: "external process holds an exclusive write transaction on the shared goals database",
    humanReview: "not performed" }, null, 2) + "\n");
  const observer = join(environment.artifacts, "ui-lifecycle.jsonl");
  const widgetMarker = join(control.dir, "widget-mounted.json");
  const prompt = readFileSync(join(fixtureRoot, "launch-prompt.txt"), "utf8").trim();
  const pi = startAgentsLockPi(environment, { prompt, model: `${profile.provider}/${profile.model}`,
    observer, widgetMarker, idleSeconds: 10, timeoutMs: 420000, turnTimeoutMs: 300000, tools: ["read", "Agent"] });
  t.after(() => killQuietly(pi.stop));

  // Wait for the widget mount signal: the agent now exists through the real
  // tool flow and the 500 ms render tick is live.
  const mountDeadline = Date.now() + 360000;
  while (!existsSync(widgetMarker) && Date.now() < mountDeadline) await sleep(200);
  assert.ok(existsSync(widgetMarker), "The async-agents widget must mount before the lock is taken");
  const threadId = control.threadId();
  assert.ok(threadId, "The probe must record the session thread identity");

  // Mimic the concurrent session: hold an exclusive write transaction across
  // several widget ticks. The driver keeps the TUI alive for ten seconds of
  // observation; an unguarded render read dies within one second of the lock.
  const writer = holdExternalWriteLock(goalsDbPath(environment.state), control, 8000);
  const lockDeadline = Date.now() + 30000;
  while (!externalWriterLocked(control) && Date.now() < lockDeadline) await sleep(50);
  assert.ok(externalWriterLocked(control), "The external writer must hold the write transaction");

  const outcome = await pi.result;
  await writer.done;
  profile.redactArtifacts();
  const terminalResult = JSON.parse(readFileSync(join(pi.terminal, "result.json"), "utf8"));
  const terminalText = readFileSync(join(pi.terminal, "walkthrough.cast"), "utf8");

  writeFileSync(join(environment.artifacts, "assertions.json"), JSON.stringify({
    threadId,
    agentsWidgetMounted: control.probeEvents().some(event => event["event"] === "widget"
      && event["id"] === "secretary.agents.async" && event["mounted"] === true),
    probeEvents: control.probeEvents(),
    diedDuringLock: terminalResult.diedDuringLock,
    exitCode: terminalResult.exitCode,
  }, null, 2) + "\n");

  assert.equal(terminalResult.diedDuringLock, null,
    `pi must survive a concurrent write lock on the shared goals database; got: ${terminalResult.diedDuringLock ?? "none"}; ` +
    (terminalText.includes("database is locked") ? "terminal shows the SQLITE_BUSY uncaughtException" : "see walkthrough.cast"));
  assert.equal(terminalResult.completedInteraction, true, terminalResult.failure ?? "The interactive session did not complete");
  assert.equal(outcome.code, 0, readFileSync(join(environment.artifacts, "terminal-driver.stderr.log"), "utf8"));
});

// Fast in-process complement: no PTY or model. It mounts the agents widget's
// read path — AgentService.viewModels — against a real file-backed store
// locked by a second connection. The second connection inherits the file's
// journal mode, exactly like the production concurrent session
// (holdExternalWriteLock takes BEGIN EXCLUSIVE). After the display-projection
// fix (subagent architecture §6.2) the display read serves the in-memory
// projection and never touches storage, so it cannot participate in the lock
// at all; before the fix the render path SELECTed from the shared store, and
// under the pre-fix rollback journal with busy_timeout 0 that read threw
// SQLITE_BUSY, which pi's unguarded TUI render timer turned into a process
// exit.
test("agents widget render read succeeds while a concurrent connection holds a write lock", async t => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { AgentService } = await import("../../../../extensions/secretary/agents/service.ts");
  const { AgentRepository } = await import("../../../../extensions/secretary/agents/storage/agent-repository.ts");
  const { defaultAgentUi } = await import("../../../../extensions/secretary/agents/configuration.ts");
  const { GoalDb } = await import("../../../../extensions/secretary/goal/storage/goal-db.ts");

  const dir = mkdtempSync(joinPath(tmpdir(), "agents-lock-unit-"));
  try {
    // Production wiring: AgentRepository shares the goal engine's connection
    // (installation.ts passes engine.db.connection).
    const db = GoalDb.open(joinPath(dir, "pi-secretary-goals.sqlite"));
    const repository = new AgentRepository(db.connection);
    const service = new AgentService({ parentId: "p", root: dir, repository,
      ctx: { cwd: dir, mode: "tui" } as never,
      config: { modelFallbackLists: {}, ui: defaultAgentUi(), maxConcurrent: 1, maxQueued: 2, shutdownTimeoutMs: 100 },
      runner: async options => {
        options.hooks.usage("u1", { inputTokens: 1500, cachedInputTokens: 500, cacheWriteInputTokens: 0,
          outputTokens: 250, reasoningOutputTokens: 0, totalTokens: 1750 });
        return { result: new Promise(() => {}), steer: async () => {}, abort: async () => {}, dispose: async () => {} };
      } });
    t.after(async () => { await service.shutdown(); db.close(); });
    const definition = { name: "worker", description: "Test worker", prompt: "p", source: "packaged", hash: "h", resumable: true };
    const launched = await service.launch({ launchKey: "k1", definition, model: "test/model",
      tools: ["read"], prompt: "Do it", description: "Agents widget lock check", background: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.run(launched.run!.runId).status, "running");

    const concurrent = new DatabaseSync(joinPath(dir, "pi-secretary-goals.sqlite"));
    concurrent.exec("PRAGMA busy_timeout = 5000");
    try {
      concurrent.exec("BEGIN EXCLUSIVE");
      concurrent.prepare("UPDATE secretary_agent_usage SET json = json WHERE id = ?").run("u1");
      try {
        // The production render callback (commands.ts) re-reads view models on
        // every 500 ms tick. The projection serves them from memory, so the
        // read returns the committed rows without touching the locked store.
        const rows = service.viewModels();
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.status, "running");
        assert.equal(rows[0]!.cumulativeTokens, 1750);
      } finally {
        concurrent.exec("ROLLBACK");
        concurrent.close();
      }
      // After the lock is released the read still returns the live rows.
      assert.equal(service.viewModels().length, 1);
    } finally {
      if (concurrent.isOpen) concurrent.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
