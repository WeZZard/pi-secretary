import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { artifactDirectory } from "./test-artifacts.ts";
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

const requested = process.argv[2];
if (!requested) throw new Error("Usage: check-inline-recording.ts <recording directory under test-results/ or an external path>");
const directory = artifactDirectory(fileURLToPath(new URL("../", import.meta.url)), requested);
const [header, ...events] = readFileSync(join(directory, "walkthrough.cast"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const checkpoints = JSON.parse(readFileSync(join(directory, "checkpoints.json"), "utf8")) as Array<{ name: string; eventIndex: number; columns: number; rows: number }>;
const terminal = new Terminal({ cols: header.width, rows: header.height, allowProposedApi: true, scrollback: 10000 });
const snapshots = join(directory, "screens"); mkdirSync(snapshots, { recursive: true });
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const expected: Record<string, string[]> = {
  "01-foreground-compact": ["Agent · general-purpose · foreground-worker · inline-test/fixture", "running", "thinking…", "expand for task details"],
  "02-foreground-full": ["Agent ID:", "Run:", "Prompt:", "FOREGROUND_TASK", "Result:", "Partial: true"],
  "03-foreground-recollapsed": ["thinking…", "expand for task details"],
  "04-foreground-completed": ["succeeded", "INLINE_STEP_DONE"],
  "05-completed-full": ["Partial: false", "FOREGROUND_RESULT", "FOREGROUND_TASK"],
  "06-background-launch": ["Agent · general-purpose · background-worker · inline-test/fixture · background"],
  "07-message-compact": ["SendMessage · general-purpose · background-worker", "Message: MESSAGE_FIRST", "…"],
  "08-message-full": ["SendMessage · general-purpose · background-worker", "MESSAGE_SECOND", "Run:", "queued"],
  "09-narrow-full": ["MESSAGE_SECOND", "Run:", "queued"],
  "10-narrow-compact": ["Message: MESSAGE_FIRST", "…"],
  "11-wide-compact": ["Message: MESSAGE_FIRST", "…"],
};
assert.deepEqual(checkpoints.map(checkpoint => checkpoint.name), Object.keys(expected), "All walkthrough checkpoints must be recorded in order");
const assertions: Array<{ checkpoint: string; passed: boolean; checks: string[] }> = [];
let next = 0;
for (let index = 0; index < events.length; index++) {
  const [, kind, value] = events[index];
  if (kind === "o") await new Promise<void>(resolve => terminal.write(value, resolve));
  if (kind === "r") { const [cols, rows] = value.split("x").map(Number); terminal.resize(cols, rows); }
  while (next < checkpoints.length && checkpoints[next].eventIndex === index + 1) {
    const checkpoint = checkpoints[next++];
    assert.equal(terminal.cols, checkpoint.columns);
    assert.equal(terminal.rows, checkpoint.rows);
    const buffer = terminal.buffer.active;
    const lines = Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true).trimEnd() ?? "");
    const text = lines.join("\n") + "\n";
    writeFileSync(join(snapshots, `${checkpoint.name}.txt`), text);
    for (const required of expected[checkpoint.name] ?? []) assert.ok(text.includes(required), `${checkpoint.name}: visible terminal grid is missing ${required}`);
    if (["01-foreground-compact", "03-foreground-recollapsed", "04-foreground-completed", "06-background-launch", "07-message-compact", "10-narrow-compact", "11-wide-compact"].includes(checkpoint.name)) {
      for (const forbidden of ["Prompt:", "Agent ID:", "original multiline guidance and report the result.", "Not the actual message"])
        assert.ok(!text.includes(forbidden), `${checkpoint.name}: compact grid contains ${forbidden}`);
    }
    if (checkpoint.name === "06-background-launch") {
      const header = lines.findIndex(line => line.includes("Agent · general-purpose · background-worker"));
      assert.ok(header >= 0 && !lines[header + 1].trim(), "Background launch must have no status/task/acknowledgment body");
    }
    if (["08-message-full", "09-narrow-full"].includes(checkpoint.name)) {
      const message = text.slice(text.indexOf("SendMessage ·"));
      assert.ok(message.indexOf("MESSAGE_FIRST") < message.indexOf("MESSAGE_SECOND"));
      assert.ok(message.indexOf("MESSAGE_SECOND") < message.indexOf("Run:"));
      assert.ok(!message.includes("inline-test/fixture"), "SendMessage must not add a model row");
    }
    assertions.push({ checkpoint: checkpoint.name, passed: true, checks: expected[checkpoint.name] ?? [] });
    writeFileSync(join(snapshots, `${checkpoint.name}.html`), `<!doctype html><meta charset="utf-8"><title>${checkpoint.name}</title><style>body{background:#111;color:#eee;padding:24px}pre{font:14px/1.4 monospace;white-space:pre}</style><p>Recorded terminal grid: ${checkpoint.columns} × ${checkpoint.rows}. Colors are not reproduced.</p><pre>${escape(text)}</pre>`);
  }
}
terminal.dispose();
writeFileSync(join(directory, "screen-assertions.json"), JSON.stringify(assertions, null, 2) + "\n");
if (next !== checkpoints.length) throw new Error("A checkpoint did not correspond to a recorded output boundary.");
console.log(`Replayed ${next} recorded terminal checkpoints. HTML files show the captured character grid, not pixel screenshots or human approval.`);
