// The trajectory viewer's local web server: the relay's review server (mcp-vm-relay
// src/relay-trajectory-viewer/server.ts), moved here by decision PS-D18 and reshaped to serve
// computer-use agents instead of single packages (design §12.3).
//
// It serves one app, each agent's model, the pictures the agent received and its machines'
// package files on 127.0.0.1, and names the address the browser opens. The app renders the page
// from the model in the browser. The app's modules are TypeScript; the server strips their
// types as it serves them, so no bundler is needed and a reload shows an edit to the app. The
// model is built again on every request, so a reload also shows new evidence.
import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { buildTrajectory, type AgentTrajectory, type TrajectoryInput } from "../trajectory.ts";
import { relayIcon, reviewCss } from "./page.ts";

// Package files come from the guest: none is served as a page or a script.
const types: Record<string, string> = {
  ".json": "application/json; charset=utf-8", ".jsonl": "text/plain; charset=utf-8", ".ndjson": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8", ".tsv": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8", ".xml": "text/plain; charset=utf-8", ".toml": "text/plain; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};
const html = "text/html; charset=utf-8", plain = "text/plain; charset=utf-8";
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]!);
const href = (...parts: string[]) => `/${parts.map(encodeURIComponent).join("/")}/`;
// The app may run only its own script and style, and ask only its own server.
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Computer-use trajectory</title><link rel="icon" href="/.app/icon.svg"><link rel="stylesheet" href="/.app/review.css"><script type="module" src="/.app/main.ts"></script></head><body><p class="loading">Reading the trajectory…</p></body></html>`;
const list = (title: string, items: [string, string][]) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title><link rel="icon" href="/.app/icon.svg"><link rel="stylesheet" href="/.app/review.css"></head><body class="runs"><h1>${escape(title)}</h1><ul>${items.map(([h, text]) => `<li><a href="${escape(h)}">${escape(text)}</a></li>`).join("")}</ul></body></html>`;
/** The app's own modules, the only scripts the server serves. */
const APP_MODULES = new Set(["main.ts", "page.ts", "behaviour.ts"]);

export class TrajectoryServer {
  /** agent → how to build its trajectory */
  private readonly agents = new Map<string, TrajectoryInput>();
  private server?: Server;
  private listening?: Promise<number>;
  private readonly port: number;

  constructor(port = 0) { this.port = port; }

  /** Serve an agent's trajectory; returns the address of its page. */
  async add(agent: string, input: TrajectoryInput): Promise<string> {
    this.agents.set(agent, input);
    return `http://127.0.0.1:${await this.listen()}${href(agent)}`;
  }

  /** The agents served, as their page addresses. */
  async addresses(): Promise<string[]> {
    const port = await this.listen();
    return [...this.agents.keys()].map(agent => `http://127.0.0.1:${port}${href(agent)}`);
  }

  listen(): Promise<number> {
    this.listening ??= new Promise((done, fail) => {
      const server = createServer((request, response) => void this.handle(request.url ?? "/", request.headers.host, response));
      server.once("error", fail);
      server.listen(this.port, "127.0.0.1", () => { server.unref(); done((server.address() as AddressInfo).port); });
      this.server = server;
    });
    return this.listening;
  }

  close() { this.server?.close(); }

  private async trajectory(agent: string): Promise<AgentTrajectory | undefined> {
    const input = this.agents.get(agent);
    return input ? buildTrajectory(input) : undefined;
  }

  private async handle(url: string, host: string | undefined, response: ServerResponse) {
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": policy, ...headers });
      response.end(body);
    };
    const redirect = (location: string) => { response.writeHead(301, { location }); response.end(); };
    try {
      // Only the browser that was given this address may ask: a page elsewhere
      // that rebinds a name to 127.0.0.1 carries its own name as the host.
      const port = await this.listen();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(421, plain, "unknown host");
      const path = new URL(url, "http://127.0.0.1").pathname;
      const module = /^\/\.app\/([a-z]+\.ts)$/.exec(path)?.[1];
      if (module && APP_MODULES.has(module))
        return send(200, "text/javascript; charset=utf-8", stripTypeScriptTypes(await readFile(join(import.meta.dirname, module), "utf8")));
      if (path === "/.app/review.css") return send(200, "text/css; charset=utf-8", reviewCss);
      if (path === "/.app/icon.svg") return send(200, "image/svg+xml", relayIcon);
      const api = /^\/\.api\/([^/]+)\.json$/.exec(path);
      if (api) {
        const trajectory = await this.trajectory(decodeURIComponent(api[1]!));
        return trajectory ? send(200, types[".json"]!, JSON.stringify(trajectory.data)) : send(404, plain, "unknown agent");
      }
      const [, agent = "", ...rest] = path.split("/").map(decodeURIComponent);
      if (!agent) return send(200, html, list("Computer-use trajectories", [...this.agents.keys()].map(a => [href(a), a] as [string, string])));
      if (!this.agents.has(agent)) return send(404, plain, `unknown agent ${agent}`);
      // The page refers to its pictures and files relatively, so it is served from the agent's folder.
      if (!rest.length) return redirect(href(agent));
      const file = rest.join("/");
      if (!file) return send(200, html, shell);
      const trajectory = (await this.trajectory(agent))!;
      const image = trajectory.images.find(image => image.path === file);
      if (image) return send(200, image.mimeType, Buffer.from(image.data, "base64"));
      const [name = "", ...inside] = rest;
      const root = trajectory.packages.get(name);
      if (!root || !inside.length) return send(404, plain, "not in the trajectory");
      const base = await realpath(root);
      const target = await realpath(resolve(base, inside.join("/"))).catch(() => undefined);
      if (!target || !target.startsWith(base + sep)) return send(404, plain, "not in the package");
      return send(200, types[extname(target).toLowerCase()] ?? "application/octet-stream", await readFile(target));
    } catch (error) {
      return send(500, plain, error instanceof Error ? error.message : String(error));
    }
  }
}
