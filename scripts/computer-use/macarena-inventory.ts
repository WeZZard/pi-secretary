/**
 * Evaluation plan phase E0 (design docs/testing/computer-use-evaluation.md §9): list what every
 * MacArena task needs, so each can be classified as runnable in a relay machine or not.
 *
 *   node --experimental-strip-types scripts/computer-use/macarena-inventory.ts <MacArena checkout> [probe.json]
 *
 * `probe.json` is the relay image's facts: { "apps": ["Calendar", ...], "tools": ["python3", ...], "paths": ["~/Desktop/a.txt", ...] },
 * where "paths" lists the referenced paths that exist in the image. Without it, only the needs are listed.
 * Output: a new directory under test-results/computer-use/ with inventory.json and inventory.md.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [root, probePath] = process.argv.slice(2);
if (!root) { console.error("usage: macarena-inventory.ts <MacArena checkout> [probe.json]"); process.exit(2); }
const probe = probePath ? JSON.parse(readFileSync(probePath, "utf8")) as { apps: string[]; tools: string[]; paths: string[] } : undefined;

interface Task {
  id: string; instruction: string; pre_command?: string; pre_upload_files?: unknown[]; config?: unknown[];
  evaluator: [string, number][] | { func: unknown }; related_apps?: string[];
}
export interface Need {
  file: string; source: string; category: string; format: "shell" | "osworld"; id: string; instruction: string;
  apps: string[]; tools: string[]; paths: string[]; uploads: number; quitsApp: boolean; opensApp: boolean;
  runnable?: boolean; reasons?: string[];
}

const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : name.endsWith(".json") ? [path] : [];
});
/** Tools a task's shell commands run, beyond what every macOS guest has. */
const TOOLS = ["python3", "ffmpeg", "ffprobe", "sqlite3", "exiftool", "pdftotext", "jq", "brew", "conda", "mdls", "mdfind", "defaults", "plutil", "shortcuts", "sips", "textutil"];
const examples = join(root, "evaluation_examples");
const needs: Need[] = [];
for (const file of walk(examples)) {
  const rel = relative(examples, file);
  const [source, category] = rel.split("/");
  if (!category || !rel.includes("/", source!.length + category.length + 1)) continue;
  const task = JSON.parse(readFileSync(file, "utf8")) as Task;
  if (!task.instruction) continue;
  const format = Array.isArray(task.evaluator) ? "shell" : "osworld";
  const scripts = [task.pre_command ?? "", ...(Array.isArray(task.evaluator) ? task.evaluator.map(([command]) => command) : [JSON.stringify(task.evaluator), JSON.stringify(task.config ?? [])])].join("\n");
  const apps = new Set(task.related_apps ?? []);
  for (const match of scripts.matchAll(/tell application (?:\\?")([^"\\]+)(?:\\?")/g)) if (match[1] !== "System Events" && match[1] !== "Finder") apps.add(match[1]!);
  for (const match of scripts.matchAll(/open -a (?:\\?"([^"\\]+)\\?"|'([^']+)'|(\S+))/g)) apps.add((match[1] ?? match[2] ?? match[3])!);
  const tools = TOOLS.filter(tool => new RegExp(`(^|[\\s;|&(])${tool}\\b`).test(scripts));
  const paths = [...new Set([...scripts.matchAll(/(~\/[^\s'"\\;|&)]+|\/Users\/[^\s'"\\;|&)]+)/g)].map(match => match[1]!.replace(/[.,]$/, "")))];
  needs.push({ file: rel, source: source!, category, format, id: task.id, instruction: task.instruction, apps: [...apps].sort(), tools, paths,
    uploads: task.pre_upload_files?.length ?? 0, quitsApp: /\bto quit\b|killall|pkill/.test(task.pre_command ?? ""), opensApp: /open -a|\bto activate\b|\blaunch\b/.test(task.pre_command ?? "") });
}

if (probe) {
  const has = (list: string[], name: string) => list.some(entry => entry.toLowerCase() === name.toLowerCase());
  for (const need of needs) {
    const reasons = [
      ...(need.format === "osworld" ? ["checked by a host-side Python evaluator"] : []),
      ...need.apps.filter(app => !has(probe.apps, app)).map(app => `app missing: ${app}`),
      ...need.tools.filter(tool => !has(probe.tools, tool)).map(tool => `tool missing: ${tool}`),
      ...(need.uploads ? ["needs uploaded files"] : []),
      // macOSWorld tasks run in snapshots whose account is admin and whose files, such as
      // ~/Documents/benchmark_files, are not published; the relay image's account is station.
      ...(need.paths.some(path => path.startsWith("/Users/admin")) ? ["needs macOSWorld snapshot files under /Users/admin"] : []),
    ];
    need.runnable = reasons.length === 0;
    need.reasons = reasons;
  }
}

const out = join(import.meta.dirname, "../../test-results/computer-use", `macarena-inventory-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "inventory.json"), JSON.stringify(needs, null, 1));
const count = (filter: (need: Need) => boolean) => needs.filter(filter).length;
const categories = [...new Set(needs.map(need => `${need.source}/${need.category}`))].sort();
const lines = ["# MacArena task inventory", "", `Checkout: ${root}`, `Probe: ${probePath ?? "none"}`, "",
  "| Category | Tasks | Shell-checked | Runnable | Setup quits the app | One app |", "| --- | --- | --- | --- | --- | --- |",
  ...categories.map(category => {
    const inCategory = (need: Need) => `${need.source}/${need.category}` === category;
    return `| ${category} | ${count(inCategory)} | ${count(need => inCategory(need) && need.format === "shell")} | ${probe ? count(need => inCategory(need) && need.runnable === true) : "?"} | ${count(need => inCategory(need) && need.quitsApp)} | ${count(need => inCategory(need) && need.apps.length === 1)} |`;
  }),
  `| total | ${needs.length} | ${count(need => need.format === "shell")} | ${probe ? count(need => need.runnable === true) : "?"} | ${count(need => need.quitsApp)} | ${count(need => need.apps.length === 1)} |`,
  "", "Apps named by shell-checked tasks:", "",
  ...Object.entries(needs.filter(need => need.format === "shell").flatMap(need => need.apps).reduce<Record<string, number>>((all, app) => ({ ...all, [app]: (all[app] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1]).map(([app, n]) => `- ${app}: ${n}`),
  "", "Tools named by shell-checked tasks:", "",
  ...TOOLS.map(tool => [tool, count(need => need.format === "shell" && need.tools.includes(tool))] as const).filter(([, n]) => n > 0).map(([tool, n]) => `- ${tool}: ${n}`),
  ...(probe ? ["", "Reasons a shell-checked task cannot run:", "",
    ...Object.entries(needs.filter(need => need.format === "shell").flatMap(need => need.reasons ?? []).reduce<Record<string, number>>((all, reason) => ({ ...all, [reason]: (all[reason] ?? 0) + 1 }), {}))
      .sort((a, b) => b[1] - a[1]).map(([reason, n]) => `- ${reason}: ${n}`)] : []),
];
writeFileSync(join(out, "inventory.md"), `${lines.join("\n")}\n`);
console.log(out);
