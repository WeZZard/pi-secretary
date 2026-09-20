import test from "node:test";
import assert from "node:assert/strict";
import { TuiMainScreen, TuiAltScreen, Input, type Terminal, type Component } from "@earendil-works/pi-tui";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import type { AgentSnapshot } from "../../extensions/secretary/agents/records.ts";
import { registerAgentUI, type AgentUIPort } from "../../extensions/secretary/agents/ui/commands.ts";

function snapshot(id: string, parentId = "p", parentAgentId?: string): AgentSnapshot {
  return { agent: { agentId: id, parentId, parentAgentId, definition: { name: "general-purpose", description: "test", prompt: "test", source: "packaged", hash: "h", resumable: true }, model: "provider/model", tools: [], cwd: "/tmp", configCwd: "/tmp", sessionPath: "/tmp/session", resumable: true, createdAt: 0 }, run: { agentId: id, parentId, runId: `${id}-run`, launchKey: id, prompt: "task", description: "task", status: "running", background: true, createdAt: 0, outputPath: "/tmp/output", output: "", toolCount: 0, turnCount: 0, revision: 0 } };
}

// Only the service and ExtensionContext facade are fixtures. Input listeners, focus,
// overlay routing, Inspector, reducer, effect dispatch, and terminal rendering are real.
function harness(mode: "main" | "alternate") {
  const screen = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  let input = (_data: string) => {}, output = "";
  const terminal: Terminal = {
    columns: 120, rows: 40, kittyProtocolActive: false,
    start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write(data) { output += data; },
    moveBy(n) { this.write(n < 0 ? `\x1b[${-n}A` : `\x1b[${n}B`); }, hideCursor() {}, showCursor() {},
    clearLine() { this.write("\x1b[2K"); }, clearFromCursor() { this.write("\x1b[J"); }, clearScreen() { this.write("\x1b[2J\x1b[H"); }, setTitle() {}, setProgress() {},
  };
  const tui = mode === "main" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  const editor = new Input();
  let widget: Component | undefined;
  const hooks: Record<string, () => void> = {};
  const commands: Record<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }> = {};
  let records = [snapshot("a"), snapshot("b"), snapshot("child", "p", "a"), snapshot("foreign", "other")];
  const listeners = new Set<() => void>();
  const stopped: string[] = [];
  const port: AgentUIPort = { list: () => records, transcript: async () => [], message: async () => {}, cleanup: async () => {},
    stop: async runId => { stopped.push(runId); return { outcome: "accepted", message: "Cancellation requested; waiting for terminal status." }; },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "p" }, ui: {
    setWidget(_key: string, factory?: () => Component) { widget = factory?.(); tui.requestRender(); },
    getEditorText: () => editor.getValue(), notify() {},
    onTerminalInput: (fn: Parameters<typeof tui.addInputListener>[0]) => tui.addInputListener(fn),
    custom: (factory: (host: typeof tui, theme: unknown, kb: KeybindingsManager, done: () => void) => Component, options: { overlayOptions: object }) => new Promise<void>(resolve => {
      hooks.ui_prompt_start?.();
      const component = factory(tui, undefined, new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tools" } }), () => { handle.hide(); hooks.ui_prompt_end?.(); resolve(); });
      const handle = tui.showOverlay(component, options.overlayOptions);
    }),
  } } as unknown as ExtensionContext;
  const pi = { on(name: string, fn: () => void) { hooks[name] = fn; }, registerCommand(name: string, command: typeof commands[string]) { commands[name] = command; } } as unknown as ExtensionAPI;
  tui.addChild(editor); tui.addChild({ render: width => widget?.render(width) ?? [], invalidate() {} });
  tui.setFocus(editor); tui.start();
  const ui = registerAgentUI(pi, port); ui.bind(ctx);
  const hostKeys: string[] = [];
  tui.addInputListener(data => { hostKeys.push(data); return undefined; });
  const paint = async () => {
    tui.requestRender(); await new Promise(resolve => setTimeout(resolve, 30));
    const data = output; output = ""; await new Promise<void>(resolve => screen.write(data, resolve));
    return Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(screen.buffer.active.viewportY + i)!.translateToString(true)).join("\n");
  };
  return { paint, input: (data: string) => input(data), editor, stopped, port, hostKeys,
    widget: () => widget?.render(120).join("\n") ?? "",
    update: (next: AgentSnapshot[]) => { records = next; for (const fn of listeners) fn(); },
    records: () => structuredClone(records), hooks,
    open: () => { void commands.agents!.handler("a", ctx); },
    close: () => { ui.dispose(); tui.stop(); screen.dispose(); },
  };
}

test("idle Ctrl+X and other modal input reach the host; editor and composer drafts are preserved", async () => {
  const h = harness("main");
  try {
    h.hooks.ui_prompt_start!(); h.input("\x18"); h.input("X"); h.hooks.ui_prompt_end!();
    assert.equal(h.editor.getValue(), "X"); assert.deepEqual(h.stopped, []);
    assert.deepEqual(h.hostKeys, ["\x18", "X"], "an unrelated modal owns its shortcuts");
    h.open(); await h.paint(); h.input("s"); h.input("draft xX"); h.input("\x18");
    assert.match(await h.paint(), /draft xX/); assert.deepEqual(h.stopped, []);
    h.input("\x1b"); await h.paint(); h.input("s"); assert.match(await h.paint(), /draft xX/);
    h.input("\x1b"); h.input("\x1b"); await h.paint();
    h.update([]); h.input("\x18"); await h.paint();
    assert.equal(h.widget(), ""); assert.deepEqual(h.stopped, []);
    assert.equal(h.hostKeys.at(-1), "\x18", "idle Ctrl+X reaches host copy routing");
  } finally { h.close(); }
});

test("captured batch skips replacement and terminal runs without adding new admissions", async () => {
  const h = harness("main");
  try {
    h.input("\x18"); await h.paint();
    const records = h.records(); records.find(s => s.agent.agentId === "a")!.run!.runId = "replacement";
    records.push(snapshot("new")); h.update(records);
    h.input("\r"); await h.paint(); assert.deepEqual(h.stopped, ["b-run"]);
  } finally { h.close(); }
});

test("a departed selected row cannot redirect X to another agent", async () => {
  const h = harness("main");
  try {
    h.input("\x1b[B"); h.input("\x1b[B");
    h.update(h.records().filter(s => s.agent.agentId !== "a")); h.input("x");
    assert.doesNotMatch(await h.paint(), /Confirm stop/); assert.deepEqual(h.stopped, []);
  } finally { h.close(); }
});

test("unresolved batch blocks duplicate selected and fleet cancellation after dismissal, then reconciles its receipt", async () => {
  const h = harness("main"); let calls = 0, accepted = false;
  h.port.stopMany = async () => { calls++; throw new Error("Lost acknowledgment"); };
  h.port.receipt = () => accepted ? { outcome: "accepted", message: "Cancellation acceptance recorded, not completion." } : undefined;
  try {
    h.open(); await h.paint(); h.input("\x18"); h.input("\r");
    assert.match(await h.paint(), /uncertain: stop-all/);
    h.input("\x1b"); h.input("x");
    assert.match(await h.paint(), /uncertain: stop-all/); h.input("\r"); assert.equal(calls, 1);
    h.input("\x1b"); h.input("\x18"); assert.match(await h.paint(), /uncertain: stop-all/);
    accepted = true; h.update(h.records()); assert.match(await h.paint(), /Cancellation acceptance recorded/);
    assert.equal(calls, 1);
  } finally { h.close(); }
});

for (const mode of ["main", "alternate"] as const) {
  test(`real ${mode} routing: X confirms selected cancellation without intercepting editor text`, async () => {
    const h = harness(mode);
    try {
      h.input("x"); assert.equal(h.editor.getValue(), "x"); h.editor.setValue("");
      h.input("\x1b[B"); h.input("\x1b[B"); h.input("X");
      assert.match(await h.paint(), /Confirm stop: a/);
      assert.deepEqual(h.stopped, []);
      h.input("\r"); await h.paint();
      assert.deepEqual(h.stopped, ["a-run"]);
      assert.match(h.widget(), /a · running/, "acceptance must not invent a terminal status");
    } finally { h.close(); }
  });
  test(`real ${mode} routing: Ctrl+X captures this parent fleet and excludes later admissions`, async () => {
    const h = harness(mode);
    try {
      h.editor.setValue("keep draft"); h.input("\x18");
      assert.match(await h.paint(), /Confirm stop all/);
      assert.deepEqual(h.stopped, []);
      h.update([...h.records(), snapshot("new")]);
      h.input("\r"); await h.paint();
      assert.deepEqual(h.stopped.sort(), ["a-run", "b-run"]);
      assert.equal(h.editor.getValue(), "keep draft");
    } finally { h.close(); }
  });
  test(`real ${mode} routing: overlay X and Ctrl+X keep confirmation ownership`, async () => {
    const h = harness(mode);
    try {
      h.open(); await h.paint(); h.input("x");
      assert.match(await h.paint(), /Confirm stop: a/);
      h.input("\x18"); assert.match(await h.paint(), /Confirm stop: a/);
      h.input("\x1b"); await h.paint(); h.input("\x18");
      assert.match(await h.paint(), /Confirm stop all/);
      h.input("\x1b"); await h.paint(); assert.deepEqual(h.stopped, []);
    } finally { h.close(); }
  });
  test(`real ${mode} rendering: active bottom list always advertises cancellation and idle stays hidden`, async () => {
    const h = harness(mode);
    try {
      const screen = await h.paint();
      assert.match(screen, /X.*selected/); assert.match(screen, /Ctrl\+X.*all/);
      h.update([]); await h.paint(); assert.equal(h.widget(), "");
    } finally { h.close(); }
  });
}
