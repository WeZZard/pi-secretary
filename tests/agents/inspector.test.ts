import test from "node:test";
import assert from "node:assert/strict";
import { TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { stripVTControlCharacters } from "node:util";
import type { AgentSnapshot } from "../../extensions/secretary/agents/records.ts";
import { transition } from "../../extensions/secretary/agents/ui/reducer.ts";
import { initialState, type UiEvent, type UiState } from "../../extensions/secretary/agents/ui/state.ts";
import { Inspector, inspectorHeight } from "../../extensions/secretary/agents/ui/inspector.ts";
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

// Exercise real keyboard routing, overlay composition, ANSI output, and terminal cells.
async function terminalHarness(mode: "main" | "alternate") {
  const screen = new xterm.Terminal({ cols: 160, rows: 50, allowProposedApi: true });
  let input: (data: string) => void = () => {};
  let output = "";
  let resized: () => void = () => {};
  const terminal: Terminal = {
    get columns() { return screen.cols; }, get rows() { return screen.rows; }, kittyProtocolActive: false,
    start(onInput, onResize) { input = onInput; resized = onResize; }, stop() {}, async drainInput() {},
    write(data) { output += data; },
    moveBy(n) { this.write(n < 0 ? `\x1b[${-n}A` : `\x1b[${n}B`); },
    hideCursor() {}, showCursor() {}, clearLine() { this.write("\x1b[2K"); },
    clearFromCursor() { this.write("\x1b[J"); }, clearScreen() { this.write("\x1b[2J\x1b[H"); },
    setTitle() {}, setProgress() {},
  };
  let state = inspectorState();
  const tui = mode === "main" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  const inspector = new Inspector(() => state, event => {
    state = transition(state, event).state;
    tui.requestRender();
  }, () => "nav-request", () => inspectorHeight(terminal.rows));
  tui.addChild({ render: () => Array.from({ length: 50 }, () => "background"), invalidate() {} });
  tui.start();
  tui.showOverlay(inspector, { width: "100%", maxHeight: "100%", anchor: "center" });
  const paint = async () => {
    tui.requestRender();
    await new Promise(resolve => setTimeout(resolve, 30));
    const data = output; output = "";
    await new Promise<void>(resolve => screen.write(data, resolve));
    return Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(screen.buffer.active.viewportY + i)!.translateToString(false, 0, screen.cols));
  };
  return { paint, input: (data: string) => input(data), state: () => state,
    resize: (cols: number, rows: number) => { screen.resize(cols, rows); resized(); },
    load: (events: TranscriptEvent[]) => {
      const nav = state.navigation;
      assert.ok(nav.kind === "inspector" && nav.detail.kind === "loading");
      state = transition(state, { type: "transcript", epoch: "e", viewId: "v1", agentId: nav.detail.agentId, requestId: nav.detail.requestId, events }).state;
    },
    close: () => { tui.stop(); screen.dispose(); },
  };
}

for (const mode of ["main", "alternate"] as const) for (const defect of ["right border", "stable height", "pane proportions"] as const) {
  test(`real ${mode} TUI fleet overlay preserves ${defect} through navigation`, async () => {
    const h = await terminalHarness(mode);
    try {
      const ready = await h.paint();
      const top = ready.findIndex(line => line.startsWith("╭"));
      const bottom = ready.findIndex(line => line.startsWith("╰"));
      assert.ok(top >= 0 && bottom > top);
      assert.equal(bottom - top + 1, inspectorHeight(50));
      if (defect === "right border") {
        for (const line of ready.slice(top + 1, bottom)) assert.equal(line.at(-1), "│", line);
      } else if (defect === "pane proportions") {
        const divider = ready[top + 1]!.indexOf("│", 1);
        assert.ok(divider - 3 >= 20 && divider - 3 <= 40, "navigation stays within 20–40 content columns");
        assert.ok(160 - divider - 4 >= Math.ceil(160 * 0.618), "detail content has at least 61.8% of terminal columns");
      } else {
        h.input("\x1b[B");
        const loading = await h.paint();
        assert.equal(loading.findIndex(line => line.startsWith("╭")), top, "loading must not recenter");
        assert.equal(loading.findIndex(line => line.startsWith("╰")), bottom);
        h.load([]);
        const empty = await h.paint();
        assert.equal(empty.findIndex(line => line.startsWith("╭")), top, "empty transcript must not recenter");
        assert.equal(empty.findIndex(line => line.startsWith("╰")), bottom);
        h.resize(80, 24);
        const narrow = await h.paint();
        const resizedTop = narrow.findIndex(line => line.startsWith("╭"));
        const resizedBottom = narrow.findIndex(line => line.startsWith("╰"));
        assert.equal(resizedBottom - resizedTop + 1, inspectorHeight(24));
        for (const line of narrow.slice(resizedTop + 1, resizedBottom)) assert.equal(line.at(-1), "│", JSON.stringify(line));
      }
    } finally { h.close(); }
  });
}

for (const mode of ["main", "alternate"] as const) {
  test(`real ${mode} TUI composer draws its top rule`, async () => {
    const h = await terminalHarness(mode);
    try {
      await h.paint(); h.input("s");
      const lines = await h.paint();
      assert.match(lines.find(line => line.startsWith("╭"))!, /^╭─ Agents ─+╮$/);
    } finally { h.close(); }
  });
  for (const escape of ["\x1b", "\x1b[27u", "\x1b[27;1u"]) {
    test(`real ${mode} TUI composer dismisses Escape ${JSON.stringify(escape)} without sending`, async () => {
      const h = await terminalHarness(mode);
      try {
        await h.paint(); h.input("s"); h.input("draft"); await h.paint();
        assert.equal(h.state().dialog.kind, "composing");
        h.input(escape); await h.paint();
        assert.equal(h.state().dialog.kind, "closed");
        assert.equal(h.state().navigation.kind, "inspector", "only the composer closes");
        assert.deepEqual(h.state().pending, {}, "dismissal sends nothing");
        h.input("s"); await h.paint();
        const dialog = h.state().dialog;
        assert.ok(dialog.kind === "composing"); assert.equal(dialog.draft, "draft");
        h.input(escape); h.input(escape); await h.paint();
        assert.equal(h.state().navigation.kind, "editor", "the second Escape exits inspection");
      } finally { h.close(); }
    });
  }
}

for (const mode of ["main", "alternate"] as const) {
  test(`real ${mode} TUI scrolls by keyboard and accepts protocol-encoded Enter`, async () => {
    const h = await terminalHarness(mode);
    try {
      const before = await h.paint();
      assert.match(before.join("\n"), /PgUp\/PgDn scroll/);
      h.input("\x1b[5~");
      const page = await h.paint();
      const nav = h.state().navigation;
      assert.ok(nav.kind === "inspector" && nav.detail.kind === "ready" && nav.detail.transcript.follow === "paused");
      assert.notDeepEqual(page.filter(line => line.includes("paragraph")), before.filter(line => line.includes("paragraph")));
      h.input("\x1b[6~"); await h.paint();
      const tail = h.state().navigation;
      assert.ok(tail.kind === "inspector" && tail.detail.kind === "ready" && tail.detail.transcript.follow === "following");
      h.input("s"); h.input("guidance"); h.input("\x1b[13u"); await h.paint();
      assert.equal(h.state().dialog.kind, "submitting");
      assert.equal(Object.keys(h.state().pending).length, 1);
      h.input("\x1b[27u"); await h.paint();
      assert.equal(h.state().dialog.kind, "closed");
      assert.equal(Object.keys(h.state().pending).length, 1, "dismissal does not cancel an accepted dispatch");
    } finally { h.close(); }
  });
}

test("real alternate TUI routes wheel input to the transcript and preserves selection", async () => {
  const h = await terminalHarness("alternate");
  try {
    const before = await h.paint();
    const selected = () => {
      const nav = h.state().navigation;
      assert.ok(nav.kind === "inspector" && nav.detail.kind === "ready");
      return nav.detail;
    };
    assert.equal(selected().transcript.follow, "following");
    h.input("\x1b[<64;130;25M"); // SGR wheel up inside the transcript pane.
    const scrolled = await h.paint();
    assert.equal(selected().agentId, "b");
    assert.equal(selected().transcript.follow, "paused");
    assert.notDeepEqual(scrolled.filter(line => line.includes("paragraph")), before.filter(line => line.includes("paragraph")));
    h.input("\x1b[<65;130;25M"); await h.paint();
    assert.equal(selected().transcript.follow, "following");
    h.input("s"); await h.paint();
    const modal = h.state();
    h.input("\x1b[<64;130;25M"); await h.paint();
    assert.equal(h.state(), modal, "the wheel cannot navigate behind a composer");
    h.input("\x1b"); await h.paint();
    h.input("\x1b[<64;5;25M"); await h.paint();
    const nav = h.state().navigation;
    assert.ok(nav.kind === "inspector" && nav.detail.kind === "loading" && nav.detail.agentId === "a", "wheel over the roster selects an agent");
  } finally { h.close(); }
});

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
  assert.match(wide, /╭─ Agents · 2\/3 · 3 active ─+╮/);
  assert.match(wide, /╰─+╯/);
  assert.match(wide, /│ ○ a\s+│ b · running/, "wide terminals show the list beside the status header");
  assert.match(wide, /│ ● b\s+│ activity: /);
  assert.match(wide, /│ ○ c\s+│ ─{4,}/, "the divider separates the fixed header from the transcript");
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
    if (width >= 35) assert.match(plain(lines), /^Agents overlay requires a wider t/);
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

test("viewport sizing, dialogs, feedback, and Unicode preserve the complete frame", () => {
  for (const [rows, expected] of [[1, 1], [10, 10], [24, 18], [40, 24], [50, 30], [100, 61]]) assert.equal(inspectorHeight(rows!), expected);
  let s = inspectorState();
  s.snapshots[0]!.agent.name = "分析🧪".repeat(30);
  const states = [s, { ...s, feedback: "queued" }, transition(s, { type: "compose" }).state,
    transition(s, { type: "control", action: "stop", agentId: "b" }).state,
    transition(s, { type: "open", viewId: "list" }).state];
  for (const state of states) for (const width of [36, 60, 99, 100, 140, 300]) for (const height of [4, 6, 18, 30]) {
    const lines = new Inspector(() => state, () => {}, () => "id", () => height).render(width);
    assert.equal(lines.length, height);
    for (const line of lines) assert.equal(visibleWidth(line), width);
    for (const line of lines.slice(1, -1)) assert.equal(stripVTControlCharacters(line).at(-1), "│");
    if (height >= 18 && state.dialog.kind === "closed") assert.match(plain(lines), /Esc close/);
  }
});

test("navigation bounds take priority and excess width belongs to the transcript", () => {
  const state = inspectorState();
  const inspector = new Inspector(() => state, () => {}, () => "id");
  for (const width of [100, 101, 120, 140, 160, 300, 600]) {
    const lines = inspector.render(width);
    const divider = lines[1]!.indexOf("│", 1);
    const navigationWidth = divider - 3;
    const transcriptWidth = width - divider - 4;
    assert.ok(navigationWidth >= 20 && navigationWidth <= 40);
    assert.ok(transcriptWidth >= Math.ceil(width * 0.618));
    if (width >= 140) assert.equal(navigationWidth, 40);
    state.snapshots[0]!.agent.name = "long label ".repeat(100);
    assert.equal(inspector.render(width)[1]!.indexOf("│", 1), divider);
  }
  assert.match(plain(inspector.render(36)), /PgUp\/PgDn scroll/);
});

test("the selected roster row remains visible when the fleet exceeds the viewport", () => {
  const snapshots = Array.from({ length: 40 }, (_, i) => snapshot(`agent-${i}`));
  let s = transition(initialState(), { type: "activate", parentId: "p", epoch: "e", viewId: "v" }, snapshots).state;
  s = transition(s, { type: "open", viewId: "v1" }).state;
  s = transition(s, { type: "select-last", requestId: "last" }).state;
  for (const width of [60, 140]) {
    const lines = new Inspector(() => s, () => {}, () => "id", () => 18).render(width);
    assert.equal(lines.length, 18);
    assert.match(plain(lines), /● agent-39/);
  }
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
