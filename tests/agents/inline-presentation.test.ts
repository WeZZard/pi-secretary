import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retainInlineText } from "../../extensions/secretary/agents/tools/presentation.ts";
import { publicHarness } from "../acceptance/runtime-harness.ts";

function temp(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "secretary-input-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("input artifacts preserve original text, permissions, retry identity, and operation separation", t => {
  const output = join(temp(t), "run", "output.txt");
  const text = "  original\tmessage\n界🧪\n\u001b[31muntrusted text\n";
  const prompt = retainInlineText(output, "prompt", "run-1", text);
  const first = retainInlineText(output, "message", "call-1", text);
  const second = retainInlineText(output, "message", "call-2", text);
  assert.equal(retainInlineText(output, "message", "call-1", text), first);
  assert.notEqual(first, second);
  assert.notEqual(prompt, first);
  for (const path of [prompt, first, second]) {
    assert.equal(readFileSync(path, "utf8"), text);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test("retention refuses mismatched existing content or a symlink without overwriting it", t => {
  const root = temp(t), output = join(root, "output.txt");
  const path = retainInlineText(output, "message", "call-1", "original");
  writeFileSync(path, "tampered");
  assert.throws(() => retainInlineText(output, "message", "call-1", "original"), /does not match/);
  assert.equal(readFileSync(path, "utf8"), "tampered");
  rmSync(path);
  const target = join(root, "outside.txt"); writeFileSync(target, "original");
  symlinkSync(target, path);
  assert.throws(() => retainInlineText(output, "message", "call-1", "original"));
  assert.equal(readFileSync(target, "utf8"), "original");
});

test("registered tools retain prompt and actual guidance and distinguish resumption from queued guidance", async t => {
  const h = await publicHarness(t);
  await h.start();
  const prompt = "Inspect\n original prompt 🧪";
  const args = { description: "inspect", prompt, name: "reviewer", run_in_background: true };
  const launched = await h.tool("Agent", args);
  const original = structuredClone(launched.details.presentation);
  assert.equal(original.agentType, "general-purpose");
  assert.equal(original.name, "reviewer");
  assert.equal(original.model, "acceptance-runtime/fixture");
  assert.equal(readFileSync(original.promptPath, "utf8"), prompt);
  await h.call(0);
  const message = "Check credentials.\nReport errors.";
  const queued = await h.tool("SendMessage", { to: "reviewer", message, summary: "not the message" });
  assert.equal(queued.details.presentation.acknowledgment, "Message queued.");
  assert.equal(readFileSync(queued.details.presentation.messagePath, "utf8"), message);
  (await h.call(0)).finish("first turn");
  (await h.call(1)).finish("after guidance");
  assert.equal((await h.outcome(launched.details.runId)).details.status, "succeeded");
  const resumed = await h.tool("SendMessage", { to: launched.details.agentId, message: "Resume review." });
  assert.equal(resumed.details.presentation.acknowledgment, "Resume accepted.");
  assert.notEqual(resumed.details.runId, launched.details.runId);
  assert.equal(readFileSync(resumed.details.presentation.messagePath, "utf8"), "Resume review.");
  assert.deepEqual(launched.details.presentation, original, "An old result remains an immutable identity snapshot");
  (await h.call(2)).finish("resumed output");
  assert.equal((await h.outcome(resumed.details.runId)).details.status, "succeeded");
  const stopped = await h.tool("TaskStop", { task_id: resumed.details.runId });
  assert.equal(stopped.details.presentation, undefined, "TaskStop retains its legacy result shape");
  assert.match(stopped.content[0].text, /Status: succeeded/);
});

test("artifact failure does not turn accepted guidance into rejection or advertise a nonexistent path", async t => {
  const h = await publicHarness(t);
  await h.start();
  const launched = await h.tool("Agent", { description: "inspect", prompt: "start", name: "reviewer", run_in_background: true });
  await h.call(0);
  const directory = join(launched.details.outputPath, "..");
  // Deny new artifact creation after successful launch. Existing output can still
  // be written by the fixture; restore permissions before completing the run.
  chmodSync(directory, 0o500);
  t.after(() => { if (existsSync(directory)) chmodSync(directory, 0o700); });
  let queued;
  try { queued = await h.tool("SendMessage", { to: "reviewer", message: "Retain if possible." }); }
  finally { chmodSync(directory, 0o700); }
  assert.equal(queued.details.presentation.acknowledgment, "Message queued.");
  assert.equal(queued.details.presentation.messagePath, undefined);
  assert.match(queued.details.presentation.artifactError, /EACCES|EPERM/);
  assert.ok(h.notices.some(text => text.includes("artifact")));
  (await h.call(0)).finish("first"); (await h.call(1)).finish("second");
  assert.equal((await h.outcome(launched.details.runId)).details.status, "succeeded");
});
