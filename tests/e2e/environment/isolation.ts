import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
function instantiate(value: unknown, bindings: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    if (!(key in bindings)) throw new Error(`Unbound environment-template value: ${key}`);
    return bindings[key];
  });
  if (Array.isArray(value)) return value.map(item => instantiate(item, bindings));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, instantiate(item, bindings)]));
  return value;
}

/** Versioned templates are copied into disposable writable state, never synthesized test code. */
export function createCleanPiEnvironment(options: {
  name: string;
  extensionUnderTest: string;
  projectFixture: string;
  repositoryState?: "none" | "unborn" | "committed";
}) {
  if (!/^[a-z0-9-]+$/.test(options.name)) throw new Error("Unsafe e2e run name");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifacts = resolve(repository, "test-results", "e2e", options.name, runId);
  mkdirSync(artifacts, { recursive: true });
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "secretary-e2e-")));
  const home = join(workspace, "home");
  const agentDir = join(workspace, "agent");
  const project = join(workspace, "project");
  const sessions = join(artifacts, "sessions");
  const state = join(artifacts, "extension-state");
  for (const path of [home, agentDir, sessions, state]) mkdirSync(path, { recursive: true });
  cpSync(options.projectFixture, project, { recursive: true, errorOnExist: true });
  const extension = realpathSync(options.extensionUnderTest);
  const settingsSource = fileURLToPath(new URL("templates/settings.json", import.meta.url));
  const settings = instantiate(JSON.parse(readFileSync(settingsSource, "utf8")), { EXTENSION_UNDER_TEST: extension });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  // Do not inherit API keys, NODE_OPTIONS, PI_* controls, proxy settings, or user config paths.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: workspace, LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1",
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_SECRETARY_DB_DIR: state, PI_OFFLINE: "1", PI_TELEMETRY: "0",
  };
  const repositoryState = options.repositoryState ?? "none";
  if (repositoryState !== "none") {
    const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") };
    const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { env: gitEnv });
    git("init", "-q");
    if (repositoryState === "committed") {
      git("add", "--all");
      git("-c", "user.name=E2E fixture", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-qm", "Committed fixture scenario");
    }
  }
  const metadata = { repositoryState, repositoryRevision: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: !!execFileSync("git", ["-C", repository, "status", "--porcelain"], { encoding: "utf8" }).trim(),
    workspace, project, agentDir, parentSessions: sessions, extensionState: state,
    extensionUnderTest: extension, settingsTemplate: settingsSource,
    projectFixture: resolve(options.projectFixture),
    modelTransport: "external provider profile", environment: env };
  writeFileSync(join(artifacts, "environment.json"), JSON.stringify(metadata, null, 2) + "\n");
  const extensions = [extension];
  return { repository, artifacts, workspace, home, agentDir, project, sessions, state, extension, extensions, env,
    redact: (text: string) => text,
    dispose() { rmSync(workspace, { recursive: true, force: true }); },
  };
}
export type CleanPiEnvironment = ReturnType<typeof createCleanPiEnvironment>;
