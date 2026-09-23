import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WindowRead } from "./backend/backend.ts";
import { renderExecutorTable, type Observation, type ObservationFailure } from "./observer.ts";

/**
 * Step telemetry (design docs/arch/computer-use.md §12.1). Phase 1 writes the retrieval
 * record (§6.4) for every observation: the full parsed tree, the executor table, every
 * discard with its reason, and the group assignment of every kept element.
 */
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
}
