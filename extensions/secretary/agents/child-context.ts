import { AsyncLocalStorage } from "node:async_hooks";

export interface ChildSessionContext {
  /** The agent record this child session executes. */
  agentId: string;
  runId?: string;
  /** Levels below the main session; a top-level child is 1. */
  depth: number;
}

// Extension loaders may evaluate this module separately from the SDK caller.
// Share the marker across those module instances, without sharing child state across async chains.
const key = Symbol.for("pi-secretary.child-context");
const shared = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<ChildSessionContext> };
const childContext = shared[key] ??= new AsyncLocalStorage<ChildSessionContext>();

/**
 * Sessions whose delegation tools were registered by this extension (SA-12). The runner
 * consults this marker before admitting Agent/SendMessage/TaskStop/TaskOutput to a child
 * session's model or tool execution, so a foreign extension cannot hijack the tool names
 * even when the session allowlist includes them. Shared by symbol because extension loaders
 * may evaluate this module separately from the SDK caller.
 */
const authKey = Symbol.for("pi-secretary.child-delegation-authorized");
const authShared = globalThis as typeof globalThis & { [authKey]?: Set<string> };
const authorizedSessions = authShared[authKey] ??= new Set<string>();

export function authorizeChildDelegation(sessionId: string): void { authorizedSessions.add(sessionId); }
export function revokeChildDelegation(sessionId: string): void { authorizedSessions.delete(sessionId); }
export function childDelegationAuthorized(sessionId: string): boolean { return authorizedSessions.has(sessionId); }

/** The child session identity when the current async chain executes a delegated agent. */
export function childSession(): ChildSessionContext | undefined {
  return childContext.getStore();
}

export function inChildSession(): boolean {
  return childContext.getStore() !== undefined;
}

export function runInChildSession<T>(context: ChildSessionContext, action: () => T): T {
  return childContext.run(context, action);
}
