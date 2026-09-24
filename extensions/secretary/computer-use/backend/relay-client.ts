import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BackendError, type ActionOutcome, type BackendAction, type ExecutionBackend, type ForegroundState, type Point, type ReadOptions, type WindowRead, type WindowRef, type WindowTarget } from "./backend.ts";
import { LocalDriverBackend, type DriverRunner, type FrontmostPid, type ScreenshotFiles } from "./local-backend.ts";

/**
 * The relay client (design docs/arch/computer-use.md §11.2). It sends the harness's reads and
 * actions to an mcp-vm-relay server of its own, which performs them in a disposable virtual
 * machine with a driver of its choosing. It reuses the local driver backend and replaces only the
 * driver calls, the active-application source and the screenshot files.
 */

/** One call of the server's `relay` tool: the text block, and whether the server marked it an error. */
export interface RelayConnection {
  call(input: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<{ text: string; isError: boolean }>;
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
    return {
      async call(input, { timeoutMs, signal }) {
        const result = await client.callTool({ name: "relay", arguments: input }, undefined, { timeout: timeoutMs, signal });
        const blocks = (result.content ?? []) as { type: string; text?: string }[];
        return { text: blocks.filter(block => block.type === "text").map(block => block.text ?? "").join("\n"), isError: result.isError === true };
      },
      close: () => client.close(),
    };
  };
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
}

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
  #ready?: Promise<RelayConnection>;
  #sequence = 0;
  constructor(connect: RelayConnect, acquire: { image: string; env?: string; ttlHours: number }) {
    this.#connect = connect;
    this.#acquire = { action: "acquire", task: "computer-use", image: acquire.image, extractions: [{ path: SCREENSHOT_EXTRACTION, name: SCREENSHOT_EXTRACTION }],
      ttlHours: acquire.ttlHours, ...(acquire.env ? { env: acquire.env } : {}) };
  }

  async #call(connection: RelayConnection, input: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
    try { return await connection.call(input, { timeoutMs, signal }); }
    catch (error) {
      if (signal?.aborted) throw new BackendError("aborted", `relay ${String(input.action)} was cancelled`);
      throw new BackendError("driver_failed", `relay ${String(input.action)} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #connection(signal?: AbortSignal): Promise<RelayConnection> {
    this.#ready ??= (async () => {
      const connection = await this.#connect();
      for (const input of [this.#acquire, { action: "stage" }]) {
        const result = await this.#call(connection, input, 15 * 60_000, signal);
        if (result.isError) throw new BackendError("driver_failed", `relay ${String(input.action)} failed: ${result.text.slice(0, 500)}`);
      }
      return connection;
    })();
    // A failed start is not cached: the next call tries again.
    this.#ready.catch(() => { this.#ready = undefined; });
    return this.#ready;
  }

  /**
   * One relay run. An outcome other than a clean exit is `driver_failed` and is never repeated,
   * because the input may have reached the machine (design §11.2).
   */
  async run(input: RunInput, signal?: AbortSignal): Promise<RelayExecution> {
    const connection = await this.#connection(signal);
    const id = `cu-${String(++this.#sequence).padStart(4, "0")}`;
    const result = await this.#call(connection, { action: "run", kind: input.kind, reason: `Secretary computer use: ${input.title}`,
      step: { id, title: input.title, expected: input.expected, inputMode: "ordinary" }, snapshots: { afterIntervalMs: input.afterIntervalMs },
      timeoutMs: input.timeoutMs, ...input.body }, input.timeoutMs + RELAY_OVERHEAD_MS, signal);
    let execution: RelayExecution | undefined;
    try { execution = await resultBody(result.text) as RelayExecution; }
    catch { execution = undefined; }
    if (!execution?.outcome) throw new BackendError("driver_failed", `relay run ${id} failed: ${result.text.slice(0, 500)}`);
    if (execution.outputTruncated) throw new BackendError("state_too_large", `${input.title}: the output passed the relay's 64 KiB limit`);
    const { outcome } = execution;
    if (outcome.kind !== "completed" || outcome.exitStatus?.code !== 0) {
      const detail = outcome.kind === "completed" ? `exit ${outcome.exitStatus?.code ?? outcome.exitStatus?.signal}: ${(execution.stderr ?? "").trim().slice(0, 400)}` : outcome.diagnostic ?? "";
      throw new BackendError("driver_failed", `relay run ${id} (${input.title}) was ${outcome.kind}: ${detail}`.trim());
    }
    return execution;
  }

  /** The untouched original of an image in the screenshot extraction, read from this machine. */
  async screenshot(path: string, signal?: AbortSignal): Promise<Buffer> {
    const connection = await this.#connection(signal);
    const result = await this.#call(connection, { action: "image", target: { source: "application", name: SCREENSHOT_EXTRACTION, path } }, 120_000, signal);
    const facts = JSON.parse(result.text.split("\n")[0]!) as { imageDelivery?: { status?: string; image?: { originalPath?: string }; diagnostic?: string } };
    const original = facts.imageDelivery?.image?.originalPath;
    if (facts.imageDelivery?.status !== "attached" || !original) {
      throw new BackendError("driver_failed", `relay image ${path}: ${facts.imageDelivery?.status ?? "no delivery"} ${facts.imageDelivery?.diagnostic ?? ""}`.trim());
    }
    return readFile(original);
  }

  /** Delivers the evidence package and releases the machine. */
  async close(): Promise<void> {
    const ready = this.#ready;
    this.#ready = undefined;
    if (!ready) return;
    const connection = await ready.catch(() => undefined);
    if (!connection) return;
    try { await connection.call({ action: "finish" }, { timeoutMs: 15 * 60_000 }); }
    finally { await connection.close(); }
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

export function relayDriverRunner(session: RelaySession, options: { actionIntervalMs: number }): DriverRunner {
  return async (tool, args, { timeoutMs, signal }) => {
    if (READ_TOOLS.has(tool)) {
      const execution = await session.run({ kind: "code", title: `Read with ${tool}`, expected: "The screen does not change", afterIntervalMs: 0, timeoutMs,
        body: { code: readProgram(tool, args), language: "javascript" } }, signal);
      let value: unknown;
      try { value = JSON.parse(gunzipSync(Buffer.from((JSON.parse(execution.stdout ?? "") as { gz: string }).gz, "base64")).toString("utf8")); }
      catch { throw new BackendError("driver_failed", `cua-driver ${tool} returned output that is not JSON`); }
      const failure = value as { isError?: boolean; error?: unknown };
      if (failure && typeof failure === "object" && (failure.isError === true || failure.error)) {
        throw new BackendError("driver_failed", `cua-driver ${tool} failed: ${JSON.stringify(value).slice(0, 500)}`);
      }
      return value;
    }
    const execution = await session.run({ kind: "cua", title: `Input with ${tool}`, expected: "The window reacts to the input", afterIntervalMs: options.actionIntervalMs, timeoutMs,
      body: { tool, args } }, signal);
    try { return JSON.parse(execution.stdout ?? ""); }
    catch { return {}; }
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
}

export class RelayBackend implements ExecutionBackend {
  readonly kind = "relay" as const;
  readonly #session: RelaySession;
  readonly #driver: LocalDriverBackend;
  constructor(options: RelayBackendOptions) {
    this.#session = new RelaySession(options.connect, options);
    this.#driver = new LocalDriverBackend({ run: relayDriverRunner(this.#session, options), maxTreeNodes: options.maxTreeNodes,
      foregroundDelivery: options.foregroundDelivery, frontmostPid: relayFrontmost(this.#session), screenshots: relayScreenshotFiles(this.#session),
      timeoutMs: options.timeoutMs ?? 60_000 });
  }
  readWindow(target: WindowTarget, options: ReadOptions): Promise<WindowRead> { return this.#driver.readWindow(target, options); }
  act(window: WindowRef, action: BackendAction, signal?: AbortSignal): Promise<ActionOutcome> { return this.#driver.act(window, action, signal); }
  foreground(window: WindowRef, point: Point | undefined, signal?: AbortSignal): Promise<ForegroundState> { return this.#driver.foreground(window, point, signal); }
  bringToFront(window: WindowRef, signal?: AbortSignal): Promise<void> { return this.#driver.bringToFront(window, signal); }
  close(): Promise<void> { return this.#session.close(); }
}
