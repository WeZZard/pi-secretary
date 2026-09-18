import type { AgentSnapshot } from "../records.ts";
import type { TranscriptEvent } from "./transcript-events.ts";

export interface Correlation { epoch: string; viewId: string }
export interface TranscriptView { events: readonly TranscriptEvent[]; follow: "following" | "paused"; anchor: number; anchorEntryId?: string; anchorOffset?: number; expanded: boolean }
export type InspectorState = { kind: "list" } | { kind: "loading"; agentId: string; requestId: string; previous?: TranscriptView } | { kind: "ready"; agentId: string; transcript: TranscriptView } | { kind: "unavailable"; agentId: string; reason: string };
export type NavigationState = { kind: "inactive" } | { kind: "editor" } | { kind: "fleet"; selectedAgentId: string | null } | { kind: "inspector"; detail: InspectorState };
export type ActionTarget = { parentId: string; agentId: string; revision: number } & ({ action: "stop"; runId: string } | { action: "cleanup"; worktreeId: string });
export type Operation = Correlation & { id: string; agentId: string; action: "message"; text: string } | Correlation & { id: string; agentId: string; action: "stop" | "cleanup"; target: ActionTarget };
export type DialogState = { kind: "closed" } | { kind: "composing"; agentId: string; draft: string; error?: string } | { kind: "confirming"; target: ActionTarget } | { kind: "submitting"; operation: Operation } | { kind: "uncertain"; operation: Operation; reason: string };
export interface UiState extends Correlation {
  parentId: string; revision: number; navigation: NavigationState; dialog: DialogState;
  snapshots: readonly AgentSnapshot[]; drafts: Readonly<Record<string, string>>;
  pending: Readonly<Record<string, Operation>>; hiddenFinished: readonly string[]; feedback?: string;
}
export const initialState = (): UiState => ({ parentId: "", epoch: "", viewId: "", revision: 0, navigation: { kind: "inactive" }, dialog: { kind: "closed" }, snapshots: [], drafts: {}, pending: {}, hiddenFinished: [] });
export type UiEvent =
  | { type: "activate"; parentId: string; epoch: string; viewId: string }
  | { type: "deactivate" }
  | { type: "snapshot"; epoch: string }
  | { type: "fleet"; editorEmpty: boolean }
  | { type: "fleet-select"; agentId: string | null }
  | { type: "open"; viewId: string }
  | { type: "select"; agentId: string; requestId: string }
  | { type: "select-first"; requestId: string }
  | { type: "select-last"; requestId: string }
  | ({ type: "transcript"; agentId: string; requestId: string; events?: readonly TranscriptEvent[]; error?: string } & Correlation)
  | { type: "compose" }
  | { type: "draft"; text: string }
  | { type: "control"; action: "stop" | "cleanup"; agentId: string }
  | { type: "submit"; operationId: string }
  | ({ type: "outcome"; operationId: string; outcome: "accepted" | "rejected" | "uncertain"; message: string } & Correlation)
  | { type: "escape" }
  | { type: "scroll"; delta: number; pageSize: number }
  | { type: "expand" }
  | { type: "refresh" };
export type UiEffect = { type: "render" } | { type: "focus"; target: "editor" | "fleet" | "inspector" | "dialog" } | { type: "feedback"; message: string } | ({ type: "load"; agentId: string; requestId: string } & Correlation) | { type: "operate"; operation: Operation } | { type: "receipt"; operation: Operation };
