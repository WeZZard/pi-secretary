import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewData as MachineData } from "@wezzard/mcp-vm-relay/review-data";
import { buildTrajectory, leasedPackages, type TrajectoryInput } from "../../extensions/secretary/computer-use/trajectory.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";
import { renderReview, reviewModelOf } from "../../extensions/secretary/computer-use/viewer/page.ts";
import { TrajectoryServer } from "../../extensions/secretary/computer-use/viewer/server.ts";

/** Plan phase 1: the moved viewer shows the agent's session joined with its machines' evidence (decision PS-D18, design §12.3, ACC-CU-10). */

const write = async (path: string, value: unknown) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
};
const lines = (values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const at = (clock: string) => `2026-09-29T${clock}.000Z`;

/** A machine's review data as the relay derives it, with steps `[id, start]` that have snapshots. */
const machine = (name: string, steps: [string, string][], execution = "completed"): MachineData => ({
  packageId: name, sessionId: "relay-session", taskId: "task", completeness: "complete", execution, findings: [],
  reasons: { snapshots: [], execution: execution === "failed" ? [{ text: "A step failed.", stepIds: [steps[0]![0]] }] : [], defects: [] },
  steps: steps.map(([id]) => ({ id, title: `cua.click ${id}`, execution: "completed", state: "recorded", inputMode: "cua",
    snapshots: { before: `state/snapshots/${id}-before.png`, after: `state/snapshots/${id}-after.png` } })),
  details: Object.fromEntries(steps.map(([id, start]) => [id, { at: at(start) }])),
  outputs: [], files: [{ path: "manifest.json", bytes: 10 }],
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "computer-use-trajectory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, "relay-evidence"), session = join(root, "session.jsonl");
  await write(session, lines([
    { type: "session", id: "session-1", timestamp: at("10:00:00") },
    { type: "model_change", provider: "litellm", modelId: "qwen" },
    { type: "message", timestamp: at("10:00:01"), message: { role: "user", content: [{ type: "text", text: "Open <Notes> and add a note" }] } },
    { type: "message", timestamp: at("10:00:02"), message: { role: "assistant", content: [{ type: "thinking", thinking: "Look first." }, { type: "text", text: "I'll observe first." }, { type: "toolCall", id: "call-1", name: "computer_observe", arguments: { app: "Notes" } }] } },
    { type: "message", timestamp: at("10:01:00"), message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "Observation: obs-1" }, { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") }] } },
    { type: "message", timestamp: at("10:01:05"), message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "computer_run_plan", arguments: { goal: "New note" } }] } },
    { type: "message", timestamp: at("10:01:30"), message: { role: "toolResult", toolCallId: "call-2", isError: true, content: [{ type: "text", text: "Outcome: failed." }] } },
    { type: "message", timestamp: at("10:01:40"), message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
    { type: "message", timestamp: at("10:05:00"), message: { role: "user", content: "Please continue" } },
    { type: "message", timestamp: at("10:05:01"), message: { role: "assistant", content: [{ type: "toolCall", id: "call-3", name: "computer_observe", arguments: { app: "Notes" } }] } },
    { type: "message", timestamp: at("10:06:00"), message: { role: "toolResult", toolCallId: "call-3", content: [{ type: "text", text: "Observation: obs-2" }] } },
    { type: "message", timestamp: at("10:06:10"), message: { role: "assistant", content: [{ type: "text", text: "All done." }] } },
  ]));
  const machines: Record<string, MachineData> = {
    // The first machine: its last step, a check, comes after the run's last message.
    "relay-computer-use-aaaa0001": machine("relay-computer-use-aaaa0001", [["cu-0001", "10:00:30"], ["cu-0002", "10:01:10"], ["cu-0003", "10:02:00"]], "failed"),
    "relay-computer-use-bbbb0002": machine("relay-computer-use-bbbb0002", [["cu-0001", "10:05:30"]]),
    // Another agent's machine, which started after this session ended.
    "relay-computer-use-cccc0003": machine("relay-computer-use-cccc0003", [["cu-0001", "10:20:00"]]),
  };
  for (const name of Object.keys(machines)) await write(join(evidence, name, "state", "snapshots", "cu-0001-before.png"), "png");
  await write(join(root, "outside.txt"), "secret");
  const review = async (dir: string) => { const data = machines[dir.split("/").at(-1)!]; if (!data) throw new Error("no package"); return data; };
  return { root, evidence, session, review };
}

const outline = (data: Awaited<ReturnType<typeof buildTrajectory>>["data"]) => {
  const byId = new Map(data.steps.map(step => [step.id, step]));
  const page = reviewModelOf(data);
  return [...page.steps].sort((a, b) => Date.parse(page.details.get(a.id)!.at!) - Date.parse(page.details.get(b.id)!.at!) || data.steps.indexOf(a) - data.steps.indexOf(b))
    .map(step => step.agent ? `${step.agent.kind}: ${step.agent.kind === "call" ? step.agent.name : step.agent.text}`
      : `  ${step.id} ← ${step.cause ? byId.get(step.cause)!.agent!.name : "none"}`);
};

test("the trajectory joins each machine step to the call that caused it, between the agent's messages", async t => {
  const { evidence, session, review } = await fixture(t);
  const trajectory = await buildTrajectory({ session, evidence, agentId: "agent-1", review });
  assert.deepEqual([...trajectory.packages.keys()], ["relay-computer-use-aaaa0001", "relay-computer-use-bbbb0002"], "a machine that started after the session is not this agent's");
  assert.deepEqual(outline(trajectory.data), [
    "prompt: Open <Notes> and add a note",
    "thinking: Look first.",
    "agent: I'll observe first.",
    "call: computer_observe",
    "  aaaa0001-cu-0001 ← computer_observe",
    "result: Observation: obs-1",
    "call: computer_run_plan",
    "  aaaa0001-cu-0002 ← computer_run_plan",
    "result: Outcome: failed.",
    "agent: Done.",
    "  aaaa0001-cu-0003 ← none",
    "prompt: Please continue",
    "call: computer_observe",
    "  bbbb0002-cu-0001 ← computer_observe",
    "result: Observation: obs-2",
    "agent: All done.",
  ]);
  const { agent } = trajectory.data;
  assert.deepEqual({ model: agent.model, runs: agent.runs, by: agent.machinesBy }, { model: "litellm/qwen", runs: 2, by: "time" });
  assert.equal(trajectory.data.execution, "failed", "the worst machine decides the verdict");
  assert.deepEqual(trajectory.data.reasons.execution[0]!.stepIds, ["aaaa0001-cu-0001"], "a reason names the step by its joined identifier");
  const step = trajectory.data.steps.find(s => s.id === "aaaa0001-cu-0001")!;
  assert.equal(step.snapshots!.before, "relay-computer-use-aaaa0001/state/snapshots/cu-0001-before.png", "a machine's pictures are under its package");
  const result = trajectory.data.steps.find(s => s.agent?.kind === "result" && s.agent.image)!;
  assert.equal(result.agent!.image, ".session/1.png");
  assert.equal(trajectory.images[0]!.data, Buffer.from("png").toString("base64"));
  assert.equal(trajectory.data.steps.find(s => s.agent?.text === "Outcome: failed.")!.execution, "failed", "an error result is a failed step");
});

test("lease records choose the session's machines, and a leased machine without evidence is named", async t => {
  const { root, evidence, session, review } = await fixture(t);
  const state = join(root, "computer-use", "session");
  assert.equal(leasedPackages(state), undefined, "without a lease record the viewer chooses by time");
  const telemetry = new Telemetry(state);
  await telemetry.recordLease({ package: "relay-computer-use-cccc0003" });
  await telemetry.recordLease({ package: "relay-computer-use-dddd0004" });
  const packages = leasedPackages(state)!;
  assert.deepEqual(packages, ["relay-computer-use-cccc0003", "relay-computer-use-dddd0004"]);
  const trajectory = await buildTrajectory({ session, evidence, packages, review });
  assert.equal(trajectory.data.agent.machinesBy, "lease");
  assert.deepEqual(trajectory.data.agent.machines.map(m => [m.name, m.found]), [["relay-computer-use-cccc0003", true], ["relay-computer-use-dddd0004", false]]);
  assert.equal(trajectory.data.completeness, "missing", "a missing machine keeps the verdict from reading complete");
  assert.equal(trajectory.data.steps.find(s => s.machine)!.cause, undefined, "a step outside every call has no cause");
});

test("the page shows the agent's steps and each machine step's cause, escaped", async t => {
  const { evidence, session, review } = await fixture(t);
  const { data } = await buildTrajectory({ session, evidence, agentId: "agent-1", review });
  const page = renderReview(reviewModelOf(data));
  assert.equal(page.title, "Computer use: agent-1");
  assert.match(page.html, /Open &lt;Notes&gt; and add a note/);
  assert.doesNotMatch(page.html, /<Notes>/);
  assert.match(page.html, /Prompt from the spawn/);
  assert.match(page.html, /Message from the parent/);
  assert.match(page.html, /<h3>Asked for by<\/h3><p><a href="#step-agent-4">Step <span class="d">04<\/span><\/a> · Tool call <code>computer_observe<\/code>/, "a machine step links to its call");
  assert.match(page.html, /No tool call asked for this step\./);
  assert.match(page.html, /<h3>Machine steps<\/h3><p class="steps"><a href="#step-aaaa0001-cu-0001">/, "a call lists the machine steps it caused");
  assert.match(page.html, /src="\.session\/1\.png"/, "a result shows the screenshot the agent received");
  assert.match(page.html, /id="lightbox-agent-1--agent"/, "an agent step can be enlarged");
  assert.match(page.html, /No evidence was found|relay-computer-use-aaaa0001/);
});

const get = (port: number, path: string, host = `127.0.0.1:${port}`) => new Promise<{ status: number; type: string; body: string }>((done, fail) => {
  request({ host: "127.0.0.1", port, path, headers: { host } }, response => {
    let body = "";
    response.setEncoding("utf8").on("data", chunk => body += chunk).on("end", () => done({ status: response.statusCode!, type: String(response.headers["content-type"]), body }));
  }).on("error", fail).end();
});

test("the server serves the app, the agent's model and pictures, and only its machines' files", async t => {
  const { evidence, session, review } = await fixture(t);
  const server = new TrajectoryServer();
  t.after(() => server.close());
  const input: TrajectoryInput = { session, evidence, agentId: "agent-1", review };
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
  assert.equal(model.steps.length, 16);
  assert.equal((await get(port, "/agent-1/.session/1.png")).body, "png");
  assert.equal((await get(port, "/agent-1/relay-computer-use-aaaa0001/state/snapshots/cu-0001-before.png")).body, "png");
  assert.equal((await get(port, "/agent-1/relay-computer-use-cccc0003/state/snapshots/cu-0001-before.png")).status, 404, "another agent's machine is not served");
  assert.equal((await get(port, "/agent-1/relay-computer-use-aaaa0001/..%2F..%2Foutside.txt")).status, 404);
  assert.equal((await get(port, "/agent-1/", "evil.example")).status, 421, "a rebound name is refused");
});
