/**
 * Instrumentation for the time between relay calls. It drives one relay virtual machine through the
 * extension's own relay client (as a real run does) and records, on this Mac's clock:
 * - every HTTP request the relay sends to vm-service, through a logging proxy (requests.jsonl);
 * - every process vm-service starts, such as ssh, from `ps` sampled every 40 ms (processes.jsonl);
 * - the start and end of every client call (calls.jsonl).
 *
 *   node --experimental-strip-types scripts/vm-use/relay-latency.ts [image] [calls-per-phase]
 *
 * Phases:
 * - A: bring_to_front calls back to back, as a run's actions are.
 * - B: the same calls, each started 6 s after the previous one ended, so no screenshot download runs.
 * - C: a command with no snapshots (`/usr/bin/true`, diagnostic) back to back.
 * - D: window reads with a screenshot back to back, as a run's reads are.
 * Records go to a new directory under test-results/.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { RelayBackend, stdioRelayConnect } from "../../extensions/secretary/vm-use/backend/relay-client.ts";
import { DEFAULT_RELAY_COMMAND, defaultVmUseConfiguration } from "../../extensions/secretary/vm-use/configuration.ts";

const run = promisify(execFile);
const [image = "macos26", perPhase = "12"] = process.argv.slice(2);
const out = resolve("test-results/vm-use", `relay-latency-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const now = () => performance.timeOrigin + performance.now();
const record = (file: string, value: unknown) => appendFileSync(join(out, file), `${JSON.stringify(value)}\n`);
const log = (line: string) => { console.log(line); appendFileSync(join(out, "log.txt"), `${line}\n`); };

// The guest command each exec runs, by text unique to the relay 0.9.0 script (dist/server.mjs 19643-19660, 20127).
const KINDS: [string, string][] = [
  ["receiver", "spawnSync(process.execPath,[receiver"], ["image-fact", "Source changed before image hash"],
  ["prepare", "check(root,target,true);fs.mkdirSync"], ["scan", "walk(root);check(approved,root);check(frameRoot"],
  ["file-fact", "Invalid frame file"], ["size", "bytes+=s.size;files++"], ["remove-frame", "fs.rmSync(file,{force:true})"],
  ["guest-path", "check(process.argv[1],process.argv[2]);"],
];
const kindOf = (path: string, body: string) => {
  const action = path.split("/").at(-1)!;
  if (action !== "exec") return action;
  return KINDS.find(([, text]) => body.includes(text))?.[0] ?? `exec:${createHash("sha256").update(body).digest("hex").slice(0, 8)}`;
};

// The proxy. The relay accepts a loopback IPv4 origin with an explicit port (dist/server.mjs 19028-19033).
let inFlight = 0, sequence = 0;
const proxy = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const id = ++sequence, received = now(), body = Buffer.concat(chunks), concurrent = inFlight++;
    const text = body.toString("utf8");
    let argvTail: unknown;
    try { const parsed = JSON.parse(text) as Record<string, unknown>; const argv = (parsed.argv ?? parsed.command) as unknown;
      argvTail = Array.isArray(argv) ? argv.filter((part, i) => !(i === 2 && String(part).length > 200)).map(part => String(part).slice(0, 200)) : undefined;
      if (!argvTail) argvTail = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 200) : typeof v]));
    } catch { argvTail = undefined; }
    const upstream = http.request({ host: "127.0.0.1", port: 6240, path: request.url, method: request.method,
      headers: { ...request.headers, host: "localhost:6240" } }, reply => {
      const headersAt = now(), parts: Buffer[] = [];
      reply.on("data", chunk => parts.push(chunk));
      reply.on("end", () => {
        const ended = now(), payload = Buffer.concat(parts);
        let vm: unknown;
        if (/^\/(vms\/[^/]+|acquire)$/.test(request.url ?? "")) {
          try { const parsed = JSON.parse(payload.toString("utf8")) as Record<string, unknown>; vm = { name: parsed.name ?? parsed.vm, ip: parsed.ip, status: parsed.status }; } catch { vm = undefined; }
        }
        inFlight--;
        record("requests.jsonl", { id, method: request.method, path: request.url, kind: kindOf(request.url ?? "", text), argv: argvTail,
          requestBytes: body.length, status: reply.statusCode, responseBytes: payload.length, concurrentAtStart: concurrent,
          receivedAt: received, headersAt, endedAt: ended, ms: ended - received, ...(vm ? { vm } : {}) });
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        response.end(payload);
      });
    });
    upstream.on("error", error => { inFlight--; record("requests.jsonl", { id, path: request.url, error: String(error), receivedAt: received, endedAt: now() }); response.writeHead(502); response.end(); });
    upstream.end(body);
  });
});
await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
const port = (proxy.address() as { port: number }).port;
process.env.MCP_VM_RELAY_URL = `http://127.0.0.1:${port}`;

// The process sampler: every descendant of vm-service, with when it was first and last seen.
const service = Number((await run("lsof", ["-tiTCP:6240", "-sTCP:LISTEN"])).stdout.trim().split("\n")[0]);
const seen = new Map<number, { pid: number; ppid: number; command: string; firstSeen: number; lastSeen: number }>();
let sampling = true, samples = 0;
const sampler = (async () => {
  while (sampling) {
    const at = now();
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 16 << 20 });
    const rows = stdout.trim().split("\n").map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: Number(m![1]), ppid: Number(m![2]), command: m![3]! }));
    const family = new Set([service]);
    for (let grew = true; grew;) { grew = false; for (const row of rows) if (family.has(row.ppid) && !family.has(row.pid)) { family.add(row.pid); grew = true; } }
    for (const row of rows) {
      if (row.pid === service || !family.has(row.pid) || row.command === "<defunct>") continue;
      const known = seen.get(row.pid);
      if (known && known.command === row.command.slice(0, 600)) known.lastSeen = at;
      else { if (known) record("processes.jsonl", known); seen.set(row.pid, { pid: row.pid, ppid: row.ppid, command: row.command.slice(0, 600), firstSeen: at, lastSeen: at }); }
    }
    samples++;
    await new Promise(done => setTimeout(done, 40));
  }
})();

const config = defaultVmUseConfiguration();
const driver = new RelayBackend({ connect: stdioRelayConnect({ command: DEFAULT_RELAY_COMMAND, cwd: out, stderrLog: join(out, "relay-server.log") }), image, env: "default", ttlHours: 1,
  maxTreeNodes: config.maxTreeNodes, foregroundDelivery: config.foregroundDelivery, actionIntervalMs: config.settleMs });
const session = driver.session;
const call = async <T>(phase: string, name: string, work: () => Promise<T>) => {
  const startedAt = now();
  try { const value = await work(); record("calls.jsonl", { phase, name, startedAt, endedAt: now(), ok: true }); return value; }
  catch (error) { record("calls.jsonl", { phase, name, startedAt, endedAt: now(), ok: false, error: String(error).slice(0, 400) }); throw error; }
};
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

log(`Proxy on ${process.env.MCP_VM_RELAY_URL} -> localhost:6240; vm-service pid ${service}; output ${out}`);
try {
  await call("setup", "open Calculator", () => session.run({ kind: "exec", title: "Open Calculator", expected: "Calculator shows its window", afterIntervalMs: 2500, timeoutMs: 60_000, body: { argv: ["/usr/bin/open", "-a", "Calculator"] } }));
  const { window } = await call("setup", "read", () => driver.readWindow({ app: "Calculator" }, { screenshot: true }));
  await pause(8000);
  const count = Number(perPhase);
  for (let i = 0; i < count; i++) await call("A", "bring_to_front", () => driver.bringToFront(window));
  for (let i = 0; i < count; i++) { await pause(6000); await call("B", "bring_to_front", () => driver.bringToFront(window)); }
  await pause(8000);
  for (let i = 0; i < count; i++) {
    await call("C", "diagnostic true", () => session.run({ kind: "exec", title: "No-op", expected: "Nothing changes", afterIntervalMs: 0, timeoutMs: 30_000, body: { argv: ["/usr/bin/true"], diagnostic: true } }))
      .catch(error => log(`C ${i + 1} failed: ${String(error).slice(0, 300)}`));
  }
  await pause(8000);
  for (let i = 0; i < Math.ceil(count / 2); i++) await call("D", "read", () => driver.readWindow({ app: "Calculator" }, { screenshot: true }));
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  const closing = now();
  try { await call("close", "finish", () => driver.close()); log(`finish: ${Math.round(now() - closing)} ms`); }
  catch (error) { log(`finish FAILED: ${String(error)}`); process.exitCode = 1; }
  sampling = false;
  await sampler;
  for (const known of seen.values()) record("processes.jsonl", known);
  log(`ps samples: ${samples}; requests: ${sequence}`);
  proxy.close();
}
