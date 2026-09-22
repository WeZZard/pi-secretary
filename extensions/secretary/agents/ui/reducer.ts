import { TERMINAL_STATUSES, type AgentSnapshot } from "../records.ts";
import { captureAnchor, restoreTranscript, transcriptLineCount } from "./transcript.ts";
import { initialState, type ActionTarget, type CleanupTarget, type StopTarget, type InspectorLevel, type Operation, type UiEffect, type UiEvent, type UiState } from "./state.ts";
export const active = (s: AgentSnapshot) => !!s.run && !TERMINAL_STATUSES.has(s.run.status);
export const stopTargets = (s: UiState): StopTarget[] => fleetRows(s).filter(a => active(a) && a.run?.status !== "cancelling").map(a => ({ action: "stop", parentId: a.agent.parentId, agentId: a.agent.agentId, runId: a.run!.runId, revision: a.run!.revision }));
export const messageEligible = (s: AgentSnapshot | undefined): boolean => !!s && s.agent.resumable && (!s.agent.worktree || s.agent.worktree.state === "allocated") && s.run?.status !== "cancelling" && (active(s) || !!s.agent.sessionPath);
/** The fleet indicator lists top-level agents while their run is non-terminal; terminal rows leave immediately (UX §2.2). */
export const fleetRows = (s: UiState) => s.snapshots.filter(a => !a.agent.parentAgentId && (!a.run || !TERMINAL_STATUSES.has(a.run.status)));
/**
 * The overlay retains the session's own children plus every descendant reachable through parent
 * agent identity (§12.1.6). Session ownership alone is not enough: a nested record is owned by the
 * child session that launched it, so filtering by session identity discards the drill levels.
 */
export const sessionTree = (snapshots: readonly AgentSnapshot[], parentId: string): AgentSnapshot[] => {
  const byParent = new Map<string | undefined, AgentSnapshot[]>();
  for (const s of snapshots) {
    const key = s.agent.parentAgentId;
    const group = byParent.get(key);
    if (group) group.push(s); else byParent.set(key, [s]);
  }
  const retained: AgentSnapshot[] = [];
  const visit = (parentAgentId: string | undefined) => {
    for (const s of byParent.get(parentAgentId) ?? []) {
      if (parentAgentId === undefined && s.agent.parentId !== parentId) continue;
      retained.push(s); visit(s.agent.agentId);
    }
  };
  visit(undefined);
  return retained;
};
/** The overlay lists one drill level at a time; the filter retains or drops terminal statuses (§12.1.6). */
export const overlayRows = (s: UiState, level: InspectorLevel) => {
  const parent = level.path.at(-1);
  return s.snapshots.filter(a => (parent ? a.agent.parentAgentId === parent : !a.agent.parentAgentId) && (level.includeFinished || !a.run || !TERMINAL_STATUSES.has(a.run.status)));
};
export function eligible(target: ActionTarget, s: AgentSnapshot | undefined): boolean {
  // Eligibility is evaluated against the agent record rather than by comparing the capturing
  // session with the owning session, so a nested agent at a drill level is a valid target (§12.1.6).
  if (!s || s.agent.agentId !== target.agentId) return false;
  return target.action === "stop" ? s.run?.runId === target.runId && active(s) : !active(s) && s.agent.worktree?.id === target.worktreeId && s.agent.worktree.state === "allocated";
}
export function transition(previous: UiState, event: UiEvent, snapshots: readonly AgentSnapshot[] = previous.snapshots): { state: UiState; effects: UiEffect[] } {
  let state = previous;
  const effects: UiEffect[] = [];
  const patch = (p: Partial<UiState>) => { state = { ...state, ...p }; };
  const feedback = (message: string) => { patch({ feedback: message }); effects.push({ type: "feedback", message }); };
  const focus = (target: "editor" | "fleet" | "inspector" | "dialog") => effects.push({ type: "focus", target });
  const find = (id: string) => state.snapshots.find(s => s.agent.agentId === id);
  const restore = () => focus(state.navigation.kind === "inspector" ? "inspector" : state.navigation.kind === "fleet" ? "fleet" : "editor");
  const pendingStop = (targets: readonly StopTarget[]) => Object.values(state.pending).find(op =>
    op.action === "stop-all" ? op.targets.some(t => targets.some(target => target.runId === t.runId)) :
      op.action === "stop" && op.target.action === "stop" && targets.map(target => target.runId).includes(op.target.runId));
  const unresolved = (operation: Operation) => {
    patch({ dialog: { kind: "uncertain", operation, reason: "An earlier cancellation remains unresolved. Do not resend." } }); focus("dialog");
  };
  if (event.type === "deactivate") return { state: { ...initialState(), revision: previous.revision + 1 }, effects: [{ type: "render" }] };
  if (event.type === "activate") {
    state = { ...initialState(), ...event, navigation: { kind: "editor" }, snapshots: structuredClone(sessionTree(snapshots, event.parentId)) };
  } else if (state.navigation.kind === "inactive") return { state, effects };
  else switch (event.type) {
    case "snapshot": {
      if (event.epoch !== state.epoch) break;
      patch({ snapshots: structuredClone(sessionTree(snapshots, state.parentId)) });
      if (state.dialog.kind === "confirming" && !eligible(state.dialog.target, find(state.dialog.target.agentId))) {
        patch({ dialog: { kind: "closed" } }); feedback("The captured target is no longer eligible. No operation was sent."); restore();
      }
      const nav = state.navigation;
      // When the last non-terminal row leaves, the hidden indicator cannot hold focus (UX §2.2).
      if (nav.kind === "fleet" && fleetRows(state).length === 0) { patch({ navigation: { kind: "editor" } }); focus("editor"); }
      else if (nav.kind === "fleet" && nav.selectedAgentId && !fleetRows(state).some(a => a.agent.agentId === nav.selectedAgentId)) patch({ navigation: { kind: "fleet", selectedAgentId: null } });
      else if (nav.kind === "inspector" && nav.detail.kind !== "list" && !find(nav.detail.agentId)) patch({ navigation: { kind: "inspector", detail: { kind: "unavailable", level: nav.detail.level, agentId: nav.detail.agentId, reason: "Agent is no longer available." } } });
      break;
    }
    case "fleet":
      // Entry requires at least one agent row; an idle session has no visible indicator (UX §2.2).
      if (state.navigation.kind === "editor" && state.dialog.kind === "closed" && event.downAtLastLine && fleetRows(state).length > 0) { patch({ navigation: { kind: "fleet", selectedAgentId: null } }); focus("fleet"); } break;
    case "fleet-select":
      if (state.navigation.kind === "fleet" && (!event.agentId || find(event.agentId))) patch({ navigation: { kind: "fleet", selectedAgentId: event.agentId } }); break;
    case "open":
      if (state.dialog.kind !== "closed") break;
      patch({ viewId: event.viewId, navigation: { kind: "inspector", detail: { kind: "list", level: { path: [], includeFinished: false } } }, feedback: undefined }); focus("inspector"); break;
    case "select": {
      if (state.navigation.kind !== "inspector" || state.dialog.kind !== "closed") break;
      if (!find(event.agentId)) { feedback("Agent does not belong to this session."); break; }
      const detail = state.navigation.detail;
      const prior = detail.kind === "ready" && detail.agentId === event.agentId ? detail.transcript : undefined;
      patch({ navigation: { kind: "inspector", detail: { kind: "loading", level: detail.level, agentId: event.agentId, requestId: event.requestId, previous: prior } } });
      effects.push({ type: "load", epoch: state.epoch, viewId: state.viewId, agentId: event.agentId, requestId: event.requestId }); break;
    }
    case "select-first": case "select-last": {
      if (state.navigation.kind !== "inspector" || state.dialog.kind !== "closed") break;
      const detail = state.navigation.detail;
      const rows = overlayRows(state, detail.level);
      const target = event.type === "select-first" ? rows[0] : rows.at(-1);
      if (!target) break;
      if (detail.kind !== "list" && detail.agentId === target.agent.agentId) break;
      const prior = detail.kind === "ready" && detail.agentId === target.agent.agentId ? detail.transcript : undefined;
      patch({ navigation: { kind: "inspector", detail: { kind: "loading", level: detail.level, agentId: target.agent.agentId, requestId: event.requestId, previous: prior } } });
      effects.push({ type: "load", epoch: state.epoch, viewId: state.viewId, agentId: target.agent.agentId, requestId: event.requestId }); break;
    }
    case "drill-in": {
      const nav = state.navigation;
      if (nav.kind !== "inspector" || nav.detail.kind === "list" || state.dialog.kind !== "closed") break;
      const level: InspectorLevel = { path: [...nav.detail.level.path, nav.detail.agentId], includeFinished: nav.detail.level.includeFinished };
      const first = overlayRows(state, level)[0];
      if (!first) break; // A childless agent has no level to enter (UI-13's guard).
      patch({ navigation: { kind: "inspector", detail: { kind: "loading", level, agentId: first.agent.agentId, requestId: event.requestId } } });
      effects.push({ type: "load", epoch: state.epoch, viewId: state.viewId, agentId: first.agent.agentId, requestId: event.requestId }); break;
    }
    case "drill-out": {
      const nav = state.navigation;
      if (nav.kind !== "inspector" || state.dialog.kind !== "closed" || !nav.detail.level.path.length) break;
      const cameFrom = nav.detail.level.path.at(-1)!;
      const level: InspectorLevel = { path: nav.detail.level.path.slice(0, -1), includeFinished: nav.detail.level.includeFinished };
      patch({ navigation: { kind: "inspector", detail: { kind: "loading", level, agentId: cameFrom, requestId: event.requestId } } });
      effects.push({ type: "load", epoch: state.epoch, viewId: state.viewId, agentId: cameFrom, requestId: event.requestId }); break;
    }
    case "toggle-finished": {
      const nav = state.navigation;
      if (nav.kind !== "inspector" || state.dialog.kind !== "closed") break;
      const level: InspectorLevel = { path: nav.detail.level.path, includeFinished: !nav.detail.level.includeFinished };
      const detail = nav.detail;
      const rows = overlayRows(state, level);
      if (detail.kind === "list") { patch({ navigation: { kind: "inspector", detail: { kind: "list", level } } }); break; }
      if (rows.some(a => a.agent.agentId === detail.agentId)) { patch({ navigation: { kind: "inspector", detail: { ...detail, level } } }); break; }
      // The selected row left the list: move to the nearest remaining row (UI-15).
      const before = overlayRows(state, detail.level).findIndex(a => a.agent.agentId === detail.agentId);
      const target = rows[Math.max(0, Math.min(rows.length - 1, before - 1))] ?? rows.at(-1);
      if (!target) { patch({ navigation: { kind: "inspector", detail: { kind: "list", level } } }); break; }
      patch({ navigation: { kind: "inspector", detail: { kind: "loading", level, agentId: target.agent.agentId, requestId: event.requestId } } });
      effects.push({ type: "load", epoch: state.epoch, viewId: state.viewId, agentId: target.agent.agentId, requestId: event.requestId }); break;
    }
    case "transcript": {
      const nav = state.navigation;
      if (event.epoch !== state.epoch || event.viewId !== state.viewId || nav.kind !== "inspector" || nav.detail.kind !== "loading" || nav.detail.agentId !== event.agentId || nav.detail.requestId !== event.requestId) break;
      patch({ navigation: { kind: "inspector", detail: event.error ? { kind: "unavailable", level: nav.detail.level, agentId: event.agentId, reason: event.error } : { kind: "ready", level: nav.detail.level, agentId: event.agentId, transcript: restoreTranscript(nav.detail.previous, event.events ?? []) } } }); break;
    }
    case "compose": {
      const nav = state.navigation;
      if (state.dialog.kind !== "closed" || nav.kind !== "inspector" || nav.detail.kind === "list") break;
      const id = nav.detail.agentId;
      const pending = Object.values(state.pending).find(o => o.action === "message" && o.agentId === id);
      if (pending) { patch({ dialog: { kind: "uncertain", operation: pending, reason: "The earlier request remains unresolved. Do not resend." } }); focus("dialog"); break; }
      if (!messageEligible(find(id))) { feedback("This agent cannot receive guidance or resume."); break; }
      patch({ dialog: { kind: "composing", agentId: id, draft: state.drafts[id] ?? "" } }); focus("dialog"); break;
    }
    case "draft":
      if (state.dialog.kind === "composing") patch({ drafts: { ...state.drafts, [state.dialog.agentId]: event.text }, dialog: { ...state.dialog, draft: event.text, error: undefined } }); break;
    case "stop-all": {
      // Ctrl+X cancels immediately: the shortcut is the decision, so it submits the captured batch
      // in the same event and exposes no dialog to confirm (UX §3.3).
      if (state.dialog.kind !== "closed") break;
      const targets = stopTargets(state).filter(t => eligible(t, find(t.agentId)));
      const pending = pendingStop(targets);
      if (pending) { unresolved(pending); break; }
      if (!targets.length) { feedback("No runs are eligible for cancellation; existing cancellation requests remain in progress."); break; }
      const operation: Operation = { epoch: state.epoch, viewId: state.viewId, id: event.operationId, action: "stop-all", agentId: state.parentId, targets };
      patch({ dialog: { kind: "submitting", operation }, pending: { ...state.pending, [operation.id]: operation }, feedback: undefined });
      effects.push({ type: "operate", operation }); break;
    }
    case "stop": {
      // X cancels immediately, like Ctrl+X: the shortcut is the decision, and the run identity
      // observed at the keypress is submitted in the same event with no dialog to confirm (§3.3).
      if (state.dialog.kind !== "closed") break;
      const s = find(event.agentId);
      if (!s) { feedback("Agent is not available."); break; }
      const target: StopTarget | undefined = s.run ? { parentId: s.agent.parentId, agentId: event.agentId, revision: s.run.revision, action: "stop", runId: s.run.runId } : undefined;
      if (!target || !eligible(target, s)) { feedback("The target is not eligible for this operation."); break; }
      const pending = pendingStop([target]);
      if (pending) { unresolved(pending); break; }
      if (s.run?.status === "cancelling") { feedback("Cancellation is already in progress."); break; }
      const operation: Operation = { epoch: state.epoch, viewId: state.viewId, id: event.operationId, action: "stop", agentId: event.agentId, target };
      patch({ dialog: { kind: "submitting", operation }, pending: { ...state.pending, [operation.id]: operation }, feedback: undefined });
      effects.push({ type: "operate", operation }); break;
    }
    case "cleanup": {
      if (state.dialog.kind !== "closed") break;
      const s = find(event.agentId);
      if (!s) { feedback("Agent is not available."); break; }
      const target: CleanupTarget | undefined = s.agent.worktree ? { parentId: s.agent.parentId, agentId: event.agentId, revision: s.run?.revision ?? 0, action: "cleanup", worktreeId: s.agent.worktree.id } : undefined;
      if (!target || !eligible(target, s)) { feedback("The target is not eligible for this operation."); break; }
      patch({ dialog: { kind: "confirming", target }, feedback: undefined }); focus("dialog"); break;
    }
    case "submit": {
      const d = state.dialog;
      let operation: Operation;
      const correlation = { epoch: state.epoch, viewId: state.viewId, id: event.operationId };
      if (state.pending[event.operationId]) break;
      if (d.kind === "composing") {
        if (!d.draft.trim() || !messageEligible(find(d.agentId))) { patch({ dialog: { ...d, error: !d.draft.trim() ? "Enter nonempty guidance." : "Recipient is no longer eligible. Your draft is retained." } }); break; }
        operation = { ...correlation, action: "message", agentId: d.agentId, text: d.draft };
      } else if (d.kind === "confirming") {
        if (!eligible(d.target, find(d.target.agentId))) { patch({ dialog: { kind: "closed" } }); feedback("The captured target is no longer eligible."); restore(); break; }
        operation = { ...correlation, action: d.target.action, agentId: d.target.agentId, target: d.target };
      } else break;
      patch({ dialog: { kind: "submitting", operation }, pending: { ...state.pending, [operation.id]: operation } }); effects.push({ type: "operate", operation }); break;
    }
    case "outcome": {
      if (event.epoch !== state.epoch) break;
      const operation = state.pending[event.operationId];
      if (!operation || operation.viewId !== event.viewId) break;
      if (event.outcome !== "uncertain") { const pending = { ...state.pending }; delete pending[event.operationId]; patch({ pending }); }
      const d = state.dialog;
      const matching = (d.kind === "submitting" || d.kind === "uncertain") && d.operation.id === event.operationId;
      if (event.outcome === "uncertain") {
        if (matching) patch({ dialog: { kind: "uncertain", operation, reason: event.message } });
        if (d.kind !== "uncertain") effects.push({ type: "receipt", operation });
      } else if (matching) {
        if (event.outcome === "rejected" && operation.action === "message") patch({ dialog: { kind: "composing", agentId: operation.agentId, draft: operation.text, error: event.message } });
        else { patch({ dialog: { kind: "closed" } }); restore(); }
        feedback(event.message);
      }
      break;
    }
    case "escape":
      if (state.dialog.kind !== "closed") { patch({ dialog: { kind: "closed" } }); restore(); }
      else if (state.navigation.kind === "fleet" || state.navigation.kind === "inspector") { patch({ navigation: { kind: "editor" } }); focus("editor"); } break;
    case "scroll": {
      const nav = state.navigation;
      if (state.dialog.kind !== "closed" || nav.kind !== "inspector" || nav.detail.kind !== "ready") break;
      const t = nav.detail.transcript, end = Math.max(0, transcriptLineCount(t.events) - event.pageSize);
      const anchor = Math.max(0, Math.min(end, (t.follow === "following" ? end : t.anchor) + event.delta));
      patch({ navigation: { ...nav, detail: { ...nav.detail, transcript: { ...t, ...captureAnchor(t, anchor), follow: anchor >= end ? "following" : "paused" } } } }); break;
    }
    case "expand": {
      const nav = state.navigation;
      if (state.dialog.kind === "closed" && nav.kind === "inspector" && nav.detail.kind === "ready") patch({ navigation: { ...nav, detail: { ...nav.detail, transcript: { ...nav.detail.transcript, expanded: !nav.detail.transcript.expanded } } } }); break;
    }
    case "refresh": effects.push({ type: "render" }); break;
  }
  if (state !== previous) { state = { ...state, revision: previous.revision + 1 }; effects.push({ type: "render" }); }
  return { state, effects };
}
