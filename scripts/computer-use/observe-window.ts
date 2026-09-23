/**
 * Manual check for plan Phase 1: observe one open window through the local cua-driver backend.
 * It only reads; it never launches, focuses, or clicks. Output goes to a new directory under
 * test-results/computer-use/, because window contents can contain personal data.
 *
 *   node --experimental-strip-types scripts/computer-use/observe-window.ts <App> [window title] [--screenshot]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cuaDriverRunner, LocalDriverBackend } from "../../extensions/secretary/computer-use/backend/local-backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";
import { executeObserve } from "../../extensions/secretary/computer-use/tools/observe.ts";

const args = process.argv.slice(2);
const screenshot = args.includes("--screenshot");
const [app, title] = args.filter(arg => arg !== "--screenshot");
if (!app) { console.error("usage: observe-window.ts <App> [window title] [--screenshot]"); process.exit(2); }

const config = { ...defaultComputerUseConfiguration(), backend: "local" as const, allowLocalDesktop: true };
const out = resolve("test-results/computer-use", `observe-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const backend = new LocalDriverBackend({ run: cuaDriverRunner(config.localDriverPath), maxTreeNodes: config.maxTreeNodes });
const result = await executeObserve({ backend, config, telemetry: new Telemetry(out), remember: () => {} },
  { app, ...(title ? { window_title: title } : {}) }, screenshot);
for (const part of result.content) {
  if (part.type === "text") console.log(part.text);
  else { writeFileSync(join(out, "screenshot.png"), Buffer.from(part.data, "base64")); console.log(`[screenshot written, ${part.data.length} base64 characters]`); }
}
writeFileSync(join(out, "details.json"), `${JSON.stringify(result.details, null, 1)}\n`);
console.log(`\nOutput: ${out}`);
