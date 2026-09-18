import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkspaceManager } from "../../extensions/secretary/agents/workspaces.ts";
import { runGit } from "../../extensions/secretary/agents/worktrees.ts";
import { resolveIsolation } from "../../extensions/secretary/agents/configuration.ts";
import { AgentService } from "../../extensions/secretary/agents/service.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { formatAgentOutcome } from "../../extensions/secretary/agents/presentation.ts";

type RepositoryState = "none" | "unborn" | "committed";
async function fixture(t: TestContext, state: RepositoryState) {
  const root = await mkdtemp(join(tmpdir(), "secretary-workspace-"));
  const project = join(root, "project"), storage = join(root, "state");
  await mkdir(project); await mkdir(storage);
  await writeFile(join(project, "fixture.txt"), "original project contents\n");
  await mkdir(join(project, "nested")); await writeFile(join(project, "nested", "file.txt"), "nested contents\n");
  if (state !== "none") await runGit(project, ["init", "-q"]);
  if (state === "committed") {
    await runGit(project, ["add", "."]);
    await runGit(project, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "initial"]);
  }
  const manager = new WorkspaceManager(storage);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, project, storage, manager };
}

test("isolation precedence is invocation, definition, then shared directory", () => {
  assert.equal(resolveIsolation(undefined), "none");
  assert.equal(resolveIsolation(undefined, "worktree"), "worktree");
  assert.equal(resolveIsolation("none", "worktree"), "none");
  assert.equal(resolveIsolation("worktree", "none"), "worktree");
  assert.throws(() => resolveIsolation("remote"), /Unsupported/);
});

for (const state of ["none", "unborn", "committed"] as const) {
  test(`explicit isolation allocates the correct mechanism for ${state} repositories`, async t => {
    const f = await fixture(t, state);
    const plan = await f.manager.captureBase(f.project);
    const workspace = await f.manager.create("agent", plan);
    assert.notEqual(workspace.path, f.project);
    assert.equal(await readFile(join(workspace.path, "fixture.txt"), "utf8"), "original project contents\n");
    assert.equal(workspace.kind, state === "committed" ? "git-worktree" : "directory-snapshot");
    if (workspace.kind === "directory-snapshot") {
      assert.equal(workspace.reason, state === "none" ? "no-git" : "unborn-head");
      await assert.rejects(access(join(workspace.path, ".git")));
      assert.equal(workspace.baseCommit, undefined); assert.equal(workspace.branch, undefined);
      if (state === "none") await assert.rejects(access(join(f.project, ".git")));
      else await assert.rejects(runGit(f.project, ["rev-parse", "--verify", "HEAD"]));
    }
    await f.manager.verify(workspace);
    await writeFile(join(workspace.path, "fixture.txt"), "child changes\n");
    assert.equal(await readFile(join(f.project, "fixture.txt"), "utf8"), "original project contents\n");
    await assert.rejects(f.manager.cleanup(workspace), /changes/);
    await writeFile(join(workspace.path, "fixture.txt"), "original project contents\n");
    await f.manager.cleanup(workspace); await assert.rejects(access(workspace.path));
  });

  test(`default service launch shares the parent directory with ${state} repositories`, async t => {
    const f = await fixture(t, state); const db = new DatabaseSync(":memory:");
    const repository = new AgentRepository(db);
    let childCwd = "";
    const service = new AgentService({ parentId: "parent", root: f.storage, repository,
      ctx: { cwd: f.project, mode: "tui" } as ExtensionContext,
      config: { modelAliases: {}, maxConcurrent: 1, maxQueued: 1, shutdownTimeoutMs: 1000 },
      runner: async ({ agent }) => { childCwd = agent.cwd; return { result: Promise.resolve({ status: "succeeded", output: "done" }), steer: async () => {}, abort: async () => {}, dispose: async () => {} }; },
    });
    try {
      const launch = await service.launch({ launchKey: "launch", definition: { name: "worker", description: "Task", prompt: "", source: "fixture", hash: "hash", resumable: true }, model: "provider/model", tools: ["read"], prompt: "Read fixture.txt", description: "Read fixture", background: true });
      const completed = await service.wait(launch.run!.runId, 10000);
      assert.equal(completed.status, "succeeded"); assert.equal(childCwd, f.project);
      assert.equal(service.resolve(launch.agent.agentId).worktree, undefined);
      assert.equal(service.resolve(launch.agent.agentId).requestedWorktree, undefined);
      assert.match(formatAgentOutcome(completed, service.resolve(launch.agent.agentId)), /Isolation: none/);
      await assert.rejects(access(join(f.storage, "worktrees")));
      await assert.rejects(access(join(f.storage, "snapshots")));
    } finally { await service.shutdown(); db.close(); }
  });
}

test("unborn snapshot preserves the parent's relative working directory", async t => {
  const f = await fixture(t, "unborn");
  const plan = await f.manager.captureBase(join(f.project, "nested"));
  assert.equal(plan.relativeCwd, "nested");
  const snapshot = await f.manager.create("agent", plan);
  assert.equal(await readFile(join(snapshot.path, plan.relativeCwd!, "file.txt"), "utf8"), "nested contents\n");
});

test("snapshot rejects symlinks and corrupt Git metadata instead of hiding setup failures", async t => {
  const f = await fixture(t, "none");
  await symlink(join(f.project, "fixture.txt"), join(f.project, "link"));
  const plan = await f.manager.captureBase(f.project);
  await assert.rejects(f.manager.create("agent", plan), /symbolic links/);
  await rm(join(f.project, "link"));
  await writeFile(join(f.project, ".git"), "invalid Git metadata\n");
  await assert.rejects(f.manager.captureBase(f.project));
});

test("snapshot cleanup retains nested Git metadata and refuses a replaced snapshot path", async t => {
  const f = await fixture(t, "none");
  const snapshot = await f.manager.create("agent", await f.manager.captureBase(f.project));
  await mkdir(join(snapshot.path, "nested", ".git"));
  await writeFile(join(snapshot.path, "nested", ".git", "config"), "new repository\n");
  await assert.rejects(f.manager.cleanup(snapshot), /changes/);
  await access(join(snapshot.path, "nested", ".git", "config"));
  await rm(snapshot.path, { recursive: true });
  await symlink(f.project, snapshot.path);
  await assert.rejects(f.manager.verify(snapshot), /symbolic link|missing|replaced/);
  assert.equal(await readFile(join(f.project, "fixture.txt"), "utf8"), "original project contents\n");
});
