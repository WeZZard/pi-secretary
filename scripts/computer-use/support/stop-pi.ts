/**
 * Stops the Pi process of one live delegation and waits for its relay leases to finish (evaluation
 * design §3). A lease is finished when the relay has written its lifecycle record.
 */
import type { ChildProcess } from "node:child_process";

export interface StopOptions {
  /** The relay leases that have not finished yet. */
  unfinished: () => string[];
  /** How long to wait for the leases to finish. */
  leaseWaitMs: number;
  /** How long Pi gets to exit after SIGTERM. */
  exitGraceMs: number;
  pollMs: number;
}

const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

export async function stopPi(child: ChildProcess, options: StopOptions): Promise<{ unfinished: string[] }> {
  child.stdin?.end();
  child.kill("SIGTERM");
  await wait(3000);
  // The relay server finishes a lease after the agent's session ends, which can outlast Pi by minutes.
  for (const deadline = Date.now() + options.leaseWaitMs; options.unfinished().length && Date.now() < deadline;) await wait(options.pollMs);
  return { unfinished: options.unfinished() };
}
