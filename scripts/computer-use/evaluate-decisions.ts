/**
 * Plan Phase 4: replay recorded trees through the current observer, ask the live executor one
 * request per labelled intent, apply the decision policy, and classify every outcome.
 *
 *   node --experimental-strip-types scripts/computer-use/evaluate-decisions.ts <trees-dir> <targets.json> [executor-url]
 *
 * Metric formulas (design §12.2), held for every number this script prints:
 * - Retrieval miss rate: labelled intents whose expected element is absent from the executor's table, over all labelled intents.
 * - Judgment miss rate: intents whose expected element was in the table but the policy acted on another element, over intents whose element was in the table.
 * - Escalation: the policy returned an escalation or reobserve instead of acting; counted separately from misses.
 * - Wrong action on an unlisted target: the expected element was not in the table and the policy acted on another element.
 * - Executor round-trip latency, median (ms): harness-side time from sending the request to the full response.
 * - Input tokens: the service's usage.input_tokens, shown beside this harness's estimate.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import { ExecutorClient } from "../../extensions/secretary/computer-use/executor-client.ts";
import { observe, type Observation } from "../../extensions/secretary/computer-use/observer.ts";
import { decide } from "../../extensions/secretary/computer-use/policy.ts";
import { buildDecisionRequest } from "../../extensions/secretary/computer-use/request-builder.ts";

const flags = process.argv.slice(2).filter(arg => arg.startsWith("--"));
const [dir, targetsPath, url = "http://jev.home.arpa"] = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
if (!dir || !targetsPath) { console.error("usage: evaluate-decisions.ts <trees-dir> <targets.json> [executor-url] [--region-plain] [--no-none] [--seeds=1,2,3]"); process.exit(2); }
const regionDescriptions = flags.includes("--region-plain") ? "none" as const : "names" as const;
const noneOption = !flags.includes("--no-none");
const seeds = (flags.find(flag => flag.startsWith("--seeds="))?.slice(8) ?? "42").split(",").map(Number);
const targets = JSON.parse(readFileSync(targetsPath, "utf8")) as { label: string; app: string; goal?: string; intents?: { intent: string; expect: string[]; text?: string; keys?: string }[] }[];
const config = defaultComputerUseConfiguration();
const client = new ExecutorClient({ baseUrl: url, timeoutMs: 60_000 });
const clean = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const records = new Map(readdirSync(join(dir, "observations")).map(file => {
  const record = JSON.parse(readFileSync(join(dir, "observations", file), "utf8"));
  return [file.replace(/\.json$/, ""), record];
}));

const rows: string[] = ["| Target | Intent | Groups | In table | Decision | Outcome | Confidences | Input tokens (estimate) | Round trip |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
const latencies: number[] = [];
let labelled = 0, retrievalMisses = 0, present = 0, judgmentMisses = 0, correct = 0, escalations = 0, wrongActsOnAbsent = 0, scrollsOnAbsent = 0;
for (const target of targets) {
  const record = records.get(target.label);
  if (!record || record.status !== "ready") { rows.push(`| ${target.label} | (no ready record) | | | | | | | |`); continue; }
  const read: WindowRead = { window: record.window, appActive: record.appActive ?? false, truncated: record.truncated, elements: record.tree,
    ...(record.descendantText ? { descendantText: record.descendantText } : {}), readMs: 0 };
  const observation = observe(read, { id: target.label, maxElements: config.maxElements, maxNameLength: config.maxNameLength }) as Observation;
  for (const seed of seeds) for (const intent of target.intents ?? []) {
    labelled++;
    const wanted = new Set(intent.expect.map(clean));
    const inTable = observation.groups.flatMap(group => group.elements).some(element => wanted.has(clean(element.name)));
    if (inTable) present++; else retrievalMisses++;
    const step = { id: "s", intent: intent.intent, ...(intent.text ? { text: intent.text } : {}), ...(intent.keys ? { keys: intent.keys } : {}) };
    const built = buildDecisionRequest({ goal: target.goal ?? intent.intent, step, observation, recent: [], answerReserveTokens: config.answerReserveTokens, regionDescriptions, noneOption });
    let response;
    try { response = await client.decide({ ...built.body, seed }); }
    catch (error) { rows.push(`| ${target.label} | ${intent.intent} | ${observation.groups.length} | ${inTable} | ${(error as Error).message} | escalation | | (${built.estimatedTokens}) | |`); escalations++; continue; }
    latencies.push(response.roundTripMs);
    const decision = decide({ response, questions: built.questions, observation, step, allowDestructive: false, confidenceGate: config.confidenceGate });
    const confidences = Object.entries(decision.prior.confidences).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ");
    let described: string, outcome: string;
    if (decision.kind === "act") {
      described = `${decision.operation}${decision.element ? ` ${JSON.stringify(decision.element.name)}` : ""}${decision.group ? ` in ${decision.group.name}` : ""}`;
      const hit = decision.element ? wanted.has(clean(decision.element.name)) : false;
      const scrolled = decision.operation === "scroll_up" || decision.operation === "scroll_down";
      if (hit) { correct++; outcome = "correct"; }
      else if (inTable) { judgmentMisses++; outcome = "**judgment miss**"; }
      else if (scrolled) { scrollsOnAbsent++; outcome = "scroll (target not listed)"; }
      else { wrongActsOnAbsent++; outcome = "**wrong action on an unlisted target**"; }
    } else {
      escalations++;
      described = decision.kind === "reobserve" ? "reobserve" : `${decision.reason}: ${decision.detail}`;
      outcome = inTable ? "escalation" : "escalation (target absent)";
      if (decision.prior.element) described += ` (prior ${JSON.stringify(decision.prior.element)})`;
    }
    rows.push(`| ${target.label} | ${intent.intent} (seed ${seed}) | ${observation.groups.length} | ${inTable} | ${described} | ${outcome} | ${confidences} | ${response.inputTokens ?? "?"} (${built.estimatedTokens}) | ${Math.round(response.roundTripMs)} ms |`);
  }
}
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN; };
const text = `# Executor decision evaluation\n\nTrees: ${dir}\nExecutor: ${url}\nRegion descriptions: ${regionDescriptions}\nNone option: ${noneOption}\nSeeds: ${seeds.join(", ")}\nRun: ${new Date().toISOString()}\n\n` +
  `| Measure | Value |\n| --- | --- |\n| Labelled intents | ${labelled} |\n| Retrieval misses | ${retrievalMisses} of ${labelled} |\n` +
  `| Judgment misses | ${judgmentMisses} of ${present} intents whose element was in the table |\n| Correct actions | ${correct} of ${labelled} |\n` +
  `| Escalations | ${escalations} |\n| Wrong actions when the target was not listed | ${wrongActsOnAbsent} of ${retrievalMisses} |\n| Scrolls when the target was not listed | ${scrollsOnAbsent} of ${retrievalMisses} |\n| Executor round-trip latency, median | ${Math.round(median(latencies))} ms over ${latencies.length} requests |\n\n${rows.join("\n")}\n`;
writeFileSync(join(dir, `evaluation-${new Date().toISOString().replace(/[:.]/g, "-")}.md`), text);
console.log(text);
