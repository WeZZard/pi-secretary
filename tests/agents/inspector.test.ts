import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { AgentSnapshot } from "../../extensions/secretary/agents/records.ts";
import { transition } from "../../extensions/secretary/agents/ui/reducer.ts";
import { initialState, type UiEvent, type UiState } from "../../extensions/secretary/agents/ui/state.ts";
import { Inspector } from "../../extensions/secretary/agents/ui/inspector.ts";
import type { TranscriptEvent } from "../../extensions/secretary/agents/ui/transcript-events.ts";

const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));
function snapshot(id = "a"): AgentSnapshot {
  return { agent: { agentId: id, parentId: "p", definition: { name: "general-purpose", description: "test", prompt: "test", source: "packaged", hash: "hash", resumable: true }, model: "provider/model", tools: [], cwd: "/tmp", configCwd: "/tmp", sessionPath: "/tmp/session", resumable: true, createdAt: 0, worktree: { id: "wt", repo: "/repo", path: "/wt", branch: "agent", baseCommit: "base", state: "allocated" } }, run: { agentId: id, parentId: "p", runId: `${id}-run`, launchKey: id, prompt: "task", description: `${id} task`, status: "running", background: true, createdAt: 0, outputPath: "/tmp/output", output: "", toolCount: 0, turnCount: 0, revision: 0 } };
}
const events: TranscriptEvent[] = Array.from({ length: 40 }, (_, i) => ({ kind: "assistant" as const, entryId: `e-${i}`, text: `paragraph ${i}` }));
function inspectorState(): UiState {
  let s = transition(initialState(), { type: "activate", parentId: "p", epoch: "e", viewId: "v" }, [snapshot("a"), snapshot("b"), snapshot("c")]).state;
  s = transition(s, { type: "open", viewId: "v1" }).state;
  s = transition(s, { type: "select", agentId: "b", requestId: "r" }).state;
  return transition(s, { type: "transcript", epoch: "e", viewId: "v1", agentId: "b", requestId: "r", events }).state;
}

test("select-first and select-last are reducer events that load the boundary agents", () => {
  const s = inspectorState();
  const first = transition(s, { type: "select-first", requestId: "f" });
  assert.equal(first.state.navigation.kind === "inspector" && first.state.navigation.detail.kind, "loading");
  const load = first.effects.find(e => e.type === "load");
  assert.ok(load && load.type === "load" && load.agentId === "a" && load.requestId === "f");
  const loaded = transition(first.state, { type: "transcript", epoch: "e", viewId: "v1", agentId: "a", requestId: "f", events }).state;
  assert.equal(loaded.navigation.kind === "inspector" && loaded.navigation.detail.kind === "ready" && loaded.navigation.detail.agentId, "a");
  const last = transition(loaded, { type: "select-last", requestId: "l" });
  const lastLoad = last.effects.find(e => e.type === "load");
  assert.ok(lastLoad && lastLoad.type === "load" && lastLoad.agentId === "c");
  // First/last on a single-agent session targeting the current selection is a no-op.
  const single = transition(loaded, { type: "select-first", requestId: "f2" });
  assert.equal(single.state, loaded);
  assert.deepEqual(single.effects, []);
  // A dialog blocks boundary selection like any other selection.
  const composing = transition(s, { type: "compose" }).state;
  assert.deepEqual(transition(composing, { type: "select-last", requestId: "x" }).state, composing);
});

test("Home and End keys dispatch first and last selection", () => {
  const s = inspectorState();
  const dispatched: UiEvent[] = [];
  const inspector = new Inspector(() => s, e => dispatched.push(e), () => "id");
  inspector.handleInput("\x1b[H");
  inspector.handleInput("\x1b[F");
  assert.deepEqual(dispatched.map(e => e.type), ["select-first", "select-last"]);
});

test("the overlay renders a bordered frame with title, position, and footer at wide and narrow widths", () => {
  const s = inspectorState();
  const inspector = new Inspector(() => s, () => {}, () => "id", () => 22);
  const wide = plain(inspector.render(140));
  assert.match(wide, /╭─ Agents · 2\/3 ─+╮/);
  assert.match(wide, /╰─+╯/);
  assert.match(wide, /│ > ● b · running\s+│ Task: b task/, "wide terminals show the roster beside the detail pane");
  assert.match(wide, /Esc close/);
  const narrow = inspector.render(60);
  assert.match(plain(narrow), /╭─ Agents · 2\/3/);
  const headerRow = plain(narrow).split("\n")[1]!;
  assert.doesNotMatch(headerRow, / │ /, "narrow terminals stack panes");
  assert.match(plain(narrow), /Esc close/);
  for (const width of [36, 60, 100, 140]) {
    for (const line of inspector.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}`);
  }
});

test("below the minimum width the inspector renders a single diagnostic line", () => {
  const inspector = new Inspector(() => inspectorState(), () => {}, () => "id");
  for (const width of [0, 1, 10, 35]) {
    const lines = inspector.render(width);
    assert.ok(lines.length <= 1);
    if (width >= 35) assert.match(plain(lines), /^Agents inspector requires a wider t/);
    else if (width > 0) assert.equal(plain(lines).trim().length <= width, true);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
});

test("the footer enumerates only actions available for the selected record", () => {
  const running = inspectorState();
  const withRunning = plain(new Inspector(() => running, () => {}, () => "id").render(140));
  assert.match(withRunning, /s message/);
  assert.match(withRunning, /D stop/);
  assert.match(withRunning, /x tools/);
  assert.match(withRunning, /r reload/);
  // A finished one-shot agent can only be viewed; message and stop disappear.
  const done = snapshot("b"); done.run!.status = "succeeded"; done.agent.resumable = false;
  let s = transition(initialState(), { type: "activate", parentId: "p", epoch: "e", viewId: "v" }, [done]).state;
  s = transition(s, { type: "open", viewId: "v1" }).state;
  s = transition(s, { type: "select", agentId: "b", requestId: "r" }).state;
  s = transition(s, { type: "transcript", epoch: "e", viewId: "v1", agentId: "b", requestId: "r", events }).state;
  const finished = plain(new Inspector(() => s, () => {}, () => "id").render(140));
  assert.doesNotMatch(finished, /s message/);
  assert.doesNotMatch(finished, /D stop/);
  assert.match(finished, /x tools/);
  assert.match(finished, /Esc close/);
  // The list view without a selection offers selection and closing only.
  const list = transition(s, { type: "open", viewId: "v2" }).state;
  const listRender = plain(new Inspector(() => list, () => {}, () => "id").render(140));
  assert.doesNotMatch(listRender, /s message|D stop|x tools/);
});

test("tool-detail expansion toggles on x, X, and the configured expansion key", () => {
  let s = inspectorState();
  const withTool: TranscriptEvent[] = [{ kind: "tool", entryId: "t1", name: "bash", status: "complete", argsPreview: "```\n{\"command\":\"ls\"}\n```", output: "file-a\nfile-b" }];
  const nav = s.navigation;
  if (nav.kind !== "inspector" || nav.detail.kind !== "ready") throw new Error("expected ready");
  s = { ...s, navigation: { ...nav, detail: { ...nav.detail, transcript: { ...nav.detail.transcript, events: withTool } } } };
  const dispatched: UiEvent[] = [];
  const inspector = new Inspector(() => s, e => {
    if (e.type === "expand") {
      const nav = s.navigation;
      if (nav.kind === "inspector" && nav.detail.kind === "ready") {
        s = { ...s, navigation: { ...nav, detail: { ...nav.detail, transcript: { ...nav.detail.transcript, expanded: !nav.detail.transcript.expanded } } } };
      }
    }
    dispatched.push(e);
  }, () => "id");
  assert.doesNotMatch(plain(inspector.render(120)), /"command"/);
  inspector.handleInput("x");
  assert.match(plain(inspector.render(120)), /"command"/);
  assert.match(plain(inspector.render(120)), /file-a/);
  inspector.handleInput("X");
  assert.doesNotMatch(plain(inspector.render(120)), /"command"/);
  inspector.handleInput("\x0f"); // ctrl+o: the default configured expansion binding
  assert.match(plain(inspector.render(120)), /"command"/);
  assert.deepEqual(dispatched.map(e => e.type), ["expand", "expand", "expand"]);
});

test("configured keybindings replace defaults in both input handling and the footer", () => {
  const s = inspectorState();
  const dispatched: UiEvent[] = [];
  const inspector = new Inspector(() => s, e => dispatched.push(e), () => "id", () => 22,
    { keybindings: { stop: ["shift+t"], steer: ["m"], close: ["ctrl+q"] } });
  inspector.handleInput("T");
  assert.deepEqual(dispatched.map(e => e.type), ["control"]);
  inspector.handleInput("m");
  assert.deepEqual(dispatched.map(e => e.type), ["control", "compose"]);
  const rendered = plain(new Inspector(() => inspectorState(), () => {}, () => "id", () => 22,
    { keybindings: { stop: ["shift+t"], steer: ["m"], close: ["ctrl+q"] } }).render(140));
  assert.match(rendered, /T stop/);
  assert.match(rendered, /m message/);
  assert.match(rendered, /Ctrl\+Q close/);
  assert.doesNotMatch(rendered, /D stop/);
});

test("r and R reload the selected transcript as reducer events", () => {
  const s = inspectorState();
  const dispatched: UiEvent[] = [];
  const inspector = new Inspector(() => s, e => dispatched.push(e), () => "req");
  inspector.handleInput("r");
  inspector.handleInput("R");
  assert.deepEqual(dispatched, [
    { type: "select", agentId: "b", requestId: "req" },
    { type: "select", agentId: "b", requestId: "req" },
  ]);
});
