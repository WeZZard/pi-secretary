/**
 * Plan Phase 5 live check: run one computer_run_plan input through the real executor, the local
 * cua-driver backend and the live grounder, exactly as the tool would, and print the tool's
 * result text. Records go to a new directory under test-results/.
 *
 *   CUA_DRIVER=… node --experimental-strip-types scripts/computer-use/run-plan-live.ts <plan.json> [grounder-url]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { cuaDriverRunner, LocalDriverBackend, lsappinfoFrontmost } from "../../extensions/secretary/computer-use/backend/local-backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import { DecisionServiceClient } from "../../extensions/secretary/computer-use/decision-service-client.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";
import { executeRunPlan } from "../../extensions/secretary/computer-use/tools/run-plan.ts";

const [planPath, url = "http://jev.home.arpa"] = process.argv.slice(2);
if (!planPath) { console.error("usage: run-plan-live.ts <plan.json> [grounder-url]"); process.exit(2); }
const params = JSON.parse(readFileSync(planPath, "utf8"));
const config = { ...defaultComputerUseConfiguration(), backend: "local" as const, allowLocalDesktop: true, executorUrl: url, executorTimeoutMs: 60_000 };
const out = resolve("test-results/computer-use", `run-plan-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const backend = new LocalDriverBackend({ run: cuaDriverRunner(process.env.CUA_DRIVER ?? config.localDriverPath), maxTreeNodes: config.maxTreeNodes, foregroundDelivery: config.foregroundDelivery, frontmostPid: lsappinfoFrontmost });
const result = await executeRunPlan({
  deps: { backend, grounder: new DecisionServiceClient({ baseUrl: url, timeoutMs: config.executorTimeoutMs }), telemetry: new Telemetry(out), config },
  observation: () => undefined, escalations: { used: 0, limit: config.maxEscalationsPerRun, record: () => {} },
}, params);
const text = (result.content[0] as { text: string }).text;
writeFileSync(join(out, "result.md"), `${text}\n\n${JSON.stringify(result.details)}\n`);
console.log(text);
console.log(`\nOutput: ${out}`);
