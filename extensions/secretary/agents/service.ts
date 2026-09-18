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
import { TERMINAL_STATUSES, type AgentDefinition, type AgentRecord, type AgentRowView, type AgentRun, type AgentSnapshot, type GoalOrigin, type RunningChild, type RunnerHooks, type UsageRecord } from "./records.ts";
import { deriveUsageLabels } from "./ui/usage-labels.ts";

export interface LaunchSpec {
  launchKey: string;
  definition: AgentDefinition;
  model: string;
  thinkingLevel?: string;
  tools: string[];
  prompt: string;
  description: string;
  name?: string;
  background: boolean;
  isolation?: "none" | "worktree";
  goal?: GoalOrigin;
}
export interface ServiceOptions {
  parentId: string;
  root: string;
  ctx: ExtensionContext;
  config: AgentConfiguration;
  repository: AgentRepository;
  runner?: typeof createChildRunner;
  authorize?: (run: AgentRun) => void;
  account?: (usage: UsageRecord) => void;
  completion?: (run: AgentRun) => void;
  currentTools?: () => readonly string[];
  resumeOrigin?: (previous: AgentRun) => GoalOrigin;
  validateResume?: (agent: AgentRecord) => Promise<void>;
  diagnostic?: (error: unknown) => void;
}
interface Active { controller: AbortController; child?: RunningChild; done: Promise<void> }
const rejected = (message: string): Error & { definitive: true } => Object.assign(new Error(message), { definitive: true as const });

/** Owns state transitions; a UI or tool result never determines execution state. */
export class AgentService {
  private readonly repo: AgentRepository;
  private readonly worktrees: WorkspaceManager;
  private readonly active = new Map<string, Active>();
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
    for (const run of this.repo.runs(this.options.parentId)) {
      if (!TERMINAL_STATUSES.has(run.status)) {
        run.status = "interrupted"; run.error = "The previous session ended before settlement was recorded.";
        run.endedAt = Date.now(); this.saveRun(run); this.settleGuidance(run.runId);
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
  list(): AgentSnapshot[] {
    const runs = this.repo.runs(this.options.parentId);
    return this.repo.agents(this.options.parentId).map(agent => ({ agent, run: runs.filter(r => r.agentId === agent.agentId).at(-1) }));
  }
  /** Immutable widget rows; consumers render them without deriving state or usage. */
  viewModels(): AgentRowView[] {
    return this.list().map(({ agent, run }) => {
      const labels = run ? deriveUsageLabels(this.repo.usage(run.runId)) : {};
      return { agentId: agent.agentId, name: agent.name, status: run?.status ?? "idle",
        description: run?.description ?? agent.definition.description, model: agent.model,
        ...(run?.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
        ...(run?.activity !== undefined ? { activity: run.activity } : {}),
        background: run?.background ?? false, ...labels };
    });
  }
  resolve(ref: string): AgentRecord {
    const all = this.repo.agents(this.options.parentId);
    const agent = all.find(a => a.agentId === ref || a.name === ref);
    if (!agent) throw rejected(`Agent not found in this parent session: ${ref}`);
    return agent;
  }
  run(ref: string): AgentRun {
    const direct = this.repo.getRun(ref);
    if (direct?.parentId === this.options.parentId) return direct;
    const agent = this.resolve(ref);
    const run = this.repo.runs(this.options.parentId).filter(r => r.agentId === agent.agentId).at(-1);
    if (!run) throw new Error("Agent has no execution record.");
    return run;
  }
  private saveRun(run: AgentRun): void { run.revision++; this.repo.putRun(run); this.changed(); }
  private capacity(): void {
    if (this.closed) throw rejected("This agent controller is shutting down.");
    const pending = this.repo.runs(this.options.parentId).filter(r => !TERMINAL_STATUSES.has(r.status)).length;
    if (pending >= this.options.config.maxConcurrent + this.options.config.maxQueued) throw rejected("Agent execution capacity and pending queue are full.");
  }
  async launch(spec: LaunchSpec): Promise<AgentSnapshot> {
    const existing = this.repo.findLaunch(this.options.parentId, spec.launchKey);
    if (existing) return { agent: this.resolve(existing.agentId), run: existing };
    this.capacity();
    if (!spec.prompt.trim() || !spec.description.trim()) throw new Error("Agent prompt and description must be nonempty.");
    if (spec.name && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(spec.name) || /^(main|team-lead)$/i.test(spec.name) || /^(agent|run)_/.test(spec.name))) throw new Error("Invalid or reserved agent name.");
    const isolation = resolveIsolation(spec.isolation, spec.definition.isolation);
    const requestedWorktree = isolation === "worktree" ? await this.worktrees.captureBase(this.options.ctx.cwd) : undefined;
    this.capacity();
    const duplicate = this.repo.findLaunch(this.options.parentId, spec.launchKey);
    if (duplicate) return { agent: this.resolve(duplicate.agentId), run: duplicate };
    const agentId = `agent_${randomUUID()}`;
    const agent: AgentRecord = {
      agentId, parentId: this.options.parentId, name: spec.name, definition: spec.definition,
      model: spec.model, thinkingLevel: spec.thinkingLevel, tools: spec.tools,
      cwd: this.options.ctx.cwd, configCwd: this.options.ctx.cwd,
      resumable: spec.definition.resumable, requestedWorktree, createdAt: Date.now(),
    };
    const run = this.newRun(agent, spec.prompt, spec.description, spec.background, spec.launchKey, spec.goal);
    this.options.authorize?.(run);
    this.repo.transaction(() => {
      if (spec.name && this.repo.agents(this.options.parentId).some(a => a.name === spec.name)) throw new Error(`Agent name already exists: ${spec.name}`);
      this.repo.putAgent(agent); this.repo.putRun(run);
    });
    this.changed(); this.drain();
    return { agent, run };
  }
  private newRun(agent: AgentRecord, prompt: string, description: string, background: boolean, launchKey: string, goal?: GoalOrigin): AgentRun {
    const runId = `run_${randomUUID()}`;
    const dir = join(this.options.root, "runs", runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outputPath = join(dir, "output.txt");
    writeFileSync(outputPath, "", { mode: 0o600 });
    return { runId, agentId: agent.agentId, parentId: agent.parentId, launchKey, prompt, description,
      status: "queued", background, createdAt: Date.now(), outputPath, output: "", goal,
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
      this.options.authorize?.(run);
      if (entry.controller.signal.aborted) throw new Error("Execution cancelled before startup.");
      run.status = "starting"; run.startedAt = Date.now(); this.saveRun(run);
      let agent = this.resolve(run.agentId);
      const currentTools = this.options.currentTools?.();
      if (currentTools) agent = { ...agent, tools: agent.tools.filter(name => currentTools.includes(name)) };
      if (!agent.tools.length) throw new Error("The saved agent no longer has tools permitted by its parent.");
      if (agent.requestedWorktree && !agent.worktree) {
        const base = agent.requestedWorktree;
        agent.worktree = await this.worktrees.create(agent.agentId, base, entry.controller.signal);
        agent.cwd = join(agent.worktree.path, base.relativeCwd ?? ""); this.repo.putAgent(agent);
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
        session: path => { const a = this.resolve(agent.agentId); a.sessionPath = path; this.repo.putAgent(a); },
        text: text => { output += text; appendFileSync(run.outputPath, text); update(r => { r.output = output.slice(-50000); }); },
        activity: name => update(r => { r.activity = name; r.toolCount++; }),
        turn: () => update(r => { r.turnCount++; }),
        usage: (id, usage) => {
          const record: UsageRecord = { id: `${runId}:${id}`, runId, usage, goal: run.goal };
          // Goal integration commits its own durable idempotency marker atomically.
          this.options.account?.(record); this.repo.recordUsage(record);
        },
        authorize: () => {
          if (entry.controller.signal.aborted || this.closed) throw new Error("Child execution is stopping.");
          this.options.authorize?.(this.run(runId));
        },
      };
      entry.child = await (this.options.runner ?? createChildRunner)({ agent, run, ctx: this.options.ctx,
        signal: entry.controller.signal, hooks, sessionDir: join(this.options.root, "sessions", agent.agentId) });
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
      });
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
  message(ref: string, text: string, operationId: string, goal?: GoalOrigin): Promise<AgentRun> {
    let id: string;
    try { id = this.resolve(ref).agentId; } catch (error) { return Promise.reject(error); }
    const prior = this.messages.get(id) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(() => this.acceptMessage(id, text, operationId, goal));
    this.messages.set(id, operation);
    void operation.finally(() => { if (this.messages.get(id) === operation) this.messages.delete(id); }).catch(() => {});
    return operation;
  }
  private async acceptMessage(ref: string, text: string, operationId: string, goal?: GoalOrigin): Promise<AgentRun> {
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
      this.capacity();
      const latest = this.resolve(agent.agentId);
      if (latest.worktree && latest.worktree.state !== "allocated") throw rejected("Worktree cleanup prevents resumption.");
    }
    const previous = this.run(agent.agentId);
    if (!active && previous.goal && !goal) {
      if (!this.options.resumeOrigin) throw rejected("Resuming goal-attributed work requires current goal authorization.");
      try { goal = this.options.resumeOrigin(previous); }
      catch (error) { throw rejected(String(error)); }
    }
    const run = active ?? this.newRun(agent, text, `Resume ${agent.name ?? agent.definition.name}`, true, `message:${operationId}`, goal);
    try { this.options.authorize?.(run); } catch (error) { throw rejected(String(error)); }
    this.repo.transaction(() => {
      if (!active) this.repo.putRun(run);
      else this.repo.putGuidance({ id: operationId, runId: run.runId, text, state: "pending" });
      this.repo.putReceipt(this.options.parentId, operationId, { runId: run.runId });
    });
    this.changed(); if (active) this.flushGuidance(run.runId); else this.drain();
    return run;
  }
  async stop(ref: string, operationId: string): Promise<AgentRun> {
    const receipt = this.repo.receipt(this.options.parentId, operationId) as { runId: string } | undefined;
    if (receipt) return this.run(receipt.runId);
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
    const guidance = this.repo.runs(this.options.parentId).filter(run => run.agentId === a.agentId)
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
    if (this.repo.activeRun(agent.agentId) || !agent.worktree || agent.worktree.state !== "allocated") throw rejected("Worktree is active, missing, or already reserved for cleanup.");
    agent.worktree.state = "cleaning"; this.repo.putAgent(agent); this.changed();
    try {
      await this.worktrees.cleanup(agent.worktree);
      agent.worktree.state = "removed"; agent.resumable = false;
      this.repo.transaction(() => { this.repo.putAgent(agent); this.repo.putReceipt(this.options.parentId, operationId, { removed: true, agentId: agent.agentId }); });
      return { removed: true, agentId: agent.agentId };
    } catch (error) {
      try { await this.worktrees.verify(agent.worktree); agent.worktree.state = "allocated"; }
      catch { agent.worktree.state = "uncertain"; }
      this.repo.putAgent(agent);
      if (agent.worktree.state === "allocated") throw rejected(String(error));
      throw error;
    } finally { this.changed(); }
  }
  receipt(id: string): unknown { return this.repo.receipt(this.options.parentId, id); }
  pendingCompletions() { return this.repo.completions(this.options.parentId).filter(c => c.state !== "observed"); }
  recordDelivery(id: string, state: "submitted" | "observed" | "uncertain"): void {
    const d = this.repo.completions(this.options.parentId).find(c => c.id === id);
    if (d) this.repo.putCompletion({ ...d, state });
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
