import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, realpath, readFile, writeFile, lstat, readdir, rm, unlink, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, dirname, isAbsolute } from "node:path";
import { WorktreeManager, runGit } from "./worktrees.ts";
import type { DirectorySnapshotRecord, WorkspacePlan, WorkspaceRecord } from "./records.ts";

interface InventoryEntry { path: string; type: "file" | "directory"; mode: number; hash?: string; size?: number }
interface SnapshotManifest { version: 1; agentId: string; record: DirectorySnapshotRecord; inventory: InventoryEntry[] }
const MAX_FILES = 10000, MAX_BYTES = 128 * 1024 * 1024;
function inside(root: string, path: string) {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith("../") && !isAbsolute(part));
}
async function hasGitMarker(cwd: string): Promise<boolean> {
  let path = cwd;
  for (;;) {
    try { await lstat(join(path, ".git")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(path); if (parent === path) return false; path = parent;
  }
}
async function inventory(root: string, signal?: AbortSignal, skipGit = true): Promise<InventoryEntry[]> {
  const result: InventoryEntry[] = [];
  let files = 0, bytes = 0;
  async function visit(path: string, prefix: string) {
    signal?.throwIfAborted();
    for (const name of (await readdir(path)).sort()) {
      if (skipGit && name === ".git") continue;
      const file = join(path, name), key = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Directory snapshot cannot safely copy symbolic links or special files: ${key}`);
      if (stat.isDirectory()) {
        result.push({ path: key, type: "directory", mode: stat.mode & 0o777 });
        if (result.length > MAX_FILES * 2) throw new Error("Directory snapshot contains too many entries");
        await visit(file, key);
      } else {
        if (++files > MAX_FILES || (bytes += stat.size) > MAX_BYTES) throw new Error("Directory snapshot exceeds 10000 files or 128 MiB");
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error(`Source changed while snapshotting: ${key}`);
          const content = Buffer.alloc(stat.size + 1);
          let length = 0;
          while (length < content.length) {
            signal?.throwIfAborted();
            const read = await handle.read(content, length, content.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          const after = await lstat(file);
          if (after.isSymbolicLink() || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || length !== stat.size) throw new Error(`Source changed while snapshotting: ${key}`);
          result.push({ path: key, type: "file", mode: stat.mode & 0o777, size: stat.size, hash: createHash("sha256").update(content.subarray(0, length)).digest("hex") });
        } finally { await handle.close(); }
      }
    }
  }
  await visit(root, ""); return result;
}

/** Selects an explicit isolation mechanism without modifying the source project's Git state. */
export class WorkspaceManager {
  private readonly git: WorktreeManager;
  private readonly snapshots: string;
  constructor(root: string) { this.git = new WorktreeManager(join(root, "worktrees")); this.snapshots = join(root, "snapshots"); }
  async captureBase(cwd: string): Promise<WorkspacePlan> {
    const source = await realpath(cwd);
    let repo: string;
    try { repo = await realpath(await runGit(source, ["rev-parse", "--show-toplevel"])); }
    catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (await hasGitMarker(source) || (failure.code !== "ENOENT" && !/not a git repository/i.test(failure.stderr ?? ""))) throw error;
      return { kind: "directory-snapshot", repo: source, reason: "no-git", relativeCwd: "" };
    }
    try {
      const baseCommit = await runGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
      return { kind: "git-worktree", repo, baseCommit, relativeCwd: relative(repo, source) };
    } catch (error) {
      const ref = await runGit(repo, ["symbolic-ref", "--quiet", "HEAD"]);
      if (!ref.startsWith("refs/heads/")) throw error;
      try { await runGit(repo, ["show-ref", "--verify", "--quiet", ref]); }
      catch (missing) {
        if ((missing as { code?: number }).code === 1) return { kind: "directory-snapshot", repo, reason: "unborn-head", relativeCwd: relative(repo, source) };
        throw missing;
      }
      throw error;
    }
  }
  async create(agentId: string, plan: WorkspacePlan, signal?: AbortSignal): Promise<WorkspaceRecord> {
    if (plan.kind !== "directory-snapshot") return this.git.create(agentId, plan.repo, plan.baseCommit, signal);
    signal?.throwIfAborted();
    const source = await realpath(plan.repo);
    await mkdir(this.snapshots, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.snapshots)).isDirectory()) throw new Error("Snapshot storage must be a real directory");
    const storage = await realpath(this.snapshots);
    if (inside(source, storage)) throw new Error("Directory snapshot storage must be outside the source project");
    const baseline = await inventory(source, signal);
    const id = randomUUID();
    const record: DirectorySnapshotRecord = { kind: "directory-snapshot", id, repo: source, path: join(storage, id), reason: plan.reason, state: "allocated" };
    const manifest: SnapshotManifest = { version: 1, agentId, record, inventory: baseline };
    await writeFile(join(storage, `${id}.json`), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await mkdir(record.path, { mode: 0o700 });
    await cp(source, record.path, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true,
      filter: path => { signal?.throwIfAborted(); return path === source || !relative(source, path).split(/[\\/]/).includes(".git"); } });
    signal?.throwIfAborted();
    const copied = await inventory(record.path, signal), after = await inventory(source, signal);
    if (JSON.stringify(baseline) !== JSON.stringify(copied) || JSON.stringify(baseline) !== JSON.stringify(after)) throw new Error("Source changed during directory snapshot creation; retained incomplete allocation for inspection");
    return record;
  }
  private async snapshotManifest(record: DirectorySnapshotRecord): Promise<SnapshotManifest> {
    if (!/^[a-f0-9-]{36}$/.test(record.id)) throw new Error("Invalid snapshot identity");
    const storage = await realpath(this.snapshots);
    if (!(await lstat(this.snapshots)).isDirectory() || record.path !== join(storage, record.id)) throw new Error("Snapshot storage or path ownership mismatch");
    const path = join(storage, `${record.id}.json`);
    if (!(await lstat(path)).isFile()) throw new Error("Snapshot manifest is not an owned regular file");
    const manifest = JSON.parse(await readFile(path, "utf8")) as SnapshotManifest;
    if (manifest.version !== 1 || !manifest.agentId || manifest.record.kind !== "directory-snapshot" || !Array.isArray(manifest.inventory)) throw new Error("Invalid snapshot manifest");
    for (const key of ["id", "repo", "path", "reason"] as const) if (manifest.record[key] !== record[key]) throw new Error(`Snapshot ownership mismatch: ${key}`);
    return manifest;
  }
  async verify(record: WorkspaceRecord): Promise<void> {
    if (record.kind !== "directory-snapshot") return this.git.verify(record);
    await this.snapshotManifest(record);
    if (record.state === "removed" || !(await lstat(record.path)).isDirectory() || await realpath(record.path) !== record.path) throw new Error("Snapshot is missing, removed, or replaced by a symbolic link");
  }
  async cleanup(record: WorkspaceRecord): Promise<void> {
    if (record.kind !== "directory-snapshot") return this.git.cleanup(record);
    await this.verify(record);
    const manifest = await this.snapshotManifest(record);
    // A new .git directory is also a user change and must never be silently discarded.
    try { await lstat(join(record.path, ".git")); throw new Error("Snapshot contains new Git metadata; retain it for review"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (JSON.stringify(await inventory(record.path, undefined, false)) !== JSON.stringify(manifest.inventory)) throw new Error("Snapshot contains changes and is retained for review");
    await this.verify(record);
    await rm(record.path, { recursive: true });
    await unlink(join(await realpath(this.snapshots), `${record.id}.json`));
  }
}
