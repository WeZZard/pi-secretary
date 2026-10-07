/**
 * An opt-in timing trace of the vm-use runtime, for troubleshooting where a run's time goes. When
 * PI_SECRETARY_VM_USE_TRACE names a directory, Pi records there, on this Mac's clock:
 * - spans.jsonl: a span per piece of Pi's own work (executor, grounder request, relay tool call);
 * - vm-service.jsonl: every HTTP request the relay server sends to vm-service, through a logging
 *   proxy that Pi starts and names to the relay server with MCP_VM_RELAY_URL;
 * - scripts/<sha256>.txt: each guest script those requests ran, once.
 * Without the variable nothing is recorded and nothing is started.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

const dir = process.env.PI_SECRETARY_VM_USE_TRACE || undefined;
if (dir) mkdirSync(join(dir, "scripts"), { recursive: true });
const now = () => performance.timeOrigin + performance.now();
const write = (file: string, value: unknown) => { if (dir) appendFileSync(join(dir, file), `${JSON.stringify(value)}\n`); };

export const tracing = dir !== undefined;

/** Times `work` as a span named `name`. */
export async function span<T>(name: string, args: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
  if (!dir) return work();
  const start = now();
  try { return await work(); }
  finally { write("spans.jsonl", { name, args, start, end: now(), pid: process.pid }); }
}

/** Times `work` as a span, for work that does not wait. */
export function spanSync<T>(name: string, args: Record<string, unknown>, work: () => T): T {
  if (!dir) return work();
  const start = now();
  try { return work(); }
  finally { write("spans.jsonl", { name, args, start, end: now(), pid: process.pid }); }
}

let proxy: Promise<string> | undefined;

/**
 * The URL the relay server should use for vm-service: a logging proxy to the one it would use, or
 * undefined when not tracing. A selected VM environment names its own vm-service, which a proxy
 * would not match, so it is left alone.
 */
export function vmServiceUrl(): Promise<string | undefined> {
  if (!dir || process.env.VM_ENVIRONMENT_FILE) return Promise.resolve(undefined);
  // The relay's own default (mcp-vm-relay dist/server.mjs, class VmService).
  const upstream = new URL(process.env.MCP_VM_RELAY_URL ?? "http://localhost:6240");
  return proxy ??= new Promise(resolve => {
    let sequence = 0, inFlight = 0;
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        const id = ++sequence, received = now(), body = Buffer.concat(chunks), concurrent = inFlight++;
        let summary: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
          summary = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (key === "argv" && Array.isArray(value)) summary.argv = value.map(part => {
              const text = String(part);
              if (text.length <= 200) return text;
              const sha = createHash("sha256").update(text).digest("hex");
              const file = join(dir, "scripts", `${sha}.txt`);
              if (!existsSync(file)) writeFileSync(file, text);
              return `sha256:${sha}`;
            });
            else summary[key] = typeof value === "string" ? value.slice(0, 300) : value;
          }
        } catch { summary = undefined; }
        const upstreamRequest = http.request({ host: upstream.hostname, port: upstream.port, path: request.url, method: request.method,
          headers: { ...request.headers, host: upstream.host } }, reply => {
          const parts: Buffer[] = [];
          reply.on("data", chunk => parts.push(chunk));
          reply.on("end", () => {
            inFlight--;
            write("vm-service.jsonl", { id, method: request.method, path: request.url, body: summary, status: reply.statusCode, concurrentAtStart: concurrent, start: received, end: now() });
            response.writeHead(reply.statusCode ?? 502, reply.headers);
            response.end(Buffer.concat(parts));
          });
        });
        upstreamRequest.on("error", error => {
          inFlight--;
          write("vm-service.jsonl", { id, method: request.method, path: request.url, body: summary, error: String(error), start: received, end: now() });
          response.writeHead(502);
          response.end();
        });
        upstreamRequest.end(body);
      });
    });
    server.unref();
    // The relay accepts a loopback IPv4 origin with an explicit port (dist/server.mjs, class VmService).
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      write("spans.jsonl", { name: "vm-service proxy", args: { url, upstream: upstream.origin }, start: now(), end: now(), pid: process.pid });
      resolve(url);
    });
  });
}
