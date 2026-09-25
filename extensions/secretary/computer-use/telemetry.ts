import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Screenshot, WindowRead } from "./backend/backend.ts";
import { renderExecutorTable, type Observation, type ObservationFailure } from "./observer.ts";

/**
 * Step telemetry (design docs/arch/computer-use.md §12.1). Phase 1 writes the retrieval
 * record (§6.4) for every observation: the full parsed tree, the executor table, every
 * discard with its reason, and the group assignment of every kept element.
 */
export interface Picture { file: string; sha256: string }

export class Telemetry {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  async recordObservation(read: WindowRead, result: Observation | ObservationFailure, context: { attempt: number; purpose: string }): Promise<string> {
    const directory = join(this.root, "observations");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${result.id}.json`);
    const record = {
      schema: "secretary.computer-use.observation/1",
      recordedAt: new Date().toISOString(),
      purpose: context.purpose,
      attempt: context.attempt,
      status: result.status,
      ...(result.status !== "ready" ? { detail: result.detail } : {}),
      window: read.window,
      snapshotId: read.snapshotId,
      appActive: read.appActive,
      truncated: read.truncated,
      readMs: read.readMs,
      screenshotCaptured: read.screenshot !== undefined,
      tree: read.elements,
      descendantText: read.descendantText,
      executorTable: result.status === "ready" ? renderExecutorTable(result) : undefined,
      groups: result.status === "ready"
        ? result.groups.map(group => ({ name: group.name, elements: group.elements.map(element => ({ letter: element.letter, index: element.index, name: element.name })) }))
        : [],
      discards: result.discards,
    };
    await writeFile(path, `${JSON.stringify(record, null, 1)}\n`, { mode: 0o600 });
    return path;
  }

  /** One record per executor decision (design §12.1). The request carries no typed literal; step text stays in the plan record. */
  async recordStep(record: { runId: string; stepId: string; attempt: number } & Record<string, unknown>): Promise<string> {
    const directory = join(this.root, "runs", record.runId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `step-${record.stepId.replace(/[^A-Za-z0-9_-]/g, "_")}-${record.attempt}-${Date.now()}.json`);
    await writeFile(path, `${JSON.stringify({ schema: "secretary.computer-use.step/1", recordedAt: new Date().toISOString(), ...record }, null, 1)}\n`, { mode: 0o600 });
    return path;
  }

  /**
   * Fix plan F-4: one window picture, named by step, attempt and phase. The SHA-256 hash in the plan
   * record shows that the file was not changed later.
   */
  async recordPicture(runId: string, name: string, screenshot: Screenshot): Promise<Picture> {
    const directory = join(this.root, "runs", runId, "pictures");
    await mkdir(directory, { recursive: true });
    const bytes = Buffer.from(screenshot.data, "base64");
    const file = `${name.replace(/[^A-Za-z0-9_-]/g, "_")}.png`;
    await writeFile(join(directory, file), bytes, { mode: 0o600 });
    return { file: `pictures/${file}`, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  /** Fix plan F-4: a page that lists each step with its postcondition, result and pictures, for human review. */
  async recordReview(runId: string, lines: string[]): Promise<string> {
    const directory = join(this.root, "runs", runId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "review.md");
    await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    return path;
  }

  /** One summary per plan call. Typed literals are replaced by their length when redaction is on. */
  async recordPlan(record: { runId: string; redact: boolean; plan: { steps: { text?: string }[] } } & Record<string, unknown>): Promise<string> {
    const directory = join(this.root, "runs", record.runId);
    await mkdir(directory, { recursive: true });
    const { redact, plan, ...rest } = record;
    const steps = plan.steps.map(step => step.text !== undefined && redact ? { ...step, text: `<${[...step.text].length} characters>` } : step);
    const path = join(directory, "plan.json");
    await writeFile(path, `${JSON.stringify({ schema: "secretary.computer-use.plan/1", recordedAt: new Date().toISOString(), ...rest, plan: { ...plan, steps } }, null, 1)}\n`, { mode: 0o600 });
    return path;
  }

  /** A `computer_run_plan` call rejected before any read, with the rule that rejected it (design §12.1). */
  async recordRejection(record: { rule: string; message: string; redact: boolean; plan: { steps?: { text?: string }[] } }): Promise<string> {
    const directory = join(this.root, "rejections");
    await mkdir(directory, { recursive: true });
    const { redact, plan, ...rest } = record;
    const steps = plan.steps?.map(step => step.text !== undefined && redact ? { ...step, text: `<${[...step.text].length} characters>` } : step);
    const path = join(directory, `${Date.now()}-${rest.rule.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
    await writeFile(path, `${JSON.stringify({ schema: "secretary.computer-use.rejection/1", recordedAt: new Date().toISOString(), ...rest, plan: { ...plan, ...(steps ? { steps } : {}) } }, null, 1)}\n`, { mode: 0o600 });
    return path;
  }
}
