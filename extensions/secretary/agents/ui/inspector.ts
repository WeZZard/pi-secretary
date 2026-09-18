import { Input, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentSnapshot } from "../records.ts";
import type { UiEvent, UiState } from "./state.ts";
import { messageEligible, active } from "./reducer.ts";
import { clip, transcriptWindow } from "./transcript.ts";
import { statusGlyph } from "./glyphs.ts";
import { bindingLabel, matchesInspectorAction, resolveInspectorKeybindings, type ResolvedInspectorKeybindings, type InspectorKeybindingsConfig } from "./keybindings.ts";

const MIN_WIDTH = 36;
const PANE_SPLIT = 100;

export interface InspectorOptions {
  theme?: Theme;
  /** Configured overrides; the footer and input handling reflect the resolved keys. */
  keybindings?: InspectorKeybindingsConfig;
  /** The host's configured tool-expansion key also toggles tool details. */
  expandKey?: (data: string) => boolean;
}

/** The bordered inspector overlay (architecture §12.6.4). It emits reducer events only. */
export class Inspector implements Component, Focusable {
  private input = new Input();
  focused = true;
  private state: () => UiState;
  private dispatch: (e: UiEvent) => void;
  private id: () => string;
  private height: () => number;
  private expandKey?: (data: string) => boolean;
  private keys: ResolvedInspectorKeybindings;
  private theme?: Theme;
  private visibleTranscriptRows = 1;
  constructor(state: () => UiState, dispatch: (e: UiEvent) => void, id: () => string, height: () => number = () => 24, options: InspectorOptions | ((data: string) => boolean) = {}) {
    this.state = state; this.dispatch = dispatch; this.id = id; this.height = height;
    const resolved = typeof options === "function" ? { expandKey: options } : options;
    this.expandKey = resolved.expandKey;
    this.theme = resolved.theme;
    this.keys = resolveInspectorKeybindings(resolved.keybindings);
  }
  invalidate(): void {}
  private action(data: string, name: keyof ResolvedInspectorKeybindings): boolean {
    return matchesInspectorAction(data, this.keys, name) || (name === "toggleTools" && this.expandKey?.(data) === true);
  }
  handleInput(data: string): void {
    const s = this.state(), d = s.dialog;
    // A focused dialog owns Escape; it never falls through to the inspector in the same event.
    if (d.kind !== "closed" && data === "\x1b") { this.dispatch({ type: "escape" }); return; }
    if (d.kind === "composing") {
      if (this.input.getValue() !== d.draft) this.input.setValue(d.draft);
      if (data === "\r") this.dispatch({ type: "submit", operationId: this.id() });
      else { this.input.handleInput(data); this.dispatch({ type: "draft", text: this.input.getValue() }); }
      return;
    }
    if (d.kind !== "closed") {
      if (d.kind === "confirming" && data === "\r") this.dispatch({ type: "submit", operationId: this.id() });
      return;
    }
    if (this.action(data, "close")) { this.dispatch({ type: "escape" }); return; }
    const nav = s.navigation;
    if (nav.kind !== "inspector") return;
    const selected = nav.detail.kind === "list" ? undefined : nav.detail.agentId;
    if (this.action(data, "selectUp") || this.action(data, "selectDown")) {
      const idx = s.snapshots.findIndex(a => a.agent.agentId === selected), delta = this.action(data, "selectUp") ? -1 : 1;
      const next = s.snapshots[Math.max(0, Math.min(s.snapshots.length - 1, idx + delta))];
      if (next) this.dispatch({ type: "select", agentId: next.agent.agentId, requestId: this.id() });
    } else if (this.action(data, "selectFirst")) this.dispatch({ type: "select-first", requestId: this.id() });
    else if (this.action(data, "selectLast")) this.dispatch({ type: "select-last", requestId: this.id() });
    else if (this.action(data, "steer")) this.dispatch({ type: "compose" });
    else if (this.action(data, "stop") && selected) this.dispatch({ type: "control", action: "stop", agentId: selected });
    else if (this.action(data, "refresh") && selected) this.dispatch({ type: "select", agentId: selected, requestId: this.id() });
    else if (this.action(data, "toggleTools")) this.dispatch({ type: "expand" });
    else if (this.action(data, "pageUp") || this.action(data, "pageDown")) this.dispatch({ type: "scroll", delta: this.action(data, "pageUp") ? -this.visibleTranscriptRows : this.visibleTranscriptRows, pageSize: this.visibleTranscriptRows });
    else if (this.action(data, "scrollUp") || this.action(data, "scrollDown")) this.dispatch({ type: "scroll", delta: this.action(data, "scrollUp") ? -1 : 1, pageSize: this.visibleTranscriptRows });
  }
  private dialogRender(width: number): string[] | undefined {
    const s = this.state(), d = s.dialog;
    if (d.kind === "composing") {
      const recipient = s.snapshots.find(a => a.agent.agentId === d.agentId);
      this.input.focused = this.focused;
      if (this.input.getValue() !== d.draft) this.input.setValue(d.draft);
      const label = messageEligible(recipient) ? recipient && active(recipient) ? "Queue guidance" : "Resume conversation" : "Submission unavailable; draft retained";
      return [clip(`${label}: ${d.agentId}`, width), ...this.input.render(Math.max(1, width)).map(l => width <= 0 ? "" : l), clip(d.error ?? "Enter sends · Escape keeps draft", width)];
    }
    if (d.kind === "confirming") return [`Confirm ${d.target.action}: ${d.target.agentId}`, d.target.action === "stop" ? `Run: ${d.target.runId}. File changes are not rolled back.` : `Workspace: ${d.target.worktreeId}. Cleanup disables future resumption.`, "Enter confirms · Escape dismisses"].map(l => clip(l, width));
    if (d.kind === "submitting" || d.kind === "uncertain") return [`${d.kind}: ${d.operation.action} ${d.operation.agentId}`, `Operation: ${d.operation.id}`, ...(d.operation.action === "message" ? [d.operation.text] : []), d.kind === "uncertain" ? d.reason : "Waiting for acceptance; this is not completion.", "Escape dismisses without cancelling or retrying"].map(l => clip(l, width));
    return undefined;
  }
  private rosterRow(a: AgentSnapshot, selected: string | undefined, width: number): string {
    const status = a.run?.status ?? "idle";
    return clip(`${a.agent.agentId === selected ? ">" : " "} ${statusGlyph(status, this.theme)} ${a.agent.name ?? a.agent.agentId} · ${status}`, width);
  }
  private footer(selected: AgentSnapshot | undefined, width: number): string {
    const keys = this.keys;
    const label = (action: keyof ResolvedInspectorKeybindings) => bindingLabel(keys, action, { firstOnly: true });
    const close = `${label("close")} close`;
    const select = `${bindingLabel(keys, "selectUp", { firstOnly: true })}/${bindingLabel(keys, "selectDown", { firstOnly: true })} select`;
    const optional: string[] = [];
    if (selected) {
      if (messageEligible(selected)) optional.push(`${label("steer")} message`);
      if (active(selected)) optional.push(`${label("stop")} stop`);
      const nav = this.state().navigation;
      if (nav.kind === "inspector" && nav.detail.kind === "ready") optional.push(`${label("toggleTools")} tools`, `${label("refresh")} reload`);
    }
    // Close is never expendable; narrower footers drop transcript-action hints before navigation.
    const parts = [select, ...optional, close];
    while (parts.length > 2 && visibleWidth(parts.join(" · ")) > width) parts.splice(1, 1);
    return parts.join(" · ");
  }
  render(width: number): string[] {
    // Below the minimum width the inspector renders a single diagnostic line instead of panes.
    if (width < MIN_WIDTH) return [clip("Agents inspector requires a wider terminal.", width)];
    const dialog = this.dialogRender(width);
    if (dialog) return dialog;
    const s = this.state(), theme = this.theme;
    const nav = s.navigation;
    if (nav.kind !== "inspector") return [];
    const border = (text: string) => theme ? theme.fg("borderMuted", text) : text;
    const selected = nav.detail.kind === "list" ? undefined : nav.detail.agentId;
    const record = s.snapshots.find(a => a.agent.agentId === selected);
    const position = record ? `${s.snapshots.findIndex(a => a.agent.agentId === selected) + 1}/${s.snapshots.length}` : `0/${s.snapshots.length}`;
    const inner = width - 2;
    const title = clip(` Agents · ${position} `, inner - 1);
    const top = border("╭─") + title + border("─".repeat(Math.max(0, inner - 1 - visibleWidth(title)))) + border("╮");
    const bottom = border(`╰${"─".repeat(Math.max(0, inner))}╯`);
    const footer = clip(this.footer(record, inner - 2), inner - 1);
    const footerLine = border("│ ") + footer + " ".repeat(Math.max(0, inner - 2 - visibleWidth(footer))) + border(" │");
    const body: string[] = [];
    const wide = width >= PANE_SPLIT;
    const paneWidth = wide ? Math.max(24, Math.min(34, Math.floor(width * 0.3))) : width - 4;
    const detailWidth = wide ? inner - paneWidth - 3 : inner - 4;
    const details: string[] = [];
    if (record) {
      details.push(`${record.agent.agentId} · ${record.agent.model} · ${record.run?.status ?? "idle"}`);
      details.push(`Task: ${record.run?.description ?? ""}`);
      details.push(`Definition: ${record.agent.definition.source}`);
      details.push(`Output: ${record.run?.outputPath ?? "unavailable"}`);
      if (record.agent.worktree?.kind === "directory-snapshot") {
        details.push(`Directory snapshot: ${record.agent.worktree.path} (${record.agent.worktree.state})`, `Source: ${record.agent.worktree.repo}; reason: ${record.agent.worktree.reason}`, "Current files copied without Git metadata; this is not a security sandbox.");
      } else if (record.agent.worktree) {
        details.push(`Worktree: ${record.agent.worktree.path} (${record.agent.worktree.branch}; ${record.agent.worktree.state})`, `Base commit: ${record.agent.worktree.baseCommit}`, "Uncommitted parent changes are excluded; this is not a security sandbox.");
      } else details.push("Isolation: none; using the parent's working directory.");
    }
    if (nav.detail.kind === "loading") details.push("Loading transcript…");
    else if (nav.detail.kind === "unavailable") details.push(nav.detail.reason, `${bindingLabel(this.keys, "refresh")} retries`);
    else if (nav.detail.kind === "ready") {
      details.push(`Transcript: ${nav.detail.transcript.follow}`);
      if (nav.detail.transcript.expanded && record) details.push(`Original prompt: ${record.run?.prompt ?? ""}`, `Activity: ${record.run?.activity ?? "none"}`, `Definition hash: ${record.agent.definition.hash}`, `Outcome: ${record.run?.error ?? record.run?.status ?? "idle"}`);
    } else details.push(`Select an agent with ${bindingLabel(this.keys, "selectUp")}/${bindingLabel(this.keys, "selectDown")}.`);
    const roster = s.snapshots.map(a => this.rosterRow(a, selected, paneWidth));
    // Feedback is part of the operation contract, not expendable transcript overflow.
    const fixedRows = 2 /* rules */ + 1 /* footer */ + (s.feedback ? 1 : 0);
    const bodyHeight = Math.max(1, this.height() - fixedRows);
    const rosterRows = wide ? bodyHeight : Math.min(roster.length, Math.min(5, bodyHeight - 2));
    this.visibleTranscriptRows = Math.max(1, bodyHeight - (wide ? 0 : rosterRows) - details.length);
    const transcriptRows = nav.detail.kind === "ready" ? transcriptWindow(nav.detail.transcript, detailWidth, this.visibleTranscriptRows, theme) : [];
    const detailLines = [...details, ...transcriptRows];
    if (wide) {
      const rows = Math.max(roster.length, detailLines.length, 1);
      for (let i = 0; i < Math.min(rows, bodyHeight); i++) {
        const left = clip(roster[i] ?? "", paneWidth);
        const right = clip(detailLines[i] ?? "", detailWidth);
        const leftText = left + " ".repeat(Math.max(0, paneWidth - visibleWidth(left)));
        body.push(border("│ ") + leftText + border(" │ ") + right + " ".repeat(Math.max(0, width - 4 - paneWidth - visibleWidth(right))) + border(" │"));
      }
    } else {
      for (const line of [...roster.slice(0, rosterRows), ...detailLines].slice(0, bodyHeight)) {
        const clipped = clip(line, inner - 4);
        body.push(border("│ ") + clipped + " ".repeat(Math.max(0, inner - 2 - visibleWidth(clipped))) + border(" │"));
      }
    }
    const feedback = s.feedback ? border("│ ") + clip(s.feedback, inner - 4) + border(" │") : undefined;
    return [top, ...body, ...(feedback ? [feedback] : []), footerLine, bottom].map(l => truncateToWidth(l, width, ""));
  }
}
