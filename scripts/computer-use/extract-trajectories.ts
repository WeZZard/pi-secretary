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
  /** Relay evidence package directories whose screenshots belong to this run. */
  packages: string[];
  /** Harness step pictures: runs/<runId>/pictures/<step>-<attempt>-<before|after>.png. */
  pictures: string[];
}

/** A relay display screenshot, named by the relay after its capture time, phase and execution. */
interface DisplayShot { path: string; at: number; phase: string; execution: string; caption: string }
function displayShots(packageDir: string): DisplayShot[] {
  const shots: DisplayShot[] = [];
  for (const path of walk(join(packageDir, "state", "snapshots")).filter(file => file.endsWith(".png"))) {
    const match = /-(\d{8}T\d{6}\.\d{3}Z)-(before|after)-(execution-[A-Za-z0-9]+)\.png$/.exec(path);
    if (!match) continue;
    const stamp = match[1]!.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:$6");
    const request = join(packageDir, "host", "requests", `${match[3]}.json`);
    let what = match[3]!;
    if (existsSync(request)) {
      const body = readJson(request);
      const input = body.kind === "cua" ? ` (cua-driver ${body.tool}${body.args?.x !== undefined ? ` at pixel ${body.args.x},${body.args.y}` : ""}${body.args?.key ? ` key ${body.args.key}` : ""})`
        : body.kind === "exec" ? ` (${(body.argv ?? []).join(" ").slice(0, 200)})` : body.kind ? ` (${body.kind} run)` : "";
      what = `relay step ${body.step?.id ?? "?"}, "${body.step?.title ?? ""}"${input}`;
    }
    shots.push({ path, at: Date.parse(stamp), phase: match[2]!, execution: match[3]!, caption: `Whole VM display ${match[2]} ${what}` });
  }
  return shots.sort((a, b) => a.at - b.at);
}
/** Relay evidence packages delivered into a run directory, not the finalization attempts. */
const packagesIn = (dir: string) => existsSync(join(dir, "relay-evidence"))
  ? readdirSync(join(dir, "relay-evidence")).filter(name => /^relay-[^.]+$/.test(name)).map(name => join(dir, "relay-evidence", name)) : [];

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
  const pictures = walk(join(dir, "secretary", "computer-use")).filter(path => path.includes("/pictures/") && path.endsWith(".png"));
  const siblings = join(dirname(dir), "runs.json");
  const check = existsSync(siblings) ? (readJson(siblings) as Json[]).find(entry => entry.name === basename(dir)) : undefined;
  const first = messages.find(message => message.role === "user");
  const pkg = packageOf(events);
  runs.push({ id: "", when: started(messages, events), source: rel(dir), package: pkg, packages: pkg ? [join(repository, "relay-evidence", pkg)] : [], pictures,
    task: text(first).slice(0, 200), conversations: [{ label: "Pi (planner)", source: rel(events), messages }], records, ...(check ? { check } : {}) });
}

// Script runs of the harness on the development machine through the relay client.
for (const dir of readdirSync(join(repository, "test-results/computer-use")).filter(name => name.startsWith("relay-live-")).map(name => join(repository, "test-results/computer-use", name))) {
  const records = walk(dir).filter(path => /\/(observations|runs)\//.test(path) && path.endsWith(".json") && !path.includes("relay-evidence"));
  if (records.length === 0) continue;
  runs.push({ id: "", when: new Date(Math.min(...records.map(path => time(readJson(path).recordedAt)))).toISOString(), source: rel(dir),
    task: "Scripted plan: Calculator 7 + 3 (scripts/computer-use/relay-live.ts, no model)", conversations: [], records, packages: packagesIn(dir), pictures: [] });
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
  runs.push({ id: "", when: started(conversations.flatMap(conversation => conversation.messages), join(dir, "log.txt")), source: rel(dir), task: text(first).slice(0, 200), conversations, records, packages: packagesIn(dir), pictures: [] });
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
  const docDir = dirname(join(out, file));
  // Figures are numbered after the timeline is sorted; FIGURE is the placeholder.
  const figure = (path: string, caption: string) => `\n![Figure \u0000FIGURE\u0000](${relative(docDir, path).split("/").map(encodeURIComponent).join("/")})\n\n*Figure \u0000FIGURE\u0000. ${caption}*\n`;

  // Window screenshots the relay client wrote at every read, in read order (design §11.2).
  const readShots = [...new Map(run.packages.flatMap(dir => walk(join(dir, "extractions")))
    .filter(path => /\/read-\d{4}\.png$/.test(path)).map(path => [basename(path), path] as const)).values()].sort();
  const observations = run.records.filter(path => path.includes("/observations/")).map(path => ({ path, at: time(readJson(path).recordedAt) })).sort((a, b) => a.at - b.at);
  const readShotFor = new Map<string, { path: string; note: string }>();
  if (readShots.length >= observations.length && observations.length > 0) {
    // The scripted runs make reads without records first, so the recorded reads are the last ones.
    const offset = readShots.length - observations.length;
    observations.forEach((observation, i) => readShotFor.set(observation.path, { path: readShots[offset + i]!,
      note: offset === 0 ? "matched to this read by order" : `matched by order to the last ${observations.length} of ${readShots.length} reads; the script made ${offset} reads without records first` }));
  }
  const usedPictures = new Set<string>();

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
        + `- Text shown in the window: ${shown || "none"}\n\n<details><summary>Element table given to the executor</summary>\n${fence(record.executorTable ?? "")}</details>\n`
        + (readShotFor.has(path) ? figure(readShotFor.get(path)!.path, `Window screenshot taken by this read (${record.purpose}); ${readShotFor.get(path)!.note}.`) : ""));
    } else if (record.schema?.includes("step")) {
      const answers = Object.entries(record.answers ?? {}).map(([question, answer]: [string, any]) => `${question}=${answer.choice} (${Number(answer.confidence).toFixed(2)})`).join(", ");
      const decision = record.decision ?? {};
      add(at, `### ${clock(at)} executor: step \`${record.stepId}\`, attempt ${record.attempt}\n\n`
        + `- Asked: ${JSON.stringify(record.request?.state?.step ?? "")}\n- Answers: ${answers || "none"}\n`
        + `- Decision: ${decision.kind}${decision.operation ? ` ${decision.operation}` : ""}${decision.element ? ` ${JSON.stringify(decision.element)}` : ""}${decision.reason ? ` (${decision.reason})` : ""}${decision.detail ? `: ${decision.detail}` : ""}\n`
        + `- Round trip: ${Math.round(record.roundTripMs ?? 0)} ms\n`
        + ["before", "after"].map(phase => {
          const picture = run.pictures.find(candidate => !usedPictures.has(candidate) && candidate.includes(`/runs/${record.runId}/pictures/`)
            && basename(candidate) === `${record.stepId}-${record.attempt}-${phase}.png`);
          if (!picture) return "";
          usedPictures.add(picture);
          return figure(picture, `Target window ${phase} the action of step ${record.stepId}, attempt ${record.attempt} (harness step picture).`);
        }).join(""));
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

  // Step pictures not matched to an executor record go with their plan.
  for (const picture of run.pictures.filter(candidate => !usedPictures.has(candidate))) {
    const plan = join(dirname(dirname(picture)), "plan.json");
    add(existsSync(plan) ? time(readJson(plan).recordedAt) - 1 : NaN, figure(picture, `Target window, ${basename(picture, ".png")} (harness step picture).`));
  }
  // Whole-display screenshots from the relay, placed by their capture time. A package shared by
  // several Pi runs contributes only the relay commands whose before-to-after span overlaps this run.
  const times = events.map(event => event.at).filter(Number.isFinite);
  const [from, to] = [Math.min(...times), Math.max(...times)];
  const shared = run.package !== undefined;
  let displayed = 0;
  const shots = run.packages.flatMap(displayShots);
  const spans = new Map<string, [number, number]>();
  for (const shot of shots) {
    const span = spans.get(shot.execution) ?? [Infinity, -Infinity];
    spans.set(shot.execution, [Math.min(span[0], shot.at), Math.max(span[1], shot.at)]);
  }
  for (const shot of shots.filter(candidate => !shared || (spans.get(candidate.execution)![0] <= to && spans.get(candidate.execution)![1] >= from))) {
    displayed++;
    add(shot.at, `### ${clock(shot.at)} relay: display ${shot.phase}\n${figure(shot.path, shot.caption)}`);
  }

  events.sort((a, b) => (Number.isFinite(a.at) ? a.at : Infinity) - (Number.isFinite(b.at) ? b.at : Infinity) || a.order - b.order);
  const header = [`# Run ${run.id}: ${run.task || "(no prompt)"}`, "",
    `- Started: ${run.when}`, `- Source: \`${run.source}\``, ...(run.package ? [`- Relay package: \`relay-evidence/${run.package}/\` (open its index.html for the screenshots)`] : []),
    ...run.conversations.map(conversation => `- ${conversation.label} transcript: \`${conversation.source}\``),
    `- Harness records: ${run.records.length}`,
    `- Figures: ${run.pictures.length} step pictures, ${readShotFor.size} window screenshots from reads, ${displayed} whole-display screenshots from the relay`,
    ...(run.check ? [`- Code check by the batch script: ${run.check.done ? "passed" : "FAILED"} (${run.check.check}); ${Math.round(run.check.seconds)} s`] : []),
    `- Failures found: ${failures.filter(failure => failure.run === run.id).length}`, "",
    "Times are UTC. Thinking is the model's own reasoning text as recorded.",
    "Figures: a step picture shows the target window before or after one action; a read screenshot shows the window at one read; a display screenshot shows the whole VM screen before or after one relay command. In the 2026-09-23 runs Pi itself ran as one relay command, so the display screenshots there bracket the whole Pi run, not single steps.", ""];
  let figures = 0;
  const body = events.map(event => event.body).join("\n").replace(/!\[Figure \u0000FIGURE\u0000\]([^\n]*)\n\n\*Figure \u0000FIGURE\u0000\./g,
    (_match, link: string) => { figures++; return `![Figure ${figures}]${link}\n\n*Figure ${figures}.`; });
  writeFileSync(join(out, file), `${header.join("\n")}\n${body}\n`);
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
  `Generated ${new Date().toISOString()} by \`scripts/computer-use/extract-trajectories.ts\` at revision of the working tree. Each run has a trajectory file under \`runs/\`, with screenshots as figures.`, "",
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
