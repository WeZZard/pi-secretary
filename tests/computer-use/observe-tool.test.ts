import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendError } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { FakeBackend } from "../../extensions/secretary/computer-use/backend/fake-backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import type { Observation } from "../../extensions/secretary/computer-use/observer.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";
import { executeObserve } from "../../extensions/secretary/computer-use/tools/observe.ts";
import { finderRead, textEditRead } from "./fixtures/trees.ts";

function setup(t: TestContext, script: ConstructorParameters<typeof FakeBackend>[0]) {
  const root = mkdtempSync(join(tmpdir(), "secretary-observe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remembered: Observation[] = [];
  const sleeps: number[] = [];
  const backend = new FakeBackend(script);
  let id = 0;
  const deps = { backend, telemetry: new Telemetry(root), config: defaultComputerUseConfiguration(), remember: (o: Observation) => remembered.push(o),
    sleep: async (ms: number) => { sleeps.push(ms); }, newId: () => `obs-${++id}` };
  return { deps, backend, remembered, sleeps, root };
}

test("a ready observation returns the planner table, the screenshot, and a retrieval record", async (t) => {
  const shot = { data: "aW1hZ2U=", mimeType: "image/png" };
  const { deps, remembered } = setup(t, { Finder: [{ ...finderRead(), screenshot: shot }] });
  const result = await executeObserve(deps, { app: "Finder" }, true);
  const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
  assert.match(text, /Elements: 31 in 3 groups\. Discarded: container 4, collapsed_frame 1, disabled 1\./);
  assert.match(text, /toolbar:\n {2}A Button "Back"/);
  assert.deepEqual(result.content[1], { type: "image", ...shot });
  assert.equal(result.details.screenshot, "included");
  assert.equal(remembered[0]!.id, "obs-1");
  const record = JSON.parse(readFileSync(result.details.recordPath!, "utf8"));
  assert.equal(record.tree.length, record.discards.length + 31, "The record holds the full tree, the table, and every discard");
  assert.match(record.executorTable, /^TOOLBAR\n/);
});

test("a text-only model gets no image and is told why", async (t) => {
  const { deps } = setup(t, { TextEdit: [{ ...textEditRead(), screenshot: { data: "x", mimeType: "image/png" } }] });
  const result = await executeObserve(deps, { app: "TextEdit" }, false);
  assert.equal(result.content.length, 1);
  assert.equal(result.details.screenshot, "omitted_model_text_only");
  assert.match((result.content[0] as { text: string }).text, /Screenshot omitted: the current model does not accept images\./);
});

test("a window that is still appearing is read again after the settle interval, at most twice", async (t) => {
  const missing = textEditRead();
  missing.elements = missing.elements.filter(element => element.role !== "AXWindow");
  const recovering = setup(t, { TextEdit: [missing, textEditRead()] });
  const result = await executeObserve(recovering.deps, { app: "TextEdit" }, false);
  assert.equal(result.details.status, "ready");
  assert.equal(result.details.attempts, 2);
  assert.deepEqual(recovering.sleeps, [300]);

  const stuck = setup(t, { TextEdit: [missing] });
  const failed = await executeObserve(stuck.deps, { app: "TextEdit" }, false);
  assert.equal(failed.details.status, "window_missing");
  assert.equal(failed.details.attempts, 3);
  assert.equal(stuck.remembered.length, 0, "A failed observation cannot be cited by a plan");
});

test("backend errors are reported as tool results rather than partial tables", async (t) => {
  const { deps } = setup(t, { Finder: [new BackendError("timeout", "cua-driver get_window_state exceeded 15000 ms")] });
  const result = await executeObserve(deps, { app: "Finder" }, false);
  assert.equal(result.details.status, "backend_failed");
  assert.match((result.content[0] as { text: string }).text, /^Observation failed: cua-driver get_window_state exceeded/);
  const closed = await executeObserve(deps, { app: "Mail" }, false);
  assert.match((closed.content[0] as { text: string }).text, /does not launch applications/);
});
