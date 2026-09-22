import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord, AgentRun, CompletionRecord, RunStatus } from "../../extensions/secretary/agents/records.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { agentHarness } from "../support/agent-harness.ts";

/**
 * Contract regression suite for the outcome projection.
 *
 * The extension injects a per-turn notice listing outcomes the parent has not been informed of, and
 * instructs the parent that reading one with `TaskOutput` informs it as well. The reported defect was
 * that the notice was keyed on the delivery transport state of the completion record rather than on
 * whether the parent holds the outcome. A settled run whose completion message was never delivered
 * therefore stayed listed forever, and reading it could not clear the list.
 *
 * The contract asserted here is:
 *
 *   N1. A settled run the parent has not been informed about is listed.
 *   N2. A settled run the parent has been informed about is not listed, whether the parent was informed
 *       by delivery or by inspection.
 *   N3. An unsettled run is not listed as an uninformed outcome.
 *   N4. A read of an unsettled run does not inform the parent, so live progress stays visible.
 *   N5. Acknowledgement is stable and is never resurrected by later turns.
 *   N6. The notice only instructs `TaskOutput` if calling `TaskOutput` actually discharges the list.
 *
 * N1 and N2 are asserted together on purpose. N2 alone would be satisfied by never listing anything,
 * and N1 alone by listing everything forever. Only the pair identifies the intended behaviour.
 *
 * Assertions read the parsed outcome line rather than the whole snapshot, because the snapshot also
 * carries a roster of active runs that legitimately contains run identifiers.
 */

const PARENT = "parent";
const SNAPSHOT = "secretary:agents-state";
const COMPLETION = "secretary:agent-completion";

/** The five terminal statuses in the run vocabulary. */
const TERMINAL: RunStatus[] = ["succeeded", "partial", "failed", "cancelled", "interrupted"];
/** The four non-terminal statuses, used for the negative controls. */
const NON_TERMINAL: RunStatus[] = ["queued", "starting", "running", "cancelling"];
/**
 * The prior delivery dimension. `undefined` means no completion record exists at all, which the
 * interrupted-recovery path could produce before the settlement transaction was completed.
 */
const DELIVERY: Array<{ label: string; state?: CompletionRecord["state"]; acknowledged?: boolean }> = [
  { label: "no-record", state: undefined },
  { label: "pending", state: "pending" },
  { label: "submitted", state: "submitted" },
  { label: "uncertain", state: "uncertain" },
  { label: "acknowledged", state: "observed", acknowledged: true },
];

type Harness = Awaited<ReturnType<typeof agentHarness>>;

/** Create the conversation entry that admits a delegation, and return its id. */
function admitDelegation(h: Harness): string {
  h.pi.appendEntry("fixture-admission", {});
  const admission = h.ctx.sessionManager.getLeafId();
  assert.ok(admission, "the fixture conversation has an admission entry");
  return admission;
}

/** Seed one owned run through the real repository, mirroring how the service records a settled execution. */
function seedRun(h: Harness, options: { runId: string; status: RunStatus; delivery?: CompletionRecord["state"]; acknowledged?: boolean; admission: string }): AgentRepository {
  const repository = new AgentRepository(h.engine.db.connection);
  const agent: AgentRecord = {
    agentId: `agent_${options.runId}`, parentId: PARENT,
    definition: { name: options.runId, description: "Fixture delegation", prompt: "Return a fixture result", source: "fixture", hash: "fixture", resumable: true },
    model: "installer-test/fixture", tools: [], cwd: h.root, configCwd: h.root, resumable: true, createdAt: 1,
  };
  repository.putAgent(agent);
  const run: AgentRun = {
    runId: options.runId, agentId: agent.agentId, parentId: PARENT, launchKey: `launch:${options.runId}`,
    parentEntryId: options.admission,
    prompt: "Return a fixture result", description: "Fixture delegation", status: options.status, background: true,
    createdAt: 1, startedAt: 1, endedAt: 2, outputPath: join(h.root, `${options.runId}.txt`),
    output: "Fixture outcome.", toolCount: 0, turnCount: 0, revision: 0,
  };
  repository.putRun(run);
  if (options.delivery) repository.putCompletion({
    id: `completion:${options.runId}`, runId: run.runId, parentId: PARENT, state: options.delivery, trigger: true,
    ...(options.acknowledged ? { acknowledgedAt: 1 } : {}),
  });
  return repository;
}

/** The announcement the parent agent actually reads, taken from the injected snapshot message. */
async function announcement(h: Harness): Promise<string> {
  const prepared = await h.emit("context", { messages: [] }) as { messages?: Array<{ customType?: string; content?: string }> } | undefined;
  return (prepared?.messages ?? []).filter(m => m.customType === SNAPSHOT).map(m => String(m.content ?? "")).join("\n");
}

/** Parse the run identifiers out of the injected notice's uninformed-outcome line. */
function listed(text: string): string[] {
  const match = /Outcomes you have not been informed of:\s*([^.]*)\./.exec(text);
  if (!match) return [];
  const body = (match[1] ?? "").trim();
  if (!body || body === "none") return [];
  return body.split(",").map(part => part.trim()).filter(Boolean);
}

/** The uninformed outcomes the notice currently lists. */
async function outcomes(h: Harness): Promise<string[]> { return listed(await announcement(h)); }

/** Render a fixed-width table so a failed run reports the whole defect surface at once. */
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => (row[column] ?? "").length)));
  return rows.map(row => row.map((cell, column) => (cell ?? "").padEnd(widths[column]!)).join("  ")).join("\n");
}

/**
 * The exploration instrument.
 *
 * One harness seeds the full cross product of terminal status and prior delivery state. Every run is
 * read once, and the notice is captured before and after. The assertion collects every violation
 * instead of stopping at the first, so a single run reports the entire surface.
 */
test("a settled outcome leaves the notice once the parent reads it, whatever the delivery history", async (t) => {
  const h = await agentHarness(t);
  await h.start();
  const admission = admitDelegation(h);
  const cases = TERMINAL.flatMap(status => DELIVERY.map(delivery => ({ status, delivery, runId: `run_${status}_${delivery.label.replace("-", "")}` })));
  for (const item of cases) seedRun(h, { runId: item.runId, status: item.status, delivery: item.delivery.state, acknowledged: item.delivery.acknowledged, admission });

  const before = await outcomes(h);
  const rows: string[][] = [["status", "delivery", "listed-before", "listed-after-read", "acknowledged-after", "contract"]];
  const violations: string[] = [];

  for (const item of cases) {
    const repository = new AgentRepository(h.engine.db.connection);
    const listedBefore = before.includes(item.runId);
    await h.tool("TaskOutput", { task_id: item.runId, block: false });
    const listedAfter = (await outcomes(h)).includes(item.runId);
    const acknowledged = repository.completions(PARENT).find(entry => entry.runId === item.runId)?.acknowledgedAt !== undefined;

    // N1 and N2. A settled run is listed until the parent is informed, and an informed run is not listed.
    const expectListedBefore = !item.delivery.acknowledged;
    // A terminal read informs the parent, so the notice retires the run and storage records it.
    const faults: string[] = [];
    if (listedBefore !== expectListedBefore) faults.push(`listed-before=${listedBefore} want ${expectListedBefore}`);
    if (listedAfter) faults.push("listed-after=true want false");
    if (!acknowledged) faults.push("acknowledged-after=false want true");
    rows.push([item.status, item.delivery.label, String(listedBefore), String(listedAfter), String(acknowledged), faults.length ? faults.join("; ") : "ok"]);
    if (faults.length) violations.push(`${item.runId}: ${faults.join("; ")}`);
  }

  console.log(`\n=== delivery-history matrix (${cases.length} cases, ${violations.length} violations) ===\n${table(rows)}\n`);
  assert.deepEqual(violations, [], "every settled, uninformed run must be listed, and a terminal read must retire it and record the acknowledgement");
});

test("observing the delivered completion retires the run", async (t) => {
  const h = await agentHarness(t);
  await h.start();
  seedRun(h, { runId: "run_delivered", status: "succeeded", delivery: "submitted", admission: admitDelegation(h) });
  assert.ok((await outcomes(h)).includes("run_delivered"), "a submitted outcome stays listed until the parent is informed");
  await h.emit("message_end", { message: { role: "custom", customType: COMPLETION, details: { deliveryId: "completion:run_delivered" }, content: "" } });
  assert.ok(!(await outcomes(h)).includes("run_delivered"), "observing the completion informs the parent and retires the outcome");
});

test("a read of an unsettled run does not inform the parent, so live progress stays visible", async (t) => {
  const h = await agentHarness(t);
  await h.start();
  // A non-terminal run normally has no completion record, so the fixture supplies one to give the
  // negative control something to observe. The assertion is about the read, not about the seeding.
  const repository = seedRun(h, { runId: "run_running", status: "running", delivery: "pending", admission: admitDelegation(h) });
  await h.tool("TaskOutput", { task_id: "run_running", block: false });
  assert.equal(repository.completions(PARENT).find(entry => entry.runId === "run_running")?.acknowledgedAt, undefined, "a nonterminal read must not record acknowledgement");
  // The roster is built from the service projection and needs a real launch to populate, so this
  // fixture asserts the projection rule instead: an unsettled run is never an uninformed outcome.
  assert.ok(!(await outcomes(h)).includes("run_running"), "an unsettled run is never an uninformed outcome, and a read does not change that");
});

test("an unsettled run is not listed as an uninformed outcome", async (t) => {
  const h = await agentHarness(t);
  await h.start();
  const admission = admitDelegation(h);
  const runIds = NON_TERMINAL.map((_, index) => `run_open_${index}`);
  for (const [index, status] of NON_TERMINAL.entries()) seedRun(h, { runId: runIds[index]!, status, admission });
  const current = await outcomes(h);
  for (const runId of runIds) assert.ok(!current.includes(runId), "an outcome that has not settled is not an uninformed outcome");
});

test("acknowledgement is stable and is not resurrected by later turns", async (t) => {
  const h = await agentHarness(t);
  await h.start();
  const repository = seedRun(h, { runId: "run_stable", status: "failed", delivery: "uncertain", admission: admitDelegation(h) });
  await h.tool("TaskOutput", { task_id: "run_stable", block: false });
  assert.ok(repository.completions(PARENT).find(entry => entry.runId === "run_stable")?.acknowledgedAt, "the read records the acknowledgement");
  assert.ok(!(await outcomes(h)).includes("run_stable"), "the entry does not come back on the next turn");
  await h.tool("TaskOutput", { task_id: "run_stable", block: false });
  assert.ok(!(await outcomes(h)).includes("run_stable"), "a second read does not resurrect the entry");
});

test("the notice instructs TaskOutput only if TaskOutput can discharge the list", async (t) => {
  const h = await agentHarness(t);
  await h.start();
  const admission = admitDelegation(h);
  seedRun(h, { runId: "run_failed_pending", status: "failed", delivery: "pending", admission });
  seedRun(h, { runId: "run_cancelled_uncertain", status: "cancelled", delivery: "uncertain", admission });

  const text = await announcement(h);
  const flagged = listed(text);
  assert.ok(flagged.length > 0, "the fixture produces a non-empty notice, so the property is not vacuous");

  if (/TaskOutput/.test(text)) {
    for (const runId of flagged) await h.tool("TaskOutput", { task_id: runId, block: false });
    assert.deepEqual(await outcomes(h), [], "the notice names TaskOutput as a way to inform the parent, so reading every listed run must empty the list");
  }
});

test("a settled run without a completion record is still announced", async (t) => {
  const h = await agentHarness(t);
  await h.start();
  // The projection reads settlement rather than the delivery record, so a settlement that never wrote
  // a record cannot hide the run from the parent.
  seedRun(h, { runId: "run_interrupted", status: "interrupted", admission: admitDelegation(h) });
  assert.ok((await outcomes(h)).includes("run_interrupted"), "a settled run the parent has not been told about must be announced, however it settled");
});
