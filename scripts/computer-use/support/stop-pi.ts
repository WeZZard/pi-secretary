/**
 * Stops the Pi process of one live delegation and waits for its relay leases to finish (evaluation
 * design §3). A lease is finished when the relay has written its lifecycle record.
 */
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface StopOptions {
  /** The relay leases that have not finished yet. */
  unfinished: () => string[];
  /** How long to wait for the leases to finish. */
  leaseWaitMs: number;
  /** How long Pi gets to exit after SIGTERM. */
  exitGraceMs: number;
  pollMs: number;
}

/**
 * The relay leases in a project's relay-evidence folder, and whether each has its lifecycle record.
 * A lease that acquired a machine has the relay's host configuration; a refused acquisition has only events.
 */
export function relayLeases(evidence: string): { name: string; finished: boolean }[] {
  if (!existsSync(evidence)) return [];
  return readdirSync(evidence).filter(name => existsSync(join(evidence, name, "host", "mcp-host-config.json")))
    .map(name => ({ name, finished: existsSync(join(evidence, `${name}.lifecycle.json`)) }));
}

const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

/**
 * The child's backend finishes its lease while Pi runs: after the child session ends, it runs the
 * checks, writes their record and calls `relay_finish`, and `relay_release` if the finish fails. So
 * Pi is stopped only after every lease has finished, or at the deadline. On 2026-09-26 the runner
 * stopped Pi as soon as the check record existed; the finish failed after Pi had exited, and the
 * fallback release was never sent (troubleshooting, incident A).
 */
export async function stopPi(child: ChildProcess, options: StopOptions): Promise<{ unfinished: string[] }> {
  for (const deadline = Date.now() + options.leaseWaitMs; options.unfinished().length && Date.now() < deadline;) await wait(options.pollMs);
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(done => child.once("exit", () => done()));
  child.stdin?.end();
  child.kill("SIGTERM");
  // Pi's own SIGTERM handler disposes its sessions before it exits; a Pi that outlasts the grace period is killed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceEnded = await Promise.race([exited.then(() => false), new Promise<boolean>(done => { timer = setTimeout(() => done(true), options.exitGraceMs); })]);
  clearTimeout(timer);
  if (graceEnded) { child.kill("SIGKILL"); await exited; }
  return { unfinished: options.unfinished() };
}
