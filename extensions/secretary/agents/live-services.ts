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
