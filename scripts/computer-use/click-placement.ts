/**
 * Fix plan F-2: why did a click into a covered TextEdit document not move the insertion point?
 * Each trial resets the document, proves the insertion point is at the start, clicks the text
 * area's center with one method, types one letter, and reads where the letter landed.
 *
 *   CUA_DRIVER=… node --experimental-strip-types scripts/computer-use/click-placement.ts [trials-per-method]
 *
 * Methods:
 * - background: one pixel click posted to the process, window left covered (the setup of research §10.2).
 * - background-twice: two such clicks, to test whether the first click is only an activation click.
 * - foreground-delivery: the driver briefly brings the window forward for the click, then restores.
 * - bring-to-front: the window is brought forward and left there, then one background click.
 *
 * Setup resets the text with real keys: Cmd+A with foreground delivery, then "aaaa", then Cmd+Up
 * and "y". The foreground state is read before each click: whether TextEdit is active, and which
 * windows are drawn over the click point. Output goes to a new test-results directory.
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
const out = resolve("test-results/computer-use", `click-placement-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });

const textArea = (read: WindowRead) => {
  const found = read.elements.find(element => element.role === "AXTextArea" && element.frame);
  if (!found) throw new Error("the TextEdit window has no text area");
  return found;
};
const coverWithSafari = async () => { execFileSync("/usr/bin/open", ["-a", "Safari"]); await wait(1500); };

type Method = "background" | "background-twice" | "foreground-delivery" | "bring-to-front";
const methods: Method[] = ["background", "background-twice", "foreground-delivery", "bring-to-front"];
const rows: Record<string, unknown>[] = [];

for (const method of methods) {
  for (let trial = 1; trial <= trials; trial++) {
    await coverWithSafari();
    let read = await backend.readWindow(target, { screenshot: false });
    // Cmd+A is a menu shortcut; it did nothing with background delivery (first run, 2026-09-23).
    await backend.act(read.window, { kind: "key", key: "a", modifiers: ["cmd"], delivery: "foreground" });
    for (const letter of "aaaa") await backend.act(read.window, { kind: "key", key: letter, modifiers: [] });
    await backend.act(read.window, { kind: "key", key: "up", modifiers: ["cmd"] });
    await backend.act(read.window, { kind: "key", key: "y", modifiers: [] });
    await wait(300);
    read = await backend.readWindow(target, { screenshot: false });
    const start = textArea(read).value ?? "";
    const frame = textArea(read).frame!;
    const point = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
    if (method === "bring-to-front") { await backend.bringToFront(read.window); await wait(800); }
    const before = await backend.foreground(read.window, point);
    const click = { kind: "click" as const, point, button: "left" as const, count: 1 as const };
    if (method === "foreground-delivery") await backend.act(read.window, { ...click, delivery: "foreground" });
    else await backend.act(read.window, { ...click, delivery: "background" });
    if (method === "background-twice") { await wait(300); await backend.act(read.window, { ...click, delivery: "background" }); }
    await wait(300);
    await backend.act(read.window, { kind: "key", key: "z", modifiers: [] });
    await wait(500);
    read = await backend.readWindow(target, { screenshot: false });
    const value = textArea(read).value ?? "";
    const after = await backend.foreground(read.window, point);
    const placement = start !== "yaaaa" ? "setup failed" : value === "yaaaaz" ? "end (click moved it)" : value === "yzaaaa" ? "start (click did not move it)" : "other";
    rows.push({ method, trial, start, value, placement, activeBefore: before.active, coveredBefore: before.coveredBy, activeAfter: after.active, coveredAfter: after.coveredBy });
    console.log(`${method} #${trial}: ${placement}; start ${JSON.stringify(start)}, value ${JSON.stringify(value)}; before click active=${before.active} covered by ${before.coveredBy.join(", ") || "nothing"}`);
  }
}

const lines = ["# Click placement (fix plan F-2)", "",
  "A trial passes when the letter typed after the click lands at the end, which is where a click below the text puts the insertion point.", "",
  "| Method | Moved to the end | Did not move | Other or setup failed |", "| --- | --- | --- | --- |"];
for (const method of methods) {
  const of = rows.filter(row => row.method === method);
  const count = (prefix: string) => of.filter(row => String(row.placement).startsWith(prefix)).length;
  lines.push(`| ${method} | ${count("end")} of ${of.length} | ${count("start")} of ${of.length} | ${of.length - count("end") - count("start")} of ${of.length} |`);
}
writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
writeFileSync(join(out, "trials.json"), `${JSON.stringify(rows, null, 1)}\n`);
console.log(`\n${lines.join("\n")}\n\nOutput: ${out}`);
