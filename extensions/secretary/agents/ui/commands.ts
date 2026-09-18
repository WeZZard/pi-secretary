import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { AsyncWidget, ASYNC_WIDGET_KEY, startAsyncWidgetPolling } from "./async-widget.ts";
import { FleetView } from "./fleet-view.ts";
import { Inspector } from "./inspector.ts";
import type { InspectorKeybindingsConfig } from "./keybindings.ts";
import { runEffect, type AgentUIPort } from "./effects.ts";
import { fleetRows, transition } from "./reducer.ts";
import { initialState, type UiEvent } from "./state.ts";
import { sanitize } from "./transcript.ts";
export type { AgentUIPort, OperationReceipt } from "./effects.ts";
export const FLEET_WIDGET_KEY = "secretary.agents.fleet";
export interface AgentUiOptions {
  fleetViewPlacement?: "belowEditor" | "aboveEditor";
  asyncWidget?: boolean;
  keybindings?: InspectorKeybindingsConfig;
}
export function registerAgentUI(pi: ExtensionAPI, port: AgentUIPort, resolveOptions: AgentUiOptions | (() => AgentUiOptions) = {}): { bind(ctx: ExtensionContext): void; dispose(): void } {
  const options = () => typeof resolveOptions === "function" ? resolveOptions() : resolveOptions;
  let state = initialState();
  let ctx: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined, terminal: (() => void) | undefined;
  let requestRender: (() => void) | undefined, close: (() => void) | undefined;
  let customOpen = false, promptDepth = 0, transcriptDirty = false;
  let polling: { dispose(): void } | undefined;
  let asyncWidget: AsyncWidget | undefined;
  const placement = () => options().fleetViewPlacement ?? "belowEditor";
  const asyncEnabled = () => options().asyncWidget ?? true;
  const fleet = new FleetView(() => state, { rows: () => port.viewModels?.() ?? [] });
  const render = () => {
    if (ctx?.mode !== "tui") return;
    ctx.ui.setWidget(FLEET_WIDGET_KEY, () => fleet, { placement: placement() });
    if (asyncEnabled() && asyncWidget) ctx.ui.setWidget(ASYNC_WIDGET_KEY, () => asyncWidget!, { placement: "belowEditor" });
    requestRender?.();
  };
  const dispatch = (event: UiEvent) => {
    const result = transition(state, event, event.type === "activate" || event.type === "snapshot" ? port.list() : state.snapshots);
    state = result.state;
    if (event.type === "snapshot" && event.epoch === state.epoch) transcriptDirty = true;
    for (const effect of result.effects) {
      if (effect.type === "render") render();
      else if (effect.type === "feedback") { /* Feedback remains in the originating view. */ }
      else if (effect.type === "focus") { if (effect.target === "editor" && state.dialog.kind === "closed") close?.(); }
      else void runEffect(effect, port, dispatch);
    }
    if (state.navigation.kind === "editor" && state.dialog.kind === "closed") close?.();
    const nav = state.navigation;
    if (transcriptDirty && nav.kind === "inspector" && nav.detail.kind === "ready" && state.dialog.kind === "closed") {
      transcriptDirty = false;
      dispatch({ type: "select", agentId: nav.detail.agentId, requestId: randomUUID() });
    }
  };
  const show = async () => {
    if (!ctx || ctx.mode !== "tui" || customOpen) return;
    customOpen = true;
    const epoch = state.epoch, owner = ctx;
    try {
      await owner.ui.custom<void>((tui, _theme, kb, done) => {
        close = () => done(); requestRender = () => tui.requestRender();
        return new Inspector(() => state, dispatch, randomUUID, () => Math.max(6, Math.floor(tui.terminal.rows * 0.9)), { keybindings: options().keybindings, expandKey: data => kb.matches(data, "app.tools.expand") });
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "90%", anchor: "center" } });
    } catch (error) { if (state.epoch === epoch) owner.ui.notify(`Agent inspector unavailable: ${String(error)}`, "error"); }
    finally { if (state.epoch === epoch) { customOpen = false; close = undefined; requestRender = undefined; if (state.navigation.kind === "inspector" || state.dialog.kind !== "closed") { dispatch({ type: "escape" }); if (state.navigation.kind === "inspector") dispatch({ type: "escape" }); } } }
  };
  const dispose = () => {
    unsubscribe?.(); terminal?.(); unsubscribe = terminal = undefined;
    polling?.dispose(); polling = undefined; asyncWidget = undefined;
    close?.(); close = undefined; requestRender = undefined; customOpen = false;
    if (ctx?.mode === "tui") { ctx.ui.setWidget(FLEET_WIDGET_KEY, undefined); ctx.ui.setWidget(ASYNC_WIDGET_KEY, undefined); }
    state = transition(state, { type: "deactivate" }).state; ctx = undefined; transcriptDirty = false;
  };
  const bind = (next: ExtensionContext) => {
    dispose(); ctx = next;
    if (next.mode !== "tui") return;
    dispatch({ type: "activate", epoch: randomUUID(), viewId: randomUUID(), parentId: next.sessionManager.getSessionId() });
    const epoch = state.epoch;
    unsubscribe = port.subscribe(() => {
      if (state.epoch !== epoch) return;
      dispatch({ type: "snapshot", epoch });
      for (const operation of Object.values(state.pending)) void runEffect({ type: "receipt", operation }, port, dispatch);
    });
    if (asyncEnabled()) {
      asyncWidget = new AsyncWidget({ rows: () => port.viewModels?.() ?? [], expanded: () => next.ui.getToolsExpanded?.() ?? false });
      const widget = asyncWidget;
      polling = startAsyncWidgetPolling({ rows: () => port.viewModels?.() ?? [], folded: () => widget.isFolded(),
        repaint: () => { if (state.epoch === epoch) render(); }, subscribe: listener => port.subscribe(listener) });
    }
    if (typeof next.ui.onTerminalInput !== "function") { next.ui.notify("Fleet keyboard integration unavailable. Use /agents.", "warning"); return; }
    terminal = next.ui.onTerminalInput(data => {
      if (customOpen || promptDepth > 0 || state.dialog.kind !== "closed") return;
      if (state.navigation.kind === "editor") {
        if ((matchesKey(data, "down") || matchesKey(data, "left")) && next.ui.getEditorText() === "" && fleetRows(state).length) {
          dispatch({ type: "fleet", editorEmpty: true }); return { consume: true };
        }
        return;
      }
      if (state.navigation.kind !== "fleet") return;
      if (matchesKey(data, "escape")) dispatch({ type: "escape" });
      else if (matchesKey(data, "enter")) {
        const id = state.navigation.selectedAgentId;
        if (!id) dispatch({ type: "escape" });
        else { dispatch({ type: "open", viewId: randomUUID() }); dispatch({ type: "select", agentId: id, requestId: randomUUID() }); void show(); }
      } else if (matchesKey(data, "up") || matchesKey(data, "down") || data === "j" || data === "k") {
        const ids = [null, ...fleetRows(state).map(a => a.agent.agentId)];
        const idx = ids.indexOf(state.navigation.selectedAgentId), delta = matchesKey(data, "up") || data === "k" ? -1 : 1;
        dispatch({ type: "fleet-select", agentId: ids[Math.max(0, Math.min(ids.length - 1, idx + delta))]! });
      }
      return { consume: true };
    });
  };
  pi.on("ui_prompt_start", () => { promptDepth++; });
  pi.on("ui_prompt_end", () => { promptDepth = Math.max(0, promptDepth - 1); });
  pi.registerCommand("agents", {
    description: "Inspect agents: /agents [id-or-name], /agents stop <id>, /agents cleanup <id>",
    handler: async (args, commandCtx) => {
      const words = args.trim().split(/\s+/).filter(Boolean), action = words[0] === "stop" || words[0] === "cleanup" ? words.shift() as "stop" | "cleanup" : undefined;
      const reference = words.join(" ");
      const snapshots = port.list().filter(a => a.agent.parentId === commandCtx.sessionManager.getSessionId());
      const selected = snapshots.find(a => a.agent.agentId === reference || a.agent.name === reference || a.run?.runId === reference);
      if (commandCtx.mode !== "tui") {
        const text = action ? "Stop and cleanup commands require TUI confirmation. Use TaskStop for an explicit non-TUI stop." : snapshots.map(a => `${a.agent.agentId} ${a.agent.name ?? ""}: ${a.run?.status ?? "idle"} ${a.run?.outputPath ?? ""}`).join("\n") || "No agents in this session.";
        pi.sendMessage({ customType: "secretary-agents", content: sanitize(text), display: true }, { triggerTurn: false }); return;
      }
      if ((reference && !selected) || (action && !reference)) { commandCtx.ui.notify("Specify an agent ID or exact name in this session.", "warning"); return; }
      if (!ctx || state.parentId !== commandCtx.sessionManager.getSessionId()) bind(commandCtx);
      if (customOpen) return;
      if (action && selected) dispatch({ type: "control", action, agentId: selected.agent.agentId });
      else { dispatch({ type: "open", viewId: randomUUID() }); if (selected) dispatch({ type: "select", agentId: selected.agent.agentId, requestId: randomUUID() }); }
      if (state.dialog.kind !== "closed" || state.navigation.kind === "inspector") await show();
      else if (state.feedback) commandCtx.ui.notify(sanitize(state.feedback), "warning");
    },
  });
  return { bind, dispose };
}
