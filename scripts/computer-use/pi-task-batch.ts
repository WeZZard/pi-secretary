/**
 * Runs Pi on fixed desktop tasks several times and checks each outcome with code (research §14).
 * It is meant for a disposable macOS virtual machine: it kills and relaunches Calculator, TextEdit
 * and Finder, writes fixtures, and opens Safari over them.
 *
 *   node --experimental-strip-types scripts/computer-use/pi-task-batch.ts [repeats] [task,...]
 *
 * Pi runs with only this worktree's secretary extension, the LiteLLM provider, the Qwen planner and
 * the two computer-use tools, as in research §11. The guest's ~/.pi/agent/secretary.json selects the
 * local backend.
 *
 * Formulas, held for every number this script prints:
 * - Task done: after Pi exits, a code check of the window holds (see each task's `check`).
 * - Answer states the result: Pi's final text contains the checked result (10, the typed line, or the file name).
 *   It does not test whether the answer claims checks that were not made.
 * - Pi wall time (s): from starting Pi to its exit.
 * - Driver call time, median (ms): from spawning `cua-driver call` to its parsed output, over 10 calls. The lsappinfo row
 *   times the backend's lsappinfoFrontmost, which runs two lsappinfo processes, the same way.
 * - Active application agreement: with each app brought to front, lsappinfo's pid equals the one active pid of list_apps.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RawElement, WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { cuaDriverRunner, LocalDriverBackend, lsappinfoFrontmost } from "../../extensions/secretary/computer-use/backend/local-backend.ts";
import { BIDI_MARKS, observe, type Observation } from "../../extensions/secretary/computer-use/observer.ts";

const repeats = Number(process.argv[2] ?? 3);
const only = process.argv[3]?.split(",");
const run = cuaDriverRunner(process.env.CUA_DRIVER ?? "cua-driver");
const backend = new LocalDriverBackend({ run, maxTreeNodes: 2000, foregroundDelivery: true });
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const out = resolve("test-results/computer-use-pi", `batch-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const content = join(out, "content");
mkdirSync(content, { recursive: true });
const sh = (command: string) => { try { execFileSync("/bin/zsh", ["-c", command], { stdio: "ignore", timeout: 30_000 }); } catch { /* best effort */ } };
const clean = (text: string | undefined) => (text ?? "").replace(BIDI_MARKS, "").replace(/\s+/g, " ").trim();

// Fixtures. File names are fixed, so the Finder target sorts last in every run.
const SCRATCH = "Disposable document for the computer-use batch.\nSecond line of the document.";
writeFileSync(join(content, "scratch.txt"), SCRATCH);
const folder = join(content, "Fixture Folder");
mkdirSync(folder, { recursive: true });
const FILES = ["Agenda", "Appendix", "Archive", "Backups", "Budget draft", "Calendar", "Contacts", "Contract", "Diagram", "Drafts",
  "Estimates", "Expenses", "Feedback", "Forecast", "Glossary", "Guidelines", "Handbook", "Invoices", "Itinerary", "Journal",
  "Ledger", "Letters", "Minutes", "Notes", "Outline", "Plans", "Proposal", "Queries", "Receipts", "Reports",
  "Schedule", "Slides", "Summary", "Templates", "Timeline", "Todo", "Updates", "Vendors", "Workshop", "Zoning notes"];
for (const name of FILES) writeFileSync(join(folder, `${name}.txt`), `${name}\n`);
writeFileSync(join(content, "cover.html"), "<!doctype html><title>Cover</title><h1>A window that covers the others</h1>");
// Relaunched apps must not restore the previous run's windows or unsaved text.
sh("defaults write com.apple.TextEdit ApplePersistenceIgnoreState -bool YES; defaults write NSGlobalDomain NSQuitAlwaysKeepsWindows -bool false");

const read = (app: string, windowTitle?: string) => backend.readWindow({ app, ...(windowTitle ? { windowTitle } : {}) }, { screenshot: false });
const look = (windowRead: WindowRead): Observation | undefined => {
  const result = observe(windowRead, { id: "batch", maxElements: 240, maxNameLength: 200 });
  return result.status === "ready" ? result : undefined;
};
const textOf = (windowRead: WindowRead, element: RawElement) => clean(element.label || element.value || windowRead.descendantText?.[element.element_index]);
const cover = async () => { sh(`open -a Safari ${JSON.stringify(join(content, "cover.html"))}`); await wait(2500); };

interface Task {
  name: string;
  prompt: string;
  /** Puts the app in a known state and returns a reason when it could not. */
  setup(): Promise<string | undefined>;
  /** Reads the window after Pi exits. */
  check(): Promise<{ done: boolean; detail: string }>;
  /** Whether the final text states the checked result. */
  answered(final: string): boolean;
}

const calculator: Task = {
  name: "calculator",
  prompt: "In the Calculator app, compute 7 plus 3 and tell me the result shown on the display.",
  async setup() {
    sh("killall Calculator"); await wait(1000); sh("open -a Calculator"); await wait(2500);
    for (let press = 0; press < 2; press++) {
      const windowRead = await read("Calculator");
      const clear = windowRead.elements.find(element => element.role === "AXButton" && /^(all )?clear$/i.test(element.label ?? "") && element.frame);
      if (!clear) break;
      const f = clear.frame!;
      await backend.act(windowRead.window, { kind: "click", point: { x: f.x + f.w / 2, y: f.y + f.h / 2 }, button: "left", count: 1 });
      await wait(400);
    }
    const texts = look(await read("Calculator"))?.texts ?? [];
    return texts.some(text => clean(text) === "0") ? undefined : `the display did not read 0: ${JSON.stringify(texts)}`;
  },
  async check() {
    const texts = (look(await read("Calculator"))?.texts ?? []).map(clean);
    return { done: texts.some(text => /(^|[\s=])10$/.test(text)), detail: `display text ${JSON.stringify(texts)}` };
  },
  answered: final => /\b10\b/.test(final),
};

const textEdit: Task = {
  name: "textedit",
  prompt: "In TextEdit, the document scratch.txt is open. Add a new last line that says: Hello from Pi",
  async setup() {
    sh("killall -9 TextEdit"); await wait(1000);
    writeFileSync(join(content, "scratch.txt"), SCRATCH);
    sh(`open -a TextEdit ${JSON.stringify(join(content, "scratch.txt"))}`); await wait(2500);
    const value = (await read("TextEdit", "scratch.txt")).elements.find(element => element.role === "AXTextArea")?.value;
    return value === SCRATCH ? undefined : `the document did not reset: ${JSON.stringify(value?.slice(0, 120))}`;
  },
  async check() {
    const value = (await read("TextEdit", "scratch.txt")).elements.find(element => element.role === "AXTextArea")?.value ?? "";
    const done = value.replace(/\n+$/, "") === `${SCRATCH}\nHello from Pi`;
    return { done, detail: `document ends ${JSON.stringify(value.slice(-60))}` };
  },
  answered: final => /Hello from Pi/.test(final),
};

const TARGET = "Zoning notes.txt";
const finder: Task = {
  name: "finder",
  prompt: `In Finder, the window "Fixture Folder" is open. Select the file named ${TARGET}.`,
  async setup() {
    sh("killall Finder"); await wait(3000); sh(`open ${JSON.stringify(folder)}`); await wait(2500);
    const windowRead = await read("Finder", "Fixture Folder");
    const selected = windowRead.elements.filter(element => element.selected).map(element => textOf(windowRead, element));
    if (selected.some(name => name.includes(TARGET))) return "the target was already selected";
    return undefined;
  },
  async check() {
    const windowRead = await read("Finder", "Fixture Folder");
    const selected = windowRead.elements.filter(element => element.selected).map(element => textOf(windowRead, element)).filter(Boolean);
    return { done: selected.some(name => name.includes(TARGET)), detail: `selected ${JSON.stringify(selected.slice(0, 5))}` };
  },
  answered: final => final.includes(TARGET.replace(/\.txt$/, "")),
};

interface PiRun { exit: number | null; seconds: number; calls: { tool: string; result: string }[]; final: string }
function runPi(name: string, prompt: string): Promise<PiRun> {
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  const command = [
    "source ~/.config/zsh/secrets.zsh 2>/dev/null;",
    `export PI_SECRETARY_DB_DIR=${JSON.stringify(join(dir, "secretary"))};`,
    "pi --print --mode json --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files",
    `-e ${join(homedir(), ".pi/agent/npm/node_modules/pi-provider-litellm")} -e ${JSON.stringify(resolve("extensions/secretary/index.ts"))}`,
    "--model litellm/qwen3.8-27b --tools computer_observe,computer_run_plan", JSON.stringify(prompt),
    `> ${JSON.stringify(join(dir, "events.jsonl"))} 2> ${JSON.stringify(join(dir, "stderr.txt"))}`,
  ].join(" ");
  const started = performance.now();
  return new Promise(done => {
    const child = spawn("/bin/zsh", ["-c", command], { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 8 * 60_000);
    child.on("exit", exit => {
      clearTimeout(timer);
      const events = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const calls: PiRun["calls"] = [];
      for (const event of events) {
        if (event.type === "tool_execution_end") {
          const text = (event.result?.content ?? []).filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join(" ");
          calls.push({ tool: event.toolName, result: text.split("\n")[0]!.slice(0, 160) });
        }
      }
      const last = events.filter(event => event.type === "message_end" && event.message?.role === "assistant").at(-1);
      const final = (last?.message?.content ?? []).filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join(" ").trim();
      done({ exit, seconds: (performance.now() - started) / 1000, calls, final });
    });
  });
}

// Driver call times, measured before any task so that no Pi run is in flight.
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
sh(`open -a TextEdit ${JSON.stringify(join(content, "scratch.txt"))}`); await wait(2500);
const timings: string[] = [];
const textEditWindow = (await read("TextEdit", "scratch.txt")).window;
for (const [tool, args] of [["list_apps", {}], ["list_windows", {}], ["get_window_state", { pid: textEditWindow.pid, window_id: textEditWindow.windowId, max_elements: 2000, include_screenshot: false }]] as const) {
  const times: number[] = [];
  for (let i = 0; i < 10; i++) { const started = performance.now(); await run(tool, args, { timeoutMs: 30_000 }); times.push(performance.now() - started); }
  timings.push(`| ${tool} | ${Math.round(median(times))} | ${Math.round(Math.min(...times))} | ${Math.round(Math.max(...times))} |`);
}
// The backend's source of the active application, lsappinfo, timed and compared with list_apps
// with each test application in front, then with Safari in front.
const agreement: string[] = [];
{
  const times: number[] = [];
  for (let i = 0; i < 10; i++) { const started = performance.now(); await lsappinfoFrontmost({ timeoutMs: 30_000 }); times.push(performance.now() - started); }
  timings.push(`| lsappinfo front, then info -only pid | ${Math.round(median(times))} | ${Math.round(Math.min(...times))} | ${Math.round(Math.max(...times))} |`);
  for (const app of ["Calculator", "TextEdit", "Finder", "Safari"]) {
    sh(`open -a ${app}`); await wait(1500);
    const front = await lsappinfoFrontmost({ timeoutMs: 30_000 });
    const listed = await run("list_apps", {}, { timeoutMs: 30_000 }) as { apps?: { pid: number; name?: string; active?: boolean }[] } | { pid: number; name?: string; active?: boolean }[];
    const active = (Array.isArray(listed) ? listed : listed.apps ?? []).filter(entry => entry.active === true);
    const same = active.length === 1 && active[0]!.pid === front;
    agreement.push(`| ${app} | ${front ?? "none"} | ${active.map(entry => `${entry.name ?? "?"} ${entry.pid}`).join(", ") || "none"} | ${same ? "yes" : "no"} |`);
  }
}

const tasks = [calculator, textEdit, finder].filter(task => !only || only.includes(task.name));
const rows: string[] = [];
const results: Record<string, unknown>[] = [];
for (let round = 1; round <= repeats; round++) {
  for (const task of tasks) {
    const name = `${task.name}-${round}`;
    let setupFailure: string | undefined;
    try { setupFailure = await task.setup(); } catch (error) { setupFailure = (error as Error).message; }
    if (setupFailure) { rows.push(`| ${name} | setup failed | | | | | ${setupFailure.replace(/\|/g, "/")} |`); results.push({ name, setupFailure }); continue; }
    await cover();
    const pi = await runPi(name, task.prompt);
    let check: { done: boolean; detail: string };
    try { check = await task.check(); } catch (error) { check = { done: false, detail: `check failed: ${(error as Error).message}` }; }
    const plans = pi.calls.filter(call => call.tool === "computer_run_plan");
    const outcomes = plans.map(call => call.result.replace(/^Outcome: (\w+).*$/, "$1").replace(/^Plan rejected.*$/, "rejected")).join(", ") || "none";
    const answered = task.answered(pi.final);
    rows.push(`| ${name} | ${check.done ? "done" : "not done"} | ${answered ? "yes" : "no"} | ${pi.calls.length - plans.length} / ${plans.length} | ${outcomes} | ${pi.seconds.toFixed(0)} | ${check.detail.replace(/\|/g, "/")} |`);
    results.push({ name, exit: pi.exit, seconds: pi.seconds, done: check.done, answered, check: check.detail, calls: pi.calls, final: pi.final.slice(0, 1500) });
    console.log(rows.at(-1));
  }
}
rmSync(join(content, "Fixture Folder"), { recursive: true, force: true });

const summary = tasks.map(task => {
  const of = results.filter(result => String(result.name).startsWith(`${task.name}-`));
  const ran = of.filter(result => !result.setupFailure);
  return `| ${task.name} | ${ran.length} of ${of.length} | ${ran.filter(result => result.done).length} of ${ran.length} | ${ran.filter(result => result.answered).length} of ${ran.length} |`;
});
const report = ["# Pi task batch", "", `Date: ${new Date().toISOString()}. Repeats: ${repeats}.`, "",
  "## Summary", "", "| Task | Runs with a clean setup | Task done | Answer states the result |", "| --- | --- | --- | --- |", ...summary, "",
  "## Runs", "", "| Run | Task | Answer states the result | Observe calls / plan calls | Plan outcomes | Pi wall time (s) | Check |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows, "",
  "## Driver call time", "", "| Call | Median (ms) | Min (ms) | Max (ms) |", "| --- | --- | --- | --- |", ...timings, "",
  "## Active application: lsappinfo and list_apps", "", "| Brought to front | lsappinfo pid | list_apps active | Same |", "| --- | --- | --- | --- |", ...agreement, ""].join("\n");
writeFileSync(join(out, "report.md"), report);
writeFileSync(join(out, "runs.json"), `${JSON.stringify(results, null, 1)}\n`);
console.log(`\n${report}\nOutput: ${out}`);
