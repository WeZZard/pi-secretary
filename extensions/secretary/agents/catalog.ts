import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { canonicalJson, type JsonValue, type PreparedContext } from "../context/index.ts";
import { loadAgentConfiguration, type AgentConfiguration } from "./configuration.ts";
import { discoverAgents } from "./registry.ts";
import type { AgentDefinition } from "./records.ts";

export const AGENT_CATALOG_ID = "secretary.agent-catalog";
export type AgentCatalogSnapshot = {
  status: "ready"; cwd: string; trusted: boolean; fingerprint: string;
  definitions: AgentDefinition[]; config: AgentConfiguration;
} | { status: "disabled" | "unavailable"; reason: string };

/** Source manifests detect changes across discovery, including shadowed files and membership. */
function manifest(cwd: string, agentDir: string, trusted: boolean): string {
  const roots = [agentDir, ...(trusted ? [join(cwd, CONFIG_DIR_NAME)] : [])];
  const sources: JsonValue[] = [];
  function file(path: string): void {
    try {
      const before = statSync(path, { bigint: true });
      const content = readFileSync(path);
      const after = statSync(path, { bigint: true });
      const identity = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
      if (identity(before) !== identity(after)) throw new Error("unstable_sources");
      sources.push([path, identity(after), createHash("sha256").update(content).digest("hex")]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      sources.push([path, null]);
    }
  }
  for (const root of roots) {
    file(join(root, "secretary.json"));
    const directory = join(root, "agents");
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      sources.push([directory, null]); continue;
    }
    const names = entries.filter(e => e.name.endsWith(".md") && (e.isFile() || e.isSymbolicLink())).map(e => e.name).sort();
    sources.push([directory, names]);
    for (const name of names) file(join(directory, name));
  }
  return createHash("sha256").update(canonicalJson(sources)).digest("hex");
}

export function captureAgentCatalog(cwd: string, agentDir: string, trusted: boolean, enabled: boolean, depth: number): AgentCatalogSnapshot {
  if (!enabled) return { status: "disabled", reason: "delegation_unavailable" };
  try {
    const before = manifest(cwd, agentDir, trusted);
    const config = loadAgentConfiguration(cwd, agentDir, trusted);
    const definitions = [...discoverAgents(cwd, agentDir, trusted).values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (before !== manifest(cwd, agentDir, trusted)) return { status: "unavailable", reason: "unstable_sources" };
    if (depth >= config.maxNestingDepth) return { status: "disabled", reason: "maximum_nesting_depth" };
    return { status: "ready", cwd, trusted, fingerprint: before, config, definitions };
  } catch (error) {
    // Whitelist bounded diagnostic fields; never expose source contents or raw parser exceptions.
    const unsupported = error instanceof Error ? /unsupported agent field ([A-Za-z0-9_]{1,64})(?:\s|$)/.exec(error.message) : null;
    return { status: "unavailable", reason: unsupported ? `unsupported agent field ${unsupported[1]}` : "invalid_or_unreadable_configuration" };
  }
}

export function projectAgentCatalog(snapshot: Readonly<AgentCatalogSnapshot>): JsonValue {
  if (snapshot.status !== "ready") return { status: snapshot.status, reason: snapshot.reason };
  return { status: "ready", defaultType: "general-purpose",
    definitions: snapshot.definitions.map(d => ({ type: d.name, description: d.description, modelPolicy: d.model ?? "inherit" })),
    modelFallbackLists: Object.keys(snapshot.config.modelFallbackLists).sort() };
}

/** One in-flight generation becomes exact call bindings at assistant message_end, before preflight. */
export class AgentCatalogReceipts {
  #pending?: PreparedContext;
  #calls = new Map<string, PreparedContext>();

  begin(): void { this.#pending = undefined; }
  prepared(context: PreparedContext): void { this.#pending = context; }
  bind(calls: readonly { id: string; name: string }[]): void {
    const request = this.#pending;
    this.#pending = undefined;
    if (!request) return;
    for (const call of calls) {
      if (call.name === "Agent" && !this.#calls.has(call.id)) this.#calls.set(call.id, request);
    }
  }
  release(id: string): void { this.#calls.delete(id); }
  clear(): void { this.#pending = undefined; this.#calls.clear(); }
  get(id: string, sessionId: string): Extract<AgentCatalogSnapshot, { status: "ready" }> {
    const request = this.#calls.get(id);
    if (!request || request.sessionId !== sessionId) throw new Error("Agent request correlation is unavailable. Ask again to prepare a current catalog; definition files will not be rediscovered for this call.");
    if (request.errorCode || request.contributions.get(AGENT_CATALOG_ID)?.status !== "ready") {
      throw new Error("Agent catalog could not be published for this request. Correct unavailable or oversized configuration and try again.");
    }
    const snapshot = request.getSnapshot<AgentCatalogSnapshot>(AGENT_CATALOG_ID);
    if (!snapshot || snapshot.status !== "ready") {
      throw new Error(`Agent catalog is ${snapshot?.status ?? "unavailable"}${snapshot ? ` (${snapshot.reason})` : ""}. Check definition files, delegation availability, and configuration before trying again.`);
    }
    return snapshot;
  }
}
