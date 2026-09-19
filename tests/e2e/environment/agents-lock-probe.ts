import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Probe for the agents-widget storage-lock reproduction. Runs INSIDE the pi
 * process and only observes: it records the session thread identity and wraps
 * `ctx.ui.setWidget` so the test can tell when the async-agents widget is
 * mounted (which starts the 500 ms render tick that re-reads the shared goals
 * database through AgentService.viewModels). It changes no behavior.
 *
 * The control directory layout matches the goal-widget harness
 * (storage-lock-extensions.ts): the driver reads `probe-events.jsonl` from the
 * parent of the widget-marker file and the test drives the external writer
 * with the same control helpers.
 */
export default function agentsLockProbe(pi: ExtensionAPI): void {
  const control = process.env.PI_E2E_STORAGE_LOCK;
  if (!control) return; // Not a lock reproduction run; stay inert.
  mkdirSync(control, { recursive: true });
  const events = join(control, "probe-events.jsonl");
  const record = (event: string, extra: Record<string, unknown> = {}) => {
    appendFileSync(events, JSON.stringify({ event, at: Date.now(), ...extra }) + "\n", { mode: 0o600 });
  };
  pi.on("session_start", (_event, ctx) => {
    const threadId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    record("session", { threadId, mode: ctx.mode, hasUI: ctx.hasUI });
    if (!ctx.hasUI) return;
    const original = ctx.ui.setWidget.bind(ctx.ui);
    ctx.ui.setWidget = ((id: string, component: unknown, ...rest: unknown[]) => {
      record("widget", { id, mounted: component !== undefined });
      return (original as (...args: unknown[]) => void)(id, component, ...rest);
    }) as typeof ctx.ui.setWidget;
  });
}
