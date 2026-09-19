import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "../../extensions/secretary/agents/records.ts";
import { transition } from "../../extensions/secretary/agents/ui/reducer.ts";
import { initialState, type UiState, type UiEvent } from "../../extensions/secretary/agents/ui/state.ts";
import { FleetView } from "../../extensions/secretary/agents/ui/fleet-view.ts";
import { Inspector } from "../../extensions/secretary/agents/ui/inspector.ts";
import { sanitize, transcriptWindow } from "../../extensions/secretary/agents/ui/transcript.ts";
import type { TranscriptEvent } from "../../extensions/secretary/agents/ui/transcript-events.ts";
import { runEffect, type AgentUIPort } from "../../extensions/secretary/agents/ui/effects.ts";
import { registerAgentUI, FLEET_WIDGET_KEY } from "../../extensions/secretary/agents/ui/commands.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
function snapshot(id = "a"): AgentSnapshot {
  return { agent: { agentId: id, parentId: "p", definition: { name: "general-purpose", description: "test", prompt: "test", source: "packaged", hash: "hash", resumable: true }, model: "provider/model", tools: [], cwd: "/tmp", configCwd: "/tmp", sessionPath: "/tmp/session", resumable: true, createdAt: 0, worktree: { id: "wt", repo: "/repo", path: "/wt", branch: "agent", baseCommit: "base", state: "allocated" } }, run: { agentId: id, parentId: "p", runId: `${id}-run`, launchKey: id, prompt: "task", description: "task", status: "running", background: true, createdAt: 0, outputPath: "/tmp/output", output: "", toolCount: 0, turnCount: 0, revision: 0 } };
}
const activate = (snapshots = [snapshot(), snapshot("b")]) => transition(initialState(), { type: "activate", parentId: "p", epoch: "e", viewId: "v" }, snapshots).state;
const step = (s: UiState, e: UiEvent) => transition(s, e).state;
function ready(): UiState {
  let s = step(activate(), { type: "open", viewId: "v1" });
  s = step(s, { type: "select", agentId: "a", requestId: "r" });
  const events: TranscriptEvent[] = Array.from({ length: 100 }, (_, i) => ({ kind: "assistant" as const, entryId: `line-${i}`, text: `line ${i}` }));
  return step(s, { type: "transcript", epoch: "e", viewId: "v1", agentId: "a", requestId: "r", events });
}
function submitting(): UiState { let s = step(ready(), { type: "compose" }); s = step(s, { type: "draft", text: "retained guidance" }); return step(s, { type: "submit", operationId: "op" }); }
const outcome = (result: "accepted" | "rejected" | "uncertain"): UiEvent => ({ type: "outcome", epoch: "e", viewId: "v1", operationId: "op", outcome: result, message: result });
test("fleet guards preserve main editor and inactive events cannot mutate service", () => {
  const s = activate();
  assert.deepEqual(transition(s, { type: "fleet", editorEmpty: false }), { state: s, effects: [] });
  const entered = transition(s, { type: "fleet", editorEmpty: true });
  assert.equal(entered.state.navigation.kind, "fleet"); assert.ok(entered.effects.some(e => e.type === "focus" && e.target === "fleet"));
  const idle = transition(activate([]), { type: "fleet", editorEmpty: true });
  assert.equal(idle.state.navigation.kind, "editor", "an empty indicator cannot receive focus");
  assert.deepEqual(idle.effects, []);
  const emptied = transition(entered.state, { type: "snapshot", epoch: "e" }, []);
  assert.equal(emptied.state.navigation.kind, "editor", "losing the last row returns focus to the editor");
  assert.ok(emptied.effects.some(e => e.type === "focus" && e.target === "editor"));
  const closed = transition(entered.state, { type: "escape" });
  assert.equal(closed.state.navigation.kind, "editor"); assert.ok(!closed.effects.some(e => e.type === "operate"));
  const inactive = step(s, { type: "deactivate" });
  for (const e of [{ type: "compose" }, { type: "submit", operationId: "x" }, { type: "control", action: "stop", agentId: "a" }] as UiEvent[]) assert.deepEqual(transition(inactive, e), { state: inactive, effects: [] });
});
test("activation copies owned snapshots rather than retaining mutable service objects", () => {
  const a = snapshot(), foreign = snapshot("foreign"); foreign.agent.parentId = "other";
  const s = activate([a, foreign]); a.agent.name = "changed"; a.run!.status = "failed";
  assert.equal(s.snapshots.length, 1); assert.equal(s.snapshots[0]!.agent.name, undefined); assert.equal(s.snapshots[0]!.run!.status, "running");
});
test("transcript response requires epoch, view, recipient and request; reordering never changes selection", () => {
  let s = step(ready(), { type: "select", agentId: "b", requestId: "b-load" });
  const stale = { type: "transcript", epoch: "e", viewId: "v1", agentId: "a", requestId: "r", events: [{ kind: "assistant", entryId: "stale", text: "wrong" }] } as const;
  assert.equal(step(s, stale), s);
  for (const patch of [{ epoch: "old" }, { viewId: "old" }, { requestId: "old" }]) assert.equal(step(s, { ...stale, agentId: "b", requestId: "b-load", ...patch }), s);
  s = transition(s, { type: "snapshot", epoch: "e" }, [...s.snapshots].reverse()).state;
  assert.equal(s.navigation.kind === "inspector" && s.navigation.detail.kind === "loading" && s.navigation.detail.agentId, "b");
});
test("one submission, empty validation, rejected draft and modal-only Escape", () => {
  const composer = step(ready(), { type: "compose" });
  const invalid = transition(composer, { type: "submit", operationId: "empty" });
  assert.equal(invalid.state.dialog.kind, "composing"); assert.ok(!invalid.effects.some(e => e.type === "operate"));
  const sent = transition(step(composer, { type: "draft", text: "guidance" }), { type: "submit", operationId: "op" });
  assert.equal(sent.effects.filter(e => e.type === "operate").length, 1);
  assert.deepEqual(transition(sent.state, { type: "submit", operationId: "duplicate" }).effects, []);
  const rejected = step(submitting(), outcome("rejected"));
  assert.equal(rejected.dialog.kind === "composing" && rejected.dialog.draft, "retained guidance");
  const dismissed = transition(submitting(), { type: "escape" });
  assert.equal(dismissed.state.navigation.kind, "inspector"); assert.ok(dismissed.state.pending.op); assert.ok(!dismissed.effects.some(e => e.type === "operate"));
  const newer = step(step(dismissed.state, { type: "select", agentId: "b", requestId: "b-load" }), { type: "compose" });
  const late = transition(newer, outcome("accepted"));
  assert.deepEqual(late.state.dialog, newer.dialog); assert.ok(!late.effects.some(e => e.type === "focus"));
});
test("uncertainty retains operation and prevents resubmission even after dismissing", () => {
  const uncertain = transition(submitting(), outcome("uncertain"));
  assert.equal(uncertain.state.dialog.kind, "uncertain"); assert.equal(uncertain.effects.filter(e => e.type === "receipt").length, 1);
  const reopened = step(step(uncertain.state, { type: "escape" }), { type: "compose" });
  assert.equal(reopened.dialog.kind, "uncertain"); assert.ok(!transition(reopened, { type: "submit", operationId: "again" }).effects.some(e => e.type === "operate"));
  assert.equal(step(reopened, outcome("rejected")).dialog.kind, "composing");
});
test("stop confirmation captures run, ignores progress revisions, rejects replacement or terminal run", () => {
  const confirmed = step(ready(), { type: "control", action: "stop", agentId: "a" });
  const progress = confirmed.snapshots.map(s => ({ ...s, run: s.run && { ...s.run, revision: 10 } }));
  const current = transition(confirmed, { type: "snapshot", epoch: "e" }, progress).state;
  assert.equal(current.dialog.kind, "confirming");
  const sent = transition(current, { type: "submit", operationId: "stop" });
  const op = sent.effects.find(e => e.type === "operate"); assert.ok(op && op.operation.action === "stop" && op.operation.target.action === "stop" && op.operation.target.runId === "a-run");
  for (const change of [{ status: "succeeded" as const }, { runId: "new-run" }]) {
    const changed = progress.map(s => s.agent.agentId === "a" ? { ...s, run: { ...s.run!, ...change } } : s);
    const result = transition(confirmed, { type: "snapshot", epoch: "e" }, changed);
    assert.equal(result.state.dialog.kind, "closed"); assert.ok(!result.effects.some(e => e.type === "operate"));
  }
});
test("completion retains composer and paused source-line anchor across refresh", () => {
  let s = step(ready(), { type: "scroll", delta: -20, pageSize: 10 });
  const before = s.navigation.kind === "inspector" && s.navigation.detail.kind === "ready" ? s.navigation.detail.transcript : undefined; assert.ok(before);
  const refreshed = step(step(s, { type: "select", agentId: "a", requestId: "fresh" }), { type: "transcript", epoch: "e", viewId: "v1", agentId: "a", requestId: "fresh", events: [...before.events, { kind: "assistant", entryId: "new", text: "new output" }] });
  assert.equal(refreshed.navigation.kind === "inspector" && refreshed.navigation.detail.kind === "ready" && refreshed.navigation.detail.transcript.anchor, before.anchor);
  s = step(step(s, { type: "compose" }), { type: "draft", text: "keep" });
  const completed = s.snapshots.map(a => ({ ...a, run: { ...a.run!, status: "succeeded" as const } }));
  const next = transition(s, { type: "snapshot", epoch: "e" }, completed);
  assert.deepEqual(next.state.dialog, s.dialog); assert.ok(!next.effects.some(e => e.type === "focus"));
});
test("cleanup captures worktree identity, refuses active work, and preserves direct-command editor focus", () => {
  const activeState = activate();
  assert.equal(step(activeState, { type: "control", action: "cleanup", agentId: "a" }).dialog.kind, "closed");
  const idle = snapshot(); idle.run!.status = "succeeded";
  const state = activate([idle]);
  const confirmation = step(state, { type: "control", action: "cleanup", agentId: "a" });
  assert.equal(confirmation.navigation.kind, "editor"); assert.equal(confirmation.dialog.kind, "confirming");
  const sent = transition(confirmation, { type: "submit", operationId: "clean" });
  assert.equal(sent.effects.filter(e => e.type === "operate").length, 1);
  const dismissed = transition(confirmation, { type: "escape" });
  assert.equal(dismissed.state.navigation.kind, "editor"); assert.ok(dismissed.effects.some(e => e.type === "focus" && e.target === "editor"));
  idle.agent.worktree!.id = "replacement";
  const stale = transition(confirmation, { type: "snapshot", epoch: "e" }, [idle]);
  assert.equal(stale.state.dialog.kind, "closed"); assert.ok(!stale.effects.some(e => e.type === "operate"));
});
test("unavailable transcript retains identity; retry and refresh never acquire focus", () => {
  const loading = step(ready(), { type: "select", agentId: "a", requestId: "failed-load" });
  const unavailable = transition(loading, { type: "transcript", epoch: "e", viewId: "v1", agentId: "a", requestId: "failed-load", error: "Missing transcript" });
  assert.equal(unavailable.state.navigation.kind === "inspector" && unavailable.state.navigation.detail.kind, "unavailable");
  assert.ok(!unavailable.effects.some(e => e.type === "focus"));
  const retry = transition(unavailable.state, { type: "select", agentId: "a", requestId: "retry" });
  assert.ok(retry.effects.some(e => e.type === "load" && e.agentId === "a"));
  assert.deepEqual(transition(retry.state, { type: "refresh" }).effects, [{ type: "render" }]);
  const closed = step(retry.state, { type: "escape" });
  assert.equal(step(closed, { type: "transcript", epoch: "e", viewId: "v1", agentId: "a", requestId: "retry", events: [{ kind: "assistant", entryId: "late", text: "late" }] }), closed);
});
test("bounded event sequences preserve modal/navigation constraints and forbid accidental mutations", () => {
  const events: UiEvent[] = [{ type: "compose" }, { type: "draft", text: "text" }, { type: "submit", operationId: "fixed" }, { type: "escape" }, { type: "fleet", editorEmpty: true }, { type: "control", action: "stop", agentId: "a" }, outcome("accepted"), outcome("uncertain"), { type: "deactivate" }];
  let states = [ready()];
  for (let depth = 0; depth < 4; depth++) {
    const next: UiState[] = [];
    for (const before of states) for (const event of events) {
      const result = transition(before, event), after = result.state;
      if (after.navigation.kind === "inactive") { assert.equal(after.dialog.kind, "closed"); assert.deepEqual(after.drafts, {}); }
      if (after.dialog.kind === "composing") assert.equal(after.navigation.kind, "inspector");
      if (after.navigation.kind === "fleet") assert.equal(after.dialog.kind, "closed");
      if (event.type !== "submit") assert.ok(!result.effects.some(e => e.type === "operate"));
      if (before.dialog.kind === "submitting") assert.ok(!result.effects.some(e => e.type === "operate"));
      next.push(after);
    }
    states = next;
  }
});
test("deactivation clears draft and rejects late operation outcomes", () => {
  const inactive = step(submitting(), { type: "deactivate" });
  assert.deepEqual(inactive.drafts, {}); assert.deepEqual(inactive.pending, {});
  assert.equal(step(inactive, outcome("accepted")), inactive);
});
test("expanded narrow inspector preserves operation feedback and navigation hints", () => {
  const state = { ...step(ready(), { type: "expand" }), feedback: "Operation acceptance is recorded." };
  const events: UiEvent[] = [];
  const inspector = new Inspector(() => state, event => events.push(event), () => "id", () => 22);
  const lines = inspector.render(58);
  assert.ok(lines.some(line => line.includes("Operation acceptance is recorded.")));
  assert.ok(lines.some(line => line.includes("Esc close")));
  assert.ok(lines.length <= 22, "the bordered frame keeps the rendered height within the overlay budget");
  inspector.handleInput("\x1b[6~");
  const scroll = events.find(event => event.type === "scroll");
  assert.ok(scroll?.type === "scroll");
  assert.equal(scroll.delta, scroll.pageSize);
  assert.ok(scroll.pageSize < 10, "expanded metadata reduces the actual transcript viewport");
});

test("renderers clip CJK and sanitize terminal controls without changing focus", () => {
  const s = ready(); s.snapshots[0]!.agent.name = "界".repeat(100) + "\x1b]52;c;attack\x07";
  const events: UiEvent[] = [];
  const inspector = new Inspector(() => s, e => events.push(e), () => "id");
  for (const width of [0, 1, 10, 60, 120]) {
    for (const component of [inspector, new FleetView(() => s)]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  assert.deepEqual(events, []);
  assert.equal(sanitize("hello\x1b[2J\x1b]52;c;bad\x07\rworld"), "helloworld");
  const anchorEvents: TranscriptEvent[] = [{ kind: "user", entryId: "a", text: "a" }, { kind: "assistant", entryId: "b", text: "b" }, { kind: "notice", entryId: "c", tone: "muted", text: "c" }];
  const anchored = transcriptWindow({ events: anchorEvents, follow: "paused", anchor: 1, expanded: false }, 20, 2);
  assert.equal(anchored[0], "│ a", "anchors are logical lines: offset one into the user event starts at its content");
  const headerAnchored = transcriptWindow({ events: anchorEvents, follow: "paused", anchor: 2, expanded: false }, 20, 2);
  assert.equal(headerAnchored[0], "◆ Assistant"); assert.match(headerAnchored[1]!, /^│ b/);
});
test("effect runner correlates outcomes, never repeats uncertain mutations and supports receipts", async () => {
  let calls = 0; const events: UiEvent[] = [];
  const port: AgentUIPort = { list: () => [], subscribe: () => () => {}, transcript: async () => [], message: async () => { calls++; throw new Error("transport lost"); }, stop: async () => {}, cleanup: async () => {}, receipt: async () => ({ outcome: "accepted", message: "Recorded" }) };
  const s = submitting(); assert.equal(s.dialog.kind, "submitting"); if (s.dialog.kind !== "submitting") return;
  await runEffect({ type: "operate", operation: s.dialog.operation }, port, e => events.push(e));
  assert.equal(calls, 1); assert.deepEqual(events[0], { type: "outcome", epoch: "e", viewId: "v1", operationId: "op", outcome: "uncertain", message: "transport lost" });
  await runEffect({ type: "receipt", operation: s.dialog.operation }, port, e => events.push(e));
  assert.equal(calls, 1); assert.equal(events[1]?.type === "outcome" && events[1].outcome, "accepted");
});
test("adapter uses one namespaced below-editor widget and does not consume normal editing or other prompts", () => {
  let terminal: ((data: string) => unknown) | undefined, editor = "draft", removed = 0;
  const hooks: Record<string, () => void> = {}, widgets: string[] = [];
  const pi = { registerCommand() {}, on(name: string, fn: () => void) { hooks[name] = fn; } } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "p" }, ui: { setWidget(key: string, _component: unknown, options?: { placement: string }) { widgets.push(key); if (_component) assert.equal(options?.placement, "belowEditor"); }, onTerminalInput(fn: (data: string) => unknown) { terminal = fn; return () => { removed++; }; }, getEditorText: () => editor, notify() {} } } as unknown as ExtensionContext;
  const port: AgentUIPort = { list: () => [snapshot()], transcript: async () => [], message: async () => {}, stop: async () => {}, cleanup: async () => {}, subscribe: () => () => {} };
  const ui = registerAgentUI(pi, port); ui.bind(ctx);
  assert.equal(terminal?.("\x1b[B"), undefined); editor = "";
  hooks.ui_prompt_start!(); assert.equal(terminal?.("\x1b[B"), undefined); hooks.ui_prompt_end!();
  assert.deepEqual(terminal?.("\x1b[B"), { consume: true });
  assert.deepEqual(terminal?.("\x1b"), { consume: true });
  assert.equal(terminal?.("s"), undefined);
  ui.dispose(); assert.equal(removed, 1); assert.ok(widgets.every(key => key === FLEET_WIDGET_KEY));
  assert.ok(widgets.includes(FLEET_WIDGET_KEY));
});
