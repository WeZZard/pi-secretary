/** Bounded action history for the executor's `recent` state field (design §7.1). */
export interface ActionRecord { intent: string; action: string; element?: string; outcome: "verified" | "weakly_verified" | "failed" | "skipped" }

export class ActionHistory {
  readonly #limit: number;
  readonly #records: ActionRecord[] = [];
  constructor(limit = 5) { this.#limit = limit; }
  push(record: ActionRecord): void {
    this.#records.push(record);
    while (this.#records.length > this.#limit) this.#records.shift();
  }
  recent(): ActionRecord[] { return [...this.#records]; }
}

export const formatRecord = (record: ActionRecord): string =>
  `${record.intent} -> ${record.action}${record.element ? ` ${JSON.stringify(record.element)}` : ""} (${record.outcome.replace("_", " ")})`;
