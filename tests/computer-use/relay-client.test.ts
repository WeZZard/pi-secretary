import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BackendError } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { RelayBackend, readProgram, stdioRelayConnect, type RelayConnection } from "../../extensions/secretary/computer-use/backend/relay-client.ts";

/** Plan Phase 7: the relay client's contract with an mcp-vm-relay server (design §11.2). */

const server = resolve(import.meta.dirname, "support/scripted-relay-server.ts");

/**
 * A fake guest cua-driver. Its window tree is larger than the guest's 64 KiB output cap, as one
 * Finder read was (research §14.5), and its screenshot is 800 pixels wide for a 400-point window.
 */
const FAKE_DRIVER = `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const [, , , tool, , json] = process.argv;
const args = JSON.parse(json);
const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1"); return Buffer.concat([head, data, Buffer.alloc(4)]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(800, 0); ihdr.writeUInt32BE(600, 4);
// Like a macOS window screenshot, it carries a compressed colour profile.
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("iCCP", Buffer.from("profile")), chunk("IDAT", Buffer.from("pixels")), chunk("IEND", Buffer.alloc(0))]);
if (args.screenshot_out_file) writeFileSync(args.screenshot_out_file, png);
const out = tool === "list_windows" ? { windows: [{ window_id: 5, pid: 7, app_name: "Finder", title: "Documents", is_on_screen: true, z_index: 1, bounds: { x: 100, y: 50, width: 400, height: 300 } }] }
  : tool === "get_window_state" ? { snapshot_id: "s", element_count: 400, elements: [{ element_index: 0, role: "AXWindow", label: "Documents", depth: 0, frame: { x: 100, y: 50, w: 400, h: 300 } },
    ...Array.from({ length: 399 }, (_, i) => ({ element_index: i + 1, role: "AXCell", label: "Quarterly report draft number " + i + " with a long descriptive name", parent_index: 0, depth: 1, frame: { x: 110, y: 60 + i, w: 300, h: 20 } }))] }
  : { ok: true };
process.stdout.write(JSON.stringify(out));
`;

async function scripted(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "secretary-relay-client-"));
  const driver = join(root, "cua-driver");
  await writeFile(driver, FAKE_DRIVER);
  await chmod(driver, 0o755);
  const log = join(root, "calls.jsonl");
  await writeFile(log, "");
  process.env.SCRIPTED_RELAY_WORKSPACE = join(root, "workspace");
  process.env.SCRIPTED_RELAY_LOG = log;
  process.env.SCRIPTED_RELAY_DRIVER = driver;
  t.after(() => { delete process.env.SCRIPTED_RELAY_WORKSPACE; delete process.env.SCRIPTED_RELAY_LOG; delete process.env.SCRIPTED_RELAY_DRIVER; });
  const backend = new RelayBackend({ connect: stdioRelayConnect({ command: [process.execPath, "--experimental-strip-types", "--no-warnings", server], cwd: root }),
    image: "macos26", env: "default", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: true, actionIntervalMs: 300 });
  // A failed assertion must not leave the server running, or the test process never exits.
  t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
  return { backend, calls, root };
}

test("a relay read acquires once, reads with code runs that pass the 64 KiB cap, and fetches the screenshot original", async t => {
  const { backend, calls, root } = await scripted(t);
  const read = await backend.readWindow({ app: "Finder", windowTitle: "Documents" }, { screenshot: true });
  assert.equal(read.window.windowId, 5);
  assert.equal(read.elements.length, 400, "The whole tree arrived although its JSON is larger than 64 KiB");
  assert.ok(JSON.stringify(read.elements).length > 64 * 1024);
  assert.equal(read.appActive, true, "The active application came from lsappinfo in the guest");
  const screenshot = Buffer.from(read.screenshot!.data, "base64");
  assert.equal(screenshot.readUInt32BE(16), 800, "The screenshot keeps its full width");
  assert.ok(!screenshot.includes("iCCP") && screenshot.includes("IDAT"), "The guest program removed the colour profile the relay refuses");

  const log = await calls();
  assert.deepEqual(log.slice(0, 2).map(call => call.action), ["acquire", "stage"]);
  assert.deepEqual(log[0]!.extractions, [{ path: "computer-use-screenshots", name: "computer-use-screenshots" }]);
  assert.equal(log[0]!.image, "macos26");
  assert.equal(log[0]!.env, "default");
  assert.match(log[0]!.session, /^secretary-computer-use-/, "The client runs its own relay session, apart from the parent's");
  assert.equal(log[0]!.project, root);
  const runs = log.filter(call => call.action === "run");
  assert.deepEqual(runs.map(call => call.kind), ["code", "exec", "code", "code", "code"], "list_windows, lsappinfo, warm-up, read, and the bounds for the scale");
  for (const run of runs) {
    assert.equal(run.step.inputMode, "ordinary");
    assert.equal(run.snapshots.afterIntervalMs, 0, "A read waits for nothing");
  }
  assert.deepEqual(runs.map(run => run.step.id), ["cu-0001", "cu-0002", "cu-0003", "cu-0004", "cu-0005"]);
  const image = log.find(call => call.action === "image")!;
  assert.deepEqual(image.target, { source: "application", name: "computer-use-screenshots", path: "0001-window.png" });
  await backend.close();
  assert.equal((await calls()).at(-1)!.action, "finish", "Closing delivers the evidence and releases the machine");
});

test("a relay click is one cua run of real pointer input at window pixels", async t => {
  const { backend, calls } = await scripted(t);
  const read = await backend.readWindow({ app: "Finder" }, { screenshot: true });
  await backend.act(read.window, { kind: "click", point: { x: 150, y: 70 }, button: "left", count: 1 });
  const cua = (await calls()).filter(call => call.kind === "cua");
  assert.equal(cua.length, 1);
  assert.equal(cua[0]!.tool, "click");
  assert.deepEqual({ x: cua[0]!.args.x, y: cua[0]!.args.y, delivery: cua[0]!.args.delivery_mode }, { x: 100, y: 40, delivery: "foreground" }, "Points become pixels at the learned scale of 2");
  assert.equal(cua[0]!.args.element_index, undefined, "No accessibility activation");
  assert.equal(cua[0]!.snapshots.afterIntervalMs, 300);
});

test("the read program prints the driver's output compressed", () => {
  const program = readProgram("get_window_state", { pid: 1, screenshot_out_file: "computer-use-screenshots/0001-window.png" });
  assert.match(program, /gzipSync\(stdout\)/);
  assert.match(program, /process\.env\.RELAY_CUA_DRIVER/);
});

/** An in-memory relay that answers every run with the given execution. */
function answering(execution: Record<string, unknown>) {
  const inputs: Record<string, any>[] = [];
  const connection: RelayConnection = {
    async call(input) {
      inputs.push(input);
      if (input.action !== "run") return { text: "{}", isError: false };
      return { text: `${JSON.stringify({ imageDelivery: { status: "attached" }, executionFailed: true })}\n${JSON.stringify(execution)}`, isError: true };
    },
    async close() {},
  };
  const backend = new RelayBackend({ connect: async () => connection, image: "macos26", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: false, actionIntervalMs: 0 });
  return { backend, inputs };
}

test("an uncertain relay outcome is a backend failure and is not sent again", async () => {
  const { backend, inputs } = answering({ outcome: { kind: "uncertain", diagnostic: "receiver error" } });
  await assert.rejects(backend.readWindow({ app: "Finder" }, { screenshot: false }),
    (error: unknown) => error instanceof BackendError && error.code === "driver_failed" && /uncertain: receiver error/.test(error.message));
  assert.equal(inputs.filter(input => input.action === "run").length, 1);
});

test("output cut at the relay's cap is state_too_large", async () => {
  const { backend } = answering({ outcome: { kind: "uncertain", diagnostic: "execution exceeded output bound" }, stdout: "x", outputTruncated: true });
  await assert.rejects(backend.readWindow({ app: "Finder" }, { screenshot: false }),
    (error: unknown) => error instanceof BackendError && error.code === "state_too_large");
});

test("a refused acquisition is reported, and the next call tries again", async () => {
  let attempts = 0;
  const backend = new RelayBackend({ connect: async () => ({ async call(input) { if (input.action === "acquire") attempts++; return { text: "No capacity", isError: true }; }, async close() {} }),
    image: "macos26", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: false, actionIntervalMs: 0 });
  await assert.rejects(backend.readWindow({ app: "Finder" }, { screenshot: false }), /relay acquire failed: No capacity/);
  await assert.rejects(backend.readWindow({ app: "Finder" }, { screenshot: false }), /relay acquire failed/);
  assert.equal(attempts, 2);
});
