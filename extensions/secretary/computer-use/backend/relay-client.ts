import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BackendError, type ActionOutcome, type BackendAction, type ExecutionBackend, type ForegroundState, type Point, type ReadOptions, type WindowRead, type WindowRef, type WindowTarget } from "./backend.ts";
import { LocalDriverBackend, selectWindow, toWindowRead, windowRef, type DriverRunner, type FrontmostPid, type ListedWindow, type ScreenshotFiles, type WindowBounds, type WindowState } from "./local-backend.ts";

/**
 * The relay client (design docs/arch/computer-use.md §11.2). It sends the harness's reads and
 * actions to an mcp-vm-relay server of its own, which performs them in a disposable virtual
 * machine with a driver of its choosing. It reuses the local driver backend and replaces only the
 * driver calls, the active-application source and the screenshot files.
 */

/**
 * One call of a relay tool, such as `relay_code` (mcp-vm-relay 0.6): the first text block, which
 * holds the relay's record, and whether the server marked the call an error. A `relay_run` result
 * has a second text block with the target tool's own text, which the client does not need.
 */
export interface RelayConnection {
  call(tool: string, args: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}
export type RelayConnect = () => Promise<RelayConnection>;

/**
 * Starts one mcp-vm-relay server over standard input and output. The fresh session identifier
 * keeps this lease apart from the relay session of the parent's conversation.
 */
export function stdioRelayConnect(options: { command: string[]; cwd: string }): RelayConnect {
  return async () => {
    const [command, ...args] = options.command;
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({ command: command!, args, cwd: options.cwd, stderr: "ignore",
      env: { ...env, MCP_VM_RELAY_SESSION: `secretary-computer-use-${randomUUID()}`, MCP_VM_RELAY_PROJECT: options.cwd } });
    const client = new Client({ name: "secretary-computer-use", version: "1.0.0" });
    // A first start may download the package, so it gets longer than a request.
    await client.connect(transport, { timeout: 5 * 60_000 });
    const pid = transport.pid;
    const server = { ending: false };
    if (pid !== null) liveServers.set(pid, server);
    installExitHook();
    return {
      async call(tool, args, { timeoutMs, signal }) {
        if (tool === "relay_finish" || tool === "relay_release") server.ending = true;
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs, signal });
        const blocks = (result.content ?? []) as { type: string; text?: string }[];
        return { text: blocks.find(block => block.type === "text")?.text ?? "", isError: result.isError === true };
      },
      close: async () => { try { await client.close(); } finally { if (pid !== null) liveServers.delete(pid); } },
    };
  };
}

/**
 * Relay servers still running when the process exits (design §11.2), with whether a finish or a
 * release was sent. A child run's shutdown handlers get 5 s and `relay_finish` takes about a
 * minute, so a server that is ending its lease is left to complete it after Pi exits, which
 * delivers the evidence. A server that never got a finish, because Pi exited during a child run,
 * kept renewing its lease for over an hour on 2026-09-26. Such a server and the `npm exec`
 * wrapper's children are stopped, so the lease's own time limit ends the machine.
 */
const liveServers = new Map<number, { ending: boolean }>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const [pid, server] of liveServers) {
      if (server.ending) continue;
      spawnSync("/usr/bin/pkill", ["-TERM", "-P", String(pid)]);
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  });
}

/** The declared extraction that receives window screenshots; the relay delivers it with the evidence. */
export const SCREENSHOT_EXTRACTION = "computer-use-screenshots";
/** Driver tools that only read. Their output can pass the guest's 64 KiB cap, so they run as code. */
const READ_TOOLS = new Set(["list_windows", "list_apps", "get_window_state", "get_screen_size"]);
/** Time the relay may add to a run for its screenshots and transfers, beyond the run's own limit. */
const RELAY_OVERHEAD_MS = 120_000;

export interface RelayExecution {
  outcome: { kind: string; exitStatus?: { code: number | null; signal: string | null }; diagnostic?: string };
  stdout?: string;
  stderr?: string;
  outputTruncated?: boolean;
  /** `relay_run` only: whether the target tool itself completed, and its structured result. */
  toolOutcome?: string;
  structuredContent?: unknown;
}

/** Step titles are shortened to this length; the relay accepts at most 500 characters. */
const TITLE_LIMIT = 200;
interface RunInput { kind: "exec" | "code" | "cua"; title: string; expected: string; afterIntervalMs: number; timeoutMs: number; body: Record<string, unknown> }

/**
 * Parses a relay result. A run's text is a line of delivery facts and then the execution as
 * JSON; a result above 50 KiB is cut short and kept whole in a file on this machine.
 */
async function resultBody(text: string): Promise<unknown> {
  const newline = text.indexOf("\n");
  let body = newline >= 0 && text.startsWith("{\"imageDelivery\"") ? text.slice(newline + 1) : text;
  const kept = /\n\[Truncated\. Full result: (.+)\]$/.exec(body);
  if (kept) body = await readFile(kept[1]!, "utf8");
  return JSON.parse(body);
}

/** The lease, from acquisition on first use to `finish` on close. */
export class RelaySession {
  readonly #connect: RelayConnect;
  readonly #acquire: Record<string, unknown>;
  readonly #prepare: string[][];
  #ready?: Promise<RelayConnection>;
  #sequence = 0;
  #label?: string;
  #issued: string[] = [];
  constructor(connect: RelayConnect, acquire: { image: string; env?: string; ttlHours: number; prepare?: string[][] }) {
    this.#connect = connect;
    this.#prepare = acquire.prepare ?? [];
    this.#acquire = { task: "computer-use", image: acquire.image, extractions: [{ path: SCREENSHOT_EXTRACTION, name: SCREENSHOT_EXTRACTION }],
      ttlHours: acquire.ttlHours, ...(acquire.env ? { env: acquire.env } : {}) };
  }

  async #call(connection: RelayConnection, tool: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
    try { return await connection.call(tool, args, { timeoutMs, signal }); }
    catch (error) {
      if (signal?.aborted) throw new BackendError("aborted", `${tool} was cancelled`);
      throw new BackendError("driver_failed", `${tool} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #connection(signal?: AbortSignal): Promise<RelayConnection> {
    if (this.#ready) return this.#ready;
    const ready = (async () => {
      const connection = await this.#connect();
      let acquired = false;
      try {
        for (const [tool, args] of [["relay_acquire", this.#acquire], ["relay_stage", {}]] as const) {
          const result = await this.#call(connection, tool, args, 15 * 60_000, signal);
          if (result.isError) throw new BackendError("driver_failed", `${tool} failed: ${result.text.slice(0, 500)}`);
          acquired = true;
        }
        // Configured preparation, such as opening the application a task needs, runs once after staging.
        for (const argv of this.#prepare) {
          await this.#runOn(connection, { kind: "exec", title: `Prepare: ${argv.join(" ")}`, expected: "The machine is ready for the task",
            afterIntervalMs: 2000, timeoutMs: 120_000, body: { argv } }, signal);
        }
        return connection;
      } catch (error) {
        // The next attempt starts a new server, which would acquire a second machine; this one is released.
        if (acquired) await connection.call("relay_release", {}, { timeoutMs: 5 * 60_000 }).catch(() => undefined);
        await connection.close().catch(() => undefined);
        throw error;
      }
    })();
    this.#ready = ready;
    // A failed start is not cached: the next call tries again.
    ready.catch(() => { if (this.#ready === ready) this.#ready = undefined; });
    return ready;
  }

  /**
   * Runs `work` with `label` in the title of every relay step it makes, and returns the steps'
   * identifiers, so the step records and the relay's evidence join by identifier (design §11.2).
   * Reads and actions are sequential, so one label is active at a time.
   */
  async labelled<T>(label: string | undefined, work: () => Promise<T>): Promise<{ value: T; evidence: string[] }> {
    this.#label = label;
    this.#issued = [];
    try { const value = await work(); return { value, evidence: [...this.#issued] }; }
    finally { this.#label = undefined; }
  }

  /**
   * One relay run. An outcome other than a clean exit is `driver_failed` and is never repeated,
   * because the input may have reached the machine (design §11.2).
   */
  async run(input: RunInput, signal?: AbortSignal): Promise<RelayExecution> {
    return this.#runOn(await this.#connection(signal), input, signal);
  }

  async #runOn(connection: RelayConnection, input: RunInput, signal?: AbortSignal): Promise<RelayExecution> {
    const id = `cu-${String(++this.#sequence).padStart(4, "0")}`;
    this.#issued.push(id);
    // The relay rejects a step title over 500 characters with a generic input error; a Finder
    // preparation command that wrote 40 fixture files was 740 characters (observed 2026-09-26).
    const full = this.#label ? `${this.#label} · ${input.title}` : input.title;
    const title = full.length > TITLE_LIMIT ? `${full.slice(0, TITLE_LIMIT - 1)}…` : full;
    const reason = `Secretary computer use: ${title} (${id})`;
    // A command or program run records the client's step; a driver tool call sends the call to the
    // relay's own cua-driver server in the guest, which takes a reason but no step record.
    const [tool, args] = input.kind === "cua"
      ? ["relay_run", { target: "cua", tool: input.body.tool, args: input.body.args, reason, expected: input.expected, afterIntervalMs: input.afterIntervalMs, timeoutMs: input.timeoutMs }]
      : [input.kind === "exec" ? "relay_exec" : "relay_code", { reason, step: { id, title, expected: input.expected, inputMode: "ordinary" },
        snapshots: { afterIntervalMs: input.afterIntervalMs }, timeoutMs: input.timeoutMs, ...input.body }];
    const result = await this.#call(connection, tool, args, input.timeoutMs + RELAY_OVERHEAD_MS, signal);
    let execution: RelayExecution | undefined;
    try { execution = await resultBody(result.text) as RelayExecution; }
    catch { execution = undefined; }
    if (!execution?.outcome) throw new BackendError("driver_failed", `${tool} ${id} failed: ${result.text.slice(0, 500)}`);
    const { outcome } = execution;
    // The guest caps a run's output at 64 KiB; relay 0.6 reports it as an uncertain outcome (probed 2026-09-26).
    if (execution.outputTruncated || /output bound/.test(outcome.diagnostic ?? "")) throw new BackendError("state_too_large", `${input.title}: the output passed the relay's 64 KiB limit`);
    if (outcome.kind !== "completed" || outcome.exitStatus?.code !== 0) {
      const detail = outcome.kind === "completed" ? `exit ${outcome.exitStatus?.code ?? outcome.exitStatus?.signal}: ${(execution.stderr ?? "").trim().slice(0, 400)}` : outcome.diagnostic ?? "";
      throw new BackendError("driver_failed", `${tool} ${id} (${input.title}) was ${outcome.kind}: ${detail}`.trim());
    }
    if (input.kind === "cua" && execution.toolOutcome !== undefined && execution.toolOutcome !== "completed") {
      throw new BackendError("driver_failed", `${tool} ${id} (${input.title}): cua-driver ${String(input.body.tool)} was ${execution.toolOutcome}`);
    }
    return execution;
  }

  /** The untouched original of an image in the screenshot extraction, read from this machine. */
  async screenshot(path: string, signal?: AbortSignal): Promise<Buffer> {
    const connection = await this.#connection(signal);
    const result = await this.#call(connection, "relay_image", { target: { source: "application", name: SCREENSHOT_EXTRACTION, path } }, 120_000, signal);
    const facts = JSON.parse(result.text.split("\n")[0]!) as { imageDelivery?: { status?: string; image?: { originalPath?: string }; diagnostic?: string } };
    const original = facts.imageDelivery?.image?.originalPath;
    if (facts.imageDelivery?.status !== "attached" || !original) {
      throw new BackendError("driver_failed", `relay image ${path}: ${facts.imageDelivery?.status ?? "no delivery"} ${facts.imageDelivery?.diagnostic ?? ""}`.trim());
    }
    return readFile(original);
  }

  /**
   * Delivers the evidence package and releases the machine. A failed `finish` keeps the lease, so
   * the client then releases it without the package. With relay 0.4, `finish` pulled the whole
   * guest recording in one transfer capped at 512 MiB, and two display screenshots per run passed
   * that cap in a 40-run check (research §15). The failure is still reported.
   */
  async close(): Promise<void> {
    const ready = this.#ready;
    this.#ready = undefined;
    if (!ready) return;
    const connection = await ready.catch(() => undefined);
    if (!connection) return;
    try {
      const finished = await this.#call(connection, "relay_finish", {}, 15 * 60_000);
      if (!finished.isError) return;
      const released = await this.#call(connection, "relay_release", {}, 5 * 60_000);
      throw new BackendError("driver_failed", `relay finish failed, so the evidence package was not delivered: ${finished.text.slice(0, 300)}. `
        + (released.isError ? `Release also failed, and the machine remains until its lease expires: ${released.text.slice(0, 300)}` : "The machine was released."));
    } finally {
      await connection.close();
    }
  }
}

/**
 * The guest program for a read: it calls the driver the relay staged and prints the result as
 * gzip-compressed, base64-encoded JSON, because one Finder read was 66,253 bytes (research §14.5).
 * It also removes the ancillary chunks of a screenshot that the relay's `image` action refuses.
 */
export function readProgram(tool: string, args: Record<string, unknown>): string {
  return `(async () => {
  const { execFile } = await import("node:child_process");
  const { gzipSync } = await import("node:zlib");
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  ${stripPngMetadata.toString()}
  const { dirname, resolve } = await import("node:path");
  const args = ${JSON.stringify(args)};
  if (typeof args.screenshot_out_file === "string") {
    args.screenshot_out_file = resolve(args.screenshot_out_file);
    mkdirSync(dirname(args.screenshot_out_file), { recursive: true });
  }
  execFile(process.env.RELAY_CUA_DRIVER || "cua-driver", ["call", ${JSON.stringify(tool)}, "--json", JSON.stringify(args)], { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) { process.stderr.write(String(stderr || error.message).slice(0, 2000)); process.exit(1); }
    if (typeof args.screenshot_out_file === "string" && existsSync(args.screenshot_out_file)) {
      writeFileSync(args.screenshot_out_file, stripPngMetadata(readFileSync(args.screenshot_out_file)));
    }
    process.stdout.write(JSON.stringify({ gz: gzipSync(stdout).toString("base64") }));
  });
})().catch(error => { process.stderr.write(String(error)); process.exit(1); });
`;
}

/**
 * Removes a PNG's compressed metadata chunks and the chunks that describe them. The relay refuses
 * to present a PNG with iCCP, zTXt or iTXt, and every macOS window screenshot carries iCCP and iTXt
 * (observed 2026-09-24). eXIf and Apple's iDOT go too; iDOT holds byte offsets that removing
 * earlier chunks would make wrong. All are ancillary, so the picture itself is unchanged.
 * It is serialized into the guest program, so it uses nothing from its module.
 */
export function stripPngMetadata(png: Buffer): Buffer {
  const dropped = ["iCCP", "zTXt", "iTXt", "eXIf", "iDOT"];
  if (png.length < 8) return png;
  const kept = [png.subarray(0, 8)];
  for (let at = 8; at + 12 <= png.length;) {
    const end = at + 12 + png.readUInt32BE(at);
    if (end > png.length) return png;
    if (!dropped.includes(png.toString("latin1", at + 4, at + 8))) kept.push(png.subarray(at, end));
    at = end;
  }
  return Buffer.concat(kept);
}

/** Decodes the gzip-compressed, base64-encoded JSON a guest program printed. */
function decoded(execution: RelayExecution, what: string): unknown {
  try { return JSON.parse(gunzipSync(Buffer.from((JSON.parse(execution.stdout ?? "") as { gz: string }).gz, "base64")).toString("utf8")); }
  catch { throw new BackendError("driver_failed", `${what} returned output that is not JSON`); }
}

interface WindowReadInput { target: WindowTarget; maxTreeNodes: number; warmed: string[]; screenshotPath: string; lsappinfo: string }
interface GuestWindowRead {
  error?: { code: "app_not_running" | "window_not_found" | "window_ambiguous"; message: string };
  window: ListedWindow; frontPid: number | null; listedActive: boolean | null; state: WindowState; pngWidth: number | null;
}

/**
 * The guest program for one whole window read, as one relay run (design §11.2). It lists the
 * windows, chooses the target with the client's own `selectWindow`, reads the active application,
 * makes the warm-up read of a window it has not read before, reads the tree with a screenshot, and
 * measures the screenshot's width for the scale. The first relay client made three relay runs for
 * this and took a median of 22,891 ms per read (research §15).
 */
export function windowReadProgram(input: WindowReadInput): string {
  return `(async () => {
  const { execFileSync } = await import("node:child_process");
  const { gzipSync } = await import("node:zlib");
  const fs = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  ${selectWindow.toString()}
  ${stripPngMetadata.toString()}
  const input = ${JSON.stringify(input)};
  const driver = process.env.RELAY_CUA_DRIVER || "cua-driver";
  const call = (tool, args) => {
    const value = JSON.parse(execFileSync(driver, ["call", tool, "--json", JSON.stringify(args)], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }));
    if (value && typeof value === "object" && (value.isError === true || value.error)) throw new Error("cua-driver " + tool + " failed: " + JSON.stringify(value).slice(0, 500));
    return value;
  };
  const print = value => process.stdout.write(JSON.stringify({ gz: gzipSync(JSON.stringify(value)).toString("base64") }));
  const selected = selectWindow(call("list_windows", {}).windows || [], input.target);
  if (!selected.window) return print({ error: selected });
  const window = selected.window;
  let frontPid = null, listedActive = null;
  try {
    const front = execFileSync(input.lsappinfo, ["front"], { encoding: "utf8" }).trim();
    const pid = /"pid"=(\\d+)/.exec(execFileSync(input.lsappinfo, ["info", "-only", "pid", front], { encoding: "utf8" }));
    if (pid) frontPid = Number(pid[1]);
  } catch {}
  if (frontPid === null) {
    const apps = call("list_apps", {});
    listedActive = (Array.isArray(apps) ? apps : apps.apps || []).some(app => app.pid === window.pid && app.active === true);
  }
  const base = { pid: window.pid, window_id: window.window_id, max_elements: input.maxTreeNodes };
  if (!input.warmed.includes(window.pid + ":" + window.window_id)) call("get_window_state", { ...base, include_screenshot: false });
  const shot = resolve(input.screenshotPath);
  fs.mkdirSync(dirname(shot), { recursive: true });
  const state = call("get_window_state", { ...base, screenshot_out_file: shot });
  let pngWidth = null;
  if (fs.existsSync(shot)) {
    const png = stripPngMetadata(fs.readFileSync(shot));
    fs.writeFileSync(shot, png);
    if (png.length >= 24 && png.readUInt32BE(12) === 0x49484452) pngWidth = png.readUInt32BE(16);
  }
  print({ window, frontPid, listedActive, state, pngWidth });
})().catch(error => { process.stderr.write(String((error && error.stack) || error).slice(0, 2000)); process.exit(1); });
`;
}

export function relayDriverRunner(session: RelaySession, options: { actionIntervalMs: number }): DriverRunner {
  return async (tool, args, { timeoutMs, signal }) => {
    if (READ_TOOLS.has(tool)) {
      const execution = await session.run({ kind: "code", title: `Read with ${tool}`, expected: "The screen does not change", afterIntervalMs: 0, timeoutMs,
        body: { code: readProgram(tool, args), language: "javascript" } }, signal);
      const value = decoded(execution, `cua-driver ${tool}`);
      const failure = value as { isError?: boolean; error?: unknown };
      if (failure && typeof failure === "object" && (failure.isError === true || failure.error)) {
        throw new BackendError("driver_failed", `cua-driver ${tool} failed: ${JSON.stringify(value).slice(0, 500)}`);
      }
      return value;
    }
    const execution = await session.run({ kind: "cua", title: `Input with ${tool}`, expected: "The window reacts to the input", afterIntervalMs: options.actionIntervalMs, timeoutMs,
      body: { tool, args } }, signal);
    return execution.structuredContent ?? {};
  };
}

/** The active application from the guest's `lsappinfo`, as the local backend reads it (research §14.4). */
export function relayFrontmost(session: RelaySession): FrontmostPid {
  return async ({ timeoutMs, signal }) => {
    const execution = await session.run({ kind: "exec", title: "Read the active application", expected: "The screen does not change", afterIntervalMs: 0, timeoutMs,
      body: { argv: ["/bin/sh", "-c", "/usr/bin/lsappinfo info -only pid \"$(/usr/bin/lsappinfo front)\""] } }, signal);
    const pid = /"pid"=(\d+)/.exec(execution.stdout ?? "")?.[1];
    return pid === undefined ? undefined : Number(pid);
  };
}

/** Screenshot files in the declared extraction, kept in the guest as evidence rather than removed. */
export function relayScreenshotFiles(session: RelaySession): ScreenshotFiles {
  let sequence = 0;
  return async name => {
    const file = `${String(++sequence).padStart(4, "0")}-${name}`;
    return { path: `${SCREENSHOT_EXTRACTION}/${file}`, read: signal => session.screenshot(file, signal), discard: async () => {} };
  };
}

export interface RelayBackendOptions {
  connect: RelayConnect;
  image: string;
  env?: string;
  ttlHours: number;
  maxTreeNodes: number;
  foregroundDelivery: boolean;
  /** The wait before the relay's after-screenshot of an action. */
  actionIntervalMs: number;
  timeoutMs?: number;
  /** Commands run in the guest once after staging, such as `open -a Calculator`. */
  prepare?: string[][];
  /** The guest's `lsappinfo`; tests replace it. */
  guestLsappinfo?: string;
}

/**
 * A read is one relay run and, when a screenshot is wanted, one `image` call. Actions go through
 * the local driver backend with relay runs, and take the window's bounds and scale from its latest
 * read instead of reading the bounds again. If the window moved since that read, the click lands
 * where the window was, and the step's postcondition reports the miss.
 */
export class RelayBackend implements ExecutionBackend {
  readonly kind = "relay" as const;
  readonly #session: RelaySession;
  readonly #driver: LocalDriverBackend;
  readonly #options: RelayBackendOptions;
  readonly #warmed = new Set<string>();
  readonly #geometry = new Map<string, { bounds: WindowBounds; scale: number }>();
  #reads = 0;
  constructor(options: RelayBackendOptions) {
    this.#options = options;
    this.#session = new RelaySession(options.connect, options);
    this.#driver = new LocalDriverBackend({ run: relayDriverRunner(this.#session, options), maxTreeNodes: options.maxTreeNodes,
      foregroundDelivery: options.foregroundDelivery, frontmostPid: relayFrontmost(this.#session), screenshots: relayScreenshotFiles(this.#session),
      geometry: window => this.#geometry.get(`${window.pid}:${window.windowId}`), timeoutMs: this.#timeout });
  }
  get #timeout(): number { return this.#options.timeoutMs ?? 60_000; }
  /** The lease, for scripts that prepare the machine, such as opening an application. */
  get session(): RelaySession { return this.#session; }

  async readWindow(target: WindowTarget, options: ReadOptions): Promise<WindowRead> {
    const { value, evidence } = await this.#session.labelled(options.label, () => this.#read(target, options));
    return { ...value, evidence };
  }

  async #read(target: WindowTarget, options: ReadOptions): Promise<WindowRead> {
    const started = performance.now();
    const file = `read-${String(++this.#reads).padStart(4, "0")}.png`;
    const execution = await this.#session.run({ kind: "code", title: `Read the ${target.app} window`, expected: "The screen does not change", afterIntervalMs: 0,
      timeoutMs: this.#timeout, body: { code: windowReadProgram({ target, maxTreeNodes: this.#options.maxTreeNodes, warmed: [...this.#warmed],
        screenshotPath: `${SCREENSHOT_EXTRACTION}/${file}`, lsappinfo: this.#options.guestLsappinfo ?? "/usr/bin/lsappinfo" }), language: "javascript" } }, options.signal);
    const result = decoded(execution, "The window read") as GuestWindowRead;
    if (result.error) throw new BackendError(result.error.code, result.error.message);
    const window = windowRef(result.window);
    const key = `${window.pid}:${window.windowId}`;
    this.#warmed.add(key);
    const bounds = result.window.bounds;
    if (result.pngWidth && bounds && bounds.width > 0) this.#geometry.set(key, { bounds, scale: result.pngWidth / bounds.width });
    else this.#geometry.delete(key);
    const appActive = result.frontPid !== null ? result.frontPid === window.pid : result.listedActive === true;
    let screenshot: WindowRead["screenshot"];
    if (options.screenshot && result.pngWidth && Array.isArray(result.state.elements)) {
      try { screenshot = { data: (await this.#session.screenshot(file, options.signal)).toString("base64"), mimeType: "image/png" }; }
      catch (error) { if (options.signal?.aborted) throw new BackendError("aborted", "the window read was cancelled"); }
    }
    return toWindowRead(window, appActive, result.state, this.#options.maxTreeNodes, screenshot, performance.now() - started);
  }
  async act(window: WindowRef, action: BackendAction, signal?: AbortSignal): Promise<ActionOutcome> {
    const { value, evidence } = await this.#session.labelled(action.label, () => this.#driver.act(window, action, signal));
    return { ...value, evidence };
  }
  foreground(window: WindowRef, point: Point | undefined, signal?: AbortSignal): Promise<ForegroundState> { return this.#driver.foreground(window, point, signal); }
  bringToFront(window: WindowRef, signal?: AbortSignal): Promise<void> { return this.#driver.bringToFront(window, signal); }
  close(): Promise<void> { return this.#session.close(); }
}
