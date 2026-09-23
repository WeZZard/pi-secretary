/**
 * Plan Phase 3: run a hand-written plan with real input and code-evaluated postconditions,
 * without any model. Each step names its target element directly, which is the decision the
 * executor will make in Phase 4. Output goes to a new directory under test-results/.
 *
 *   node --experimental-strip-types scripts/computer-use/scripted-plan.ts <plan.json>
 *
 * plan.json: { "app": "TextEdit", "windowTitle": "scratch.txt", "steps": [
 *   { "id": "select", "operation": "key_combo", "keys": "cmd+a", "postcondition": { "changed": true } },
 *   { "id": "type", "operation": "enter_text", "target": "Text", "text": "Hello", "postcondition": { "value": { "name": "Hello", "equals": "Hello" } } } ] }
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { actionsFor, type ActuatorRequest, type Operation } from "../../extensions/secretary/computer-use/actuator.ts";
import { cuaDriverRunner, LocalDriverBackend, lsappinfoFrontmost } from "../../extensions/secretary/computer-use/backend/local-backend.ts";
import type { WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import { observe, type Observation } from "../../extensions/secretary/computer-use/observer.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";
import { evaluatePostcondition, validatePostcondition, type Postcondition } from "../../extensions/secretary/computer-use/verifier.ts";

/** `target` names an element by prefix; `targetGroup` names a group by prefix, for scrolling its container. */
interface Step { id: string; operation: Operation; target?: string; targetGroup?: string; text?: string; keys?: string; postcondition: Postcondition }
const plan = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as { app: string; windowTitle?: string; settleMs?: number; steps: Step[] };
for (const step of plan.steps) {
  const problem = validatePostcondition(step.postcondition);
  if (problem) { console.error(`Step ${step.id}: ${problem}`); process.exit(2); }
}
const config = defaultComputerUseConfiguration();
const out = resolve("test-results/computer-use", `scripted-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const backend = new LocalDriverBackend({ run: cuaDriverRunner(process.env.CUA_DRIVER ?? config.localDriverPath), maxTreeNodes: config.maxTreeNodes, foregroundDelivery: config.foregroundDelivery, frontmostPid: lsappinfoFrontmost });
const telemetry = new Telemetry(out);
const target = { app: plan.app, ...(plan.windowTitle ? { windowTitle: plan.windowTitle } : {}) };
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
let sequence = 0;
async function look(purpose: string): Promise<{ read: WindowRead; observation: Observation }> {
  const read = await backend.readWindow(target, { screenshot: false });
  const result = observe(read, { id: `${String(++sequence).padStart(2, "0")}-${purpose}`, maxElements: config.maxElements, maxNameLength: config.maxNameLength });
  await telemetry.recordObservation(read, result, { attempt: 1, purpose });
  if (result.status !== "ready") throw new Error(`${purpose}: ${result.status}: ${result.detail}`);
  return { read, observation: result };
}

const rows: string[] = [];
let before = await look("initial");
let failed = false;
for (const step of plan.steps) {
  const started = performance.now();
  try {
    const element = step.target === undefined ? undefined
      : before.observation.groups.flatMap(group => group.elements).find(candidate => candidate.name.toLowerCase().startsWith(step.target!.toLowerCase()));
    if (step.target !== undefined && !element) throw new Error(`no kept element named ${JSON.stringify(step.target)}`);
    const group = step.targetGroup === undefined ? undefined
      : before.observation.groups.find(candidate => candidate.name.toLowerCase().startsWith(step.targetGroup!.toLowerCase()));
    if (step.targetGroup !== undefined && !group?.frame) throw new Error(`no scrollable group named ${JSON.stringify(step.targetGroup)}`);
    const frame = element?.frame ?? group?.frame;
    const request = { operation: step.operation, ...(frame ? { frame } : {}), ...(step.text !== undefined ? { text: step.text } : {}),
      ...(step.keys !== undefined ? { keys: step.keys } : {}) } as ActuatorRequest;
    const outcomes = [];
    for (const action of actionsFor(request)) outcomes.push((await backend.act(before.read.window, action)).kind);
    await wait(plan.settleMs ?? config.settleMs);
    const after = await look(`after-${step.id}`);
    const evaluation = evaluatePostcondition(step.postcondition, after.read, before.read);
    rows.push(`| ${step.id} | ${step.operation}${element ? ` ${JSON.stringify(element.name)}` : group ? ` in ${group.name}` : ""} | ${[...new Set(outcomes)].join(", ")} | ${evaluation.holds ? "holds" : "**fails**"}: ${evaluation.detail} | ${Math.round(performance.now() - started)} ms |`);
    before = after;
    if (!evaluation.holds) { failed = true; break; }
  } catch (error) {
    rows.push(`| ${step.id} | ${step.operation} | error | **${(error as Error).message}** | ${Math.round(performance.now() - started)} ms |`);
    failed = true;
    break;
  }
}
const text = `# Scripted plan\n\n${plan.app}${plan.windowTitle ? ` / ${plan.windowTitle}` : ""}, settle ${plan.settleMs ?? config.settleMs} ms. Step time is wall clock from the first action to the evaluated postcondition, including the verifying observation.\n\n| Step | Action | Driver outcome | Postcondition | Step time |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\nResult: ${failed ? "stopped at a failed step" : "all steps verified"}.\n`;
writeFileSync(join(out, "report.md"), text);
console.log(text);
console.log(`Output: ${out}`);
process.exit(failed ? 1 : 0);
