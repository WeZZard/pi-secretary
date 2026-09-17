import type { DatabaseSync } from "node:sqlite";

export function migrateAgents(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS secretary_agent_schema (version INTEGER NOT NULL)`);
  const versions = db.prepare("SELECT version FROM secretary_agent_schema").all();
  if (versions.length > 1 || (versions.length === 1 && versions[0].version !== 1)) throw new Error("Unsupported agent database schema version");
  db.exec(`
    SAVEPOINT secretary_agent_migration;
    CREATE TABLE IF NOT EXISTS secretary_agents (
      id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT, json TEXT NOT NULL,
      UNIQUE(parent_id, name), UNIQUE(id, parent_id)
    );
    CREATE TABLE IF NOT EXISTS secretary_agent_runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, parent_id TEXT NOT NULL,
      launch_key TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL,
      UNIQUE(parent_id, launch_key), UNIQUE(id, parent_id),
      FOREIGN KEY(agent_id, parent_id) REFERENCES secretary_agents(id, parent_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS secretary_agent_one_active
      ON secretary_agent_runs(agent_id) WHERE status IN ('queued','starting','running','cancelling');
    CREATE TABLE IF NOT EXISTS secretary_agent_guidance (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES secretary_agent_runs(id), json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secretary_agent_completions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, parent_id TEXT NOT NULL, json TEXT NOT NULL,
      FOREIGN KEY(run_id, parent_id) REFERENCES secretary_agent_runs(id, parent_id)
    );
    CREATE TABLE IF NOT EXISTS secretary_agent_receipts (
      parent_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(parent_id,id)
    );
    CREATE TABLE IF NOT EXISTS secretary_agent_usage (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES secretary_agent_runs(id), json TEXT NOT NULL
    );
    INSERT INTO secretary_agent_schema SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM secretary_agent_schema);
    RELEASE secretary_agent_migration;
  `);
}
