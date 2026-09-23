import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, KeybindingsManager, TUI_KEYBINDINGS, type Component, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AgentSnapshot, RunningChild } from "../../extensions/secretary/agents/records.ts";
import { AgentService } from "../../extensions/secretary/agents/service.ts";
import { defaultAgentUi } from "../../extensions/secretary/agents/configuration.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { transition } from "../../extensions/secretary/agents/ui/reducer.ts";
import { initialState, type UiEvent, type UiEffect } from "../../extensions/secretary/agents/ui/state.ts";
import { runEffect, type AgentUIPort } from "../../extensions/secretary/agents/ui/effects.ts";
import type { TranscriptEvent } from "../../extensions/secretary/agents/ui/transcript-events.ts";
import { Inspector } from "../../extensions/secretary/agents/ui/inspector.ts";
import { FleetView } from "../../extensions/secretary/agents/ui/fleet-view.ts";
import { registerAgentUI, FLEET_WIDGET_KEY } from "../../extensions/secretary/agents/ui/commands.ts";
import { deferred, tick } from "./support.ts";

export function snapshot(id = "a", parentId = "p"): AgentSnapshot {
  return { agent: { agentId: id, parentId, definition: { name: "worker", description: "Test worker", prompt: "Inspect", source: "packaged", hash: "fixture", resumable: true }, model: "test/model", tools: ["read"], cwd: "/tmp", configCwd: "/tmp", sessionPath: `/tmp/${id}.jsonl`, resumable: true, createdAt: 0, worktree: { id: `${id}-wt`, repo: "/repo", path: `/worktrees/${id}`, branch: `agent/${id}`, baseCommit: "base", state: "allocated" } }, run: { agentId: id, parentId, runId: `${id}-run`, launchKey: id, prompt: "Inspect files", description: `${id} inspection`, status: "running", background: true, createdAt: 0, outputPath: `/output/${id}.txt`, output: "", toolCount: 0, turnCount: 0, revision: 0 } };
}
export const markdown = Array.from({ length: 30 }, (_, i) => `<!-- secretary-entry:entry-${i} -->\n## assistant\n\nRetained paragraph ${i}.\n`).join("\n");
/** Structured fixture events, one stable entry id per event, replacing the legacy markdown transcript. */
export const fixtureEvents: readonly TranscriptEvent[] = Array.from({ length: 30 }, (_, i) => ({ kind: "assistant" as const, entryId: `entry-${i}`, text: `Retained paragraph ${i}.` }));
export const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n").replaceAll("\x1b_pi:c\x07", ""));

export class UIHarness {
  state = initialState();
  effects: UiEffect[] = [];
  events: UiEvent[] = [];
  sequence = 0;
  height = 30;
  inspector = new Inspector(() => this.state, e => this.send(e), () => `input-${++this.sequence}`, () => this.height);
  fleet = new FleetView(() => this.state);
  constructor(snapshots = [snapshot(), snapshot("b")]) {
    this.send({ type: "activate", parentId: snapshots[0]?.agent.parentId ?? "p", epoch: "e", viewId: "v" }, snapshots);
  }
  send(event: UiEvent, snapshots = this.state.snapshots) {
    this.events.push(event);
    const result = transition(this.state, event, snapshots);
    this.state = result.state; this.effects.push(...result.effects);
    return result.effects;
  }
  open(id = this.state.snapshots[0]!.agent.agentId) {
    this.send({ type: "open", viewId: "view" });
    return this.select(id);
  }
  select(agentId: string) { return this.send({ type: "select", agentId, requestId: `load-${++this.sequence}` }).find(e => e.type === "load")!; }
  ready(events: readonly TranscriptEvent[] = fixtureEvents) {
    const load = this.open(); assert.equal(load.type, "load");
    this.send({ ...load, type: "transcript", events }); return this;
  }
  transcript() { const nav = this.state.navigation; assert.equal(nav.kind, "inspector"); if (nav.kind !== "inspector") throw new Error("Not inspecting"); assert.equal(nav.detail.kind, "ready"); if (nav.detail.kind !== "ready") throw new Error("Not ready"); return nav.detail.transcript; }
  compose(text = "Check the edge cases") { this.inspector.handleInput("s"); this.send({ type: "draft", text }); }
  submit() { const effects = this.send({ type: "submit", operationId: `op-${++this.sequence}` }); const op = effects.find(e => e.type === "operate"); assert.ok(op); return op; }
  render(width = 120) { return plain(this.inspector.render(width)); }
  async execute(effect: UiEffect, port: AgentUIPort) { await runEffect(effect, port, event => this.send(event)); }
}
export function port(overrides: Partial<AgentUIPort> = {}): AgentUIPort {
  return { list: () => [snapshot(), snapshot("b")], subscribe: () => () => {}, transcript: async () => fixtureEvents,
    message: async () => { throw new Error("Unexpected message mutation"); }, stop: async () => { throw new Error("Unexpected stop mutation"); }, cleanup: async () => { throw new Error("Unexpected cleanup mutation"); }, ...overrides };
}

// This is an ExtensionUI contract double, not a DOM, PTY, or real terminal.
// Production components and key routing run unchanged; only host callbacks are captured.
export function adapter(t: TestContext, servicePort = port()) {
  let input: ((data: string) => unknown) | undefined;
  let parentId = "p", inspector: Inspector | undefined, fleet: FleetView | undefined;
  let opens = 0, closes = 0, removals = 0, modelTurns = 0;
  // The host keeps one default editor instance across custom-editor swaps and copies the text into
  // each replacement. The double mirrors that so a session rebind does not lose the draft.
  const editorTui = { terminal: { rows: 30 }, requestRender() {} } as unknown as TUI;
  const editorTheme = { borderColor: (text: string) => text } as unknown as EditorTheme;
  const editorKeys = new KeybindingsManager(TUI_KEYBINDINGS);
  const defaultEditor: EditorComponent = new Editor(editorTui, editorTheme);
  let editorFactory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined;
  let editor: EditorComponent = defaultEditor;
  const hooks = new Map<string, () => void>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const pi = { on(name: string, callback: () => void) { hooks.set(name, callback); }, registerCommand(name: string, command: any) { commands.set(name, command); }, sendMessage() { modelTurns++; } } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => parentId }, ui: {
    setWidget(key: string, factory: (() => Component) | undefined, options?: { placement: string }) {
      assert.equal(key, FLEET_WIDGET_KEY, "the unified indicator is the only registered widget");
      if (factory) { assert.equal(options?.placement, "belowEditor"); fleet = factory() as FleetView; } else fleet = undefined;
    },
    getEditorText: () => editor.getText(),
    setEditorComponent(factory?: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined) {
      const current = editor.getText();
      editorFactory = factory;
      editor = factory ? factory(editorTui, editorTheme, editorKeys) : defaultEditor;
      editor.setText(current);
    },
    getEditorComponent: () => editorFactory,
    onTerminalInput(callback: (data: string) => unknown) { input = callback; return () => { removals++; input = undefined; }; },
    notify() {},
    custom(factory: any) { opens++; const done = deferred<void>(); let closed = false; inspector = factory({ requestRender() {}, terminal: { rows: 30 } }, {}, { matches: () => false }, () => { if (!closed) { closed = true; closes++; inspector = undefined; done.resolve(); } }); return done.promise; },
  } } as unknown as ExtensionContext;
  const ui = registerAgentUI(pi, servicePort); ui.bind(ctx); t.after(() => ui.dispose());
  return {
    get editor() { return editor.getText(); }, set editor(value: string) { editor.setText(value); },
    get inspector() { return inspector; }, get opens() { return opens; }, get closes() { return closes; }, get removals() { return removals; }, get modelTurns() { return modelTurns; },
    // Raw terminal input reaches the extension hook first; the focused editor sees only what the
    // hook leaves unconsumed, and an open overlay owns focus instead of the editor.
    input: (data: string) => { const result = input?.(data); const consumed = !!result && typeof result === "object" && (result as { consume?: boolean }).consume === true; if (!consumed && !inspector) editor.handleInput(data); return result; },
    prompt: (open: boolean) => hooks.get(open ? "ui_prompt_start" : "ui_prompt_end")!(),
    fleet: () => plain(fleet?.render(120) ?? []), render: (width = 120) => plain(inspector?.render(width) ?? []),
    command: (args: string) => commands.get("agents")!.handler(args, ctx),
    replaceSession(id: string, draft: string) { parentId = id; editor.setText(draft); ui.bind(ctx); },
  };
}

// Real service and SQLite receipts; deterministic child transport only (no model/network).
export async function durableService(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "acceptance-ui-")), db = new DatabaseSync(":memory:");
  const repository = new AgentRepository(db);
  let starts = 0;
  const delivered: string[] = [];
  const service = new AgentService({ parentId: "p", root, repository, ctx: { cwd: root, mode: "tui" } as ExtensionContext,
    config: { modelFallbackLists: {}, subagentModels: {}, ui: defaultAgentUi(), maxConcurrent: 2, maxQueued: 2, shutdownTimeoutMs: 1000, maxNestingDepth: 3 },
    runner: async options => {
      starts++; const result = deferred<Awaited<RunningChild["result"]>>();
      const path = join(root, `${options.agent.agentId}.jsonl`); writeFileSync(path, '{"type":"session"}\n'); options.hooks.session(path);
      return { result: result.promise, steer: async text => { delivered.push(text); }, abort: async () => result.resolve({ status: "cancelled", output: "" }), dispose: async () => {} };
    },
  });
  t.after(async () => { await service.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const definition = snapshot().agent.definition;
  for (const launchKey of ["a", "b"]) await service.launch({ launchKey, definition, model: "test/model", tools: ["read"], prompt: "Inspect", description: launchKey, background: true });
  await tick();
  const servicePort: AgentUIPort = { list: () => service.list(), subscribe: cb => service.subscribe(cb), transcript: id => service.transcript(id), message: (id, text, op) => service.message(id, text, op), stop: (id, op) => service.stop(id, op), cleanup: (id, op) => service.cleanup(id, op), receipt: id => service.receipt(id) ? { outcome: "accepted", message: "Operation acceptance is recorded." } : undefined };
  return { service, repository, port: servicePort, delivered, starts: () => starts };
}
