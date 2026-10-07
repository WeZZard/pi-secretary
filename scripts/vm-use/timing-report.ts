/**
 * Evaluation §7.1 (decision PS-D29): where the time of a delegated vm-use run went. One row per user message,
 * assistant message and tool call of the main session and its subagent, with the relay actions each tool call
 * contained, then totals and a comparison table across the runs given. Reads only the run's artifacts.
 *
 *   node --experimental-strip-types scripts/vm-use/timing-report.ts [--out=DIR] <run-dir>...
 *
 * A run directory is a Pi run (sessions/ and extension-state/agents/…/sessions/) or a Claude Code run from
 * claude-code-run.ts (transcripts/). Output: DIR (default a new test-results/vm-use/timing-<time>/) gets
 * report.md.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type Actor = "main" | "subagent";
interface Row { start: number; end: number; actor: Actor; kind: "user" | "assistant" | "tool" | "notice"; what: string; model?: string; outputTokens?: number; id?: string; relay?: RelayAction[] }
interface RelayAction { title: string; start: number; end: number }
interface Run { dir: string; harness: "Pi" | "Claude Code"; rows: Row[]; relay: RelayAction[]; score?: string }

const flags = new Map(process.argv.slice(2).filter(arg => arg.startsWith("--")).map(arg => { const [key, value] = arg.slice(2).split("="); return [key!, value ?? "true"]; }));
const dirs = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
if (!dirs.length) { console.error("usage: timing-report.ts [--out=DIR] <run-dir>..."); process.exit(2); }
const repository = join(import.meta.dirname, "../..");
const out = flags.get("out") ?? join(repository, "test-results/vm-use", `timing-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const jsonl = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const ms = (iso: string) => Date.parse(iso);
const clip = (text: string, length = 110) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat; };
const files = (dir: string, suffix: string): string[] => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name), suffix) : entry.name.endsWith(suffix) ? [join(dir, entry.name)] : []);
const argsText = (input: unknown) => clip(JSON.stringify(input ?? {}), 90);

/** Pi: an assistant message's own timestamp is when its request started; the entry's is when it was written. */
function piSession(file: string, actor: Actor): Row[] {
  const rows: Row[] = [], calls = new Map<string, Row>();
  for (const entry of jsonl(file)) {
    const at = ms(entry.timestamp);
    if (entry.type === "custom_message") { rows.push({ start: at, end: at, actor, kind: "notice", what: `${entry.customType}` }); continue; }
    if (entry.type !== "message") continue;
    const message = entry.message;
    const content: any[] = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content) }];
    if (message.role === "user") rows.push({ start: at, end: at, actor, kind: "user", what: clip(content.filter(block => block.type === "text").map(block => block.text).join(" ")) });
    else if (message.role === "assistant") {
      const toolCalls = content.filter(block => block.type === "toolCall");
      const text = content.filter(block => block.type === "text").map(block => block.text).join(" ");
      rows.push({ start: typeof message.timestamp === "number" ? message.timestamp : at, end: at, actor, kind: "assistant", model: message.model,
        outputTokens: message.usage?.output, what: clip(text.trim() || `calls ${toolCalls.map(call => call.name).join(", ")}`) });
      for (const call of toolCalls) {
        const row: Row = { start: at, end: at, actor, kind: "tool", what: `${call.name} ${argsText(call.arguments)}`, id: call.id };
        calls.set(call.id, row); rows.push(row);
      }
    } else if (message.role === "toolResult") { const row = calls.get(message.toolCallId); if (row) row.end = at; }
  }
  return rows;
}

/** Claude Code: an assistant message is written one content block per line, sharing message.id; it starts when the entry before it was written. */
function claudeCodeSession(file: string, actor: Actor): Row[] {
  const rows: Row[] = [], calls = new Map<string, Row>(), messages = new Map<string, Row>();
  let previous: number | undefined;
  for (const entry of jsonl(file)) {
    if (!entry.timestamp) continue;
    const at = ms(entry.timestamp);
    if (entry.type === "assistant") {
      const message = entry.message;
      let row = messages.get(message.id);
      if (!row) { row = { start: previous ?? at, end: at, actor, kind: "assistant", model: message.model, what: "" }; messages.set(message.id, row); rows.push(row); }
      row.end = at;
      if (message.usage?.output_tokens) row.outputTokens = message.usage.output_tokens;
      for (const block of message.content ?? []) {
        if (block.type === "text" && block.text.trim()) row.what = clip(`${row.what} ${block.text}`);
        if (block.type === "tool_use") {
          const call: Row = { start: at, end: at, actor, kind: "tool", what: `${block.name.replace("mcp__plugin_mcp-vm-relay_relay__", "")} ${argsText(block.input)}`, id: block.id };
          calls.set(block.id, call); rows.push(call);
          if (!row.what || row.what.startsWith("calls ")) row.what = clip(`calls ${[...calls.values()].filter(c => c.start >= row!.start && c.actor === actor && c.start <= at).map(c => c.what.split(" ")[0]).join(", ")}`);
        }
      }
    } else if (entry.type === "user" && !entry.isMeta) {
      const content = entry.message?.content;
      const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
      for (const block of blocks.filter(block => block.type === "tool_result")) { const call = calls.get(block.tool_use_id); if (call) call.end = at; }
      const text = blocks.filter(block => block.type === "text").map(block => block.text).join(" ");
      if (text.trim()) rows.push({ start: at, end: at, actor, kind: "user", what: clip(text) });
    }
    previous = at;
  }
  return rows;
}

/** Relay actions from every package's journal: from the action's start to its completion. */
function relayActions(dir: string): RelayAction[] {
  const evidence = join(dir, "relay-evidence");
  if (!existsSync(evidence)) return [];
  return readdirSync(evidence, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const journal = join(evidence, entry.name, "state/journal/events.jsonl");
    if (!existsSync(journal)) return [];
    const starts = new Map<string, { title: string; start: number }>(), actions: RelayAction[] = [];
    for (const event of jsonl(journal)) {
      if (event.kind === "action-start") starts.set(event.actionId, { title: event.title, start: ms(event.writtenAt) });
      if (event.kind === "action-completion") { const start = starts.get(event.actionId); if (start) actions.push({ ...start, end: ms(event.writtenAt) }); }
    }
    return actions;
  }).sort((a, b) => a.start - b.start);
}

function loadRun(dir: string): Run {
  let harness: Run["harness"], rows: Row[];
  if (existsSync(join(dir, "transcripts"))) {
    harness = "Claude Code";
    rows = [...claudeCodeSession(join(dir, "transcripts/main.jsonl"), "main"), ...files(join(dir, "transcripts/subagents"), ".jsonl").flatMap(file => claudeCodeSession(file, "subagent"))];
  } else {
    harness = "Pi";
    rows = [...files(join(dir, "sessions"), ".jsonl").flatMap(file => piSession(file, "main")), ...files(join(dir, "extension-state/agents"), ".jsonl").flatMap(file => piSession(file, "subagent"))];
  }
  rows.sort((a, b) => a.start - b.start || a.end - b.end);
  const relay = relayActions(dir);
  // Each relay action belongs to the innermost tool call running when it started: the subagent's before the main session's.
  const tools = rows.filter(row => row.kind === "tool");
  for (const action of relay) {
    const owner = tools.filter(row => row.start <= action.start && action.start <= row.end).sort((a, b) => (a.actor === "subagent" ? 0 : 1) - (b.actor === "subagent" ? 0 : 1))[0];
    if (owner) (owner.relay ??= []).push(action);
  }
  const log = existsSync(join(dir, "log.txt")) ? readFileSync(join(dir, "log.txt"), "utf8") : "";
  const score = [...log.matchAll(/score (\S+?)[,.]/g)].at(-1)?.[1];
  return { dir, harness, rows, relay, score };
}

const seconds = (value: number) => `${(value / 1000).toFixed(1)} s`;
const clock = (value: number) => { const s = Math.round(value / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const time = (value: number) => new Date(value).toISOString().slice(11, 22);
const cell = (text: string) => text.replace(/\|/g, "\\|");
/** Relay action titles grouped by their kind: a relayed tool's name, or the words before a colon. Pi prefixes a plan step's title with its run and step. */
const titleKind = (title: string) => {
  const rest = title.replace(/^run-\w+ [^:]*: /, "").split(" · ").at(-1)!;
  return /^[\w-]+\.[\w.-]+$/.test(rest.split(" ")[0]!) ? rest.split(" ")[0]! : clip(rest.split(":")[0]!, 40);
};

interface Totals { wall: number; relaySpan: number; outsideRelay: number; finalAnswer: number; model: Record<Actor, number>; assistant: Record<Actor, number>; tool: Record<Actor, number>; toolCalls: Record<Actor, number>; outputTokens: number; vmUseCalls: number; relayCount: number; relayTime: number; afterSubagent: number; models: string[] }
function totals(run: Run): Totals {
  const start = Math.min(...run.rows.map(row => row.start)), end = Math.max(...run.rows.map(row => row.end));
  const of = (actor: Actor, kind: Row["kind"]) => run.rows.filter(row => row.actor === actor && row.kind === kind);
  const lastSubagent = Math.max(...run.rows.filter(row => row.actor === "subagent").map(row => row.end));
  const mainEnd = Math.max(...run.rows.filter(row => row.actor === "main" && row.kind === "assistant").map(row => row.end));
  return {
    wall: end - start,
    relaySpan: run.relay.length ? Math.max(...run.relay.map(action => action.end)) - run.relay[0]!.start : 0,
    outsideRelay: sum(of("subagent", "tool").map(row => row.end - row.start - sum((row.relay ?? []).map(action => action.end - action.start)))),
    finalAnswer: Number.isFinite(lastSubagent) ? mainEnd - lastSubagent : 0,
    model: { main: sum(of("main", "assistant").map(row => row.end - row.start)), subagent: sum(of("subagent", "assistant").map(row => row.end - row.start)) },
    assistant: { main: of("main", "assistant").length, subagent: of("subagent", "assistant").length },
    tool: { main: sum(of("main", "tool").map(row => row.end - row.start)), subagent: sum(of("subagent", "tool").map(row => row.end - row.start)) },
    toolCalls: { main: of("main", "tool").length, subagent: of("subagent", "tool").length },
    outputTokens: sum(run.rows.map(row => row.outputTokens ?? 0)),
    vmUseCalls: run.rows.filter(row => row.kind === "tool" && /^(?:vm|computer)_/.test(row.what)).length,
    relayCount: run.relay.length, relayTime: sum(run.relay.map(action => action.end - action.start)),
    afterSubagent: Number.isFinite(lastSubagent) ? end - lastSubagent : 0,
    models: [...new Set(run.rows.flatMap(row => row.model ? [`${row.actor}: ${row.model}`] : []))],
  };
}

function section(run: Run, index: number): string {
  const t = totals(run), start = Math.min(...run.rows.map(row => row.start));
  const byTool = new Map<string, { count: number; time: number }>();
  for (const row of run.rows.filter(row => row.kind === "tool")) {
    const key = `${row.actor} ${row.what.split(" ")[0]}`, entry = byTool.get(key) ?? { count: 0, time: 0 };
    entry.count++; entry.time += row.end - row.start; byTool.set(key, entry);
  }
  const byRelay = new Map<string, { count: number; time: number }>();
  for (const action of run.relay) { const key = titleKind(action.title), entry = byRelay.get(key) ?? { count: 0, time: 0 }; entry.count++; entry.time += action.end - action.start; byRelay.set(key, entry); }
  const lines = [
    `## Run ${index + 1}: ${run.harness}`, "",
    `Artifacts: \`${run.dir.replace(`${repository}/`, "")}\`. Score: ${run.score ?? "not recorded"}. Models: ${t.models.join("; ")}.`, "",
    "### Time by tool", "", "| Actor and tool | Calls | Time |", "|---|---:|---:|",
    ...[...byTool].sort((a, b) => b[1].time - a[1].time).map(([key, entry]) => `| ${key} | ${entry.count} | ${clock(entry.time)} |`), "",
    "### Relay actions by kind", "", "| Kind | Actions | Time | Mean |", "|---|---:|---:|---:|",
    ...[...byRelay].sort((a, b) => b[1].time - a[1].time).map(([key, entry]) => `| ${cell(key)} | ${entry.count} | ${clock(entry.time)} | ${seconds(entry.time / entry.count)} |`), "",
    "### Every message and tool call", "",
    "Time is UTC; offset is from the run's first entry. An assistant message runs from its request to its last block; a tool call from its issue to its result.", "",
    "| # | Time | Offset | Actor | Kind | Duration | Relay actions | What |", "|---:|---|---:|---|---|---:|---|---|",
    ...run.rows.map((row, n) => {
      const inRelay = sum((row.relay ?? []).map(action => action.end - action.start));
      const relay = row.relay?.length ? `${row.relay.length} in ${clock(inRelay)}; ${clock(row.end - row.start - inRelay)} outside` : "";
      const what = row.kind === "assistant" && row.outputTokens ? `${row.what} (${row.outputTokens} output tokens)` : row.what;
      return `| ${n + 1} | ${time(row.start)} | ${clock(row.start - start)} | ${row.actor} | ${row.kind} | ${row.kind === "user" || row.kind === "notice" ? "" : seconds(row.end - row.start)} | ${relay} | ${cell(what)} |`;
    }), "",
  ];
  return lines.join("\n");
}

const runs = dirs.map(dir => loadRun(dir.replace(/\/$/, "")));
const all = runs.map(totals);
const metric = (label: string, value: (t: Totals) => string) => `| ${label} | ${all.map(value).join(" | ")} |`;
const report = [
  "# Time comparison of delegated vm-use runs", "",
  `Generated ${new Date().toISOString()} by \`scripts/vm-use/timing-report.ts\` from ${runs.map(run => `\`${basename(run.dir)}\``).join(", ")}.`,
  "The runs differ in harness, models and relay use; the figures are reported as measured, not adjusted for those differences.", "",
  "## Comparison", "",
  `| | ${runs.map((run, i) => `Run ${i + 1}: ${run.harness}`).join(" | ")} |`, `|---|${runs.map(() => "---:").join("|")}|`,
  `| Score | ${runs.map(run => run.score ?? "—").join(" | ")} |`,
  metric("Wall clock, first to last entry", t => clock(t.wall)),
  metric("Main session: model time (messages)", t => `${clock(t.model.main)} (${t.assistant.main})`),
  metric("Main session: tool time (calls)", t => `${clock(t.tool.main)} (${t.toolCalls.main})`),
  metric("Subagent: model time (messages)", t => `${clock(t.model.subagent)} (${t.assistant.subagent})`),
  metric("Subagent: tool time (calls)", t => `${clock(t.tool.subagent)} (${t.toolCalls.subagent})`),
  metric("Calls to vm-use tools", t => String(t.vmUseCalls)),
  metric("Relay actions: count, time", t => `${t.relayCount}, ${clock(t.relayTime)}`),
  metric("From the first relay action (prepare) to the last (check)", t => clock(t.relaySpan)),
  metric("Subagent: tool time outside relay actions", t => clock(t.outsideRelay)),
  metric("From the subagent's last entry to the main session's last message", t => clock(t.finalAnswer)),
  metric("From the subagent's last entry to the last entry", t => clock(t.afterSubagent)),
  metric("Output tokens", t => String(t.outputTokens)),
  "",
  "Model time is the sum of assistant-message durations. The main session's tool time contains the subagent's whole run; the subagent's tool time contains its relay actions. A relay action runs from the relay's action start to its completion in the evidence journal; time outside relay actions inside a tool call is the harness's own work (model calls inside the tool, grounding, judging, waiting).",
  "Only the vm-use tools call the decision service (the grounder, and in runs before decision PS-D53 the permission guardian); a run without them drives the relay tools directly, with neither.", "",
  ...runs.map(section),
].join("\n");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "report.md"), report);
console.log(join(out, "report.md"));
