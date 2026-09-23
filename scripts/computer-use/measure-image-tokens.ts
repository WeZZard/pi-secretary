/**
 * Measures what one screenshot costs the planner (plan Phase 1; design §13).
 *
 * Formula, held for every number this script prints:
 *   image input tokens = usage.prompt_tokens(request with the image and the fixed text)
 *                      − usage.prompt_tokens(the same request without the image)
 * Both values are the gateway's own usage report. Each variant is sent `repeats` times to
 * show whether the count is deterministic.
 *
 *   LITELLM_MASTER_KEY=… node --experimental-strip-types scripts/computer-use/measure-image-tokens.ts <png> [model] [repeats]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [png, model = "qwen3.8-27b", repeatText = "2"] = process.argv.slice(2);
if (!png) { console.error("usage: measure-image-tokens.ts <png> [model] [repeats]"); process.exit(2); }
const key = process.env.LITELLM_MASTER_KEY;
if (!key) { console.error("LITELLM_MASTER_KEY is not set"); process.exit(2); }
const repeats = Number(repeatText);
const TEXT = "Reply with the single word ok.";

async function promptTokens(image?: string): Promise<number> {
  const content = image
    ? [{ type: "text", text: TEXT }, { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }]
    : [{ type: "text", text: TEXT }];
  const response = await fetch("http://api.home.arpa/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 1 }),
    signal: AbortSignal.timeout(240_000),
  });
  const body = await response.json() as { usage?: { prompt_tokens?: number }; error?: unknown };
  if (!response.ok || body.usage?.prompt_tokens === undefined) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.usage.prompt_tokens;
}

const work = mkdtempSync(join(tmpdir(), "image-tokens-"));
try {
  const size = (path: string) => execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" }).match(/\d+/g)!.slice(-2).join("x");
  const baseline: number[] = [];
  for (let i = 0; i < repeats; i++) baseline.push(await promptTokens());
  console.log(`model ${model}; text-only prompt tokens: ${baseline.join(", ")}`);
  const [width] = size(png).split("x").map(Number);
  for (const scale of [1, 0.5, 0.25]) {
    const path = scale === 1 ? png : join(work, `scaled-${scale}.png`);
    if (scale !== 1) execFileSync("sips", ["-Z", String(Math.round(width! * scale)), png, "--out", path], { stdio: "ignore" });
    const data = readFileSync(path).toString("base64");
    const costs: number[] = [];
    for (let i = 0; i < repeats; i++) costs.push(await promptTokens(data) - baseline[0]!);
    console.log(`${size(path).padEnd(10)} scale ${String(scale).padEnd(4)} image input tokens: ${costs.join(", ")}  (${data.length} base64 chars)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
