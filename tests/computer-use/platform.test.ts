import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBackend } from "../../extensions/secretary/computer-use/backend/fake-backend.ts";
import { defaultComputerUseConfiguration } from "../../extensions/secretary/computer-use/configuration.ts";
import type { DecisionRequestBody, DecisionResponse } from "../../extensions/secretary/computer-use/executor-client.ts";
import { runPlan } from "../../extensions/secretary/computer-use/harness.ts";
import { observe, platformView, type Observation } from "../../extensions/secretary/computer-use/observer.ts";
import { Telemetry } from "../../extensions/secretary/computer-use/telemetry.ts";
import { executeObserve } from "../../extensions/secretary/computer-use/tools/observe.ts";
import { executeRunPlan } from "../../extensions/secretary/computer-use/tools/run-plan.ts";
import { simulatorRead, textEditRead } from "./fixtures/trees.ts";

/** Plan phase 1.4: the platform of each element (design §6.5, decision PS-D6). */

const options = { id: "obs-1", maxElements: 240, maxNameLength: 48 };
const simulator = () => observe({ ...simulatorRead(), readMs: 0 }, options) as Observation;
const namesOf = (observation: Observation, platform: string) => observation.groups.filter(group => group.platform === platform).flatMap(group => group.elements.map(element => element.name));

test("in the Simulator, the device screen's elements are iOS, and the menu bar, toolbar, title and hardware buttons are macOS", () => {
  const observation = simulator();
  assert.deepEqual(namesOf(observation, "ios").sort(), ["App Clips", "Search", "Search Engine", "Settings", "Show Recent Searches"]);
  assert.deepEqual(namesOf(observation, "macos").sort(), ["Action", "Device", "Home", "Rotate", "Save Screen", "Sleep/Wake", "Volume Down", "Volume Up", "iPhone 17"]);
  for (const group of observation.groups) assert.ok(group.elements.every(element => element.platform === group.platform), `${group.name} mixes platforms`);
  assert.deepEqual(observation.groups.map(group => group.name), ["menu bar", "toolbar", "iOS screen", "content"]);
});

test("an ordinary window is macOS and stays one group", () => {
  const observation = observe({ ...textEditRead(), readMs: 0 }, options) as Observation;
  assert.deepEqual(observation.groups.map(group => [group.name, group.platform]), [["window", "macos"]]);
});

test("the executor is offered only macOS groups", () => {
  const view = platformView(simulator(), "macos");
  assert.ok(!view.groups.some(group => group.name === "iOS screen"));
  assert.ok(namesOf(view, "macos").includes("Home"));
});

function tools(t: TestContext, reads: ReturnType<typeof simulatorRead>[]) {
  const root = mkdtempSync(join(tmpdir(), "secretary-platform-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bodies: DecisionRequestBody[] = [];
  const executor = { decide: async (body: DecisionRequestBody): Promise<DecisionResponse> => {
    bodies.push(body);
    return { roundTripMs: 1, answers: { operation: { choice: "abstain", confidence: 0.9 } } };
  } };
  const backend = new FakeBackend({ Simulator: reads });
  const deps = { backend, executor, telemetry: new Telemetry(root), config: { ...defaultComputerUseConfiguration(), settleMs: 0 }, sleep: async () => {} };
  return { deps, backend, bodies };
}

test("a Simulator window without its device screen is read once more, and the planner is told iOS targets are not supported", async (t) => {
  const { deps, backend } = tools(t, [simulatorRead({ screen: false }), simulatorRead()]);
  const result = await executeObserve({ ...deps, remember: () => {} }, { app: "Simulator" }, false);
  const text = (result.content[0] as { text: string }).text;
  assert.equal(backend.reads.length, 2);
  assert.match(text, /The iOS screen group is the Simulator's device screen\. iOS targets are not supported yet/);
  assert.match(text, /iOS screen:\n {2}A Button "Settings"/);
});

test("a plan whose step names an iOS control is rejected before any action", async (t) => {
  const { deps, backend } = tools(t, [simulatorRead()]);
  const observation = simulator();
  const result = await executeRunPlan({ deps, observation: () => observation, escalations: { used: 0, limit: 5, record: () => {} } },
    { app: "Simulator", based_on: "obs-1", goal: "Open Search Engine", steps: [{ id: "engine", intent: "Tap Search Engine", control: { name: "Search Engine" }, postcondition: { exists: { name: "Google" } } }] });
  assert.equal(result.details.rule, "ios_target");
  assert.match((result.content[0] as { text: string }).text, /"Search Engine" is on the iOS screen of the Simulator, and iOS targets are not supported yet/);
  assert.equal(backend.actions.length, 0);
});

test("at run time a step naming an iOS control stops, and the executor never sees the iOS screen", async (t) => {
  const { deps, backend, bodies } = tools(t, [simulatorRead()]);
  const stopped = await runPlan(deps, { target: { app: "Simulator" }, goal: "g", allowDestructive: [],
    steps: [{ id: "s", intent: "Tap Settings", control: { name: "Settings", role: "Button" }, postcondition: { exists: { name: "General" } } }] });
  assert.equal(stopped.escalation?.reason, "target_not_found");
  assert.match(stopped.escalation!.detail, /iOS targets are not supported yet/);
  assert.equal(bodies.length, 0);
  await runPlan(deps, { target: { app: "Simulator" }, goal: "g", allowDestructive: [],
    steps: [{ id: "s", intent: "Go home", postcondition: { exists: { name: "Maps" } } }] });
  assert.doesNotMatch(String((bodies[0]!.state as Record<string, unknown>).elements), /Search Engine/);
  assert.match(String((bodies[0]!.state as Record<string, unknown>).elements), /"Home"/);
  assert.equal(backend.actions.length, 0);
});
