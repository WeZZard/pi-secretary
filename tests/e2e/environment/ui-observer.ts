import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Records lifecycle facts without replacing tools, providers, UI methods, or session outcomes. */
export default function observeTerminalSession(pi: ExtensionAPI) {
  const path = process.env.PI_E2E_UI_OBSERVER;
  if (!path) throw new Error("The terminal E2E observer requires its output path");
  function record(event: string, ctx: ExtensionContext) {
    appendFileSync(path!, JSON.stringify({ event, sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd, mode: ctx.mode, hasUI: ctx.hasUI,
      setWidget: typeof ctx.ui.setWidget, onTerminalInput: typeof ctx.ui.onTerminalInput,
      timestamp: Date.now() }) + "\n", { mode: 0o600 });
  }
  pi.on("session_start", (_event, ctx) => record("session_start", ctx));
  pi.on("agent_end", (_event, ctx) => record("agent_end", ctx));
  pi.on("session_shutdown", (_event, ctx) => record("session_shutdown", ctx));
}
