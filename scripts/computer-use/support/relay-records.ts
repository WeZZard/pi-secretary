/**
 * Check results read back from relay evidence, for runs whose agent runs the task's check itself with
 * relay_exec (evaluation §7.1 and §7.2): each check command's result is the first action record whose
 * execution request carries the command's script. A sleep needs no record.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "../../../extensions/secretary/computer-use/backend/relay-client.ts";

interface ActionRecord { executionId?: string; startRetainedAt?: string; toolOutcome?: { kind: string; value?: { stdout?: string; exitStatus?: { code: number | null } } } }

/** Undefined when no check command left a record. */
export function recordedChecks(evidence: string, check: string[][]): CheckResult[] | undefined {
  // The argv is in the execution's request; an action record names its execution, and its title only when the agent gave none.
  const read = (dir: string) => existsSync(dir) ? readdirSync(dir).map(name => readFileSync(join(dir, name), "utf8")) : [];
  const records = existsSync(evidence) ? readdirSync(evidence, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const requests = new Map(read(join(evidence, entry.name, "host/requests"))
      .map(text => [(JSON.parse(text) as { executionId?: string }).executionId, text] as const));
    return read(join(evidence, entry.name, "state/records/action")).map(record => {
      const json = JSON.parse(record) as ActionRecord;
      return { text: record + (requests.get(json.executionId) ?? ""), json };
    });
  }) : [];
  const results = check.map(argv => {
    if (argv[0] === "/bin/sleep") return { argv, completed: true, stdout: "" };
    const needle = JSON.stringify(argv.at(-1)!).slice(1, 80);
    const record = records.filter(entry => entry.text.includes(needle))
      .sort((a, b) => (a.json.startRetainedAt ?? "").localeCompare(b.json.startRetainedAt ?? ""))[0];
    const value = record?.json.toolOutcome?.value;
    return { argv, completed: record?.json.toolOutcome?.kind === "success" && value?.exitStatus?.code === 0, stdout: value?.stdout ?? "" };
  });
  return results.some(result => result.argv[0] !== "/bin/sleep" && (result.completed || result.stdout)) ? results : undefined;
}
