import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Parser, AstBuilder, GherkinClassicTokenMatcher } from "@cucumber/gherkin";

let sequence = 0;
const parser = new Parser(new AstBuilder(() => String(++sequence)), new GherkinClassicTokenMatcher());
const root = "docs/acceptance";
const ids = new Set<string>();
let files = 0;
for (const name of readdirSync(root).filter(name => name.endsWith(".feature")).sort()) {
  const path = join(root, name);
  const doc = parser.parse(readFileSync(path, "utf8"));
  if (!doc.feature?.tags.some(tag => tag.name === "@draft")) throw new Error(`${path}: missing specification status`);
  for (const child of doc.feature.children) {
    const scenario = child.scenario;
    if (!scenario) continue;
    const tags = scenario.tags.map(tag => tag.name);
    const scenarioIds = tags.filter(tag => tag.startsWith("@ACC-SA-"));
    if (scenarioIds.length !== 1 || ids.has(scenarioIds[0])) throw new Error(`${path}: duplicate or missing scenario identity`);
    ids.add(scenarioIds[0]);
    if (tags.filter(tag => tag === "@confirmed" || tag === "@proposed").length !== 1) throw new Error(`${path}: missing approval classification`);
    for (const keyword of ["Given", "When", "Then"]) {
      if (!scenario.steps.some(step => step.keyword.trim() === keyword)) throw new Error(`${path}: missing ${keyword} step`);
    }
    for (const examples of scenario.examples) {
      const headers = examples.tableHeader?.cells.map(cell => cell.value) ?? [];
      const placeholders = [...JSON.stringify(scenario.steps).matchAll(/<([^>]+)>/g)].map(match => match[1]);
      if (placeholders.some(p => !headers.includes(p)) || examples.tableBody.some(row => row.cells.length !== headers.length)) throw new Error(`${path}: invalid example columns`);
    }
  }
  files++;
}
console.log(`Validated ${files} Gherkin files and ${ids.size} scenario identities. This is syntax and traceability validation, not behavioral execution.`);
