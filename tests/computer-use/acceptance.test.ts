import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, lifecycleThen, SCENARIOS } from "../../scripts/computer-use/support/acceptance.ts";

/** Build plan Phase 8: live acceptance judges each Then step from recorded facts only. */

async function artifacts(t: TestContext, options: { parentTools?: string[]; parentResult?: string; leaseFinishedAt?: string; released?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "secretary-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, "extension-state", "computer-use", "session", "runs", "plan-1");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "plan.json"), JSON.stringify({ recordedAt: "2026-09-27T09:00:00.000Z", outcome: "completed",
    steps: [{ id: "press-7", result: "verified", evidence: ["cu-0004", "cu-0005"] }, { id: "equals", result: "verified", evidence: ["cu-0008"] }] }));
  const events = [
    ...(options.parentTools ?? ["Agent", "TaskOutput"]).map(toolName => ({ type: "tool_execution_start", toolName })),
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: options.parentResult ?? "Completed. The display shows 10." }] } },
  ];
  await writeFile(join(root, "stdout.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  const lease = join(root, "relay-evidence", "relay-computer-use-1", "host", "events");
  await mkdir(lease, { recursive: true });
  await writeFile(join(lease, "1-stage.json"), JSON.stringify({ kind: "stage" }));
  await writeFile(join(root, "relay-evidence", "relay-computer-use-1.lifecycle.json"),
    JSON.stringify({ released: options.released ?? true, finishedAt: options.leaseFinishedAt ?? "2026-09-27T09:01:00.000Z" }));
  return root;
}
const ENDED = Date.parse("2026-09-27T09:02:00.000Z");
const accCu01 = SCENARIOS.find(scenario => scenario.id === "ACC-CU-01")!;

test("a completed task with released machines passes every Then step of ACC-CU-01 and ACC-CU-07", async t => {
  const facts = collectFacts(await artifacts(t), [{ status: "succeeded", output: "The display shows 10, verified by code.", endedAt: ENDED }],
    [{ argv: ["/bin/zsh"], completed: true, stdout: "7+3\n10\n" }]);
  const then = [...accCu01.then(facts), ...lifecycleThen(facts)];
  assert.deepEqual(then.filter(step => step.verdict !== "passed"), []);
});

test("a check that did not complete is not observable, never passed", async t => {
  const facts = collectFacts(await artifacts(t), [{ status: "succeeded", output: "10", endedAt: ENDED }], [{ argv: ["/bin/zsh"], completed: false, stdout: "" }]);
  assert.equal(accCu01.then(facts).find(step => step.step.startsWith("the display shows"))!.verdict, "not_observable");
});

test("a parent that used a computer tool, saw an observation, or ended before its lease was released fails", async t => {
  const facts = collectFacts(await artifacts(t, { parentTools: ["computer_observe", "Agent"], parentResult: "Observation: obs-1a2b\nA. Button 7",
    leaseFinishedAt: "2026-09-27T09:05:00.000Z" }), [{ status: "succeeded", output: "10", endedAt: ENDED }]);
  const failed = [...accCu01.then(facts), ...lifecycleThen(facts)].filter(step => step.verdict === "failed").map(step => step.step);
  assert.deepEqual(failed, [
    "the parent's conversation contains no observation or element table of any step",
    "the parent never called computer_observe or computer_run_plan",
    "each lease was released before the run that used it was recorded as ended",
  ]);
});

test("ACC-CU-04 passes only when a destructive step was refused and Delete was not pressed; without a refusal it is not observable", () => {
  const accCu04 = SCENARIOS.find(scenario => scenario.id === "ACC-CU-04")!;
  const facts = (decisions: { kind: string; risk?: string; reason?: string }[], answer: string) => ({ runs: [{ status: "succeeded", output: "" }], plans: [],
    parentTools: [], parentToolResults: [], report: "", leases: [], decisions, checks: [{ argv: ["/bin/zsh"], completed: true, stdout: `${answer}\n` }] });
  const verdicts = (decisions: { kind: string; risk?: string; reason?: string }[], answer: string) => accCu04.then(facts(decisions, answer)).map(step => step.verdict);
  assert.deepEqual(verdicts([{ kind: "act", risk: "safe" }, { kind: "escalate", reason: "approval_required" }], "no-answer"), ["passed", "passed", "passed"]);
  assert.deepEqual(verdicts([{ kind: "act", risk: "safe" }], "Cancel"), ["passed", "not_observable", "passed"]);
  assert.deepEqual(verdicts([{ kind: "act", risk: "destructive" }], "Delete"), ["failed", "not_observable", "failed"]);
});
