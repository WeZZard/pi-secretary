import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { SecretaryConfigMenu, headlessSecretaryConfig } from "./config-menu.ts";
import { SecretaryEditor, installFleetEditor } from "./editor.ts";
import { FleetView, startFleetPolling } from "./fleet-view.ts";
import { Inspector, inspectorHeight } from "./inspector.ts";
import { matchesStopAll, matchesStopSelected, type InspectorKeybindingsConfig } from "./keybindings.ts";
import { runEffect, type AgentUIPort } from "./effects.ts";
import { active, fleetRows, sessionTree, transition } from "./reducer.ts";
import { initialState, type UiEvent } from "./state.ts";
import { sanitize } from "./transcript.ts";
export type { AgentUIPort, OperationReceipt } from "./effects.ts";
export const FLEET_WIDGET_KEY = "secretary.agents.fleet";
export interface AgentUiOptions {
  fleetViewPlacement?: "belowEditor" | "aboveEditor";
  keybindings?: InspectorKeybindingsConfig;
}
export function registerAgentUI(pi: ExtensionAPI, port: AgentUIPort, resolveOptions: AgentUiOptions | (() => AgentUiOptions) = {}): { bind(ctx: ExtensionContext): void; dispose(): void } {
  let ctx: ExtensionContext | undefined;
  let optionsFault: string | undefined;
  // A paint or poll tick is a total operation (§12.6.3, goal architecture §13.6): option
  // resolution may perform configuration file I/O and strict validation, so a failure
  // degrades to the documented defaults and notifies once per distinct fault. It must
  // never throw out of the host's render path; a display refresh never terminates pi.
  const options = (): AgentUiOptions => {
    let resolved: AgentUiOptions;
    try { resolved = typeof resolveOptions === "function" ? resolveOptions() : resolveOptions; }
    catch (error) {
      const message = `Agents UI configuration unavailable; using defaults: ${error instanceof Error ? error.message : String(error)}`;
      if (message !== optionsFault) { optionsFault = message; if (ctx?.hasUI) ctx.ui.notify(message, "error"); }
      return {};
    }
    optionsFault = undefined;
    return resolved;
  };
  let state = initialState();
  let unsubscribe: (() => void) | undefined, terminal: (() => void) | undefined;
  let requestRender: (() => void) | undefined, close: (() => void) | undefined;
  let customOpen = false, promptDepth = 0, transcriptDirty = false;
  let fleetEditor: SecretaryEditor | undefined, restoreEditor: (() => void) | undefined;
  let polling: { dispose(): void } | undefined;
  const placement = () => options().fleetViewPlacement ?? "belowEditor";
  // The hint must name the action Down will take, so it reads the live caret through the installed
  // editor; without one the empty-editor trigger remains the only state that focuses the indicator.
  const downFocuses = () => fleetEditor ? fleetEditor.caretAtLastLine() : ctx?.ui.getEditorText() === "";
  const fleet = new FleetView(() => state, { rows: () => port.viewModels?.() ?? [], downFocuses });
  const render = () => {
    if (ctx?.mode !== "tui") return;
    ctx.ui.setWidget(FLEET_WIDGET_KEY, () => fleet, { placement: placement() });
    requestRender?.();
  };
  const dispatch = (event: UiEvent) => {
    const result = transition(state, event, event.type === "activate" || event.type === "snapshot" ? port.list() : state.snapshots);
    state = result.state;
    if (event.type === "snapshot" && event.epoch === state.epoch) transcriptDirty = true;
    for (const effect of result.effects) {
      if (effect.type === "render") render();
      else if (effect.type === "feedback") {
        if (state.navigation.kind !== "inspector") ctx?.ui.notify(sanitize(effect.message), "info");
      }
      else if (effect.type === "focus") { if ((effect.target === "editor" || effect.target === "fleet") && state.dialog.kind === "closed") close?.(); }
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
        return new Inspector(() => state, dispatch, randomUUID, () => inspectorHeight(tui.terminal.rows), { keybindings: options().keybindings, expandKey: data => kb.matches(data, "app.tools.expand"), rows: () => port.viewModels?.() ?? [] });
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } });
    } catch (error) { if (state.epoch === epoch) owner.ui.notify(`Agent inspector unavailable: ${String(error)}`, "error"); }
    finally { if (state.epoch === epoch) { customOpen = false; close = undefined; requestRender = undefined; if (state.navigation.kind === "inspector" || state.dialog.kind !== "closed") { dispatch({ type: "escape" }); if (state.navigation.kind === "inspector") dispatch({ type: "escape" }); } } }
  };
  const dispose = () => {
    unsubscribe?.(); terminal?.(); unsubscribe = terminal = undefined;
    polling?.dispose(); polling = undefined;
    close?.(); close = undefined; requestRender = undefined; customOpen = false;
    restoreEditor?.(); restoreEditor = undefined; fleetEditor = undefined;
    if (ctx?.mode === "tui") ctx.ui.setWidget(FLEET_WIDGET_KEY, undefined);
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
    polling = startFleetPolling({ rows: () => port.viewModels?.() ?? [],
      selected: () => state.navigation.kind === "fleet" ? state.navigation.selectedAgentId : undefined,
      repaint: () => { if (state.epoch === epoch) render(); }, subscribe: listener => port.subscribe(listener) });
    // The indicator's Down trigger needs the caret position, which pi exposes only to an editor
    // component. The plugin owns the editor for the session and restores the previous factory on
    // disposal; a host without the custom-editor API keeps the empty-editor-only trigger.
    if (typeof next.ui.setEditorComponent === "function" && typeof next.ui.getEditorComponent === "function") {
      try { restoreEditor = installFleetEditor(next.ui, editor => { fleetEditor = editor; }); }
      catch (error) { next.ui.notify(`Fleet editor integration unavailable; Down at the last line is disabled: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
    }
    if (typeof next.ui.onTerminalInput !== "function") { next.ui.notify("Fleet keyboard integration unavailable. Use /agents.", "warning"); return; }
    terminal = next.ui.onTerminalInput(data => {
      // pi runs extension terminal listeners before it filters key-release events for the focused
      // component (pi-tui `handleTerminalInput`). A terminal that reports event types therefore
      // delivers both the press and the release of one physical key, and acting on both would move
      // the selection twice — or open and close a surface in the same press (UX §2.2).
      if (isKeyRelease(data)) return;
      if (customOpen || promptDepth > 0 || state.dialog.kind !== "closed") return;
      if (matchesStopAll(data) && fleetRows(state).some(active)) {
        dispatch({ type: "stop-all", operationId: randomUUID() });
        if (state.dialog.kind !== "closed") void show();
        return { consume: true };
      }
      if (state.navigation.kind === "editor") {
        // Down enters the indicator when the caret cannot move down any further: an empty editor or
        // the last line of a multi-line draft. The installed editor reports its own caret; the
        // empty-editor test remains the fallback for a host that cannot install it (UX §2.2).
        const atLastLine = fleetEditor ? fleetEditor.downAtLastLine(data) : matchesKey(data, "down") && next.ui.getEditorText() === "";
        if (atLastLine && fleetRows(state).length > 0) {
          dispatch({ type: "fleet", downAtLastLine: true }); return { consume: true };
        }
        return;
      }
      if (state.navigation.kind !== "fleet") return;
      if (matchesStopSelected(data)) {
        const id = state.navigation.selectedAgentId;
        if (id && fleetRows(state).some(a => a.agent.agentId === id)) {
          dispatch({ type: "stop", agentId: id, operationId: randomUUID() });
          if (state.dialog.kind !== "closed") void show();

        }
      }
      else if (matchesKey(data, "escape")) dispatch({ type: "escape" });
      else if (matchesKey(data, "enter")) {
        const id = state.navigation.selectedAgentId;
        if (id) {
          // Enter opens the overlay on the selected agent row.
          dispatch({ type: "open", viewId: randomUUID() });
          dispatch({ type: "select", agentId: id, requestId: randomUUID() });
          void show();
        } else {
          // The main row's destination is the session behind the editor: return focus to the prompt input (UX §2.2).
          dispatch({ type: "escape" });
        }
      } else if (matchesKey(data, "up") || matchesKey(data, "down") || data === "j" || data === "k") {
        const ids = [null, ...fleetRows(state).map(a => a.agent.agentId)];
        const idx = ids.indexOf(state.navigation.selectedAgentId), delta = matchesKey(data, "up") || data === "k" ? -1 : 1;
        // Up on the first row returns focus to the editor (UX §4).
        if (idx + delta < 0) dispatch({ type: "escape" });
        else dispatch({ type: "fleet-select", agentId: ids[Math.max(0, Math.min(ids.length - 1, idx + delta))]! });
      }
      return { consume: true };
    });
  };
  pi.on("ui_prompt_start", () => { promptDepth++; });
  pi.on("ui_prompt_end", () => { promptDepth = Math.max(0, promptDepth - 1); });
  pi.registerCommand("secretary", {
    description: "Configure Secretary: /secretary opens the configuration menu",
    handler: async (_args, commandCtx) => {
      const agentDir = getAgentDir();
      if (commandCtx.mode !== "tui") {
        // Headless modes receive text only; no terminal component, no edits (§6).
        pi.sendMessage({ customType: "secretary-config", content: sanitize(headlessSecretaryConfig(agentDir)), display: true }, { triggerTurn: false });
        return;
      }
      // Full-screen presentation (no overlay), matching pi's native configuration selectors.
      await commandCtx.ui.custom<void>((tui, theme, _kb, done) => new SecretaryConfigMenu({
        agentDir,
        models: () => commandCtx.modelRegistry.getAll().map(model => `${model.provider}/${model.id}`),
        onDismiss: () => done(),
        theme,
      }));
    },
  });
  pi.registerCommand("agents", {
    description: "Inspect agents: /agents [id-or-name], /agents stop <id>, /agents cleanup <id>",
    handler: async (args, commandCtx) => {
      const words = args.trim().split(/\s+/).filter(Boolean), action = words[0] === "stop" || words[0] === "cleanup" ? words.shift() as "stop" | "cleanup" : undefined;
      const reference = words.join(" ");
      const snapshots = sessionTree(port.list(), commandCtx.sessionManager.getSessionId());
      const selected = snapshots.find(a => a.agent.agentId === reference || a.agent.name === reference || a.run?.runId === reference);
      if (commandCtx.mode !== "tui") {
        const text = action ? "Stop and cleanup commands require TUI confirmation. Use TaskStop for an explicit non-TUI stop." : snapshots.map(a => `${a.agent.agentId} ${a.agent.name ?? ""}: ${a.run?.status ?? "idle"} ${a.run?.outputPath ?? ""}`).join("\n") || "No agents in this session.";
        pi.sendMessage({ customType: "secretary-agents", content: sanitize(text), display: true }, { triggerTurn: false }); return;
      }
      if ((reference && !selected) || (action && !reference)) { commandCtx.ui.notify("Specify an agent ID or exact name in this session.", "warning"); return; }
      if (!ctx || state.parentId !== commandCtx.sessionManager.getSessionId()) bind(commandCtx);
      if (customOpen) return;
      if (action && selected) dispatch(action === "stop" ? { type: "stop", agentId: selected.agent.agentId, operationId: randomUUID() } : { type: "cleanup", agentId: selected.agent.agentId });
      else { dispatch({ type: "open", viewId: randomUUID() }); if (selected) dispatch({ type: "select", agentId: selected.agent.agentId, requestId: randomUUID() }); }
      if (state.dialog.kind !== "closed" || state.navigation.kind === "inspector") await show();

    },
  });
  return { bind, dispose };
}
