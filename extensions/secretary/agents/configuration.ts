import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { validateInspectorKeybindings, type InspectorKeybindingsConfig } from "./ui/keybindings.ts";

export const FALLBACK_LIST_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export interface AgentUiConfiguration {
  fleetViewPlacement: "belowEditor" | "aboveEditor";
  fleetKeybindings: InspectorKeybindingsConfig;
}
export interface AgentConfiguration {
  modelFallbackLists: Record<string, string[]>;
  maxConcurrent: number;
  maxQueued: number;
  shutdownTimeoutMs: number;
  /** Levels of nested delegation below the main session (SA-12; architecture §7). */
  maxNestingDepth: number;
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
      } else if (key === "modelAliases") {
        throw new Error(`${path}: agents.modelAliases was removed; use agents.modelFallbackLists (an object mapping list names to ordered provider/modelId arrays)`);
      } else if (key === "maxConcurrent" || key === "maxQueued" || key === "shutdownTimeoutMs" || key === "maxNestingDepth") {
        const minimum = key === "maxConcurrent" || key === "maxNestingDepth" ? 1 : 0;
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

export const defaultAgentConfiguration = (): AgentConfiguration => ({ modelFallbackLists: {}, maxConcurrent: 4, maxQueued: 16, shutdownTimeoutMs: 5000, maxNestingDepth: 3, ui: defaultAgentUi() });

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
 * Validate and persist model fallback lists to the user-global secretary.json
 * (architecture §12.6.5). The full resulting `agents` object is validated against the
 * file-loading rules before anything is written; a failed validation or write leaves
 * the previous configuration in effect. Project-level overrides are never touched.
 */
export function saveModelFallbackLists(agentDir: string, lists: Record<string, string[]>): void {
  const path = join(agentDir, "secretary.json");
  let root: Record<string, unknown> = {};
  try { root = object(JSON.parse(readFileSync(path, "utf8")), path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const agents = Object.hasOwn(root, "agents") ? object(root.agents, `${path}: agents`) : {};
  const candidate: Record<string, unknown> = { ...agents,
    modelFallbackLists: Object.fromEntries(Object.entries(lists).map(([name, entries]) => [name, [...entries]])) };
  applyAgentsConfiguration(candidate, path, { modelFallbackLists: {}, maxConcurrent: 4, maxQueued: 16, shutdownTimeoutMs: 5000, maxNestingDepth: 3, ui: defaultAgentUi() });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...root, agents: candidate }, null, 2) + "\n");
}
