/**
 * Plan Phase 7 live check: the relay client in a fresh relay virtual machine. It opens Calculator,
 * times reads and clicks, and runs a scripted plan through the real harness and executor.
 * Records go to a new directory under test-results/.
 *
 *   node --experimental-strip-types scripts/computer-use/relay-live.ts [image] [reads] [executor-url]
 *
 * Formulas, one per quantity:
 * - relay read time, ms: wall clock from calling readWindow to its return, with a screenshot, on a
 *   window already read once (so no warm-up read is included).
 * - relay action time, ms: wall clock of one backend act call, including every relay run it makes
 *   and the relay's own before and after display screenshots of each.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExecutionBackend } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { RelayBackend, stdioRelayConnect } from "../../extensions/secretary/computer-use/backend/relay-client.ts";
import { DEFAULT_RELAY_COMMAND, defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import { ExecutorClient } from "../../extensions/secretary/computer-use/executor-client.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";
import { executeRunPlan } from "../../extensions/secretary/computer-use/tools/run-plan.ts";

const [image = "macos26", readCount = "5", url = "http://jev.home.arpa"] = process.argv.slice(2);
const out = resolve("test-results/computer-use", `relay-live-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const config = { ...defaultComputerUseConfiguration(), backend: "relay" as const, relayImage: image, executorUrl: url, executorTimeoutMs: 60_000 };
const driver = new RelayBackend({ connect: stdioRelayConnect({ command: DEFAULT_RELAY_COMMAND, cwd: out }), image, env: "default", ttlHours: 1,
  maxTreeNodes: config.maxTreeNodes, foregroundDelivery: config.foregroundDelivery, actionIntervalMs: config.settleMs });
const session = driver.session;
const readMs: number[] = [], actMs: number[] = [];
const timed = async <T>(into: number[], work: () => Promise<T>) => { const start = performance.now(); try { return await work(); } finally { into.push(performance.now() - start); } };
const backend: ExecutionBackend = { kind: "relay",
  readWindow: (target, options) => timed(readMs, () => driver.readWindow(target, options)),
  act: (window, action, signal) => timed(actMs, () => driver.act(window, action, signal)),
  foreground: (window, point, signal) => driver.foreground(window, point, signal),
  bringToFront: (window, signal) => driver.bringToFront(window, signal),
  close: async () => {} };
const log = (line: string) => { console.log(line); writeFileSync(join(out, "log.txt"), `${line}\n`, { flag: "a" }); };
const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return `n=${values.length}, median ${Math.round(sorted[Math.floor(sorted.length / 2)] ?? NaN)}, min ${Math.round(sorted[0] ?? NaN)}, max ${Math.round(sorted.at(-1) ?? NaN)}`; };

try {
  const acquired = performance.now();
  await session.run({ kind: "exec", title: "Open Calculator", expected: "Calculator shows its window", afterIntervalMs: 2500, timeoutMs: 60_000, body: { argv: ["/usr/bin/open", "-a", "Calculator"] } });
  log(`Acquire, stage and open Calculator: ${Math.round(performance.now() - acquired)} ms (wall clock, not a per-read quantity)`);
  await driver.readWindow({ app: "Calculator" }, { screenshot: true });
  for (let i = 0; i < Number(readCount); i++) {
    const read = await backend.readWindow({ app: "Calculator" }, { screenshot: true });
    log(`read ${i + 1}: ${Math.round(readMs.at(-1)!)} ms, ${read.elements.length} elements, screenshot ${read.screenshot ? Buffer.from(read.screenshot.data, "base64").length : 0} bytes, active ${read.appActive}`);
  }
  readMs.length = 0;
  for (let i = 0; i < Number(readCount); i++) await backend.readWindow({ app: "Calculator" }, { screenshot: true });
  const plan = { app: "Calculator", goal: "Compute 7 plus 3", steps: [
    { id: "seven", intent: "Press 7", postcondition: { text: { endsWith: "7" } } },
    { id: "plus", intent: "Press Add", postcondition: { changed: true } },
    { id: "three", intent: "Press 3", postcondition: { text: { endsWith: "3" } } },
    { id: "equals", intent: "Press Equals", postcondition: { text: { endsWith: "10" } } },
  ] };
  const readsBeforePlan = readMs.length;
  const result = await executeRunPlan({
    deps: { backend, executor: new ExecutorClient({ baseUrl: url, timeoutMs: config.executorTimeoutMs }), telemetry: new Telemetry(out), config },
    observation: () => undefined, escalations: { used: 0, limit: config.maxEscalationsPerRun, record: () => {} },
  }, plan as never);
  const text = (result.content[0] as { text: string }).text;
  log(`\nPlan result:\n${text}\n${JSON.stringify(result.details)}`);
  log(`\nrelay read time, ms (warm window, with screenshot): ${stats(readMs.slice(0, readsBeforePlan))}`);
  log(`relay read time, ms, during the plan: ${stats(readMs.slice(readsBeforePlan))}`);
  log(`relay action time, ms: ${stats(actMs)}`);
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  const closing = performance.now();
  try { await driver.close(); log(`finish: ${Math.round(performance.now() - closing)} ms`); }
  catch (error) { log(`finish FAILED: ${String(error)}`); process.exitCode = 1; }
  log(`Output: ${out}`);
}
