import { Input, matchesKey, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { UiEvent, UiState } from "./state.ts";
import { messageEligible, active } from "./reducer.ts";
import { clip, transcriptWindow } from "./transcript.ts";
export class Inspector implements Component, Focusable {
  private input = new Input();
  focused = true;
  private state: () => UiState;
  private dispatch: (e: UiEvent) => void;
  private id: () => string;
  private height: () => number;
  private expandKey?: (data: string) => boolean;
  private visibleTranscriptRows = 1;
  constructor(state: () => UiState, dispatch: (e: UiEvent) => void, id: () => string, height: () => number = () => 24, expandKey?: (data: string) => boolean) {
    this.state = state; this.dispatch = dispatch; this.id = id; this.height = height; this.expandKey = expandKey;
  }
  invalidate(): void {}
  handleInput(data: string): void {
    const s = this.state(), d = s.dialog;
    if (matchesKey(data, "escape")) { this.dispatch({ type: "escape" }); return; }
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
    const nav = s.navigation;
    if (nav.kind !== "inspector") return;
    const selected = nav.detail.kind === "list" ? undefined : nav.detail.agentId;
    if (matchesKey(data, "up") || matchesKey(data, "down") || data === "j" || data === "k") {
      const idx = s.snapshots.findIndex(a => a.agent.agentId === selected), delta = matchesKey(data, "up") || data === "k" ? -1 : 1;
      const next = s.snapshots[Math.max(0, Math.min(s.snapshots.length - 1, idx + delta))];
      if (next) this.dispatch({ type: "select", agentId: next.agent.agentId, requestId: this.id() });
    } else if (data === "s") this.dispatch({ type: "compose" });
    else if (data === "D" && selected) this.dispatch({ type: "control", action: "stop", agentId: selected });
    else if (data === "r" && selected) this.dispatch({ type: "select", agentId: selected, requestId: this.id() });
    else if (data === "x" || this.expandKey?.(data)) this.dispatch({ type: "expand" });
    else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) this.dispatch({ type: "scroll", delta: matchesKey(data, "pageUp") ? -this.visibleTranscriptRows : this.visibleTranscriptRows, pageSize: this.visibleTranscriptRows });
    else if (data === "K" || data === "J") this.dispatch({ type: "scroll", delta: data === "K" ? -1 : 1, pageSize: this.visibleTranscriptRows });
  }
  render(width: number): string[] {
    const s = this.state(), d = s.dialog;
    if (d.kind === "composing") {
      const recipient = s.snapshots.find(a => a.agent.agentId === d.agentId);
      this.input.focused = this.focused;
      if (this.input.getValue() !== d.draft) this.input.setValue(d.draft);
      const label = messageEligible(recipient) ? recipient && active(recipient) ? "Queue guidance" : "Resume conversation" : "Submission unavailable; draft retained";
      return [clip(`${label}: ${d.agentId}`, width), ...this.input.render(Math.max(1, width)).map(l => width <= 0 ? "" : l), clip(d.error ?? "Enter sends · Escape keeps draft", width)];
    }
    if (d.kind === "confirming") return [`Confirm ${d.target.action}: ${d.target.agentId}`, d.target.action === "stop" ? `Run: ${d.target.runId}. File changes are not rolled back.` : `Worktree: ${d.target.worktreeId}. Cleanup disables future resumption.`, "Enter confirms · Escape dismisses"].map(l => clip(l, width));
    if (d.kind === "submitting" || d.kind === "uncertain") return [`${d.kind}: ${d.operation.action} ${d.operation.agentId}`, `Operation: ${d.operation.id}`, ...(d.operation.action === "message" ? [d.operation.text] : []), d.kind === "uncertain" ? d.reason : "Waiting for acceptance; this is not completion.", "Escape dismisses without cancelling or retrying"].map(l => clip(l, width));
    const nav = s.navigation;
    if (nav.kind !== "inspector") return [];
    const selected = nav.detail.kind === "list" ? undefined : nav.detail.agentId;
    const selectedIndex = s.snapshots.findIndex(a => a.agent.agentId === selected);
    const list = s.snapshots.slice(Math.max(0, selectedIndex - 4), Math.max(8, selectedIndex + 4)).map(a => `${a.agent.agentId === selected ? ">" : " "} ${a.agent.name ?? a.agent.agentId} · ${a.run?.status ?? "idle"}`);
    const record = s.snapshots.find(a => a.agent.agentId === selected);
    const details: string[] = [];
    if (record) details.push(`${record.agent.agentId} · ${record.agent.model} · ${record.run?.status ?? "idle"}`, `Task: ${record.run?.description ?? ""}`, `Definition: ${record.agent.definition.source}`, `Output: ${record.run?.outputPath ?? "unavailable"}`, ...(record.agent.worktree ? [`Worktree: ${record.agent.worktree.path} (${record.agent.worktree.branch}; ${record.agent.worktree.state})`, `Base commit: ${record.agent.worktree.baseCommit}`, "Uncommitted parent changes are excluded; this is not a security sandbox."] : []));
    if (nav.detail.kind === "loading") details.push("Loading transcript…");
    else if (nav.detail.kind === "unavailable") details.push(nav.detail.reason, "r retries");
    else if (nav.detail.kind === "ready") {
      details.push(`Transcript: ${nav.detail.transcript.follow}`);
      if (nav.detail.transcript.expanded && record) details.push(`Original prompt: ${record.run?.prompt ?? ""}`, `Activity: ${record.run?.activity ?? "none"}`, `Definition hash: ${record.agent.definition.hash}`, `Outcome: ${record.run?.error ?? record.run?.status ?? "idle"}`);
      const headerRows = width < 80 ? 2 : 1;
      const listRows = width >= 100 ? 0 : Math.min(list.length, 5);
      this.visibleTranscriptRows = Math.max(1, this.height() - 2 - headerRows - 1 - listRows - details.length);
      details.push(...transcriptWindow(nav.detail.transcript, width >= 100 ? width - 33 : width, this.visibleTranscriptRows));
    } else details.push("Select an agent with Up/Down.");
    const body = width >= 100 ? Array.from({ length: Math.max(list.length, details.length) }, (_, i) => { const left = clip(list[i] ?? "", 30); return left + " ".repeat(30 - visibleWidth(left)) + " │ " + clip(details[i] ?? "", width - 33); }) : [...list.slice(0, 5), ...details];
    const header = width < 80
      ? ["Agents · ↑↓ select · s message · D stop", "PgUp/PgDn scroll · x details · Esc close"]
      : ["Agents · ↑↓ select · s message · D stop · PgUp/PgDn scroll · x details · Esc close"];
    // Feedback is part of the operation contract, not expendable transcript overflow.
    const available = Math.max(0, this.height() - 2 - header.length - 1);
    return [...header, ...body.slice(0, available), s.feedback ?? ""].map(l => clip(l, width));
  }
}
