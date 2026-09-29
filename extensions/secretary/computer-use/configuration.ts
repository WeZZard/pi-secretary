import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** The `computerUse` object of secretary.json (design docs/arch/computer-use.md §4.5). */
export type InputMode = "ordinary" | "accessibility-test";
/** Permissions design docs/arch/computer-use-permissions.md §2, decision PS-D13. */
export type PermissionMode = "ask" | "auto" | "bypass";

export interface ComputerUseConfiguration {
  backend: "none" | "local" | "relay";
  executorUrl?: string;
  executorTimeoutMs: number;
  confidenceGate: number;
  answerReserveTokens?: number;
  maxElements: number;
  maxTreeNodes: number;
  maxNameLength: number;
  maxActionsPerPlan: number;
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
  /**
   * Design §11.4, decision PS-D8: `ordinary` allows only real pointer and key input, and a driver
   * action performed through accessibility stops the plan; `accessibility-test` allows it.
   */
  inputMode: InputMode;
  /** Permissions design §2: who decides whether an action may be sent. */
  permissionMode: PermissionMode;
  /** Permissions design §4: a guardian answer below this confidence is doubt, which asks. Provisional (PS-D15). */
  permissionGate: number;
  /** Permissions design §5: the guardian's thought budget in tokens; 0 sends no `think`. Provisional (PS-D15). */
  permissionThink: number;
  /** Permissions design §8: how long a person has to answer an approval before the plan stops. Provisional (PS-D15). */
  approvalTimeoutMs: number;
  allowLocalDesktop: boolean;
  localDriverPath: string;
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
export const DEFAULT_RELAY_COMMAND = ["npx", "-y", "--prefer-offline", "@wezzard/mcp-vm-relay@0.6.2"];

export const defaultComputerUseConfiguration = (): ComputerUseConfiguration => ({
  backend: "none",
  executorTimeoutMs: 10_000,
  confidenceGate: 0.4,
  maxElements: 240,
  maxTreeNodes: 2000,
  maxNameLength: 48,
  maxActionsPerPlan: 100,
  maxEscalationsPerRun: 5,
  settleMs: 300,
  redactTypedText: true,
  stepPictures: false,
  foregroundDelivery: true,
  inputMode: "ordinary",
  permissionMode: "auto",
  permissionGate: 0.6,
  permissionThink: 256,
  approvalTimeoutMs: 300_000,
  allowLocalDesktop: false,
  localDriverPath: "cua-driver",
  relayCommand: DEFAULT_RELAY_COMMAND,
  relayTtlHours: 2,
  relayPrepare: [],
  relayCheck: [],
});

type Field = keyof ComputerUseConfiguration;
const integer = (min: number, max = Number.MAX_SAFE_INTEGER) => (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const VALIDATORS: Record<Field, { check: (value: unknown) => boolean; expected: string }> = {
  backend: { check: value => value === "none" || value === "local" || value === "relay", expected: "none, local, or relay" },
  executorUrl: { check: value => typeof value === "string" && /^https?:\/\/[^\s]+$/.test(value), expected: "an http or https URL" },
  executorTimeoutMs: { check: integer(1), expected: "a positive integer" },
  confidenceGate: { check: value => typeof value === "number" && value >= 0 && value <= 1, expected: "a number from 0 to 1" },
  answerReserveTokens: { check: integer(0, 4096), expected: "an integer from 0 to 4096" },
  maxElements: { check: integer(1), expected: "a positive integer" },
  maxTreeNodes: { check: integer(1), expected: "a positive integer" },
  maxNameLength: { check: integer(8, 200), expected: "an integer from 8 to 200" },
  maxActionsPerPlan: { check: integer(1), expected: "a positive integer" },
  maxEscalationsPerRun: { check: integer(0), expected: "a non-negative integer" },
  settleMs: { check: integer(0, 60_000), expected: "an integer from 0 to 60000" },
  redactTypedText: { check: value => typeof value === "boolean", expected: "a boolean" },
  stepPictures: { check: value => typeof value === "boolean", expected: "a boolean" },
  foregroundDelivery: { check: value => typeof value === "boolean", expected: "a boolean" },
  inputMode: { check: value => value === "ordinary" || value === "accessibility-test", expected: "ordinary or accessibility-test" },
  permissionMode: { check: value => value === "ask" || value === "auto" || value === "bypass", expected: "ask, auto, or bypass" },
  permissionGate: { check: value => typeof value === "number" && value >= 0 && value <= 1, expected: "a number from 0 to 1" },
  permissionThink: { check: integer(0, 4096), expected: "an integer from 0 to 4096" },
  approvalTimeoutMs: { check: integer(1), expected: "a positive integer" },
  allowLocalDesktop: { check: value => typeof value === "boolean", expected: "a boolean" },
  localDriverPath: { check: value => typeof value === "string" && value.trim().length > 0, expected: "a non-empty string" },
  relayCommand: { check: value => Array.isArray(value) && value.length > 0 && value.every(part => typeof part === "string" && part.length > 0), expected: "a non-empty array of non-empty strings" },
  relayImage: { check: value => typeof value === "string" && value.trim().length > 0, expected: "a non-empty string" },
  relayEnv: { check: value => typeof value === "string" && value.trim().length > 0, expected: "a non-empty string" },
  relayPrepare: { check: value => Array.isArray(value) && value.every(argv => Array.isArray(argv) && argv.length > 0 && argv.every(part => typeof part === "string" && part.length > 0)),
    expected: "an array of non-empty command arrays" },
  relayCheck: { check: value => Array.isArray(value) && value.every(argv => Array.isArray(argv) && argv.length > 0 && argv.every(part => typeof part === "string" && part.length > 0)),
    expected: "an array of non-empty command arrays" },
  relayTtlHours: { check: value => typeof value === "number" && value >= 0.1 && value <= 720, expected: "a number from 0.1 to 720" },
};

function applyComputerUse(section: unknown, path: string, result: ComputerUseConfiguration): void {
  if (!section || typeof section !== "object" || Array.isArray(section)) throw new Error(`${path}: computerUse must be an object`);
  for (const [key, value] of Object.entries(section)) {
    const validator = VALIDATORS[key as Field];
    if (!validator) throw new Error(`${path}: unsupported computerUse field ${key}`);
    if (!validator.check(value)) throw new Error(`${path}: computerUse.${key} must be ${validator.expected}`);
    (result as unknown as Record<string, unknown>)[key] = value;
  }
}

/**
 * Global configuration first, then trusted project configuration field by field.
 * The subagent module never reads this object (design §4.5).
 */
export function loadComputerUseConfiguration(cwd: string, agentDir: string, trusted: boolean): ComputerUseConfiguration {
  const result = defaultComputerUseConfiguration();
  const paths = [join(agentDir, "secretary.json")];
  if (trusted) paths.push(join(cwd, CONFIG_DIR_NAME, "secretary.json"));
  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const root = JSON.parse(text) as unknown;
    if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error(`${path} must contain an object`);
    if (!Object.hasOwn(root, "computerUse")) continue;
    applyComputerUse((root as Record<string, unknown>).computerUse, path, result);
  }
  if (result.backend === "local" && !result.allowLocalDesktop) {
    throw new Error("computerUse.backend local operates this machine's desktop; set computerUse.allowLocalDesktop to true to enable it for development");
  }
  if (result.backend === "relay" && result.relayImage === undefined) throw new Error("computerUse.backend relay needs computerUse.relayImage, the relay image key");
  return result;
}

/** Observation needs only a backend; plan execution also needs the executor (design §4.3). */
export const observationAvailable = (config: ComputerUseConfiguration): boolean => config.backend !== "none";
export const planExecutionAvailable = (config: ComputerUseConfiguration): boolean => observationAvailable(config) && config.executorUrl !== undefined;
