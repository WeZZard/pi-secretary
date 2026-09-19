/**
 * Agents UI configuration fault tolerance (architecture §12.6.3, goal
 * architecture §13.6): resolving the agents UI options on the display path
 * performs file I/O and strict validation (loadAgentConfiguration). A
 * validation failure must degrade to the documented defaults with a
 * diagnostic notification; it must never throw out of the host's render
 * path. A display refresh is never allowed to terminate the host process.
 *
 * Regression: production crash of 2026-09-19. A session running newer code
 * wrote `agents.modelFallbackLists` into the user-global secretary.json
 * while the installed extension predated that key. The installed build
 * rejects unknown `agents` fields by design (§12.6.5), so the indicator's
 * poll tick's repaint threw `unsupported agents field modelFallbackLists`
 * out of the `setInterval` callback, and pi exited with an
 * uncaughtException. This test replays that sequence in process: bind with
 * a valid configuration, contaminate the file mid-session, then drive the
 * same tick closure the polling timer runs.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentUI, FLEET_WIDGET_KEY } from "../../extensions/secretary/agents/ui/commands.ts";
import { loadAgentConfiguration } from "../../extensions/secretary/agents/configuration.ts";

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "secretary-ui-config-fault-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), agentDir = join(root, "user");
  mkdirSync(agentDir, { recursive: true });
  const configPath = join(agentDir, "secretary.json");
  const putConfig = (agents: unknown) => writeFileSync(configPath, JSON.stringify({ agents }));

  const listeners = new Set<() => void>();
  const notifications: Array<{ message: string; level: string }> = [];
  const widgets: Array<{ key: string; placement: string | undefined }> = [];
  const noopTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, fgDim: (text: string) => text };

  // The exact production resolver from installation.ts.
  const resolveOptions = () => {
    const config = loadAgentConfiguration(cwd, agentDir, false);
    return { fleetViewPlacement: config.ui.fleetViewPlacement, keybindings: config.ui.fleetKeybindings };
  };
  // One running background row mirrors the incident session: hasRunning makes
  // every poll tick repaint, so each tick re-resolves the UI options.
  const runningRow = { agentId: "agent-1", name: "walkthrough-tester", status: "running", description: "relay", model: "p/m",
    startedAt: Date.now(), activity: "thinking…", background: true };
  const port: any = {
    list: () => [],
    viewModels: () => [runningRow],
    transcript: () => [],
    message: async () => {},
    stop: async () => {},
    cleanup: async () => {},
    receipt: async () => undefined,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const pi: any = { on: () => {}, registerCommand: () => {} };
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: { getSessionId: () => "thread-1" },
    ui: {
      setWidget: (key: string, factory: unknown, options?: { placement?: string }) => {
        if (typeof factory === "function") widgets.push({ key, placement: options?.placement });
      },
      notify: (message: string, level: string) => notifications.push({ message, level }),
      getToolsExpanded: () => false,
      getEditorText: () => "",
      onTerminalInput: () => () => {},
      setStatus: () => {},
      theme: noopTheme,
    },
  };
  const ui = registerAgentUI(pi, port, resolveOptions);
  t.after(() => ui.dispose());
  /** The same closure startFleetPolling hands to setInterval (fleet-view.ts tick). */
  const tick = () => { for (const listener of [...listeners]) listener(); };
  return { putConfig, tick, bind: () => ui.bind(ctx), notifications, widgets };
}

test("agents display refresh survives an unsupported agents configuration field", (t) => {
  const h = harness(t);
  h.putConfig({ maxConcurrent: 2 });
  h.bind();
  h.tick();
  h.notifications.length = 0;
  h.widgets.length = 0;

  // Mid-session contamination: a newer build writes a key this build rejects
  // by design (unknown-key validation, §12.6.5). In the incident the key was
  // modelFallbackLists; this build already supports that key, so the
  // reproducer uses a stand-in future field.
  h.putConfig({ unsupportedFutureField: { Superior: ["litellm/kimi-k3"] } });

  assert.doesNotThrow(h.tick, "the poll tick must not throw out of the host's render path (§12.6.3, §13.6)");
  assert.ok(h.notifications.some(entry => entry.level === "error" && /configuration/i.test(entry.message)),
    `a diagnostic notification is expected; got ${JSON.stringify(h.notifications)}`);
  assert.ok(h.widgets.some(entry => entry.key === FLEET_WIDGET_KEY && entry.placement === "belowEditor"),
    "the fleet indicator keeps rendering with the documented default placement");
  assert.ok(h.widgets.every(entry => entry.key === FLEET_WIDGET_KEY),
    "the unified indicator is the only registered widget; the async widget is removed");
});

test("the configuration-fault notification is throttled and re-arms after recovery", (t) => {
  const h = harness(t);
  h.putConfig({ maxConcurrent: 2 });
  h.bind();
  h.tick();
  h.notifications.length = 0;

  h.putConfig({ unsupportedFutureField: true });
  h.tick();
  h.tick();
  const duringFault = h.notifications.filter(entry => entry.level === "error");
  assert.equal(duringFault.length, 1, "a persistent fault notifies once, not on every tick");

  h.putConfig({ maxConcurrent: 2 });
  h.tick();
  h.putConfig({ unsupportedFutureField: true });
  h.tick();
  const afterRefault = h.notifications.filter(entry => entry.level === "error");
  assert.equal(afterRefault.length, 2, "a fault that recovers and recurs notifies again");
});
