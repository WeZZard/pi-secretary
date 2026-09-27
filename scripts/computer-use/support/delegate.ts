/**
 * One live delegation: a real Pi parent in RPC mode delegates a desktop task to the computer-use
 * agent definition, which runs through the relay client in a fresh relay virtual machine, with the
 * real LiteLLM model and the executor. It makes model calls. Used by the live delegation script and
 * the MacArena task runner (evaluation design §3).
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCleanPiEnvironment } from "../../../tests/e2e/environment/isolation.ts";
import { useGlobalLiteLLM } from "../../../tests/e2e/environment/global-litellm.ts";
import { DEFAULT_RELAY_COMMAND } from "../../../extensions/secretary/computer-use/configuration.ts";
import type { CheckResult } from "../../../extensions/secretary/computer-use/backend/relay-client.ts";
import { writeRunReport } from "../../../extensions/secretary/computer-use/report.ts";
import { stopPi } from "./stop-pi.ts";

export interface DelegationInput {
  /** Artifact directory name under test-results/e2e/. */
  name: string;
  task: string;
  prepare: string[][];
  /** Commands run in the machine after the child run and before the lease is finished. */
  check?: string[][];
  modelId: string;
  executorUrl: string;
  timeoutMs?: number;
}

export interface Run { status?: string; background?: boolean; output?: string; subagentType?: string }

export interface DelegationResult {
  artifacts: string;
  runs: Run[];
  /** The relay check results, when checks were configured and ran. */
  checks?: CheckResult[];
  elapsedMs: number;
  /** Relay leases that did not finish within 10 minutes of stopping Pi. */
  unfinishedLeases: string[];
  log: (line: string) => void;
}

const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const TERMINAL = ["succeeded", "failed", "cancelled", "partial"];
const subdirectories = (root: string) => existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name)) : [];

export async function delegate(input: DelegationInput): Promise<DelegationResult> {
  const environment = createCleanPiEnvironment({ name: input.name,
    extensionUnderTest: join(import.meta.dirname, "../../../extensions/secretary/index.ts"),
    projectFixture: join(import.meta.dirname, "../../../tests/e2e/fixtures/computer-use/project") });
  const profile = useGlobalLiteLLM(environment, undefined, { model: input.modelId });
  const model = `${profile.provider}/${profile.model}`;
  const log = (line: string) => { console.log(line); writeFileSync(join(environment.artifacts, "log.txt"), `${line}\n`, { flag: "a" }); };

  mkdirSync(join(environment.agentDir, "agents"));
  cpSync(join(import.meta.dirname, "../../../extensions/secretary/computer-use/templates/computer-use.md"), join(environment.agentDir, "agents", "computer-use.md"));
  writeFileSync(join(environment.agentDir, "secretary.json"), JSON.stringify({
    agents: { modelFallbackLists: { "computer-use": [model] }, subagentModels: { "computer-use": "computer-use" } },
    computerUse: {
      backend: "relay", relayImage: "macos26", relayEnv: "default", relayTtlHours: 1,
      // The isolated Pi environment replaces HOME; the relay keeps its state and credential packs under the real one.
      relayCommand: ["/usr/bin/env", `HOME=${homedir()}`, ...DEFAULT_RELAY_COMMAND],
      relayPrepare: input.prepare,
      ...(input.check?.length ? { relayCheck: input.check } : {}),
      executorUrl: input.executorUrl, executorTimeoutMs: 60_000,
    },
  }, null, 2));

  const prompt = `Delegate this task to the computer-use agent and do not use the computer tools yourself: ${input.task} `
    + "When the agent finishes, tell me its result and what it verified.";
  const args = [join(environment.repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--no-extensions",
    ...environment.extensions.flatMap(extension => ["--extension", extension]),
    // Pi runs on the host. Without its built-in tools, the parent cannot read or act on the host's
    // desktop, as it did with osascript on 2026-09-26; the child's computer tools act only in the relay machine.
    "--no-builtin-tools",
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve",
    "--session-dir", environment.sessions, "--model", model, "--mode", "rpc"];
  writeFileSync(join(environment.artifacts, "invocation.json"), JSON.stringify({ args, cwd: environment.project, prompt }, null, 2) + "\n");
  const started = Date.now();
  const child = spawn(process.execPath, args, { cwd: environment.project, env: environment.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", agentEnds = 0;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    stdout += text;
    for (const line of text.split("\n")) {
      if (line.includes('"type":"agent_end"')) agentEnds++;
      if (line.includes('"type":"tool_execution_start"')) { try { const event = JSON.parse(line); log(`${Math.round((Date.now() - started) / 1000)}s parent tool: ${event.toolName}`); } catch {} }
    }
  });
  child.stderr.on("data", (text: string) => { stderr += text; });
  child.stdin.write(JSON.stringify({ id: "prompt-1", type: "prompt", message: prompt }) + "\n");

  const database = join(environment.state, "pi-secretary-goals.sqlite");
  const runs = (): Run[] => {
    if (!existsSync(database)) return [];
    const db = new DatabaseSync(database, { readOnly: true });
    try { return db.prepare("SELECT json FROM secretary_agent_runs").all().map(row => JSON.parse(String((row as { json: string }).json))); }
    catch { return []; } finally { db.close(); }
  };
  // The child's backend runs the checks when the child session ends, while Pi is still running.
  const checkRecords = () => subdirectories(join(environment.state, "computer-use")).flatMap(root => {
    const dir = join(root, "checks");
    return existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : [];
  });
  let finishedAt: number | undefined, endsAtFinish = 0, lastStatus = "";
  while (Date.now() - started < (input.timeoutMs ?? 20 * 60_000)) {
    await wait(5000);
    // The parent may delegate again after a run ends, so every run must end, not only the first.
    const all = runs();
    const status = all.map(run => run.status ?? "none").join(", ") || "none";
    if (status !== lastStatus) { log(`${Math.round((Date.now() - started) / 1000)}s run status: ${status}`); lastStatus = status; }
    const ended = all.length > 0 && all.every(run => TERMINAL.includes(run.status ?? ""));
    if (!ended) { finishedAt = undefined; continue; }
    if (!finishedAt) { finishedAt = Date.now(); endsAtFinish = agentEnds; }
    // After the last run ends, the parent takes one more turn to report it; with checks, their record must exist too.
    const reported = agentEnds > endsAtFinish || Date.now() - finishedAt > 3 * 60_000;
    const checked = !input.check?.length || checkRecords().length > 0 || Date.now() - finishedAt > 6 * 60_000;
    if (reported && checked) break;
  }
  const evidence = join(environment.project, "relay-evidence");
  // A lease that acquired a machine has the relay's host configuration; a refused acquisition has only events.
  const leases = () => existsSync(evidence) ? readdirSync(evidence).filter(name => existsSync(join(evidence, name, "host", "mcp-host-config.json"))) : [];
  const unfinished = () => leases().filter(name => !existsSync(join(evidence, `${name}.lifecycle.json`)));
  await stopPi(child, { unfinished, leaseWaitMs: 10 * 60_000, exitGraceMs: 30_000, pollMs: 5000 });
  writeFileSync(join(environment.artifacts, "stdout.jsonl"), environment.redact(stdout));
  writeFileSync(join(environment.artifacts, "stderr.log"), environment.redact(stderr));
  log(unfinished().length ? `Relay leases not finished within 10 minutes of stopping Pi: ${unfinished().join(", ")}.` : `Every relay lease was finished (${leases().length}).`);
  if (existsSync(evidence)) cpSync(evidence, join(environment.artifacts, "relay-evidence"), { recursive: true });
  const all = runs();
  writeFileSync(join(environment.artifacts, "runs.json"), environment.redact(JSON.stringify(all, null, 2)));
  profile.redactArtifacts();
  // One page that joins each plan step to its relay screenshots (design §12.1).
  const report = writeRunReport({
    records: subdirectories(join(environment.artifacts, "extension-state", "computer-use")),
    relayPackages: subdirectories(join(environment.artifacts, "relay-evidence")).filter(root => existsSync(join(root, "trajectory.json"))),
    out: join(environment.artifacts, "report.html"),
    title: `Computer use: ${input.name}`,
  });
  log(`Report: ${report.path} (${report.plans} plans, ${report.steps} steps, ${report.screenshots} screenshots)`);
  const checkFile = checkRecords().sort().at(-1);
  const checks = checkFile ? (JSON.parse(readFileSync(checkFile, "utf8")) as { results: CheckResult[] }).results : undefined;
  return { artifacts: environment.artifacts, runs: all, ...(checks ? { checks } : {}), elapsedMs: Date.now() - started, unfinishedLeases: unfinished(), log };
}
