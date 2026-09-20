import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];
type CustomMessage = Extract<AgentMessage, { role: "custom" }>;
import { canonicalJson, immutableSnapshot, type JsonValue } from "./serializer.ts";

export { canonicalJson, type JsonValue } from "./serializer.ts";

export const REQUEST_CONTEXT_CUSTOM_TYPE = "secretary:request-context";
export const REQUEST_CONTEXT_MAX_BYTES = 32 * 1024;
const OWNER = "secretary.request-context";

export interface RequestContext {
  readonly sessionId: string;
  readonly activationEpoch: number;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface ContextContributor<S> {
  readonly id: string;
  readonly order: number;
  capture(context: RequestContext): Promise<S | undefined>;
  project(snapshot: Readonly<S>): JsonValue;
}

export type ContextErrorCode = "capture_failed" | "projection_failed" | "invalid_json" | "overflow"
  | "cancelled" | "invalidated" | "disposed";
export type ContributionOutcome =
  | { readonly id: string; readonly status: "ready" }
  | { readonly id: string; readonly status: "omitted" }
  | { readonly id: string; readonly status: "unavailable"; readonly errorCode: ContextErrorCode };

export interface PreparedContext {
  readonly sessionId: string;
  readonly activationEpoch: number;
  readonly requestId: string;
  readonly content?: string;
  readonly status: "ready" | "unavailable";
  readonly errorCode?: ContextErrorCode;
  readonly contributions: ReadonlyMap<string, ContributionOutcome>;
  getSnapshot<S>(id: string): Readonly<S> | undefined;
}

interface Registration {
  readonly id: string;
  readonly order: number;
  capture(context: RequestContext): Promise<unknown>;
  project(snapshot: unknown): JsonValue;
}
type CaptureResult = { id: string; snapshot?: unknown; errorCode?: ContextErrorCode };

function envelope(value: JsonValue): string {
  return `<secretary-runtime-state>${canonicalJson(value)}</secretary-runtime-state>`;
}

function prepared(context: RequestContext, outcomes: Map<string, ContributionOutcome>, snapshots: Map<string, unknown>,
  content: string | undefined, status: "ready" | "unavailable", errorCode?: ContextErrorCode): PreparedContext {
  for (const outcome of outcomes.values()) Object.freeze(outcome);
  return Object.freeze({
    sessionId: context.sessionId, activationEpoch: context.activationEpoch, requestId: context.requestId,
    content, status, errorCode,
    get contributions(): ReadonlyMap<string, ContributionOutcome> { return new Map(outcomes); },
    getSnapshot<S>(id: string): Readonly<S> | undefined { return snapshots.get(id) as Readonly<S> | undefined; },
  });
}

export function isRequestContextMessage(message: AgentMessage): boolean {
  if (message.role !== "custom" || message.customType !== REQUEST_CONTEXT_CUSTOM_TYPE) return false;
  const details = message.details as { owner?: unknown; version?: unknown } | undefined;
  return details?.owner === OWNER && details.version === 1;
}

export function compose(messages: readonly AgentMessage[], context: PreparedContext): AgentMessage[] {
  const result = messages.filter((message) => !isRequestContextMessage(message));
  if (context.content !== undefined) {
    const message: CustomMessage = {
      role: "custom", customType: REQUEST_CONTEXT_CUSTOM_TYPE, content: context.content,
      display: false, timestamp: 0, details: { owner: OWNER, version: 1 },
    };
    result.push(message);
  }
  return result;
}

export class RequestContextComposer {
  #registrations = new Map<string, Registration>();
  #pending = new Set<AbortController>();
  #activation?: { sessionId: string; activationEpoch: number };
  #disposed = false;

  register<S>(contributor: ContextContributor<S>): () => void {
    if (this.#disposed) throw new Error("disposed");
    if (!/^[A-Za-z0-9_-]+(?:[.:/][A-Za-z0-9_-]+)+$/.test(contributor.id)
      || contributor.id.length > 256 || !Number.isSafeInteger(contributor.order)) throw new Error("invalid_contributor");
    if (this.#registrations.has(contributor.id)) throw new Error("duplicate_contributor");
    const project = contributor.project.bind(contributor);
    const registration: Registration = Object.freeze({
      id: contributor.id, order: contributor.order,
      capture: contributor.capture.bind(contributor),
      project: (snapshot: unknown) => project(snapshot as Readonly<S>),
    });
    this.#registrations.set(registration.id, registration);
    return () => {
      if (this.#registrations.get(registration.id) === registration) this.#registrations.delete(registration.id);
    };
  }

  invalidate(): void {
    for (const controller of this.#pending) controller.abort("invalidated");
    this.#pending.clear();
  }

  dispose(): void {
    this.#disposed = true;
    for (const controller of this.#pending) controller.abort("disposed");
    this.#pending.clear();
    this.#registrations.clear();
    this.#activation = undefined;
  }

  compose(messages: readonly AgentMessage[], context: PreparedContext): AgentMessage[] {
    return compose(messages, context);
  }

  async prepare(input: RequestContext): Promise<PreparedContext> {
    input = Object.freeze({ sessionId: input.sessionId, activationEpoch: input.activationEpoch,
      requestId: input.requestId, signal: input.signal });
    const registrations = [...this.#registrations.values()].sort((a, b) => a.order - b.order
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const outcomes = new Map<string, ContributionOutcome>();
    const snapshots = new Map<string, unknown>();
    const failure = (errorCode: ContextErrorCode): PreparedContext => {
      snapshots.clear();
      outcomes.clear();
      for (const { id } of registrations) outcomes.set(id, { id, status: "unavailable", errorCode });
      return prepared(input, outcomes, snapshots, envelope({ version: 1, status: "unavailable", errorCode }), "unavailable", errorCode);
    };
    if (this.#disposed) return failure("disposed");
    if (input.signal.aborted) return failure("cancelled");
    if (this.#activation && (this.#activation.sessionId !== input.sessionId
      || this.#activation.activationEpoch !== input.activationEpoch)) this.invalidate();
    this.#activation = { sessionId: input.sessionId, activationEpoch: input.activationEpoch };
    const controller = new AbortController();
    const cancel = () => controller.abort("cancelled");
    input.signal.addEventListener("abort", cancel, { once: true });
    this.#pending.add(controller);
    const context = Object.freeze({ sessionId: input.sessionId, activationEpoch: input.activationEpoch,
      requestId: input.requestId, signal: controller.signal });
    let onAbort!: () => void;
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const capture = async (registration: Registration): Promise<CaptureResult> => {
        if (controller.signal.aborted) return { id: registration.id };
        try {
          const value = await registration.capture(context);
          if (controller.signal.aborted) return { id: registration.id };
          return { id: registration.id, snapshot: immutableSnapshot(value) };
        } catch {
          return { id: registration.id, errorCode: "capture_failed" };
        }
      };
      const captures = await Promise.race([Promise.all(registrations.map(capture)), aborted]);
      if (controller.signal.aborted || !captures) return failure(controller.signal.reason as ContextErrorCode);
      const contributions: JsonValue[] = [];
      let status: "ready" | "unavailable" = "ready";
      for (let index = 0; index < registrations.length; index++) {
        if (controller.signal.aborted) return failure(controller.signal.reason as ContextErrorCode);
        const registration = registrations[index];
        const captured = captures[index];
        const { id } = registration;
        let errorCode = captured.errorCode;
        if (!errorCode && captured.snapshot === undefined) {
          outcomes.set(id, { id, status: "omitted" });
          continue;
        }
        if (!errorCode) {
          snapshots.set(id, captured.snapshot);
          let data: JsonValue | undefined;
          try { data = registration.project(captured.snapshot); } catch { errorCode = "projection_failed"; }
          if (!errorCode) {
            try {
              const canonical = canonicalJson(data!);
              contributions.push({ id, status: "ready", data: JSON.parse(canonical) as JsonValue });
              outcomes.set(id, { id, status: "ready" });
              continue;
            } catch { errorCode = "invalid_json"; }
          }
        }
        status = "unavailable";
        outcomes.set(id, { id, status: "unavailable", errorCode: errorCode! });
        contributions.push({ id, status: "unavailable", errorCode: errorCode! });
      }
      if (controller.signal.aborted) return failure(controller.signal.reason as ContextErrorCode);
      let content: string | undefined;
      try { content = contributions.length ? envelope({ version: 1, status, contributions }) : undefined; }
      catch { return failure("invalid_json"); }
      if (content !== undefined && Buffer.byteLength(content, "utf8") > REQUEST_CONTEXT_MAX_BYTES) {
        return prepared(input, outcomes, snapshots, envelope({ version: 1, status: "unavailable", errorCode: "overflow" }), "unavailable", "overflow");
      }
      return prepared(input, outcomes, snapshots, content, status);
    } finally {
      input.signal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
      this.#pending.delete(controller);
    }
  }
}
