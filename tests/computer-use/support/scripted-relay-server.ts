/**
 * A scripted stand-in for the mcp-vm-relay server (design §11.2), for the relay client's contract
 * tests. It speaks MCP over standard input and output and answers the relay 0.6 tools, such as
 * `relay_code` and `relay_run`, in the real server's result format (probed 2026-09-26). A `code` run executes the given program with node in a workspace
 * directory, with RELAY_CUA_DRIVER naming a fake driver, and applies the guest's 64 KiB output cap.
 * Every call is appended to the log as one JSON line, with the relay tool's name in `relayTool`.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const workspace = process.env.SCRIPTED_RELAY_WORKSPACE!;
const log = process.env.SCRIPTED_RELAY_LOG!;
const driver = process.env.SCRIPTED_RELAY_DRIVER!;
const MAX_OUTPUT_BYTES = 64 * 1024;
mkdirSync(workspace, { recursive: true });
if (process.env.SCRIPTED_RELAY_PID_FILE) writeFileSync(process.env.SCRIPTED_RELAY_PID_FILE, String(process.pid));

const executed = (execution: Record<string, unknown>) =>
  `${JSON.stringify({ imageDelivery: { status: "attached" }, executionFailed: false })}\n${JSON.stringify({ executionId: "e", ...execution }, null, 2)}`;
const completed = (stdout: string) => executed({ outcome: { kind: "completed", exitStatus: { code: 0, signal: null } }, stdout, stderr: "", outputTruncated: false });

function runCode(code: string): Promise<string> {
  const file = join(workspace, `.program-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  writeFileSync(file, code);
  return new Promise(done => execFile(process.execPath, [file], { cwd: workspace, env: { ...process.env, RELAY_CUA_DRIVER: driver }, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        return done(executed({ outcome: { kind: "uncertain", diagnostic: "execution exceeded output bound" }, stdout: stdout.slice(0, MAX_OUTPUT_BYTES), stderr, outputTruncated: true }));
      }
      done(error ? executed({ outcome: { kind: "completed", exitStatus: { code: 1, signal: null } }, stdout, stderr, outputTruncated: false }) : completed(stdout));
    }));
}

const server = new Server({ name: "scripted-relay", version: "0.0.0" }, { capabilities: { tools: {} } });
const TOOLS = ["relay_acquire", "relay_stage", "relay_exec", "relay_code", "relay_run", "relay_image", "relay_finish", "relay_release"];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(name => ({ name, inputSchema: { type: "object" } })) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = request.params.name;
  const input = request.params.arguments as Record<string, any>;
  appendFileSync(log, `${JSON.stringify({ relayTool: tool, ...input, ...(input.code ? { code: "<program>" } : {}), session: process.env.MCP_VM_RELAY_SESSION, project: process.env.MCP_VM_RELAY_PROJECT })}\n`);
  let text: string;
  if (tool === "relay_code") text = await runCode(input.code);
  else if (tool === "relay_exec") text = completed(`"pid"=7\n`);
  // A relay_run result has a second text block with the target tool's own text.
  else if (tool === "relay_run") return { content: [{ type: "text", text: executed({ outcome: { kind: "completed", exitStatus: { code: 0, signal: null } }, relayOutcome: "completed",
    target: input.target, tool: input.tool, toolOutcome: "completed", structuredContent: { ok: true } }) }, { type: "text", text: "✅ done" }], isError: false };
  else if (tool === "relay_image") {
    const originalPath = resolve(workspace, input.target.name, input.target.path);
    // The relay refuses to present a PNG with compressed metadata, and then reports no original.
    if (readFileSync(originalPath).includes("iCCP")) {
      return { content: [{ type: "text", text: `${JSON.stringify({ imageDelivery: { status: "presentation-unavailable", diagnostic: "Image operation failed: presentation-unavailable" } })}\n{}` }], isError: true };
    }
    text = `${JSON.stringify({ imageDelivery: { status: "attached", image: { source: "application", name: input.target.name, path: input.target.path, originalPath } } })}\n{}`;
  } else if (TOOLS.includes(tool)) text = JSON.stringify({ ok: true, tool });
  else return { content: [{ type: "text", text: `unknown tool ${tool}` }], isError: true };
  return { content: [{ type: "text", text }], isError: false };
});
await server.connect(new StdioServerTransport());
