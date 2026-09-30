/**
 * Evaluation plan phase E1 (design docs/testing/computer-use-evaluation.md §3): run MacArena tasks
 * through Pi, each in a fresh relay machine, and record a score and a failure cause per run.
 * It makes model calls.
 *
 *   node --experimental-strip-types scripts/computer-use/macarena-run.ts [--open-app] [--runs=N] [--out=DIR]
 *     [--model=qwen3.8-27b] [--grounder=http://jev.home.arpa] [--relay-server=PATH] <task.json>...
 *
 * `--open-app` opens the task's one application after its setup (the ship gate's variant, §5).
 * `--relay-server` runs a local build of mcp-vm-relay's `dist/server.mjs` instead of the published package.
 * Runs go round by round: every task's run 1, then every task's run 2, so a partial result covers
 * every task. Output: DIR (default a new test-results/computer-use/macarena-<time>/) gets
 * results.jsonl, one line per run, and deferred.jsonl, one line per attempt that got no machine.
 * A run already in DIR's results.jsonl is not run again, so the same command resumes a stopped
 * evaluation. Each run's own artifacts, with report.html, stay under test-results/e2e/.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appsOf, classify, instructionFor, loadTask, machineUnavailable, score, toCommands } from "./support/macarena.ts";
import { delegate } from "./support/delegate.ts";

const flags = new Map(process.argv.slice(2).filter(arg => arg.startsWith("--")).map(arg => { const [key, value] = arg.slice(2).split("="); return [key!, value ?? "true"]; }));
const taskFiles = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
if (!taskFiles.length) { console.error("usage: macarena-run.ts [--open-app] [--runs=N] [--out=DIR] [--model=M] [--grounder=URL] [--relay-server=PATH] <task.json>..."); process.exit(2); }
const runsPerTask = Number(flags.get("runs") ?? 1);
const out = flags.get("out") ?? join(import.meta.dirname, "../../test-results/computer-use", `macarena-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const results = join(out, "results.jsonl");
const done = new Set(existsSync(results) ? readFileSync(results, "utf8").trim().split("\n").filter(Boolean)
  .map(line => JSON.parse(line) as { task: string; run: number }).map(record => `${record.task}#${record.run}`) : []);
/** The host runs at most two macOS machines, shared with other sessions; an abandoned lease expires within its hour. */
const CAPACITY_WAIT_MS = 5 * 60_000;
const CAPACITY_TRIES = 15;

const tasks = taskFiles.flatMap(file => {
  const task = loadTask(file);
  const apps = appsOf(task);
  const openApp = flags.has("open-app") ? apps.length === 1 ? apps[0] : undefined : undefined;
  if (flags.has("open-app") && !openApp) { console.error(`${file}: --open-app needs exactly one application, found ${apps.join(", ") || "none"}`); return []; }
  return [{ file, task, openApp, ...toCommands(task, { ...(openApp ? { openApp } : {}) }) }];
});

for (let run = 1; run <= runsPerTask; run++) {
  for (const { file, task, openApp, prepare, check } of tasks) {
    if (done.has(`${task.id}#${run}`)) continue;
    for (let attempt = 1; ; attempt++) {
      const started = new Date().toISOString();
      const result = await delegate({ name: `macarena-${task.id.slice(0, 8)}`, task: instructionFor(task.instruction, openApp), prepare, check,
        modelId: flags.get("model") ?? "qwen3.8-27b", grounderUrl: flags.get("grounder") ?? "http://jev.home.arpa", timeoutMs: 25 * 60_000,
        ...(flags.has("relay-server") ? { relayCommand: [process.execPath, flags.get("relay-server")!] } : {}) });
      const state = join(result.artifacts, "extension-state");
      // A run that never had a machine says nothing about the agent, so it runs again once one is free.
      if (machineUnavailable({ checks: result.checks, state }) && attempt < CAPACITY_TRIES) {
        appendFileSync(join(out, "deferred.jsonl"), `${JSON.stringify({ task: task.id, run, attempt, started, artifacts: result.artifacts })}\n`);
        result.log(`MacArena ${task.id} run ${run}: no machine was free (attempt ${attempt}); trying again in ${CAPACITY_WAIT_MS / 60_000} minutes.`);
        await new Promise(resume => setTimeout(resume, CAPACITY_WAIT_MS));
        continue;
      }
      const taskScore = score(task, result.checks);
      const cause = classify({ score: taskScore, checks: result.checks, state });
      const record = { task: task.id, file: basename(file), run, started, openApp: openApp ?? null, instruction: task.instruction, score: taskScore ?? null, cause,
        elapsedS: Math.round(result.elapsedMs / 1000), runStatus: result.runs.map(entry => entry.status), agentReport: result.runs.at(-1)?.output ?? null,
        checks: result.checks ?? null, unfinishedLeases: result.unfinishedLeases, artifacts: result.artifacts };
      appendFileSync(results, `${JSON.stringify(record)}\n`);
      result.log(`MacArena ${task.id} run ${run}: score ${taskScore ?? "none"}, ${cause}. Artifacts: ${result.artifacts}`);
      break;
    }
  }
}
console.log(`Results: ${results}`);
