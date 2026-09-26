import { BackendError, type ActionOutcome, type BackendAction, type ExecutionBackend, type ReadOptions, type WindowRead, type WindowRef, type WindowTarget } from "./backend.ts";

/**
 * Deterministic test desktop (design §4.2). Each application key yields its scripted reads
 * in order, and the last read repeats. An Error entry is thrown instead of returned.
 */
export class FakeBackend implements ExecutionBackend {
  readonly kind = "fake" as const;
  readonly reads: WindowTarget[] = [];
  /** When set, reads and actions report relay-style evidence identifiers and input paths, as the relay client does. */
  reportEvidence = false;
  /** The input path an action reports when `reportEvidence` is set; tests set `ax` to see the input-mode check. */
  pointerPath = "cgevent_hid";
  #evidence = 0;
  readonly actions: { window: WindowRef; action: BackendAction }[] = [];
  /** Scripted failures for the next actions, consumed in order. */
  readonly actionFailures: Error[] = [];
  closed = false;
  readonly #script: Map<string, (Omit<WindowRead, "readMs"> | Error)[]>;
  constructor(script: Record<string, (Omit<WindowRead, "readMs"> | Error)[]>) {
    this.#script = new Map(Object.entries(script).map(([app, reads]) => [app.toLowerCase(), [...reads]]));
  }

  async readWindow(target: WindowTarget, options: ReadOptions): Promise<WindowRead> {
    if (options.signal?.aborted) throw new BackendError("aborted", "read was cancelled");
    this.reads.push(target);
    const queue = this.#script.get(target.app.toLowerCase());
    if (!queue || queue.length === 0) throw new BackendError("app_not_running", `No window of ${target.app} is open. This tool does not launch applications.`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    const { screenshot, ...rest } = structuredClone(next);
    return { ...rest, ...(options.screenshot && screenshot ? { screenshot } : {}), readMs: 0, ...this.#reported() };
  }

  async act(window: WindowRef, action: BackendAction, signal?: AbortSignal): Promise<ActionOutcome> {
    if (signal?.aborted) throw new BackendError("aborted", "action was cancelled");
    const failure = this.actionFailures.shift();
    if (failure) throw failure;
    this.actions.push({ window, action });
    const path = this.reportEvidence ? { path: action.kind === "key" ? "key_events" : this.pointerPath } : {};
    return action.kind === "key" ? { kind: "unverifiable", ...path, ...this.#reported() } : { kind: "completed", ...path, ...this.#reported() };
  }

  #reported(): { evidence?: string[] } {
    return this.reportEvidence ? { evidence: [`cu-${String(++this.#evidence).padStart(4, "0")}`] } : {};
  }

  async close(): Promise<void> { this.closed = true; }
}
