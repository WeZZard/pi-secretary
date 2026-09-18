import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AsyncWidget, activeBackground, startAsyncWidgetPolling, widgetRenderKey } from "../../extensions/secretary/agents/ui/async-widget.ts";
import type { AgentRowView } from "../../extensions/secretary/agents/records.ts";

const row = (overrides: Partial<AgentRowView> = {}): AgentRowView => ({
  agentId: "agent_1", name: "reviewer", status: "running", description: "Review error handling",
  model: "test/model", startedAt: 1000, activity: "read", background: true,
  windowTokens: 3800, cumulativeTokens: 4250, ...overrides,
});

test("render-key deduplication: equal snapshots share a key, every state change alters it", () => {
  const a = widgetRenderKey([row()], false);
  assert.equal(widgetRenderKey([row()], false), a);
  assert.notEqual(widgetRenderKey([row({ status: "succeeded" })], false), a);
  assert.notEqual(widgetRenderKey([row({ activity: "bash" })], false), a);
  assert.notEqual(widgetRenderKey([row({ cumulativeTokens: 4251 })], false), a);
  assert.notEqual(widgetRenderKey([row()], true), a);
  assert.notEqual(widgetRenderKey([row(), row({ agentId: "agent_2" })], false), a);
});

test("polling skips unchanged idle state, repaints running rows, and disposes the timer", async () => {
  let repaints = 0, rows = [row({ status: "running" })], folded = false;
  let subscribed = 0;
  const polling = startAsyncWidgetPolling({
    intervalMs: 20, rows: () => rows, folded: () => folded,
    repaint: () => { repaints++; },
    subscribe: () => { subscribed++; return () => { subscribed--; }; },
  });
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.ok(repaints >= 2, "running rows advance elapsed time between service events");
  assert.ok(polling.renderKey());
  repaints = 0;
  rows = [row({ status: "succeeded" })]; // Not active background work: no repaint after the key change settles.
  await new Promise(resolve => setTimeout(resolve, 90));
  const settled = repaints;
  assert.ok(settled <= 2);
  repaints = 0;
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(repaints, 0, "an unchanged key with no running row never repaints");
  folded = true;
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.ok(repaints >= 1, "fold state is part of the render key");
  polling.dispose();
  assert.equal(subscribed, 0);
  repaints = 0;
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(repaints, 0, "the timer is disposed");
});

test("the async widget lists only active background executions with glyphs, activity, elapsed, and usage", () => {
  const rows = [
    row(),
    row({ agentId: "agent_2", name: "queued-worker", status: "queued", startedAt: undefined, activity: undefined, windowTokens: undefined, cumulativeTokens: undefined }),
    row({ agentId: "agent_3", name: "done", status: "succeeded" }),
    row({ agentId: "agent_4", name: "foreground", status: "running", background: false }),
  ];
  assert.deepEqual(activeBackground(rows).map(r => r.agentId), ["agent_1", "agent_2"]);
  const widget = new AsyncWidget({ rows: () => rows, now: () => 6500 });
  const lines = widget.render(80).join("\n");
  assert.match(lines, /Async agents/);
  assert.match(lines, /●.*reviewer/);
  assert.match(lines, /⎿ {2}read/);
  assert.match(lines, /6s · ↓ 3\.8k window · 4\.3k spent/);
  assert.match(lines, /◦.*queued-worker/);
  assert.match(lines, /queued…/);
  assert.doesNotMatch(lines, /done|foreground/);
  assert.ok(widget.render(0).length === 0);
});

test("the widget is removed when no active background work remains", () => {
  const widget = new AsyncWidget({ rows: () => [row({ status: "failed" })] });
  assert.deepEqual(widget.render(80), []);
});

test("expansion reveals live detail lines for running children", () => {
  let expanded = false;
  const widget = new AsyncWidget({ rows: () => [row()], expanded: () => expanded });
  assert.doesNotMatch(widget.render(100).join("\n"), /model test\/model/);
  expanded = true;
  assert.match(widget.render(100).join("\n"), /status running · model test\/model/);
});

test("clicking the header folds into a one-line summary; folding never changes execution", () => {
  const rows = [row(), row({ agentId: "agent_2" })];
  const widget = new AsyncWidget({ rows: () => rows });
  const clickHeader = { type: "click", button: "left", x: 1, y: 0, screenX: 1, screenY: 1, width: 80, height: 4, shift: false, alt: false, ctrl: false } as const;
  assert.equal(widget.handleMouse({ ...clickHeader, y: 1 })?.handled, undefined, "only the header row folds");
  assert.equal(widget.handleMouse({ ...clickHeader, shift: true })?.handled, undefined);
  assert.deepEqual(widget.handleMouse({ ...clickHeader })?.handled, true);
  const foldedLines = widget.render(80);
  assert.equal(foldedLines.length, 1);
  assert.match(foldedLines[0]!, /2 active/);
  assert.equal(widget.isFolded(), true);
  assert.deepEqual(widget.handleMouse({ ...clickHeader })?.handled, true);
  assert.ok(widget.render(80).length > 1);
  assert.equal(widget.isFolded(), false);
});

test("row rendering stays within the terminal width at several sizes", () => {
  const rows = [row({ name: "界".repeat(40), description: "界".repeat(40) }), row({ agentId: "agent_2", status: "queued", startedAt: undefined })];
  const widget = new AsyncWidget({ rows: () => rows });
  for (const width of [0, 1, 10, 36, 60, 120]) {
    for (const line of widget.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
  }
});

test("overflow rows are summarized rather than rendered", () => {
  const rows = Array.from({ length: 9 }, (_, i) => row({ agentId: `agent_${i}` }));
  const lines = new AsyncWidget({ rows: () => rows }).render(80);
  assert.match(lines.at(-1)!, /\+3 more active background executions/);
});
