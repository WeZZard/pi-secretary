import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, fstatSync, readSync, existsSync, constants } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfiguration } from "./configuration.ts";
import { AgentRepository } from "./storage/agent-repository.ts";
import { WorkspaceManager } from "./workspaces.ts";
import { resolveIsolation } from "./configuration.ts";
import { createChildRunner } from "./runner.ts";
import { guidanceNotice, parseTranscriptEvents, type TranscriptEvent } from "./ui/transcript-events.ts";
import { TERMINAL_STATUSES, type AgentDefinition, type AgentRecord, type AgentRowView, type AgentRun, type AgentSnapshot, type ModelResolutionRecord, type RunningChild, type RunnerHooks, type UsageRecord } from "./records.ts";
import { deriveUsageLabels } from "./ui/usage-labels.ts";
import { liveChildService, liveSessionOwner } from "./live-services.ts";

export interface LaunchSpec {
  launchKey: string;
  parentEntryId?: string;
  definition: AgentDefinition;
  model: string;
  /** Ordered fallback candidates remaining after `model` (architecture §5.3). */
  modelCandidates?: string[];
  /** How `model` was chosen (architecture §5.3); recorded so every result surface can state the source. */
  modelResolution?: ModelResolutionRecord;
  thinkingLevel?: string;
  tools: string[];
  prompt: string;
  description: string;
  name?: string;
  /** The delegating agent when a nested child session launches this agent (SA-12). */
  parentAgentId?: string;
  background: boolean;
  isolation?: "none" | "worktree";
  requestId?: string;
  signal?: AbortSignal;
  /** Recheck caller cancellation and live authority across asynchronous admission boundaries. */
  assertAdmission?: () => void;
}
export interface MessageOptions {
  parentEntryId?: string;
  requestId?: string;
  signal?: AbortSignal;
}
export type ServiceEvent = { type: "admitted"; run: AgentRun } | { type: "usage"; usage: UsageRecord };
export interface ServiceOptions {
  parentId: string;
  root: string;
  ctx: ExtensionContext;
  config: AgentConfiguration;
  repository: AgentRepository;
  runner?: typeof createChildRunner;
  events?: (event: ServiceEvent) => void;
  completion?: (run: AgentRun) => void;
  currentTools?: () => readonly string[];
  validateResume?: (agent: AgentRecord) => Promise<void>;
  /** Nesting depth of the session this service serves; the main session is 0. */
  depth?: number;
  /** Records an availability failure for a model candidate in the per-session cache. */
  availability?: (id: string, resetAt?: number) => void;
  diagnostic?: (error: unknown) => void;
  branchDisposition?: (run: AgentRun) => "visible" | "outside" | "unknown";
  admissionEntry?: () => string | undefined;
}
interface Active { controller: AbortController; child?: RunningChild; done: Promise<void> }
const rejected = (message: string): Error & { definitive: true } => Object.assign(new Error(message), { definitive: true as const });

/** Owns state transitions; a UI or tool result never determines execution state. */
export class AgentService {
  private readonly repo: AgentRepository;
  private readonly worktrees: WorkspaceManager;
  // In-memory display projection (subagent architecture §6.2): the service is
  // the single writer for its parent's tables, so a projection loaded at
  // recovery and updated write-through in the same commit as every mutation
  // cannot go stale from another session. Display reads (list, viewModels)
  // serve this projection and never touch storage, keeping a paint or poll
  // tick non-blocking and total (§12.6.3, goal architecture §5.1.1).
  private projectionAgents: AgentRecord[] = [];
  private readonly projectionRuns = new Map<string, AgentRun[]>();
  private readonly projectionUsage = new Map<string, UsageRecord[]>();
  private readonly active = new Map<string, Active>();
  private readonly abortListeners = new Map<string, Set<() => void>>();
  private readonly cleanups = new Set<Promise<unknown>>();
  private readonly messages = new Map<string, Promise<AgentRun>>();
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private drainScheduled = false;
  private revision = 0;
  private readonly options: ServiceOptions;
  constructor(options: ServiceOptions) {
    this.options = options;
    this.repo = options.repository;
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.worktrees = new WorkspaceManager(options.root);
  }
  /** Call only after acquiring exclusive parent ownership. */
  async recover(): Promise<void> {
    this.loadProjection();
    for (const run of this.repo.runs(this.options.parentId)) {
      if (!TERMINAL_STATUSES.has(run.status)) {
        run.status = "interrupted"; run.error = "The previous session ended before settlement was recorded.";
        run.endedAt = Date.now(); this.saveRun(run); this.settleGuidance(run.runId); this.ensureCompletion(run);
      }
    }
    // A nested child never outlives its parent's session (SA-12): once this session is
    // recovering, the sessions that owned descendant runs are gone, so interrupt them here.
    for (const agent of this.treeAgents()) {
      if (agent.parentId === this.options.parentId) continue;
      for (const run of this.repo.runs(agent.parentId).filter(r => r.agentId === agent.agentId && !TERMINAL_STATUSES.has(r.status))) {
        run.status = "interrupted"; run.error = "The previous session ended before settlement was recorded.";
        run.endedAt = Date.now(); run.revision++;
        this.repo.putRun(run); this.settleGuidance(run.runId); this.ensureCompletion(run);
      }
    }
    for (const agent of this.repo.agents(this.options.parentId)) {
      if (agent.worktree?.state !== "cleaning") continue;
      if (!existsSync(agent.worktree.path)) {
        agent.worktree.state = "removed"; agent.resumable = false;
      } else {
        try { await this.worktrees.verify(agent.worktree); agent.worktree.state = "allocated"; }
        catch { agent.worktree.state = "uncertain"; }
      }
      this.repo.putAgent(agent);
      this.projectAgent(agent);
    }
    for (const delivery of this.repo.completions(this.options.parentId)) {
      if (delivery.state === "submitted") this.repo.putCompletion({ ...delivery, state: "uncertain", trigger: false });
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) { try { listener(); } catch (e) { this.options.diagnostic?.(e); } }
  }
  version(): number { return this.revision; }
  /** The host session this service owns; used to decide completion promotion (§10.1). */
  sessionId(): string { return this.options.parentId; }
  /** A service that is shutting down no longer owns delivery of its session's completions. */
  shuttingDown(): boolean { return this.closed; }
  /** Projection load and write-through updates; the only projection paths that touch storage. */
  private loadProjection(): void {
    this.projectionAgents = this.repo.agents(this.options.parentId);
    this.projectionRuns.clear();
    for (const run of this.repo.runs(this.options.parentId)) {
      const runs = this.projectionRuns.get(run.agentId) ?? [];
      runs.push(run);
      this.projectionRuns.set(run.agentId, runs);
    }
    this.projectionUsage.clear();
    for (const runs of this.projectionRuns.values()) {
      for (const run of runs) this.projectionUsage.set(run.runId, this.repo.usage(run.runId));
    }
  }
  private projectAgent(record: AgentRecord): void {
    if (record.parentId !== this.options.parentId) return;
    const index = this.projectionAgents.findIndex(a => a.agentId === record.agentId);
    if (index >= 0) this.projectionAgents[index] = record;
    else this.projectionAgents.push(record);
  }
  private projectRun(record: AgentRun): void {
    if (record.parentId !== this.options.parentId) return;
    const runs = this.projectionRuns.get(record.agentId) ?? [];
    const index = runs.findIndex(r => r.runId === record.runId);
    if (index >= 0) runs[index] = record;
    else runs.push(record);
    this.projectionRuns.set(record.agentId, runs);
  }
  private projectUsage(record: UsageRecord): void {
    const events = this.projectionUsage.get(record.runId) ?? [];
    if (!events.some(e => e.id === record.id)) events.push(record);
    this.projectionUsage.set(record.runId, events);
  }
  isVisible(run: AgentRun): boolean { return !this.options.branchDisposition || this.options.branchDisposition(run) === "visible"; }
  list(): AgentSnapshot[] {
    return this.projectionAgents.flatMap(agent => {
      const runs = this.projectionRuns.get(agent.agentId) ?? [];
      const run = runs.filter(run => this.isVisible(run)).at(-1);
      return run || !this.options.branchDisposition ? [{ agent, run }] : [];
    });
  }
  /** Navigation cancels only proven abandoned admissions, never unknown legacy work. */
  async reconcileBranch(): Promise<void> {
    for (const run of this.repo.runs(this.options.parentId)) {
      if (!TERMINAL_STATUSES.has(run.status) && this.options.branchDisposition?.(run) === "outside") {
        await this.stop(run.runId, `rewind:${run.runId}`);
      }
    }
    this.changed();
  }
  /** Immutable widget rows; consumers render them without deriving state or usage. */
  viewModels(): AgentRowView[] {
    return this.list().map(({ agent, run }) => this.rowFor(agent, run, run ? this.projectionUsage.get(run.runId) ?? [] : []));
  }
  private rowFor(agent: AgentRecord, run: AgentRun | undefined, usage: UsageRecord[]): AgentRowView {
    const labels = run ? deriveUsageLabels(usage) : {};
    return { agentId: agent.agentId, name: agent.name, status: run?.status ?? "idle",
      description: run?.description ?? agent.definition.description, model: agent.model,
      ...(agent.parentAgentId !== undefined ? { parentAgentId: agent.parentAgentId } : {}),
      ...(run?.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run?.activity !== undefined ? { activity: run.activity } : {}),
      background: run?.background ?? false, ...labels };
  }
  /**
   * Snapshots for the whole delegation tree (SA-12): own agents first, then descendants
   * grouped under each delegating agent. Live descendant rows come from the owning child
   * session's service; rows whose owner session has ended come from storage and are static.
   */
  tree(): AgentSnapshot[] {
    const own = this.list();
    const result = [...own];
    const visited = new Set(own.map(s => s.agent.agentId));
    const visit = (agentId: string) => {
      for (const child of this.childrenOf(agentId)) {
        if (visited.has(child.agent.agentId)) continue;
        visited.add(child.agent.agentId); result.push(child); visit(child.agent.agentId);
      }
    };
    for (const snapshot of own) if (!this.savedConversationAdvanced(snapshot.agent.agentId)) visit(snapshot.agent.agentId);
    return result;
  }
  /** Tree view of viewModels(); the fleet view overlay drills into these rows. */
  treeViewModels(): AgentRowView[] {
    const own = this.viewModels();
    const result = [...own];
    const visited = new Set(own.map(r => r.agentId));
    const visit = (agentId: string) => {
      const live = liveChildService(agentId);
      const children = live ? live.viewModels()
        : this.repo.childrenOf(agentId).map(agent => {
            const run = this.repo.runs(agent.parentId).filter(r => r.agentId === agent.agentId).at(-1);
            return this.rowFor(agent, run, run ? this.repo.usage(run.runId) : []);
          });
      for (const row of children) {
        if (visited.has(row.agentId)) continue;
        visited.add(row.agentId); result.push(row); visit(row.agentId);
      }
    };
    for (const row of own) if (!this.savedConversationAdvanced(row.agentId)) visit(row.agentId);
    return result;
  }
  private savedConversationAdvanced(agentId: string): boolean {
    const runs = this.projectionRuns.get(agentId) ?? [];
    const selected = runs.filter(run => this.isVisible(run)).at(-1);
    return !!selected && selected.runId !== runs.at(-1)?.runId;
  }
  private childrenOf(agentId: string): AgentSnapshot[] {
    const live = liveChildService(agentId);
    if (live) return live.list();
    return this.repo.childrenOf(agentId).map(agent => ({ agent,
      run: this.repo.runs(agent.parentId).filter(r => r.agentId === agent.agentId).at(-1) }));
  }
  /** Every agent in the delegation tree from storage; complete because launches commit synchronously. */
  private treeAgents(): AgentRecord[] {
    const own = this.repo.agents(this.options.parentId);
    const result = [...own];
    const visited = new Set(own.map(a => a.agentId));
    const visit = (agentId: string) => {
      for (const child of this.repo.childrenOf(agentId)) {
        if (visited.has(child.agentId)) continue;
        visited.add(child.agentId); result.push(child); visit(child.agentId);
      }
    };
    for (const agent of own) visit(agent.agentId);
    return result;
  }
  resolve(ref: string): AgentRecord {
    const own = this.repo.getAgent(ref);
    if (own?.parentId === this.options.parentId) return own;
    const named = this.tree().find(s => s.agent.name === ref)?.agent;
    if (named) return named;
    const descendant = this.treeAgents().find(a => a.parentId !== this.options.parentId && a.agentId === ref);
    if (descendant) return descendant;
    throw rejected(`Agent not found in this parent session: ${ref}`);
  }
  run(ref: string): AgentRun {
    const direct = this.repo.getRun(ref);
    if (direct && (direct.parentId === this.options.parentId || this.treeAgents().some(a => a.agentId === direct!.agentId))) return direct;
    const agent = this.resolve(ref);
    const run = this.repo.runs(agent.parentId).filter(r => r.agentId === agent.agentId).at(-1);
    if (!run) throw new Error("Agent has no execution record.");
    return run;
  }
  /** Name/agent inspection follows branch visibility; exact run IDs retain historical access. */
  inspectRun(ref: string): AgentRun {
    const selected = this.tree().find(s => s.agent.agentId === ref || s.agent.name === ref)?.run;
    return selected ?? this.run(ref);
  }
  /** The live service of the delegating agent's session, when a nested agent's owner is running. */
  private liveOwner(agent: AgentRecord): AgentService | undefined {
    if (agent.parentId === this.options.parentId || !agent.parentAgentId) return undefined;
    return liveChildService(agent.parentAgentId);
  }
  private notify(event: ServiceEvent): void {
    try { this.options.events?.(event); } catch (error) { this.diagnose(error); }
  }
  private diagnose(error: unknown): void {
    try { this.options.diagnostic?.(error); } catch { /* Diagnostics cannot affect execution. */ }
  }
  private releaseAbortListeners(runId: string): void {
    for (const remove of this.abortListeners.get(runId) ?? []) remove();
    this.abortListeners.delete(runId);
  }
  private bindAbort(run: AgentRun, signal?: AbortSignal): void {
    // A background run outlives the request that admitted it: interrupting the parent turn must not
    // cancel the fleet. Only an explicit stop (X / Ctrl+X) cancels a background run, while a
    // foreground call stays bound to its own signal so interrupting that call still stops it (§2.1).
    if (!signal || run.background || TERMINAL_STATUSES.has(this.run(run.runId).status)) return;
    const abort = () => { void this.stop(run.runId, `signal:${randomUUID()}`).catch(error => this.diagnose(error)); };
    const listeners = this.abortListeners.get(run.runId) ?? new Set<() => void>();
    listeners.add(() => signal.removeEventListener("abort", abort));
    this.abortListeners.set(run.runId, listeners);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
  private saveRun(run: AgentRun): void { run.revision++; this.repo.putRun(run); this.projectRun(run); if (TERMINAL_STATUSES.has(run.status)) this.releaseAbortListeners(run.runId); this.changed(); }
  /** A run's settlement and its pending completion record are committed together (architecture Section 10.1). */
  private ensureCompletion(run: AgentRun): void {
    if (this.repo.completions(run.parentId).some(c => c.runId === run.runId)) return;
    this.repo.putCompletion({ id: `completion:${run.runId}`, runId: run.runId, parentId: run.parentId, state: "pending", trigger: run.background });
  }
  private capacity(): void {
    if (this.closed) throw rejected("This agent controller is shutting down.");
    const pending = this.repo.runs(this.options.parentId).filter(r => !TERMINAL_STATUSES.has(r.status)).length;
    if (pending >= this.options.config.maxConcurrent + this.options.config.maxQueued) throw rejected("Agent execution capacity and pending queue are full.");
  }
  async launch(spec: LaunchSpec): Promise<AgentSnapshot> {
    spec.signal?.throwIfAborted();
    const existing = this.repo.findLaunch(this.options.parentId, spec.launchKey);
    if (existing) return { agent: this.resolve(existing.agentId), run: existing };
    spec.assertAdmission?.();
    const depth = this.options.depth ?? 0;
    if (depth >= this.options.config.maxNestingDepth) {
      throw rejected(`Nested delegation is limited to ${this.options.config.maxNestingDepth} level(s) below the main session; this session is at the maximum depth and cannot launch agents.`);
    }
    this.capacity();
    if (!spec.prompt.trim() || !spec.description.trim()) throw new Error("Agent prompt and description must be nonempty.");
    if (spec.name && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(spec.name) || /^(main|team-lead)$/i.test(spec.name) || /^(agent|run)_/.test(spec.name))) throw new Error("Invalid or reserved agent name.");
    const isolation = resolveIsolation(spec.isolation, spec.definition.isolation);
    const requestedWorktree = isolation === "worktree" ? await this.worktrees.captureBase(this.options.ctx.cwd) : undefined;
    spec.assertAdmission?.();
    this.capacity();
    spec.signal?.throwIfAborted();
    const duplicate = this.repo.findLaunch(this.options.parentId, spec.launchKey);
    if (duplicate) return { agent: this.resolve(duplicate.agentId), run: duplicate };
    const agentId = `agent_${randomUUID()}`;
    const agent: AgentRecord = {
      agentId, parentId: this.options.parentId, name: spec.name, definition: spec.definition,
      ...(spec.parentEntryId ? { nameScope: spec.parentEntryId } : {}),
      ...(spec.parentAgentId !== undefined ? { parentAgentId: spec.parentAgentId } : {}),
      depth: depth + 1,
      model: spec.model, ...(spec.modelCandidates?.length ? { modelCandidates: spec.modelCandidates } : {}),
      ...(spec.modelResolution ? { modelResolution: spec.modelResolution } : {}), thinkingLevel: spec.thinkingLevel, tools: spec.tools,
      cwd: this.options.ctx.cwd, configCwd: this.options.ctx.cwd,
      resumable: spec.definition.resumable, requestedWorktree, createdAt: Date.now(),
    };
    const run = this.newRun(agent, spec.prompt, spec.description, spec.background, spec.launchKey, spec.requestId, spec.parentEntryId);
    this.repo.transaction(() => {
      if (spec.name && this.list().some(s => s.agent.name === spec.name)) throw new Error(`Agent name already exists: ${spec.name}`);
      this.repo.putAgent(agent); this.repo.putRun(run);
    });
    this.projectAgent(agent); this.projectRun(run);
    this.bindAbort(run, spec.signal);
    this.notify({ type: "admitted", run: structuredClone(run) });
    this.changed(); this.drain();
    return { agent, run };
  }
  private newRun(agent: AgentRecord, prompt: string, description: string, background: boolean, launchKey: string, requestId?: string, parentEntryId?: string): AgentRun {
    const runId = `run_${randomUUID()}`;
    const dir = join(this.options.root, "runs", runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outputPath = join(dir, "output.txt");
    writeFileSync(outputPath, "", { mode: 0o600 });
    return { runId, agentId: agent.agentId, parentId: agent.parentId, launchKey, prompt, description,
      ...(parentEntryId ? { parentEntryId } : {}),
      status: "queued", background, createdAt: Date.now(), outputPath, output: "", ...(requestId !== undefined ? { requestId } : {}),
      toolCount: 0, turnCount: 0, revision: 0 };
  }
  private drain(): void {
    if (this.drainScheduled || this.closed) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (this.closed) return;
      for (const run of this.repo.runs(this.options.parentId).filter(r => r.status === "queued")) {
        if (this.active.size >= this.options.config.maxConcurrent) break;
        const controller = new AbortController();
        // Reserve before any awaited startup. A concurrent drain cannot start it twice.
        const entry: Active = { controller, done: Promise.resolve() };
        this.active.set(run.runId, entry);
        entry.done = this.execute(run.runId, entry).catch(e => this.options.diagnostic?.(e)).finally(() => {
          this.active.delete(run.runId); this.changed(); this.drain();
        });
      }
    });
  }
  private async execute(runId: string, entry: Active): Promise<void> {
    let run = this.run(runId);
    let output = "";
    try {
      if (entry.controller.signal.aborted) throw new Error("Execution cancelled before startup.");
      run.status = "starting"; run.startedAt = Date.now(); this.saveRun(run);
      let agent = this.resolve(run.agentId);
      const currentTools = this.options.currentTools?.();
      if (currentTools) agent = { ...agent, tools: agent.tools.filter(name => currentTools.includes(name)) };
      if (!agent.tools.length) throw new Error("The saved agent no longer has tools permitted by its parent.");
      if (agent.requestedWorktree && !agent.worktree) {
        const base = agent.requestedWorktree;
        agent.worktree = await this.worktrees.create(agent.agentId, base, entry.controller.signal);
        agent.cwd = join(agent.worktree.path, base.relativeCwd ?? ""); this.repo.putAgent(agent); this.projectAgent(agent);
      }
      if (agent.worktree) {
        if (agent.worktree.state !== "allocated") throw new Error("Worktree is unavailable or reserved for cleanup.");
        await this.worktrees.verify(agent.worktree);
      }
      if (entry.controller.signal.aborted) throw new Error("Execution cancelled during startup.");
      const update = (fn: (r: AgentRun) => void) => {
        const current = this.run(runId); if (TERMINAL_STATUSES.has(current.status)) return;
        fn(current); this.saveRun(current);
      };
      const hooks: RunnerHooks = {
        allowedTools: this.options.currentTools,
        session: path => { const a = this.resolve(agent.agentId); a.sessionPath = path; this.repo.putAgent(a); this.projectAgent(a); },
        text: text => { output += text; appendFileSync(run.outputPath, text); update(r => { r.output = output.slice(-50000); }); },
        activity: name => update(r => { r.activity = name; r.toolCount++; }),
        turn: () => update(r => { r.turnCount++; }),
        usage: (id, usage) => {
          const record: UsageRecord = { id: `${runId}:${id}`, runId, usage };
          if (this.repo.recordUsage(record)) {
            this.projectUsage(record);
            this.notify({ type: "usage", usage: structuredClone(record) });
          }
        },
        assertRunning: () => {
          if (entry.controller.signal.aborted || this.closed) throw new Error("Child execution is stopping.");
        },
        availability: (id, resetAt) => { this.options.availability?.(id, resetAt); },
        model: id => {
          const a = this.resolve(agent.agentId);
          if (a.model === id) return;
          a.model = id; a.modelCandidates = [];
          if (a.modelResolution) {
            const selected = a.modelResolution.chain.indexOf(id);
            if (selected >= 0) a.modelResolution = { ...a.modelResolution, selected };
          }
          this.repo.putAgent(a); this.projectAgent(a);
        },
      };
      entry.child = await (this.options.runner ?? createChildRunner)({ agent, run, ctx: this.options.ctx,
        signal: entry.controller.signal, hooks, sessionDir: join(this.options.root, "sessions", agent.agentId),
        allowDelegation: (agent.depth ?? 1) < this.options.config.maxNestingDepth });
      if (entry.controller.signal.aborted) void entry.child.abort().catch(e => this.options.diagnostic?.(e));
      update(r => { if (r.status !== "cancelling") r.status = "running"; });
      this.flushGuidance(runId);
      const result = await entry.child.result;
      if (!output) output = result.output;
      else if (result.output && !output.endsWith(result.output)) output += `\n${result.output}`;
      run = this.run(runId);
      run.status = result.status; run.error = result.error;
      if (entry.controller.signal.aborted && result.status !== "succeeded") run.status = "cancelled";
    } catch (error) {
      run = this.run(runId);
      run.status = entry.controller.signal.aborted ? "cancelled" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
    } finally {
      try { await entry.child?.dispose(); } catch (e) { this.options.diagnostic?.(e); }
      run = { ...this.run(runId), status: run.status, error: run.error, output: output.slice(-50000), endedAt: Date.now() };
      try { writeFileSync(run.outputPath, output, { mode: 0o600 }); } catch (e) { run.error = `${run.error ?? ""} Output persistence failed: ${String(e)}`; run.status = "failed"; }
      this.repo.transaction(() => {
        this.repo.putRun({ ...run, revision: run.revision + 1 });
        this.settleGuidance(runId, run.error);
        this.repo.putCompletion({ id: `completion:${runId}`, runId, parentId: run.parentId, state: "pending", trigger: run.background });
        this.projectRun(run);
      });
      this.releaseAbortListeners(runId);
      this.changed();
      try { this.options.completion?.(run); } catch (e) { this.options.diagnostic?.(e); }
    }
  }
  private settleGuidance(runId: string, reason?: string): void {
    for (const g of this.repo.guidance(runId)) {
      if (g.state === "pending" || g.state === "transport-accepted") this.repo.putGuidance({ ...g,
        state: g.state === "pending" ? "undelivered" : "uncertain", reason: reason ?? "Execution settled before correlated consumption was established." });
    }
  }
  private flushGuidance(runId: string): void {
    const child = this.active.get(runId)?.child; if (!child) return;
    for (const g of this.repo.guidance(runId).filter(g => g.state === "pending")) {
      this.repo.putGuidance({ ...g, state: "transport-accepted" });
      void child.steer(g.text).catch(error => {
        this.repo.putGuidance({ ...g, state: "uncertain", reason: String(error) }); this.changed();
      });
    }
  }
  message(ref: string, text: string, operationId: string, options: MessageOptions = {}): Promise<AgentRun> {
    return this.routeMessage(ref, text, operationId, options);
  }
  private routeMessage(ref: string, text: string, operationId: string, options: MessageOptions, assertCaller?: () => void): Promise<AgentRun> {
    let agent: AgentRecord;
    try { options.signal?.throwIfAborted(); agent = this.resolve(ref); } catch (error) { return Promise.reject(error); }
    const owner = this.liveOwner(agent);
    const parentEntryId = options.parentEntryId ?? this.options.admissionEntry?.();
    const assertAdmission = () => {
      assertCaller?.();
      options.signal?.throwIfAborted();
      if (this.closed) throw rejected("Agent controller is shutting down.");
      if (!owner) return;
      let ancestor: AgentRecord | undefined = agent;
      const visited = new Set<string>();
      while (ancestor && ancestor.parentId !== this.options.parentId && !visited.has(ancestor.agentId)) {
        visited.add(ancestor.agentId);
        ancestor = ancestor.parentAgentId ? this.repo.getAgent(ancestor.parentAgentId) : undefined;
      }
      if (!ancestor || ancestor.parentId !== this.options.parentId) throw rejected("The nested agent has no ancestor in this parent session.");
      const previous = this.run(ancestor.agentId);
      if (!this.isVisible(previous) || (parentEntryId && !this.isVisible({ ...previous, parentEntryId }))) {
        throw rejected("The delegating agent or this operation belongs to another branch. Return to that branch or launch a fresh agent.");
      }
    };
    // Session entry IDs are local: retain caller checks, but capture the owner's own admission entry.
    if (owner) {
      try { assertAdmission(); } catch (error) { return Promise.reject(error); }
      return owner.routeMessage(agent.agentId, text, operationId, { ...options, parentEntryId: undefined }, assertAdmission);
    }
    if (agent.parentId !== this.options.parentId && this.repo.activeRun(agent.agentId)) {
      return Promise.reject(rejected("The owning child session is unavailable; wait for the run to settle or stop its delegating agent."));
    }
    const id = agent.agentId;
    const prior = this.messages.get(id) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(() => this.acceptMessage(id, text, operationId, { ...options, parentEntryId }, assertAdmission));
    this.messages.set(id, operation);
    void operation.finally(() => { if (this.messages.get(id) === operation) this.messages.delete(id); }).catch(() => {});
    return operation;
  }
  private async acceptMessage(ref: string, text: string, operationId: string, options: MessageOptions, assertAdmission: () => void): Promise<AgentRun> {
    assertAdmission();
    const { parentEntryId, requestId, signal } = options;
    signal?.throwIfAborted();
    if (!text.trim()) throw rejected("Message must be nonempty.");
    if (this.closed) throw rejected("Agent controller is shutting down.");
    const receipt = this.repo.receipt(this.options.parentId, operationId) as { runId: string } | undefined;
    if (receipt) return this.run(receipt.runId);
    const agent = this.resolve(ref);
    const active = this.repo.activeRun(agent.agentId);
    if (active?.status === "cancelling") throw rejected("Agent is still stopping; wait for observed termination.");
    if (!active) {
      this.capacity();
      if (this.options.ctx.mode === "print" || this.options.ctx.mode === "json") throw rejected("SendMessage resumption requires a persistent TUI or RPC session.");
      if (!agent.resumable || !agent.sessionPath) throw rejected("Agent is not resumable or its saved conversation is unavailable.");
      try {
        const lines = readFileSync(agent.sessionPath, "utf8").trim().split("\n");
        if (!lines.length || lines.some(line => { JSON.parse(line); return false; }) || JSON.parse(lines[0]).type !== "session") throw new Error("Invalid session header");
      } catch (error) { throw rejected(`Saved conversation cannot be resumed: ${String(error)}`); }
      if (agent.worktree && agent.worktree.state !== "allocated") throw rejected("Worktree cleanup prevents resumption.");
      try {
        await this.options.validateResume?.(agent);
        if (agent.worktree) await this.worktrees.verify(agent.worktree);
      } catch (error) { throw rejected(`Recorded model or worktree is unavailable: ${String(error)}`); }
      signal?.throwIfAborted();
      this.capacity();
      const latest = this.resolve(agent.agentId);
      if (latest.worktree && latest.worktree.state !== "allocated") throw rejected("Worktree cleanup prevents resumption.");
    }
    assertAdmission();
    const previous = this.run(agent.agentId);
    if (agent.parentId === this.options.parentId && (!this.isVisible(previous)
      || (parentEntryId && !this.isVisible({ ...previous, parentEntryId })))) {
      throw rejected("The agent's saved conversation or this operation belongs to another branch. Return to that branch or launch a fresh agent.");
    }
    signal?.throwIfAborted();
    const run = active ?? this.newRun(agent, text, `Resume ${agent.name ?? agent.definition.name}`, true, `message:${operationId}`, requestId, parentEntryId);
    this.repo.transaction(() => {
      if (!active) this.repo.putRun(run);
      else this.repo.putGuidance({ id: operationId, runId: run.runId, text, state: "pending" });
      this.repo.putReceipt(this.options.parentId, operationId, { runId: run.runId });
    });
    if (!active) this.projectRun(run);
    if (!active) {
      this.bindAbort(run, signal);
      this.notify({ type: "admitted", run: structuredClone(run) });
    }
    this.changed(); if (active) this.flushGuidance(run.runId); else this.drain();
    return run;
  }
  /** Commit the exact parent fleet batch before callbacks can settle work or admit queued runs. */
  async stopMany(runIds: readonly string[], operationId: string): Promise<{ runIds: string[] }> {
    const receipt = this.repo.receipt(this.options.parentId, operationId) as { runIds: string[] } | undefined;
    if (receipt) return receipt;
    // Validate the entire set before writing. Agent names/IDs and foreign sessions must
    // never resolve implicitly here: confirmation captures execution identities only.
    const runs = [...new Set(runIds)].map(id => {
      const run = this.repo.getRun(id);
      if (!run || run.parentId !== this.options.parentId) throw rejected(`Run is not in this parent session: ${id}`);
      return run;
    });
    const result = { runIds: runs.map(run => run.runId) };
    const completions: AgentRun[] = [];
    this.repo.transaction(() => {
      for (const run of runs) {
        if (TERMINAL_STATUSES.has(run.status)) continue;
        run.status = run.status === "queued" && !this.active.has(run.runId) ? "cancelled" : "cancelling";
        if (run.status === "cancelled") {
          run.endedAt = Date.now(); this.settleGuidance(run.runId);
          if (!this.repo.completions(run.parentId).some(c => c.runId === run.runId)) {
            this.repo.putCompletion({ id: `completion:${run.runId}`, runId: run.runId, parentId: run.parentId, state: "pending", trigger: run.background });
            completions.push(run);
          }
        }
        run.revision++; this.repo.putRun(run);
      }
      this.repo.putReceipt(this.options.parentId, operationId, result);
    });
    // Publish only after the complete transaction. No callback sees a partially
    // cancelled queue, and no await separates target transitions.
    for (const run of runs) {
      this.projectRun(run);
      if (TERMINAL_STATUSES.has(run.status)) this.releaseAbortListeners(run.runId);
    }
    this.changed();
    for (const run of runs) {
      if (TERMINAL_STATUSES.has(run.status)) continue;
      const active = this.active.get(run.runId);
      active?.controller.abort();
      try { if (active?.child) void active.child.abort().catch(e => this.options.diagnostic?.(e)); }
      catch (error) { this.options.diagnostic?.(error); }
    }
    for (const run of completions) {
      try { this.options.completion?.(run); } catch (error) { this.options.diagnostic?.(error); }
    }
    return result;
  }
  async stop(ref: string, operationId: string): Promise<AgentRun> {
    const receipt = this.repo.receipt(this.options.parentId, operationId) as { runId: string } | undefined;
    if (receipt) return this.run(receipt.runId);
    const direct = this.repo.getRun(ref);
    const agent = direct ? this.repo.getAgent(direct.agentId) : undefined;
    const resolved = agent ?? (() => { try { return this.resolve(ref); } catch { return undefined; } })();
    const owner = resolved ? this.liveOwner(resolved) : undefined;
    // Stopping a live nested agent is performed by its owning session, which cascades the
    // stop to that agent's own children before it settles (SA-12).
    if (resolved && owner) return owner.stop(resolved.agentId, operationId);
    if (resolved && resolved.parentId !== this.options.parentId) {
      const settled = this.run(resolved.agentId);
      if (TERMINAL_STATUSES.has(settled.status)) return settled;
      throw rejected("The owning child session is unavailable; the execution is interrupted when the parent session recovers.");
    }
    const run = this.run(ref);
    if (!TERMINAL_STATUSES.has(run.status)) {
      run.status = run.status === "queued" && !this.active.has(run.runId) ? "cancelled" : "cancelling";
      if (run.status === "cancelled") { run.endedAt = Date.now(); this.settleGuidance(run.runId); }
      this.saveRun(run);
    }
    this.repo.putReceipt(this.options.parentId, operationId, { runId: run.runId });
    if (run.status === "cancelled" && !this.repo.completions(run.parentId).some(c => c.runId === run.runId)) {
      this.repo.putCompletion({ id: `completion:${run.runId}`, runId: run.runId, parentId: run.parentId, state: "pending", trigger: run.background });
      try { this.options.completion?.(run); } catch (e) { this.options.diagnostic?.(e); }
    }
    const active = this.active.get(run.runId);
    active?.controller.abort();
    if (active?.child) void active.child.abort().catch(e => this.options.diagnostic?.(e));
    this.changed(); return this.run(run.runId);
  }
  async wait(ref: string, timeout = 30000, signal?: AbortSignal): Promise<AgentRun> {
    const id = this.run(ref).runId;
    if (TERMINAL_STATUSES.has(this.run(id).status) || timeout === 0) return this.run(id);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(timer); off(); signal?.removeEventListener("abort", abort); };
      const finish = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new Error("Output wait cancelled; child execution is unchanged.")); };
      const off = this.subscribe(() => { if (TERMINAL_STATUSES.has(this.run(id).status)) finish(); });
      timer = setTimeout(finish, Math.min(timeout, 2_147_483_647));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    return this.run(id);
  }
  async transcript(ref: string): Promise<readonly TranscriptEvent[]> {
    const a = this.resolve(ref);
    const selected = this.inspectRun(a.agentId);
    if (selected.runId !== this.run(a.agentId).runId) {
      return [{ kind: "notice", tone: "muted", text: "This branch's retained execution output is shown below. The saved child conversation advanced on another branch; launch a fresh agent to continue here." },
        { kind: "assistant", text: selected.output || selected.error || "No retained output." }];
    }
    const guidance = this.repo.runs(a.parentId).filter(run => run.agentId === a.agentId)
      .flatMap(run => this.repo.guidance(run.runId)).filter(item => item.state !== "consumed").slice(-20)
      .map(item => guidanceNotice(item));
    if (!a.sessionPath) {
      const run = this.run(a.agentId);
      return [{ kind: "notice", tone: "muted", text: run.output || run.error || "The child has not created a transcript yet." }, ...guidance];
    }
    const fd = openSync(a.sessionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = fstatSync(fd).size;
      const offset = Math.max(0, size - 200000);
      const buffer = Buffer.alloc(Math.min(size, 200000));
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      let text = buffer.subarray(0, bytes).toString("utf8");
      if (offset) text = text.slice(text.indexOf("\n") + 1);
      const parsed = parseTranscriptEvents(text, { maxBytes: 200000 });
      return [...parsed.events, ...guidance];
    } finally { closeSync(fd); }
  }
  cleanup(ref: string, operationId: string): Promise<unknown> {
    if (this.closed) return Promise.reject(rejected("Agent controller is shutting down."));
    const operation = Promise.resolve().then(() => this.performCleanup(ref, operationId));
    this.cleanups.add(operation);
    void operation.finally(() => this.cleanups.delete(operation)).catch(() => {});
    return operation;
  }
  private async performCleanup(ref: string, operationId: string): Promise<unknown> {
    if (this.closed) throw rejected("Agent controller is shutting down.");
    const receipt = this.repo.receipt(this.options.parentId, operationId);
    if (receipt) return receipt;
    const agent = this.resolve(ref);
    const owner = this.liveOwner(agent);
    // A nested agent's workspace belongs to its owning session's storage root (SA-12).
    if (owner) return owner.cleanup(agent.agentId, operationId);
    if (agent.parentId !== this.options.parentId) throw rejected("Worktree cleanup for a nested agent requires its owning child session; clean up after the delegating agent settles.");
    if (this.repo.activeRun(agent.agentId) || !agent.worktree || agent.worktree.state !== "allocated") throw rejected("Worktree is active, missing, or already reserved for cleanup.");
    agent.worktree.state = "cleaning"; this.repo.putAgent(agent); this.projectAgent(agent); this.changed();
    try {
      await this.worktrees.cleanup(agent.worktree);
      agent.worktree.state = "removed"; agent.resumable = false;
      this.repo.transaction(() => { this.repo.putAgent(agent); this.repo.putReceipt(this.options.parentId, operationId, { removed: true, agentId: agent.agentId }); });
      return { removed: true, agentId: agent.agentId };
    } catch (error) {
      try { await this.worktrees.verify(agent.worktree); agent.worktree.state = "allocated"; }
      catch { agent.worktree.state = "uncertain"; }
      this.repo.putAgent(agent); this.projectAgent(agent);
      if (agent.worktree.state === "allocated") throw rejected(String(error));
      throw error;
    } finally { this.changed(); }
  }
  receipt(id: string): unknown { return this.repo.receipt(this.options.parentId, id); }
  findLaunch(id: string): AgentRun | undefined { return this.repo.findLaunch(this.options.parentId, id); }
  /**
   * Sessions whose completions this session may deliver: its own, plus descendant sessions whose
   * service has ended. A run's `parentId` is the session that launched it, and a nested agent's
   * record carries that session in `parentId`, so the owning sessions are derivable from the tree
   * (architecture Section 10.1). A live owner still delivers its own outcomes.
   */
  private completionSessions(): string[] {
    const sessions = new Set<string>([this.options.parentId]);
    for (const agent of this.treeAgents()) sessions.add(agent.parentId);
    return [...sessions].filter(session => session === this.options.parentId || !liveSessionOwner(session));
  }
  /**
   * Settled, visible runs whose outcome the parent has not been informed of, across this session and
   * the descendant sessions whose owner has ended (architecture Sections 10.1 and 10.2).
   *
   * The projection reads run settlement and outcome acknowledgement rather than the delivery state,
   * so a settled run stays listed until a notification or a read informs the parent, and a missing
   * completion record cannot hide a settled run.
   */
  uninformedOutcomes(): AgentRun[] {
    const acknowledged = new Set<string>();
    const runs: AgentRun[] = [];
    const seen = new Set<string>();
    for (const session of this.completionSessions()) {
      for (const completion of this.repo.completions(session)) if (completion.acknowledgedAt) acknowledged.add(completion.runId);
      for (const run of this.repo.runs(session)) if (!seen.has(run.runId)) { seen.add(run.runId); runs.push(run); }
    }
    return runs.filter(run => TERMINAL_STATUSES.has(run.status) && this.isVisible(run) && !acknowledged.has(run.runId));
  }
  /**
   * Record that the parent has been informed of a run's outcome.
   *
   * A read of a run that has not settled informs nothing, so an outcome in progress stays visible
   * (architecture Section 3, Invariant 16). An existing acknowledgement is never replaced
   * (Invariant 15). The record is written by the session that owns the run, so the same sessions the
   * projection reads are searched (Section 10.1).
   */
  acknowledgeOutcome(runId: string): void {
    const run = this.run(runId);
    if (!TERMINAL_STATUSES.has(run.status)) return;
    for (const session of this.completionSessions()) {
      const existing = this.repo.completions(session).find(c => c.runId === runId);
      if (!existing) continue;
      if (existing.acknowledgedAt) return;
      this.repo.putCompletion({ ...existing, acknowledgedAt: Date.now() });
      this.changed();
      return;
    }
    // A settled run whose settlement never wrote a completion record is still acknowledgeable, so that
    // the projection can never list a settled run the parent is unable to retire (Section 10.2).
    this.repo.putCompletion({ id: `completion:${runId}`, runId, parentId: run.parentId, state: "pending" as const, trigger: run.background, acknowledgedAt: Date.now() });
    this.changed();
  }
  recordDelivery(id: string, state: "submitted" | "observed" | "uncertain"): void {
    for (const session of this.completionSessions()) {
      const d = this.repo.completions(session).find(c => c.id === id);
      if (!d) continue;
      // Delivering the notification informs the parent, and an earlier acknowledgement survives every
      // later delivery transition (architecture Section 3, Invariant 15).
      this.repo.putCompletion({ ...d, state, acknowledgedAt: state === "observed" ? (d.acknowledgedAt ?? Date.now()) : d.acknowledgedAt });
      return;
    }
    this.options.diagnostic?.(new Error(`Completion delivery ${id} has no record to update.`));
  }
  async shutdown(): Promise<boolean> {
    this.closed = true;
    for (const run of this.repo.runs(this.options.parentId).filter(r => !TERMINAL_STATUSES.has(r.status))) await this.stop(run.runId, `shutdown:${run.runId}`);
    const settled = Promise.allSettled([...this.active.values()].map(a => a.done).concat([...this.cleanups, ...this.messages.values()].map(p => p.then(() => {}, () => {})))).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([settled, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.options.config.shutdownTimeoutMs); })]);
    clearTimeout(timer); return result;
  }
}
