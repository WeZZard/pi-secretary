import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AgentRepository, acquireParentLock } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import type { AgentRecord, AgentRun } from "../../extensions/secretary/agents/records.ts";
const agent: AgentRecord = { agentId: "a", parentId: "p", name: "worker", definition: { name: "test", description: "test", prompt: "test", source: "test", hash: "test", resumable: true }, model: "test", tools: [], cwd: "/tmp", configCwd: "/tmp", resumable: true, createdAt: 1 };
const run: AgentRun = { runId: "r", agentId: "a", parentId: "p", launchKey: "launch", prompt: "test", description: "test", status: "queued", background: true, createdAt: 1, outputPath: "/tmp/output", output: "", toolCount: 0, turnCount: 0, revision: 0 };

test("repository preserves JSON, enforces ownership and unique active runs, and rolls back synchronously", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const repo = new AgentRepository(db);
    repo.putAgent(agent); repo.putRun(run);
    assert.deepEqual(repo.getAgent("a"), agent);
    assert.deepEqual(repo.agents("p"), [agent]);
    assert.deepEqual(repo.runs("p"), [run]);
    assert.equal(repo.activeRun("a")?.runId, "r");
    assert.equal(repo.findLaunch("p", "launch")?.runId, "r");
    assert.equal(repo.findLaunch("other", "launch"), undefined);
    assert.throws(() => repo.putAgent({ ...agent, agentId: "b" }));
    assert.throws(() => repo.putRun({ ...run, runId: "r2", launchKey: "second" }));
    assert.throws(() => repo.putRun({ ...run, parentId: "foreign" }));
    assert.throws(() => repo.transaction(() => { repo.putRun({ ...run, status: "succeeded" }); repo.putReceipt("p", "op", { ok: true }); throw Error("rollback"); }));
    assert.equal(repo.getRun("r")?.status, "queued");
    assert.equal(repo.receipt("p", "op"), undefined);
    assert.throws(() => repo.transaction(() => Promise.resolve(1)), /synchronous/);
    repo.transaction(() => repo.transaction(() => repo.putRun({ ...run, status: "succeeded" })));
    repo.putRun({ ...run, runId: "r2", launchKey: "second" });
    assert.equal(repo.activeRun("a")?.runId, "r2");
    repo.putGuidance({ id: "g", runId: "r2", text: "hello", state: "pending" });
    repo.putGuidance({ id: "g2", runId: "r2", text: "next", state: "pending" });
    repo.putGuidance({ id: "g", runId: "r2", text: "hello", state: "uncertain" });
    assert.deepEqual(repo.guidance("r2").map(g => g.id), ["g", "g2"]);
    assert.equal(repo.getGuidance("g")?.state, "uncertain");
    repo.putCompletion({ id: "c", runId: "r", parentId: "p", state: "pending", trigger: true });
    assert.equal(repo.completions("p").length, 1);
    assert.throws(() => repo.putCompletion({ id: "c2", runId: "r", parentId: "p", state: "pending", trigger: true }));
    repo.putReceipt("p", "op", { accepted: "r" }); repo.putReceipt("p", "op", { accepted: "r2" });
    assert.deepEqual(repo.receipt("p", "op"), { accepted: "r" });
    assert.equal(repo.receipt("other", "op"), undefined);
  } finally { db.close(); }
});

test("usage deduplication and receipts survive reopening the shared database", async () => {
  const root = await mkdtemp(join(tmpdir(), "secretary-db-"));
  try {
    const path = join(root, "state.sqlite");
    let db = new DatabaseSync(path);
    let repo = new AgentRepository(db);
    repo.putAgent(agent); repo.putRun(run);
    const usage = { id: "event", runId: "r", usage: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 5 } };
    assert.equal(repo.recordUsage(usage), true);
    repo.putReceipt("p", "op", { id: "r" });
    db.close(); db = new DatabaseSync(path); repo = new AgentRepository(db);
    assert.equal(repo.recordUsage(usage), false);
    assert.deepEqual(repo.receipt("p", "op"), { id: "r" });
    assert.equal(db.prepare("SELECT count(*) AS n FROM secretary_agent_usage").get()?.n, 1);
    db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("future schema versions fail safely", () => {
  const db = new DatabaseSync(":memory:");
  try { db.exec("CREATE TABLE secretary_agent_schema(version INTEGER); INSERT INTO secretary_agent_schema VALUES(2)"); assert.throws(() => new AgentRepository(db), /schema version/); }
  finally { db.close(); }
});

test("parent locks exclude live owners, refuse unknown owners, and permit release", async () => {
  const root = await mkdtemp(join(tmpdir(), "secretary-lock-"));
  try {
    const release = await acquireParentLock(root, "parent/../../safe");
    await assert.rejects(acquireParentLock(root, "parent/../../safe"), /locked/);
    await release();
    const release2 = await acquireParentLock(root, "parent/../../safe"); await release2();
    await acquireParentLock(root, "unknown");
    const directory = (await readdir(root))[0];
    await writeFile(join(root, directory, "owner.json"), "{}");
    await assert.rejects(acquireParentLock(root, "unknown"), /Cannot prove/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parent locks recover only a proven dead child owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "secretary-lock-dead-"));
  try {
    const module = new URL("../../extensions/secretary/agents/storage/parent-lock.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { acquireParentLock } from ${JSON.stringify(module)}; await acquireParentLock(${JSON.stringify(root)}, "p");`], { stdio: "pipe" });
    const [code] = await once(child, "exit"); assert.equal(code, 0);
    const directory = (await readdir(root))[0];
    const previous = JSON.parse(await readFile(join(root, directory, "owner.json"), "utf8"));
    assert.equal(previous.pid, child.pid);
    const release = await acquireParentLock(root, "p"); await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
