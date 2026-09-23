import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { validateInspectorKeybindings, type InspectorKeybindingsConfig } from "./ui/keybindings.ts";

export const FALLBACK_LIST_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export interface AgentUiConfiguration {
  fleetViewPlacement: "belowEditor" | "aboveEditor";
  fleetKeybindings: InspectorKeybindingsConfig;
}
/** The concurrency, timeout, and nesting limits, edited together in the configuration menu (UX §2.5). */
export const AGENT_LIMIT_FIELDS = ["maxConcurrent", "maxQueued", "shutdownTimeoutMs", "maxNestingDepth"] as const;
export type AgentLimitField = (typeof AGENT_LIMIT_FIELDS)[number];
export interface AgentLimits {
  maxConcurrent: number;
  maxQueued: number;
  shutdownTimeoutMs: number;
  /** Levels of nested delegation below the main session (SA-12; architecture §7). */
  maxNestingDepth: number;
}
/** The smallest value each limit accepts: an idle queue or an instant timeout is meaningful, zero workers is not. */
export const agentLimitMinimum = (field: AgentLimitField): number => field === "maxConcurrent" || field === "maxNestingDepth" ? 1 : 0;
export interface AgentConfiguration extends AgentLimits {
  modelFallbackLists: Record<string, string[]>;
  /** Per-definition model assignments keyed by agent name (architecture §5.3). */
  subagentModels: Record<string, string>;
  ui: AgentUiConfiguration;
}
export const defaultAgentUi = (): AgentUiConfiguration => ({ fleetViewPlacement: "belowEditor", fleetKeybindings: {} });

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

function applyAgentsConfiguration(agents: Record<string, unknown>, path: string, result: AgentConfiguration): void {
  for (const [key, value] of Object.entries(agents)) {
      if (key === "modelFallbackLists") {
        for (const [name, list] of Object.entries(object(value, `${path}: agents.modelFallbackLists`))) {
          if (!FALLBACK_LIST_NAME.test(name) || name === "inherit") {
            throw new Error(`${path}: invalid agents.modelFallbackLists name ${name}; use the agent-name pattern and avoid the reserved name inherit`);
          }
          if (!Array.isArray(list) || list.some(entry => !isExactModelIdentifier(entry))) {
            throw new Error(`${path}: agents.modelFallbackLists.${name} must be an array of exact provider/modelId identifiers`);
          }
          if (new Set(list).size !== list.length) throw new Error(`${path}: agents.modelFallbackLists.${name} contains duplicate models`);
          result.modelFallbackLists[name] = [...list];
        }
      } else if (key === "subagentModels") {
        for (const [name, assigned] of Object.entries(object(value, `${path}: agents.subagentModels`))) {
          if (!FALLBACK_LIST_NAME.test(name) || name === "inherit") {
            throw new Error(`${path}: invalid agents.subagentModels name ${name}; use the agent-name pattern and avoid the reserved name inherit`);
          }
          if (typeof assigned !== "string" || !(assigned === "inherit" || isExactModelIdentifier(assigned) || FALLBACK_LIST_NAME.test(assigned))) {
            throw new Error(`${path}: agents.subagentModels.${name} must be inherit, an exact provider/modelId, or a model fallback list name`);
          }
          result.subagentModels[name] = assigned;
        }
      } else if (key === "modelAliases") {
        throw new Error(`${path}: agents.modelAliases was removed; use agents.modelFallbackLists (an object mapping list names to ordered provider/modelId arrays)`);
      } else if (key === "maxConcurrent" || key === "maxQueued" || key === "shutdownTimeoutMs" || key === "maxNestingDepth") {
        const minimum = agentLimitMinimum(key);
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
          throw new Error(`${path}: agents.${key} must be an integer >= ${minimum}`);
        }
        result[key] = value;
      } else if (key === "ui") {
        const ui = object(value, `${path}: agents.ui`);
        for (const [uiKey, uiValue] of Object.entries(ui)) {
          if (uiKey === "inlineToolDisplay") {
            if (uiValue !== "rich" && uiValue !== "summary") throw new Error(`${path}: agents.ui.inlineToolDisplay must be "rich" or "summary"`);
            // Retired selector: accept old known values without retaining a display mode.
            // Pi's expanded state is now the only detail-disclosure control.
          } else if (uiKey === "fleetViewPlacement") {
            if (uiValue !== "belowEditor" && uiValue !== "aboveEditor") throw new Error(`${path}: agents.ui.fleetViewPlacement must be "belowEditor" or "aboveEditor"`);
            result.ui.fleetViewPlacement = uiValue;
          } else if (uiKey === "asyncWidget") {
            // Recognized and ignored (§12.6.5): the async widget is removed, but configurations
            // written by earlier builds stay valid instead of failing as an unknown key.
          } else if (uiKey === "fleetKeybindings") {
            result.ui.fleetKeybindings = { ...result.ui.fleetKeybindings, ...validateInspectorKeybindings(uiValue, `${path}: agents.ui.fleetKeybindings`) };
          } else throw new Error(`${path}: unsupported agents.ui field ${uiKey}`);
        }
      } else throw new Error(`${path}: unsupported agents field ${key}`);
  }
}

export const defaultAgentConfiguration = (): AgentConfiguration => ({ modelFallbackLists: {}, subagentModels: {}, maxConcurrent: 4, maxQueued: 16, shutdownTimeoutMs: 5000, maxNestingDepth: 3, ui: defaultAgentUi() });

export function loadAgentConfiguration(cwd: string, agentDir: string, trusted: boolean): AgentConfiguration {
  const result = defaultAgentConfiguration();
  const paths = [join(agentDir, "secretary.json")];
  if (trusted) paths.push(join(cwd, CONFIG_DIR_NAME, "secretary.json"));
  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const root = object(JSON.parse(text), path);
    if (!Object.hasOwn(root, "agents")) continue;
    applyAgentsConfiguration(object(root.agents, `${path}: agents`), path, result);
  }
  return result;
}

/**
 * Apply an operation to the persisted model fallback lists at the persistence boundary
 * (architecture §12.6.5). The lists are re-read from disk immediately before the operation
 * runs, so a caller holding an older in-memory copy can express intent — add a list, remove
 * a model, rename — without reverting a newer edit made by another session or by hand. An
 * operation that cannot apply to the fresh state fails and leaves the file unchanged. The
 * full resulting `agents` object is validated against the file-loading rules before anything
 * is written; a failed validation or write leaves the previous configuration in effect.
 * Project-level overrides are never touched.
 */
function rewriteAgentsConfiguration(agentDir: string, apply: (agents: Record<string, unknown>, path: string) => Record<string, unknown>): Record<string, unknown> {
  const path = join(agentDir, "secretary.json");
  let root: Record<string, unknown> = {};
  try { root = object(JSON.parse(readFileSync(path, "utf8")), path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const agents = Object.hasOwn(root, "agents") ? object(root.agents, `${path}: agents`) : {};
  const candidate = apply(agents, path);
  applyAgentsConfiguration(candidate, path, defaultAgentConfiguration());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...root, agents: candidate }, null, 2) + "\n");
  return candidate;
}

/** Read one `agents.<key>` object into a fresh accumulator, so a caller receives the persisted value. */
function readAgentKey<T>(agents: Record<string, unknown>, path: string, key: "modelFallbackLists" | "subagentModels", seed: AgentConfiguration): T {
  if (Object.hasOwn(agents, key)) applyAgentsConfiguration({ [key]: agents[key] }, path, seed);
  return seed[key] as T;
}

export function updateModelFallbackLists(agentDir: string, update: (lists: Record<string, string[]>) => Record<string, string[]>): Record<string, string[]> {
  const candidate = rewriteAgentsConfiguration(agentDir, (agents, path) => ({
    ...agents, modelFallbackLists: update({ ...readAgentKey(agents, path, "modelFallbackLists", defaultAgentConfiguration()) }),
  }));
  return candidate.modelFallbackLists as Record<string, string[]>;
}

/**
 * Apply an operation to the persisted per-definition model assignments (architecture §5.3).
 * It shares the persistence boundary of `updateModelFallbackLists`: the assignments are
 * re-read from disk immediately before the operation runs, the full resulting `agents`
 * object is validated before anything is written, and project-level overrides are never
 * touched.
 */
export function updateSubagentModels(agentDir: string, update: (models: Record<string, string>) => Record<string, string>): Record<string, string> {
  const candidate = rewriteAgentsConfiguration(agentDir, (agents, path) => ({
    ...agents, subagentModels: update({ ...readAgentKey(agents, path, "subagentModels", defaultAgentConfiguration()) }),
  }));
  return candidate.subagentModels as Record<string, string>;
}

/** Replace the persisted lists wholesale. Callers with per-operation intent should prefer updateModelFallbackLists. */
export function saveModelFallbackLists(agentDir: string, lists: Record<string, string[]>): void {
  updateModelFallbackLists(agentDir, () => lists);
}

/**
 * Apply an operation to the persisted concurrency, timeout, and nesting limits (UX §2.5). It shares
 * the persistence boundary of `updateModelFallbackLists`: the file is re-read immediately before the
 * operation runs, the full resulting `agents` object is validated before anything is written, and
 * project-level overrides are never touched.
 */
export function updateAgentLimits(agentDir: string, update: (limits: AgentLimits) => AgentLimits): AgentLimits {
  const candidate = rewriteAgentsConfiguration(agentDir, (agents, path) => {
    // Validate the fresh state first, so the operation sees the values actually on disk rather than
    // the caller's older copy, and so an unreadable file fails before anything is replaced.
    const current = defaultAgentConfiguration();
    applyAgentsConfiguration(agents, path, current);
    return { ...agents, ...update({
      maxConcurrent: current.maxConcurrent, maxQueued: current.maxQueued,
      shutdownTimeoutMs: current.shutdownTimeoutMs, maxNestingDepth: current.maxNestingDepth,
    }) };
  });
  return {
    maxConcurrent: candidate.maxConcurrent as number, maxQueued: candidate.maxQueued as number,
    shutdownTimeoutMs: candidate.shutdownTimeoutMs as number, maxNestingDepth: candidate.maxNestingDepth as number,
  };
}
