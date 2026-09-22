import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionUIContext, KeybindingsManager as HostKeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, KeybindingsManager, TUI_KEYBINDINGS, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { SecretaryEditor, installFleetEditor } from "../../extensions/secretary/agents/ui/editor.ts";

const tui = { terminal: { rows: 30 }, requestRender() {} } as unknown as TUI;
const theme = { borderColor: (text: string) => text } as unknown as EditorTheme;
// The host passes its own KeybindingsManager; the double only needs `matches`.
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as HostKeybindingsManager;
const DOWN = "\x1b[B", UP = "\x1b[A";

const editor = () => new SecretaryEditor(tui, theme, keybindings);

test("Down at the last visual line is the fleet trigger, above it is not", () => {
  const empty = editor();
  assert.equal(empty.downAtLastLine(DOWN), true, "an empty editor is a single last line");
  assert.equal(empty.downAtLastLine(UP), false, "only the Down binding qualifies");
  assert.equal(empty.downAtLastLine("j"), false, "ordinary text never qualifies");
  // A kitty-protocol release carries the same key identity as its press (UX §2.2).
  assert.equal(empty.downAtLastLine("\x1b[1;1:3B"), false, "a key release is not a second press");
  assert.equal(empty.downAtLastLine("\x1b[1;1:1B"), true, "the press form of the same sequence still qualifies");

  const draft = editor();
  draft.setText("first line\nsecond line\nthird line");
  assert.equal(draft.downAtLastLine(DOWN), true, "setText leaves the caret on the last line");
  assert.equal(draft.caretAtLastLine(), true, "the hint predicate reads the same caret state");
  draft.handleInput(UP);
  assert.equal(draft.downAtLastLine(DOWN), false, "a caret above the last line keeps Down");
  assert.equal(draft.caretAtLastLine(), false, "the hint follows the caret as well as the key routing");
  draft.handleInput(UP);
  assert.equal(draft.downAtLastLine(DOWN), false);
  draft.handleInput(DOWN); draft.handleInput(DOWN);
  assert.equal(draft.downAtLastLine(DOWN), true, "Down reaches the last line again");
});

test("autocomplete and prompt-history browsing keep Down for themselves", () => {
  const completing = new (class extends SecretaryEditor {
    override isShowingAutocomplete(): boolean { return true; }
  })(tui, theme, keybindings);
  completing.setText("draft");
  assert.equal(completing.downAtLastLine(DOWN), false, "completion owns Down while its list is open");
  assert.equal(completing.caretAtLastLine(), false, "completion is never advertised as fleet focus");

  const history = editor();
  history.addToHistory("previous prompt");
  history.handleInput(UP);
  assert.equal(history.isShowingAutocomplete(), false);
  assert.equal(history.downAtLastLine(DOWN), false, "history browsing owns Down while it is active");
});

test("installFleetEditor adopts the host editor and restores the previous factory", () => {
  let factory: ((tui: TUI, theme: EditorTheme, keybindings: HostKeybindingsManager) => EditorComponent) | undefined;
  const ui = {
    getEditorComponent: () => factory,
    setEditorComponent(next?: typeof factory) { factory = next; },
  } as unknown as ExtensionUIContext;

  let created: SecretaryEditor | undefined;
  const restore = installFleetEditor(ui, next => { created = next; });
  assert.ok(factory, "the plugin factory is installed");
  const component = factory!(tui, theme, keybindings);
  assert.ok(component instanceof SecretaryEditor);
  assert.equal(created, component, "the callback receives the created editor");
  restore();
  assert.equal(factory, undefined, "restoring returns the built-in editor when none was configured");

  const previous = (tuiArg: TUI, themeArg: EditorTheme) => new Editor(tuiArg, themeArg);
  ui.setEditorComponent(previous);
  const restoreOver = installFleetEditor(ui, () => {});
  assert.notEqual(factory, previous);
  restoreOver();
  assert.equal(factory, previous, "another extension's editor is restored, not discarded");
});
