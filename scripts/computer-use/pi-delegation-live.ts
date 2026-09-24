/**
 * Live delegation check: a real Pi parent in RPC mode delegates a desktop task to the
 * computer-use agent definition, which runs through the relay client in a fresh relay virtual
 * machine, with the real LiteLLM model and the executor at jev.home.arpa. It makes model calls.
 *
 *   node --experimental-strip-types scripts/computer-use/pi-delegation-live.ts [model] [executor-url]
 *
 * Output: a new directory under test-results/e2e/computer-use-delegation/.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCleanPiEnvironment } from "../../tests/e2e/environment/isolation.ts";
import { useGlobalLiteLLM } from "../../tests/e2e/environment/global-litellm.ts";
import { DEFAULT_RELAY_COMMAND } from "../../extensions/secretary/computer-use/configuration.ts";

const [modelId = "qwen3.8-27b", executorUrl = "http://jev.home.arpa"] = process.argv.slice(2);
const TIMEOUT_MS = 20 * 60_000;
const environment = createCleanPiEnvironment({ name: "computer-use-delegation",
  extensionUnderTest: join(import.meta.dirname, "../../extensions/secretary/index.ts"),
  projectFixture: join(import.meta.dirname, "../../tests/e2e/fixtures/computer-use/project") });
const profile = useGlobalLiteLLM(environment, undefined, { model: modelId });
const model = `${profile.provider}/${profile.model}`;
const log = (line: string) => { console.log(line); writeFileSync(join(environment.artifacts, "log.txt"), `${line}\n`, { flag: "a" }); };

mkdirSync(join(environment.agentDir, "agents"));
cpSync(join(import.meta.dirname, "../../extensions/secretary/computer-use/templates/computer-use.md"), join(environment.agentDir, "agents", "computer-use.md"));
writeFileSync(join(environment.agentDir, "secretary.json"), JSON.stringify({
  agents: { modelFallbackLists: { "computer-use": [model] }, subagentModels: { "computer-use": "computer-use" } },
  computerUse: {
    backend: "relay", relayImage: "macos26", relayEnv: "default", relayTtlHours: 1,
    // The isolated Pi environment replaces HOME; the relay keeps its state and credential packs under the real one.
    relayCommand: ["/usr/bin/env", `HOME=${homedir()}`, ...DEFAULT_RELAY_COMMAND],
    relayPrepare: [["/usr/bin/open", "-a", "Calculator"]],
    executorUrl, executorTimeoutMs: 60_000,
  },
}, null, 2));

const prompt = "Delegate this task to the computer-use agent and do not use the computer tools yourself: "
  + "in the Calculator app, which is already open, compute 7 plus 3 and report the result the display shows. "
  + "When the agent finishes, tell me its result and what it verified.";
const args = [join(environment.repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--no-extensions",
  ...environment.extensions.flatMap(extension => ["--extension", extension]),
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
const runs = (): { status?: string; background?: boolean; output?: string; subagentType?: string }[] => {
  if (!existsSync(database)) return [];
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare("SELECT json FROM secretary_agent_runs").all().map(row => JSON.parse(String((row as { json: string }).json))); }
  catch { return []; } finally { db.close(); }
};
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
let finishedAt: number | undefined, endsAtFinish = 0, lastStatus = "";
while (Date.now() - started < TIMEOUT_MS) {
  await wait(5000);
  const run = runs()[0];
  const status = run?.status ?? "none";
  if (status !== lastStatus) { log(`${Math.round((Date.now() - started) / 1000)}s run status: ${status}`); lastStatus = status; }
  if (!finishedAt && ["succeeded", "failed", "cancelled", "partial"].includes(status)) { finishedAt = Date.now(); endsAtFinish = agentEnds; }
  // After the run ends, the parent takes one more turn to report it.
  if (finishedAt && (agentEnds > endsAtFinish || Date.now() - finishedAt > 3 * 60_000)) break;
}
child.stdin.end();
child.kill("SIGTERM");
await wait(3000);
writeFileSync(join(environment.artifacts, "stdout.jsonl"), environment.redact(stdout));
writeFileSync(join(environment.artifacts, "stderr.log"), environment.redact(stderr));
const evidence = join(environment.project, "relay-evidence");
// The relay server finishes the lease after the agent's session ends, which can outlast Pi by minutes.
const finished = () => existsSync(evidence) && readdirSync(evidence).some(name => name.endsWith(".lifecycle.json"));
for (const deadline = Date.now() + 10 * 60_000; !finished() && Date.now() < deadline;) await wait(5000);
log(finished() ? "The relay lease was finished." : "The relay lease was not finished within 10 minutes of stopping Pi.");
if (existsSync(evidence)) cpSync(evidence, join(environment.artifacts, "relay-evidence"), { recursive: true });
writeFileSync(join(environment.artifacts, "runs.json"), environment.redact(JSON.stringify(runs(), null, 2)));
profile.redactArtifacts();
const run = runs()[0];
log(`\nElapsed: ${Math.round((Date.now() - started) / 1000)} s (wall clock from sending the prompt to stopping Pi)`);
log(`Run: ${run ? `${run.subagentType ?? ""} background=${run.background} status=${run.status}` : "none"}`);
log(`Run output:\n${run?.output ?? ""}`);
log(`Output: ${environment.artifacts}`);
log(`Workspace kept for inspection: ${environment.workspace}`);
