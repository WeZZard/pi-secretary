import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCleanPiEnvironment } from "../../environment/isolation.ts";
import { useGlobalLiteLLM } from "../../environment/global-litellm.ts";
import { startStorageLockPi } from "../../environment/storage-lock-pi-process.ts";
import {
  createStorageLockControl, externalWriterLocked, goalsDbPath, holdExternalWriteLock, killQuietly,
} from "../../environment/storage-lock-extensions.ts";

/**
 * Cross-process storage-lock reproduction (production crash of 2026-09-18).
 *
 * The goals database is shared by every pi session on the machine and is
 * opened with Node's node:sqlite defaults (rollback journal, busy_timeout 0).
 * While any other session holds a write lock — an accounting checkpoint or a
 * child-usage accounting write — every read in this session fails immediately
 * with SQLITE_BUSY. The goal widget's one-second render tick calls
 * GoalService.getGoal without a guard, the throw escapes pi's TUI render
 * timer, and pi exits with "pi exiting due to uncaughtException: Error:
 * database is locked".
 *
 * This test drives the genuine production flow: a live model turn creates the
 * goal through the create_goal tool, the TUI idles with the active-goal
 * widget ticking, and an external process then holds a write transaction on
 * the same database file — exactly the concurrent-session window.
 */
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtures = join(repository, "tests/e2e/fixtures/storage-lock");
const observerEntry = join(repository, "tests/e2e/environment/ui-observer.ts");
const probeEntry = join(repository, "tests/e2e/environment/storage-lock-extensions.ts");

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test("goal widget render survives a concurrent session's write lock (interactive)", { timeout: 330000 }, async t => {
  const environment = createCleanPiEnvironment({ name: "goal-widget-storage-lock",
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
  const objective = "Hold the line while the database is contended";
  const prompt = `Call the create_goal tool exactly once with objective "${objective}". After the tool result arrives, reply with exactly: GOAL SET`;
  const pi = startStorageLockPi(environment, { prompt, model: `${profile.provider}/${profile.model}`,
    observer, widgetMarker, idleSeconds: 10, timeoutMs: 180000 });
  t.after(() => killQuietly(pi.stop));

  // Wait for the widget mount signal: the goal now exists through the real
  // tool flow and the one-second render tick is live.
  const mountDeadline = Date.now() + 240000;
  while (!existsSync(widgetMarker) && Date.now() < mountDeadline) await sleep(200);
  assert.ok(existsSync(widgetMarker), "The goal widget must mount before the lock is taken");
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
    goalWidgetMounted: control.goalWidgetMounted(),
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

// Fast in-process complement: no PTY or model. It mounts the widget's read
// path against a real GoalEngine whose database is locked by a second
// connection and renders once. After the §5.1.1 fix (WAL + busy timeout) the
// read succeeds under the lock; before the fix it threw SQLITE_BUSY, which
// pi's unguarded TUI render timer turned into a process exit.
test("widget render read succeeds while a concurrent connection holds a write lock", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { GoalEngine } = await import("../../../../extensions/secretary/goal-engine.ts");

  const dir = mkdtempSync(joinPath(tmpdir(), "secretary-lock-unit-"));
  try {
    const dbPath = joinPath(dir, "goals.sqlite");
    const engine = new GoalEngine({ dbPath, enabled: true });
    engine.service.createGoal("thread-1", "Hold the line while the database is contended");

    const concurrent = new DatabaseSync(dbPath);
    concurrent.exec("PRAGMA journal_mode = WAL");
    try {
      concurrent.exec("BEGIN IMMEDIATE");
      concurrent.prepare("UPDATE thread_goals SET updated_at_ms = ?").run(Date.now());
      try {
        // The production render callback (goal-ui.ts) re-reads the goal on
        // every tick; under WAL a writer does not exclude readers, so the
        // read returns instead of throwing SQLITE_BUSY.
        assert.equal(engine.service.getGoal("thread-1")?.status, "active");
      } finally {
        concurrent.exec("ROLLBACK");
        concurrent.close();
      }
      // After the lock is released the read still returns the live goal.
      assert.equal(engine.service.getGoal("thread-1")?.status, "active");
    } finally {
      engine.dispose();
      engine.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
