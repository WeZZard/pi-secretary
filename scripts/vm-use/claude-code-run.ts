/**
 * Evaluation §7.1 (decision PS-D29): run one MacArena task through Claude Code, delegated to Claude Code's native
 * subagent for the relay (the mcp-vm-relay plugin's vm-relay-operator), for a time comparison with the Pi run.
 * It makes model calls through the owner's Claude Code.
 *
 *   node --experimental-strip-types scripts/vm-use/claude-code-run.ts [--open-app] [--out=DIR] <task.json>
 *
 * The project is a new empty directory outside the owner's home. The subagent runs the task's preparation and
 * check itself with relay_exec, from `macarena-task.json` in the project; the score comes from the check's output
 * in the relay evidence. Output: DIR (default a new test-results/vm-use/claude-code-<time>/) gets
 * results.jsonl; the run's artifacts go to a new test-results/e2e/claude-code-<task>/<time>/.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appsOf, instructionFor, loadTask, score, toCommands } from "./support/macarena.ts";
import { recordedChecks } from "./support/relay-records.ts";

const flags = new Map(process.argv.slice(2).filter(arg => arg.startsWith("--")).map(arg => { const [key, value] = arg.slice(2).split("="); return [key!, value ?? "true"]; }));
const [taskFile] = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
if (!taskFile) { console.error("usage: claude-code-run.ts [--open-app] [--out=DIR] <task.json>"); process.exit(2); }
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const repository = join(import.meta.dirname, "../..");
const out = flags.get("out") ?? join(repository, "test-results/vm-use", `claude-code-${stamp()}`);
mkdirSync(out, { recursive: true });

const task = loadTask(taskFile);
const apps = appsOf(task);
const openApp = flags.has("open-app") ? apps.length === 1 ? apps[0] : undefined : undefined;
if (flags.has("open-app") && !openApp) { console.error(`--open-app needs exactly one application, found ${apps.join(", ") || "none"}`); process.exit(2); }
const { prepare, check } = toCommands(task, openApp ? { openApp } : {});
const instruction = instructionFor(task.instruction, openApp);

const artifacts = join(repository, "test-results/e2e", `claude-code-${task.id.slice(0, 8)}`, stamp());
mkdirSync(artifacts, { recursive: true });
const log = (line: string) => { console.log(line); appendFileSync(join(artifacts, "log.txt"), `${line}\n`); };
const project = realpathSync(mkdtempSync(join(tmpdir(), "claude-code-macarena-")));
writeFileSync(join(project, "macarena-task.json"), `${JSON.stringify({ image: "macos26", instruction, prepare, check }, null, 2)}\n`);

const OPERATOR = "mcp-vm-relay:vm-relay-operator";
const RELAY_SERVER = "mcp__plugin_mcp-vm-relay_relay";
const prompt = `Delegate this task to the ${OPERATOR} agent and do not use the relay tools yourself: ${instruction} `
  + "Tell the agent to use the macos26 image, and to read macarena-task.json in the project directory: before the task, run each "
  + "`prepare` command with relay_exec, in order, with its argv exactly as written; after the task and before relay_finish, run each "
  + "`check` command the same way and report each one's stdout. "
  + "When the agent finishes, tell me its result and what the window showed.";
const sessionId = randomUUID();
const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--session-id", sessionId,
  // The main session cannot act on the host's desktop, as Pi's parent cannot (evaluation §3).
  "--tools", "Agent,Read,Glob,Grep", "--allowedTools", `Agent ${RELAY_SERVER}`,
  "--permission-mode", "dontAsk", "--permission-prompts", "none"];
const version = spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim();
writeFileSync(join(artifacts, "invocation.json"), `${JSON.stringify({ claude: version, cwd: project, args, prompt, task: basename(taskFile) }, null, 2)}\n`);

const TIMEOUT_MS = 25 * 60_000;
const started = Date.now();
log(`Claude Code ${version}, session ${sessionId}, project ${project}`);
const child = spawn("claude", args, { cwd: project, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
child.stdout.on("data", (text: string) => {
  stdout += text;
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    try {
      const event = JSON.parse(line) as { message?: { content?: { type: string; name?: string }[] }; parent_tool_use_id?: string | null };
      for (const block of event.message?.content ?? []) if (block.type === "tool_use") log(`${Math.round((Date.now() - started) / 1000)}s ${event.parent_tool_use_id ? "subagent" : "main"} tool: ${block.name}`);
    } catch {}
  }
});
child.stderr.on("data", (text: string) => { stderr += text; });
const timer = setTimeout(() => { log("Timed out after 25 minutes; stopping Claude Code."); child.kill("SIGTERM"); }, TIMEOUT_MS);
const exitCode = await new Promise<number | null>(done => child.on("exit", code => done(code)));
clearTimeout(timer);
const elapsedMs = Date.now() - started;
log(`Claude Code exited ${exitCode} after ${Math.round(elapsedMs / 1000)} s.`);

writeFileSync(join(artifacts, "stream.jsonl"), stdout);
writeFileSync(join(artifacts, "stderr.log"), stderr);
// Claude Code keeps the session under ~/.claude/projects/<project slug>/: the main transcript and its subagents.
const projects = join(homedir(), ".claude/projects");
const slug = readdirSync(projects).find(dir => existsSync(join(projects, dir, `${sessionId}.jsonl`)));
if (slug) {
  mkdirSync(join(artifacts, "transcripts"));
  cpSync(join(projects, slug, `${sessionId}.jsonl`), join(artifacts, "transcripts", "main.jsonl"));
  const subagents = join(projects, slug, sessionId, "subagents");
  if (existsSync(subagents)) cpSync(subagents, join(artifacts, "transcripts", "subagents"), { recursive: true });
} else log("No session transcript was found.");
const evidence = join(project, "relay-evidence");
if (existsSync(evidence)) cpSync(evidence, join(artifacts, "relay-evidence"), { recursive: true });
cpSync(join(project, "macarena-task.json"), join(artifacts, "macarena-task.json"));

const checks = recordedChecks(join(artifacts, "relay-evidence"), check);
const taskScore = score(task, checks);
const result = [...stdout.trim().split("\n")].reverse().map(line => { try { return JSON.parse(line); } catch { return undefined; } })
  .find(event => event?.type === "result") as { result?: string; is_error?: boolean; num_turns?: number; total_cost_usd?: number } | undefined;
const record = { task: task.id, file: basename(taskFile), run: 1, started: new Date(started).toISOString(), openApp: openApp ?? null, instruction: task.instruction,
  score: taskScore ?? null, elapsedS: Math.round(elapsedMs / 1000), exitCode, claude: version, sessionId,
  agentReport: result?.result ?? null, checks: checks ?? null, artifacts };
appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(record)}\n`);
log(`MacArena ${task.id} in Claude Code: score ${taskScore ?? "none"}. Artifacts: ${artifacts}`);
console.log(`Results: ${join(out, "results.jsonl")}`);
