import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BackendError } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { RelayBackend, desktopScaleOf, readProgram, stdioRelayConnect, type CheckResult, type RelayConnection } from "../../extensions/secretary/computer-use/backend/relay-client.ts";

/** Plan Phase 7: the relay client's contract with an mcp-vm-relay server (design §11.2). */

const server = resolve(import.meta.dirname, "support/scripted-relay-server.ts");
/** The relay 0.6 tools that perform a recorded run in the guest. */
const RUN_TOOLS = new Set(["relay_exec", "relay_code", "relay_run"]);

/**
 * A fake guest cua-driver. Its window tree is larger than the guest's 64 KiB output cap, as one
 * Finder read was (research §14.5), and its screenshot is 800 pixels wide for a 400-point window.
 * Its display is 1,600 pixels wide under an 800-point menu bar.
 */
const FAKE_DRIVER = `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const [, , , tool, , json] = process.argv;
const args = JSON.parse(json);
require("node:fs").appendFileSync(process.env.SCRIPTED_DRIVER_LOG, tool + (args.screenshot_out_file ? " with screenshot" : "") + "\\n");
const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1"); return Buffer.concat([head, data, Buffer.alloc(4)]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(tool === "get_desktop_state" ? 1600 : 800, 0); ihdr.writeUInt32BE(600, 4);
// Like a macOS window screenshot, it carries a compressed colour profile.
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("iCCP", Buffer.from("profile")), chunk("IDAT", Buffer.from("pixels")), chunk("IEND", Buffer.alloc(0))]);
if (args.screenshot_out_file) writeFileSync(args.screenshot_out_file, png);
const out = tool === "list_windows" ? { windows: [{ window_id: 5, pid: 7, app_name: "Finder", title: "Documents", is_on_screen: true, z_index: 1, bounds: { x: 100, y: 50, width: 400, height: 300 } }] }
  : tool === "get_window_state" ? { snapshot_id: "s", element_count: 400, elements: [{ element_index: 0, role: "AXWindow", label: "Documents", depth: 0, frame: { x: 100, y: 50, w: 400, h: 300 } },
    { element_index: 1, role: "AXMenuBar", depth: 0, frame: { x: 0, y: 0, w: 800, h: 24 } },
    ...Array.from({ length: 398 }, (_, i) => ({ element_index: i + 2, role: "AXCell", label: "Quarterly report draft number " + i + " with a long descriptive name", parent_index: 0, depth: 1, frame: { x: 110, y: 60 + i, w: 300, h: 20 } }))] }
  : tool === "click" || tool === "scroll" ? { ok: true, path: "cgevent_hid" }
  : { ok: true };
process.stdout.write(JSON.stringify(out));
`;

async function scripted(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "secretary-relay-client-"));
  const driver = join(root, "cua-driver");
  await writeFile(driver, FAKE_DRIVER);
  await chmod(driver, 0o755);
  const lsappinfo = join(root, "lsappinfo");
  await writeFile(lsappinfo, `#!/bin/sh\ncase "$1" in front) echo "ASN:0x0-0x7:" ;; *) echo '"pid"=7' ;; esac\n`);
  await chmod(lsappinfo, 0o755);
  const log = join(root, "calls.jsonl");
  await writeFile(log, "");
  process.env.SCRIPTED_RELAY_WORKSPACE = join(root, "workspace");
  process.env.SCRIPTED_RELAY_LOG = log;
  process.env.SCRIPTED_RELAY_DRIVER = driver;
  process.env.SCRIPTED_DRIVER_LOG = join(root, "driver.log");
  process.env.SCRIPTED_RELAY_PID_FILE = join(root, "server.pid");
  t.after(() => { for (const name of ["SCRIPTED_RELAY_WORKSPACE", "SCRIPTED_RELAY_LOG", "SCRIPTED_RELAY_DRIVER", "SCRIPTED_DRIVER_LOG", "SCRIPTED_RELAY_PID_FILE"]) delete process.env[name]; });
  const backend = new RelayBackend({ connect: stdioRelayConnect({ command: [process.execPath, "--experimental-strip-types", "--no-warnings", server], cwd: root }),
    image: "macos26", env: "default", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: true, actionIntervalMs: 300, guestLsappinfo: lsappinfo });
  // A failed assertion must not leave the server running, or the test process never exits.
  t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
  const driverCalls = async () => (await readFile(join(root, "driver.log"), "utf8")).trim().split("\n");
  return { backend, calls, root, driverCalls };
}

test("relay steps carry the plan step's label, and reads and actions return their relay step identifiers and input path", async t => {
  const { backend, calls } = await scripted(t);
  const read = await backend.readWindow({ app: "Finder" }, { screenshot: false, label: "run-1 open: initial" });
  const click = await backend.act(read.window, { kind: "click", point: { x: 150, y: 70 }, button: "left", count: 1, label: 'run-1 open: click "Agenda.txt"' });
  assert.deepEqual([read.evidence, click.evidence, click.path], [["cu-0001"], ["cu-0002", "cu-0003"], "cgevent_hid"], "The click's evidence includes bringing the window to the front");
  const runs = (await calls()).filter(call => RUN_TOOLS.has(call.relayTool));
  assert.equal(runs[0]!.step.title, "run-1 open: initial · Read the Finder window");
  assert.equal(runs[2]!.reason, 'Secretary computer use: run-1 open: click "Agenda.txt" · Input with click (cu-0003)');
  const unlabelled = await backend.readWindow({ app: "Finder" }, { screenshot: false });
  assert.deepEqual(unlabelled.evidence, ["cu-0004"]);
  assert.equal((await calls()).filter(call => RUN_TOOLS.has(call.relayTool)).at(-1)!.step.title, "Read the Finder window", "The label ends with its read");
});

test("a relay read is one code run that passes the 64 KiB cap, plus the screenshot original", async t => {
  const { backend, calls, root, driverCalls } = await scripted(t);
  const read = await backend.readWindow({ app: "Finder", windowTitle: "Documents" }, { screenshot: true });
  assert.equal(read.window.windowId, 5);
  assert.equal(read.elements.length, 400, "The whole tree arrived although its JSON is larger than 64 KiB");
  assert.ok(JSON.stringify(read.elements).length > 64 * 1024);
  assert.equal(read.appActive, true, "The active application came from lsappinfo in the guest");
  const screenshot = Buffer.from(read.screenshot!.data, "base64");
  assert.equal(screenshot.readUInt32BE(16), 800, "The screenshot keeps its full width");
  assert.ok(!screenshot.includes("iCCP") && screenshot.includes("IDAT"), "The guest program removed the colour profile the relay refuses");

  const log = await calls();
  assert.deepEqual(log.slice(0, 2).map(call => call.relayTool), ["relay_acquire", "relay_stage"]);
  assert.deepEqual(log[0]!.extractions, [{ path: "computer-use-screenshots", name: "computer-use-screenshots" }]);
  assert.equal(log[0]!.image, "macos26");
  assert.equal(log[0]!.env, "default");
  assert.match(log[0]!.session, /^secretary-computer-use-/, "The client runs its own relay session, apart from the parent's");
  assert.equal(log[0]!.project, root);
  const runs = log.filter(call => RUN_TOOLS.has(call.relayTool));
  assert.deepEqual(runs.map(call => call.relayTool), ["relay_code"], "One run lists the windows, reads the active application, warms up, reads and measures the scale");
  assert.equal(runs[0]!.step.inputMode, "ordinary");
  assert.equal(runs[0]!.snapshots.afterIntervalMs, 0, "A read waits for nothing");
  assert.equal(runs[0]!.step.id, "cu-0001");
  const image = log.find(call => call.relayTool === "relay_image")!;
  assert.deepEqual(image.target, { source: "application", name: "computer-use-screenshots", path: "read-0001.png" });
  await backend.readWindow({ app: "Finder", windowTitle: "Documents" }, { screenshot: false });
  assert.equal((await calls()).filter(call => call.relayTool === "relay_image").length, 1, "A read without a screenshot fetches no image");
  assert.deepEqual(await driverCalls(), ["list_windows", "get_window_state", "get_window_state with screenshot", "get_desktop_state with screenshot", "list_windows", "get_window_state with screenshot"],
    "Only the first read of a window makes the warm-up read, and only the first read of a lease measures the display");
  await assert.rejects(backend.readWindow({ app: "Safari" }, { screenshot: false }),
    (error: unknown) => error instanceof BackendError && error.code === "app_not_running", "The guest chose the window with the client's own rules");
  const server = Number(await readFile(join(root, "server.pid"), "utf8"));
  await backend.close();
  assert.equal((await calls()).at(-1)!.relayTool, "relay_finish", "Closing delivers the evidence and releases the machine");
  const alive = () => { try { process.kill(server, 0); return true; } catch { return false; } };
  for (const deadline = Date.now() + 5000; alive() && Date.now() < deadline;) await new Promise(done => setTimeout(done, 50));
  assert.equal(alive(), false, "Closing ends the relay server process");
});

test("a relay click brings the window to the front and clicks in screen coordinates at the display's learned scale", async t => {
  const { backend, calls } = await scripted(t);
  const read = await backend.readWindow({ app: "Finder" }, { screenshot: true });
  await backend.act(read.window, { kind: "click", point: { x: 150, y: 70 }, button: "left", count: 1 });
  await backend.act(read.window, { kind: "click", point: { x: 150, y: 70 }, button: "right", count: 1 });
  await backend.act(read.window, { kind: "click", point: { x: 150, y: 70 }, button: "left", count: 2 });
  await backend.act(read.window, { kind: "scroll", point: { x: 300, y: 200 }, direction: "down", by: "page", extent: 250 });
  const runs = (await calls()).filter(call => RUN_TOOLS.has(call.relayTool));
  assert.deepEqual(runs.map(call => call.relayTool === "relay_run" ? call.tool : call.relayTool),
    ["relay_code", "bring_to_front", "click", "bring_to_front", "click", "bring_to_front", "click", "bring_to_front", "scroll"], "No read of bounds or scale before an action");
  const pointer = runs.filter(call => call.tool === "click" || call.tool === "scroll").map(call => call.args);
  assert.deepEqual(pointer, [
    { scope: "desktop", x: 300, y: 140 },
    { scope: "desktop", x: 300, y: 140, button: "right" },
    { scope: "desktop", x: 300, y: 140, count: 2 },
    { scope: "desktop", x: 600, y: 400, direction: "down", by: "page", amount: 2 },
  ], "Points become desktop pixels at 1,600 pixels over an 800-point menu bar, with no window or accessibility element");
  assert.deepEqual(runs[1]!.args, { pid: 7, window_id: 5 });
  assert.equal(runs[2]!.afterIntervalMs, 300);
  assert.match(runs[2]!.reason, /^Secretary computer use: Input with click \(cu-0003\)$/);
});

test("the desktop scale comes from the widest menu bar and is ignored outside 1 to 4", () => {
  const bar = (w: number) => ({ element_index: w, role: "AXMenuBar", depth: 0, frame: { x: 0, y: 0, w, h: 24 } });
  assert.equal(desktopScaleOf(2560, [bar(300), bar(1280)]), 2);
  assert.equal(desktopScaleOf(2560, []), undefined);
  assert.equal(desktopScaleOf(2560, [bar(300)]), undefined);
});

test("the read program prints the driver's output compressed", () => {
  const program = readProgram("get_window_state", { pid: 1, screenshot_out_file: "computer-use-screenshots/0001-window.png" });
  assert.match(program, /gzipSync\(stdout\)/);
  assert.match(program, /process\.env\.RELAY_CUA_DRIVER/);
});

/** An in-memory relay that answers every run with the given execution. */
function answering(execution: Record<string, unknown>) {
  const inputs: string[] = [];
  const connection: RelayConnection = {
    async call(tool) {
      inputs.push(tool);
      if (!RUN_TOOLS.has(tool)) return { text: "{}", isError: false };
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
  assert.equal(inputs.filter(tool => RUN_TOOLS.has(tool)).length, 1);
});

test("output cut at the relay's cap is state_too_large", async () => {
  // Relay 0.6 reports only the uncertain outcome, without stdout or an outputTruncated field (probed 2026-09-26).
  const { backend } = answering({ outcome: { kind: "uncertain", diagnostic: "execution exceeded output bound" }, timeoutMs: 120000 });
  await assert.rejects(backend.readWindow({ app: "Finder" }, { screenshot: false }),
    (error: unknown) => error instanceof BackendError && error.code === "state_too_large");
});

test("a refused acquisition is reported, and the next call tries again", async () => {
  let attempts = 0;
  const backend = new RelayBackend({ connect: async () => ({ async call(tool) { if (tool === "relay_acquire") attempts++; return { text: "No capacity", isError: true }; }, async close() {} }),
    image: "macos26", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: false, actionIntervalMs: 0 });
  await assert.rejects(backend.readWindow({ app: "Finder" }, { screenshot: false }), /relay_acquire failed: No capacity/);
  await assert.rejects(backend.readWindow({ app: "Finder" }, { screenshot: false }), /relay_acquire failed/);
  assert.equal(attempts, 2);
});

test("a failed finish releases the machine and reports that the package was not delivered", async () => {
  const actions: string[] = [];
  const connection: RelayConnection = {
    async call(tool) {
      actions.push(tool);
      if (tool === "relay_finish") return { text: "Guest setup/transfer command failed (1): extraction exceeds 512MiB / 10000 files", isError: true };
      if (RUN_TOOLS.has(tool)) return { text: `${JSON.stringify({ imageDelivery: { status: "attached" }, executionFailed: false })}\n${JSON.stringify({ outcome: { kind: "completed", exitStatus: { code: 0, signal: null } }, stdout: "" })}`, isError: false };
      return { text: "{}", isError: false };
    },
    async close() { actions.push("closed"); },
  };
  const backend = new RelayBackend({ connect: async () => connection, image: "macos26", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: false, actionIntervalMs: 0 });
  await backend.readWindow({ app: "Finder" }, { screenshot: false }).catch(() => undefined);
  await assert.rejects(backend.close(), /evidence package was not delivered: .*512MiB.*The machine was released\./);
  assert.deepEqual(actions.slice(-3), ["relay_finish", "relay_release", "closed"]);
});

test("checks run on the leased machine before the finish, and a failing check is recorded without stopping the others (evaluation design §3)", async () => {
  const actions: string[] = [];
  const connection: RelayConnection = {
    async call(tool, args) {
      const argv = (args.argv as string[] | undefined)?.join(" ");
      actions.push(RUN_TOOLS.has(tool) && argv ? `${tool} ${argv}` : tool);
      const exit = argv?.includes("fails") ? 1 : 0;
      if (RUN_TOOLS.has(tool)) return { text: `${JSON.stringify({ imageDelivery: { status: "attached" }, executionFailed: exit !== 0 })}\n${JSON.stringify({ outcome: { kind: "completed", exitStatus: { code: exit, signal: null } }, stdout: argv?.includes("passes") ? "True\n" : "" })}`, isError: exit !== 0 };
      return { text: "{}", isError: false };
    },
    async close() { actions.push("closed"); },
  };
  const recorded: CheckResult[][] = [];
  const backend = new RelayBackend({ connect: async () => connection, image: "macos26", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: false, actionIntervalMs: 0,
    check: [["/bin/zsh", "-c", "fails"], ["/bin/zsh", "-c", "passes"]], onCheck: results => { recorded.push(results); } });
  await backend.close();
  assert.deepEqual(actions, [], "A session that never acquired a machine checks nothing");
  await backend.readWindow({ app: "Reminders" }, { screenshot: false }).catch(() => undefined);
  await backend.close();
  assert.deepEqual(actions, ["relay_acquire", "relay_stage", "relay_code", "relay_exec /bin/zsh -c fails", "relay_exec /bin/zsh -c passes", "relay_finish", "closed"]);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0]!.map(result => [result.completed, result.stdout]), [[false, ""], [true, "True\n"]]);
  assert.match(recorded[0]![0]!.error!, /Check: \/bin\/zsh -c fails/);
});

test("preparation runs once after staging, and a failed start releases the machine it acquired", async () => {
  const actions: string[] = [];
  let failPrepare = true;
  const connection: RelayConnection = {
    async call(tool, args) {
      actions.push(RUN_TOOLS.has(tool) ? `${tool} ${(args.argv as string[] | undefined)?.join(" ") ?? ""}`.trim() : tool);
      if (tool === "relay_exec" && failPrepare) {
        failPrepare = false;
        return { text: `${JSON.stringify({ imageDelivery: { status: "attached" }, executionFailed: true })}\n${JSON.stringify({ outcome: { kind: "completed", exitStatus: { code: 1, signal: null } }, stderr: "no such app" })}`, isError: true };
      }
      if (RUN_TOOLS.has(tool)) return { text: `${JSON.stringify({ imageDelivery: { status: "attached" }, executionFailed: false })}\n${JSON.stringify({ outcome: { kind: "completed", exitStatus: { code: 0, signal: null } }, stdout: "" })}`, isError: false };
      return { text: "{}", isError: false };
    },
    async close() { actions.push("closed"); },
  };
  const backend = new RelayBackend({ connect: async () => connection, image: "macos26", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: false, actionIntervalMs: 0,
    prepare: [["/usr/bin/open", "-a", "Calculator"]] });
  await assert.rejects(backend.readWindow({ app: "Calculator" }, { screenshot: false }), /Prepare: \/usr\/bin\/open -a Calculator/);
  assert.deepEqual(actions, ["relay_acquire", "relay_stage", "relay_exec /usr/bin/open -a Calculator", "relay_release", "closed"]);
  actions.length = 0;
  await backend.readWindow({ app: "Calculator" }, { screenshot: false }).catch(() => undefined);
  assert.deepEqual(actions.slice(0, 4), ["relay_acquire", "relay_stage", "relay_exec /usr/bin/open -a Calculator", "relay_code"]);
  await backend.readWindow({ app: "Calculator" }, { screenshot: false }).catch(() => undefined);
  assert.equal(actions.filter(action => action.startsWith("relay_exec")).length, 1, "Preparation runs once per machine");
});

test("a long preparation command is sent with a title the relay accepts", async () => {
  // The relay rejects a step title over 500 characters (observed 2026-09-26 with a Finder fixture command).
  const titles: string[] = [];
  const connection: RelayConnection = {
    async call(tool, args) {
      if (RUN_TOOLS.has(tool)) titles.push((args.step as { title: string }).title, String(args.reason));
      return RUN_TOOLS.has(tool) ? { text: `${JSON.stringify({ imageDelivery: { status: "attached" }, executionFailed: false })}\n${JSON.stringify({ outcome: { kind: "completed", exitStatus: { code: 0, signal: null } }, stdout: "" })}`, isError: false }
        : { text: "{}", isError: false };
    },
    async close() {},
  };
  const long = ["/bin/zsh", "-c", `for f in ${Array.from({ length: 60 }, (_, i) => `"File ${i}"`).join(" ")}; do touch "$f.txt"; done`];
  const backend = new RelayBackend({ connect: async () => connection, image: "macos26", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: false, actionIntervalMs: 0, prepare: [long] });
  await backend.readWindow({ app: "Finder" }, { screenshot: false }).catch(() => undefined);
  assert.ok(`Prepare: ${long.join(" ")}`.length > 500);
  assert.ok(titles[0]!.length <= 200 && titles[0]!.endsWith("…"), "the step title is shortened");
  assert.ok(titles[1]!.length <= 500, "the reason stays within the relay's title limit too");
  await backend.close();
});

test("a cancelled read is not sent again, and closing still finishes the lease", async () => {
  const actions: string[] = [];
  const connection: RelayConnection = {
    async call(tool, _args, { signal }) {
      actions.push(tool);
      if (!RUN_TOOLS.has(tool)) return { text: "{}", isError: false };
      // The run waits until the caller cancels it, as a long relay run would.
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("request cancelled")), { once: true }));
    },
    async close() { actions.push("closed"); },
  };
  const backend = new RelayBackend({ connect: async () => connection, image: "macos26", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: false, actionIntervalMs: 0 });
  const controller = new AbortController();
  const read = backend.readWindow({ app: "Calculator" }, { screenshot: false, signal: controller.signal });
  while (!actions.includes("relay_code")) await new Promise(done => setTimeout(done, 5));
  controller.abort();
  await assert.rejects(read, (error: unknown) => error instanceof BackendError && error.code === "aborted");
  await backend.close();
  assert.deepEqual(actions, ["relay_acquire", "relay_stage", "relay_code", "relay_finish", "closed"], "One run, never repeated, and the lease is finished");
});

test("a cua-driver tool that fails inside a completed relay_run is a backend failure", async t => {
  const calls: string[] = [];
  const connection: RelayConnection = {
    async call(tool) {
      calls.push(tool);
      if (tool === "relay_run") return { text: `${JSON.stringify({ imageDelivery: { status: "attached" } })}\n${JSON.stringify({ outcome: { kind: "completed", exitStatus: { code: 0, signal: null } }, toolOutcome: "tool-error" })}`, isError: false };
      return { text: "{}", isError: false };
    },
    async close() {},
  };
  const backend = new RelayBackend({ connect: async () => connection, image: "macos26", ttlHours: 1, maxTreeNodes: 2000, foregroundDelivery: false, actionIntervalMs: 0 });
  t.after(() => backend.close());
  await assert.rejects(backend.act({ pid: 1, windowId: 5, app: "Finder", title: "Documents" }, { kind: "key", key: "return", modifiers: [] }),
    (error: unknown) => error instanceof BackendError && error.code === "driver_failed" && /cua-driver press_key was tool-error/.test(error.message));
  assert.equal(calls.filter(tool => tool === "relay_run").length, 1, "Not sent again");
});

/** Runs a process that connects to the scripted relay under a shell wrapper, as `npm exec` does, then exits without closing. */
async function exitWithServer(t: TestContext, beforeExit: string) {
  const root = await mkdtemp(join(tmpdir(), "secretary-relay-exit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = join(root, "server.pid");
  const client = join(root, "client.ts");
  const relayClient = resolve(import.meta.dirname, "../../extensions/secretary/computer-use/backend/relay-client.ts");
  const wrapped = `"${process.execPath}" --experimental-strip-types --no-warnings "${server}"; true`;
  await writeFile(client, `import { stdioRelayConnect } from ${JSON.stringify(relayClient)};
const connection = await stdioRelayConnect({ command: ["/bin/sh", "-c", ${JSON.stringify(wrapped)}], cwd: ${JSON.stringify(root)} })();
${beforeExit}
process.stdout.write("connected");
process.exit(143);
`);
  const { execFile } = await import("node:child_process");
  await new Promise<void>((done, fail) => execFile(process.execPath, ["--experimental-strip-types", "--no-warnings", client],
    { env: { ...process.env, SCRIPTED_RELAY_WORKSPACE: join(root, "workspace"), SCRIPTED_RELAY_LOG: join(root, "calls.jsonl"),
      SCRIPTED_RELAY_DRIVER: "/bin/false", SCRIPTED_RELAY_PID_FILE: pidFile, SCRIPTED_RELAY_OUTLIVE_INPUT: "1", SCRIPTED_RELAY_FINISH_MS: "3000" } },
    (error, stdout) => (stdout.includes("connected") ? done() : fail(error ?? new Error(stdout)))));
  const serverPid = Number(await readFile(pidFile, "utf8"));
  const alive = () => { try { process.kill(serverPid, 0); return true; } catch { return false; } };
  t.after(() => { if (alive()) process.kill(serverPid, "SIGKILL"); });
  return alive;
}

test("a relay server that never got a finish stops when the process exits", async t => {
  // On 2026-09-26, Pi exited during a child run, and the relay server under `npm exec` kept renewing its lease for over an hour.
  const alive = await exitWithServer(t, "");
  for (let waited = 0; alive() && waited < 5000; waited += 100) await new Promise(done => setTimeout(done, 100));
  assert.equal(alive(), false, "The server under the wrapper was stopped");
});

test("a relay server that is finishing its lease is left to deliver the evidence after the process exits", async t => {
  const alive = await exitWithServer(t, `connection.call("relay_finish", {}, { timeoutMs: 60000 }).catch(() => {});
await new Promise(done => setTimeout(done, 500));`);
  await new Promise(done => setTimeout(done, 1000));
  assert.equal(alive(), true, "A finish in progress is not cut off");
});
