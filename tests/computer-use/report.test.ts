import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunReport } from "../../extensions/secretary/computer-use/report.ts";

/** Plan phase 1.1: the run report joins each plan step to its relay screenshots (design §12.1). */

const write = async (path: string, value: unknown) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};

test("the report shows each step's intent, answers, input path and the relay screenshots of its own reads and action", async t => {
  const root = await mkdtemp(join(tmpdir(), "computer-use-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = join(root, "extension-state", "computer-use", "session-a");
  const relay = join(root, "relay-evidence", "relay-computer-use-1");
  await write(join(records, "runs", "run-1", "plan.json"), {
    recordedAt: "2026-09-26T08:00:00.000Z", runId: "run-1", outcome: "completed",
    plan: { goal: "Open <Agenda>", target: { app: "Finder", windowTitle: "Documents" }, steps: [
      { id: "open", intent: "Double-click Agenda.txt", action: "double_click", control: { name: "Agenda.txt" }, postcondition: { exists: { name: "Agenda" } } },
    ] },
    steps: [{ id: "open", result: "verified", action: "double_click", element: "Agenda.txt", evidence: ["cu-0001", "cu-0002", "cu-0003"], inputPaths: ["cgevent_hid"] }],
  });
  await write(join(records, "runs", "run-1", "step-open-1-1.json"), {
    recordedAt: "2026-09-26T08:00:01.000Z", runId: "run-1", stepId: "open", attempt: 1,
    answers: { region: { choice: "content", confidence: 0.98 }, element: { choice: "C", confidence: 0.91 } },
  });
  // A second child run on the same lease numbers its relay steps from the same client; its
  // identifiers must not pull in this run's screenshots.
  await write(join(relay, "trajectory.json"), { steps: [
    { id: "cu-0001", title: "run-1 open: initial · Read the Finder window", execution: "completed", snapshots: { before: "state/snapshots/a1-before.png", after: "state/snapshots/a1-after.png" } },
    { id: "cua.double_click-2", title: "cua.double_click", execution: "completed", because: "Secretary computer use: run-1 open: double_click \"Agenda.txt\" · Input with double_click (cu-0002)", snapshots: { before: "state/snapshots/a2-before.png", after: "state/snapshots/a2-after.png" } },
    { id: "cu-0003", title: "run-0 other: initial · Read the Finder window", execution: "completed", snapshots: { before: "state/snapshots/other.png" } },
  ] });

  const out = join(root, "report.html");
  const result = writeRunReport({ records: [records], relayPackages: [relay], out });
  const html = await readFile(out, "utf8");

  assert.deepEqual(result, { path: out, plans: 1, steps: 1, screenshots: 4 });
  assert.match(html, /Double-click Agenda\.txt/);
  assert.match(html, /Open &lt;Agenda&gt;/, "text from records is escaped");
  assert.match(html, /region: content \(0\.98\), element: C \(0\.91\)/);
  assert.match(html, /<th>Input path<\/th><td>cgevent_hid<\/td>/);
  assert.match(html, /src="relay-evidence\/relay-computer-use-1\/state\/snapshots\/a2-after\.png"/, "action screenshots link relative to the report");
  assert.match(html, /<code>cu-0002<\/code> run-1 open: double_click &quot;Agenda\.txt&quot;/);
  assert.doesNotMatch(html, /other\.png/, "another run's relay step is not joined");
  assert.match(html, /cu-0003: no relay step found/);
});
