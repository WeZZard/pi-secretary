import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RawElement, WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { FakeBackend } from "../../extensions/secretary/computer-use/backend/fake-backend.ts";
import type { DecisionRequestBody, DecisionResponse } from "../../extensions/secretary/computer-use/executor-client.ts";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { discoverySession } from "../support/discovery-session.ts";
import delegationFixtureExtension from "./support/delegation-fixture-extension.ts";

/** Plan Phase 6: a parent delegates to the computer-use definition template through the real SDK. */

const fixtureModule = resolve(import.meta.dirname, "support/delegation-fixture-extension.ts");
const template = resolve(import.meta.dirname, "../../extensions/secretary/computer-use/templates/computer-use.md");

function calculator(controls: string[]): Omit<WindowRead, "readMs"> {
  const elements: RawElement[] = [{ element_index: 0, role: "AXWindow", label: "Calculator", depth: 0, frame: { x: 0, y: 0, w: 400, h: 600 } }];
  controls.forEach((name, i) => elements.push({ element_index: i + 1, role: "AXButton", label: name, parent_index: 0, depth: 1,
    frame: { x: 20, y: 40 + i * 40, w: 60, h: 30 } }));
  return { window: { pid: 3, windowId: 9, app: "Calculator", title: "Calculator" }, appActive: true, truncated: false, elements };
}

/** Answers every element question with the control named "All Clear", and chooses click. */
const executor = { decide: async (body: DecisionRequestBody): Promise<DecisionResponse> => {
  const table = String((body.state as { elements: string }).elements);
  const letter = table.split("\n").find(line => line.includes("All Clear"))?.trim()[0] ?? "none";
  const answers: DecisionResponse["answers"] = { operation: { choice: "click", confidence: 0.9 }, risk: { choice: "safe", confidence: 0.9 } };
  for (const id of Object.keys(body.questions)) if (id.startsWith("element")) answers[id] = { choice: letter, confidence: 0.9 };
  return { roundTripMs: 1, answers };
} };

test("a parent delegates a desktop task to the computer-use template, which runs with only the computer-use tools", async t => {
  const before = calculator(["All Clear", "7"]), after = calculator(["Clear", "7"]);
  const backend = new FakeBackend({ Calculator: [before, before, after] });
  const telemetryRoot = await mkdtemp(join(tmpdir(), "secretary-cu-"));
  (globalThis as { computerUseDelegationFixture?: unknown }).computerUseDelegationFixture = { backend, executor, root: telemetryRoot };
  t.after(async () => {
    delete (globalThis as { computerUseDelegationFixture?: unknown }).computerUseDelegationFixture;
    await rm(telemetryRoot, { recursive: true, force: true });
  });
  let observationId = "";
  // The template sets background: true, and background agents need an interactive or RPC parent.
  const h = await discoverySession(t, {
    mode: "rpc",
    modelIds: ["main", "planner"],
    setup: async (_root, agentDir) => {
      await mkdir(join(agentDir, "agents"));
      await writeFile(join(agentDir, "agents", "computer-use.md"), await readFile(template, "utf8"));
      // Child sessions discover extensions from the agent directory, as real Pi loads installed packages.
      await mkdir(join(agentDir, "extensions"));
      await writeFile(join(agentDir, "extensions", "computer-use-fixture.ts"), `export { default } from ${JSON.stringify(fixtureModule)};\n`);
      await writeFile(join(agentDir, "secretary.json"), JSON.stringify({
        agents: { modelFallbackLists: { "computer-use": ["discovery-test/planner"] }, subagentModels: { "computer-use": "computer-use" } },
        computerUse: { backend: "local", allowLocalDesktop: true, executorUrl: "http://127.0.0.1:1/never" },
      }));
    },
    // A child's tools are the parent's tools intersected with its allowlist (subagent architecture
    // Section 5), so the parent installs the same computer-use tools and relay stand-in.
    extension: delegationFixtureExtension,
    respond: async (_context, index) => index === 0
      ? [{ type: "toolCall", name: "Agent", id: "launch", arguments: {
        subagent_type: "computer-use", description: "Clear Calculator", prompt: "In Calculator, press All Clear.", run_in_background: true } }]
      : [{ type: "text", text: "Delegated." }],
    respondChild: async (context, index) => {
      if (index === 0) return [{ type: "toolCall", name: "computer_observe", id: "observe", arguments: { app: "Calculator", window_title: "Calculator" } }];
      if (index === 1) {
        const result = context.messages.at(-1) as { content: { type: string; text?: string }[] };
        observationId = /Observation: (obs-[0-9a-f]+)/.exec(result.content.map(part => part.text ?? "").join(""))?.[1] ?? "";
        return [{ type: "toolCall", name: "computer_run_plan", id: "plan", arguments: { app: "Calculator", window_title: "Calculator",
          based_on: observationId, goal: "Clear the display", steps: [{ id: "clear", intent: "Press All Clear", postcondition: { exists: { name: "Clear" } } }] } }];
      }
      return [{ type: "text", text: "Completed. Verified by code: \"Clear\" is on screen." }];
    },
  });
  await h.session.prompt("Clear the calculator.");
  const repo = new AgentRepository(h.engine.db.connection);
  const run = () => repo.runs(h.manager.getSessionId())[0];
  const deadline = Date.now() + 5000;
  while (!["succeeded", "failed", "cancelled", "partial"].includes(run()?.status ?? "")) {
    assert.ok(Date.now() < deadline, "the computer-use run did not finish");
    await new Promise(done => setTimeout(done, 5));
  }

  assert.match(observationId, /^obs-/, "The child observed the window before planning");
  assert.deepEqual(h.childModels, Array(3).fill("discovery-test/planner"), "agents.subagentModels resolves the computer-use fallback list");
  assert.match(h.childCalls[0]!.systemPrompt ?? "", /only the items the tool listed under "Verified by code after the step"/, "The template's instructions reach the child");
  assert.ok(h.parentCalls[0]!.tools?.some(tool => tool.name === "relay"), "The relay tool exists in the user's sessions");
  for (const call of h.childCalls) {
    assert.deepEqual(call.tools?.map(tool => tool.name).sort(), ["computer_observe", "computer_run_plan"], "The allowlist bounds the child");
  }
  const planResult = h.childCalls[2]!.messages.at(-1) as { content: { text?: string }[] };
  assert.match(planResult.content.map(part => part.text ?? "").join(""), /^Outcome: completed\. Executor decisions: 1\. Actions: 1\./);
  assert.deepEqual(backend.actions.map(entry => entry.action.kind), ["click"]);
  assert.deepEqual(backend.reads[1], { app: "Calculator", windowTitle: "Calculator", windowId: 9, single: true }, "The plan acts on the observed window");
  assert.equal(run()!.background, true, "The definition runs in the background");
  assert.equal(run()!.status, "succeeded");
  assert.match(run()!.output, /Verified by code: "Clear" is on screen/, "The parent receives the child's report");
});
