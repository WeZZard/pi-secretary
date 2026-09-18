import { TERMINAL_STATUSES, type AgentSnapshot } from "../records.ts";
import { captureAnchor, restoreTranscript, transcriptLineCount } from "./transcript.ts";
import { initialState, type ActionTarget, type Operation, type UiEffect, type UiEvent, type UiState } from "./state.ts";
export const active = (s: AgentSnapshot) => !!s.run && !TERMINAL_STATUSES.has(s.run.status);
export const messageEligible = (s: AgentSnapshot | undefined): boolean => !!s && s.agent.resumable && (!s.agent.worktree || s.agent.worktree.state === "allocated") && s.run?.status !== "cancelling" && (active(s) || !!s.agent.sessionPath);
export const fleetRows = (s: UiState) => s.snapshots.filter(a => active(a) || !s.hiddenFinished.includes(a.run?.runId ?? a.agent.agentId));
export function eligible(target: ActionTarget, s: AgentSnapshot | undefined): boolean {
  if (!s || s.agent.parentId !== target.parentId) return false;
  return target.action === "stop" ? s.run?.runId === target.runId && active(s) : !active(s) && s.agent.worktree?.id === target.worktreeId && s.agent.worktree.state === "allocated";
}
export function transition(previous: UiState, event: UiEvent, snapshots: readonly AgentSnapshot[] = previous.snapshots): { state: UiState; effects: UiEffect[] } {
  let state = previous;
  const effects: UiEffect[] = [];
  const patch = (p: Partial<UiState>) => { state = { ...state, ...p }; };
  const feedback = (message: string) => { patch({ feedback: message }); effects.push({ type: "feedback", message }); };
  const focus = (target: "editor" | "fleet" | "inspector" | "dialog") => effects.push({ type: "focus", target });
  const find = (id: string) => state.snapshots.find(s => s.agent.agentId === id);
  const restore = () => focus(state.navigation.kind === "inspector" ? "inspector" : "editor");
  if (event.type === "deactivate") return { state: { ...initialState(), revision: previous.revision + 1 }, effects: [{ type: "render" }] };
  if (event.type === "activate") {
    state = { ...initialState(), ...event, navigation: { kind: "editor" }, snapshots: structuredClone(snapshots.filter(s => s.agent.parentId === event.parentId)) };
  } else if (state.navigation.kind === "inactive") return { state, effects };
  else switch (event.type) {
    case "snapshot": {
      if (event.epoch !== state.epoch) break;
      patch({ snapshots: structuredClone(snapshots.filter(s => s.agent.parentId === state.parentId)) });
      if (state.dialog.kind === "confirming" && !eligible(state.dialog.target, find(state.dialog.target.agentId))) {
        patch({ dialog: { kind: "closed" } }); feedback("The captured target is no longer eligible. No operation was sent."); restore();
      }
      const nav = state.navigation;
      if (nav.kind === "inspector" && nav.detail.kind !== "list" && !find(nav.detail.agentId)) patch({ navigation: { kind: "inspector", detail: { kind: "unavailable", agentId: nav.detail.agentId, reason: "Agent is no longer available." } } });
      break;
    }
    case "fleet":
      if (state.navigation.kind === "editor" && state.dialog.kind === "closed" && event.editorEmpty && fleetRows(state).length) { patch({ navigation: { kind: "fleet", selectedAgentId: null } }); focus("fleet"); } break;
    case "fleet-select":
      if (state.navigation.kind === "fleet" && (!event.agentId || find(event.agentId))) patch({ navigation: { kind: "fleet", selectedAgentId: event.agentId } }); break;
    case "open":
      if (state.dialog.kind !== "closed") break;
      patch({ viewId: event.viewId, navigation: { kind: "inspector", detail: { kind: "list" } }, feedback: undefined }); focus("inspector"); break;
    case "select": {
      if (state.navigation.kind !== "inspector" || state.dialog.kind !== "closed") break;
      if (!find(event.agentId)) { feedback("Agent does not belong to this session."); break; }
      const detail = state.navigation.detail;
      const prior = detail.kind === "ready" && detail.agentId === event.agentId ? detail.transcript : undefined;
      patch({ navigation: { kind: "inspector", detail: { kind: "loading", agentId: event.agentId, requestId: event.requestId, previous: prior } } });
      effects.push({ type: "load", epoch: state.epoch, viewId: state.viewId, agentId: event.agentId, requestId: event.requestId }); break;
    }
    case "select-first": case "select-last": {
      if (state.navigation.kind !== "inspector" || state.dialog.kind !== "closed") break;
      const target = event.type === "select-first" ? state.snapshots[0] : state.snapshots.at(-1);
      if (!target) break;
      const detail = state.navigation.detail;
      if (detail.kind !== "list" && detail.agentId === target.agent.agentId) break;
      const prior = detail.kind === "ready" && detail.agentId === target.agent.agentId ? detail.transcript : undefined;
      patch({ navigation: { kind: "inspector", detail: { kind: "loading", agentId: target.agent.agentId, requestId: event.requestId, previous: prior } } });
      effects.push({ type: "load", epoch: state.epoch, viewId: state.viewId, agentId: target.agent.agentId, requestId: event.requestId }); break;
    }
    case "transcript": {
      const nav = state.navigation;
      if (event.epoch !== state.epoch || event.viewId !== state.viewId || nav.kind !== "inspector" || nav.detail.kind !== "loading" || nav.detail.agentId !== event.agentId || nav.detail.requestId !== event.requestId) break;
      patch({ navigation: { kind: "inspector", detail: event.error ? { kind: "unavailable", agentId: event.agentId, reason: event.error } : { kind: "ready", agentId: event.agentId, transcript: restoreTranscript(nav.detail.previous, event.events ?? []) } } }); break;
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
    case "control": {
      if (state.dialog.kind !== "closed" || state.navigation.kind === "fleet") break;
      const s = find(event.agentId);
      if (!s) { feedback("Agent is not available."); break; }
      const base = { parentId: state.parentId, agentId: event.agentId, revision: s.run?.revision ?? 0 };
      const target: ActionTarget | undefined = event.action === "stop" && s.run ? { ...base, action: "stop", runId: s.run.runId } : event.action === "cleanup" && s.agent.worktree ? { ...base, action: "cleanup", worktreeId: s.agent.worktree.id } : undefined;
      if (!target || !eligible(target, s)) { feedback("The target is not eligible for this operation."); break; }
      patch({ dialog: { kind: "confirming", target } }); focus("dialog"); break;
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
      const matching = (d.kind === "submitting" || d.kind === "uncertain") && d.operation.id === event.operationId && state.viewId === event.viewId;
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
      else if (state.navigation.kind === "fleet" || state.navigation.kind === "inspector") { patch({ navigation: { kind: "editor" }, hiddenFinished: state.snapshots.filter(s => !active(s)).map(s => s.run?.runId ?? s.agent.agentId) }); focus("editor"); } break;
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
