import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CleanPiEnvironment } from "./isolation.ts";

/** Opt-in reproduction using installed widget extensions, never synthetic UI failures. */
export function useInstalledWidgetExtensions(environment: CleanPiEnvironment, globalAgentDir: string) {
  const names = [...new Set((process.env.PI_E2E_WIDGET_PACKAGES ?? "").split(",").filter(Boolean))];
  const allowed = new Set(["pi-recap", "@juicesharp/rpiv-todo"]);
  const packages = names.map(name => {
    if (!allowed.has(name)) throw new Error(`Unsupported widget reproduction package: ${name}`);
    const root = join(globalAgentDir, "npm", "node_modules", name);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const entries: unknown = manifest.pi?.extensions;
    if (!Array.isArray(entries) || !entries.length || entries.some(entry => typeof entry !== "string")) {
      throw new Error(`No installed extension entry points for ${name}`);
    }
    return { name, version: String(manifest.version), entries: entries.map(entry => resolve(root, entry)) };
  });
  const extensions = packages.flatMap(pkg => pkg.entries);
  let recap: { source: string; modelOverride?: string } | undefined;
  if (names.includes("pi-recap")) {
    const sourceHome = process.env.PI_RECAP_HOME ?? join(homedir(), ".pi", "agent", "extensions", "pi-recap");
    const source = join(sourceHome, "state", "config.json");
    const settings = existsSync(source) ? JSON.parse(readFileSync(source, "utf8")) : {};
    if (settings.modelOverride !== undefined && typeof settings.modelOverride !== "string") throw new Error("Invalid installed recap model setting");
    // Preserve only the real model preference, not the user's recap history or mutable state.
    // All plugin-generated files stay in the disposable test environment.
    environment.env.PI_RECAP_HOME = join(environment.workspace, "widget-state", "pi-recap");
    const state = join(environment.env.PI_RECAP_HOME, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "config.json"), JSON.stringify({ modelOverride: settings.modelOverride }) + "\n", { mode: 0o600 });
    recap = { source, modelOverride: settings.modelOverride };
  }
  if (extensions.length) {
    const path = join(environment.agentDir, "settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8"));
    settings.extensions.push(...extensions);
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    environment.extensions.push(...extensions);
    const profilePath = join(environment.artifacts, "provider-profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.loadedExtensions = [...environment.extensions];
    writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");
    writeFileSync(join(environment.artifacts, "widget-profile.json"), JSON.stringify({ packages, recap,
      stateIsolation: "Private temporary HOME, agent directory, and PI_RECAP_HOME; original plugin state is unchanged" }, null, 2) + "\n");
  }
  return { packages, extensions, recap };
}
