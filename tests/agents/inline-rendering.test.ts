import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { renderAgentResult, renderMessageResult } from "../../extensions/secretary/agents/tools/rendering.ts";
import type { AgentRun } from "../../extensions/secretary/agents/records.ts";

initTheme("dark", false);
const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));
const presentation = { version: 1 as const, agentType: "general-purpose", name: "reviewer", model: "test/model", cwd: "/repo", workspaceLines: ["Isolation: none (parent working directory)."], promptPath: "/artifacts/prompt.txt", messagePath: "/artifacts/message.txt" };
const run = (overrides: Partial<AgentRun> = {}) => ({
  runId: "run_1", agentId: "agent_1", parentId: "p", launchKey: "k", prompt: "Inspect the fixture",
  description: "Inspect acceptance fixture", status: "running", background: false, createdAt: 0,
  startedAt: 1000, outputPath: "/output/agent_1.txt", output: "partial output", toolCount: 3, turnCount: 2,
  activity: "read", revision: 0, ...overrides, presentation,
} satisfies AgentRun & { presentation: typeof presentation });
const resultFor = (r: AgentRun) => ({ content: [{ type: "text" as const, text: `Agent: ${r.agentId}\nStatus: ${r.status}\nOutput: ${r.outputPath}\n\n${r.output}` }], details: r });
const full = { expanded: true, isPartial: false };

test("foreground body renders progress, statistics and expansion hint without a duplicate header or task", () => {
  const text = plain(renderAgentResult(resultFor(run()), { expanded: false, isPartial: true }, { now: () => 6500 }).render(100));
  assert.match(text, /^● running\n  ⎿  read\n  ⟳ 2 · 3 tools · 6s\n/);
  assert.match(text, /expand.*task details.*result/i);
  assert.doesNotMatch(text, /Agent ·|task:|foreground|Inspect acceptance fixture/);
});

test("compact completion uses C for zero counters and F for nonzero counters", () => {
  for (const [turnCount, toolCount, expected] of [[0, 0, "✓ succeeded"], [2, 3, "✓ succeeded · ⟳ 2 · 3 tools · 4s"]] as const) {
    const result = resultFor(run({ status: "succeeded", endedAt: 4600, turnCount, toolCount }));
    assert.equal(plain(renderAgentResult(result, { expanded: false, isPartial: false }).render(100)), expected);
    const expanded = plain(renderAgentResult(result, full).render(100));
    assert.match(expanded, /Agent ID: agent_1\nRun: run_1\nWorking directory: \/repo/);
    assert.match(expanded, /Prompt:\nInspect the fixture\nResult:\npartial output/);
  }
});

test("background compact launch has no body; expansion still exposes original content", () => {
  const result = resultFor(run({ status: "queued", background: true }));
  assert.equal(plain(renderAgentResult(result, { expanded: false, isPartial: false }).render(100)), "");
  assert.match(plain(renderAgentResult(result, full).render(100)), /Prompt:\nInspect the fixture/);
});

test("background errors remain visible and unstructured errors are not discarded", () => {
  const failed = resultFor(run({ status: "failed", background: true, error: "launch rejected" }));
  assert.match(plain(renderAgentResult(failed, { expanded: false, isPartial: false }, { isError: true }).render(100)), /failed|launch rejected/);
  const error = { content: [{ type: "text" as const, text: "Unknown destination" }] };
  assert.match(plain(renderAgentResult(error, full, { isError: true }).render(100)), /Unknown destination/);
});

for (const count of [199, 200, 201]) test(`each unbounded Agent field independently retains up to 200 lines (${count})`, () => {
  const prompt = Array.from({ length: count }, (_, i) => `prompt-${i}`).join("\n");
  const output = Array.from({ length: count }, (_, i) => `output-${i}`).join("\n");
  const lines = plain(renderAgentResult(resultFor(run({ prompt, output, status: "succeeded" })), full).render(100)).split("\n");
  assert.equal(lines.filter(line => /^prompt-\d+$/.test(line)).length, Math.min(count, 200));
  assert.equal(lines.filter(line => /^output-\d+$/.test(line)).length, Math.min(count, 200));
  for (const label of ["Prompt:", "Result:", "Run: run_1", "Partial: false"]) assert.ok(lines.includes(label), label);
  if (count > 200) {
    assert.match(lines.join("\n"), /\/artifacts\/prompt\.txt/);
    assert.match(lines.join("\n"), /full output: \/output\/agent_1\.txt/i);
    assert.ok(!lines.includes("prompt-200") && !lines.includes("output-200"));
  } else assert.doesNotMatch(lines.join("\n"), /omitted|full prompt:|full output:/i);
});

test("message full body uses actual multiline text and recorded acknowledgment, never summary or child output", () => {
  const details = { ...run(), presentation: { ...presentation, acknowledgment: "Resume accepted." as const } };
  const args = { to: "reviewer", message: "Check sessions.\nReport gaps.", summary: "not the message" };
  assert.equal(plain(renderMessageResult(resultFor(details), full, { args }).render(100)), "Message:\nCheck sessions.\nReport gaps.\nRun: run_1\nResume accepted.");
  assert.equal(plain(renderMessageResult(resultFor(details), { expanded: false, isPartial: false }, { args }).render(100)), "Message: Check sessions. Report gaps.");
});

for (const count of [199, 200, 201]) test(`sent message has its own 200-line allowance (${count})`, () => {
  const message = Array.from({ length: count }, (_, i) => `message-${i}`).join("\n");
  const details = { ...run(), presentation: { ...presentation, acknowledgment: "Message queued." as const } };
  const text = plain(renderMessageResult(resultFor(details), full, { args: { message } }).render(100));
  assert.equal(text.split("\n").filter(line => /^message-\d+$/.test(line)).length, Math.min(count, 200));
  assert.match(text, /Run: run_1\nMessage queued\.$/);
  if (count > 200) assert.match(text, /\/artifacts\/message\.txt/);
  else assert.doesNotMatch(text, /omitted|full message:/i);
});

test("legacy clipped prompt reports unavailable retention rather than inventing an artifact", () => {
  const details = { ...run({ prompt: "line\n".repeat(201) }), presentation: { ...presentation, promptPath: undefined } };
  const text = plain(renderAgentResult(resultFor(details), full).render(100));
  assert.match(text, /unavailable/i);
  assert.doesNotMatch(text, /\/artifacts\/prompt\.txt/);
});

test("wrapping is recomputed after resize, with labels outside the content budget", () => {
  const component = renderAgentResult(resultFor(run({ prompt: "x".repeat(5000), output: "answer" })), full);
  assert.doesNotMatch(plain(component.render(100)), /full prompt:/i);
  assert.match(plain(component.render(10)), /prompt/i);
  const narrow = plain(component.render(10));
  assert.equal(narrow.split("\n").filter(line => /^x+$/.test(line)).length, 200);
  assert.doesNotMatch(plain(component.render(100)), /full prompt:/i);
});

test("untrusted terminal commands are removed and Unicode rendering stays within terminal width", () => {
  const hostile = "界👩‍💻é\x1b[2J\x1b]52;c;c2VjcmV0\x07\r\x00safe";
  const component = renderAgentResult(resultFor(run({ prompt: hostile.repeat(20), output: hostile })), full);
  for (const width of [0, 1, 10, 60, 120]) {
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
      assert.doesNotMatch(line, /\x1b\[2J|\x1b\]52|\x00|\r/);
    }
  }
});
