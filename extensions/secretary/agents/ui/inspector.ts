import { Input, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentRowView, AgentSnapshot } from "../records.ts";
import type { InspectorLevel, UiEvent, UiState } from "./state.ts";
import { messageEligible, active, overlayRows } from "./reducer.ts";
import { clip, transcriptWindow } from "./transcript.ts";
import { selectionCircle } from "./glyphs.ts";
import { formatElapsed, formatUsageLabels } from "./usage-labels.ts";
import { CANCELLATION_HINT, matchesStopAll, matchesStopSelected, bindingLabel, matchesInspectorAction, resolveInspectorKeybindings, type ResolvedInspectorKeybindings, type InspectorKeybindingsConfig } from "./keybindings.ts";

const MIN_WIDTH = 36;
const PANE_SPLIT = 100;
const LIST_MIN_WIDTH = 20;
const LIST_MAX_WIDTH = 40;
const VIEWPORT_RATIO = 0.618;

/** The minimum yields only to the physical terminal height (architecture §12.6.4). */
export function inspectorHeight(terminalRows: number): number {
  return Math.max(1, Math.min(terminalRows, Math.max(18, Math.floor(terminalRows * VIEWPORT_RATIO))));
}

export interface InspectorOptions {
  theme?: Theme;
  /** Configured overrides; the footer and input handling reflect the resolved keys. */
  keybindings?: InspectorKeybindingsConfig;
  /** The host's configured tool-expansion key also toggles tool details. */
  expandKey?: (data: string) => boolean;
  /** Service view-model rows supply the status header's stats (§12.6.3). */
  rows?: () => readonly AgentRowView[];
  now?: () => number;
}

/** The bordered fleet view overlay (architecture §12.6.4). It emits reducer events only. */
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
  private viewRows?: () => readonly AgentRowView[];
  private now: () => number;
  private visibleTranscriptRows = 1;
  private transcriptPaneX = 0;
  constructor(state: () => UiState, dispatch: (e: UiEvent) => void, id: () => string, height: () => number = () => 24, options: InspectorOptions | ((data: string) => boolean) = {}) {
    this.state = state; this.dispatch = dispatch; this.id = id; this.height = height;
    const resolved = typeof options === "function" ? { expandKey: options } : options;
    this.expandKey = resolved.expandKey;
    this.theme = resolved.theme;
    this.viewRows = resolved.rows;
    this.now = resolved.now ?? Date.now;
    this.keys = resolveInspectorKeybindings(resolved.keybindings);
  }
  invalidate(): void {}
  private action(data: string, name: keyof ResolvedInspectorKeybindings): boolean {
    return matchesInspectorAction(data, this.keys, name) || (name === "toggleTools" && this.expandKey?.(data) === true);
  }
  private level(): InspectorLevel {
    const nav = this.state().navigation;
    return nav.kind === "inspector" ? nav.detail.level : { path: [], includeFinished: false };
  }
  handleInput(data: string): void {
    const s = this.state(), d = s.dialog;
    // A focused dialog owns Escape; it never falls through to the overlay in the same event.
    if (d.kind !== "closed" && matchesKey(data, "escape")) { this.dispatch({ type: "escape" }); return; }
    if (d.kind === "composing") {
      if (this.input.getValue() !== d.draft) this.input.setValue(d.draft);
      if (matchesKey(data, "enter")) this.dispatch({ type: "submit", operationId: this.id() });
      else { this.input.handleInput(data); this.dispatch({ type: "draft", text: this.input.getValue() }); }
      return;
    }
    if (d.kind !== "closed") {
      if (d.kind === "confirming" && matchesKey(data, "enter")) this.dispatch({ type: "submit", operationId: this.id() });
      return;
    }
    if (matchesStopAll(data)) { this.dispatch({ type: "stop-all", operationId: this.id() }); return; }
    if (matchesStopSelected(data)) {
      const nav = s.navigation;
      if (nav.kind === "inspector" && nav.detail.kind !== "list") this.dispatch({ type: "stop", agentId: nav.detail.agentId, operationId: this.id() });
      return;
    }
    if (this.action(data, "close")) { this.dispatch({ type: "escape" }); return; }
    const nav = s.navigation;
    if (nav.kind !== "inspector") return;
    const rows = overlayRows(s, nav.detail.level);
    const selected = nav.detail.kind === "list" ? undefined : nav.detail.agentId;
    if (this.action(data, "selectUp") || this.action(data, "selectDown")) {
      const idx = rows.findIndex(a => a.agent.agentId === selected), delta = this.action(data, "selectUp") ? -1 : 1;
      const next = rows[Math.max(0, Math.min(rows.length - 1, idx + delta))];
      if (next) this.dispatch({ type: "select", agentId: next.agent.agentId, requestId: this.id() });
    } else if (this.action(data, "selectFirst")) this.dispatch({ type: "select-first", requestId: this.id() });
    else if (this.action(data, "selectLast")) this.dispatch({ type: "select-last", requestId: this.id() });
    else if (this.action(data, "drillIn") && selected) this.dispatch({ type: "drill-in", requestId: this.id() });
    else if (this.action(data, "drillOut")) this.dispatch({ type: "drill-out", requestId: this.id() });
    else if (this.action(data, "toggleFinished")) this.dispatch({ type: "toggle-finished", requestId: this.id() });
    else if (this.action(data, "steer")) this.dispatch({ type: "compose" });
    else if (this.action(data, "stop") && selected) this.dispatch({ type: "stop", agentId: selected, operationId: this.id() });
    else if (this.action(data, "refresh") && selected) this.dispatch({ type: "select", agentId: selected, requestId: this.id() });
    else if (this.action(data, "toggleTools")) this.dispatch({ type: "expand" });
    else if (this.action(data, "pageUp") || this.action(data, "pageDown")) this.dispatch({ type: "scroll", delta: this.action(data, "pageUp") ? -this.visibleTranscriptRows : this.visibleTranscriptRows, pageSize: this.visibleTranscriptRows });
    else if (this.action(data, "scrollUp") || this.action(data, "scrollDown")) this.dispatch({ type: "scroll", delta: this.action(data, "scrollUp") ? -1 : 1, pageSize: this.visibleTranscriptRows });
  }
  /**
   * Optional host-dependent enhancement (UX §2.4): the wheel scrolls the transcript pane and moves
   * the selection over the list pane. Both reuse the existing reducer events and add no states.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    const s = this.state();
    // A modal owns wheel input too; do not let the host forward its raw sequence to Input.
    if (s.dialog.kind !== "closed") return { handled: true };
    if (s.navigation.kind !== "inspector") return undefined;
    const nav = s.navigation;
    const delta = event.wheelDelta;
    if (event.x < this.transcriptPaneX) {
      const rows = overlayRows(s, nav.detail.level);
      const selected = nav.detail.kind === "list" ? undefined : nav.detail.agentId;
      const idx = rows.findIndex(a => a.agent.agentId === selected);
      const next = rows[Math.max(0, Math.min(rows.length - 1, idx + Math.sign(delta)))];
      if (next && next.agent.agentId !== selected) this.dispatch({ type: "select", agentId: next.agent.agentId, requestId: this.id() });
      return { handled: true };
    }
    if (nav.detail.kind === "ready") this.dispatch({ type: "scroll", delta, pageSize: this.visibleTranscriptRows });
    return { handled: true };
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
    if (d.kind === "confirming") return [`Confirm ${d.target.action}: ${d.target.agentId}`, `Workspace: ${d.target.worktreeId}. Cleanup disables future resumption.`, "Enter confirms · Escape dismisses"].map(l => clip(l, width));
    if (d.kind === "submitting" || d.kind === "uncertain") return [`${d.kind}: ${d.operation.action} ${d.operation.agentId}`, `Operation: ${d.operation.id}`, ...(d.operation.action === "message" ? [d.operation.text] : []), d.kind === "uncertain" ? d.reason : "Waiting for acceptance; this is not completion.", "Escape dismisses without cancelling or retrying"].map(l => clip(l, width));
    return undefined;
  }
  private rosterRow(a: AgentSnapshot, selected: string | undefined, width: number): string {
    return clip(`${selectionCircle(a.agent.agentId === selected, this.theme)} ${a.agent.name ?? a.agent.agentId}`, width);
  }
  /** The bounded breadcrumb: the root label, the current level, and its nearest ancestor (UX §2.4). */
  private breadcrumb(level: InspectorLevel): string {
    const s = this.state();
    const names = level.path.map(id => s.snapshots.find(a => a.agent.agentId === id)?.agent.name ?? id);
    const segments = ["Agents", ...names];
    const bounded = segments.length > 3 ? [segments[0]!, "…", segments.at(-2)!, segments.at(-1)!] : segments;
    return bounded.join(" › ");
  }
  /** The fixed status header above the transcript viewport: name, status, stats, activity (UX §2.4). */
  private statusHeader(record: AgentSnapshot, width: number): string[] {
    const theme = this.theme;
    const vm = this.viewRows?.().find(row => row.agentId === record.agent.agentId);
    const status = record.run?.status ?? "idle";
    const stats = [formatElapsed(vm?.startedAt ?? record.run?.startedAt, this.now()), ...formatUsageLabels(vm ?? {})].filter(Boolean).join(" · ");
    const name = theme ? theme.bold(record.agent.name ?? record.agent.agentId) : record.agent.name ?? record.agent.agentId;
    const first = clip(`${name} · ${status}${stats ? ` · ${stats}` : ""}`, width);
    const activity = record.run?.activity ?? (status === "running" ? "thinking…" : status === "queued" ? "queued…" : "none");
    const second = clip(theme ? theme.fg("dim", `activity: ${activity}`) : `activity: ${activity}`, width);
    const divider = theme ? theme.fg("dim", "─".repeat(Math.max(1, width))) : "─".repeat(Math.max(1, width));
    return [first, second, divider];
  }
  private footer(selected: AgentSnapshot | undefined, width: number): string {
    const keys = this.keys;
    const label = (action: keyof ResolvedInspectorKeybindings) => bindingLabel(keys, action, { firstOnly: true });
    const close = `${label("close")} close`;
    const select = `${bindingLabel(keys, "selectUp", { firstOnly: true })}/${bindingLabel(keys, "selectDown", { firstOnly: true })} select`;
    const drill = `${label("drillIn")} open · ${label("drillOut")} back`;
    const filter = `${label("toggleFinished")} finished`;
    const optional: string[] = [];
    if (selected) {
      if (messageEligible(selected)) optional.push(`${label("steer")} message`);
      if (active(selected) && label("stop") !== "X") optional.push(`${label("stop")} stop`);
      const nav = this.state().navigation;
      if (nav.kind === "inspector" && nav.detail.kind === "ready") optional.push(`${label("toggleTools")} tools`, `${label("refresh")} reload`);
    }
    const scroll = `${label("pageUp")}/${label("pageDown")} scroll`;
    // Preserve scrolling and closing hints on narrow terminals; drop secondary actions first.
    const parts = [select, scroll, drill, filter, ...optional, close];
    while (parts.length > 3 && visibleWidth(parts.join(" · ")) > width) parts.splice(2, 1);
    while (parts.length > 1 && visibleWidth(parts.join(" · ")) > width) parts.shift();
    return parts.join(" · ");
  }
  render(width: number): string[] {
    // Below the minimum width the overlay renders a single diagnostic line instead of panes.
    if (width < MIN_WIDTH) return [clip("Agents overlay requires a wider terminal.", width)];
    const height = Math.max(1, Math.floor(this.height()));
    if (height < 4) return [clip("Agents overlay requires a taller terminal.", width)];
    const s = this.state(), theme = this.theme;
    const border = (text: string) => theme ? theme.fg("borderMuted", text) : text;
    const fit = (text: string, columns: number) => truncateToWidth(text, columns, "", true);
    const frameRow = (text: string) => border("│ ") + fit(text, width - 4) + border(" │");
    const topBorder = (label: string) => {
      const title = clip(` ${label} `, width - 3);
      return border("╭─") + title + border("─".repeat(Math.max(0, width - 3 - visibleWidth(title)))) + border("╮");
    };
    const bottom = border(`╰${"─".repeat(width - 2)}╯`);
    const dialog = this.dialogRender(width - 4);
    if (dialog) {
      const content = dialog.slice(0, -1).slice(0, height - 3);
      while (content.length < height - 3) content.push("");
      return [topBorder("Agents"), ...content.map(frameRow), frameRow(dialog.at(-1) ?? ""), bottom];
    }
    const nav = s.navigation;
    if (nav.kind !== "inspector") return [];
    const level = nav.detail.level;
    const roster = overlayRows(s, level);
    const selected = nav.detail.kind === "list" ? undefined : nav.detail.agentId;
    const record = s.snapshots.find(a => a.agent.agentId === selected);
    const position = record ? `${roster.findIndex(a => a.agent.agentId === selected) + 1}/${roster.length}` : `0/${roster.length}`;
    const activeCount = s.snapshots.filter(a => active(a)).length;
    const top = topBorder(`${this.breadcrumb(level)} · ${position} · ${activeCount} active`);
    const cancellationLine = frameRow(clip(width - 4 >= CANCELLATION_HINT.length ? CANCELLATION_HINT : "Stop: X selected · Ctrl+X all", width - 4));
    const footerLine = frameRow(clip(this.footer(record, width - 4), width - 4));
    if (height === 4) return [top, frameRow(clip(s.feedback ?? "", width - 4)), footerLine, bottom];
    const body: string[] = [];
    const wide = width >= PANE_SPLIT;
    // Reserve seven columns for the outer frame, padding, and pane divider.
    // Navigation's bounds take priority; the transcript receives all remaining columns.
    const paneWidth = wide ? Math.max(LIST_MIN_WIDTH, Math.min(LIST_MAX_WIDTH, width - 7 - Math.ceil(width * VIEWPORT_RATIO))) : width - 4;
    const rosterLines = roster.map(a => this.rosterRow(a, selected, paneWidth));
    const detailWidth = wide ? width - paneWidth - 7 : width - 4;
    const header = record ? this.statusHeader(record, detailWidth) : [];
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
    } else if (!record) details.push(`Select an agent with ${bindingLabel(this.keys, "selectUp")}/${bindingLabel(this.keys, "selectDown")}.`);
    // Feedback is part of the operation contract, not expendable transcript overflow.
    const fixedRows = 2 /* rules */ + 2 /* footers */ + (s.feedback ? 1 : 0);
    const bodyHeight = Math.max(0, height - fixedRows);
    const rosterRows = wide ? bodyHeight : Math.min(rosterLines.length, Math.min(5, Math.max(0, bodyHeight - 2)));
    const selectedIndex = roster.findIndex(a => a.agent.agentId === selected);
    const rosterStart = Math.max(0, Math.min(selectedIndex - rosterRows + 1, rosterLines.length - rosterRows));
    const visibleRoster = rosterLines.slice(rosterStart, rosterStart + rosterRows);
    this.visibleTranscriptRows = Math.max(1, bodyHeight - (wide ? 0 : rosterRows) - header.length - details.length);
    const transcriptRows = nav.detail.kind === "ready" ? transcriptWindow(nav.detail.transcript, detailWidth, this.visibleTranscriptRows, theme) : [];
    const detailLines = [...header, ...details, ...transcriptRows];
    if (wide) {
      this.transcriptPaneX = 2 + paneWidth + 3;
      for (let i = 0; i < bodyHeight; i++) {
        const left = clip(visibleRoster[i] ?? "", paneWidth);
        const right = clip(detailLines[i] ?? "", detailWidth);
        const leftText = left + " ".repeat(Math.max(0, paneWidth - visibleWidth(left)));
        body.push(border("│ ") + leftText + border(" │ ") + right + " ".repeat(Math.max(0, detailWidth - visibleWidth(right))) + border(" │"));
      }
    } else {
      this.transcriptPaneX = 0;
      const lines = [...visibleRoster, ...detailLines];
      for (let i = 0; i < bodyHeight; i++) body.push(frameRow(clip(lines[i] ?? "", detailWidth)));
    }
    const feedback = s.feedback ? frameRow(clip(s.feedback, width - 4)) : undefined;
    return [top, ...body, ...(feedback ? [feedback] : []), ...(height >= 5 ? [cancellationLine] : []), footerLine, bottom].map(l => truncateToWidth(l, width, ""));
  }
}
