import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { publicHarness } from "../acceptance/runtime-harness.ts";
import { formatAgentOutcome } from "../../extensions/secretary/agents/presentation.ts";
import type { AgentRun } from "../../extensions/secretary/agents/records.ts";

// Intentional target-layout tests, not snapshots generated from current output.
// UX §2.1.1 A–I and its compact/full policies define the expected layouts.
// See docs/testing/inline-tool-wireframes.md for scope and verification limits.
initTheme("dark", false);
const model = "acceptance-runtime/fixture";
const header = `Agent · general-purpose · auth-reviewer · ${model}`;
const messageHeader = "SendMessage · general-purpose · auth-reviewer";
const prompt = "Inspect authentication and identify its entry points.";
const output = "Found two authentication entry points.\nThe session middleware validates incoming credentials.";
const message = "Focus on session validation, then check whether expired credentials are rejected.\nReport any untested paths separately.";
const sentArgs = { to: "auth-reviewer", message, summary: "SUMMARY MUST NOT REPLACE MESSAGE" };

type ToolName = "Agent" | "SendMessage" | "TaskOutput" | "TaskStop";

async function fixture(t: TestContext, sentMessage = message) {
  const h = await publicHarness(t);
  await h.start();
  const args = { description: "Inspect authentication", prompt, subagent_type: "general-purpose", name: "auth-reviewer", model, run_in_background: true };
  const launched = await h.tool("Agent", args);
  const stream = await h.call();
  const guidance = await h.tool("SendMessage", { ...sentArgs, message: sentMessage });
  stream.finish(output);
  // Queued guidance causes another assistant turn in this same execution.
  (await h.call(1)).finish(output);
  const finished = await h.outcome(launched.details.runId);
  assert.equal(finished.details.status, "succeeded", "Fixture execution must settle before rendering completion cases");
  const agent = h.repository.getAgent(launched.details.agentId)!;
  assert.ok(agent, "The fixture has a real registered destination");

  // Preserve real launch identity, but freeze display-only values. Rendering does
  // not execute a child or alter runtime state. No external provider is contacted.
  const run: AgentRun = { ...finished.details, outputPath: "/output/agent_1.txt", background: false, startedAt: 1000, endedAt: 6500, turnCount: 2, toolCount: 3, activity: "read", output };
  const response = (patch: Partial<AgentRun> = {}) => {
    const details = { ...run, presentation: launched.details.presentation, ...patch };
    return { content: [{ type: "text" as const, text: formatAgentOutcome(details, agent) }], details, isError: false };
  };
  const normalize = (line: string) => stripVTControlCharacters(line)
    .replaceAll(run.outputPath, "/output/agent_1.txt")
    .replaceAll(run.agentId, "agent_1")
    .replaceAll(run.runId, "run_1")
    .replaceAll(h.root, "/repo");

  function render(name: ToolName, options: { expanded?: boolean; partial?: boolean; result?: typeof finished; args?: Record<string, unknown>; width?: number } = {}) {
    // Use Pi's real composition, not the unattached renderCall helper. This
    // catches missing tool registration hooks and duplicate host headers.
    const row = new ToolExecutionComponent(name, "wireframe-call", options.args ?? { ...args, run_in_background: false },
      { showImages: false }, h.tools.get(name), { requestRender() {} } as unknown as TUI, h.root);
    row.setArgsComplete();
    row.markExecutionStarted();
    if (options.result) row.updateResult(options.result, options.partial ?? false);
    row.setExpanded(options.expanded ?? false);
    const lines = row.render(options.width ?? 120).map(normalize).map(line => line.trimEnd());
    // Remove host padding only. Preserve indentation and interior blank lines.
    while (lines[0]?.trim() === "") lines.shift();
    while (lines.at(-1)?.trim() === "") lines.pop();
    return lines.map(line => line.startsWith(" ") ? line.slice(1) : line);
  }
  return { render, response, guidance, args, run, h, normalize };
}

test("the same registered host row updates its header on first result, toggles details, completes, and replays", async t => {
  const f = await fixture(t);
  t.mock.method(Date, "now", () => 6500);
  const row = new ToolExecutionComponent("Agent", "lifecycle-call", { ...f.args, run_in_background: false },
    { showImages: false }, f.h.tools.get("Agent"), { requestRender() {} } as unknown as TUI, f.h.root);
  row.setArgsComplete(); row.markExecutionStarted();
  const text = () => row.render(120).map(f.normalize).join("\n");
  assert.match(text(), /model pending/);
  assert.doesNotMatch(text(), /acceptance-runtime\/fixture/);
  row.updateResult(f.response({ status: "running", endedAt: undefined }), true);
  assert.match(text(), /Agent · general-purpose · auth-reviewer · acceptance-runtime\/fixture/);
  assert.equal((text().match(/Agent ·/g) ?? []).length, 1);
  assert.match(text(), /● running/);
  row.setExpanded(true);
  assert.match(text(), /Prompt:/); assert.match(text(), /Inspect authentication and identify its entry points\./);
  assert.match(text(), /Result:/);
  row.setExpanded(false);
  assert.doesNotMatch(text(), /Prompt:|Result:/);
  row.updateResult(f.response(), false);
  assert.match(text(), /✓ succeeded · ⟳ 2 · 3 tools · 6s/);
  assert.doesNotMatch(text(), /● running|model pending/);
  const replay = f.render("Agent", { result: f.response() });
  assert.ok(text().includes(replay[0]!)); assert.ok(text().includes(replay[1]!));
  row.updateResult({ content: [{ type: "text", text: "Fixture failure without details" }], isError: true }, false);
  assert.match(text(), /Agent · general-purpose · auth-reviewer · acceptance-runtime\/fixture/,
    "An unstructured error retains identity already observed on this same row");
  assert.match(text(), /Error: Fixture failure without details/);
  assert.doesNotMatch(text(), /✓ succeeded|model pending/);
});

test("registered Agent and SendMessage hooks keep unstructured rejection errors visible", async t => {
  const f = await fixture(t);
  for (const name of ["Agent", "SendMessage"] as const) {
    const args = name === "Agent" ? { ...f.args, run_in_background: false } : sentArgs;
    const row = new ToolExecutionComponent(name, `rejected-${name}`, args,
      { showImages: false }, f.h.tools.get(name), { requestRender() {} } as unknown as TUI, f.h.root);
    row.setArgsComplete(); row.markExecutionStarted();
    row.render(120);
    row.updateResult({ content: [{ type: "text", text: "Destination rejected: fixture failure" }], isError: true }, false);
    for (const expanded of [false, true]) {
      row.setExpanded(expanded);
      const text = row.render(120).map(f.normalize).join("\n");
      assert.match(text, /Destination rejected: fixture failure/);
      assert.doesNotMatch(text, /Message queued\.|Resume accepted\.|✓ succeeded/);
      assert.equal((text.match(new RegExp(`${name} ·`, "g")) ?? []).length, 1);
      if (name === "SendMessage") assert.match(text, /Focus on session validation/);
    }
  }
});

test("TaskStop retains the generic host header and result rather than Agent presentation", async t => {
  const f = await fixture(t);
  const lines = f.render("TaskStop", { args: { task_id: f.run.runId }, result: f.response({ status: "cancelled" }) });
  assert.equal(lines[0], "TaskStop");
  assert.ok(lines.includes("Status: cancelled"));
  assert.ok(!lines.some(line => line.startsWith("Agent ·")));
});

function same(actual: string[], expected: string[]) {
  assert.deepEqual(actual, expected, "The composed tool row must match the intentional wireframe; borders and host padding are not part of the layout contract");
}

test("WF-A: pending Agent does not mistake a requested model for a resolved model", async t => {
  const f = await fixture(t);
  same(f.render("Agent"), ["Agent · general-purpose · auth-reviewer · model pending"]);
});

test("WF-B: foreground progress keeps identity, activity, statistics, and expansion hint without task or mode rows", async t => {
  const f = await fixture(t);
  t.mock.method(Date, "now", () => 6500);
  const lines = f.render("Agent", { partial: true, result: f.response({ status: "running", endedAt: undefined }) });
  // The configured shortcut's spelling is host-dependent; the hint's semantic
  // position is fixed. The remaining lines are exact, including activity indent.
  assert.match(lines.at(-1) ?? "", /expand.*task details.*result/i);
  same(lines.slice(0, -1), [header, "● running", "  ⎿  read", "  ⟳ 2 · 3 tools · 6s"]);
});

test("WF-C: collapsed completion contains only the destination header and outcome", async t => {
  const f = await fixture(t);
  same(f.render("Agent", { result: f.response({ turnCount: 0, toolCount: 0 }) }), [header, "✓ succeeded"]);
});

test("WF-D: expanded completion shows metadata, original prompt, and result in order", async t => {
  const f = await fixture(t);
  same(f.render("Agent", { expanded: true, result: f.response() }), [
    header, "✓ succeeded", "Agent ID: agent_1", "Run: run_1", "Working directory: /repo",
    "Isolation: none (parent working directory).", "Output: /output/agent_1.txt", "Partial: false",
    "Prompt:", prompt, "Result:", ...output.split("\n"),
  ]);
});

test("WF-E: background launch is one header with a background suffix, not a completion card", async t => {
  const f = await fixture(t);
  same(f.render("Agent", { args: f.args, result: f.response({ background: true, status: "queued", endedAt: undefined, output: "" }) }),
    [`${header} · background`]);
});

test("WF-F: a compact completion with statistics uses the same identity and outcome hierarchy", async t => {
  const f = await fixture(t);
  same(f.render("Agent", { result: f.response() }), [header, "✓ succeeded · ⟳ 2 · 3 tools · 6s"]);
});

test("WF-G: legacy TaskOutput keeps its host header, metadata preview, and expansion notice", async t => {
  const f = await fixture(t);
  const lines = f.render("TaskOutput", { args: { task_id: f.run.runId, block: false }, result: f.response() });
  same(lines.slice(0, 11), ["TaskOutput", "Agent: agent_1", "Run: run_1", "Status: succeeded",
    "Description: Inspect authentication", `Model: ${model}`, "Working directory: /repo",
    "Isolation: none (parent working directory).", "Output: /output/agent_1.txt", "Partial: false", ""]);
  assert.match(lines[11] ?? "", /more lines,.*to expand/);
  assert.equal(lines.length, 12);
  assert.ok(!lines.includes(output.split("\n")[0]!), "Legacy collapsed preview does not show the answer");
});

test("WF-H: collapsed SendMessage shows destination and a single truncated actual-message preview", async t => {
  const f = await fixture(t);
  const lines = f.render("SendMessage", { args: sentArgs, result: f.guidance, width: 72 });
  assert.equal(lines[0], messageHeader);
  assert.equal(lines.length, 2, "The collapsed wireframe omits acknowledgment and execution metadata");
  assert.match(lines[1]!, /^Message: Focus on session validation, then check whether.*…$/u);
  const preview = lines[1]!.slice("Message: ".length, -1);
  assert.ok(message.replace(/\s+/g, " ").startsWith(preview), "Preview must be a prefix of the sent message, not its summary or child output");
  assert.doesNotMatch(lines.join("\n"), /SUMMARY MUST|Message queued|Run:|Model:/);
});

test("WF-I: expanded SendMessage replaces its preview with the whole message before run and acknowledgment", async t => {
  const f = await fixture(t);
  same(f.render("SendMessage", { args: sentArgs, expanded: true, result: f.guidance }), [
    messageHeader, "Message:", ...message.split("\n"), "Run: run_1", "Message queued.",
  ]);
});

test("WF-H/I: short messages remain complete and expansion preserves multiline message content", async t => {
  const args = { ...sentArgs, message: "Check sessions.\nReport gaps." };
  const f = await fixture(t, args.message);
  same(f.render("SendMessage", { args, result: f.guidance }), [messageHeader, "Message: Check sessions. Report gaps."]);
  same(f.render("SendMessage", { args, expanded: true, result: f.guidance }), [
    messageHeader, "Message:", "Check sessions.", "Report gaps.", "Run: run_1", "Message queued.",
  ]);
});
