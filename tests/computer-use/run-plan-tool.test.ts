import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { FakeBackend } from "../../extensions/secretary/computer-use/backend/fake-backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import type { DecisionResponse } from "../../extensions/secretary/computer-use/executor-client.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";
import { executeRunPlan, formatResult } from "../../extensions/secretary/computer-use/tools/run-plan.ts";

const form: Omit<WindowRead, "readMs"> = { window: { pid: 1, windowId: 1, app: "Form", title: "Form" }, appActive: true, truncated: false, elements: [
  { element_index: 0, role: "AXWindow", label: "Form", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
  { element_index: 1, role: "AXButton", label: "Submit", parent_index: 0, depth: 1, frame: { x: 100, y: 50, w: 80, h: 20 } }] };

function context(t: TestContext, used = 0) {
  const root = mkdtempSync(join(tmpdir(), "secretary-run-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let recorded = 0;
  const executor = { decide: async (): Promise<DecisionResponse> => ({ roundTripMs: 1, answers: { operation: { choice: "abstain", confidence: 0.9 } } }) };
  return {
    recorded: () => recorded,
    context: { deps: { backend: new FakeBackend({ Form: [form] }), executor, telemetry: new Telemetry(root), config: { ...defaultComputerUseConfiguration(), settleMs: 0 }, sleep: async () => {} },
      knownObservation: (id: string) => id === "obs-1", escalations: { used, limit: 2, record: () => { recorded++; } } },
  };
}

const params = { app: "Form", goal: "Submit the form", steps: [{ id: "submit", intent: "Submit the form", postcondition: { exists: { name: "Done" } } }] };

test("an escalated plan returns the reason, the prior and the current window, and counts toward the limit", async (t) => {
  const { context: ctx, recorded } = context(t);
  const result = await executeRunPlan(ctx, params);
  assert.deepEqual(result.details, { outcome: "escalated", decisions: 1, actions: 0, escalation: "target_not_found" });
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /^Outcome: escalated\. Executor decisions: 1\. Actions: 0\./);
  assert.match(text, /Escalation at step submit: target_not_found\./);
  assert.match(text, /Current window:\nwindow:\n {2}A Button "Submit"/);
  assert.equal(recorded(), 1);
});

test("plans are rejected before execution for an unknown observation, a malformed step, or an exhausted escalation budget", async (t) => {
  const unknown = await executeRunPlan(context(t).context, { ...params, based_on: "obs-9" });
  assert.match((unknown.content[0] as { text: string }).text, /observation "obs-9" is unknown or expired/);
  const malformed = await executeRunPlan(context(t).context, { ...params, steps: [{ id: "a", intent: "i", postcondition: { focused: { name: "x" } } }] });
  assert.match((malformed.content[0] as { text: string }).text, /^Plan rejected: step a: focused is not supported/);
  const exhausted = await executeRunPlan(context(t, 2).context, params);
  assert.match((exhausted.content[0] as { text: string }).text, /already returned 2 escalations/);
  assert.equal(exhausted.details.outcome, "rejected");
});

test("a completed result lists each step compactly", () => {
  assert.equal(formatResult({ outcome: "completed", decisions: 1, actions: 1, steps: [
    { id: "a", result: "verified", action: "press", element: "Submit", detail: "\"Done\" is on screen" },
    { id: "b", result: "skipped", detail: "the postcondition already held" }] }),
  "Outcome: completed. Executor decisions: 1. Actions: 1.\n- a: verified, press \"Submit\" (\"Done\" is on screen)\n- b: skipped (the postcondition already held)");
});
