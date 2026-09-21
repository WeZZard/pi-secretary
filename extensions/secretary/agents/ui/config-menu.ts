import { join } from "node:path";
import {
  Input, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth,
  type Component, type Focusable,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { FALLBACK_LIST_NAME, loadAgentConfiguration, updateModelFallbackLists } from "../configuration.ts";

const MIN_WIDTH = 36;
const MAX_VISIBLE = 8;
const ADD_LIST = "＋ Add List";
const ADD_MODEL = "＋ Add Model";
const SECTION_ITEM = "Model Fallback Lists";

/** Keep the end of a long path visible when the full text exceeds the width. */
function clipTail(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let tail = "";
  for (const ch of [...text].reverse()) {
    if (visibleWidth(ch + tail) + 1 > width) break;
    tail = ch + tail;
  }
  return "…" + tail;
}

export interface SecretaryConfigMenuOptions {
  /** User configuration directory; the menu reads and writes only <agentDir>/secretary.json. */
  agentDir: string;
  /** Exact provider/modelId identifiers known to this session, in display order. */
  models: () => string[];
  onDismiss: () => void;
  theme?: Theme;
}

type Level =
  | { kind: "top"; selection: number }
  | { kind: "section"; selection: number }
  | { kind: "manager"; selection: number }
  | { kind: "detail"; list: string; selection: number };

type Modal =
  | { kind: "name"; input: Input; error?: string }
  | { kind: "rename"; list: string; input: Input; error?: string }
  | { kind: "picker"; list: string; input: Input; selection: number }
  | { kind: "confirmRemove"; list: string };

/**
 * The `/secretary` configuration page (interaction design §2.5, architecture §12.6.5).
 * Presented full-screen in pi's native selector style — a bold heading, muted
 * subtitles, filter inputs, `→` selection markers, and dimmed key-hint footers between
 * horizontal rules — with an internal level stack: top level, the Subagents section's
 * configuration items, the model fallback list manager, and per-list model detail,
 * plus name-prompt, rename, model-picker, and removal-confirmation pages. The menu reads and writes only the user-global secretary.json; every confirmed
 * change is validated and persisted before it is adopted, and there is no undo.
 */
export class SecretaryConfigMenu implements Component, Focusable {
  focused = true;
  private readonly options: SecretaryConfigMenuOptions;
  private lists: Record<string, string[]> = {};
  private readonly loadError?: string;
  private stack: Level[] = [{ kind: "top", selection: 0 }];
  private modal: Modal | undefined;
  private status?: { text: string; warning: boolean };

  constructor(options: SecretaryConfigMenuOptions) {
    this.options = options;
    try {
      this.lists = loadAgentConfiguration("", options.agentDir, false).modelFallbackLists;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  invalidate(): void {}

  private get level(): Level { return this.stack[this.stack.length - 1]!; }

  private listNames(): string[] { return Object.keys(this.lists); }

  private setStatus(text: string, warning = false): void { this.status = { text, warning }; }

  /**
   * Validate-then-write. The operation runs against the lists freshly re-read at the
   * persistence boundary, never against this menu's older in-memory copy, so a newer
   * external edit is not reverted; the in-memory view reloads only after persistence succeeds.
   */
  private mutate(update: (lists: Record<string, string[]>) => Record<string, string[]>, success: string): boolean {
    try {
      updateModelFallbackLists(this.options.agentDir, update);
      this.lists = loadAgentConfiguration("", this.options.agentDir, false).modelFallbackLists;
      this.setStatus(success);
      return true;
    } catch (error) {
      this.setStatus(`Not saved: ${error instanceof Error ? error.message : String(error)}`, true);
      return false;
    }
  }

  /** Picker candidates: session models not already in the list, fuzzy-filtered by the draft. */
  private pickerItems(modal: { list: string; input: Input }): string[] {
    const present = this.lists[modal.list] ?? [];
    const candidates = this.options.models().filter(id => !present.includes(id));
    const query = modal.input.getValue();
    return query ? fuzzyFilter(candidates, query, id => id) : candidates;
  }

  private openPicker(list: string): void {
    const present = this.lists[list] ?? [];
    if (!this.options.models().some(id => !present.includes(id))) {
      this.setStatus("All session models are already in this list.");
      return;
    }
    this.modal = { kind: "picker", list, input: new Input(), selection: 0 };
  }

  /** Shared name validation for the add and rename prompts. */
  private nameError(name: string): string | undefined {
    if (!name) return "Enter a list name.";
    if (!FALLBACK_LIST_NAME.test(name)) return "Use letters, digits, hyphens, and underscores; start with a letter or digit.";
    if (name === "inherit") return "inherit is reserved; choose another name.";
    if (Object.hasOwn(this.lists, name)) return `A list named "${name}" already exists.`;
    return undefined;
  }

  private submitName(modal: { kind: "name"; input: Input; error?: string }): void {
    const name = modal.input.getValue().trim();
    const error = this.nameError(name);
    if (error) { modal.error = error; return; }
    if (this.mutate(lists => {
      if (Object.hasOwn(lists, name)) throw new Error(`A list named "${name}" already exists.`);
      return { ...lists, [name]: [] };
    }, `Added list ${name}.`)) {
      this.modal = undefined;
      const level = this.level;
      if (level.kind === "manager") level.selection = this.listNames().indexOf(name);
    }
  }

  private openRename(list: string): void {
    const input = new Input();
    // Prefill with the current name through the public input API so the caret lands at the end.
    for (const ch of list) input.handleInput(ch);
    this.modal = { kind: "rename", list, input };
  }

  private submitRename(modal: { kind: "rename"; list: string; input: Input; error?: string }): void {
    const name = modal.input.getValue().trim();
    if (name === modal.list) { this.modal = undefined; return; }
    const error = this.nameError(name);
    if (error) { modal.error = error; return; }
    // Rebuild so the renamed list keeps its position in the manager.
    if (this.mutate(lists => {
      if (!Object.hasOwn(lists, modal.list)) throw new Error(`The list "${modal.list}" no longer exists; the configuration changed elsewhere.`);
      if (Object.hasOwn(lists, name)) throw new Error(`A list named "${name}" already exists.`);
      const next: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(lists)) next[key === modal.list ? name : key] = value;
      return next;
    }, `Renamed ${modal.list} to ${name}.`)) {
      this.modal = undefined;
      const level = this.level;
      if (level.kind === "manager") level.selection = this.listNames().indexOf(name);
    }
  }

  private removeList(name: string): void {
    if (this.mutate(lists => { const next = { ...lists }; delete next[name]; return next; }, `Removed list ${name}.`)) {
      this.modal = undefined;
      const level = this.level;
      if (level.kind === "manager") level.selection = Math.min(level.selection, Math.max(0, this.listNames().length - 1));
    }
  }

  private removeModel(list: string, index: number): void {
    const current = this.lists[list] ?? [];
    const id = current[index];
    if (id === undefined) return;
    if (this.mutate(lists => {
      const fresh = lists[list] ?? [];
      if (!fresh.includes(id)) throw new Error(`${id} is no longer in ${list}; the configuration changed elsewhere.`);
      return { ...lists, [list]: fresh.filter(entry => entry !== id) };
    }, `Removed ${id} from ${list}.`)) {
      const level = this.level;
      if (level.kind === "detail") level.selection = Math.min(index, Math.max(0, (this.lists[list] ?? []).length - 1));
    }
  }

  private moveModel(list: string, index: number, delta: -1 | 1): void {
    const current = this.lists[list] ?? [];
    const id = current[index];
    if (id === undefined) return;
    if (this.mutate(lists => {
      const fresh = [...(lists[list] ?? [])];
      const from = fresh.indexOf(id);
      if (from < 0) throw new Error(`${id} is no longer in ${list}; the configuration changed elsewhere.`);
      const target = from + delta;
      if (target < 0 || target >= fresh.length) throw new Error(`${id} cannot move ${delta < 0 ? "up" : "down"} in ${list}; the configuration changed elsewhere.`);
      [fresh[from], fresh[target]] = [fresh[target]!, fresh[from]!];
      return { ...lists, [list]: fresh };
    }, `Moved ${id} ${delta < 0 ? "up" : "down"}.`)) {
      const level = this.level;
      if (level.kind === "detail") level.selection = (this.lists[list] ?? []).indexOf(id);
    }
  }

  private openSelected(): void {
    const level = this.level;
    if (level.kind === "top") this.stack.push({ kind: "section", selection: 0 });
    else if (level.kind === "section") this.stack.push({ kind: "manager", selection: 0 });
    else if (level.kind === "manager") {
      const names = this.listNames();
      if (level.selection < names.length) this.stack.push({ kind: "detail", list: names[level.selection]!, selection: 0 });
      else this.modal = { kind: "name", input: new Input() };
    } else if (level.kind === "detail") {
      const models = this.lists[level.list] ?? [];
      if (level.selection >= models.length) this.openPicker(level.list);
    }
  }

  private navigate(data: string): void {
    const level = this.level;
    if (matchesKey(data, "escape")) { this.options.onDismiss(); return; }
    if (matchesKey(data, "left")) {
      if (this.stack.length > 1) this.stack.pop();
      return;
    }
    if (matchesKey(data, "right") || matchesKey(data, "enter")) { this.openSelected(); return; }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const rows = level.kind === "top" ? 1
        : level.kind === "section" ? 1
        : level.kind === "manager" ? this.listNames().length + 1
        : (this.lists[level.list] ?? []).length + 1;
      level.selection = Math.max(0, Math.min(rows - 1, level.selection + (matchesKey(data, "up") ? -1 : 1)));
      return;
    }
    if (data === "a") {
      if (level.kind === "manager") this.modal = { kind: "name", input: new Input() };
      else if (level.kind === "detail") this.openPicker(level.list);
      return;
    }
    if (data === "r" && level.kind === "manager") {
      const name = this.listNames()[level.selection];
      if (name !== undefined) this.openRename(name);
      return;
    }
    if (data === "d") {
      if (level.kind === "manager") {
        const name = this.listNames()[level.selection];
        if (name !== undefined) this.modal = { kind: "confirmRemove", list: name };
      } else if (level.kind === "detail") this.removeModel(level.list, level.selection);
      return;
    }
    if ((data === "K" || data === "J") && level.kind === "detail") {
      this.moveModel(level.list, level.selection, data === "K" ? -1 : 1);
    }
  }

  handleInput(data: string): void {
    if (this.loadError !== undefined) {
      if (matchesKey(data, "escape")) this.options.onDismiss();
      return;
    }
    const modal = this.modal;
    if (modal?.kind === "name" || modal?.kind === "rename") {
      modal.input.focused = this.focused;
      if (matchesKey(data, "escape")) this.modal = undefined;
      else if (matchesKey(data, "enter")) {
        if (modal.kind === "name") this.submitName(modal);
        else this.submitRename(modal);
      }
      else modal.input.handleInput(data);
      return;
    }
    if (modal?.kind === "picker") {
      modal.input.focused = this.focused;
      if (matchesKey(data, "escape")) { this.modal = undefined; return; }
      // Up/Down and Enter operate the candidate list; everything else edits the filter,
      // including Left/Right caret movement (interaction design §4).
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        const items = this.pickerItems(modal);
        if (items.length) {
          const delta = matchesKey(data, "up") ? -1 : 1;
          modal.selection = (modal.selection + delta + items.length) % items.length;
        }
        return;
      }
      if (matchesKey(data, "enter")) {
        const id = this.pickerItems(modal)[modal.selection];
        if (id === undefined) return;
        const list = modal.list;
        if (this.mutate(lists => {
          if (!Object.hasOwn(lists, list)) throw new Error(`The list "${list}" no longer exists; the configuration changed elsewhere.`);
          const fresh = lists[list] ?? [];
          if (fresh.includes(id)) throw new Error(`${id} is already in ${list}.`);
          return { ...lists, [list]: [...fresh, id] };
        }, `Added ${id} to ${list}.`)) {
          this.modal = undefined;
          const level = this.level;
          if (level.kind === "detail") level.selection = (this.lists[list] ?? []).length - 1;
        }
        return;
      }
      modal.input.handleInput(data);
      modal.selection = Math.min(modal.selection, Math.max(0, this.pickerItems(modal).length - 1));
      return;
    }
    if (modal?.kind === "confirmRemove") {
      if (matchesKey(data, "escape")) this.modal = undefined;
      else if (matchesKey(data, "enter")) this.removeList(modal.list);
      return;
    }
    this.navigate(data);
  }

  private title(): string {
    const modal = this.modal;
    if (modal?.kind === "name") return "Add List";
    if (modal?.kind === "rename") return "Rename List";
    if (modal?.kind === "picker") return `Add Model › ${modal.list}`;
    if (modal?.kind === "confirmRemove") return "Remove List";
    const level = this.level;
    if (level.kind === "top") return "Secretary";
    if (level.kind === "section") return "Secretary › Subagents";
    if (level.kind === "manager") return `Secretary › Subagents › ${SECTION_ITEM}`;
    return `Secretary › Subagents › ${SECTION_ITEM} › ${level.list}`;
  }

  // Rendering follows pi's native selector style (scoped-models selector): a horizontal
  // rule, a bold accent heading, muted subtitles, content rows with `→` selection
  // markers, an optional status line, dimmed key-hint footers, and a closing rule.

  private heading(text: string): string {
    const theme = this.options.theme;
    return theme ? theme.fg("accent", theme.bold(text)) : text;
  }

  private muted(text: string): string {
    const theme = this.options.theme;
    return theme ? theme.fg("muted", text) : text;
  }

  private dim(text: string): string {
    const theme = this.options.theme;
    return theme ? theme.fg("dim", text) : text;
  }

  private warn(text: string): string {
    const theme = this.options.theme;
    return theme ? theme.fg("warning", text) : text;
  }

  private marker(selected: boolean): string {
    const theme = this.options.theme;
    return selected ? (theme ? theme.fg("accent", "→ ") : "→ ") : "  ";
  }

  private plainRow(text: string, selected: boolean): string {
    const theme = this.options.theme;
    return this.marker(selected) + (selected && theme ? theme.fg("accent", text) : text);
  }

  private managerRow(name: string, selected: boolean): string {
    return this.plainRow(name, selected) + this.muted(`  ${(this.lists[name] ?? []).length} models`);
  }

  /** Models render as `modelId [provider]`, matching pi's native model selectors. */
  private modelRow(id: string, selected: boolean): string {
    const theme = this.options.theme;
    const slash = id.indexOf("/");
    const label = slash === -1 ? id : id.slice(slash + 1);
    const badge = slash === -1 ? "" : ` [${id.slice(0, slash)}]`;
    return this.marker(selected) + (selected && theme ? theme.fg("accent", label) : label) + this.muted(badge);
  }

  private body(width: number): { subtitles: string[]; rows: string[]; footer: string[] } {
    const modal = this.modal;
    if (modal?.kind === "name") {
      modal.input.focused = this.focused;
      return {
        subtitles: ["Name the fallback list."],
        rows: [modal.input.render(width)[0] ?? "", ...(modal.error ? [this.warn(modal.error)] : [])],
        footer: ["Enter confirm · Esc cancel"],
      };
    }
    if (modal?.kind === "rename") {
      modal.input.focused = this.focused;
      return {
        subtitles: ["Renaming preserves the list's models.", "Definitions that reference the old name fail at launch", "until they are updated."],
        rows: [modal.input.render(width)[0] ?? "", ...(modal.error ? [this.warn(modal.error)] : [])],
        footer: ["Enter confirm · Esc cancel"],
      };
    }
    if (modal?.kind === "picker") {
      modal.input.focused = this.focused;
      const items = this.pickerItems(modal);
      const rows = [modal.input.render(width)[0] ?? "", ""];
      if (!items.length) rows.push(this.muted("  No matching models"));
      else {
        const start = Math.max(0, Math.min(modal.selection - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE));
        const end = Math.min(start + MAX_VISIBLE, items.length);
        for (let index = start; index < end; index++) rows.push(this.modelRow(items[index]!, index === modal.selection));
        if (start > 0 || end < items.length) rows.push(this.muted(`  (${modal.selection + 1}/${items.length})`));
      }
      return { subtitles: [], rows, footer: ["Enter add", "↑/↓ select · Esc cancel"] };
    }
    if (modal?.kind === "confirmRemove") {
      return {
        subtitles: [],
        rows: [
          `Remove fallback list "${modal.list}"?`,
          this.muted("Definitions that reference it will fail at launch"),
          this.muted("until they are updated."),
        ],
        footer: ["Enter confirm · Esc cancel"],
      };
    }
    const level = this.level;
    if (level.kind === "top") {
      return {
        subtitles: ["Edits the user-global configuration only."],
        rows: [this.plainRow("Subagents", true)],
        footer: ["↑/↓ select · Enter/→ open · Esc dismiss"],
      };
    }
    if (level.kind === "section") {
      return {
        subtitles: [],
        rows: [this.plainRow(SECTION_ITEM, level.selection === 0)],
        footer: ["↑/↓ select · Enter/→ open · ← back · Esc dismiss"],
      };
    }
    if (level.kind === "manager") {
      const names = this.listNames();
      return {
        subtitles: ["Edits the user-global configuration only."],
        rows: [
          ...names.map((name, index) => this.managerRow(name, index === level.selection)),
          this.plainRow(ADD_LIST, level.selection === names.length),
        ],
        footer: ["a add list · r rename list · d remove list", "↑/↓ select · Enter/→ open · ← back · Esc dismiss"],
      };
    }
    const models = this.lists[level.list] ?? [];
    return {
      subtitles: ["Models are tried from first to last."],
      rows: [
        ...models.map((id, index) => this.modelRow(id, index === level.selection)),
        this.plainRow(ADD_MODEL, level.selection === models.length),
      ],
      footer: models.length
        ? ["a add · d remove · Shift+K/J move up/down", "↑/↓ select · Enter/→ open · ← back · Esc dismiss"]
        : ["Enter/→ add", "← back · Esc dismiss"],
    };
  }

  render(width: number): string[] {
    if (width < MIN_WIDTH) return ["Secretary configuration requires a wider terminal."];
    const theme = this.options.theme;
    const rule = "─".repeat(Math.max(1, width));
    const borderLine = theme ? theme.fg("border", rule) : rule;
    const lines = [borderLine, "", this.heading(this.title())];
    if (this.loadError !== undefined) {
      lines.push("",
        "The stored configuration is invalid:",
        clipTail(this.loadError, width),
        "Correct the file by hand; the menu cannot edit an unreadable configuration:",
        clipTail(join(this.options.agentDir, "secretary.json"), width),
        "", this.dim("  Esc dismiss"), borderLine);
      return lines.map(line => truncateToWidth(line, width, ""));
    }
    const { subtitles, rows, footer } = this.body(width);
    for (const subtitle of subtitles) lines.push(this.muted(subtitle));
    lines.push("", ...rows, "");
    if (this.status) {
      lines.push(this.status.warning ? this.warn(`  ${this.status.text}`) : this.muted(`  ${this.status.text}`));
    }
    for (const hint of footer) lines.push(this.dim(`  ${hint}`));
    lines.push(borderLine);
    return lines.map(line => truncateToWidth(line, width, ""));
  }
}

/** Headless `/secretary` response (interaction design §6): text, never a terminal component. */
export function headlessSecretaryConfig(agentDir: string): string {
  const path = join(agentDir, "secretary.json");
  let lists: Record<string, string[]>;
  try {
    lists = loadAgentConfiguration("", agentDir, false).modelFallbackLists;
  } catch (error) {
    return `Secretary configuration (user-global): ${path}\nThe stored configuration is invalid: ${error instanceof Error ? error.message : String(error)}\nEdit the file by hand; this command does not accept edits.`;
  }
  const names = Object.keys(lists);
  const summary = names.length
    ? names.map(name => `  ${name}: ${lists[name]!.length ? lists[name]!.join(", ") : "(no models)"}`).join("\n")
    : "  No model fallback lists configured.";
  return `Secretary configuration (user-global): ${path}\nModel fallback lists:\n${summary}\nThis command does not accept edits. Use /secretary in an interactive session to edit the user-global configuration.`;
}
