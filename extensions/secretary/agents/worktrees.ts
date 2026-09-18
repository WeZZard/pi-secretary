import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, readFile, writeFile, lstat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorktreeRecord } from "./records.ts";
const exec = promisify(execFile);
interface Manifest { version: 1; agentId: string; record: WorktreeRecord; gitDir: string; commonDir: string }
export async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/.test(key)) delete env[key];
  }
  const { stdout } = await exec("git", ["-C", cwd, ...args], { signal, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env });
  return stdout.trim();
}

const git = runGit;

export class WorktreeManager {
  private readonly root: string;
  constructor(root: string) { this.root = root; }
  private async storage(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory()) throw new Error("Worktree storage must be a real directory");
    return realpath(this.root);
  }
  async captureBase(cwd: string): Promise<{ repo: string; baseCommit: string }> {
    const repo = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
    const baseCommit = await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
    return { repo, baseCommit };
  }
  async create(agentId: string, repo: string, baseCommit: string, signal?: AbortSignal): Promise<WorktreeRecord> {
    signal?.throwIfAborted();
    if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error("Worktree base must be a full commit ID");
    const source = await realpath(repo);
    if (await realpath(await git(source, ["rev-parse", "--show-toplevel"])) !== source) throw new Error("Repository must be its checkout root");
    if (await git(source, ["rev-parse", "--verify", `${baseCommit}^{commit}`]) !== baseCommit) throw new Error("Invalid base commit");
    const storage = await this.storage();
    const id = randomUUID();
    const record: WorktreeRecord = { kind: "git-worktree", id, repo: source, path: join(storage, id), branch: `secretary/${id}`, baseCommit, state: "allocated" };
    // Persist the allocation intent before Git can create anything. Failed allocations remain inspectable.
    const manifest: Manifest = { version: 1, agentId, record, gitDir: "", commonDir: await realpath(await git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) };
    await writeFile(join(storage, `${id}.json`), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await git(source, ["worktree", "add", "-b", record.branch, "--", record.path, baseCommit], signal);
    manifest.gitDir = await realpath(await git(record.path, ["rev-parse", "--absolute-git-dir"]));
    await writeFile(join(storage, `${id}.json`), JSON.stringify(manifest), { mode: 0o600 });
    signal?.throwIfAborted();
    await this.verify(record);
    return record;
  }
  private async manifest(record: WorktreeRecord): Promise<Manifest> {
    if (!/^[a-f0-9-]{36}$/.test(record.id)) throw new Error("Invalid worktree identifier");
    const storage = await this.storage();
    if (record.path !== join(storage, record.id)) throw new Error("Worktree path escapes owned storage");
    const path = join(storage, `${record.id}.json`);
    if (!(await lstat(path)).isFile()) throw new Error("Invalid ownership manifest");
    const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
    if (manifest.version !== 1 || !manifest.agentId || !manifest.gitDir || !manifest.commonDir) throw new Error("Unknown or incomplete worktree ownership manifest");
    for (const key of ["id", "repo", "path", "branch", "baseCommit"] as const) {
      if (manifest.record[key] !== record[key]) throw new Error(`Worktree ownership mismatch: ${key}`);
    }
    return manifest;
  }
  async verify(record: WorktreeRecord): Promise<void> {
    const manifest = await this.manifest(record);
    if (record.state === "removed") throw new Error("Worktree has been removed");
    if (!(await lstat(record.path)).isDirectory() || await realpath(record.path) !== record.path) throw new Error("Worktree was replaced by a symbolic link");
    if (!(await lstat(join(record.path, ".git"))).isFile()) throw new Error("Worktree metadata is not a linked checkout");
    const gitDir = await realpath(await git(record.path, ["rev-parse", "--absolute-git-dir"]));
    const commonDir = await realpath(await git(record.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    if (gitDir !== manifest.gitDir || commonDir !== manifest.commonDir || await realpath(await git(record.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== commonDir) throw new Error("Worktree Git ownership mismatch");
    if (await realpath(await git(record.path, ["rev-parse", "--show-toplevel"])) !== record.path) throw new Error("Worktree root mismatch");
    if (await git(record.path, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${record.branch}`) throw new Error("Worktree branch changed");
    const backlink = (await readFile(join(gitDir, "gitdir"), "utf8")).trim();
    if (resolve(backlink) !== join(record.path, ".git")) throw new Error("Worktree backlink mismatch");
    const registered = (await git(record.repo, ["worktree", "list", "--porcelain", "-z"])).split("\0");
    if (!registered.includes(`worktree ${record.path}`)) throw new Error("Worktree is not registered with its repository");
  }
  async cleanup(record: WorktreeRecord): Promise<void> {
    await this.verify(record);
    if (await git(record.path, ["rev-parse", "HEAD"]) !== record.baseCommit || await git(record.repo, ["rev-parse", "--verify", `refs/heads/${record.branch}`]) !== record.baseCommit) throw new Error("Worktree contains retained commits");
    const index = await git(record.path, ["ls-files", "-v", "-z"]);
    if (index.split("\0").some(entry => entry && (entry[0] === "S" || /^[a-z]/.test(entry)))) throw new Error("Worktree has index flags that can hide tracked changes");
    const status = await git(record.path, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]);
    if (status) throw new Error("Worktree contains tracked, untracked, ignored, or submodule changes");
    const submodules = await git(record.path, ["submodule", "status", "--recursive"]);
    // Git cannot safely remove initialized submodules without force. Retain them, even when clean.
    if (submodules) throw new Error("Worktree contains submodules and requires manual cleanup");
    await this.verify(record);
    await git(record.repo, ["worktree", "remove", "--", record.path]);
    // Compare-and-delete refuses to discard a branch that moved after the clean check.
    await git(record.repo, ["update-ref", "-d", `refs/heads/${record.branch}`, record.baseCommit]);
    await unlink(join(await this.storage(), `${record.id}.json`));
  }
}
