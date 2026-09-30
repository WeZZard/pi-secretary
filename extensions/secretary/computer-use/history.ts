/** Bounded action history for the grounder's `recent` state field (design §7.1). */
/** What a step did; it carries no judgment of whether the step worked (design §5.3). */
export interface ActionRecord { intent: string; action: string; element?: string }

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
  `${record.intent} -> ${record.action}${record.element ? ` ${JSON.stringify(record.element)}` : ""}`;
