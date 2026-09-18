import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { renderAgentResult, renderCall, taskLine } from "../../extensions/secretary/agents/tools/rendering.ts";
import type { AgentRun } from "../../extensions/secretary/agents/records.ts";

const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));
const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  runId: "run_1", agentId: "agent_1", parentId: "p", launchKey: "k", prompt: "Inspect the fixture",
  description: "Inspect acceptance fixture", status: "running", background: false, createdAt: 0,
  startedAt: 1000, outputPath: "/output/agent_1.txt", output: "partial output", toolCount: 3, turnCount: 2,
  activity: "read", revision: 0, ...overrides,
});
const resultFor = (r: AgentRun) => ({ content: [{ type: "text" as const, text: `Agent: ${r.agentId}\nStatus: ${r.status}\nOutput: ${r.outputPath}\n\n${r.output}` }], details: r });

test("rich mode renders the live card for a running foreground call", () => {
  const component = renderAgentResult(resultFor(run()), { expanded: false, isPartial: true }, { now: () => 6500 });
  const text = plain(component.render(80));
  assert.match(text, /●/);
  assert.match(text, /agent_1 · running/);
  assert.match(text, /task: Inspect acceptance fixture/);
  assert.match(text, /⎿ {2}read/);
  assert.match(text, /⟳ 2 · 3 tools · 6s/);
  assert.match(text, /expand for task details/);
});

test("rich mode renders a terminal result with expansion-sensitive detail", () => {
  const finished = run({ status: "succeeded", endedAt: 4600, output: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") });
  const result = resultFor(finished);
  const collapsed = plain(renderAgentResult(result, { expanded: false, isPartial: false }).render(80));
  assert.match(collapsed, /✓ Inspect acceptance fixture · succeeded/);
  assert.doesNotMatch(collapsed, /line 20/);
  const expanded = plain(renderAgentResult(result, { expanded: true, isPartial: false }).render(80));
  assert.match(expanded, /line 20/);
});

test("summary mode renders one static row per call and ignores expansion", () => {
  const finished = run({ status: "failed", endedAt: 4600, error: "boom" });
  const result = resultFor(finished);
  for (const expanded of [false, true]) {
    const lines = renderAgentResult(result, { expanded, isPartial: false }, { mode: "summary" }).render(100);
    assert.equal(lines.length, 1);
    assert.match(plain(lines), /✗ Inspect acceptance fixture · failed · ⟳ 2 · 3 tools · 4s · output: \/output\/agent_1\.txt/);
  }
  // Summary mode is static for running calls too.
  const live = renderAgentResult(resultFor(run()), { expanded: true, isPartial: true }, { mode: "summary", now: () => 6500 }).render(100);
  assert.equal(live.length, 1);
  assert.match(plain(live), /● Inspect acceptance fixture · running/);
});

test("background launch results render as terminal launch rows in both modes", () => {
  const launched = run({ status: "queued", background: true });
  const result = resultFor(launched);
  const rich = plain(renderAgentResult(result, { expanded: false, isPartial: false }).render(80));
  assert.match(rich, /◦ Inspect acceptance fixture · queued/);
  const summary = renderAgentResult(result, { expanded: false, isPartial: false }, { mode: "summary" }).render(80);
  assert.equal(summary.length, 1);
});

test("truncation markers point at the full-output artifact", () => {
  const big = run({ status: "succeeded", output: "x".repeat(60000) });
  const text = plain(renderAgentResult(resultFor(big), { expanded: true, isPartial: false }).render(80));
  assert.match(text, /full output: \/output\/agent_1\.txt/);
});

test("renderCall and task lines stay bounded at every width", () => {
  const call = renderCall({ subagent_type: "Explore", description: "界".repeat(60), run_in_background: true });
  for (const width of [0, 1, 10, 60, 120]) for (const line of call.render(width)) assert.ok(visibleWidth(line) <= width);
  assert.equal(taskLine(`  multi\n\nline   text `), "multi line text");
  assert.ok(taskLine("y".repeat(300)).length <= 120);
  for (const width of [0, 1, 20, 80]) {
    for (const mode of ["rich", "summary"] as const) {
      for (const line of renderAgentResult(resultFor(run()), { expanded: false, isPartial: true }, { mode }).render(width)) {
        assert.ok(visibleWidth(line) <= width, `mode ${mode} width ${width}`);
      }
    }
  }
});
