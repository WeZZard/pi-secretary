import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FleetView, indicatorRenderKey, indicatorRows, startFleetPolling } from "../../extensions/secretary/agents/ui/fleet-view.ts";
import { transition } from "../../extensions/secretary/agents/ui/reducer.ts";
import { initialState, type UiState } from "../../extensions/secretary/agents/ui/state.ts";
import type { AgentRowView, AgentSnapshot } from "../../extensions/secretary/agents/records.ts";

type Status = NonNullable<AgentSnapshot["run"]>["status"];
function snapshot(id = "a", status: Status = "running"): AgentSnapshot {
  return { agent: { agentId: id, parentId: "p", definition: { name: "general-purpose", description: "test", prompt: "test", source: "packaged", hash: "hash", resumable: true }, model: "provider/model", tools: [], cwd: "/tmp", configCwd: "/tmp", sessionPath: "/tmp/session", resumable: true, createdAt: 0 }, run: { agentId: id, parentId: "p", runId: `${id}-run`, launchKey: id, prompt: "task", description: `${id} task`, status, background: true, createdAt: 0, startedAt: 1000, outputPath: "/tmp/output", output: "", toolCount: 0, turnCount: 0, revision: 0 } };
}
const vm = (id: string, overrides: Partial<AgentRowView> = {}): AgentRowView => ({
  agentId: id, status: "running", description: `${id} task`, model: "provider/model", startedAt: 1000, background: true, ...overrides,
});
/** Activate with the editor focused by default; pass focus: "fleet" to select the first row. */
function fleet(snapshots: AgentSnapshot[], rows: AgentRowView[] = [], now = 6500, focus: "editor" | "fleet" = "fleet"): { state: () => UiState; view: FleetView } {
  let state = transition(initialState(), { type: "activate", parentId: "p", epoch: "e", viewId: "v" }, snapshots).state;
  if (focus === "fleet") state = transition(state, { type: "fleet", downAtLastLine: true }).state;
  return { state: () => state, view: new FleetView(() => state, { rows: () => rows, now: () => now }) };
}

test("the indicator renders nothing while no agent is active", () => {
  const { view } = fleet([], [], 6500, "editor");
  assert.deepEqual(view.render(80), []);
  const { view: focused } = fleet([], []);
  assert.deepEqual(focused.render(80), [], "list focus alone cannot make the hidden indicator appear");
});

test("agent rows show the selection circle, name, status label, and right-aligned stats", () => {
  const { view } = fleet([snapshot("a", "running")], [vm("a", { name: "reviewer", windowTokens: 3800, cumulativeTokens: 4250 })]);
  const lines = view.render(100);
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /^● main$/, "entry into the indicator selects the first row");
  assert.match(lines[2]!, /○ reviewer · running/);
  assert.ok(/6s · ↓ 3\.8k window · 4\.3k spent$/.test(lines[2]!), "elapsed and usage stay right-aligned at the row end");
});

test("the circle encodes selection only and only while the indicator has focus", () => {
  const focused = fleet([snapshot("a")], [vm("a", { name: "reviewer" })]);
  assert.match(focused.view.render(80)[1]!, /^● main$/, "the first row is selected on entry");
  const moved = transition(focused.state(), { type: "fleet-select", agentId: "a" }).state;
  const lines = new FleetView(() => moved, { rows: () => [vm("a", { name: "reviewer" })], now: () => 6500 }).render(80);
  assert.match(lines[1]!, /^○ main$/);
  assert.match(lines[2]!, /^● reviewer/);
  const unfocused = fleet([snapshot("a")], [vm("a", { name: "reviewer" })], 6500, "editor");
  for (const line of unfocused.view.render(80)) assert.doesNotMatch(line, /^●/, "an unfocused indicator fills no circle");
});

test("the editor hint names the action Down will take", () => {
  const { state, view } = fleet([snapshot("a")], [vm("a")], 6500, "editor");
  assert.equal(view.render(80)[0], "↓ to focus a subagent · Ctrl+X stop all", "an unconditional reader reports the last-line action");
  const above = new FleetView(state, { rows: () => [vm("a")], now: () => 6500, downFocuses: () => false });
  assert.equal(above.render(80)[0], "↓ to move down · Ctrl+X stop all", "a caret above the last line is not advertised as focusing the fleet");
  const onList = new FleetView(() => transition(state(), { type: "fleet", downAtLastLine: true }).state, { rows: () => [vm("a")], now: () => 6500, downFocuses: () => true });
  assert.equal(onList.render(80)[0], "X stop selected · Ctrl+X stop all", "list focus keeps the cancellation hint regardless of the caret");
});

test("a row leaves the indicator immediately when its run reaches a terminal status", () => {
  const { view } = fleet([snapshot("a", "succeeded"), snapshot("b", "running")], [vm("a", { status: "succeeded", name: "done" }), vm("b", { name: "active" })]);
  const text = view.render(100);
  assert.equal(text.length, 3, "main, non-terminal agent, and cancellation hint");
  assert.match(text[2]!, /active · running/);
  assert.doesNotMatch(text.join("\n"), /done|succeeded/);
});

test("nested rows never appear in the indicator; they belong to overlay drill levels (SA-12)", () => {
  const nested = vm("child", { parentAgentId: "a", name: "nested" });
  assert.deepEqual(indicatorRows([vm("a"), nested]).map(r => r.agentId), ["a"]);
  const { view } = fleet([snapshot("a")], [vm("a", { name: "top" }), nested]);
  assert.equal(view.render(80).length, 3);
  assert.doesNotMatch(view.render(80).join("\n"), /nested/);
});

test("unknown usage is never displayed as zero", () => {
  const { view } = fleet([snapshot("a", "running")], [vm("a")]);
  const text = view.render(100).join("\n");
  assert.doesNotMatch(text, /0 window|0 spent|\b0 tokens\b/);
});

test("right-aligned information realigns across widths and stays in bounds", () => {
  const { view } = fleet([snapshot("a", "running"), snapshot("b", "queued")], [vm("a", { name: "reviewer", windowTokens: 2000, cumulativeTokens: 999 }), vm("b", { name: "queuer", status: "queued", startedAt: undefined })], 61000);
  for (const width of [0, 1, 20, 40, 58, 100, 160]) {
    const lines = view.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: [${line}]`);
    if (width >= 100) {
      const agentRow = lines.find(line => line.includes("reviewer"));
      assert.ok(agentRow && /60s · ↓ 2\.0k window · 999 spent$/.test(agentRow), "elapsed and usage stay right-aligned at the row end");
      assert.equal(visibleWidth(agentRow!), width);
    } else if (width >= 60) {
      const agentRow = lines.find(line => line.includes("reviewer"));
      assert.ok(agentRow && /60s/.test(agentRow), "elapsed time remains visible before right-side truncation");
    }
  }
});

test("wide CJK names truncate by display width within bounds", () => {
  const { view } = fleet([snapshot("a", "running")], [vm("a", { name: "界".repeat(30), windowTokens: 2000, cumulativeTokens: 999 })], 61000, "editor");
  for (const width of [20, 40, 60, 100]) {
    const lines = view.render(width);
    if (width >= 60) assert.ok(lines.some(line => line.includes("界")), "the agent row remains visible");
    assert.equal(lines[1]!, "○ main");
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: [${line}]`);
  }
});

test("rows render without a published view model using snapshot fields only", () => {
  const { view } = fleet([snapshot("a", "running")]);
  const text = view.render(100).join("\n");
  assert.match(text, /○ a · running/);
  assert.doesNotMatch(text, /window|spent/);
});

test("long lists window around the selection", () => {
  const snapshots = Array.from({ length: 15 }, (_, i) => snapshot(`a${i}`));
  const rows = snapshots.map(s => vm(s.agent.agentId));
  let state = transition(initialState(), { type: "activate", parentId: "p", epoch: "e", viewId: "v" }, snapshots).state;
  state = transition(state, { type: "fleet", downAtLastLine: true }).state;
  state = transition(state, { type: "fleet-select", agentId: "a14" }).state;
  const lines = new FleetView(() => state, { rows: () => rows, now: () => 6500 }).render(80);
  assert.ok(lines.length <= 11, "the visible window has at most ten rows plus its hint");
  assert.ok(lines.some(line => line.includes("a14")), "the selected row stays visible");
  assert.match(lines.find(line => line.includes("a14"))!, /^●/);
});

test("render-key deduplication: equal snapshots share a key, every rendered change alters it", () => {
  const a = indicatorRenderKey([vm("a")], null);
  assert.equal(indicatorRenderKey([vm("a")], null), a);
  assert.notEqual(indicatorRenderKey([vm("a", { status: "queued" })], null), a);
  assert.notEqual(indicatorRenderKey([vm("a", { cumulativeTokens: 4251 })], null), a);
  assert.notEqual(indicatorRenderKey([vm("a")], "a"), a, "selection is part of the key");
  assert.notEqual(indicatorRenderKey([vm("a"), vm("b")], null), a);
  // Terminal rows are not rendered; their departure from the key reflects immediate removal.
  assert.equal(indicatorRenderKey([vm("a"), vm("b", { status: "succeeded" })], null), a);
});

test("polling skips unchanged idle state, repaints running rows, and disposes the timer", async () => {
  let repaints = 0, rows = [vm("a", { status: "running" })], subscribed = 0;
  const polling = startFleetPolling({
    intervalMs: 20, rows: () => rows, selected: () => null,
    repaint: () => { repaints++; },
    subscribe: () => { subscribed++; return () => { subscribed--; }; },
  });
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.ok(repaints >= 2, "running rows advance elapsed time between service events");
  assert.ok(polling.renderKey());
  repaints = 0;
  rows = [vm("a", { status: "succeeded" })]; // Terminal: one repaint for the key change, then none.
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.ok(repaints <= 2);
  repaints = 0;
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(repaints, 0, "an unchanged key with no running row never repaints");
  polling.dispose();
  assert.equal(subscribed, 0);
  repaints = 0;
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(repaints, 0, "the timer is disposed");
});
