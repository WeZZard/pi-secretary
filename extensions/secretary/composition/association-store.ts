import type { DatabaseSync } from "node:sqlite";

export interface GoalAssociation {
  threadId: string;
  goalId: string;
  sessionEpoch: string;
  controlGeneration: number;
  intentSeq: number;
}

export interface RequestAssociation {
  requestId: string;
  authority: "user" | "automatic" | "notification" | "unknown";
  goal?: GoalAssociation;
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length) throw new Error("Invalid association identifier");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid association payload");
  return value as Record<string, unknown>;
}

function goalAssociation(value: unknown): GoalAssociation {
  const goal = object(value);
  const { threadId, goalId, sessionEpoch, controlGeneration, intentSeq } = goal;
  identifier(threadId); identifier(goalId); identifier(sessionEpoch);
  if (Object.keys(goal).some(key => !["threadId", "goalId", "sessionEpoch", "controlGeneration", "intentSeq"].includes(key)) ||
      !Number.isSafeInteger(controlGeneration) || Number(controlGeneration) < 0 ||
      !Number.isSafeInteger(intentSeq) || Number(intentSeq) < 0) throw new Error("Invalid goal association");
  return { threadId, goalId, sessionEpoch, controlGeneration: controlGeneration as number, intentSeq: intentSeq as number };
}

function canonical(record: RequestAssociation): RequestAssociation {
  identifier(record.requestId);
  if (!["user", "automatic", "notification", "unknown"].includes(record.authority)) throw new Error("Invalid request authority");
  return {
    requestId: record.requestId,
    authority: record.authority,
    ...(record.goal === undefined ? {} : { goal: goalAssociation(record.goal) }),
  };
}

/** Composition persistence uses the supplied connection without owning its lifetime. */
export class AgentAssociationStore {
  private readonly db: DatabaseSync;
  private sequence = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS secretary_composition_requests (
        request_id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secretary_composition_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL REFERENCES secretary_composition_requests(request_id)
      );
    `));
  }

  private transaction<T>(fn: () => T): T {
    const name = `secretary_composition_${++this.sequence}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }

  putRequest(record: RequestAssociation): void {
    const normalized = canonical(record);
    const json = JSON.stringify(normalized);
    this.transaction(() => {
      this.db.prepare("INSERT INTO secretary_composition_requests (request_id, json) VALUES (?, ?) ON CONFLICT(request_id) DO NOTHING")
        .run(normalized.requestId, json);
      if (JSON.stringify(canonical(this.request(normalized.requestId)!)) !== json) throw new Error("Request association cannot change");
    });
  }

  request(id: string): RequestAssociation | undefined {
    const row = this.db.prepare("SELECT json FROM secretary_composition_requests WHERE request_id = ?").get(id);
    return row ? canonical(JSON.parse(String(row.json))) : undefined;
  }

  associateRun(runId: string, requestId: string): void {
    identifier(runId); identifier(requestId);
    this.transaction(() => {
      if (!this.request(requestId)) throw new Error("Run association requires a durable request");
      this.db.prepare("INSERT INTO secretary_composition_runs (run_id, request_id) VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING")
        .run(runId, requestId);
      if (this.run(runId)?.requestId !== requestId) throw new Error("Run association cannot change");
    });
  }

  run(runId: string): RequestAssociation | undefined {
    const row = this.db.prepare(`SELECT requests.json FROM secretary_composition_runs AS runs
      JOIN secretary_composition_requests AS requests USING (request_id) WHERE runs.run_id = ?`).get(runId);
    return row ? canonical(JSON.parse(String(row.json))) : undefined;
  }

  /** Capture all legacy attribution before rewriting any payload, in one transaction. */
  migrateLegacy(): void {
    this.transaction(() => {
      const exists = (table: string) => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      const runs = new Map<string, Record<string, unknown>>();
      const goals = new Map<string, GoalAssociation>();
      const rewrites: { table: string; id: string; payload: Record<string, unknown> }[] = [];
      const capture = (runId: string, value: unknown) => {
        const goal = goalAssociation(value);
        const previous = goals.get(runId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(goal)) throw new Error("Conflicting legacy goal associations");
        goals.set(runId, goal);
      };
      if (exists("secretary_agent_runs")) {
        for (const row of this.db.prepare("SELECT id, json FROM secretary_agent_runs").all()) {
          const id = String(row.id);
          const payload = object(JSON.parse(String(row.json)));
          if (payload.runId !== id) throw new Error("Invalid legacy run identity");
          if (Object.hasOwn(payload, "requestId")) identifier(payload.requestId);
          runs.set(id, payload);
          if (Object.hasOwn(payload, "goal")) {
            capture(id, payload.goal);
            rewrites.push({ table: "secretary_agent_runs", id, payload });
          }
        }
      }
      if (exists("secretary_agent_usage")) {
        for (const row of this.db.prepare("SELECT id, run_id, json FROM secretary_agent_usage").all()) {
          const id = String(row.id);
          const runId = String(row.run_id);
          const payload = object(JSON.parse(String(row.json)));
          if (payload.id !== id || payload.runId !== runId) throw new Error("Invalid legacy usage identity");
          if (Object.hasOwn(payload, "goal")) {
            capture(runId, payload.goal);
            rewrites.push({ table: "secretary_agent_usage", id, payload });
          }
        }
      }
      for (const [runId, goal] of goals) {
        const payload = runs.get(runId);
        const requestId = payload?.requestId as string | undefined ?? this.run(runId)?.requestId ?? `legacy-agent-run:${runId}`;
        this.putRequest({ requestId, authority: "automatic", goal });
        this.associateRun(runId, requestId);
        if (payload && !Object.hasOwn(payload, "requestId")) {
          payload.requestId = requestId;
          if (!rewrites.some(row => row.table === "secretary_agent_runs" && row.id === runId)) {
            rewrites.push({ table: "secretary_agent_runs", id: runId, payload });
          }
        }
      }
      for (const { table, id, payload } of rewrites) {
        delete payload.goal;
        this.db.prepare(`UPDATE ${table} SET json = ? WHERE id = ?`).run(JSON.stringify(payload), id);
      }
    });
  }
}
