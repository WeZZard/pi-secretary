/**
 * Research §14.3: does any delivery of Cmd+S reach TextEdit's Save menu item?
 * Each trial types one letter so the document is edited, covers TextEdit with Safari, sends Cmd+S
 * one way, and reads the title-bar menu button, which is labelled "Edited" until the document is saved.
 * The file on disk is no evidence, because TextEdit autosaves it.
 *
 *   node --experimental-strip-types scripts/computer-use/menu-shortcut.ts [trials-per-method]
 *
 * Expects TextEdit to show scratch.txt. Output goes to a new test-results directory.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { cuaDriverRunner, LocalDriverBackend } from "../../extensions/secretary/computer-use/backend/local-backend.ts";

const trials = Number(process.argv[2] ?? 3);
const run = cuaDriverRunner(process.env.CUA_DRIVER ?? "cua-driver");
const backend = new LocalDriverBackend({ run, maxTreeNodes: 2000 });
const target = { app: "TextEdit", windowTitle: "scratch.txt" };
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const out = resolve("test-results/computer-use", `menu-shortcut-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });

/** The label of the window's title-bar menu button: "Edited" for unsaved changes. */
const marker = (read: WindowRead) => read.elements.find(element => element.role === "AXMenuButton" && element.depth === 1)?.label ?? "none";
const read = () => backend.readWindow(target, { screenshot: false });

type Method = { name: string; send(window: WindowRead["window"]): Promise<unknown> };
const methods: Method[] = [
  { name: "press_key, foreground (current backend)", send: w => run("press_key", { pid: w.pid, window_id: w.windowId, key: "s", modifiers: ["cmd"], delivery_mode: "foreground" }, { timeoutMs: 15_000 }) },
  { name: "hotkey, background", send: w => run("hotkey", { pid: w.pid, window_id: w.windowId, keys: ["cmd", "s"] }, { timeoutMs: 15_000 }) },
  { name: "hotkey, foreground", send: w => run("hotkey", { pid: w.pid, window_id: w.windowId, keys: ["cmd", "s"], delivery_mode: "foreground" }, { timeoutMs: 15_000 }) },
  { name: "open -a TextEdit, then hotkey to the desktop", send: async () => {
    execFileSync("/usr/bin/open", ["-a", "TextEdit"]); await wait(1000);
    return run("hotkey", { keys: ["cmd", "s"], scope: "desktop" }, { timeoutMs: 15_000 });
  } },
];

const rows: Record<string, unknown>[] = [];
for (const method of methods) {
  for (let trial = 1; trial <= trials; trial++) {
    execFileSync("/usr/bin/open", ["-a", "Safari"]); await wait(1500);
    let state = await read();
    await backend.act(state.window, { kind: "key", key: "x", modifiers: [] });
    await wait(800);
    state = await read();
    const before = marker(state);
    let error: string | undefined;
    try { await method.send(state.window); } catch (caught) { error = (caught as Error).message.slice(0, 200); }
    await wait(1500);
    const after = marker(await read());
    const outcome = before !== "Edited" ? "setup failed" : error ? "error" : after === "Edited" ? "not saved" : "saved";
    rows.push({ method: method.name, trial, before, after, outcome, ...(error ? { error } : {}) });
    console.log(`${method.name} #${trial}: ${outcome} (title-bar button ${JSON.stringify(before)} -> ${JSON.stringify(after)})${error ? `; ${error}` : ""}`);
  }
}

const lines = ["# Menu shortcut delivery (research §14.3)", "",
  "A trial saves when the title-bar menu button is labelled \"Edited\" before Cmd+S and no longer after it.", "",
  "| Method | Saved | Not saved | Error or setup failed |", "| --- | --- | --- | --- |"];
for (const method of methods) {
  const of = rows.filter(row => row.method === method.name);
  const count = (outcome: string) => of.filter(row => row.outcome === outcome).length;
  lines.push(`| ${method.name} | ${count("saved")} of ${of.length} | ${count("not saved")} of ${of.length} | ${of.length - count("saved") - count("not saved")} of ${of.length} |`);
}
writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
writeFileSync(join(out, "trials.json"), `${JSON.stringify(rows, null, 1)}\n`);
console.log(`\n${lines.join("\n")}\n\nOutput: ${out}`);
