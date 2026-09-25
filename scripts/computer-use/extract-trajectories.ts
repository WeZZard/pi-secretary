/**
 * Extracts readable trajectories of every recorded computer-use run, and an index of the failures
 * in them. A trajectory merges, in time order, the planner's conversation (Pi events or session
 * transcripts), the harness's observations, the executor's answers per step, and the plan outcomes.
 *
 *   node --experimental-strip-types scripts/computer-use/extract-trajectories.ts
 *
 * It reads relay-evidence/ and test-results/, and writes a new directory under
 * test-results/computer-use/. It changes nothing it reads.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "../..");
const out = join(repository, "test-results/computer-use", `trajectories-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(join(out, "runs"), { recursive: true });

type Json = Record<string, any>;
const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const lines = (path: string): Json[] => readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const walk = (root: string, found: string[] = []): string[] => {
  if (!existsSync(root)) return found;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) walk(path, found); else found.push(path);
  }
  return found;
};
const rel = (path: string) => relative(repository, path);
const time = (value: unknown): number => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
/** The earliest message time, else the file's modification time. */
const started = (messages: Json[], file: string): string => {
  const times = messages.map(message => time(message.timestamp)).filter(Number.isFinite);
  return new Date(times.length ? Math.min(...times) : statSync(file).mtimeMs).toISOString();
};
const clock = (ms: number) => Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 23) : "--:--:--.---";
const fence = (text: string) => `\n\`\`\`\n${text.replace(/```/g, "ˋˋˋ")}\n\`\`\`\n`;

interface Conversation { label: string; source: string; messages: Json[] }
interface Run {
  id: string; when: string; source: string; task: string;
  conversations: Conversation[]; records: string[]; check?: Json; package?: string;
}

/** Messages from Pi `--mode json`/RPC events (message_end) or from a session transcript (message entries). */
function messagesOf(path: string): Json[] {
  const entries = lines(path);
  const ended = entries.filter(entry => entry.type === "message_end" && entry.message).map(entry => entry.message);
  if (ended.length > 0) return ended;
  return entries.filter(entry => entry.type === "message" && entry.message).map(entry => ({ ...entry.message, timestamp: entry.message.timestamp ?? entry.timestamp }));
}

const packageOf = (path: string) => /relay-evidence\/(relay-[^/]+?)\//.exec(path)?.[1];

// Pi runs inside relay machines: a directory with events.jsonl, and harness records under secretary/computer-use.
const runs: Run[] = [];
const seen = new Map<string, string>();
const duplicates: string[] = [];
for (const events of walk(join(repository, "relay-evidence")).filter(path => basename(path) === "events.jsonl").sort()) {
  // The relay keeps its own journal in files of the same name; only Pi's event streams hold messages.
  if (messagesOf(events).length === 0) continue;
  const digest = createHash("sha256").update(readFileSync(events)).digest("hex");
  if (seen.has(digest)) { duplicates.push(`${rel(events)} is a copy of ${seen.get(digest)}`); continue; }
  seen.set(digest, rel(events));
  const dir = dirname(events);
  const messages = messagesOf(events);
  const records = walk(join(dir, "secretary", "computer-use")).filter(path => path.endsWith(".json"));
  const siblings = join(dirname(dir), "runs.json");
  const check = existsSync(siblings) ? (readJson(siblings) as Json[]).find(entry => entry.name === basename(dir)) : undefined;
  const first = messages.find(message => message.role === "user");
  runs.push({ id: "", when: started(messages, events), source: rel(dir), package: packageOf(events),
    task: text(first).slice(0, 200), conversations: [{ label: "Pi (planner)", source: rel(events), messages }], records, ...(check ? { check } : {}) });
}

// Script runs of the harness on the development machine through the relay client.
for (const dir of readdirSync(join(repository, "test-results/computer-use")).filter(name => name.startsWith("relay-live-")).map(name => join(repository, "test-results/computer-use", name))) {
  const records = walk(dir).filter(path => /\/(observations|runs)\//.test(path) && path.endsWith(".json") && !path.includes("relay-evidence"));
  if (records.length === 0) continue;
  runs.push({ id: "", when: new Date(Math.min(...records.map(path => time(readJson(path).recordedAt)))).toISOString(), source: rel(dir),
    task: "Scripted plan: Calculator 7 + 3 (scripts/computer-use/relay-live.ts, no model)", conversations: [], records });
}

// Live delegation: a Pi parent in RPC mode and the computer-use agent's session transcript.
const delegations = join(repository, "test-results/e2e/computer-use-delegation");
for (const name of existsSync(delegations) ? readdirSync(delegations) : []) {
  const dir = join(delegations, name);
  const conversations: Conversation[] = [];
  if (existsSync(join(dir, "stdout.jsonl"))) conversations.push({ label: "Pi parent", source: rel(join(dir, "stdout.jsonl")), messages: messagesOf(join(dir, "stdout.jsonl")) });
  for (const transcript of walk(join(dir, "extension-state", "agents")).filter(path => path.endsWith(".jsonl"))) {
    conversations.push({ label: "computer-use agent", source: rel(transcript), messages: messagesOf(transcript) });
  }
  const records = walk(join(dir, "extension-state", "computer-use")).filter(path => path.endsWith(".json"));
  const first = conversations[0]?.messages.find(message => message.role === "user");
  runs.push({ id: "", when: started(conversations.flatMap(conversation => conversation.messages), join(dir, "log.txt")), source: rel(dir), task: text(first).slice(0, 200), conversations, records });
}

function text(message: Json | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).filter((part: Json) => part.type === "text").map((part: Json) => part.text).join("\n");
}

runs.sort((a, b) => a.when.localeCompare(b.when));
runs.forEach((run, i) => { run.id = `${String(i + 1).padStart(3, "0")}`; });

interface Failure { run: string; when: string; kind: string; detail: string; file: string }
const failures: Failure[] = [];

for (const run of runs) {
  const file = `runs/${run.id}-${run.when.slice(0, 19).replace(/[:T]/g, "-")}.md`;
  const fail = (kind: string, detail: string) => failures.push({ run: run.id, when: run.when, kind, detail: detail.replace(/\s+/g, " ").slice(0, 300), file });
  const events: { at: number; order: number; body: string }[] = [];
  let order = 0;
  const add = (at: number, body: string) => events.push({ at, order: order++, body });

  for (const conversation of run.conversations) {
    for (const message of conversation.messages) {
      const at = time(message.timestamp);
      const who = conversation.label;
      if (message.role === "user") add(at, `### ${clock(at)} ${who}: user prompt\n${fence(text(message))}`);
      else if (message.role === "assistant") {
        const parts: string[] = [];
        for (const part of message.content ?? []) {
          if (part.type === "thinking" && part.thinking?.trim()) parts.push(`**Thinking**\n${fence(part.thinking.trim())}`);
          if (part.type === "text" && part.text?.trim()) parts.push(`**Says**\n${fence(part.text.trim())}`);
          if (part.type === "toolCall") parts.push(`**Calls \`${part.name}\`**\n${fence(JSON.stringify(part.arguments, null, 2))}`);
        }
        if (parts.length) add(at, `### ${clock(at)} ${who}: assistant\n\n${parts.join("\n")}`);
      } else if (message.role === "toolResult") {
        const body = text(message);
        add(at, `### ${clock(at)} ${who}: result of \`${message.toolName}\`${message.isError ? " (error)" : ""}\n${fence(body)}`);
        if (message.isError) fail("tool error", `${message.toolName}: ${body}`);
        else if (body.startsWith("Plan rejected:")) fail("plan rejected", body.slice("Plan rejected:".length).trim());
        else if (body.startsWith("Observation failed")) fail("observation failed", body);
        else if (/^Outcome: (?!completed)/.test(body)) {
          const escalation = /Escalation at step ([^:]+): ([a-z_]+)\.\s*([^\n]*)/.exec(body);
          fail(`plan ${/^Outcome: (\w+)/.exec(body)![1]}${escalation ? `: ${escalation[2]}` : ""}`, escalation ? `step ${escalation[1]}: ${escalation[3]}` : body.split("\n")[0]!);
        } else if (/Status: (state_too_large|no_progress)/.test(body)) fail("observation not usable", body.split("\n").find(line => line.startsWith("Status:")) ?? "");
      }
    }
  }

  for (const path of run.records) {
    const record = readJson(path);
    const at = time(record.recordedAt);
    if (record.schema?.includes("observation")) {
      const shown = Object.values(record.descendantText ?? {}).map(value => JSON.stringify(String(value).replace(/‎/g, ""))).join(", ");
      add(at, `### ${clock(at)} harness: observation (${record.purpose ?? "?"}, attempt ${record.attempt ?? 1})\n\n`
        + `- File: \`${basename(path)}\`\n- Status: ${record.status}; window ${JSON.stringify(record.window?.title)} of ${record.window?.app}; active app: ${record.appActive}; read ${Math.round(record.readMs ?? 0)} ms\n`
        + `- Text shown in the window: ${shown || "none"}\n\n<details><summary>Element table given to the executor</summary>\n${fence(record.executorTable ?? "")}</details>\n`);
    } else if (record.schema?.includes("step")) {
      const answers = Object.entries(record.answers ?? {}).map(([question, answer]: [string, any]) => `${question}=${answer.choice} (${Number(answer.confidence).toFixed(2)})`).join(", ");
      const decision = record.decision ?? {};
      add(at, `### ${clock(at)} executor: step \`${record.stepId}\`, attempt ${record.attempt}\n\n`
        + `- Asked: ${JSON.stringify(record.request?.state?.step ?? "")}\n- Answers: ${answers || "none"}\n`
        + `- Decision: ${decision.kind}${decision.operation ? ` ${decision.operation}` : ""}${decision.element ? ` ${JSON.stringify(decision.element)}` : ""}${decision.reason ? ` (${decision.reason})` : ""}${decision.detail ? `: ${decision.detail}` : ""}\n`
        + `- Round trip: ${Math.round(record.roundTripMs ?? 0)} ms\n`);
    } else if (record.schema?.includes("plan")) {
      const steps = (record.steps ?? []).map((step: Json) => `  - \`${step.id}\`: ${step.result}${step.action ? `, ${step.action} ${JSON.stringify(step.element ?? "")}` : ""}${step.detail ? ` (${step.detail})` : ""}`).join("\n");
      add(at, `### ${clock(at)} harness: plan \`${record.runId}\` ended: ${record.outcome}\n\n${steps}\n${record.escalation ? `\n- Escalation: step \`${record.escalation.stepId}\`, ${record.escalation.reason}: ${record.escalation.detail}\n` : ""}`);
      // A plan run through Pi is already counted from the tool result; a scripted run is counted here.
      if (run.conversations.length === 0 && record.outcome !== "completed") fail(`plan ${record.outcome}${record.escalation ? `: ${record.escalation.reason}` : ""}`, record.escalation?.detail ?? "");
      for (const step of record.steps ?? []) {
        if (step.result === "skipped" && /already held/.test(step.detail ?? "")) fail("step skipped as already done", `step ${step.id}: ${step.detail}`);
      }
    }
  }

  if (run.check) {
    if (run.check.done === false) fail("wrong final state (code check)", `${run.check.name}: expected ${run.check.check}`);
    if (run.check.answered === false) fail("no final answer", run.check.name);
    if (run.check.exit !== 0) fail("Pi exited with an error", `${run.check.name}: exit ${run.check.exit}`);
  }

  events.sort((a, b) => (Number.isFinite(a.at) ? a.at : Infinity) - (Number.isFinite(b.at) ? b.at : Infinity) || a.order - b.order);
  const header = [`# Run ${run.id}: ${run.task || "(no prompt)"}`, "",
    `- Started: ${run.when}`, `- Source: \`${run.source}\``, ...(run.package ? [`- Relay package: \`relay-evidence/${run.package}/\` (open its index.html for the screenshots)`] : []),
    ...run.conversations.map(conversation => `- ${conversation.label} transcript: \`${conversation.source}\``),
    `- Harness records: ${run.records.length}`,
    ...(run.check ? [`- Code check by the batch script: ${run.check.done ? "passed" : "FAILED"} (${run.check.check}); ${Math.round(run.check.seconds)} s`] : []),
    `- Failures found: ${failures.filter(failure => failure.run === run.id).length}`, "",
    "Times are UTC. Thinking is the model's own reasoning text as recorded.", ""];
  writeFileSync(join(out, file), `${header.join("\n")}\n${events.map(event => event.body).join("\n")}\n`);
}

// Relay runs that failed or were uncertain, from each package's own event log.
const relayFailures: string[] = [];
// Packages delivered to the repository root, and those delivered into the live-check run directories.
const eventDirs = [join(repository, "relay-evidence"), join(repository, "test-results")].flatMap(root => walk(root))
  .filter(path => /\/relay-evidence\/relay-[^/]+\/host\/events\/[^/]+\.json$/.test(path)).map(dirname);
for (const eventsDir of [...new Set(eventDirs)].sort()) {
  const name = rel(dirname(dirname(eventsDir)));
  for (const file of readdirSync(eventsDir).sort()) {
    const event = readJson(join(eventsDir, file));
    if (event.kind === "execution-failed" || event.kind === "operation-failed") {
      relayFailures.push(`| ${event.at} | \`${name}\` | ${event.kind} | ${JSON.stringify(event.details?.outcome ?? event.details?.error ?? event.details).slice(0, 220).replace(/\|/g, "/")} |`);
    }
  }
}

const byKind = new Map<string, number>();
for (const failure of failures) byKind.set(failure.kind, (byKind.get(failure.kind) ?? 0) + 1);
const index = [
  "# Computer-use failure trajectories", "",
  `Generated ${new Date().toISOString()} by \`scripts/computer-use/extract-trajectories.ts\` at revision of the working tree. Each run has a trajectory file under \`runs/\`.`, "",
  `- Runs found: ${runs.length} (${runs.filter(run => run.conversations.length > 0).length} with a model, ${runs.filter(run => run.conversations.length === 0).length} scripted).`,
  `- Duplicate copies skipped: ${duplicates.length}.`,
  `- Runs with at least one failure: ${new Set(failures.map(failure => failure.run)).size}.`,
  `- Failures found: ${failures.length}.`, "",
  "## Failures by kind", "", "| Kind | Count |", "| --- | --- |",
  ...[...byKind].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `| ${kind} | ${count} |`), "",
  "## Every failure", "", "| Run | Started (UTC) | Kind | Detail | Trajectory |", "| --- | --- | --- | --- | --- |",
  ...failures.map(failure => `| ${failure.run} | ${failure.when.slice(0, 19)} | ${failure.kind} | ${failure.detail.replace(/\|/g, "/")} | [${failure.file}](${failure.file}) |`), "",
  "## Every run", "", "| Run | Started (UTC) | Task | Failures | Trajectory |", "| --- | --- | --- | --- | --- |",
  ...runs.map(run => { const file = `runs/${run.id}-${run.when.slice(0, 19).replace(/[:T]/g, "-")}.md`;
    return `| ${run.id} | ${run.when.slice(0, 19)} | ${run.task.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 110)} | ${failures.filter(failure => failure.run === run.id).length} | [${file}](${file}) |`; }), "",
  "## Relay runs that failed or were uncertain", "",
  "These come from each relay package's event log. They are failures of a relay run or operation, not of a plan.", "",
  "| At | Package | Kind | Detail |", "| --- | --- | --- | --- |", ...relayFailures, "",
  "## Not covered", "",
  "- Failures without saved records, such as the `npx` start timeouts of 2026-09-24, are described in research Section 15 and in each run's `log.txt`, not here.",
  "- Standalone script checks without a plan record, such as click-placement trials, are not trajectories and are not listed.", "",
  "## Duplicate copies skipped", "", ...duplicates.map(line => `- ${line}`), "",
];
writeFileSync(join(out, "index.md"), index.join("\n"));
console.log(`Runs: ${runs.length}. Failures: ${failures.length} in ${new Set(failures.map(failure => failure.run)).size} runs. Relay run failures: ${relayFailures.length}.`);
console.log(`Output: ${rel(out)}/index.md`);
