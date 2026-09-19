import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { artifactDirectory } from "./test-artifacts.ts";
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

const requested = process.argv[2];
if (!requested) throw new Error("Usage: render-tui-recording.ts <recording directory under test-results/ or an external path>");
const directory = artifactDirectory(fileURLToPath(new URL("../", import.meta.url)), requested);
const [header, ...events] = readFileSync(join(directory, "walkthrough.cast"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const checkpoints = JSON.parse(readFileSync(join(directory, "checkpoints.json"), "utf8")) as Array<{ name: string; eventIndex: number; columns: number; rows: number }>;
const terminal = new Terminal({ cols: header.width, rows: header.height, allowProposedApi: true, scrollback: 10000 });
const snapshots = join(directory, "screens"); mkdirSync(snapshots, { recursive: true });
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const expected: Record<string, string[]> = {
  "01-running-fleet": ["1 active agents"],
  "02-wide-inspector": ["Task: Inspect acceptance fixture", "acceptance-worker", "running"],
  "02b-paused-transcript": ["Transcript: paused"],
  "02c-expanded-tool-details": ["Original prompt:", "Outcome: running"],
  "02d-following-restored": ["Transcript: following"],
  "03-message-composer": ["Queue guidance", "Check failure handling before finishing."],
  "03b-retained-composer-draft": ["Queue guidance", "Check failure handling before finishing."],
  "04-message-acknowledged": ["Operation acceptance is recorded."],
  "05-narrow-inspector": ["Task: Inspect acceptance fixture", "Esc close"],
  "06-stop-confirmation": ["Confirm stop", "Enter confirms"],
  "07-cancelled-inspector": ["acceptance-worker · cancelled", "Agents ·"],
  "07b-menu-top": ["Subagents", "Esc dismiss"],
  "07c-menu-subagents-section": ["Model Fallback Lists", "← back · Esc dismiss"],
  "07d-menu-manager": ["Model Fallback Lists", "＋ Add List", "a add list · r rename list · d remove list"],
  "07e-menu-name-prompt": ["Add List", "Name the fallback list.", "acceptance-fallback"],
  "07f-menu-list-added": ["Added list acceptance-fallback", "0 models"],
  "07g-menu-rename-prompt": ["Rename List", "Renaming preserves the list's models.", "> acceptance-fallback"],
  "07h-menu-list-renamed": ["Renamed acceptance-fallback to acceptance-fallback-renamed.", "acceptance-fallback-renamed  0 models"],
  "07i-menu-list-detail": ["Models are tried from first to last.", "＋ Add Model", "Enter/→ add"],
  "07j-menu-model-picker": ["Add Model › acceptance-fallback-renamed", "fixture [secretary-tui-test]", "Enter add"],
  "07k-menu-model-added": ["Added secretary-tui-test/fixture to acceptance-fallback-renamed", "Shift+K/J move up/down"],
  "08-editor-return": ["Preserved editor draft"],
};
const assertions: Array<{ checkpoint: string; passed: boolean; checks: string[] }> = [];
let next = 0;
for (let index = 0; index < events.length; index++) {
  const [, kind, value] = events[index];
  if (kind === "o") await new Promise<void>(resolve => terminal.write(value, resolve));
  if (kind === "r") { const [cols, rows] = value.split("x").map(Number); terminal.resize(cols, rows); }
  while (next < checkpoints.length && checkpoints[next].eventIndex === index + 1) {
    const checkpoint = checkpoints[next++];
    const buffer = terminal.buffer.active;
    const lines = Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true).trimEnd() ?? "");
    const text = lines.join("\n") + "\n";
    writeFileSync(join(snapshots, `${checkpoint.name}.txt`), text);
    for (const required of expected[checkpoint.name] ?? []) assert.ok(text.includes(required), `${checkpoint.name}: visible terminal grid is missing ${required}`);
    if (checkpoint.name === "08-editor-return") assert.ok(!text.includes("Agents ·"), "The inspector must be closed after Escape");
    assertions.push({ checkpoint: checkpoint.name, passed: true, checks: expected[checkpoint.name] ?? [] });
    writeFileSync(join(snapshots, `${checkpoint.name}.html`), `<!doctype html><meta charset="utf-8"><title>${checkpoint.name}</title><style>body{background:#111;color:#eee;padding:24px}pre{font:14px/1.4 monospace;white-space:pre}</style><p>Recorded terminal grid: ${checkpoint.columns} × ${checkpoint.rows}. Colors are not reproduced.</p><pre>${escape(text)}</pre>`);
  }
}
terminal.dispose();
writeFileSync(join(directory, "screen-assertions.json"), JSON.stringify(assertions, null, 2) + "\n");
if (next !== checkpoints.length) throw new Error("A checkpoint did not correspond to a recorded output boundary.");
console.log(`Replayed ${next} recorded terminal checkpoints. HTML files show the captured character grid, not pixel screenshots or human approval.`);
