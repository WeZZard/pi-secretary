import { AsyncLocalStorage } from "node:async_hooks";

/** Host-supplied correlation and cancellation for an operation, independent of domain policy. */
export interface ExecutionContext {
  requestId: string;
  signal?: AbortSignal;
}
const key = Symbol.for("pi-secretary.execution-context");
const shared = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<ExecutionContext> };
const contexts = shared[key] ??= new AsyncLocalStorage<ExecutionContext>();
export function executionContext(): ExecutionContext | undefined { return contexts.getStore(); }
export function withExecutionContext<T>(context: ExecutionContext, action: () => T): T {
  return contexts.run(context, action);
}
