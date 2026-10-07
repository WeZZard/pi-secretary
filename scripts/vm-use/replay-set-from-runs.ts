/**
 * Collect a decision replay set from recorded runs, for evaluate-decisions.ts (plan 2026-10-01 "whole tree outline").
 *
 *   node --experimental-strip-types scripts/vm-use/replay-set-from-runs.ts <output-dir> <runs-root>...
 *
 * Each run's `extension-state/vm-use/<agent>/` holds the window reads (`observations/`) and the plans (`runs/<run>/`).
 * A labelled intent is a plan step with a `ui_element`, paired with the read the executor took for it: the record whose
 * purpose is `initial <step id>`, the latest one at or before the step's first decision record.
 *
 * The expected UI element is the planner's `ui_element` name. A step planned before `ui_element` existed (2026-09-30) takes the
 * live grounder's choice instead. Neither is a hand label, so `--labels=<file>` applies a hand check: a JSON object from label to
 * the expected names, to `{ expect, role }`, or to null to drop the intent. Steps with `keys` and no `ui_element` are left out, because the key, not
 * the UI element, carries them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const labelsPath = process.argv.slice(2).find(arg => arg.startsWith("--labels="))?.slice(9);
const [output, ...roots] = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const checked = (labelsPath ? JSON.parse(readFileSync(labelsPath, "utf8")) : {}) as Record<string, string[] | { expect: string[]; role?: string } | null>;
if (!output || !roots.length) { console.error("usage: replay-set-from-runs.ts <output-dir> <runs-root>..."); process.exit(2); }
if (existsSync(output) && readdirSync(output).length) { console.error(`${output} is not empty; each replay set gets a new directory`); process.exit(2); }

interface PlanStep { id: string; intent: string; action?: string; text?: string; keys?: string; ui_element?: { name: string; role?: string; region?: string } }
interface Target { label: string; app: string; goal: string; source: string; labelSource: "ui_element" | "live decision" | "hand check"; liveChoice?: string; intents: { intent: string; expect: string[]; text?: string; keys?: string; role?: string }[] }

/** Every `extension-state/vm-use/<agent>` directory under a root. */
function stateDirectories(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if ((entry.name === "vm-use" || entry.name === "computer-use") && basename(dir) === "extension-state") {
        for (const agent of readdirSync(path, { withFileTypes: true })) if (agent.isDirectory()) found.push(join(path, agent.name));
      } else walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
mkdirSync(join(output, "observations"), { recursive: true });
const targets: Target[] = [];
let steps = 0, keysOnly = 0, withoutDecision = 0, withoutLabel = 0, withoutRead = 0, duplicates = 0, dropped = 0;
for (const root of roots) for (const state of stateDirectories(root)) {
  if (!existsSync(join(state, "observations")) || !existsSync(join(state, "runs"))) continue;
  const reads = readdirSync(join(state, "observations")).map(file => ({ id: file.replace(/\.json$/, ""), record: json(join(state, "observations", file)) }))
    .filter(read => read.record.status === "ready");
  const seen = new Set<string>();
  for (const run of readdirSync(join(state, "runs"))) {
    const planPath = join(state, "runs", run, "plan.json");
    if (!existsSync(planPath)) continue;
    const plan = json(planPath).plan as { goal?: string; target: { app: string }; steps: PlanStep[] };
    const decisions = readdirSync(join(state, "runs", run)).filter(file => file.startsWith("step-")).map(file => json(join(state, "runs", run, file)) as { stepId: string; attempt: number; recordedAt: string; decision?: { kind: string; element?: string } });
    for (const step of plan.steps) {
      steps++;
      if (!step.ui_element?.name && step.keys !== undefined) { keysOnly++; continue; }
      const first = decisions.filter(decision => decision.stepId === step.id).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))[0];
      if (!first) { withoutDecision++; continue; }
      const liveChoice = first.decision?.kind === "act" ? first.decision.element : undefined;
      const candidate = step.ui_element?.name ?? liveChoice;
      if (candidate === undefined) { withoutLabel++; continue; }
      const read = reads.filter(candidate => candidate.record.purpose === `initial ${step.id}` && candidate.record.recordedAt <= first.recordedAt)
        .sort((a, b) => b.record.recordedAt.localeCompare(a.record.recordedAt))[0];
      if (!read) { withoutRead++; continue; }
      const key = `${read.id}\u0000${step.intent}`;
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      const label = `${relative(root, state).split("/extension-state")[0]!}-${run}-${step.id}`.replace(/[^A-Za-z0-9_-]/g, "_");
      const entry = checked[label];
      if (entry === null) { dropped++; continue; }
      const hand = Array.isArray(entry) ? { expect: entry } : entry;
      const role = hand ? hand.role : step.ui_element?.role;
      writeFileSync(join(output, "observations", `${label}.json`), JSON.stringify(read.record));
      targets.push({ label, app: plan.target.app, goal: plan.goal ?? step.intent, source: relative(process.cwd(), join(state, "observations", `${read.id}.json`)),
        labelSource: hand ? "hand check" : step.ui_element ? "ui_element" : "live decision", ...(liveChoice !== undefined ? { liveChoice } : {}),
        intents: [{ intent: step.intent, expect: hand?.expect ?? [candidate], ...(step.text !== undefined ? { text: step.text } : {}), ...(step.keys !== undefined ? { keys: step.keys } : {}),
          ...(role ? { role } : {}) }] });
    }
  }
}
writeFileSync(join(output, "targets.json"), `${JSON.stringify(targets, null, 1)}\n`);
console.log(`${targets.length} labelled intents from ${steps} plan steps; skipped: ${keysOnly} keys without ui_element, ${withoutDecision} without a decision record, `
  + `${withoutLabel} without ui_element or a live choice, ${withoutRead} without an initial read, ${duplicates} repeated, ${dropped} dropped by the hand check.`);
