import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { AgentRecord, AgentRun, GuidanceRecord, CompletionRecord, UsageRecord } from "../records.ts";
import { migrateAgents } from "./migrations.ts";
import { TERMINAL_STATUSES } from "../records.ts";

export class AgentRepository {
  private sequence = 0;
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; migrateAgents(db); }
  transaction<T>(fn: () => T): T {
    const name = `agent_tx_${++this.sequence}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Agent transactions must be synchronous");
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }
  private one<T>(table: string, where: string, ...args: SQLInputValue[]): T | undefined {
    const row = this.db.prepare(`SELECT json FROM ${table} WHERE ${where}`).get(...args);
    return row ? JSON.parse(String(row.json)) as T : undefined;
  }
  private many<T>(table: string, where: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(`SELECT json FROM ${table} WHERE ${where} ORDER BY rowid`).all(...args).map(row => JSON.parse(String(row.json)) as T);
  }
  putAgent(record: AgentRecord): void {
    const old = this.getAgent(record.agentId);
    if (old && old.parentId !== record.parentId) throw new Error("Agent ownership cannot change");
    this.db.prepare(`INSERT INTO secretary_agents VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,json=excluded.json`).run(record.agentId, record.parentId, record.name ?? null, JSON.stringify(record));
  }
  getAgent(id: string): AgentRecord | undefined { return this.one("secretary_agents", "id=?", id); }
  agents(parentId: string): AgentRecord[] { return this.many("secretary_agents", "parent_id=?", parentId); }
  putRun(record: AgentRun): void {
    if (this.getAgent(record.agentId)?.parentId !== record.parentId) throw new Error("Run has no matching owned agent");
    if (!["queued", "starting", "running", "cancelling", ...TERMINAL_STATUSES].includes(record.status)) throw new Error("Unknown agent run status");
    const old = this.getRun(record.runId);
    if (old && TERMINAL_STATUSES.has(old.status) && old.status !== record.status) throw new Error("Terminal run status cannot change");
    if (old && (old.agentId !== record.agentId || old.parentId !== record.parentId || old.launchKey !== record.launchKey)) throw new Error("Run identity cannot change");
    this.db.prepare(`INSERT INTO secretary_agent_runs VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,json=excluded.json`).run(record.runId, record.agentId, record.parentId, record.launchKey, record.status, JSON.stringify(record));
  }
  getRun(id: string): AgentRun | undefined { return this.one("secretary_agent_runs", "id=?", id); }
  runs(parentId: string): AgentRun[] { return this.many("secretary_agent_runs", "parent_id=?", parentId); }
  findLaunch(parentId: string, launchKey: string): AgentRun | undefined { return this.one("secretary_agent_runs", "parent_id=? AND launch_key=?", parentId, launchKey); }
  activeRun(agentId: string): AgentRun | undefined { return this.one("secretary_agent_runs", "agent_id=? AND status IN ('queued','starting','running','cancelling')", agentId); }
  putGuidance(record: GuidanceRecord): void {
    if (!this.getRun(record.runId)) throw new Error("Unknown guidance run");
    const old = this.getGuidance(record.id);
    if (old && old.runId !== record.runId) throw new Error("Guidance target cannot change");
    this.db.prepare(`INSERT INTO secretary_agent_guidance VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(record.id, record.runId, JSON.stringify(record));
  }
  getGuidance(id: string): GuidanceRecord | undefined { return this.one("secretary_agent_guidance", "id=?", id); }
  guidance(runId: string): GuidanceRecord[] { return this.many("secretary_agent_guidance", "run_id=?", runId); }
  putCompletion(record: CompletionRecord): void {
    if (this.getRun(record.runId)?.parentId !== record.parentId) throw new Error("Completion has no matching owned run");
    const old = this.one<CompletionRecord>("secretary_agent_completions", "id=?", record.id);
    if (old && (old.runId !== record.runId || old.parentId !== record.parentId)) throw new Error("Completion identity cannot change");
    this.db.prepare(`INSERT INTO secretary_agent_completions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(record.id, record.runId, record.parentId, JSON.stringify(record));
  }
  completions(parentId: string): CompletionRecord[] { return this.many("secretary_agent_completions", "parent_id=?", parentId); }
  receipt(parentId: string, id: string): unknown | undefined { return this.one("secretary_agent_receipts", "parent_id=? AND id=?", parentId, id); }
  putReceipt(parentId: string, id: string, value: unknown): void {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Receipt must be JSON serializable");
    this.db.prepare("INSERT INTO secretary_agent_receipts VALUES (?,?,?) ON CONFLICT(parent_id,id) DO NOTHING").run(parentId, id, json);
  }
  recordUsage(record: UsageRecord): boolean {
    if (!this.getRun(record.runId)) throw new Error("Unknown usage run");
    return this.db.prepare("INSERT INTO secretary_agent_usage VALUES (?,?,?) ON CONFLICT(id) DO NOTHING").run(record.id, record.runId, JSON.stringify(record)).changes === 1;
  }
  usage(runId: string): UsageRecord[] { return this.many("secretary_agent_usage", "run_id=?", runId); }
}
export { acquireParentLock } from "./parent-lock.ts";
