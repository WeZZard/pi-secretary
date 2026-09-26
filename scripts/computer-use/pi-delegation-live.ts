/**
 * Live delegation check: a real Pi parent in RPC mode delegates a desktop task to the computer-use
 * agent definition, which runs through the relay client in a fresh relay virtual machine, with the
 * real LiteLLM model and the executor at jev.home.arpa. It makes model calls.
 *
 *   node --experimental-strip-types scripts/computer-use/pi-delegation-live.ts [model] [executor-url] [task]
 *
 * The task is calculator (the default), textedit or finder, as in the Pi task batch (research §14),
 * or simulator-about or simulator-dark-mode, which operate an iPhone simulator.
 * Each task's setup runs in the guest after staging, because the computer-use tools do not launch
 * applications.
 *
 * Output: a new directory under test-results/e2e/computer-use-delegation/, with report.html joining
 * each plan step to its relay screenshots.
 */
import { delegate } from "./support/delegate.ts";

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
const result = await delegate({ name: `computer-use-delegation${taskName === "calculator" ? "" : `-${taskName}`}`, task: selected.task, prepare: selected.prepare, modelId, executorUrl });
const { log } = result;
log(`\nElapsed: ${Math.round(result.elapsedMs / 1000)} s (wall clock from sending the prompt to stopping Pi)`);
if (!result.runs.length) log("Run: none");
for (const [index, run] of result.runs.entries()) {
  log(`Run ${index + 1} of ${result.runs.length}: ${run.subagentType ?? ""} background=${run.background} status=${run.status}`);
  log(`Run output:\n${run.output ?? ""}`);
}
log(`Output: ${result.artifacts}`);
