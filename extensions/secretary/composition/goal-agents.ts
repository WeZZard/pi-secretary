import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalEngine } from "../goal-engine.ts";
import type { GoalSynchronization, WorkBasis } from "../goal/synchronization.ts";
import { goalTokenDeltaForUsage } from "../goal/accounting.ts";
import { withExecutionContext } from "../execution-context.ts";
import { childSession } from "../agents/child-context.ts";
import { TERMINAL_STATUSES, type AgentRun, type UsageRecord } from "../agents/records.ts";
import type { AgentService, ServiceOptions } from "../agents/service.ts";
import { AgentRepository } from "../agents/storage/agent-repository.ts";
import { AgentAssociationStore, type RequestAssociation, type GoalAssociation } from "./association-store.ts";

const CHILD_DENIALS = new Set(["get_goal", "create_goal", "update_goal", "clear_goal"]);
const COMPLETION = "secretary:agent-completion";
interface RequestScope {
  association: RequestAssociation;
  controller: AbortController;
  valid: () => boolean;
  reportingOnly?: boolean;
}
// Child extension loaders can evaluate another module instance. Only composition shares policy.
const key = Symbol.for("pi-secretary.composition-request-scopes");
const shared = globalThis as typeof globalThis & { [key]?: Map<string, RequestScope> };
const liveScopes = shared[key] ??= new Map<string, RequestScope>();

/** Coordinates independent modules; no policy from here is passed as an agent admission callback. */
export function composeGoalAgents(pi: ExtensionAPI, engine: GoalEngine, sync: GoalSynchronization) {
  const repository = new AgentRepository(engine.db.connection);
  const associations = new AgentAssociationStore(engine.db.connection);
  associations.migrateLegacy();
  const child = childSession();
  const ownedScopes = new Set<string>();
  const calls = new Map<string, RequestScope>();
  let pending: RequestScope | undefined;
  let source: { kind: "user" | "automatic" | "notification" | "unknown"; runId?: string } = { kind: "unknown" };
  let ingestingUserPrompt = false;
  let service: (() => AgentService | undefined) | undefined;
  let waitSignature: string | undefined;
  let disposed = false;
  const diagnostics = (error: unknown) => { try { engine.service.onListenerError?.(error); } catch { /* error retained by caller where available */ } };

  function goalValid(goal: GoalAssociation): boolean {
    return engine.service.getGoal(goal.threadId)?.status === "active" && sync.isCurrent(goal);
  }
  function assertScope(scope: RequestScope): void {
    if (!scope.valid()) scope.controller.abort(new Error("This automatic request was superseded; it cannot start further work."));
    scope.controller.signal.throwIfAborted();
  }
  function inherited(): RequestScope | undefined {
    if (!child?.runId) return undefined;
    const parentRun = repository.getRun(child.runId);
    if (parentRun) associate(parentRun);
    const association = associations.run(child.runId);
    if (!association) return undefined;
    const scope = liveScopes.get(association.requestId);
    // Restored provenance is accounting evidence, never renewed automatic authority.
    return scope ?? { association, controller: new AbortController(), valid: () => association.authority === "user" };
  }
  function capture(work: WorkBasis | undefined, notificationRun?: string): RequestScope {
    const ancestor = inherited();
    if (ancestor) return ancestor;
    const notification = notificationRun ? associations.run(notificationRun) : undefined;
    const automatic = source.kind === "automatic" || (source.kind === "unknown" && (!!work?.automatic || !!work?.unresolvedAutomatic));
    const goal = work?.goalId && !work.unresolvedInput && !work.unresolvedAutomatic
      && engine.service.getGoal(work.threadId)?.status === "active"
      ? { threadId: work.threadId, goalId: work.goalId, sessionEpoch: work.sessionEpoch,
          intentSeq: work.intentSeq, controlGeneration: work.controlGeneration } : undefined;
    const association: RequestAssociation = {
      requestId: randomUUID(), authority: notificationRun ? "notification" : automatic ? "automatic" : source.kind === "user" || work?.receipt ? "user" : "unknown",
      ...(notification?.goal ? { goal: notification.goal } : goal ? { goal } : {}),
    };
    const basis = work ? structuredClone(work) : undefined;
    const notificationScope = notification ? liveScopes.get(notification.requestId) : undefined;
    const scope: RequestScope = { association, controller: new AbortController(),
      reportingOnly: automatic && basis?.automatic?.kind === "budget_wrap_up", valid: () => {
      if (disposed) return false;
      if (notificationRun) return !!notificationScope && notificationScope.valid() && !notificationScope.controller.signal.aborted;
      if (!automatic) return true;
      return !!basis && !basis.unresolvedAutomatic && !!basis.automatic && !!basis.goalId
        && engine.service.getGoal(basis.threadId)?.status === (basis.automatic.kind === "budget_wrap_up" ? "budget_limited" : "active")
        && sync.isCurrent(basis);
    } };
    associations.putRequest(association);
    liveScopes.set(association.requestId, scope); ownedScopes.add(association.requestId);
    return scope;
  }
  function invalidate(): void {
    // A nested session can account usage on its own database connection. Evaluate
    // the shared originating scopes too, so exhaustion there cancels the same
    // automatic request tree rather than waiting for the root's next event.
    for (const scope of liveScopes.values()) {
      if (!scope.valid()) scope.controller.abort(new Error("Automatic request authority expired."));
    }
    const controller = service?.();
    if (!controller) return;
    for (const { run } of controller.list()) {
      if (!run || TERMINAL_STATUSES.has(run.status)) continue;
      const association = associations.run(run.runId);
      if (!association || association.authority !== "automatic") continue;
      const scope = liveScopes.get(association.requestId);
      if (!scope || !scope.valid() || scope.controller.signal.aborted) {
        void controller.stop(run.runId, `composition-stop:${run.runId}`).catch(diagnostics);
      }
    }
  }
  const offChanged = engine.service.onGoalChanged(invalidate);
  const offIntent = engine.service.onIntentAccepted(invalidate);

  function associate(run: AgentRun): void {
    if (run.requestId && associations.request(run.requestId)) associations.associateRun(run.runId, run.requestId);
  }
  function account(event: UsageRecord): void {
    const run = repository.getRun(event.runId);
    if (run) associate(run);
    const association = associations.run(event.runId);
    if (association?.goal) engine.service.accountAgentUsage(event.id, association.goal.threadId,
      association.goal.goalId, goalTokenDeltaForUsage(event.usage));
  }
  const events: NonNullable<ServiceOptions["events"]> = event => {
    if (event.type === "admitted") {
      if (!event.run.requestId) {
        // Direct UI operations are explicit assignments, not model-request continuations.
        const association: RequestAssociation = { requestId: `ui:${event.run.runId}`, authority: "user" };
        associations.putRequest(association); associations.associateRun(event.run.runId, association.requestId);
        const scope = { association, controller: new AbortController(), valid: () => !disposed };
        liveScopes.set(association.requestId, scope); ownedScopes.add(association.requestId);
      } else associate(event.run);
    } else account(event.usage);
  };

  // A host adapter wraps operations, not agent policy hooks. The standard cancellation
  // signal remains effective across async admission and is the only execution control passed down.
  const api: ExtensionAPI = {
    ...pi,
    getActiveTools: () => pi.getActiveTools(),
    registerTool(definition) {
      pi.registerTool({ ...definition, async execute(id, params, signal, onUpdate, ctx) {
        const scope = calls.get(id);
        if (!scope) throw new Error("Request correlation is unavailable for this tool operation. Prepare a new request.");
        assertScope(scope);
        const combined = signal ? AbortSignal.any([signal, scope.controller.signal]) : scope.controller.signal;
        return withExecutionContext({ requestId: scope.association.requestId, signal: combined },
          () => definition.execute(id, params, combined, onUpdate, ctx));
      } });
    },
    sendMessage(message, options) {
      if (message.customType !== COMPLETION) { pi.sendMessage(message, options); return; }
      const runId = (message.details as { runId?: string } | undefined)?.runId;
      const run = runId ? repository.getRun(runId) : undefined;
      if (run) associate(run);
      const association = runId ? associations.run(runId) : undefined;
      const scope = association ? liveScopes.get(association.requestId) : undefined;
      // No synthetic user input. Unattributed UI work can still report a result, but cannot wake an old goal.
      const trigger = association ? !!scope && scope.valid() && !scope.controller.signal.aborted
        && (!association.goal || goalValid(association.goal)) : false;
      pi.sendMessage(message, trigger ? options : { deliverAs: "nextTurn" });
    },
  };

  pi.on("before_agent_start", () => { ingestingUserPrompt = true; source = { kind: "user" }; });
  pi.on("message_start", event => {
    const message = event.message;
    if (message.role === "user") source = { kind: "user" };
    // Pi appends deferred nextTurn result data after the fresh user message. Such
    // data must not replace that prompt's authority. Only actual later ingestion
    // (not a scan of saved history) changes the source of an automatic follow-up.
    if (message.role === "custom" && !ingestingUserPrompt) {
      if (message.customType === COMPLETION) source = { kind: "notification", runId: (message.details as { runId?: string } | undefined)?.runId };
      else if (["secretary:goal-automatic", "secretary:goal"].includes(message.customType)) source = { kind: "automatic" };
    }
  });
  pi.on("context", () => {
    pending = undefined;
    const work = sync.work();
    const notificationRun = source.kind === "notification" ? source.runId : undefined;
    pending = capture(work, notificationRun);
    ingestingUserPrompt = false;
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    // Missing correlation never borrows authority from a newer request.
    if (!pending) return;
    for (const block of event.message.content) if (block.type === "toolCall") calls.set(block.id, pending);
  });
  pi.on("tool_call", event => {
    const scope = calls.get(event.toolCallId);
    if (!scope || event.toolName === "get_goal") return;
    if (scope.reportingOnly && !["update_goal", "read", "grep", "find", "ls"].includes(event.toolName)) {
      return { block: true, reason: "Budget wrap-up authorizes reporting and read-only evidence, not new substantive goal work.", terminate: true };
    }
    if (["notification", "unknown"].includes(scope.association.authority) && ["create_goal", "update_goal"].includes(event.toolName)) {
      return { block: true, reason: "Result data or unresolved provenance cannot authorize a goal mutation. Wait for explicit user input.", terminate: true };
    }
    try { assertScope(scope); }
    catch (error) { return { block: true, reason: String(error), terminate: true }; }
  });
  pi.on("turn_start", () => { pending = undefined; });
  pi.on("tool_execution_end", event => { calls.delete(event.toolCallId); });
  pi.on("agent_end", () => { pending = undefined; calls.clear(); ingestingUserPrompt = false; });
  pi.on("input", () => { waitSignature = undefined; });
  pi.on("agent_settled", () => {
    source = { kind: "unknown" }; ingestingUserPrompt = false;
    // A live child keeps its originating scope. Completed requests without live
    // work no longer need controllers or closures; durable associations remain facts.
    const retained = new Set(service?.()?.tree().flatMap(({ run }) => run && !TERMINAL_STATUSES.has(run.status)
      ? [associations.run(run.runId)?.requestId] : []) ?? []);
    for (const id of ownedScopes) if (!retained.has(id)) { liveScopes.delete(id); ownedScopes.delete(id); }
  });
  pi.on("session_tree", () => { pending = undefined; calls.clear(); source = { kind: "unknown" }; ingestingUserPrompt = false; waitSignature = undefined; });

  return {
    api, repository, events,
    childTools: (tools: readonly string[]) => tools.filter(name => !CHILD_DENIALS.has(name)),
    attach(getService: () => AgentService | undefined): void {
      service = getService;
      pi.on("session_start", (_event, ctx) => {
        const parentId = ctx.sessionManager.getSessionId();
        // Reconstruct associations before replaying already-persisted usage. No observer
        // exception can erase costs because both source facts and request mappings are durable.
        const visited = new Set<string>();
        const replay = (owner: string) => {
          if (visited.has(owner)) return;
          visited.add(owner);
          for (const run of repository.runs(owner)) {
            associate(run);
            for (const usage of repository.usage(run.runId)) account(usage);
          }
          for (const agent of repository.agents(owner)) {
            for (const descendant of repository.childrenOf(agent.agentId)) replay(descendant.parentId);
          }
        };
        replay(parentId);
        invalidate();
      });
      sync.canContinueWithChildren = () => {
        const active = service?.()?.list().filter(s => s.run && !TERMINAL_STATUSES.has(s.run.status)
          && associations.run(s.run.runId)?.goal) ?? [];
        if (!active.length) { waitSignature = undefined; return true; }
        const signature = active.map(s => `${s.run!.runId}:${s.run!.status}`).join("|");
        if (waitSignature === signature) return false;
        waitSignature = signature; return true;
      };
    },
    dispose(): void {
      disposed = true; offChanged(); offIntent(); calls.clear(); pending = undefined;
      sync.canContinueWithChildren = undefined;
      for (const id of ownedScopes) { liveScopes.get(id)?.controller.abort(); liveScopes.delete(id); }
      ownedScopes.clear();
    },
  };
}
