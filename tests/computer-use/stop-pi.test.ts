import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test, type TestContext } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayLeases, stopPi } from "../../scripts/computer-use/support/stop-pi.ts";

/**
 * Evaluation design §3: the runner stops Pi only after its relay leases finish. On 2026-09-26 the
 * runner stopped Pi while the child's backend was still finishing a lease, so the fallback release
 * after a failed finish was never sent and the machine stayed leased (troubleshooting, incident A).
 */

/** A fake Pi. On SIGTERM it records whether the lease had finished, then exits unless told to ignore the signal. */
async function fakePi(t: TestContext, options: { ignoreTerm?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "secretary-stop-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycle = join(root, "lease.lifecycle.json");
  const record = join(root, "sigterm.json");
  const abortRecord = join(root, "abort.json");
  const script = `let input = "";
process.stdin.on("data", chunk => {
  input += chunk;
  if (input.includes('"type":"abort"') && !require("node:fs").existsSync(${JSON.stringify(abortRecord)})) {
    require("node:fs").writeFileSync(${JSON.stringify(abortRecord)}, JSON.stringify({ leaseFinished: require("node:fs").existsSync(${JSON.stringify(lifecycle)}) }));
  }
});
process.on("SIGTERM", () => {
  require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ leaseFinished: require("node:fs").existsSync(${JSON.stringify(lifecycle)}) }));
  if (!${Boolean(options.ignoreTerm)}) process.exit(143);
});
setInterval(() => {}, 1000);
process.stdout.write("ready");`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise(ready => child.stdout!.once("data", ready));
  return { child, lifecycle, record, abortRecord };
}

test("Pi is stopped only after its relay lease has finished", async t => {
  const { child, lifecycle, record } = await fakePi(t);
  // The child's backend finishes the lease a moment after the runner decides the run is over.
  setTimeout(() => { void writeFile(lifecycle, "{}"); }, 1000);
  const result = await stopPi(child, { unfinished: () => existsSync(lifecycle) ? [] : ["lease"], leaseWaitMs: 10_000, exitGraceMs: 2000, pollMs: 100 });
  assert.deepEqual(result.unfinished, []);
  assert.deepEqual(JSON.parse(await readFile(record, "utf8")), { leaseFinished: true }, "SIGTERM came after the lease finished");
});

test("a lease that never finishes delays the stop only until its deadline", async t => {
  const { child, lifecycle, record } = await fakePi(t);
  const started = Date.now();
  const result = await stopPi(child, { unfinished: () => existsSync(lifecycle) ? [] : ["lease"], leaseWaitMs: 1000, exitGraceMs: 2000, pollMs: 100 });
  assert.deepEqual(result.unfinished, ["lease"]);
  assert.ok(existsSync(record), "Pi got SIGTERM at the deadline");
  assert.ok(Date.now() - started < 8000);
});

test("a Pi that does not exit after SIGTERM is killed after its grace period", async t => {
  const { child, lifecycle } = await fakePi(t, { ignoreTerm: true });
  await writeFile(lifecycle, "{}");
  await stopPi(child, { unfinished: () => [], leaseWaitMs: 1000, exitGraceMs: 1000, pollMs: 100 });
  assert.equal(child.signalCode, "SIGKILL", "Pi was killed");
});

test("Pi is told to abort its work before the runner waits for the leases, so it starts no new lease meanwhile", async t => {
  // On 2026-09-27 the runner waited for one lease, and meanwhile the parent delegated again; that lease was not waited for.
  const { child, lifecycle, abortRecord } = await fakePi(t);
  setTimeout(() => { void writeFile(lifecycle, "{}"); }, 1000);
  await stopPi(child, { unfinished: () => existsSync(lifecycle) ? [] : ["lease"], leaseWaitMs: 10_000, exitGraceMs: 2000, pollMs: 100 });
  assert.deepEqual(JSON.parse(await readFile(abortRecord, "utf8").catch(() => "null")), { leaseFinished: false }, "The abort came before the wait ended");
});

test("a lease that was staged is waited for even when it never started the relay's MCP host", async t => {
  const root = await mkdtemp(join(tmpdir(), "secretary-relay-leases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lease = async (name: string, kinds: string[], files: { hostConfig?: boolean; lifecycle?: boolean } = {}) => {
    await mkdir(join(root, name, "host", "events"), { recursive: true });
    for (const [index, kind] of kinds.entries()) await writeFile(join(root, name, "host", "events", `${1000 + index}-${kind}.json`), JSON.stringify({ kind, at: "2026-09-27T05:43:09.370Z" }));
    if (files.hostConfig) await writeFile(join(root, name, "host", "mcp-host-config.json"), "{}");
    if (files.lifecycle) await writeFile(join(root, `${name}.lifecycle.json`), "{}");
  };
  // Observed on 2026-09-27: a lease used only through relay_exec and relay_code has no MCP host configuration.
  await lease("relay-computer-use-staged", ["acquire-intent", "stage", "renewal-paused"]);
  await lease("relay-computer-use-refused", ["acquire-intent", "operation-failed", "renewal-paused"]);
  await lease("relay-computer-use-done", ["acquire-intent", "stage", "finish"], { hostConfig: true, lifecycle: true });
  assert.deepEqual(relayLeases(root).sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "relay-computer-use-done", finished: true }, { name: "relay-computer-use-staged", finished: false }]);
});
