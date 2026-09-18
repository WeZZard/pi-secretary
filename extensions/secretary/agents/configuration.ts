import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;
export type AgentModelAlias = (typeof MODEL_ALIASES)[number];
export interface AgentConfiguration {
  modelAliases: Partial<Record<AgentModelAlias, string>>;
  maxConcurrent: number;
  maxQueued: number;
  shutdownTimeoutMs: number;
}

/** Omission inherits the definition; an explicit none keeps the parent directory. */
export function resolveIsolation(requested: unknown, definition?: "none" | "worktree"): "none" | "worktree" {
  if (requested !== undefined && requested !== "none" && requested !== "worktree") throw new Error("Unsupported isolation: use none or worktree");
  return requested ?? definition ?? "none";
}

export function isExactModelIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[^/\s]+\/[^\s]+$/.test(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function loadAgentConfiguration(cwd: string, agentDir: string, trusted: boolean): AgentConfiguration {
  const result: AgentConfiguration = { modelAliases: {}, maxConcurrent: 4, maxQueued: 16, shutdownTimeoutMs: 5000 };
  const paths = [join(agentDir, "secretary.json")];
  if (trusted) paths.push(join(cwd, CONFIG_DIR_NAME, "secretary.json"));
  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const root = object(JSON.parse(text), path);
    if (!Object.hasOwn(root, "agents")) continue;
    const agents = object(root.agents, `${path}: agents`);
    for (const [key, value] of Object.entries(agents)) {
      if (key === "modelAliases") {
        for (const [alias, model] of Object.entries(object(value, `${path}: agents.modelAliases`))) {
          if (!(MODEL_ALIASES as readonly string[]).includes(alias) || !isExactModelIdentifier(model)) {
            throw new Error(`${path}: invalid agents.modelAliases.${alias}; expected an exact provider/modelId`);
          }
          result.modelAliases[alias as AgentModelAlias] = model;
        }
      } else if (key === "maxConcurrent" || key === "maxQueued" || key === "shutdownTimeoutMs") {
        const minimum = key === "maxConcurrent" ? 1 : 0;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
          throw new Error(`${path}: agents.${key} must be an integer >= ${minimum}`);
        }
        result[key] = value;
      } else throw new Error(`${path}: unsupported agents field ${key}`);
    }
  }
  return result;
}
