import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { MODEL_ALIASES, isExactModelIdentifier, type AgentConfiguration, type AgentModelAlias } from "./configuration.ts";
import type { AgentDefinition } from "./records.ts";

const fields = new Set(["name", "description", "tools", "disallowedTools", "model", "maxTurns", "background", "isolation"]);
const safeName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const isAlias = (value: string): value is AgentModelAlias => (MODEL_ALIASES as readonly string[]).includes(value);

function tools(value: unknown, field: string): string[] {
  const list = typeof value === "string" ? value.split(",").map((item) => item.trim()) : value;
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(item))) {
    throw new Error(`${field} must be a tool-name array or comma-separated tool names`);
  }
  if (new Set(list).size !== list.length) throw new Error(`${field} contains duplicate tools`);
  return [...list];
}

function definition(content: string, source: string): AgentDefinition {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^---\n[\s\S]*?\n---(?:\n|$)/.test(normalized)) throw new Error(`${source}: missing or invalid YAML frontmatter`);
  const { frontmatter: data, body } = parseFrontmatter(content);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${source}: frontmatter must be an object`);
  for (const key of Object.keys(data)) if (!fields.has(key)) throw new Error(`${source}: unsupported agent field ${key}`);
  if (typeof data.name !== "string" || !safeName.test(data.name) || ["__proto__", "constructor", "prototype"].includes(data.name)) throw new Error(`${source}: invalid agent name`);
  if (typeof data.description !== "string" || !data.description.trim()) throw new Error(`${source}: description must be nonempty`);
  const result: AgentDefinition = { name: data.name, description: data.description, prompt: body.trim() ? body : "", source, hash: hash(content), resumable: true };
  for (const key of ["tools", "disallowedTools"] as const) if (Object.hasOwn(data, key)) result[key] = tools(data[key], `${source}: ${key}`);
  if (Object.hasOwn(data, "model")) {
    if (typeof data.model !== "string" || !(data.model === "inherit" || isAlias(data.model) || isExactModelIdentifier(data.model))) throw new Error(`${source}: invalid model; expected alias, inherit, or provider/modelId`);
    result.model = data.model;
  }
  if (Object.hasOwn(data, "maxTurns")) {
    if (typeof data.maxTurns !== "number" || !Number.isSafeInteger(data.maxTurns) || data.maxTurns < 1) throw new Error(`${source}: maxTurns must be a positive integer`);
    result.maxTurns = data.maxTurns;
  }
  if (Object.hasOwn(data, "background")) {
    if (typeof data.background !== "boolean") throw new Error(`${source}: background must be boolean`);
    result.background = data.background;
  }
  if (Object.hasOwn(data, "isolation")) {
    if (data.isolation !== "worktree") throw new Error(`${source}: unsupported isolation`);
    result.isolation = data.isolation;
  }
  return result;
}

export function discoverAgents(cwd: string, agentDir: string, trusted: boolean): Map<string, AgentDefinition> {
  const result = new Map<string, AgentDefinition>();
  for (const [name, description, prompt] of [
    ["general-purpose", "General-purpose delegated work", "Complete the delegated task using authorized tools. Report results and unresolved limitations."],
    ["Explore", "Read-only codebase exploration", "Explore the codebase using read-only tools. Report findings with file references; do not modify files."],
    ["Plan", "Read-only implementation planning", "Inspect the codebase and produce an implementation plan. Do not modify files."],
  ]) {
    const snapshot = { name, description, prompt, source: `packaged:${name}`, resumable: name === "general-purpose", ...(name === "general-purpose" ? {} : { tools: ["read", "grep", "find", "ls"] }) };
    result.set(name, { ...snapshot, hash: hash(JSON.stringify(snapshot)) });
  }
  const paths = [join(agentDir, "agents")];
  if (trusted) paths.push(join(cwd, CONFIG_DIR_NAME, "agents"));
  for (const path of paths) {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const names = new Set<string>();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
      const source = join(path, entry.name);
      const agent = definition(readFileSync(source, "utf8"), source);
      if (names.has(agent.name)) throw new Error(`${path}: duplicate agent name ${agent.name}`);
      names.add(agent.name);
      result.set(agent.name, agent);
    }
  }
  return result;
}

export async function resolveAgentModel(
  definition: AgentDefinition,
  alias: AgentModelAlias | undefined,
  config: AgentConfiguration,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels">,
): Promise<Model<Api>> {
  let requested: string | undefined = alias ?? definition.model;
  if (alias !== undefined && !isAlias(alias)) throw new Error(`Unsupported Agent.model alias: ${alias}`);
  if (requested && isAlias(requested)) {
    const mapping = config.modelAliases[requested];
    if (!mapping) throw new Error(`Missing agents.modelAliases.${requested} configuration`);
    requested = mapping;
  }
  if (!requested || requested === "inherit") {
    if (!ctx.model) throw new Error("No parent model is available to inherit");
    requested = `${ctx.model.provider}/${ctx.model.id}`;
  }
  if (!isExactModelIdentifier(requested)) throw new Error(`Invalid exact model identifier: ${requested}`);
  const slash = requested.indexOf("/");
  const model = ctx.modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1));
  if (!model) throw new Error(`Model unavailable: ${requested}`);
  if (ctx.scopedModels.length && !ctx.scopedModels.some((entry) => entry.model.provider === model.provider && entry.model.id === model.id)) throw new Error(`Model outside parent scoped models: ${requested}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Authentication unavailable for ${requested}: ${auth.error}`);
  return model;
}
