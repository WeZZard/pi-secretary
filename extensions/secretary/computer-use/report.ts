import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * One readable page for a child run (design §12.1). For each plan step it shows the intent, the
 * UI element, the grounder's answers, the action with its input path, the relay's before and after
 * screenshots, and whether the step acted. Step records name the relay steps of their reads and
 * actions (design §11.2), and a relay step's title or reason carries the plan's run identifier, so
 * the join is exact even when one child run used several leases. The page is recorded evidence,
 * not human review.
 */

interface RelayStep { id: string; title?: string; because?: string; execution?: string; snapshots?: { before?: string; after?: string } }
interface PlanRecord {
  recordedAt: string; runId: string; outcome: string; decisions?: number; actions?: number;
  escalation?: { stepId: string; reason: string; detail: string };
  plan?: { goal?: string; target?: { app?: string; windowTitle?: string }; steps?: { id: string; intent: string; ui_element?: unknown; keys?: string; text?: string; operation?: string; action?: string }[] };
  steps: { id: string; result: string; action?: string; element?: string; detail?: string; evidence?: string[]; inputPaths?: string[] }[];
}
interface StepRecord { recordedAt: string; stepId: string; attempt: number; answers?: Record<string, { choice?: string; confidence?: number }>; decision?: unknown }

const escape = (text: string) => text.replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]!);
const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };

/** Relay steps of the given evidence packages, with each screenshot as an absolute path. */
function relaySteps(packages: string[]): (RelayStep & { root: string })[] {
  return packages.flatMap(root => (readJson<{ steps?: RelayStep[] }>(join(root, "trajectory.json"))?.steps ?? []).map(step => ({ ...step, root })));
}

/** A relay step belongs to a plan step when its identifier matches and its title or reason names the plan's run. */
function findRelayStep(steps: (RelayStep & { root: string })[], id: string, runId: string) {
  return steps.find(step => (step.id === id || (step.because ?? "").includes(`(${id})`)) && `${step.title ?? ""} ${step.because ?? ""}`.includes(runId));
}

export interface ReportInput {
  /** Telemetry roots, one per session, each with `runs/<runId>/plan.json` and step records. */
  records: string[];
  /** Relay evidence packages, each with `trajectory.json`. */
  relayPackages: string[];
  out: string;
  title?: string;
}

export function writeRunReport(input: ReportInput): { path: string; plans: number; steps: number; screenshots: number } {
  const relay = relaySteps(input.relayPackages);
  const image = (path: string | undefined, root: string, label: string) => path
    ? `<figure><figcaption>${label}</figcaption><a href="${escape(relative(dirname(input.out), join(root, path)))}"><img loading="lazy" src="${escape(relative(dirname(input.out), join(root, path)))}" alt="${label}"></a></figure>` : "";
  const plans: { record: PlanRecord; steps: StepRecord[] }[] = [];
  for (const root of input.records) {
    const runs = join(root, "runs");
    if (!existsSync(runs)) continue;
    for (const runId of readdirSync(runs)) {
      const record = readJson<PlanRecord>(join(runs, runId, "plan.json"));
      if (!record) continue;
      const steps = readdirSync(join(runs, runId)).filter(name => name.startsWith("step-")).map(name => readJson<StepRecord>(join(runs, runId, name))).filter((step): step is StepRecord => !!step);
      plans.push({ record, steps });
    }
  }
  plans.sort((a, b) => a.record.recordedAt.localeCompare(b.record.recordedAt));
  let stepCount = 0, screenshots = 0;
  const sections = plans.map(({ record, steps }, index) => {
    const specs = new Map((record.plan?.steps ?? []).map(step => [step.id, step]));
    const rows = record.steps.map(outcome => {
      stepCount++;
      const spec = specs.get(outcome.id);
      const decisions = steps.filter(step => step.stepId === outcome.id).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
      const answers = decisions.map(step => Object.entries(step.answers ?? {}).map(([question, answer]) => `${question}: ${answer.choice ?? "?"} (${(answer.confidence ?? 0).toFixed(2)})`).join(", ")).filter(Boolean);
      const shots = (outcome.evidence ?? []).map(id => {
        const found = findRelayStep(relay, id, record.runId);
        if (!found) return `<p class="missing">${escape(id)}: no relay step found</p>`;
        screenshots += Number(!!found.snapshots?.before) + Number(!!found.snapshots?.after);
        // A driver call's relay title is the tool name; the reason carries the plan step's label.
        const title = (found.because ?? found.title ?? "").replace(/^Secretary computer use: /, "").replace(/ \(cu-\d+\)$/, "");
        return `<div class="relay"><p><code>${escape(id)}</code> ${escape(title)} (${escape(found.execution ?? "?")})</p>${image(found.snapshots?.before, found.root, "before")}${image(found.snapshots?.after, found.root, "after")}</div>`;
      }).join("");
      const facts = [
        ["Intent", spec?.intent],
        ["UI element", spec?.ui_element ? JSON.stringify(spec.ui_element) : undefined],
        ["Keys", spec?.keys],
        ["Text", spec?.text],
        ["Action", outcome.action ? `${outcome.action}${outcome.element ? ` ${JSON.stringify(outcome.element)}` : ""}` : undefined],
        ["Input path", outcome.inputPaths?.join(", ")],
        ["Grounder answers", answers.join(" · ") || undefined],
        ["Result", `${outcome.result}${outcome.detail ? `: ${outcome.detail}` : ""}`],
      ].filter((fact): fact is [string, string] => !!fact[1]).map(([name, value]) => `<tr><th>${name}</th><td>${escape(value)}</td></tr>`).join("");
      return `<section class="step ${escape(outcome.result)}"><h3>${escape(outcome.id)}</h3><table>${facts}</table>${shots}</section>`;
    }).join("");
    const escalation = record.escalation ? `<p class="escalation">Escalated at <code>${escape(record.escalation.stepId)}</code>: ${escape(record.escalation.reason)}, ${escape(record.escalation.detail)}</p>` : "";
    return `<article><h2>Plan ${index + 1}: ${escape(record.outcome)} <small>${escape(record.runId)} · ${escape(record.recordedAt)}</small></h2>`
      + `<p>${escape(record.plan?.goal ?? "")} <small>${escape(record.plan?.target?.app ?? "")}${record.plan?.target?.windowTitle ? ` · ${escape(record.plan.target.windowTitle)}` : ""}</small></p>${escalation}${rows}</article>`;
  }).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(input.title ?? "Computer-use run")}</title><style>
body{font:14px -apple-system,system-ui,sans-serif;margin:24px;max-width:1400px}article{border-top:2px solid #444;margin-top:24px}
.step{border-left:4px solid #aaa;padding:4px 12px;margin:12px 0}.step.acted{border-color:#2a2}.step.stopped{border-color:#c22}
table{border-collapse:collapse}th{text-align:left;padding-right:12px;vertical-align:top;color:#555}td{padding:2px 0}
.relay{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;margin:6px 0}.relay p{width:100%;margin:4px 0}figure{margin:0}img{max-width:560px;border:1px solid #ccc}
.escalation{color:#c22}.missing{color:#c22}small{color:#777;font-weight:normal}
</style></head><body><h1>${escape(input.title ?? "Computer-use run")}</h1><p>${plans.length} plans, ${stepCount} steps, ${screenshots} screenshots. Recorded evidence, not human review.</p>${sections}</body></html>`;
  writeFileSync(input.out, html);
  return { path: input.out, plans: plans.length, steps: stepCount, screenshots };
}
