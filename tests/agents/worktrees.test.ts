import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeManager } from "../../extensions/secretary/agents/worktrees.ts";
const exec = promisify(execFile);
async function git(repo: string, ...args: string[]): Promise<string> { return (await exec("git", ["-C", repo, ...args])).stdout.trim(); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "secretary-worktrees-"));
  await git(root, "init");
  await git(root, "config", "user.name", "Test"); await git(root, "config", "user.email", "test@example.invalid");
  await writeFile(join(root, "tracked"), "base\n"); await writeFile(join(root, ".gitignore"), "ignored\n");
  await git(root, "add", "."); await git(root, "commit", "-m", "base");
  const storage = await mkdtemp(join(tmpdir(), "secretary-managed-"));
  const manager = new WorktreeManager(storage);
  const base = await manager.captureBase(root);
  return { root, storage, manager, base, dispose: async () => { await rm(root, { recursive: true, force: true }); await rm(storage, { recursive: true, force: true }); } };
}

test("captured base excludes parent changes and survives parent HEAD movement", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "tracked"), "new parent commit\n"); await git(f.root, "add", "."); await git(f.root, "commit", "-m", "move parent");
    await writeFile(join(f.root, "tracked"), "dirty parent\n");
    const record = await f.manager.create("agent", f.base.repo, f.base.baseCommit);
    assert.equal(await readFile(join(record.path, "tracked"), "utf8"), "base\n");
    assert.equal(await readFile(join(f.root, "tracked"), "utf8"), "dirty parent\n");
    await f.manager.verify(record); await f.manager.cleanup({ ...record, state: "cleaning" });
    await assert.rejects(access(record.path));
    await assert.rejects(git(f.root, "rev-parse", "--verify", `refs/heads/${record.branch}`));
    assert.equal(await readFile(join(f.root, "tracked"), "utf8"), "dirty parent\n");
  } finally { await f.dispose(); }
});

for (const kind of ["unstaged", "staged", "untracked", "ignored", "commit"] as const) {
  test(`cleanup retains ${kind} changes`, async () => {
    const f = await fixture();
    try {
      const record = await f.manager.create("agent", f.base.repo, f.base.baseCommit);
      const file = kind === "untracked" ? "untracked" : kind === "ignored" ? "ignored" : "tracked";
      await writeFile(join(record.path, file), "valuable\n");
      if (kind === "staged" || kind === "commit") await git(record.path, "add", file);
      if (kind === "commit") await git(record.path, "commit", "-m", "agent result");
      await assert.rejects(f.manager.cleanup(record), /changes|commits/);
      assert.equal(await readFile(join(record.path, file), "utf8"), "valuable\n");
      await f.manager.verify(record);
    } finally { await f.dispose(); }
  });
}

test("ownership mismatches, changed branch, symlink paths, and missing manifests are refused", async () => {
  const f = await fixture();
  try {
    const record = await f.manager.create("agent", f.base.repo, f.base.baseCommit);
    await assert.rejects(f.manager.verify({ ...record, baseCommit: "0".repeat(40) }), /ownership/);
    await assert.rejects(f.manager.cleanup({ ...record, path: f.root }), /escapes/);
    await git(record.path, "checkout", "--detach"); await assert.rejects(f.manager.verify(record));
    await git(record.path, "checkout", record.branch);
    await rm(join(f.storage, `${record.id}.json`)); await assert.rejects(f.manager.cleanup(record));
    await access(record.path);
    const alternate = join(f.storage, "alias"); await symlink(f.storage, alternate);
    await assert.rejects(new WorktreeManager(alternate).create("agent", f.base.repo, f.base.baseCommit), /real directory/);
  } finally { await f.dispose(); }
});

test("cleanup refuses index flags that hide tracked changes", async () => {
  const f = await fixture();
  try {
    const record = await f.manager.create("agent", f.base.repo, f.base.baseCommit);
    await git(record.path, "update-index", "--assume-unchanged", "tracked");
    await writeFile(join(record.path, "tracked"), "hidden changes\n");
    await assert.rejects(f.manager.cleanup(record), /index flags/);
    assert.equal(await readFile(join(record.path, "tracked"), "utf8"), "hidden changes\n");
  } finally { await f.dispose(); }
});

test("allocation validates base and cancellation before creating a branch", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.manager.create("agent", f.base.repo, "--bad"), /full commit/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.manager.create("agent", f.base.repo, f.base.baseCommit, controller.signal));
    assert.equal(await git(f.root, "for-each-ref", "refs/heads/secretary"), "");
  } finally { await f.dispose(); }
});

test("cleanup refuses submodules without deleting their contents", async () => {
  const f = await fixture(); const sub = await fixture();
  try {
    await git(f.root, "-c", "protocol.file.allow=always", "submodule", "add", sub.root, "sub");
    await git(f.root, "commit", "-am", "submodule");
    const base = await f.manager.captureBase(f.root);
    const record = await f.manager.create("agent", base.repo, base.baseCommit);
    await assert.rejects(f.manager.cleanup(record), /submodules/);
    await access(record.path);
  } finally { await f.dispose(); await sub.dispose(); }
});
