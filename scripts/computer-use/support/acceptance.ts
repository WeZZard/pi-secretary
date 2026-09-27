/**
 * Live acceptance for computer use (docs/acceptance/computer-use.feature, build plan Phase 8). Each
 * scenario's Then steps are judged from recorded facts only: Secretary's run records, the harness's
 * plan records, the parent's RPC events, the task's check output, and the relay's lifecycle records.
 * A step whose fact was not recorded is `not_observable`, never passed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "../../../extensions/secretary/computer-use/backend/relay-client.ts";
import { relayLeases } from "./stop-pi.ts";

export type Verdict = "passed" | "failed" | "not_observable";
export interface ThenResult { scenario: string; step: string; verdict: Verdict; detail: string }

export interface PlanRecord {
  recordedAt: string;
  outcome: "completed" | "escalated" | "cancelled";
  steps: { id: string; result: string; action?: string; evidence?: string[] }[];
  escalation?: { stepId: string; reason: string };
  actions?: number;
}
export interface RunRecord { status?: string; output?: string; endedAt?: number }
export interface LeaseRecord { name: string; released: boolean; finishedAt?: string }

export interface Facts {
  runs: RunRecord[];
  plans: PlanRecord[];
  /** Tool names the parent called, from its RPC events. */
  parentTools: string[];
  /** Text of every tool result the parent's model received. */
  parentToolResults: string[];
  /** The child's report as delivered to the parent: the last run's output. */
  report: string;
  checks?: CheckResult[];
  leases: LeaseRecord[];
}

const walk = (dir: string, match: (name: string) => boolean): string[] => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name), match) : match(entry.name) ? [join(dir, entry.name)] : []);
const json = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };
const text = (content: unknown): string => Array.isArray(content)
  ? content.map(part => (part as { type?: string; text?: string }).type === "text" ? (part as { text: string }).text : "").join("") : typeof content === "string" ? content : "";

/** Reads the facts of one delegation from its artifact directory (see `delegate`). */
export function collectFacts(artifacts: string, runs: RunRecord[], checks?: CheckResult[]): Facts {
  const plans = walk(join(artifacts, "extension-state", "computer-use"), name => name === "plan.json").map(path => json<PlanRecord>(path))
    .filter((plan): plan is PlanRecord => !!plan).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const parentTools: string[] = [], parentToolResults: string[] = [];
  const stdout = join(artifacts, "stdout.jsonl");
  for (const line of existsSync(stdout) ? readFileSync(stdout, "utf8").split("\n") : []) {
    if (!line.startsWith("{")) continue;
    let event: { type?: string; toolName?: string; message?: { role?: string; content?: unknown } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "tool_execution_start" && event.toolName) parentTools.push(event.toolName);
    if (event.type === "message_end" && event.message?.role === "toolResult") parentToolResults.push(text(event.message.content));
  }
  const evidence = join(artifacts, "relay-evidence");
  const leases = relayLeases(evidence).map(({ name }) => {
    const lifecycle = json<{ released?: boolean; finishedAt?: string }>(join(evidence, `${name}.lifecycle.json`));
    return { name, released: lifecycle?.released === true, ...(lifecycle?.finishedAt ? { finishedAt: lifecycle.finishedAt } : {}) };
  });
  return { runs, plans, parentTools, parentToolResults, report: runs.at(-1)?.output ?? "", ...(checks ? { checks } : {}), leases };
}

const verdict = (scenario: string, step: string, holds: boolean | undefined, detail: string): ThenResult =>
  ({ scenario, step, verdict: holds === undefined ? "not_observable" : holds ? "passed" : "failed", detail });
const checkOutput = (facts: Facts): string | undefined => facts.checks?.every(check => check.completed) ? facts.checks.map(check => check.stdout).join("\n") : undefined;

/** ACC-CU-07, judged on every scenario's run: decision PS-D11. */
export function lifecycleThen(facts: Facts): ThenResult[] {
  const computerTools = facts.parentTools.filter(name => name.startsWith("computer_"));
  const ended = facts.runs.map(run => run.endedAt).filter((at): at is number => typeof at === "number");
  const lastEnd = ended.length ? Math.max(...ended) : undefined;
  return [
    verdict("ACC-CU-07", "the parent never called computer_observe or computer_run_plan", computerTools.length === 0, computerTools.join(", ") || "no computer tool calls"),
    verdict("ACC-CU-07", "every relay lease has a lifecycle record that says it was released", facts.leases.length ? facts.leases.every(lease => lease.released) : undefined,
      facts.leases.map(lease => `${lease.name}: ${lease.released ? "released" : "not released"}`).join("; ") || "no lease was acquired"),
    verdict("ACC-CU-07", "each lease was released before the run that used it was recorded as ended",
      facts.leases.length && lastEnd !== undefined && facts.leases.every(lease => lease.finishedAt) ? facts.leases.every(lease => Date.parse(lease.finishedAt!) <= lastEnd) : undefined,
      `leases finished ${facts.leases.map(lease => lease.finishedAt ?? "never").join(", ") || "none"}; last run ended ${lastEnd ? new Date(lastEnd).toISOString() : "never"}`),
  ];
}

export interface Scenario {
  id: string;
  task: string;
  prepare: string[][];
  check?: string[][];
  executorUrl?: string;
  then(facts: Facts): ThenResult[];
}

const shell = (script: string) => ["/bin/zsh", "-c", script];
/** Prints Calculator's shown text, one value per line, through System Events (JavaScript for Automation). */
const CALCULATOR_TEXT = shell(`osascript -l JavaScript -e 'const p = Application("System Events").processes["Calculator"]; `
  + `p.windows[0].entireContents().filter(e => { try { return e.role() === "AXStaticText"; } catch (x) { return false; } }).map(e => String(e.value())).join("\\n")'`);
const OPEN_CALCULATOR = [["/usr/bin/open", "-a", "Calculator"], ["/bin/sleep", "3"]];

export const SCENARIOS: Scenario[] = [
  {
    id: "ACC-CU-01",
    task: "In the Calculator app, compute 7 + 3 and tell me the result shown on the display.",
    prepare: OPEN_CALCULATOR,
    check: [CALCULATOR_TEXT],
    then(facts) {
      const last = facts.plans.at(-1);
      const shown = checkOutput(facts);
      const toolResults = facts.parentToolResults.join("\n");
      return [
        verdict("ACC-CU-01", "the run is reported as succeeded", facts.runs.length ? facts.runs.at(-1)!.status === "succeeded" : undefined, facts.runs.map(run => run.status).join(", ") || "no run"),
        verdict("ACC-CU-01", "the last plan completed, and each of its steps was verified by code",
          last ? last.outcome === "completed" && last.steps.length > 0 && last.steps.every(step => step.result === "verified") : undefined,
          last ? `${last.outcome}: ${last.steps.map(step => `${step.id}=${step.result}`).join(", ")}` : "no plan record"),
        verdict("ACC-CU-01", "the display shows 10 when the task's check reads it", shown === undefined ? undefined : /(^|\D)10(\D|$)/.test(shown), shown?.slice(0, 200) ?? "the check did not complete"),
        verdict("ACC-CU-01", "the report the parent receives states the result 10", facts.report ? /(^|\D)10(\D|$)/.test(facts.report) : undefined, facts.report.slice(0, 200) || "no report"),
        verdict("ACC-CU-01", "the parent's conversation contains no observation or element table of any step",
          facts.parentToolResults.length ? !/Observation: obs-|element_index/.test(toolResults) : undefined, `${facts.parentToolResults.length} tool results read by the parent`),
        verdict("ACC-CU-01", "every step of the last plan names the relay steps that hold its screenshots",
          last?.steps.length ? last.steps.every(step => (step.evidence?.length ?? 0) > 0) : undefined, last?.steps.map(step => `${step.id}: ${step.evidence?.length ?? 0}`).join(", ") ?? "no plan record"),
      ];
    },
  },
];
