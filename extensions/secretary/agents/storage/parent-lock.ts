import { mkdir, readFile, writeFile, unlink, rmdir, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
interface Owner { version: 1; pid: number; start: string; host: string; nonce: string }
async function startIdentity(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return `${boot}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
  }
  const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="]);
  if (!stdout.trim()) throw new Error("Cannot establish lock owner process identity");
  return stdout.trim();
}
function dead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
async function readOwner(path: string): Promise<Owner> {
  if (!(await lstat(path)).isFile()) throw new Error("Invalid owner lock metadata");
  const value = JSON.parse(await readFile(path, "utf8")) as Owner;
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || !value.start || !value.nonce || value.host !== hostname()) throw new Error("Cannot prove local lock ownership");
  return value;
}

export async function acquireParentLock(root: string, parentId: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(await realpath(root), `parent-${createHash("sha256").update(parentId).digest("hex")}.lock`);
  const ownerPath = join(directory, "owner.json");
  let released = false;
  const owner: Owner = { version: 1, pid: process.pid, start: await startIdentity(process.pid), host: hostname(), nonce: randomUUID() };
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid parent lock directory");
    const previous = await readOwner(ownerPath);
    if (!dead(previous.pid)) {
      const identity = await startIdentity(previous.pid);
      // A mismatched identity can mean PID reuse, but a live PID is deliberately not reclaimed.
      throw new Error(`Parent is locked by process ${previous.pid}${identity !== previous.start ? " (identity changed; manual recovery required)" : ""}`);
    }
    const claim = join(directory, "reclaim");
    await mkdir(claim, { mode: 0o700 });
    // Only this reclaimer can modify the dead owner's directory. A crashed reclaimer is refused.
    const checked = await readOwner(ownerPath);
    if (checked.nonce !== previous.nonce || !dead(checked.pid)) throw new Error("Parent lock changed during recovery");
    await unlink(ownerPath);
    await writeFile(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    await rmdir(claim);
    return release;
  }
  await writeFile(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  return release;

  async function release(): Promise<void> {
    if (released) return;
    const current = await readOwner(ownerPath);
    if (current.nonce !== owner.nonce || current.pid !== owner.pid || current.start !== owner.start) throw new Error("Refusing to release a foreign parent lock");
    await unlink(ownerPath);
    await rmdir(directory);
    released = true;
  }
}
