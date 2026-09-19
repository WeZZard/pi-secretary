import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CleanPiEnvironment } from "./isolation.ts";

/**
 * Starts the real TUI on a PTY with the agents storage-lock driver: identical
 * launch semantics to `startStorageLockPi`, but the Python driver allows a
 * longer launch turn (the live model must complete a full child run before the
 * async-agents widget can render against the locked database).
 */
export function startAgentsLockPi(environment: CleanPiEnvironment, options: {
  prompt: string; model: string; observer: string; widgetMarker: string;
  idleSeconds?: number; timeoutMs?: number; turnTimeoutMs?: number; tools?: string[];
}) {
  const promptFile = join(environment.workspace, "terminal-prompt.txt");
  writeFileSync(promptFile, options.prompt, { mode: 0o600 });
  const args = [join(environment.repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--no-extensions", ...environment.extensions.flatMap(extension => ["--extension", extension]),
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--approve", "--session-dir", environment.sessions, "--model", options.model,
    ...(options.tools ? ["--tools", options.tools.join(",")] : []), "--tui-mode", "regular"];
  const terminal = join(environment.artifacts, "terminal");
  const driver = join(environment.repository, "tests/e2e/environment/agents-lock-terminal-process.py");
  const env: NodeJS.ProcessEnv = { ...environment.env, TERM: "xterm-256color", COLORTERM: "truecolor", PI_E2E_UI_OBSERVER: options.observer };
  delete env.NO_COLOR;
  writeFileSync(join(environment.artifacts, "invocation.json"), JSON.stringify({ executable: process.execPath, args,
    cwd: environment.project, input: "PTY bracketed paste followed by Enter", terminal, driver,
    widgetMarker: options.widgetMarker, idleSeconds: options.idleSeconds ?? 6 }, null, 2) + "\n");
  const child = spawn("python3", [driver, "--artifacts", terminal, "--observer", options.observer,
    "--prompt-file", promptFile, "--ready-text", options.model.slice(options.model.indexOf("/") + 1),
    "--widget-marker", options.widgetMarker, "--idle-seconds", String(options.idleSeconds ?? 6),
    "--timeout", String((options.timeoutMs ?? 330000) / 1000),
    "--turn-timeout", String((options.turnTimeoutMs ?? 300000) / 1000), "--", process.execPath, ...args],
    { cwd: environment.project, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", text => { stdout += text; });
  child.stderr.on("data", text => { stderr += text; });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      writeFileSync(join(environment.artifacts, "terminal-driver.stdout.log"), environment.redact(stdout));
      writeFileSync(join(environment.artifacts, "terminal-driver.stderr.log"), environment.redact(stderr));
      resolve({ code, signal });
    });
  });
  return { terminal, result, stop: () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } };
}
