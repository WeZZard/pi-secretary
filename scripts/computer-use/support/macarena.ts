/**
 * MacArena tasks in relay machines (evaluation design docs/arch/computer-use-evaluation.md §3 and §4):
 * turn a shell-checked task into setup and check commands, score the check as MacArena does, and
 * give a failed run one cause from its records.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { CheckResult } from "../../../extensions/secretary/computer-use/backend/relay-client.ts";

export interface MacArenaTask {
  id: string;
  instruction: string;
  pre_command?: string;
  pre_upload_files?: unknown[];
  before_action_delay_seconds?: number;
  before_grading_delay_seconds?: number;
  evaluator: [string, number][];
  related_apps?: string[];
}

/**
 * MacArena's server starts a task's setup with `subprocess.Popen(command, shell=True)`, which is
 * /bin/sh, and never checks its exit status; its checks run as `#!/bin/bash` scripts
 * (vm_files/server/main.py). Some setups carry a literal "\n" that AppleScript rejects, so the
 * setup is run the same way: under /bin/sh, with its exit status ignored.
 */
const setup = (script: string) => ["/bin/sh", "-c", `${script}\ntrue`];
const shell = (script: string) => ["/bin/bash", "-c", script];

export function loadTask(file: string): MacArenaTask {
  const task = JSON.parse(readFileSync(file, "utf8")) as MacArenaTask;
  if (!Array.isArray(task.evaluator)) throw new Error(`${file}: not a shell-checked task`);
  if (task.pre_upload_files?.length) throw new Error(`${file}: needs uploaded files, which the runner does not provide`);
  return task;
}

/**
 * The applications a task uses: its `related_apps`, or, for macOSWorld tasks, which do not list
 * them, the applications its setup and checks script with `tell application` or `tell process`.
 * System Events is the scripting bridge, not an application the task is about.
 */
export function appsOf(task: MacArenaTask): string[] {
  if (task.related_apps?.length) return task.related_apps;
  const scripts = [task.pre_command ?? "", ...task.evaluator.map(([command]) => command)].join("\n");
  const named = [...scripts.matchAll(/tell (?:application|process) \\?"([^"\\]+)\\?"/g)].map(match => match[1]!);
  return [...new Set(named)].filter(app => app !== "System Events");
}

/**
 * `openApp` is the ship gate's variant (design §5): the approved requirements have the application
 * already open, so the named application is opened after the task's own setup. The benchmark run
 * leaves the setup as MacArena wrote it.
 */
export function toCommands(task: MacArenaTask, options: { openApp?: string }): { prepare: string[][]; check: string[][] } {
  const prepare = [
    ...(task.pre_command ? [setup(task.pre_command)] : []),
    ...(options.openApp ? [["/usr/bin/open", "-a", options.openApp], ["/bin/sleep", "3"]] : []),
    ...(task.before_action_delay_seconds ? [["/bin/sleep", String(task.before_action_delay_seconds)]] : []),
  ];
  // MacArena grades only the evaluators worth 100 (desktop_env.py `_macosworld_evaluate`).
  const check = [
    ...(task.before_grading_delay_seconds ? [["/bin/sleep", String(task.before_grading_delay_seconds)]] : []),
    ...task.evaluator.filter(([, reward]) => reward === 100).map(([command]) => shell(command)),
  ];
  return { prepare, check };
}

/**
 * The task as delegated. A MacArena agent sees the screen with the application open; Pi's parent
 * does not, so the ship gate's variant names the open application in one added sentence. The
 * instruction itself is unchanged.
 */
export function instructionFor(instruction: string, openApp?: string): string {
  return openApp ? `${instruction} (The task is in ${openApp}, which is open.)` : instruction;
}

/**
 * MacArena's rule: evaluators are tried in order, the first that prints "true" scores 1, one that
 * prints anything else lets the next one try, and one that does not run ends grading with 0.
 * Undefined when the checks never ran.
 */
export function score(task: MacArenaTask, checks: CheckResult[] | undefined): number | undefined {
  if (!checks) return undefined;
  const graded = checks.filter(result => result.argv[0] !== "/bin/sleep");
  if (graded.length !== task.evaluator.filter(([, reward]) => reward === 100).length) return undefined;
  for (const result of graded) {
    if (!result.completed) return 0;
    if (result.stdout.trim().toLowerCase().includes("true")) return 1;
  }
  return 0;
}

export type FailureCause = "false_success" | "destructive" | "setup_failed" | "check_failed" | "out_of_scope" | "no_plan" | "wrong_result"
  | `escalation:${string}` | `rejection:${string}`;

interface PlanRecord { recordedAt: string; outcome: string; escalation?: { reason: string } }
interface StepRecord { decision?: { kind?: string; risk?: string } }

const files = (dir: string, match: (name: string) => boolean): string[] => !existsSync(dir) ? [] : readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path, match) : match(name) ? [path] : [];
});
const json = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };

const sessionText = (state: string) => files(join(state, "agents"), name => name.endsWith(".jsonl")).map(path => readFileSync(path, "utf8")).join("\n");

/**
 * A run that never had a machine: no check ran, and the relay refused to acquire one, as when the
 * host's two macOS machines are in use. It says nothing about the agent, so it is run again later.
 */
export function machineUnavailable(input: { checks: CheckResult[] | undefined; state: string }): boolean {
  return !input.checks && /relay_acquire failed/.test(sessionText(input.state));
}

/**
 * One cause per failed run, in the order of design §4, after the two harness causes. `state` is the run's extension-state
 * directory, which holds the computer-use records and the child agent's session.
 * "Reported success" means the last plan completed with every step checked by code: the agent's
 * own checks passed while the task's check failed.
 */
export function classify(input: { score: number | undefined; checks: CheckResult[] | undefined; state: string }): FailureCause | "passed" {
  if (input.score === 1) return "passed";
  const records = join(input.state, "computer-use");
  const plans = files(records, name => name === "plan.json").map(path => json<PlanRecord>(path)).filter((plan): plan is PlanRecord => !!plan)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const steps = files(records, name => name.startsWith("step-")).map(path => json<StepRecord>(path)).filter((step): step is StepRecord => !!step);
  const rejections = files(records, name => name.endsWith(".json")).filter(path => path.split(sep).includes("rejections")).sort()
    .map(path => json<{ rule: string }>(path)).filter((rejection): rejection is { rule: string } => !!rejection);
  const session = sessionText(input.state);
  const last = plans.at(-1);
  // Harness failures come first: they say nothing about the agent.
  if (/\(Prepare: [\s\S]{0,4000}?\) was (?:completed|uncertain|failed)/.test(session)) return "setup_failed";
  if (input.score === undefined || input.checks!.some(result => !result.completed && result.argv[0] !== "/bin/sleep")) return "check_failed";
  if (last?.outcome === "completed") return "false_success";
  if (steps.some(step => step.decision?.kind === "act" && step.decision.risk === "destructive")) return "destructive";
  if (last?.escalation) return `escalation:${last.escalation.reason}`;
  if (!plans.length && rejections.length) return `rejection:${rejections.at(-1)!.rule}`;
  if (!plans.length) return /This tool does not launch applications/.test(session) ? "out_of_scope" : "no_plan";
  return "wrong_result";
}
