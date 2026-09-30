/**
 * Measures the grounder's token limits that the answer reserve rests on (research §13).
 *
 *   node --experimental-strip-types scripts/computer-use/measure-token-budget.ts [grounder-url]
 *
 * Formulas, held for every number this script prints:
 * - Answer tokens: the service's `usage.output_tokens`, which is the output length its reads request from vLLM.
 * - Input tokens: the service's `usage.input_tokens`.
 * - Model-length limit: the largest input tokens plus answer tokens that the service accepts.
 *
 * Part 1 sends the question shape the request builder makes for 1 to 26 groups: a region
 * question when there are two or more groups, one 26-option UI element question per group, and the
 * operation and risk questions. The answer length depends only on the question ids and labels.
 * Part 2 grows a one-question state until the service rejects it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DecisionServiceClient, DecisionServiceError, type ChoiceQuestion } from "../../extensions/secretary/computer-use/decision-service-client.ts";

const url = process.argv[2] ?? "http://jev.home.arpa";
const client = new DecisionServiceClient({ baseUrl: url, timeoutMs: 120_000 });
const options = (count: number): ChoiceQuestion => ({ type: "choice", instructions: "Pick one.",
  criteria: Object.fromEntries(Array.from({ length: count }, (_, i) => [String.fromCharCode(65 + i), null])) });
const lines = ["# Grounder token budget", "", `Grounder: ${url}. Date: ${new Date().toISOString()}.`, "",
  "## Answer tokens by group count", "", "| Groups | Questions | Answer tokens | Input tokens |", "| --- | --- | --- | --- |"];

for (let groups = 1; groups <= 26; groups++) {
  const questions: Record<string, ChoiceQuestion> = {};
  if (groups > 1) questions.region = options(groups);
  for (let i = 1; i <= groups; i++) questions[`element_${i}`] = options(26);
  questions.operation = options(9);
  questions.risk = options(3);
  const response = await client.decide({ state: { x: "y" }, questions, samples: 1 });
  lines.push(`| ${groups} | ${Object.keys(questions).length} | ${response.outputTokens ?? "?"} | ${response.inputTokens ?? "?"} |`);
}

lines.push("", "## Model-length limit", "", "| Words of state | Result | Input tokens | Answer tokens | Sum |", "| --- | --- | --- | --- | --- |");
const one = { q: options(2) };
for (const words of [3900, 3990, 4000, 4001, 4002, 4003, 4004, 4005, 5000]) {
  try {
    const response = await client.decide({ state: { text: Array(words).fill("alpha").join(" ") }, questions: one, samples: 1 });
    lines.push(`| ${words} | accepted | ${response.inputTokens} | ${response.outputTokens} | ${(response.inputTokens ?? 0) + (response.outputTokens ?? 0)} |`);
  } catch (error) {
    if (!(error instanceof DecisionServiceError)) throw error;
    lines.push(`| ${words} | ${error.code} | | | |`);
  }
}

const out = resolve("test-results/computer-use", `token-budget-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
console.log(`${lines.join("\n")}\n\nOutput: ${out}`);
