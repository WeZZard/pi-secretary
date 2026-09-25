/**
 * Replays a proposed plan-start check over every recorded plan: does the window still match what
 * the planner last saw? It compares the last read before a plan with the plan's first read, by
 * the observer's kept controls (role and name), ignoring values and displayed text, and reports
 * what the check would have done. It changes no behaviour; it reads recorded evidence only.
 *
 *   node --experimental-strip-types scripts/computer-use/replay-drift-check.ts
 *
 * Output: a new directory under test-results/computer-use/.
 *
 * Time formulas, one per quantity:
 * - plan wall time: plan record time minus the start of the plan's first read
 *   (its record time minus its read duration).
 * - staleness gap: the plan's first read record time minus the baseline read record time.
 * - run wall time: last record or message time minus first, per recorded session.
 * - check cost: process CPU time of the comparisons divided by their number.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import { observe } from "../../extensions/secretary/computer-use/observer.ts";
import { compareWindows, type WindowComparison } from "../../extensions/secretary/computer-use/window-check.ts";

const repository = resolve(import.meta.dirname, "../..");
const out = join(repository, "test-results/computer-use", `drift-replay-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });

type Json = Record<string, any>;
const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const walk = (root: string, found: string[] = []): string[] => {
  if (!existsSync(root)) return found;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) walk(path, found); else found.push(path);
  }
  return found;
};
const parse = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;

/** Roles that open over the window and can block input to the rest of it. */
const BLOCKING = /^AX(Sheet|Dialog|Popover|Menu|SystemDialog)$/;
/** The menu bar belongs to the application and appears only while it is active; it is not window content. */
const MENU_BAR = /^AXMenuBar(Item)?$/;

interface Read { path: string; at: number; startedAt: number; purpose: string; windowId?: number; title: string; controls: string[]; blocking: string[]; session: string; runId?: string }

function read(path: string, session: string): Read {
  const record = readJson(path);
  const tree = (parse(record.tree) ?? []) as Json[];
  const roleOf = new Map(tree.map(element => [element.element_index, element.role as string]));
  const controls = ((parse(record.groups) ?? []) as Json[]).flatMap(group => group.elements.map((element: Json) => `${roleOf.get(element.index) ?? "?"} ${JSON.stringify(element.name)}`))
    .filter(key => !MENU_BAR.test(key.split(" ")[0]!)).sort();
  // The menu bar's own menus are always in the tree of an active application; only a menu outside
  // the menu bar, such as a context menu, is open over the window (observed 2026-09-25 in the replay).
  const byIndex = new Map(tree.map(element => [element.element_index, element]));
  const inMenuBar = (element: Json): boolean => {
    for (let parent = byIndex.get(element.parent_index), hops = 0; parent && hops < 50; parent = byIndex.get(parent.parent_index), hops++) if (MENU_BAR.test(parent.role)) return true;
    return false;
  };
  const blocking = tree.filter(element => BLOCKING.test(element.role) && !inMenuBar(element)).map(element => `${element.role} ${JSON.stringify(element.label ?? "")}`);
  const at = Date.parse(record.recordedAt);
  const runId = /^(run-[a-z0-9]+)-\d+\.json$/.exec(basename(path))?.[1];
  return { path, at, startedAt: at - (record.readMs ?? 0), purpose: record.purpose ?? "", windowId: record.window?.windowId, title: record.window?.title ?? "",
    controls, blocking, session, ...(runId ? { runId } : {}) };
}

const multisetMinus = (a: string[], b: string[]) => {
  const left = new Map<string, number>();
  for (const key of b) left.set(key, (left.get(key) ?? 0) + 1);
  return a.filter(key => { const n = left.get(key) ?? 0; if (n > 0) { left.set(key, n - 1); return false; } return true; });
};

interface Verdict { stop: boolean; reasons: string[]; added: string[]; removed: string[] }
function check(baseline: Read, current: Read): Verdict {
  const reasons: string[] = [];
  if (baseline.windowId !== undefined && current.windowId !== undefined && baseline.windowId !== current.windowId) reasons.push(`a different window (${baseline.windowId} → ${current.windowId})`);
  if (baseline.title !== current.title) reasons.push(`window title ${JSON.stringify(baseline.title)} → ${JSON.stringify(current.title)}`);
  const removed = multisetMinus(baseline.controls, current.controls);
  const added = multisetMinus(current.controls, baseline.controls);
  if (removed.length) reasons.push(`${removed.length} control(s) gone`);
  const newBlocking = multisetMinus(current.blocking, baseline.blocking);
  if (newBlocking.length) reasons.push(`opened over the window: ${newBlocking.join(", ")}`);
  return { stop: reasons.length > 0, reasons, added, removed };
}

// Sessions: directories holding observations/ and runs/, from the relay packages and the live checks.
// The same run can be delivered in several copies, so plans are counted once by run identifier.
const sessions = new Set<string>();
for (const root of [join(repository, "relay-evidence"), join(repository, "test-results")]) {
  for (const path of walk(root)) if (basename(dirname(path)) === "observations" && path.endsWith(".json") && existsSync(join(dirname(dirname(path)), "runs"))) sessions.add(dirname(dirname(path)));
}

/** Messages from Pi `--mode json` events (message_end) or a session transcript (message entries). */
function messagesOf(path: string): Json[] {
  const entries = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const ended = entries.filter(entry => entry.type === "message_end" && entry.message).map(entry => entry.message);
  return ended.length ? ended : entries.filter(entry => entry.type === "message" && entry.message).map(entry => entry.message);
}

/**
 * The observation each plan was based on, from the planner's `computer_run_plan` calls. A plan is
 * matched to the call whose result arrived at or just after the plan record.
 */
function basedOnByPlanTime(session: string): { at: number; basedOn?: string }[] {
  const candidates = [join(session, "..", "..", "..", "events.jsonl"),
    ...walk(join(session, "..", "..", "agents")).filter(path => path.endsWith(".jsonl"))].filter(existsSync);
  const results: { at: number; basedOn?: string }[] = [];
  for (const file of candidates) {
    const messages = messagesOf(file);
    const args = new Map<string, Json>();
    for (const message of messages) for (const part of message.role === "assistant" ? message.content ?? [] : []) {
      if (part.type === "toolCall" && part.name === "computer_run_plan") args.set(part.id, part.arguments ?? {});
    }
    for (const message of messages) if (message.role === "toolResult" && message.toolName === "computer_run_plan") {
      results.push({ at: Number(message.timestamp), basedOn: args.get(message.toolCallId)?.based_on });
    }
  }
  return results;
}

interface Row { runtime?: boolean; matchedPrevious?: string; baselineKind: string; runId: string; session: string; app: string; task: string; outcome: string; baseline: Read; first: Read; verdict: Verdict; planMs: number; gapMs: number; escalation?: string }
const rows: Row[] = [];
/**
 * The runtime check on the same reads: the current observer reduces the recorded tree, and
 * `compareWindows` judges it, as `computer_run_plan` does at plan start (design §9). Disagreements
 * with this script's own check are counted in the report.
 */
const defaults = defaultComputerUseConfiguration();
function runtimeComparison(path: string): WindowComparison | undefined {
  const record = readJson(path);
  const result = observe({ window: record.window, snapshotId: record.snapshotId, appActive: record.appActive, truncated: record.truncated, readMs: record.readMs ?? 0,
    elements: parse(record.tree) ?? [], ...(record.descendantText ? { descendantText: parse(record.descendantText) } : {}) },
    { id: basename(path, ".json"), maxElements: defaults.maxElements, maxNameLength: defaults.maxNameLength });
  return result.status === "ready" ? result.comparison : undefined;
}
function runtimeStop(baseline: Read, first: Read, previous: Read | undefined): boolean | undefined {
  const [b, f] = [runtimeComparison(baseline.path), runtimeComparison(first.path)];
  if (!b || !f) return undefined;
  if (!compareWindows(b, f).stop) return false;
  const p = previous && runtimeComparison(previous.path);
  return !(p && !compareWindows(p, f).stop);
}

const seenPlans = new Set<string>();
const runTimes = new Map<string, number>();
let comparisons = 0;
let cpu = 0;

for (const session of [...sessions].sort()) {
  const reads = readdirSync(join(session, "observations")).filter(name => name.endsWith(".json")).map(name => read(join(session, "observations", name), session))
    .filter(entry => Number.isFinite(entry.at)).sort((a, b) => a.at - b.at);
  const plans = readdirSync(join(session, "runs")).map(name => join(session, "runs", name, "plan.json")).filter(existsSync).map(readJson);
  // Run wall time per session, counted once per distinct first plan identifier.
  const key = plans.map(plan => plan.runId).sort().join(",");
  if (key && !runTimes.has(key)) {
    const times = [...reads.map(entry => entry.startedAt), ...plans.map(plan => Date.parse(plan.recordedAt))].filter(Number.isFinite);
    runTimes.set(key, Math.max(...times) - Math.min(...times));
  }
  for (const plan of plans) {
    if (seenPlans.has(plan.runId)) continue;
    seenPlans.add(plan.runId);
    const own = reads.filter(entry => entry.runId === plan.runId);
    const first = own[0];
    if (!first) continue;
    // The planner's own view: the observation named in based_on; else the last read before the plan.
    const planAt = Date.parse(plan.recordedAt);
    const call = basedOnByPlanTime(session).find(result => result.at >= planAt && result.at - planAt < 2000);
    const named = call?.basedOn ? reads.find(entry => basename(entry.path) === `${call.basedOn}.json`) : undefined;
    const baseline = named ?? [...reads].reverse().find(entry => entry.at < first.at && entry.runId !== plan.runId) ?? reads.filter(entry => entry.at < first.at).at(-1);
    if (!baseline) continue;
    const baselineKind = named ? `based_on ${call!.basedOn}` : call ? "last read (the plan named no observation)" : "last read (no transcript)";
    // Changes made by our own earlier plans are known to the harness: the last read of a plan that
    // ran after the baseline is accepted as well.
    const previous = [...reads].reverse().find(entry => entry.runId && entry.runId !== plan.runId && entry.at > baseline.at && entry.at < first.at);
    const started = process.cpuUsage();
    let verdict = check(baseline, first);
    let matchedPrevious: string | undefined;
    if (verdict.stop && previous) {
      const again = check(previous, first);
      if (!again.stop) { verdict = again; matchedPrevious = `${previous.purpose} (\`${basename(previous.path)}\`)`; }
    }
    const used = process.cpuUsage(started);
    const runtime = runtimeStop(baseline, first, previous);
    cpu += used.user + used.system;
    comparisons++;
    rows.push({ runtime, ...(matchedPrevious ? { matchedPrevious } : {}), baselineKind, runId: plan.runId, session: relative(repository, session), app: plan.plan?.target?.app ?? first.title, task: plan.plan?.goal ?? "",
      outcome: plan.outcome, baseline, first, verdict, planMs: Date.parse(plan.recordedAt) - first.startedAt, gapMs: first.at - baseline.at,
      ...(plan.escalation ? { escalation: `${plan.escalation.reason} at ${plan.escalation.stepId}` } : {}) });
  }
}
rows.sort((a, b) => a.first.at - b.first.at);

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const seconds = (ms: number) => (ms / 1000).toFixed(1);
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN; };
const stops = rows.filter(row => row.verdict.stop);
const report = [
  "# Plan-start state check: replay over recorded plans", "",
  `Generated ${new Date().toISOString()} by \`scripts/computer-use/replay-drift-check.ts\`. It changed no behaviour; it read recorded evidence only.`, "",
  "**The check.** Before a plan's first step, compare the observation the plan was based on (the baseline) with the plan's first read; when they differ, also accept a match with the last read of an earlier plan of ours that ran after the baseline. Compare the controls the observer kept, by role and name, and ignore values, displayed text and the menu bar. Stop when the window or its title changed, when a control is gone, or when a sheet, dialog, popover or a menu outside the menu bar opened. Added controls alone do not stop the plan.", "",
  "## Result", "",
  `- Plans with a first read and a baseline: ${rows.length}, from ${sessions.size} recorded session directories (copies counted once).`,
  `- The check would have stopped: ${stops.length}. It would have let through: ${rows.length - stops.length}.`,
  `- Let through with controls added: ${rows.filter(row => !row.verdict.stop && row.verdict.added.length).length}.`,
  `- Let through only because the plan's first read matched the last read of an earlier plan of ours: ${rows.filter(row => row.matchedPrevious).length}.`,
  `- The runtime check (the current observer and \`compareWindows\` on the same recorded reads) agreed on ${rows.filter(row => row.runtime === row.verdict.stop).length} of ${rows.length} plans; disagreed on ${rows.filter(row => row.runtime !== undefined && row.runtime !== row.verdict.stop).map(row => row.runId).join(", ") || "none"}; could not judge ${rows.filter(row => row.runtime === undefined).length}.`,
  `- Baseline used: ${[...new Set(rows.map(row => row.baselineKind.replace(/^based_on .*/, "based_on observation")))].map(kind => `${kind} ${rows.filter(row => row.baselineKind.replace(/^based_on .*/, "based_on observation") === kind).length}`).join(", ")}.`, "",
  "## Time", "",
  "| Quantity (formula in the script header) | Value |", "| --- | --- |",
  `| Plan wall time, all plans, total | ${seconds(sum(rows.map(row => row.planMs)))} s |`,
  `| Plan wall time, median | ${seconds(median(rows.map(row => row.planMs)))} s |`,
  `| Plan wall time, plans the check would have stopped, total | ${seconds(sum(stops.map(row => row.planMs)))} s |`,
  `| Staleness gap, median | ${seconds(median(rows.map(row => row.gapMs)))} s |`,
  `| Staleness gap, longest | ${seconds(Math.max(...rows.map(row => row.gapMs)))} s |`,
  `| Run wall time, all recorded sessions, total | ${seconds(sum([...runTimes.values()]))} s, over ${runTimes.size} sessions |`,
  `| Check cost, per comparison | ${(cpu / Math.max(1, comparisons) / 1000).toFixed(3)} ms CPU, over ${comparisons} comparisons |`, "",
  "## Plans the check would have stopped", "",
  "| Plan | Started (UTC) | App | Outcome as run | Why the check stops | Gone | Added | Baseline read | First read |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...stops.map(row => `| ${row.runId} | ${new Date(row.first.at).toISOString().slice(0, 19)} | ${row.app} | ${row.outcome}${row.escalation ? ` (${row.escalation})` : ""} | ${row.verdict.reasons.join("; ")} | ${row.verdict.removed.join(", ").slice(0, 200)} | ${row.verdict.added.join(", ").slice(0, 200)} | ${row.baselineKind}: ${row.baseline.purpose} (\`${basename(row.baseline.path)}\`) | ${row.first.purpose} (\`${basename(row.first.path)}\`) |`), "",
  "## Every plan", "",
  "| Plan | Started (UTC) | App | Outcome as run | Check | Staleness gap (s) | Plan wall time (s) | Session |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(row => `| ${row.runId} | ${new Date(row.first.at).toISOString().slice(0, 19)} | ${row.app} | ${row.outcome}${row.escalation ? ` (${row.escalation})` : ""} | ${row.verdict.stop ? `stop: ${row.verdict.reasons.join("; ")}` : row.matchedPrevious ? `continue (matched our earlier plan's last read, ${row.matchedPrevious})` : row.verdict.added.length ? `continue (${row.verdict.added.length} added)` : "continue"} | ${seconds(row.gapMs)} | ${seconds(row.planMs)} | \`${row.session}\` |`), "",
  "## Limits", "",
  "- The baseline is the observation named in the plan's `based_on`, found by matching each plan record to the planner's call whose result arrived within 2 s after it. Without such a name, it is the last read before the plan; that stands in for what the planner saw, and it can differ from it.",
  "- A plan rejected before its first read has no first read and is not counted.",
  "", ];
writeFileSync(join(out, "report.md"), report.join("\n"));
console.log(`Plans: ${rows.length}. Would stop: ${stops.length}. Runtime check disagreed: ${rows.filter(row => row.runtime !== undefined && row.runtime !== row.verdict.stop).length}, could not judge: ${rows.filter(row => row.runtime === undefined).length}.`);
console.log(`Plans: ${rows.length}. Would stop: ${stops.length}. Check cost: ${(cpu / Math.max(1, comparisons) / 1000).toFixed(3)} ms CPU per comparison.`);
console.log(`Output: ${relative(repository, out)}/report.md`);
