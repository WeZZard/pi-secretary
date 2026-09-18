import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Cross-process storage-lock reproduction helpers.
 *
 * The probe extension runs INSIDE the pi process and only observes: it records
 * the session thread identity and wraps `ctx.ui.setWidget` so the test can
 * tell when the goal widget is mounted (which starts the one-second render
 * tick that re-reads the shared goals database). It changes no behavior.
 *
 * The external writer mimics a second concurrent pi session: it takes a write
 * lock on the same database file and holds it, so a widget render tick that
 * reads during the write window hits SQLITE_BUSY — the production crash.
 */

export default function storageLockProbe(pi: ExtensionAPI): void {
  const control = process.env.PI_E2E_STORAGE_LOCK;
  if (!control) return; // Not a lock reproduction run; stay inert.
  mkdirSync(control, { recursive: true });
  const events = join(control, "probe-events.jsonl");
  const record = (event: string, extra: Record<string, unknown> = {}) => {
    appendFileSync(events, JSON.stringify({ event, at: Date.now(), ...extra }) + "\n", { mode: 0o600 });
  };
  pi.on("session_start", (_event, ctx) => {
    const threadId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    record("session", { threadId, mode: ctx.mode, hasUI: ctx.hasUI });
    if (!ctx.hasUI) return;
    const original = ctx.ui.setWidget.bind(ctx.ui);
    ctx.ui.setWidget = ((id: string, component: unknown, ...rest: unknown[]) => {
      record("widget", { id, mounted: component !== undefined });
      return (original as (...args: unknown[]) => void)(id, component, ...rest);
    }) as typeof ctx.ui.setWidget;
  });
}

/** Signals recorded in the run directory by the probe and the external writer. */
export interface StorageLockControl {
  dir: string;
  eventsPath: string;
  threadId(): string | undefined;
  goalWidgetMounted(): boolean;
  probeEvents(): Array<Record<string, unknown>>;
}

export function createStorageLockControl(parent: string): StorageLockControl {
  const dir = join(parent, `storage-lock-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const eventsPath = join(dir, "probe-events.jsonl");
  const events = (): Array<Record<string, unknown>> =>
    existsSync(eventsPath)
      ? readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      : [];
  return {
    dir,
    eventsPath,
    threadId() {
      const session = events().find(event => event["event"] === "session");
      return session?.["threadId"] as string | undefined;
    },
    goalWidgetMounted() {
      return events().some(event => event["event"] === "widget" && event["id"] === "secretary:goal" && event["mounted"] === true);
    },
    probeEvents: events,
  };
}

/**
 * Acquires an exclusive write transaction on the shared database and holds it
 * for `holdMs`, mimicking a concurrent pi session stalled inside its write
 * window. The writer's own busy timeout lets it slip in between the widget's
 * microsecond reads; once held, every read in the pi process fails with
 * SQLITE_BUSY immediately (the shared connection runs with busy_timeout = 0
 * and the rollback journal default).
 */
export function holdExternalWriteLock(dbPath: string, control: StorageLockControl, holdMs: number): { done: Promise<number | null> } {
  const script = join(control.dir, "external-writer.mjs");
  const lockedPath = join(control.dir, "external-writer-locked.json");
  const donePath = join(control.dir, "external-writer-done.json");
  writeFileSync(script, `import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
const db = new DatabaseSync(${JSON.stringify(dbPath)});
const started = Date.now();
db.exec("PRAGMA busy_timeout = 30000");
db.exec("BEGIN EXCLUSIVE");
db.prepare("UPDATE thread_goals SET updated_at_ms = ?").run(started);
writeFileSync(${JSON.stringify(lockedPath)}, JSON.stringify({ started, locked: Date.now() }));
setTimeout(() => {
  db.exec("ROLLBACK");
  db.close();
  writeFileSync(${JSON.stringify(donePath)}, JSON.stringify({ started, released: Date.now() }));
}, ${Math.max(0, holdMs)});
`, { mode: 0o600 });
  const child = spawn(process.execPath, ["--no-warnings", script], { stdio: "ignore", detached: true });
  // The child must stay ref'd: the test awaits `done`, and an unref'd child
  // leaves the event loop idle in the window between pi's crash and the
  // writer's release, which `node --test` reports as a cancellation.
  const done = new Promise<number | null>(resolve => {
    child.once("error", () => resolve(null));
    child.once("close", code => resolve(code));
  });
  return { done };
}

/** True once the external writer holds the write transaction. */
export function externalWriterLocked(control: StorageLockControl): boolean {
  return existsSync(join(control.dir, "external-writer-locked.json"));
}

/** The goals database the extension under test shares with any concurrent session. */
export function goalsDbPath(stateDir: string): string {
  return join(stateDir, "pi-secretary-goals.sqlite");
}

/** Dispose helper that tolerates an already-crashed child. */
export function killQuietly(stop: () => void): void {
  try { stop(); } catch { /* The reproducer's whole point is that pi may already be gone. */ }
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
