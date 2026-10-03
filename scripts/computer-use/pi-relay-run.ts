/**
 * Evaluation §7.2 (decision PS-D30): run one MacArena task through Pi, delegated to a clean subagent that drives
 * the relay's MCP tools itself, without computer_observe, computer_run_plan, the grounder or the permission
 * guardian. Same harness and model as the computer-use run, same tools and instructions as the Claude Code run.
 * It makes model calls.
 *
 *   node --experimental-strip-types scripts/computer-use/pi-relay-run.ts [--open-app] [--model=qwen3.8-27b] [--out=DIR] <task.json>
 *
 * The subagent runs the task's preparation and check itself with relay_exec, from `macarena-task.json` in the
 * project; the score comes from the check's output in the relay evidence. Output: DIR (default a new
 * test-results/computer-use/pi-relay-<time>/) gets results.jsonl; the run's artifacts go to a new
 * test-results/e2e/pi-relay-<task>/<time>/, in the layout of a computer-use run.
 */
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCleanPiEnvironment } from "../../tests/e2e/environment/isolation.ts";
import { useGlobalLiteLLM } from "../../tests/e2e/environment/global-litellm.ts";
import { DEFAULT_RELAY_COMMAND } from "../../extensions/secretary/computer-use/configuration.ts";
import { appsOf, instructionFor, loadTask, score, toCommands } from "./support/macarena.ts";
import { recordedChecks } from "./support/relay-records.ts";
import { relayLeases, stopPi } from "./support/stop-pi.ts";
import type { Run } from "./support/delegate.ts";

const flags = new Map(process.argv.slice(2).filter(arg => arg.startsWith("--")).map(arg => { const [key, value] = arg.slice(2).split("="); return [key!, value ?? "true"]; }));
const [taskFile] = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
if (!taskFile) { console.error("usage: pi-relay-run.ts [--open-app] [--model=M] [--out=DIR] <task.json>"); process.exit(2); }
const repository = join(import.meta.dirname, "../..");
const out = flags.get("out") ?? join(repository, "test-results/computer-use", `pi-relay-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });

const task = loadTask(taskFile);
const apps = appsOf(task);
const openApp = flags.has("open-app") ? apps.length === 1 ? apps[0] : undefined : undefined;
if (flags.has("open-app") && !openApp) { console.error(`--open-app needs exactly one application, found ${apps.join(", ") || "none"}`); process.exit(2); }
const { prepare, check } = toCommands(task, openApp ? { openApp } : {});
const instruction = instructionFor(task.instruction, openApp);

/** The owner's installed copies: the Claude Code plugin's subagent definition, and Pi's MCP adapter. */
const OPERATOR_DEFINITION = join(homedir(), ".claude/plugins/cache/mcp-vm-relay/mcp-vm-relay/0.8.0/agents/vm-relay-operator.md");
const MCP_ADAPTER = join(homedir(), ".pi/agent/npm/node_modules/pi-mcp-adapter");

const environment = createCleanPiEnvironment({ name: `pi-relay-${task.id.slice(0, 8)}`,
  extensionUnderTest: join(repository, "extensions/secretary/index.ts"),
  projectFixture: join(repository, "tests/e2e/fixtures/computer-use/project") });
const profile = useGlobalLiteLLM(environment, undefined, { model: flags.get("model") ?? "qwen3.8-27b" });
const model = `${profile.provider}/${profile.model}`;
const log = (line: string) => { console.log(line); appendFileSync(join(environment.artifacts, "log.txt"), `${line}\n`); };
writeFileSync(join(environment.project, "macarena-task.json"), `${JSON.stringify({ image: "macos26", instruction, prepare, check }, null, 2)}\n`);

// The plugin's definition, unchanged but for Pi's tool names: the relay tools under their own names, and `read` for Read, Glob and Grep.
const definition = readFileSync(OPERATOR_DEFINITION, "utf8");
const [, frontmatter, body] = definition.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
const description = frontmatter!.match(/^description: (.*)$/m)![1]!;
const relayTools = frontmatter!.match(/^tools: (.*)$/m)![1]!.split(",").map(name => name.trim())
  .filter(name => name.startsWith("mcp__")).map(name => name.replace(/^mcp__plugin_mcp-vm-relay_relay__/, ""));
mkdirSync(join(environment.agentDir, "agents"));
writeFileSync(join(environment.agentDir, "agents", "vm-relay-operator.md"),
  `---\nname: vm-relay-operator\ndescription: ${description}\ntools: read, ${relayTools.join(", ")}\n---\n${body}`);
// No computerUse section: the backend stays "none", so computer_observe and computer_run_plan are not registered.
writeFileSync(join(environment.agentDir, "secretary.json"), JSON.stringify({
  agents: { modelFallbackLists: { "vm-relay-operator": [model] }, subagentModels: { "vm-relay-operator": "vm-relay-operator" } },
}, null, 2));
// A child session loads extensions from settings, not from the parent's --extension flags, and its adapter
// instance gets no --mcp-config: both read the adapter's global config in the agent directory.
const settingsPath = join(environment.agentDir, "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { extensions?: string[] };
writeFileSync(settingsPath, JSON.stringify({ ...settings, extensions: [...settings.extensions ?? [], MCP_ADAPTER] }, null, 2) + "\n");
// The relay keeps its state and credential packs under the owner's home, which the clean environment replaces.
const mcpConfig = join(environment.agentDir, "mcp-adapter.json");
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { relay: {
  command: "/usr/bin/env", args: [`HOME=${homedir()}`, `MCP_VM_RELAY_PROJECT=${environment.project}`, ...DEFAULT_RELAY_COMMAND],
  lifecycle: "lazy-keep-alive", requestTimeoutMs: 3_900_000, directTools: true, toolPrefix: "none" } } }, null, 2));

const prompt = `Delegate this task to the vm-relay-operator agent and do not use the relay tools yourself: ${instruction} `
  + "Tell the agent to use the macos26 image, and to read macarena-task.json in the project directory: before the task, run each "
  + "`prepare` command with relay_exec, in order, with its argv exactly as written; after the task and before relay_finish, run each "
  + "`check` command the same way and report each one's stdout. "
  + "When the agent finishes, tell me its result and what the window showed.";
const args = [join(environment.repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--no-extensions",
  ...[...environment.extensions, MCP_ADAPTER].flatMap(extension => ["--extension", extension]),
  // The parent keeps read, the relay tools and the delegation tools; no built-in tool that acts on the host.
  "--exclude-tools", "bash,edit,write,grep,find,ls",
  "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve",
  "--session-dir", environment.sessions, "--model", model, "--mode", "rpc"];
const adapterVersion = (JSON.parse(readFileSync(join(MCP_ADAPTER, "package.json"), "utf8")) as { version: string }).version;
writeFileSync(join(environment.artifacts, "invocation.json"), JSON.stringify({ args, cwd: environment.project, prompt, task: basename(taskFile),
  operatorDefinition: OPERATOR_DEFINITION, mcpAdapter: `${MCP_ADAPTER}@${adapterVersion}`, mcpConfig: JSON.parse(readFileSync(mcpConfig, "utf8")) }, null, 2) + "\n");

const started = Date.now();
const child = spawn(process.execPath, args, { cwd: environment.project, env: environment.env, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = "", agentEnds = 0;
child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
child.stdout.on("data", (text: string) => {
  stdout += text;
  for (const line of text.split("\n")) {
    if (line.includes('"type":"agent_end"')) agentEnds++;
    if (line.includes('"type":"tool_execution_start"')) { try { log(`${Math.round((Date.now() - started) / 1000)}s parent tool: ${JSON.parse(line).toolName}`); } catch {} }
  }
});
child.stderr.on("data", (text: string) => { stderr += text; });
child.stdin.write(JSON.stringify({ id: "prompt-1", type: "prompt", message: prompt }) + "\n");
log(`Pi with ${model}, the vm-relay-operator subagent and pi-mcp-adapter ${adapterVersion}; project ${environment.project}`);

const database = join(environment.state, "pi-secretary-goals.sqlite");
const runs = (): Run[] => {
  if (!existsSync(database)) return [];
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare("SELECT json FROM secretary_agent_runs").all().map(row => JSON.parse(String((row as { json: string }).json))); }
  catch { return []; } finally { db.close(); }
};
const TERMINAL = ["succeeded", "failed", "cancelled", "partial"];
const TIMEOUT_MS = 25 * 60_000;
let finishedAt: number | undefined, endsAtFinish = 0, lastStatus = "";
while (Date.now() - started < TIMEOUT_MS && child.exitCode === null) {
  await new Promise(done => setTimeout(done, 5000));
  const all = runs();
  const status = all.map(run => run.status ?? "none").join(", ") || "none";
  if (status !== lastStatus) { log(`${Math.round((Date.now() - started) / 1000)}s run status: ${status}`); lastStatus = status; }
  if (!(all.length > 0 && all.every(run => TERMINAL.includes(run.status ?? "")))) { finishedAt = undefined; continue; }
  if (!finishedAt) { finishedAt = Date.now(); endsAtFinish = agentEnds; }
  // After the last run ends, the parent takes one more turn to report it.
  if (agentEnds > endsAtFinish || Date.now() - finishedAt > 3 * 60_000) break;
}
const elapsedMs = Date.now() - started;
log(`${Math.round(elapsedMs / 1000)}s ${Date.now() - started >= TIMEOUT_MS ? "timed out after 25 minutes" : "the parent reported"}; stopping Pi.`);
const evidence = join(environment.project, "relay-evidence");
const unfinished = () => relayLeases(evidence).filter(lease => !lease.finished).map(lease => lease.name);
const running = () => runs().flatMap((run, index) => TERMINAL.includes(run.status ?? "") ? [] : [`run ${index + 1} (${run.status ?? "no status"})`]);
await stopPi(child, { unfinished: () => [...unfinished(), ...running()], leaseWaitMs: 20 * 60_000, exitGraceMs: 60_000, pollMs: 5000 });
writeFileSync(join(environment.artifacts, "stdout.jsonl"), environment.redact(stdout));
writeFileSync(join(environment.artifacts, "stderr.log"), environment.redact(stderr));
log(unfinished().length ? `Relay leases not finished when Pi was stopped: ${unfinished().join(", ")}.` : `Every relay lease was finished (${relayLeases(evidence).length}).`);
if (existsSync(evidence)) cpSync(evidence, join(environment.artifacts, "relay-evidence"), { recursive: true });
cpSync(join(environment.project, "macarena-task.json"), join(environment.artifacts, "macarena-task.json"));
const all = runs();
writeFileSync(join(environment.artifacts, "runs.json"), environment.redact(JSON.stringify(all, null, 2)));
profile.redactArtifacts();

// Whether the parent called a relay tool itself, from its own session.
const parentRelayCalls = readdirSync(environment.sessions).filter(name => name.endsWith(".jsonl"))
  .flatMap(name => readFileSync(join(environment.sessions, name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)))
  .flatMap(entry => entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content) ? entry.message.content : [])
  .filter((block: { type: string; name?: string }) => block.type === "toolCall" && block.name?.startsWith("relay_")).map((block: { name: string }) => block.name);
const checks = recordedChecks(join(environment.artifacts, "relay-evidence"), check);
const taskScore = score(task, checks);
const record = { task: task.id, file: basename(taskFile), run: 1, started: new Date(started).toISOString(), openApp: openApp ?? null, instruction: task.instruction,
  score: taskScore ?? null, elapsedS: Math.round(elapsedMs / 1000), model, runStatus: all.map(run => run.status), parentRelayCalls,
  agentReport: all.at(-1)?.output ?? null, checks: checks ?? null, unfinishedLeases: unfinished(), artifacts: environment.artifacts };
appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(record)}\n`);
log(`MacArena ${task.id} in Pi with the relay tools directly: score ${taskScore ?? "none"}. Artifacts: ${environment.artifacts}`);
console.log(`Results: ${join(out, "results.jsonl")}`);
