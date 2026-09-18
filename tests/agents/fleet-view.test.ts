import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FleetView } from "../../extensions/secretary/agents/ui/fleet-view.ts";
import { transition } from "../../extensions/secretary/agents/ui/reducer.ts";
import { initialState, type UiState } from "../../extensions/secretary/agents/ui/state.ts";
import type { AgentRowView, AgentSnapshot } from "../../extensions/secretary/agents/records.ts";

function snapshot(id = "a", status: AgentSnapshot["run"] extends infer R ? R extends { status: infer S } ? S : never : never): AgentSnapshot {
  return { agent: { agentId: id, parentId: "p", definition: { name: "general-purpose", description: "test", prompt: "test", source: "packaged", hash: "hash", resumable: true }, model: "provider/model", tools: [], cwd: "/tmp", configCwd: "/tmp", sessionPath: "/tmp/session", resumable: true, createdAt: 0 }, run: { agentId: id, parentId: "p", runId: `${id}-run`, launchKey: id, prompt: "task", description: `${id} task`, status: status as AgentSnapshot["run"] extends undefined ? never : NonNullable<AgentSnapshot["run"]>["status"], background: true, createdAt: 0, startedAt: 1000, outputPath: "/tmp/output", output: "", toolCount: 0, turnCount: 0, revision: 0 } };
}
function fleet(snapshots: AgentSnapshot[], rows: AgentRowView[] = [], now = 6500): { state: () => UiState; view: FleetView } {
  let state = transition(initialState(), { type: "activate", parentId: "p", epoch: "e", viewId: "v" }, snapshots).state;
  state = transition(state, { type: "fleet", editorEmpty: true }).state;
  return { state: () => state, view: new FleetView(() => state, { rows: () => rows, now: () => now }) };
}
const vm = (id: string, overrides: Partial<AgentRowView> = {}): AgentRowView => ({
  agentId: id, status: "running", description: `${id} task`, model: "provider/model", startedAt: 1000, background: true, ...overrides,
});

test("rows show status glyphs, labels, elapsed time, and usage labels", () => {
  const { view } = fleet([snapshot("a", "running")], [vm("a", { name: "reviewer", windowTokens: 3800, cumulativeTokens: 4250 })]);
  const lines = view.render(100);
  assert.match(lines.at(-1)!, /● reviewer · a task · running/);
  assert.match(lines.at(-1)!, /6s/);
  assert.match(lines.at(-1)!, /↓ 3\.8k window · 4\.3k spent/);
});

test("the collapsed summary carries aggregate usage labels and the activation-key hint", () => {
  const { view, state } = fleet([snapshot("a", "running"), snapshot("b", "queued")], [vm("a", { windowTokens: 1000, cumulativeTokens: 1500 }), vm("b", { status: "queued", startedAt: undefined, cumulativeTokens: 500 })]);
  // Collapse back to the editor: the summary remains as the only line.
  const collapsed = new FleetView(() => ({ ...state(), navigation: { kind: "editor" } }), { rows: () => [vm("a", { windowTokens: 1000, cumulativeTokens: 1500 }), vm("b", { status: "queued", cumulativeTokens: 500 })], now: () => 6500 });
  const lines = collapsed.render(120);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /1 active agents · 1 queued/);
  assert.match(lines[0]!, /↓ 1\.0k window · 2\.0k spent/);
  assert.match(lines[0]!, /↓\/← inspect/);
});

test("unknown usage is never displayed as zero", () => {
  const { view } = fleet([snapshot("a", "running")], [vm("a")]);
  const text = view.render(100).join("\n");
  assert.doesNotMatch(text, /0 window|0 spent|\b0 tokens\b/);
});

test("right-aligned information realigns across widths and stays in bounds", () => {
  const { view } = fleet([snapshot("a", "running"), snapshot("b", "queued")], [vm("a", { name: "reviewer", windowTokens: 2000, cumulativeTokens: 999 }), vm("b", { status: "queued", startedAt: undefined })], 61000);
  for (const width of [0, 1, 20, 40, 58, 100, 160]) {
    const lines = view.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: [${line}]`);
    if (width >= 100) {
      const agentRow = lines.find(line => line.includes("a task"));
      assert.ok(agentRow && /60s · ↓ 2\.0k window · 999 spent$/.test(agentRow), "elapsed and usage stay right-aligned at the row end");
      assert.equal(visibleWidth(agentRow!), width);
    } else if (width >= 60) {
      const agentRow = lines.find(line => line.includes("a task"));
      assert.ok(agentRow && /60s/.test(agentRow), "elapsed time remains visible before right-side truncation");
    }
  }
});

test("wide CJK names truncate by display width within bounds", () => {
  const { view } = fleet([snapshot("a", "running")], [vm("a", { name: "界".repeat(30), windowTokens: 2000, cumulativeTokens: 999 })], 61000);
  for (const width of [20, 40, 60, 100]) {
    const lines = view.render(width);
    assert.ok(lines.some(line => line.includes("a task") || line.includes("active agents")));
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: [${line}]`);
  }
});

test("rows render without a published view model using snapshot fields only", () => {
  const { view } = fleet([snapshot("a", "running")]);
  const text = view.render(100).join("\n");
  assert.match(text, /● a · a task · running/);
  assert.doesNotMatch(text, /window|spent/);
});
