import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Design docs/arch/vm-use.md §8.1, decision PS-D53: no check, or the online API checks each plan before it runs. */
export type PermissionCheck = "none" | "online";

/** The online plan check's chat completions API (design §8.3, decision PS-D52). */
export interface PermissionOnline {
  url: string;
  model: string;
  /** The environment variable that holds the API key; the key itself is never configured. */
  apiKeyEnv?: string;
  timeoutMs: number;
}

/**
 * The `vmUse` object of secretary.json (design docs/arch/vm-use.md §4.5). The input mode is not
 * configuration: the grounder chooses each action, and with it the input (design §11.4, decisions PS-D32 and PS-D39).
 */
export interface VmUseConfiguration {
  backend: "none" | "relay";
  executorUrl?: string;
  executorTimeoutMs: number;
  confidenceGate: number;
  answerReserveTokens?: number;
  maxElements: number;
  maxTreeNodes: number;
  maxNameLength: number;
  maxEscalationsPerRun: number;
  settleMs: number;
  redactTypedText: boolean;
  /**
   * Fix plan F-4: save a window picture before and after every action. Off by default, because a
   * picture can show typed text that the records otherwise redact.
   */
  stepPictures: boolean;
  /** Fix plan F-3: clicks and modifier shortcuts make the application active for the action. */
  foregroundDelivery: boolean;
  /** Design §8.1: whether each plan is checked before it runs. */
  permissionCheck: PermissionCheck;
  /** Design §8.3: the online plan check; the mode `online` requires it. */
  permissionOnline?: PermissionOnline;
  /** Design §8.4: how long a person has to answer an approval before the plan stops. Provisional, not measured (PS-D53). */
  approvalTimeoutMs: number;
  /** Design §11.2: the command that starts an mcp-vm-relay server over standard input and output. */
  relayCommand: string[];
  /** The relay image key, for example one listed by relay action=probe. Required for the relay client. */
  relayImage?: string;
  /** The relay credential pack, passed as acquire's env. */
  relayEnv?: string;
  relayTtlHours: number;
  /** Commands run in the relay machine once after staging, because the tools do not launch applications. */
  relayPrepare: string[][];
  /**
   * Evaluation design §3: commands run in the relay machine once, after the child run and before
   * the lease is finished, such as a benchmark task's checking script. Their output is recorded.
   */
  relayCheck: string[][];
}

/**
 * The version pi-mcp-adapter runs for the vm-relay server (checked 2026-09-24). `--prefer-offline`
 * starts the cached package without asking the registry: a registry request reset by the network
 * kept npx retrying past the client's 60-second start limit in 3 of 3 starts, and with the flag
 * 3 of 3 starts connected (observed 2026-09-24).
 */
export const DEFAULT_RELAY_COMMAND = ["npx", "-y", "--prefer-offline", "@wezzard/mcp-vm-relay@0.9.0"];

export const defaultVmUseConfiguration = (): VmUseConfiguration => ({
  backend: "none",
  executorTimeoutMs: 10_000,
  confidenceGate: 0.4,
  maxElements: 240,
  maxTreeNodes: 2000,
  maxNameLength: 48,
  maxEscalationsPerRun: 5,
  settleMs: 300,
  redactTypedText: true,
  stepPictures: false,
  foregroundDelivery: true,
  permissionCheck: "none",
  approvalTimeoutMs: 300_000,
  relayCommand: DEFAULT_RELAY_COMMAND,
  relayTtlHours: 2,
  relayPrepare: [],
  relayCheck: [],
});

type Field = keyof VmUseConfiguration;
const integer = (min: number, max = Number.MAX_SAFE_INTEGER) => (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const httpUrl = (value: unknown): boolean => typeof value === "string" && /^https?:\/\/[^\s]+$/.test(value);
const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
const ONLINE_FIELDS: Record<string, (value: unknown) => boolean> = {
  url: httpUrl, model: nonEmpty, apiKeyEnv: value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value), timeoutMs: integer(1),
};
/** `url` and `model` are required, and every field is known and valid. */
const onlineValid = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return "url" in value && "model" in value && entries.every(([key, field]) => ONLINE_FIELDS[key]?.(field) === true);
};

const VALIDATORS: Record<Field, { check: (value: unknown) => boolean; expected: string }> = {
  backend: { check: value => value === "none" || value === "relay", expected: "none or relay" },
  executorUrl: { check: httpUrl, expected: "an http or https URL" },
  executorTimeoutMs: { check: integer(1), expected: "a positive integer" },
  confidenceGate: { check: value => typeof value === "number" && value >= 0 && value <= 1, expected: "a number from 0 to 1" },
  answerReserveTokens: { check: integer(0, 4096), expected: "an integer from 0 to 4096" },
  maxElements: { check: integer(1), expected: "a positive integer" },
  maxTreeNodes: { check: integer(1), expected: "a positive integer" },
  maxNameLength: { check: integer(8, 200), expected: "an integer from 8 to 200" },
  maxEscalationsPerRun: { check: integer(0), expected: "a non-negative integer" },
  settleMs: { check: integer(0, 60_000), expected: "an integer from 0 to 60000" },
  redactTypedText: { check: value => typeof value === "boolean", expected: "a boolean" },
  stepPictures: { check: value => typeof value === "boolean", expected: "a boolean" },
  foregroundDelivery: { check: value => typeof value === "boolean", expected: "a boolean" },
  permissionCheck: { check: value => value === "none" || value === "online", expected: "none or online" },
  permissionOnline: { check: onlineValid, expected: "an object with url (an http or https URL), model, and optionally apiKeyEnv (an environment variable name) and timeoutMs (a positive integer)" },
  approvalTimeoutMs: { check: integer(1), expected: "a positive integer" },
  relayCommand: { check: value => Array.isArray(value) && value.length > 0 && value.every(part => typeof part === "string" && part.length > 0), expected: "a non-empty array of non-empty strings" },
  relayImage: { check: value => typeof value === "string" && value.trim().length > 0, expected: "a non-empty string" },
  relayEnv: { check: value => typeof value === "string" && value.trim().length > 0, expected: "a non-empty string" },
  relayPrepare: { check: value => Array.isArray(value) && value.every(argv => Array.isArray(argv) && argv.length > 0 && argv.every(part => typeof part === "string" && part.length > 0)),
    expected: "an array of non-empty command arrays" },
  relayCheck: { check: value => Array.isArray(value) && value.every(argv => Array.isArray(argv) && argv.length > 0 && argv.every(part => typeof part === "string" && part.length > 0)),
    expected: "an array of non-empty command arrays" },
  relayTtlHours: { check: value => typeof value === "number" && value >= 0.1 && value <= 720, expected: "a number from 0.1 to 720" },
};

function applyVmUse(section: unknown, path: string, result: VmUseConfiguration): void {
  if (!section || typeof section !== "object" || Array.isArray(section)) throw new Error(`${path}: vmUse must be an object`);
  for (const [key, value] of Object.entries(section)) {
    const validator = VALIDATORS[key as Field];
    if (!validator) throw new Error(`${path}: unsupported vmUse field ${key}`);
    if (!validator.check(value)) throw new Error(`${path}: vmUse.${key} must be ${validator.expected}`);
    (result as unknown as Record<string, unknown>)[key] = key === "permissionOnline" ? { timeoutMs: 30_000, ...(value as object) } : value;
  }
}

/**
 * Global configuration first, then trusted project configuration field by field.
 * The subagent module never reads this object (design §4.5).
 */
export function loadVmUseConfiguration(cwd: string, agentDir: string, trusted: boolean): VmUseConfiguration {
  const result = defaultVmUseConfiguration();
  const paths = [join(agentDir, "secretary.json")];
  if (trusted) paths.push(join(cwd, CONFIG_DIR_NAME, "secretary.json"));
  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const root = JSON.parse(text) as unknown;
    if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error(`${path} must contain an object`);
    if (!Object.hasOwn(root, "vmUse")) continue;
    applyVmUse((root as Record<string, unknown>).vmUse, path, result);
  }
  if (result.backend === "relay" && result.relayImage === undefined) throw new Error("vmUse.backend relay needs vmUse.relayImage, the relay image key");
  // Design §8.1: a run never believes it is checked when it is not.
  if (result.permissionCheck === "online" && result.permissionOnline === undefined) throw new Error("vmUse.permissionCheck online needs vmUse.permissionOnline, the online API");
  return result;
}

/** Observation needs only a backend; plan execution also needs the grounder (design §4.3). */
export const observationAvailable = (config: VmUseConfiguration): boolean => config.backend !== "none";
export const planExecutionAvailable = (config: VmUseConfiguration): boolean => observationAvailable(config) && config.executorUrl !== undefined;
