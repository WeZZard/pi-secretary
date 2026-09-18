import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CleanPiEnvironment } from "./isolation.ts";

/** Real CLI process boundary. It knows nothing about Secretary tools or test assertions. */
export function startPi(environment: CleanPiEnvironment, options: {
  prompt: string;
  model: string;
  timeoutMs?: number;
  offline?: boolean;
  tools?: string[];
}) {
  const args = [join(environment.repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    ...(options.offline === false ? [] : ["--offline"]), "--no-extensions",
    ...environment.extensions.flatMap(extension => ["--extension", extension]),
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--approve", "--session-dir", environment.sessions,
    "--model", options.model, ...(options.offline === false ? [] : ["--thinking", "off"]),
    ...(options.tools ? ["--tools", options.tools.join(",")] : []),
    "--mode", "json", "--print", "--", options.prompt];
  writeFileSync(join(environment.artifacts, "invocation.json"), JSON.stringify({ executable: process.execPath, args, cwd: environment.project }, null, 2) + "\n");
  const child = spawn(process.execPath, args, { cwd: environment.project, env: environment.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", text => { stdout += text; if (stdout.length > 16_000_000) child.kill("SIGTERM"); });
  child.stderr.on("data", text => { stderr += text; if (stderr.length > 16_000_000) child.kill("SIGTERM"); });
  const persistLogs = () => {
    writeFileSync(join(environment.artifacts, "stdout.jsonl"), environment.redact(stdout));
    writeFileSync(join(environment.artifacts, "stderr.log"), environment.redact(stderr));
  };
  let timedOut = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true; child.kill("SIGTERM");
    force = setTimeout(() => child.kill("SIGKILL"), 3000);
  }, options.timeoutMs ?? 30000);
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve, reject) => {
    child.once("error", error => { clearTimeout(timer); clearTimeout(force); persistLogs(); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(force);
      persistLogs();
      const outcome = { code, signal, timedOut };
      writeFileSync(join(environment.artifacts, "process-result.json"), JSON.stringify(outcome, null, 2) + "\n");
      resolve(outcome);
    });
  });
  return { result, stop: () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); } };
}
