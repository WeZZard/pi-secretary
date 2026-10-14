import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewData as MachineData } from "@wezzard/mcp-vm-relay/review-data";
import { buildTrajectory, leasedPackages, type TrajectoryInput } from "../../extensions/secretary/vm-use/trajectory.ts";
import { Telemetry } from "../../extensions/secretary/vm-use/telemetry.ts";
import { renderReview, reviewModelOf } from "../../extensions/secretary/vm-use/viewer/page.ts";
import { TrajectoryServer } from "../../extensions/secretary/vm-use/viewer/server.ts";

/** The viewer's model is the agent's session, extended by the extension's records (decisions PS-D18 and PS-D40, design §12.3, ACC-VU-10, ACC-VU-19). */

const write = async (path: string, value: unknown) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
};
const lines = (values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const at = (clock: string) => `2026-09-29T${clock}.000Z`;

/**
 * A machine's review data as the relay derives it, with steps `[id, start, label]` that have snapshots.
 * The relay keeps the extension's identifier for a read, and names a tool call by its tool, with the
 * extension's identifier at the end of `because`.
 */
const machine = (name: string, steps: [string, string, string?][], execution = "completed"): MachineData => ({
  packageId: name, sessionId: "relay-session", taskId: "task", completeness: "complete", execution, findings: [],
  reasons: { snapshots: [], execution: execution === "failed" ? [{ text: "A step failed.", stepIds: [steps[0]![0]] }] : [], defects: [] },
  steps: steps.map(([id, , label]) => ({ id, title: id.startsWith("cua.") ? id.replace(/-\d+$/, "") : "Read the Notes window", execution: "completed", state: "recorded", inputMode: "cua",
    because: `Secretary vm-use: ${label ?? "Read the Notes window"} (${id.startsWith("cua.") ? `vu-${id.replace(/^.*-/, "").padStart(4, "0")}` : id})`,
    snapshots: { before: `state/snapshots/${id}-before.png`, after: `state/snapshots/${id}-after.png` } })),
  details: Object.fromEntries(steps.map(([id, start]) => [id, { at: at(start), beforeAt: at(start), afterAt: at(start).replace(".000Z", ".800Z") }])),
  outputs: [], files: [{ path: "manifest.json", bytes: 10 }],
});

const toolCall = (clock: string, id: string, name: string, args: Record<string, unknown>) =>
  ({ type: "message", timestamp: at(clock), message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
const toolResult = (clock: string, id: string, name: string, text: string, details: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ type: "message", timestamp: at(clock), message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], details, ...extra } });

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "vm-use-trajectory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, "relay-evidence"), session = join(root, "session.jsonl"), state = join(root, "vm-use", "session");
  await write(session, lines([
    { type: "session", id: "session-1", timestamp: at("10:00:00") },
    { type: "model_change", provider: "litellm", modelId: "qwen" },
    { type: "message", timestamp: at("10:00:01"), message: { role: "user", content: [{ type: "text", text: "Open <Notes> and add a note" }] } },
    { type: "message", timestamp: at("10:00:02"), message: { role: "assistant", content: [{ type: "thinking", thinking: "Look first." }, { type: "text", text: "I'll observe first." }, { type: "toolCall", id: "call-1", name: "vm_observe", arguments: { app: "Notes" } }] } },
    { ...toolResult("10:01:00", "call-1", "vm_observe", "Observation: obs-1", { observationId: "obs-1", status: "ready", recordPath: "/elsewhere/observations/obs-1.json" }),
      message: { role: "toolResult", toolCallId: "call-1", toolName: "vm_observe", content: [{ type: "text", text: "Observation: obs-1" }, { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") }],
        details: { observationId: "obs-1", status: "ready", recordPath: "/elsewhere/observations/obs-1.json" } } },
    toolCall("10:01:05", "call-2", "vm_run_plan", { goal: "New note" }),
    toolResult("10:08:00", "call-2", "vm_run_plan", "Outcome: escalated.", { outcome: "escalated", runId: "run-1", observationId: "run-1-002" }),
    { type: "message", timestamp: at("10:08:10"), message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
    { type: "message", timestamp: at("10:10:00"), message: { role: "user", content: "Please continue" } },
    // A session recorded before results named their run: the plan is found by its goal.
    toolCall("10:10:01", "call-3", "vm_run_plan", { goal: "Title it" }),
    toolResult("10:11:00", "call-3", "vm_run_plan", "Outcome: completed.", { outcome: "completed" }),
    toolCall("10:11:10", "call-4", "vm_run_plan", { goal: "Lost" }),
    toolResult("10:11:20", "call-4", "vm_run_plan", "Outcome: completed.", { outcome: "completed", runId: "run-gone" }),
    toolCall("10:11:30", "call-5", "vm_run_plan", { goal: "Bad" }),
    toolResult("10:11:31", "call-5", "vm_run_plan", "Rejected.", { outcome: "rejected", rule: "unknown_app" }, { isError: true }),
    { type: "message", timestamp: at("10:12:00"), message: { role: "assistant", content: [{ type: "text", text: "All done." }] } },
  ]));
  const machines: Record<string, MachineData> = {
    "relay-vm-use-aaaa0001": machine("relay-vm-use-aaaa0001", [["vu-0001", "10:00:40"], ["cua.click-2", "10:01:11", "run-1 new_note: click"],
      ["vu-0003", "10:07:50", "run-1 after"], ["vu-0004", "10:09:00", "check"]], "failed"),
    "relay-vm-use-bbbb0002": machine("relay-vm-use-bbbb0002", [["cua.type_text-1", "10:10:20", "run-2 title: type"]]),
    // Another agent's machine, which started after this session ended.
    "relay-vm-use-cccc0003": machine("relay-vm-use-cccc0003", [["vu-0001", "10:20:00"]]),
  };
  for (const name of Object.keys(machines)) await write(join(evidence, name, "state", "snapshots", "vu-0001-before.png"), "png");
  await write(join(root, "outside.txt"), "secret");
  const review = async (dir: string) => { const data = machines[dir.split("/").at(-1)!]; if (!data) throw new Error("no package"); return data; };

  // The extension's records (telemetry.ts), with times inside the session.
  const lease = (name: string, clock: string) => write(join(state, "leases", `${name}.json`), { schema: "secretary.vm-use.lease/1", recordedAt: at(clock), package: name });
  await lease("relay-vm-use-aaaa0001", "10:00:30");
  await lease("relay-vm-use-bbbb0002", "10:09:30");
  await write(join(state, "observations", "obs-1.json"), { recordedAt: at("10:00:59"), status: "ready", window: { app: "Notes", title: "Notes" }, readMs: 900, groups: [{ elements: [1, 2] }, { elements: [3] }], evidence: ["vu-0001"] });
  await write(join(state, "observations", "run-1-002.json"), { recordedAt: at("10:07:59"), status: "ready", window: { app: "Notes", title: "Notes" }, groups: [], evidence: ["vu-0003"] });
  const run = (runId: string, name: string, value: unknown) => write(join(state, "runs", runId, name), value);
  await run("run-1", "plan.json", { runId: "run-1", outcome: "escalated", recordedAt: at("10:07:55"), plan: { goal: "New note", steps: [
    { id: "new_note", intent: "Make a <new> note.", action: "click", ui_element: { name: "New Note" } }, { id: "confirm", intent: "Commit it.", action: "key", keys: "return" }, { id: "save", intent: "Save.", action: "key", keys: "cmd+s" }] },
    steps: [{ id: "new_note", result: "acted", evidence: ["vu-0002"] }, { id: "confirm", result: "stopped", detail: "approval_required: key return needs a person's approval", evidence: [] }, { id: "save", result: "not_run" }] });
  await run("run-1", "step-new_note-1-1.json", { recordedAt: at("10:01:09"), stepId: "new_note", attempt: 1, roundTripMs: 400, answers: { region: { choice: "outline 1", confidence: 0.99 } }, decision: { kind: "act", operation: "click", element: "New Note" } });
  await run("run-1", "permission-new_note-1-1.json", { recordedAt: at("10:01:10"), stepId: "new_note", attempt: 1, judgment: { verdict: "proceed", requests: [{ purpose: "with_text", answers: { effect: { choice: "change", confidence: 1 } }, roundTripMs: 200 }] } });
  await run("run-1", "step-confirm-1-2.json", { recordedAt: at("10:01:20"), stepId: "confirm", attempt: 1, roundTripMs: 300, answers: {}, decision: { kind: "act", operation: "key", group: "outline 2" } });
  await run("run-1", "permission-confirm-1-2.json", { recordedAt: at("10:06:21"), stepId: "confirm", attempt: 1, approval: { answer: "timeout", ms: 300000 },
    judgment: { verdict: "ask", reason: "guardian", requests: [{ purpose: "with_text", answers: { reach: { choice: "local", confidence: 1 } }, roundTripMs: 600 }, { purpose: "without_text", answers: { reach: { choice: "outside", confidence: 1 } }, roundTripMs: 1000 }] } });
  await run("run-2", "plan.json", { runId: "run-2", outcome: "completed", recordedAt: at("10:10:50"), plan: { goal: "Title it", steps: [{ id: "title", intent: "Type the title.", action: "type", text: "<5 characters>" }] },
    steps: [{ id: "title", result: "acted", evidence: ["vu-0001"] }] });
  // The same goal, written after the session: not the call's plan.
  await run("run-3", "plan.json", { runId: "run-3", outcome: "failed", recordedAt: at("10:30:00"), plan: { goal: "Title it", steps: [{ id: "other" }] }, steps: [{ id: "other", result: "acted" }] });
  return { root, evidence, session, state, review };
}

const outline = (data: Awaited<ReturnType<typeof buildTrajectory>>["data"]) => {
  const byId = new Map(data.steps.map(step => [step.id, step]));
  const name = (step: (typeof data.steps)[number]) => step.plan ? step.plan.stepId : step.agent!.name;
  return data.steps.map(step => step.agent ? `${step.agent.kind}: ${step.agent.kind === "call" ? step.agent.name : step.agent.text}`
    : step.plan ? ` plan ${step.plan.stepId} (${step.execution}) ← ${name(byId.get(step.cause!)!)}`
    : `  ${step.id} ← ${step.cause ? name(byId.get(step.cause)!) : "none"}`);
};

test("the trajectory is the session, with each call's plan steps and the machine steps they ran before its result", async t => {
  const { evidence, session, state, review } = await fixture(t);
  const trajectory = await buildTrajectory({ session, evidence, state, agentId: "agent-1", review });
  assert.deepEqual([...trajectory.packages.keys()], ["relay-vm-use-aaaa0001", "relay-vm-use-bbbb0002"], "the lease records name the machines");
  assert.deepEqual(outline(trajectory.data), [
    "prompt: Open <Notes> and add a note",
    "thinking: Look first.",
    "agent: I'll observe first.",
    "call: vm_observe",
    "  aaaa0001-vu-0001 ← vm_observe",
    "result: Observation: obs-1",
    "call: vm_run_plan",
    " plan new_note (completed) ← vm_run_plan",
    "  aaaa0001-cua.click-2 ← new_note",
    " plan confirm (stopped) ← vm_run_plan",
    " plan save (not run) ← vm_run_plan",
    "  aaaa0001-vu-0003 ← vm_run_plan",
    "result: Outcome: escalated.",
    "agent: Done.",
    "prompt: Please continue",
    "call: vm_run_plan",
    " plan title (completed) ← vm_run_plan",
    "  bbbb0002-cua.type_text-1 ← title",
    "result: Outcome: completed.",
    "call: vm_run_plan",
    "result: Outcome: completed.",
    "call: vm_run_plan",
    "result: Rejected.",
    "agent: All done.",
  ]);
  const { agent } = trajectory.data;
  assert.deepEqual({ model: agent.model, runs: agent.runs, by: agent.machinesBy }, { model: "litellm/qwen", runs: 2, by: "lease" });
  assert.deepEqual(agent.machines.map(m => [m.name, m.unasked]), [["relay-vm-use-aaaa0001", 1], ["relay-vm-use-bbbb0002", 0]], "the check after the run is counted, not shown");
  assert.equal(trajectory.data.execution, "failed", "the worst machine decides the verdict");
  assert.deepEqual(trajectory.data.reasons.execution[0]!.stepIds, ["aaaa0001-vu-0001"], "a reason names the step by its prefixed identifier");
  const step = trajectory.data.steps.find(s => s.id === "aaaa0001-vu-0001")!;
  assert.equal(step.snapshots!.before, "relay-vm-use-aaaa0001/state/snapshots/vu-0001-before.png", "a machine's pictures are under its package");
  const result = trajectory.data.steps.find(s => s.agent?.kind === "result" && s.agent.image)!;
  assert.equal(result.agent!.image, ".session/1.png");
  assert.equal(trajectory.images[0]!.data, Buffer.from("png").toString("base64"));
  assert.equal(trajectory.data.steps.find(s => s.agent?.text === "Rejected.")!.execution, "failed", "an error result is a failed step");
});

/** The names that runs recorded before the rename to vm-use used (decision PS-D48). */
const earlier = (text: string) => text.replaceAll("vm_observe", "computer_observe").replaceAll("vm_run_plan", "computer_run_plan")
  .replaceAll("relay-vm-use-", "relay-computer-use-").replaceAll("Secretary vm-use: ", "Secretary computer use: ").replace(/\bvu-(?=\d{4})/g, "cu-");

test("a run recorded before the rename to vm-use reads as one recorded after it, with its own names (decision PS-D48)", async t => {
  const now = await fixture(t);
  const expected = outline((await buildTrajectory({ session: now.session, evidence: now.evidence, state: now.state, agentId: "agent-1", review: now.review })).data).map(earlier);
  const { root, evidence, session, state, review } = await fixture(t);
  const rewrite = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await rewrite(path);
      else if (/\.jsonl?$/.test(entry.name)) await writeFile(path, earlier(await readFile(path, "utf8")));
      if (entry.name !== earlier(entry.name)) await rename(join(dir, entry.name), join(dir, earlier(entry.name)));
    }
  };
  await rewrite(root);
  const before = async (dir: string) => JSON.parse(earlier(JSON.stringify(await review(dir.replace("relay-computer-use-", "relay-vm-use-"))))) as MachineData;
  const trajectory = await buildTrajectory({ session, evidence, state, agentId: "agent-1", review: before });
  assert.deepEqual([...trajectory.packages.keys()], ["relay-computer-use-aaaa0001", "relay-computer-use-bbbb0002"]);
  assert.deepEqual(outline(trajectory.data), expected);
  const byTime = await buildTrajectory({ session, evidence, review: before });
  assert.deepEqual(byTime.data.agent.machines.map(m => m.name), ["relay-computer-use-aaaa0001", "relay-computer-use-bbbb0002"], "without records, machines are found by their names and times");
});

test("each call names its record: by run, by goal, missing, or an observation", async t => {
  const { evidence, session, state, review } = await fixture(t);
  const { data } = await buildTrajectory({ session, evidence, state, review });
  const calls = data.steps.filter(s => s.agent?.kind === "call").map(s => s.agent!.record);
  assert.deepEqual(calls, [
    { kind: "observation", found: true, observation: { id: "obs-1", status: "ready", app: "Notes", window: "Notes", elements: 3, readMs: 900 } },
    { kind: "plan", found: true, runId: "run-1", outcome: "escalated", by: "run" },
    { kind: "plan", found: true, runId: "run-2", outcome: "completed", by: "goal" },
    { kind: "plan", found: false },
    undefined,
  ], "a goal finds only the plan written while its call ran, and a rejected plan has no record");
});

test("in a run before PS-D53, a plan step carries the grounder, the guardian and the approval wait, and its time includes the wait", async t => {
  const { evidence, session, state, review } = await fixture(t);
  const { data } = await buildTrajectory({ session, evidence, state, review });
  const confirm = data.steps.find(s => s.plan?.stepId === "confirm")!;
  assert.equal(confirm.id, "plan-run-1-confirm");
  assert.equal(confirm.title, "confirm · key return");
  assert.deepEqual(confirm.plan!.decisions, [{ attempt: 1, at: at("10:01:20"), roundTripMs: 300, answers: {}, decision: "key in outline 2" }]);
  assert.deepEqual(confirm.plan!.judgements[0]!.approval, { answer: "timeout", ms: 300000 });
  assert.equal(confirm.plan!.judgements[0]!.verdict, "ask");
  // From the grounder's request to the last judgement, after the end of the machine step before it (PS-D44).
  assert.deepEqual(data.details[confirm.id], { at: "2026-09-29T10:01:19.700Z", endAt: at("10:06:21"),
    lead: { ms: 7900, from: "aaaa0001-cua.click-2", edge: "end" } });
  const save = data.steps.find(s => s.plan?.stepId === "save")!;
  assert.deepEqual({ decisions: save.plan!.decisions, judgements: save.plan!.judgements, details: data.details[save.id] }, { decisions: [], judgements: [], details: {} }, "a step that did not run is still an item");
  const newNote = data.steps.find(s => s.plan?.stepId === "new_note")!;
  assert.equal(data.details[newNote.id]!.endAt, "2026-09-29T10:01:11.800Z", "a step ends with its last machine step");
});

test("a checked plan shows the plan check on its call, with the approval wait, and each plan step shows its answers (ACC-VU-19, PS-D53)", async t => {
  const { evidence, session, state, review } = await fixture(t);
  const run = (name: string, value: unknown) => write(join(state, "runs", "run-2", name), value);
  await run("plan.json", { runId: "run-2", outcome: "completed", recordedAt: at("10:10:50"), permissionCheck: "online", plan: { goal: "Title it", steps: [{ id: "title", intent: "Type the title.", action: "type", text: "<5 characters>" }] },
    steps: [{ id: "title", result: "acted", evidence: ["vu-0001"] }] });
  await run("permission-1.json", { schema: "secretary.vm-use.plan-check/1", recordedAt: at("10:10:15"), approval: { answer: "approved", ms: 4000 },
    check: { roundTripMs: 1200, state: { steps: [{ id: "title", intent: "Type the title.", text: "<5 characters>" }] },
      steps: [{ id: "title", reach: "outside_guest", requested: "no", needsApproval: true, why: "outside_guest" }] } });
  const { data } = await buildTrajectory({ session, evidence, state, review });
  const call = data.steps.filter(s => s.agent?.kind === "call")[2]!;
  assert.deepEqual(call.agent!.record, { kind: "plan", found: true, runId: "run-2", outcome: "completed", by: "goal",
    check: { mode: "online", roundTripMs: 1200, marked: [{ id: "title", why: "outside_guest" }], approval: { answer: "approved", ms: 4000 } } });
  const title = data.steps.find(s => s.plan?.stepId === "title")!;
  assert.deepEqual(title.plan!.check, { reach: "outside_guest", requested: "no", needsApproval: true, why: "outside_guest" });
  assert.deepEqual(title.plan!.judgements, []);
  const page = renderReview(reviewModelOf(data)).html;
  assert.match(page, /<dt>Plan check<\/dt><dd>1 step needs approval<\/dd><dd class="ms">1\.2 s<\/dd>/);
  assert.match(page, /<dt>Approval<\/dt><dd>approved<\/dd><dd class="ms">4\.0 s<\/dd>/);
  assert.match(page, /<li><code>title<\/code> · its effect leaves the guest<\/li>[^]*?<p>Approval: <b>approved<\/b> after 4\.0 s<\/p>/);
  const step = /<article id="step-plan-run-2-title"[^]*?<\/article>/.exec(page)![0];
  assert.match(step, /<dt>Plan check<\/dt><dd>outside guest · not requested · needs approval: its effect leaves the guest<\/dd>/);
  assert.doesNotMatch(step, /Guardian/);

  const none = await fixture(t);
  await write(join(none.state, "runs", "run-2", "plan.json"), { runId: "run-2", outcome: "completed", recordedAt: at("10:10:50"), permissionCheck: "none", permissionCheckSource: "request",
    plan: { goal: "Title it", steps: [{ id: "title", intent: "Type the title." }] }, steps: [{ id: "title", result: "acted", evidence: ["vu-0001"] }] });
  const unchecked = await buildTrajectory({ session: none.session, evidence: none.evidence, state: none.state, review: none.review });
  const record = unchecked.data.steps.filter(s => s.agent?.kind === "call")[2]!.agent!.record;
  assert.deepEqual(record?.kind === "plan" ? record.check : undefined, { mode: "none", source: "request", marked: [] });
  const uncheckedPage = renderReview(reviewModelOf(unchecked.data)).html;
  assert.match(uncheckedPage, /<dt>Plan check<\/dt><dd>not checked · mode none, from the request<\/dd>/, "Decision PS-D54: the page says who chose the mode");
  assert.match(uncheckedPage, /<p>Mode <code>none<\/code>, from the request: the plan was not checked\.<\/p>/);
});

test("without the extension's records, the trajectory is the session alone", async t => {
  const { evidence, session, review } = await fixture(t);
  const { data } = await buildTrajectory({ session, evidence, review });
  assert.equal(data.agent.machinesBy, "time");
  assert.deepEqual(data.agent.machines.map(m => m.name), ["relay-vm-use-aaaa0001", "relay-vm-use-bbbb0002"], "a machine that started after the session is not this agent's");
  assert.equal(data.steps.filter(s => s.machine || s.plan).length, 0, "no record names a machine step");
  assert.deepEqual(data.agent.machines.map(m => m.unasked), [4, 1]);
  assert.deepEqual(data.reasons.execution[0]!.stepIds, [], "a reason names only steps that are items");
});

test("lease records choose the session's machines, and a leased machine without evidence is named", async t => {
  const { root, evidence, session, review } = await fixture(t);
  const state = join(root, "vm-use", "other");
  assert.equal(leasedPackages(state), undefined);
  const telemetry = new Telemetry(state);
  await telemetry.recordLease({ package: "relay-vm-use-cccc0003" });
  await telemetry.recordLease({ package: "relay-vm-use-dddd0004" });
  assert.deepEqual(leasedPackages(state), ["relay-vm-use-cccc0003", "relay-vm-use-dddd0004"]);
  const trajectory = await buildTrajectory({ session, evidence, state, review });
  assert.equal(trajectory.data.agent.machinesBy, "lease");
  assert.deepEqual(trajectory.data.agent.machines.map(m => [m.name, m.found]), [["relay-vm-use-cccc0003", true], ["relay-vm-use-dddd0004", false]]);
  assert.equal(trajectory.data.completeness, "missing", "a missing machine keeps the verdict from reading complete");
});

test("the page shows plan steps with their phases, each machine step's cause, and the unasked count, escaped", async t => {
  const { evidence, session, state, review } = await fixture(t);
  const { data } = await buildTrajectory({ session, evidence, state, agentId: "agent-1", review });
  const page = renderReview(reviewModelOf(data));
  assert.equal(page.title, "vm-use: agent-1");
  assert.match(page.html, /Open &lt;Notes&gt; and add a note/);
  assert.doesNotMatch(page.html, /<Notes>|<new>/);
  assert.match(page.html, /Prompt from the spawn/);
  assert.match(page.html, /Message from the parent/);
  assert.match(page.html, /<li><b>24<\/b> <span>steps<\/span><\/li><li><b>16<\/b> <span>agent<\/span><\/li><li><b>4<\/b> <span>plan<\/span><\/li><li><b>4<\/b> <span>machine<\/span><\/li>/);
  // A run before PS-D53: the wait is on the plan step, with the guardian's verdict and the answer.
  const confirm = /<article id="step-plan-run-1-confirm"[^]*?<\/article>/.exec(page.html)![0];
  assert.match(confirm, /<dt>Guardian<\/dt><dd>ask · guardian<\/dd><dd class="ms">1\.0 s<\/dd>/, "the guardian takes as long as its slowest request");
  assert.match(confirm, /<dt>Approval<\/dt><dd>timed out<\/dd><dd class="ms">5 min 0 s<\/dd>/);
  assert.match(confirm, /<dt>Input<\/dt><dd>nothing was sent · the approval timed out<\/dd>/);
  assert.match(confirm, /<h2 class="sname" title="confirm · key return"><span class="d">10<\/span><span class="nm"><span class="h">confirm · key return<\/span><span class="took"[^>]*>5 min 1 s<\/span><\/span><span class="place host" title="Done by the agent in the host"><span class="pl">Host<\/span><svg[^]*?<\/svg><\/span><\/h2>/, "the monitor's heading: the step pill, the name and its time, where");
  // ACC-VU-13: where each step happened and its number above, its status, name and time below, and the interval pills.
  const track = /<footer class="track"[^]*?<\/footer>/.exec(page.html)![0];
  assert.match(track, /<li class="s warn k-plan err"><span class="tline"><span class="d">10<\/span><span class="place host" title="Done by the agent in the host"><span class="pl">Host<\/span><svg[^]*?<\/svg><\/span><\/span><div class="faces">[^]*?<\/div><span class="cap"><i class="dot" aria-hidden="true"><\/i><span class="t" title="confirm · key return">confirm · key return<\/span><span class="took"[^>]*>5 min 1 s<\/span><\/span>/, "a plan step is done in the host; its caption's time includes the wait (ACC-VU-12)");
  assert.match(track, /<span class="tline"><span class="d">09<\/span><span class="place guest" title="Ran in the virtual machine relay-vm-use-aaaa0001"><span class="pl">VM<\/span><svg[^]*?<\/svg><\/span>/, "a machine step ran in the guest");
  assert.match(track, /5 min 1 s<\/span><\/span><span class="sr">stopped<\/span><\/li><li class="gap" aria-hidden="true"><\/li><li class="s warn k-plan err">[^]*?save · key cmd\+s<\/span><\/span><span class="sr">not run<\/span><\/li><li class="gap" aria-hidden="true"><span class="iv" title="From the end of step 10 to the start of step 12">1 min 29 s<\/span><\/li>/,
    "the pill before the after-read measures from the waiting step's end, 6 min 30 s start to start less its 5 min 1 s, and the step that never ran has none (PS-D43, PS-D44)");
  assert.match(track, /new_note[^<]*<\/span><span class="took"[^>]*>3\.2 s<\/span><\/span><span class="sr">[^<]*<\/span><\/li><li class="gap" aria-hidden="true"><span class="iv" title="From the start of step 08 to the start of step 09">2\.4 s<\/span><\/li><li class="s [^"]*"><span class="tline"><span class="d">09<\/span>/,
    "a machine step inside its plan step measures from the plan step's start (PS-D44)");
  assert.match(track, /<span class="t" title="vm_run_plan \{ &quot;goal&quot;: &quot;New note&quot; \}">[^<]*<\/span><span class="took" title="Time from the call to its result">6 min 55 s<\/span>/, "a tool call lasts until its result (PS-D44)");
  assert.match(track, /<li class="gap" aria-hidden="true"><span class="iv" title="From the start of step 07 to the start of step 08">3\.6 s<\/span><\/li>/, "a call's first plan step measures from the call's start (PS-D44)");
  assert.equal(track.match(/<li class="s /g)!.length, 24, "every step is in the track once");
  assert.equal(track.match(/<li class="gap"/g)!.length, 23, "a gap between every two steps");
  assert.match(page.html, /<dt>Input<\/dt><dd>nothing was sent · the plan stopped before this step<\/dd>/);
  assert.match(page.html, /<dt>Input<\/dt><dd>sent · 1 machine step<\/dd>/);
  assert.match(page.html, /<h3>Asked for by<\/h3><p><a href="#step-plan-run-1-new_note">Step <span class="d">08<\/span><\/a> · Plan step <code>new_note<\/code>/, "a machine step links to its plan step");
  assert.match(page.html, /<h3>Asked for by<\/h3><p><a href="#step-agent-4">Step <span class="d">04<\/span><\/a> · Tool call <code>vm_observe<\/code>/, "a read links to its call");
  assert.match(page.html, /No plan record was found for this call\./);
  assert.match(page.html, /Found by the call's goal/);
  assert.match(page.html, /<dt>UI elements<\/dt><dd>3<\/dd>/, "an observe call shows its observation");
  assert.match(page.html, /1 not asked for by the agent/);
  assert.match(page.html, /src="\.session\/1\.png"/, "a result shows the screenshot the agent received");
  assert.match(page.html, /id="lightbox-plan-run-1-confirm--plan"/, "a plan step can be enlarged");
  assert.ok(page.html.indexOf('id="step-agent-6"') < page.html.indexOf('id="step-plan-run-1-new_note"') && page.html.indexOf('id="step-plan-run-1-save"') < page.html.indexOf('id="step-agent-7"'), "plan steps sit between the call and its result");
});

/** A PNG header of a `width` × `height` picture: enough for the trajectory to read the snapshot's size. */
const png = (width: number, height: number) => {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8); header.write("IHDR", 12, "latin1"); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
  return header;
};
/** The review data with the command and the driver's answer the relay recorded for some machine steps. */
const withCommands = (review: (dir: string) => Promise<MachineData>, commands: Record<string, { tool: string; args: Record<string, unknown>; stdout?: string }>) => async (dir: string) => {
  const data = structuredClone(await review(dir));
  for (const [id, command] of Object.entries(commands)) if (data.details[id])
    Object.assign(data.details[id]!, { argv: ["node", "mcp-host.mjs", "call", "mcp", "cua", command.tool, JSON.stringify(command.args)], output: { exit: 0, stdout: command.stdout ?? "" } });
  return data;
};

test("a machine step that clicked carries its pointer, and the page draws its button's marker (ACC-VU-29, PS-D60)", async t => {
  const { evidence, session, state, review } = await fixture(t);
  await writeFile(join(evidence, "relay-vm-use-aaaa0001", "state", "snapshots", "cua.click-2-before.png"), png(2000, 1000));
  const commands = withCommands(review, {
    "cua.click-2": { tool: "right_click", args: { x: 500, y: 250, scope: "desktop", modifier: ["cmd"] }, stdout: "Right-clicked at screen-point (250, 125)." },
    "cua.type_text-1": { tool: "type_text", args: { pid: 856, text: "Hi" } },
  });
  const { data } = await buildTrajectory({ session, evidence, state, agentId: "agent-1", review: commands });
  const detail = (id: string) => (data as unknown as { details: Record<string, { pointer?: unknown }> }).details[id];
  assert.deepEqual(detail("aaaa0001-cua.click-2")!.pointer, { kind: "click", tool: "right_click", button: "right", count: 1, modifiers: ["cmd"], source: "command",
    points: { x: 250, y: 125 }, point: { x: 500, y: 250, fx: 0.25, fy: 0.25 } }, "the snapshot's size places the point");
  assert.equal(detail("bbbb0002-cua.type_text-1")!.pointer, undefined, "typing is not a click");
  assert.equal(detail("aaaa0001-vu-0001")!.pointer, undefined, "a read has no command");

  const page = renderReview(reviewModelOf(data)).html;
  const monitor = /<article id="step-aaaa0001-cua\.click-2"[^]*?<\/article>/.exec(page)![0];
  assert.match(monitor, /<svg class="marks m-right before" aria-hidden="true">[^]*?<text class="tag"[^>]*>⌘ R<\/text>/, "an orange R ring with its modifier on the before snapshot");
  assert.match(monitor, /<svg class="marks m-right after"/, "an outline on the after snapshot");
  assert.match(monitor, /<h3>Pointer<\/h3><p><i class="swatch m-right"[^>]*><\/i>Right click with ⌘<br>\(250, 125\) points<br>pixel \(500, 250\)<br>given by the command<\/p>/);
  assert.match(monitor, /<label class="mswitch" for="show-marks"/, "the chin's switch");
  assert.match(page, /<input type="checkbox" id="show-marks" class="mstate" checked hidden>/);
  assert.match(page, /<kbd>M<\/kbd><span>Markers<\/span>/, "the key is listed");
  assert.match(page, /<svg class="marks spot m-right"/, "the thumbnail's dot");
});

test("a UI element's frame comes from the window read before the step, and a click it cannot place says why (ACC-VU-30, PS-D60)", async t => {
  const { evidence, session, state, review } = await fixture(t);
  await writeFile(join(evidence, "relay-vm-use-aaaa0001", "state", "snapshots", "cua.click-2-before.png"), png(2000, 1000));
  // The read before the click, of window 60, recorded the display scale (design §12.3, Pointer).
  await write(join(state, "observations", "obs-1.json"), { recordedAt: at("10:00:59"), status: "ready", window: { app: "Notes", title: "Notes", pid: 856, windowId: 60 }, readMs: 900, desktopScale: 2,
    groups: [{ elements: [1, 2] }, { elements: [3] }], evidence: ["vu-0001"], tree: [{ element_index: 4, role: "AXButton", label: "New Note", frame: { x: 100, y: 50, w: 30, h: 20 } }] });
  const commands = withCommands(review, {
    "cua.click-2": { tool: "click", args: { pid: 856, window_id: 60, element_index: 4 }, stdout: "Pressed [4] AXButton." },
    "cua.type_text-1": { tool: "click", args: { pid: 856, window_id: 60, x: 10, y: 10 } },
  });
  const { data } = await buildTrajectory({ session, evidence, state, agentId: "agent-1", review: commands });
  const detail = (id: string) => (data as unknown as { details: Record<string, { pointer?: unknown }> }).details[id];
  assert.deepEqual(detail("aaaa0001-cua.click-2")!.pointer, { kind: "element", tool: "click", action: "press", source: "element",
    frame: { x: 200, y: 100, w: 60, h: 40, fx: 0.1, fy: 0.1, fw: 0.03, fh: 0.04, role: "AXButton", name: "New Note" } });
  assert.deepEqual(detail("bbbb0002-cua.type_text-1")!.pointer, { kind: "unplaced", tool: "click", button: "left", count: 1,
    reason: "The command gave a point in the window's own screenshot, whose place on the display was not recorded." });

  const page = renderReview(reviewModelOf(data)).html;
  assert.match(page, /<svg class="marks m-ax before" aria-hidden="true"><rect class="halo" x="10%" y="10%" width="3%" height="4%"[^]*?>AX press<\/text>/, "a dashed box with its action");
  const unplaced = /<article id="step-bbbb0002-cua\.type_text-1"[^]*?<\/article>/.exec(page)![0];
  assert.match(unplaced, /<h3>Pointer<\/h3><p>Left click<br>Position not recorded<br>The command gave a point in the window&#39;s own screenshot/);
  assert.doesNotMatch(unplaced, /class="marks/, "no marker where the position is not known");
});

const get = (port: number, path: string, host = `127.0.0.1:${port}`) => new Promise<{ status: number; type: string; body: string }>((done, fail) => {
  request({ host: "127.0.0.1", port, path, headers: { host } }, response => {
    let body = "";
    response.setEncoding("utf8").on("data", chunk => body += chunk).on("end", () => done({ status: response.statusCode!, type: String(response.headers["content-type"]), body }));
  }).on("error", fail).end();
});

test("the server serves the app, the agent's model and pictures, and only its machines' files", async t => {
  const { evidence, session, state, review } = await fixture(t);
  const server = new TrajectoryServer();
  t.after(() => server.close());
  const input: TrajectoryInput = { session, evidence, state, agentId: "agent-1", review };
  const address = await server.add("agent-1", input);
  const port = Number(new URL(address).port);
  assert.equal(new URL(address).pathname, "/agent-1/");
  const shell = await get(port, "/agent-1/");
  assert.match(shell.body, /<script type="module" src="\/\.app\/main\.ts">/);
  const app = await get(port, "/.app/main.ts");
  assert.match(app.type, /^text\/javascript/);
  assert.doesNotMatch(app.body, /as ReviewData/, "the module is served without its types");
  assert.equal((await get(port, "/.app/trajectory.ts")).status, 404, "only the app's own modules are served");
  const model = JSON.parse((await get(port, "/.api/agent-1.json")).body) as { steps: unknown[] };
  assert.equal(model.steps.length, 24);
  assert.equal((await get(port, "/agent-1/.session/1.png")).body, "png");
  assert.equal((await get(port, "/agent-1/relay-vm-use-aaaa0001/state/snapshots/vu-0001-before.png")).body, "png");
  assert.equal((await get(port, "/agent-1/relay-vm-use-cccc0003/state/snapshots/vu-0001-before.png")).status, 404, "another agent's machine is not served");
  assert.equal((await get(port, "/agent-1/relay-vm-use-aaaa0001/..%2F..%2Foutside.txt")).status, 404);
  assert.equal((await get(port, "/agent-1/", "evil.example")).status, 421, "a rebound name is refused");
});

test("the server builds the model when the page asks for it, shares a running build, and serves pictures from the last build", async t => {
  const { evidence, session, state, review } = await fixture(t);
  let builds = 0;
  // A build here is fast; the wait keeps it running while the other requests arrive.
  const server = new TrajectoryServer(0, async input => { builds++; await new Promise(r => setTimeout(r, 200)); return buildTrajectory(input); });
  t.after(() => server.close());
  const port = Number(new URL(await server.add("agent-1", { session, evidence, state, agentId: "agent-1", review })).port);
  await Promise.all([get(port, "/.api/agent-1.json"), get(port, "/.api/agent-1.json"), get(port, "/.api/agent-1.json")]);
  assert.equal(builds, 1, "requests during a build share it");
  const pictures = await Promise.all(Array.from({ length: 5 }, () => get(port, "/agent-1/relay-vm-use-aaaa0001/state/snapshots/vu-0001-before.png")));
  assert.deepEqual(pictures.map(p => p.body), Array(5).fill("png"));
  assert.equal(builds, 1, "pictures come from the last build");
  await get(port, "/.api/agent-1.json");
  assert.equal(builds, 2, "a reload builds the model again");
});
