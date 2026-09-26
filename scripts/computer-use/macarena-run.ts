/**
 * Evaluation plan phase E1 (design docs/arch/computer-use-evaluation.md §3): run MacArena tasks
 * through Pi, each in a fresh relay machine, and record a score and a failure cause per run.
 * It makes model calls.
 *
 *   node --experimental-strip-types scripts/computer-use/macarena-run.ts [--open-app] [--runs=N] [--out=DIR]
 *     [--model=qwen3.8-27b] [--executor=http://jev.home.arpa] <task.json>...
 *
 * `--open-app` opens the task's one related application after its setup (the ship gate's variant, §5).
 * Output: DIR (default a new test-results/computer-use/macarena-<time>/) gets results.jsonl, one
 * line per run; each run's own artifacts, with report.html, stay under test-results/e2e/.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { classify, loadTask, score, toCommands } from "./support/macarena.ts";
import { delegate } from "./support/delegate.ts";

const flags = new Map(process.argv.slice(2).filter(arg => arg.startsWith("--")).map(arg => { const [key, value] = arg.slice(2).split("="); return [key!, value ?? "true"]; }));
const taskFiles = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
if (!taskFiles.length) { console.error("usage: macarena-run.ts [--open-app] [--runs=N] [--out=DIR] [--model=M] [--executor=URL] <task.json>..."); process.exit(2); }
const runsPerTask = Number(flags.get("runs") ?? 1);
const out = flags.get("out") ?? join(import.meta.dirname, "../../test-results/computer-use", `macarena-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const results = join(out, "results.jsonl");

for (const file of taskFiles) {
  const task = loadTask(file);
  const apps = task.related_apps ?? [];
  const openApp = flags.has("open-app") ? apps.length === 1 ? apps[0] : undefined : undefined;
  if (flags.has("open-app") && !openApp) { console.error(`${file}: --open-app needs exactly one related app, found ${apps.length}`); continue; }
  const { prepare, check } = toCommands(task, { ...(openApp ? { openApp } : {}) });
  for (let run = 1; run <= runsPerTask; run++) {
    const started = new Date().toISOString();
    const result = await delegate({ name: `macarena-${task.id.slice(0, 8)}`, task: task.instruction, prepare, check,
      modelId: flags.get("model") ?? "qwen3.8-27b", executorUrl: flags.get("executor") ?? "http://jev.home.arpa", timeoutMs: 25 * 60_000 });
    const taskScore = score(task, result.checks);
    const cause = classify({ score: taskScore, checks: result.checks, state: join(result.artifacts, "extension-state") });
    const record = { task: task.id, file: basename(file), run, started, openApp: openApp ?? null, instruction: task.instruction, score: taskScore ?? null, cause,
      elapsedS: Math.round(result.elapsedMs / 1000), runStatus: result.runs.map(entry => entry.status), agentReport: result.runs.at(-1)?.output ?? null,
      checks: result.checks ?? null, unfinishedLeases: result.unfinishedLeases, artifacts: result.artifacts };
    appendFileSync(results, `${JSON.stringify(record)}\n`);
    result.log(`MacArena ${task.id} run ${run}: score ${taskScore ?? "none"}, ${cause}. Artifacts: ${result.artifacts}`);
  }
}
console.log(`Results: ${results}`);
