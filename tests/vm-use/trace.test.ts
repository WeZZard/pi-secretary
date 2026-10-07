import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const trace = join(import.meta.dirname, "../../extensions/secretary/vm-use/trace.ts");

// The trace reads its variable when it loads, so each case runs in a process of its own.
function runWith(env: Record<string, string>, script: string) {
  return execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
    { env: { ...process.env, ...env }, encoding: "utf8" });
}

const exercise = `
  import http from "node:http";
  const { span, vmServiceUrl } = await import(${JSON.stringify(trace)});
  const upstream = http.createServer((request, response) => { request.resume(); request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"rc":0}'); }); });
  await new Promise(done => upstream.listen(0, "127.0.0.1", done));
  process.env.MCP_VM_RELAY_URL = "http://127.0.0.1:" + upstream.address().port;
  await span("work", { n: 1 }, async () => {});
  const url = await vmServiceUrl();
  if (url) {
    const reply = await fetch(url + "/vms/vm-1/exec", { method: "POST", body: JSON.stringify({ argv: ["/bin/sh", "-c", "x".repeat(300)], timeout: 5 }) });
    console.log(reply.status, await reply.text());
  } else console.log("no proxy");
  upstream.close();
`;

test("without the variable, the trace records nothing and starts no proxy", () => {
  assert.equal(runWith({ PI_SECRETARY_VM_USE_TRACE: "" }, exercise).trim(), "no proxy");
});

test("with the variable, spans and vm-service requests are recorded and the request is forwarded", () => {
  const dir = mkdtempSync(join(tmpdir(), "vm-use-trace-"));
  assert.equal(runWith({ PI_SECRETARY_VM_USE_TRACE: dir }, exercise).trim(), '200 {"rc":0}');
  const spans = readFileSync(join(dir, "spans.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(spans.some(span => span.name === "work" && span.args.n === 1 && span.end >= span.start));
  const [request] = readFileSync(join(dir, "vm-service.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(request.path, "/vms/vm-1/exec");
  assert.equal(request.status, 200);
  assert.match(request.body.argv[2], /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(readdirSync(join(dir, "scripts")), [`${request.body.argv[2].slice(7)}.txt`]);
});
