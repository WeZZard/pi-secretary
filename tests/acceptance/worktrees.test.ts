import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentService, type LaunchSpec } from "../../extensions/secretary/agents/service.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { WorktreeManager } from "../../extensions/secretary/agents/worktrees.ts";
import { formatAgentOutcome } from "../../extensions/secretary/agents/presentation.ts";
import type { RunningChild, WorktreeRecord } from "../../extensions/secretary/agents/records.ts";
import { deferred, runFeatures, tick, type ScenarioBindings } from "./support.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await exec("git", ["-C", cwd, ...args])).stdout.trim(); }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "secretary-bdd-worktree-"));
  const artifacts = await mkdtemp(join(tmpdir(), "secretary-bdd-artifacts-"));
  await git(root, "init");
  await git(root, "config", "user.name", "Acceptance Test");
  await git(root, "config", "user.email", "acceptance@example.invalid");
  await writeFile(join(root, "tracked"), "base\n");
  await writeFile(join(root, "second"), "second\n");
  await writeFile(join(root, ".gitignore"), "ignored\n");
  await git(root, "add", "."); await git(root, "commit", "-m", "base");
  const db = new DatabaseSync(":memory:");
  const repo = new AgentRepository(db);
  const holds = new Map<string, ReturnType<typeof deferred<Awaited<RunningChild["result"]>>>>();
  const starts = new Map<string, ReturnType<typeof deferred<void>>>();
  const service = new AgentService({ parentId: "parent", root: artifacts, repository: repo,
    config: { modelAliases: {}, maxConcurrent: 1, maxQueued: 8, shutdownTimeoutMs: 1000 },
    ctx: { cwd: root, mode: "tui" } as ExtensionContext,
    runner: async ({ agent, run, hooks }) => {
      const session = join(artifacts, `${agent.agentId}.jsonl`);
      await writeFile(session, JSON.stringify({ type: "session", id: agent.agentId }) + "\n");
      hooks.session(session); starts.get(run.launchKey)?.resolve();
      const hold = holds.get(run.launchKey);
      return { result: hold?.promise ?? Promise.resolve({ status: "succeeded", output: "Worktree fixture finished." }),
        steer: async () => {}, dispose: async () => {},
        abort: async () => { hold?.resolve({ status: "cancelled", output: "cancelled" }); } };
    },
  });
  const spec = (key = "worktree"): LaunchSpec => ({ launchKey: key,
    definition: { name: "worker", description: "Worker", prompt: "Work", source: "fixture", hash: "fixture", resumable: true },
    model: "fixture/model", tools: ["read"], prompt: "Inspect this checkout", description: "Inspect checkout", isolation: "worktree", background: true });
  t.after(async () => { await service.shutdown(); db.close(); await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); });
  async function launch(key = "worktree") {
    const accepted = await service.launch(spec(key));
    const outcome = await service.wait(accepted.run!.runId, 10000);
    assert.equal(outcome.status, "succeeded", outcome.error ?? "Run did not succeed");
    return service.resolve(accepted.agent.agentId);
  }
  return { root, artifacts, repo, service, spec, holds, starts, launch };
}

const bindings: ScenarioBindings = {
  "ACC-SA-06-01": async ({ t }) => {
    const f = await fixture(t); const agent = await f.launch();
    assert.ok(agent.worktree); assert.ok(agent.worktree.kind !== "directory-snapshot"); assert.notEqual(agent.cwd, f.root);
    assert.equal(await git(agent.cwd, "rev-parse", "HEAD"), agent.worktree.baseCommit);
    assert.equal(await git(agent.cwd, "branch", "--show-current"), agent.worktree.branch);
    assert.equal(f.service.list()[0].agent.worktree!.path, agent.cwd);
    const display = formatAgentOutcome(f.service.run(agent.agentId), agent);
    for (const value of [agent.cwd, agent.worktree.branch, agent.worktree.baseCommit]) assert.ok(display.includes(value));
    assert.match(display, /not a security sandbox/);
  },
  "ACC-SA-06-02": async ({ t }) => {
    const f = await fixture(t);
    await writeFile(join(f.root, "tracked"), "staged parent\n"); await git(f.root, "add", "tracked");
    await writeFile(join(f.root, "second"), "unstaged parent\n"); await writeFile(join(f.root, "untracked"), "new parent\n");
    const before = await git(f.root, "status", "--porcelain=v1");
    const head = await git(f.root, "rev-parse", "HEAD"); const stash = await git(f.root, "stash", "list");
    const agent = await f.launch();
    assert.equal(await readFile(join(agent.cwd, "tracked"), "utf8"), "base\n");
    assert.equal(await readFile(join(agent.cwd, "second"), "utf8"), "second\n");
    await assert.rejects(access(join(agent.cwd, "untracked")));
    assert.equal(await git(f.root, "status", "--porcelain=v1"), before);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), head); assert.equal(await git(f.root, "stash", "list"), stash);
    assert.match(formatAgentOutcome(f.service.run(agent.agentId), agent), /Uncommitted parent changes are excluded/);
  },
  "ACC-SA-06-03": async ({ t }) => {
    const f = await fixture(t);
    const hold = deferred<Awaited<RunningChild["result"]>>(); const started = deferred<void>();
    f.holds.set("first", hold); f.starts.set("first", started);
    await f.service.launch({ ...f.spec("first"), isolation: undefined }); await started.promise;
    const head = await git(f.root, "rev-parse", "HEAD");
    const queued = await f.service.launch(f.spec("queued")); assert.equal(queued.run!.status, "queued");
    await writeFile(join(f.root, "tracked"), "commit B\n"); await git(f.root, "commit", "-am", "B");
    hold.resolve({ status: "succeeded", output: "Finished blocker." });
    const outcome = await f.service.wait(queued.run!.runId, 10000); assert.equal(outcome.status, "succeeded", outcome.error ?? "Run did not succeed");
    const agent = f.service.resolve(queued.agent.agentId);
    assert.equal(agent.worktree!.baseCommit, head);
    assert.equal(await git(agent.cwd, "rev-parse", "HEAD"), head);
    assert.notEqual(await git(f.root, "rev-parse", "HEAD"), head);
  },
  "ACC-SA-06-04": async ({ t, text }) => {
    const f = await fixture(t);
    let sub: Awaited<ReturnType<typeof fixture>> | undefined;
    if (text.includes("changed submodule state")) {
      sub = await fixture(t);
      await git(f.root, "-c", "protocol.file.allow=always", "submodule", "add", sub.root, "sub");
      await git(f.root, "commit", "-am", "submodule");
    }
    const agent = await f.launch(); const record = agent.worktree!;
    const head = await git(f.root, "rev-parse", "HEAD");
    let target = "tracked";
    if (text.includes("untracked files")) target = "untracked";
    if (text.includes("ignored files")) target = "ignored";
    if (sub) {
      await git(agent.cwd, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
      await writeFile(join(agent.cwd, "sub", "tracked"), "valuable submodule change\n");
    } else {
      await writeFile(join(agent.cwd, target), "valuable child changes\n");
      if (text.includes("with staged modifications") || text.includes("commits beyond")) await git(agent.cwd, "add", target);
      if (text.includes("commits beyond")) await git(agent.cwd, "commit", "-m", "child commit");
    }
    const childHead = await git(agent.cwd, "rev-parse", "HEAD");
    await assert.rejects(f.service.cleanup(agent.agentId, "cleanup"), /changes|commits|submodule/);
    await access(record.path);
    assert.equal(await git(agent.cwd, "rev-parse", "HEAD"), childHead);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), head);
    assert.match(await readFile(join(agent.cwd, sub ? "sub/tracked" : target), "utf8"), /valuable/);
  },
  "ACC-SA-06-05": async ({ t }) => {
    const f = await fixture(t); const agent = await f.launch(); const run = f.service.run(agent.agentId);
    await f.service.cleanup(agent.agentId, "confirmed-cleanup");
    await assert.rejects(access(agent.cwd));
    assert.equal(f.service.resolve(agent.agentId).resumable, false);
    assert.equal(f.service.run(run.runId).status, "succeeded");
    await access(run.outputPath); await access(agent.sessionPath!);
    await assert.rejects(f.service.message(agent.agentId, "continue", "resume"), /not resumable/);
  },
  "ACC-SA-06-06": async ({ t }) => {
    const f = await fixture(t); const agent = await f.launch();
    const hold = deferred<Awaited<RunningChild["result"]>>();
    f.holds.set("message:resume", hold);
    const resumed = await f.service.message(agent.agentId, "continue", "resume");
    await assert.rejects(f.service.cleanup(agent.agentId, "stale-confirmation"), /active/);
    await access(agent.cwd); assert.ok(!["cancelled", "failed"].includes(f.service.run(resumed.runId).status));
    hold.resolve({ status: "succeeded", output: "done" });
  },
  "ACC-SA-06-07": async ({ t }) => {
    const f = await fixture(t); const agent = await f.launch();
    const entered = deferred<void>(); const release = deferred<void>();
    const original = WorktreeManager.prototype.cleanup;
    t.mock.method(WorktreeManager.prototype, "cleanup", async function(this: WorktreeManager, record: WorktreeRecord) {
      entered.resolve(); await release.promise; return original.call(this, record);
    });
    const cleanup = f.service.cleanup(agent.agentId, "cleanup"); await entered.promise;
    await assert.rejects(f.service.message(agent.agentId, "continue", "resume"), /cleanup/);
    assert.equal(f.repo.runs("parent").length, 1);
    release.resolve(); await cleanup;
  },
  "ACC-SA-06-08": async ({ t }) => {
    const f = await fixture(t); const agent = await f.launch();
    const retained = f.repo.getAgent(agent.agentId)!; retained.worktree!.state = "cleaning"; f.repo.putAgent(retained);
    await rm(join(f.artifacts, "worktrees", `${agent.worktree!.id}.json`));
    await f.service.recover();
    assert.equal(f.service.list()[0].agent.worktree!.state, "uncertain");
    await assert.rejects(f.service.message(agent.agentId, "continue", "resume"), /cleanup/);
    assert.equal(f.repo.runs("parent").length, 1);
    await access(f.root); await access(agent.cwd);
  },
  "ACC-SA-06-09": async ({ t }) => {
    const f = await fixture(t); const agent = await f.launch();
    const manifest = join(f.artifacts, "worktrees", `${agent.worktree!.id}.json`);
    await rm(manifest);
    await assert.rejects(f.service.cleanup(agent.agentId, "cleanup"), /ENOENT|ownership|manifest/);
    await access(agent.cwd);
    assert.equal(await git(agent.cwd, "branch", "--show-current"), agent.worktree!.branch);
  },
};

runFeatures(["worktree-isolation"], bindings, {
  "worktree-isolation": "0b88d1aa180d13d08b7e6b59efca903cd4cc0cba38e589bb275be466aa1ff101",
});
