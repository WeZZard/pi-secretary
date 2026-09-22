import { CustomEditor, type ExtensionUIContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/**
 * The inherited pi-tui editor state this feature reads. pi-tui declares both members private, but
 * they remain reachable on a subclass instance at runtime. The adapter is feature-detected: a
 * renamed or removed member degrades to the logical-last-line check instead of throwing.
 */
interface EditorInternals {
  /** The visual line index for the caret; `-1` is never returned. */
  isOnLastVisualLine?: () => boolean;
  /** The prompt-history cursor; `-1` means the editor is not browsing history. */
  historyIndex?: number;
}

const internals = (editor: SecretaryEditor): EditorInternals => editor as unknown as EditorInternals;

/**
 * The prompt editor the fleet indicator depends on. It extends `CustomEditor` so the host keeps
 * the app keybindings, clipboard paste, and editor-border working indicator, and it answers the
 * one question the host does not expose: whether the Down key still has somewhere to move.
 *
 * `downAtLastLine` is true only when the caret sits on the last visual line of an idle editor.
 * Autocomplete keeps Down for its own list, and prompt-history browsing keeps Down for the next
 * entry, so the two host-owned uses of the key are never taken over (UX §2.2).
 */
export class SecretaryEditor extends CustomEditor {
  private readonly fleetKeybindings: KeybindingsManager;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.fleetKeybindings = keybindings;
  }

  /**
   * True when the caret cannot move any further down. The indicator hint reads this directly, so
   * the advertised action always matches what Down does in the same state.
   */
  caretAtLastLine(): boolean {
    if (this.isShowingAutocomplete()) return false;
    const state = internals(this);
    if (typeof state.historyIndex === "number" && state.historyIndex > -1) return false;
    if (typeof state.isOnLastVisualLine === "function") return state.isOnLastVisualLine();
    // Fallback when pi-tui renames the visual-line helper: treat the logical last line as the end.
    return this.getCursor().line >= Math.max(0, this.getLines().length - 1);
  }

  /** True when `data` is the editor's Down keypress and the caret cannot move any further down. */
  downAtLastLine(data: string): boolean {
    // A release event carries the same key identity as its press, so it must not count as one.
    return !isKeyRelease(data) && this.fleetKeybindings.matches(data, "tui.editor.cursorDown") && this.caretAtLastLine();
  }
}

/**
 * Install the fleet editor through the host's documented custom-editor extension point
 * (pi `docs/extensions.md`, "Custom editor"). The returned function restores the editor factory
 * that was configured before, so disposal returns the session to its previous editor.
 */
export function installFleetEditor(ui: ExtensionUIContext, onEditor: (editor: SecretaryEditor) => void): () => void {
  const previous = ui.getEditorComponent();
  ui.setEditorComponent((tui, theme, keybindings) => {
    const editor = new SecretaryEditor(tui, theme, keybindings);
    onEditor(editor);
    return editor;
  });
  return () => { ui.setEditorComponent(previous); };
}
