/**
 * Live acceptance for computer use (docs/acceptance/computer-use.feature; build plan Phase 8). It
 * runs each named scenario once through a real Pi parent, the real planner and grounder, and a relay
 * machine, then judges the scenario's Then steps, and ACC-CU-07's on every run, from recorded facts.
 * It makes model calls.
 *
 *   node --experimental-strip-types scripts/computer-use/acceptance-live.ts [--relay-server=PATH] [--out=DIR]
 *     [--model=qwen3.8-27b] [--grounder=http://jev.home.arpa] <scenario-id>...
 *
 * Output: DIR (default a new test-results/computer-use/acceptance-<time>/) gets results.jsonl, one
 * line per scenario run with its Then results. Each run's own artifacts stay under test-results/e2e/.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { delegate } from "./support/delegate.ts";
import { collectFacts, lifecycleThen, SCENARIOS, type RunRecord } from "./support/acceptance.ts";

const flags = new Map(process.argv.slice(2).filter(arg => arg.startsWith("--")).map(arg => { const [key, value] = arg.slice(2).split("="); return [key!, value ?? "true"]; }));
const ids = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const unknown = ids.filter(id => !SCENARIOS.some(scenario => scenario.id === id));
if (!ids.length || unknown.length) {
  console.error(`usage: acceptance-live.ts [--relay-server=PATH] [--out=DIR] [--model=M] [--grounder=URL] <scenario-id>...; known: ${SCENARIOS.map(s => s.id).join(", ")}${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}`);
  process.exit(2);
}
const out = flags.get("out") ?? join(import.meta.dirname, "../../test-results/computer-use", `acceptance-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });

for (const id of ids) {
  const scenario = SCENARIOS.find(entry => entry.id === id)!;
  const started = new Date().toISOString();
  const result = await delegate({ name: `acceptance-${id.toLowerCase()}`, task: scenario.task, prepare: scenario.prepare, check: scenario.check,
    modelId: flags.get("model") ?? "qwen3.8-27b", grounderUrl: scenario.grounderUrl ?? flags.get("grounder") ?? "http://jev.home.arpa", timeoutMs: 20 * 60_000,
    ...(scenario.duringRun ? { duringRun: scenario.duringRun } : {}),
    ...(flags.has("relay-server") ? { relayCommand: [process.execPath, flags.get("relay-server")!] } : {}) });
  const facts = collectFacts(result.artifacts, result.runs as RunRecord[], result.checks);
  const then = [...scenario.then(facts), ...lifecycleThen(facts)];
  const passed = then.every(step => step.verdict === "passed");
  appendFileSync(join(out, "results.jsonl"), `${JSON.stringify({ scenario: id, started, elapsedS: Math.round(result.elapsedMs / 1000), passed,
    relayServer: flags.get("relay-server") ?? null, then, artifacts: result.artifacts })}\n`);
  for (const step of then) result.log(`${step.scenario} ${step.verdict.toUpperCase()}: ${step.step} (${step.detail})`);
  result.log(`${id}: ${passed ? "every Then step passed" : "not every Then step passed"}. Artifacts: ${result.artifacts}`);
}
console.log(`Results: ${join(out, "results.jsonl")}`);
