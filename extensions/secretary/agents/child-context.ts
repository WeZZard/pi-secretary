import { AsyncLocalStorage } from "node:async_hooks";

// Extension loaders may evaluate this module separately from the SDK caller.
// Share the marker across those module instances, without sharing child state across async chains.
const key = Symbol.for("pi-secretary.child-context");
const shared = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<boolean> };
const childContext = shared[key] ??= new AsyncLocalStorage<boolean>();

export function inChildSession(): boolean {
  return childContext.getStore() === true;
}

export function runInChildSession<T>(action: () => T): T {
  return childContext.run(true, action);
}
