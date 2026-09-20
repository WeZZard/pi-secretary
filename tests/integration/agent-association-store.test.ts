import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAssociationStore, type GoalAssociation } from "../../extensions/secretary/composition/association-store.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";

const goal: GoalAssociation = { threadId: "thread", goalId: "goal", sessionEpoch: "epoch", controlGeneration: 2, intentSeq: 3 };

function fixture(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE secretary_agent_runs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE secretary_agent_usage (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE secretary_agent_goal_usage (event_id TEXT PRIMARY KEY, token_delta INTEGER, applied INTEGER);
    INSERT INTO secretary_agent_goal_usage VALUES ('usage', 7, 1);
  `);
  const run = { runId: "run", agentId: "agent", parentId: "parent", goal, outputPath: "/historical/output", output: "result", status: "succeeded" };
  const usage = { id: "usage", runId: "run", goal, usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 1 } };
  db.prepare("INSERT INTO secretary_agent_runs VALUES (?, ?)").run("run", JSON.stringify(run));
  db.prepare("INSERT INTO secretary_agent_usage VALUES (?, ?, ?)").run("usage", "run", JSON.stringify(usage));
  return { run, usage };
}

function snapshot(db: DatabaseSync) {
  return ["secretary_agent_runs", "secretary_agent_usage", "secretary_agent_goal_usage", "secretary_composition_requests", "secretary_composition_runs"]
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

function payload(db: DatabaseSync, table: string) {
  return JSON.parse(String(db.prepare(`SELECT json FROM ${table}`).get()!.json));
}

test("independent installation creates only composition tables and tolerates absent agent tables", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AgentAssociationStore(db);
    store.migrateLegacy(); store.migrateLegacy();
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
      ["secretary_composition_requests", "secretary_composition_runs"]);
    assert.equal(store.request("missing"), undefined);
    assert.equal(store.run("missing"), undefined);
  } finally { db.close(); }
});

test("requests and run mappings are immutable, idempotent, and detached from caller mutation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AgentAssociationStore(db);
    assert.throws(() => store.associateRun("run", "missing"), /durable request/);
    const request = { requestId: "request", authority: "user" as const, goal: { ...goal } };
    store.putRequest(request);
    store.putRequest({ goal: { intentSeq: goal.intentSeq, controlGeneration: goal.controlGeneration, sessionEpoch: goal.sessionEpoch, goalId: goal.goalId, threadId: goal.threadId }, authority: "user", requestId: "request" });
    request.goal.goalId = "mutated";
    assert.equal(store.request("request")?.goal?.goalId, "goal");
    const returned = store.request("request")!; returned.goal!.goalId = "also-mutated";
    assert.equal(store.request("request")?.goal?.goalId, "goal");
    assert.throws(() => store.putRequest({ requestId: "request", authority: "automatic", goal }), /cannot change/);
    assert.throws(() => store.putRequest({ requestId: "request", authority: "user" }), /cannot change/);
    store.associateRun("run", "request"); store.associateRun("run", "request");
    store.putRequest({ requestId: "second", authority: "notification" });
    assert.throws(() => store.associateRun("run", "second"), /cannot change/);
    assert.deepEqual(store.run("run"), { requestId: "request", authority: "user", goal });
    store.putRequest({ requestId: "unknown", authority: "unknown" });
    store.associateRun("unattributed", "unknown");
    assert.deepEqual(store.run("unattributed"), { requestId: "unknown", authority: "unknown" });
    assert.throws(() => store.putRequest({ requestId: "bad", authority: "automatic", goal: { ...goal, intentSeq: NaN } }), /Invalid/);
    assert.equal(store.request("bad"), undefined);
  } finally { db.close(); }
});

test("migration persists attribution and replay identity across restart without changing usage or markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "association-store-"));
  const path = join(dir, "store.sqlite");
  let db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const original = fixture(db);
    let store = new AgentAssociationStore(db);
    store.migrateLegacy();
    const requestId = "legacy-agent-run:run";
    assert.deepEqual(store.run("run"), { requestId, authority: "automatic", goal });
    const { goal: _runGoal, ...run } = original.run;
    const { goal: _usageGoal, ...usage } = original.usage;
    assert.deepEqual(payload(db, "secretary_agent_runs"), { ...run, requestId });
    assert.deepEqual(payload(db, "secretary_agent_usage"), usage);
    assert.deepEqual({ ...db.prepare("SELECT * FROM secretary_agent_goal_usage").get() }, { event_id: "usage", token_delta: 7, applied: 1 });
    const migrated = snapshot(db);
    db.close(); db = new DatabaseSync(path);
    store = new AgentAssociationStore(db); store.migrateLegacy();
    assert.deepEqual(snapshot(db), migrated);
    assert.deepEqual(store.request(payload(db, "secretary_agent_runs").requestId), store.run("run"));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("migration preserves existing request IDs and can reconstruct attribution from usage alone", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const { run } = fixture(db);
    const { goal: _goal, ...withoutGoal } = run;
    db.prepare("UPDATE secretary_agent_runs SET json = ?").run(JSON.stringify({ ...withoutGoal, requestId: "existing" }));
    const store = new AgentAssociationStore(db); store.migrateLegacy();
    assert.equal(store.run("run")?.requestId, "existing");
    assert.equal(payload(db, "secretary_agent_runs").requestId, "existing");
    assert.deepEqual(store.request("existing"), { requestId: "existing", authority: "automatic", goal });
    assert.equal(store.request("legacy-agent-run:run"), undefined);
  } finally { db.close(); }
});

test("usage-only attribution adds replay identity to a run without a request ID", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const { run } = fixture(db); const { goal: _goal, ...withoutGoal } = run;
    db.prepare("UPDATE secretary_agent_runs SET json = ?").run(JSON.stringify(withoutGoal));
    const store = new AgentAssociationStore(db); store.migrateLegacy();
    assert.equal(payload(db, "secretary_agent_runs").requestId, store.run("run")?.requestId);
    assert.deepEqual(store.run("run")?.goal, goal);
  } finally { db.close(); }
});

test("usage migration tolerates an absent run table without losing attribution", () => {
  const db = new DatabaseSync(":memory:");
  try {
    fixture(db); db.exec("DROP TABLE secretary_agent_runs");
    const store = new AgentAssociationStore(db); store.migrateLegacy();
    assert.deepEqual(store.run("run")?.goal, goal);
    assert.equal(Object.hasOwn(payload(db, "secretary_agent_usage"), "goal"), false);
  } finally { db.close(); }
});

for (const stage of ["mapping", "run-rewrite", "usage-rewrite"]) {
  test(`interrupted migration rolls back all changes at ${stage} and retries safely`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      fixture(db); const store = new AgentAssociationStore(db);
      const target = stage === "mapping" ? "INSERT ON secretary_composition_runs" :
        stage === "run-rewrite" ? "UPDATE ON secretary_agent_runs" : "UPDATE ON secretary_agent_usage";
      db.exec(`CREATE TRIGGER interrupt BEFORE ${target} BEGIN SELECT RAISE(ABORT, 'injected interruption'); END`);
      const before = snapshot(db);
      assert.throws(() => store.migrateLegacy(), /injected interruption/);
      assert.deepEqual(snapshot(db), before);
      db.exec("DROP TRIGGER interrupt");
      new AgentAssociationStore(db).migrateLegacy();
      assert.deepEqual(store.run("run")?.goal, goal);
      assert.equal(Object.hasOwn(payload(db, "secretary_agent_usage"), "goal"), false);
    } finally { db.close(); }
  });
}

for (const malformed of ["{", "null", "[]", JSON.stringify({ runId: "wrong", goal }),
  JSON.stringify({ runId: "run", goal: null }), JSON.stringify({ runId: "run", goal: { ...goal, intentSeq: "3" } }),
  JSON.stringify({ runId: "run", goal: { ...goal, unknown: "preserve me" } }), JSON.stringify({ runId: "run", requestId: null, goal })]) {
  test(`malformed run payload is not erased: ${malformed}`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      fixture(db); const store = new AgentAssociationStore(db);
      db.prepare("UPDATE secretary_agent_runs SET json = ?").run(malformed);
      const before = snapshot(db);
      assert.throws(() => store.migrateLegacy()); assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
  });
}

test("malformed usage and inconsistent historical associations never erase evidence", () => {
  for (const invalid of ["{", JSON.stringify({ id: "usage", runId: "wrong", goal }),
    JSON.stringify({ id: "usage", runId: "run", goal: { ...goal, goalId: "different" } })]) {
    const db = new DatabaseSync(":memory:");
    try {
      fixture(db); const store = new AgentAssociationStore(db);
      db.prepare("UPDATE secretary_agent_usage SET json = ?").run(invalid);
      const before = snapshot(db);
      assert.throws(() => store.migrateLegacy()); assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
  }
});

test("migration does not relabel an existing user association or overwrite a conflicting request ID", () => {
  for (const authority of ["user", "automatic"] as const) {
    const db = new DatabaseSync(":memory:");
    try {
      const { run } = fixture(db); const store = new AgentAssociationStore(db);
      store.putRequest({ requestId: "existing", authority, goal }); store.associateRun("run", "existing");
      if (authority === "automatic") db.prepare("UPDATE secretary_agent_runs SET json = ?").run(JSON.stringify({ ...run, requestId: "different" }));
      const before = snapshot(db);
      assert.throws(() => store.migrateLegacy(), /cannot change/); assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
  }
});

test("migrated records replay through the public agent repository with conversation and event identities intact", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const repo = new AgentRepository(db);
    repo.putAgent({ agentId: "agent", parentId: "parent", definition: { name: "worker", description: "worker", prompt: "work", source: "fixture", hash: "hash", resumable: true },
      model: "fixture/model", tools: [], cwd: "/fixture", configCwd: "/fixture", sessionPath: "/historical/conversation.jsonl", resumable: true, createdAt: 1 });
    const legacyRun = { runId: "run", agentId: "agent", parentId: "parent", launchKey: "launch", prompt: "work", description: "work", status: "succeeded", background: true,
      createdAt: 1, outputPath: "/historical/output", output: "result", toolCount: 1, turnCount: 1, revision: 1, goal };
    db.prepare("INSERT INTO secretary_agent_runs VALUES (?, ?, ?, ?, ?, ?)").run("run", "agent", "parent", "launch", "succeeded", JSON.stringify(legacyRun));
    const legacyUsage = { id: "usage", runId: "run", usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 1 }, goal };
    db.prepare("INSERT INTO secretary_agent_usage VALUES (?, ?, ?)").run("usage", "run", JSON.stringify(legacyUsage));
    repo.putCompletion({ id: "completion", runId: "run", parentId: "parent", state: "observed", trigger: true });
    const store = new AgentAssociationStore(db); store.migrateLegacy();
    const [run] = repo.runs("parent");
    assert.deepEqual(store.run(run.runId)?.goal, goal);
    assert.equal(Object.hasOwn(run, "goal"), false);
    assert.equal((run as unknown as { requestId: string }).requestId, store.run(run.runId)?.requestId);
    assert.equal(repo.getAgent("agent")?.sessionPath, "/historical/conversation.jsonl");
    assert.equal(repo.completions("parent")[0].id, "completion");
    const [usage] = repo.usage(run.runId);
    assert.equal(usage.id, "usage"); assert.equal(Object.hasOwn(usage, "goal"), false);
    assert.equal(repo.recordUsage(usage), false, "source-event deduplication survives migration");
    assert.equal(run.outputPath, "/historical/output"); assert.equal(run.output, "result");
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name = 'thread_goals'").all(), []);
  } finally { db.close(); }
});

test("migration composes with an outer transaction and does not commit its caller's work", () => {
  const db = new DatabaseSync(":memory:");
  try {
    fixture(db); const store = new AgentAssociationStore(db); const before = snapshot(db);
    db.exec("BEGIN"); store.migrateLegacy(); assert.ok(store.run("run")); db.exec("ROLLBACK");
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});
