/**
 * Live delegation check: a real Pi parent in RPC mode delegates a desktop task to the
 * computer-use agent definition, which runs through the relay client in a fresh relay virtual
 * machine, with the real LiteLLM model and the executor at jev.home.arpa. It makes model calls.
 *
 *   node --experimental-strip-types scripts/computer-use/pi-delegation-live.ts [model] [executor-url] [task]
 *
 * The task is calculator (the default), textedit or finder, as in the Pi task batch (research §14),
 * or simulator-about or simulator-dark-mode, which operate an iPhone simulator.
 * Each task's setup runs in the guest after staging, because the computer-use tools do not launch
 * applications.
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

const [modelId = "qwen3.8-27b", executorUrl = "http://jev.home.arpa", taskName = "calculator"] = process.argv.slice(2);

// Fixtures match scripts/computer-use/pi-task-batch.ts, so results compare with research §14.
const FILES = ["Agenda", "Appendix", "Archive", "Backups", "Budget draft", "Calendar", "Contacts", "Contract", "Diagram", "Drafts",
  "Estimates", "Expenses", "Feedback", "Forecast", "Glossary", "Guidelines", "Handbook", "Invoices", "Itinerary", "Journal",
  "Ledger", "Letters", "Minutes", "Notes", "Outline", "Plans", "Proposal", "Queries", "Receipts", "Reports",
  "Schedule", "Slides", "Summary", "Templates", "Timeline", "Todo", "Updates", "Vendors", "Workshop", "Zoning notes"];
const shell = (script: string) => ["/bin/zsh", "-c", script];
const SIMULATOR_PREPARE = [
  shell("udid=$(xcrun simctl list devices available | grep -m1 -E '^ +iPhone 17 \\(' | grep -oE '[0-9A-F-]{36}') && xcrun simctl boot $udid"
    + " && xcrun simctl bootstatus $udid -b"),
  ["/usr/bin/open", "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"],
  shell("sleep 10"),
];
const TASKS: Record<string, { task: string; prepare: string[][] }> = {
  calculator: {
    task: "in the Calculator app, which is already open, compute 7 plus 3 and report the result the display shows.",
    prepare: [["/usr/bin/open", "-a", "Calculator"]],
  },
  textedit: {
    task: "in TextEdit, the document scratch.txt is open. Add a new last line that says: Hello from Pi",
    prepare: [shell("defaults write com.apple.TextEdit ApplePersistenceIgnoreState -bool YES; mkdir -p ~/cu-fixtures"
      + " && printf 'Disposable document for the computer-use batch.\\nSecond line of the document.' > ~/cu-fixtures/scratch.txt"
      + " && open -a TextEdit ~/cu-fixtures/scratch.txt && sleep 3")],
  },
  // The macos26 image has Xcode with an iOS 26.5 runtime; Simulator.app is only inside Xcode's bundle,
  // and a first boot of this device took 27 s (relay probe of 2026-09-26).
  "simulator-about": {
    task: "in the iPhone simulator, which is already open, open the Settings app, then General, then About, and report the iOS version it shows.",
    prepare: SIMULATOR_PREPARE,
  },
  "simulator-dark-mode": {
    task: "in the iPhone simulator, which is already open, open the Settings app, go to Display & Brightness, turn on Dark Mode, and report whether Dark Mode is on.",
    prepare: SIMULATOR_PREPARE,
  },
  finder: {
    task: "in Finder, the window \"Fixture Folder\" is open. Select the file named Zoning notes.txt.",
    prepare: [shell(`mkdir -p ~/cu-fixtures/"Fixture Folder" && cd ~/cu-fixtures/"Fixture Folder" && for f in ${FILES.map(name => JSON.stringify(name)).join(" ")}; do printf '%s\\n' "$f" > "$f.txt"; done`
      + " && open ~/cu-fixtures/\"Fixture Folder\" && sleep 3")],
  },
};
const selected = TASKS[taskName];
if (!selected) throw new Error(`unknown task ${taskName}; expected ${Object.keys(TASKS).join(", ")}`);
const TIMEOUT_MS = 20 * 60_000;
const environment = createCleanPiEnvironment({ name: `computer-use-delegation${taskName === "calculator" ? "" : `-${taskName}`}`,
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
    relayPrepare: selected.prepare,
    executorUrl, executorTimeoutMs: 60_000,
  },
}, null, 2));

const prompt = `Delegate this task to the computer-use agent and do not use the computer tools yourself: ${selected.task} `
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
const TERMINAL = ["succeeded", "failed", "cancelled", "partial"];
let finishedAt: number | undefined, endsAtFinish = 0, lastStatus = "";
while (Date.now() - started < TIMEOUT_MS) {
  await wait(5000);
  // The parent may delegate again after a run ends, so every run must end, not only the first.
  const all = runs();
  const status = all.map(run => run.status ?? "none").join(", ") || "none";
  if (status !== lastStatus) { log(`${Math.round((Date.now() - started) / 1000)}s run status: ${status}`); lastStatus = status; }
  const ended = all.length > 0 && all.every(run => TERMINAL.includes(run.status ?? ""));
  if (!ended) { finishedAt = undefined; continue; }
  if (!finishedAt) { finishedAt = Date.now(); endsAtFinish = agentEnds; }
  // After the last run ends, the parent takes one more turn to report it.
  if (agentEnds > endsAtFinish || Date.now() - finishedAt > 3 * 60_000) break;
}
child.stdin.end();
child.kill("SIGTERM");
await wait(3000);
writeFileSync(join(environment.artifacts, "stdout.jsonl"), environment.redact(stdout));
writeFileSync(join(environment.artifacts, "stderr.log"), environment.redact(stderr));
const evidence = join(environment.project, "relay-evidence");
// The relay server finishes a lease after the agent's session ends, which can outlast Pi by minutes.
// A lease that acquired a machine has the relay's host configuration; a refused acquisition has only events.
const leases = () => existsSync(evidence) ? readdirSync(evidence).filter(name => existsSync(join(evidence, name, "host", "mcp-host-config.json"))) : [];
const unfinished = () => leases().filter(name => !existsSync(join(evidence, `${name}.lifecycle.json`)));
for (const deadline = Date.now() + 10 * 60_000; unfinished().length && Date.now() < deadline;) await wait(5000);
log(unfinished().length ? `Relay leases not finished within 10 minutes of stopping Pi: ${unfinished().join(", ")}.` : `Every relay lease was finished (${leases().length}).`);
if (existsSync(evidence)) cpSync(evidence, join(environment.artifacts, "relay-evidence"), { recursive: true });
writeFileSync(join(environment.artifacts, "runs.json"), environment.redact(JSON.stringify(runs(), null, 2)));
profile.redactArtifacts();
log(`\nElapsed: ${Math.round((Date.now() - started) / 1000)} s (wall clock from sending the prompt to stopping Pi)`);
const all = runs();
if (!all.length) log("Run: none");
for (const [index, run] of all.entries()) {
  log(`Run ${index + 1} of ${all.length}: ${run.subagentType ?? ""} background=${run.background} status=${run.status}`);
  log(`Run output:\n${run.output ?? ""}`);
}
log(`Output: ${environment.artifacts}`);
log(`Workspace kept for inspection: ${environment.workspace}`);
