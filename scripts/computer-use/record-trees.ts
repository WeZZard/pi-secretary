/**
 * Plan Phase 2: record real accessibility trees, report how the observer groups and filters
 * them, and check whether hand-labelled step targets survive filtering (retrieval misses).
 * It only reads windows. Everything is written to a new directory under test-results/.
 *
 *   node --experimental-strip-types scripts/computer-use/record-trees.ts <targets.json>
 *
 * targets.json: [{ "label": "finder-folder", "app": "Finder", "windowTitle": "Fixture Folder",
 *                  "intents": [{ "intent": "Go back", "expect": ["Back"] }] }]
 * An intent's `expect` lists acceptable UI element names; matching ignores case and extra whitespace.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { RawElement, WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { cuaDriverRunner, LocalDriverBackend } from "../../extensions/secretary/computer-use/backend/local-backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import { discardSummary, observe, type Observation } from "../../extensions/secretary/computer-use/observer.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";

interface Intent { intent: string; expect: string[] }
interface Target { label: string; app: string; windowTitle?: string; intents?: Intent[] }

const targets = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as Target[];
const config = defaultComputerUseConfiguration();
const out = resolve("test-results/computer-use", `trees-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(join(out, "fixture-candidates"), { recursive: true });
const backend = new LocalDriverBackend({ run: cuaDriverRunner(process.env.CUA_DRIVER ?? config.localDriverPath), maxTreeNodes: config.maxTreeNodes });
const telemetry = new Telemetry(out);
const clean = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Closed-menu items carry recent files, history, and window titles; home paths and the user name can appear anywhere. */
function redact(read: WindowRead): Omit<WindowRead, "readMs" | "screenshot"> {
  const byIndex = new Map(read.elements.map(element => [element.element_index, element]));
  const inMenuBar = (element: RawElement) => {
    for (let parent = element.parent_index; parent !== undefined; parent = byIndex.get(parent)?.parent_index) {
      if (byIndex.get(parent)?.role === "AXMenuBar") return true;
      if (!byIndex.has(parent)) return false;
    }
    return false;
  };
  const home = homedir(), user = userInfo().username;
  const mask = (text: string | undefined) => text?.split(home).join("~").split(user).join("user");
  const elements = read.elements.map(element => {
    const copy: RawElement = { ...element };
    delete copy.element_token;
    if (inMenuBar(element) && element.depth >= 3 && !element.frame) {
      if (copy.label !== undefined) copy.label = `menu item ${element.element_index}`;
      delete copy.value;
    } else {
      if (copy.label !== undefined) copy.label = mask(copy.label);
      if (copy.value !== undefined) copy.value = mask(copy.value);
    }
    return copy;
  });
  const descendantText = read.descendantText && Object.fromEntries(Object.entries(read.descendantText).map(([index, text]) => [index, mask(text)!]));
  return { window: { ...read.window, pid: 0, title: mask(read.window.title)! }, appActive: read.appActive, ...(descendantText ? { descendantText } : {}), snapshotId: read.snapshotId, truncated: read.truncated, elements };
}

const report: string[] = ["| Target | Raw nodes | Kept | Groups | Largest group | Truncated | App active | Discards |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
const retrieval: string[] = ["| Target | Intent | Result |", "| --- | --- | --- |"];
let misses = 0, checked = 0;
for (const target of targets) {
  let read: WindowRead;
  try { read = await backend.readWindow({ app: target.app, ...(target.windowTitle ? { windowTitle: target.windowTitle } : {}) }, { screenshot: false }); }
  catch (error) { report.push(`| ${target.label} | read failed: ${(error as Error).message} | | | | | | |`); continue; }
  const result = observe(read, { id: target.label, maxElements: config.maxElements, maxNameLength: config.maxNameLength });
  await telemetry.recordObservation(read, result, { attempt: 1, purpose: "phase2-record" });
  writeFileSync(join(out, "fixture-candidates", `${target.label}.json`), `${JSON.stringify(redact(read), null, 1)}\n`);
  const summary = Object.entries(discardSummary(result.discards)).filter(([, n]) => n > 0).map(([reason, n]) => `${reason} ${n}`).join(", ");
  if (result.status !== "ready") { report.push(`| ${target.label} | ${read.elements.length} | ${result.status}: ${result.detail} | | | ${read.truncated} | ${read.appActive} | ${summary} |`); continue; }
  const kept = result.groups.flatMap(group => group.elements);
  const largest = Math.max(0, ...result.groups.map(group => group.elements.length));
  report.push(`| ${target.label} | ${read.elements.length} | ${kept.length} | ${result.groups.length} | ${largest} | ${read.truncated} | ${read.appActive} | ${summary} |`);
  for (const { intent, expect } of target.intents ?? []) {
    checked++;
    const wanted = new Set(expect.map(clean));
    const hit = kept.find(element => wanted.has(clean(element.name)));
    if (hit) { retrieval.push(`| ${target.label} | ${intent} | kept: ${hit.group} ${hit.letter} ${JSON.stringify(hit.name)} |`); continue; }
    misses++;
    const raw = read.elements.filter(element => wanted.has(clean(element.label ?? "")) || wanted.has(clean(element.value ?? ""))
      || wanted.has(clean(read.descendantText?.[element.element_index] ?? "")));
    const reasons = raw.map(element => `${element.role} ${JSON.stringify(element.label ?? element.value)} ${result.discards.find(discard => discard.index === element.element_index)?.reason ?? "kept under another name"}`);
    retrieval.push(`| ${target.label} | ${intent} | **miss**: ${raw.length ? reasons.join("; ") : "absent from the tree"} |`);
  }
}
const text = `# Recorded trees\n\nRecorded ${new Date().toISOString()} with cua-driver through the local backend.\n\n${report.join("\n")}\n\n## Retrieval check\n\nRetrieval misses: ${misses} of ${checked} labelled intents.\n\n${retrieval.join("\n")}\n`;
writeFileSync(join(out, "report.md"), text);
console.log(text);
console.log(`Output: ${out}`);
