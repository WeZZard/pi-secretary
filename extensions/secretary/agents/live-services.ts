import type { AgentService } from "./service.ts";

/**
 * In-process registry of live child-session services (SA-12). Nested agents execute in this
 * process, so the service serving a child session registers itself under the agent record
 * that session executes. Ancestor services aggregate tree rows and route stop/message/cleanup
 * operations for nested agents through the owning service while it is live.
 */
const live = new Map<string, AgentService>();

export function registerLiveChildService(agentId: string, service: AgentService): () => void {
  live.set(agentId, service);
  return () => { if (live.get(agentId) === service) live.delete(agentId); };
}

export function liveChildService(agentId: string): AgentService | undefined {
  return live.get(agentId);
}

/**
 * The live service serving a session, if any. A service that is shutting down no longer owns
 * delivery for its session, so an ended owning session's completions can be promoted (§10.1).
 */
export function liveSessionOwner(sessionId: string): AgentService | undefined {
  for (const service of live.values()) if (!service.shuttingDown() && service.sessionId() === sessionId) return service;
  return undefined;
}
