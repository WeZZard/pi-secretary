import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverySession } from "../support/discovery-session.ts";

test("new dynamic agents inherit the current parent model after a switch", async t => {
  const h = await discoverySession(t, {
    modelIds: ["startup", "selected", "settings-default"],
    setup: async (_root, agentDir) => {
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        defaultProvider: "discovery-test", defaultModel: "settings-default",
        compaction: { enabled: false }, retry: { enabled: false },
      }));
    },
    respond: async (_context, index) => index % 2 === 0
      ? [{ type: "toolCall", name: "Agent", id: `launch-${index}`, arguments: {
        description: "Model inheritance probe", prompt: "Return fixture result", run_in_background: false,
      } }]
      : [{ type: "text", text: "Done" }],
  });
  await h.session.prompt("Delegate before switching");
  await h.session.setModel(h.models[1]!);
  await h.session.prompt("Delegate after switching");
  assert.deepEqual(h.parentModels, ["discovery-test/startup", "discovery-test/startup", "discovery-test/selected", "discovery-test/selected"]);
  assert.deepEqual(h.childModels, ["discovery-test/startup", "discovery-test/selected"]);
  assert.equal(h.session.model?.id, "selected");
  assert.equal(h.session.messages.filter(m => m.role === "toolResult" && m.isError).length, 0);
});

test("a captured superior definition explains a different model without any parent switch", async t => {
  let definitionPath = "";
  const definition = (model?: string) => `---\nname: general-purpose\ndescription: Incident-shaped model probe\n${model ? `model: ${model}\n` : ""}---\n`;
  const h = await discoverySession(t, {
    modelIds: ["main", "default"],
    setup: async (_root, dir) => {
      await mkdir(join(dir, "agents"));
      definitionPath = join(dir, "agents", "general-purpose.md");
      await writeFile(definitionPath, definition("superior"));
      await writeFile(join(dir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { superior: ["discovery-test/default"] } } }));
    },
    respond: async (_context, index) => index % 2 === 0
      ? [{ type: "toolCall", name: "Agent", id: `launch-${index}`, arguments: {
        description: "Definition-policy probe", prompt: "Return fixture result", run_in_background: false,
      } }]
      : [{ type: "text", text: "Done" }],
  });
  await h.session.prompt("Delegate with the recorded incident definition.");
  assert.deepEqual(h.childModels, ["discovery-test/default"], "the definition override wins even when Agent omits model");
  await writeFile(definitionPath, definition()); // Change only the definition's model policy.
  await h.session.prompt("Delegate after removing the definition override.");
  assert.deepEqual(h.parentModels, Array(4).fill("discovery-test/main"));
  assert.deepEqual(h.childModels, ["discovery-test/default", "discovery-test/main"]);
  assert.equal(h.session.messages.filter(m => m.role === "toolResult" && m.isError).length, 0);
});

for (const scenario of [
  { label: "definition inherit", definition: "inherit", expected: "selected" },
  { label: "explicit definition model", definition: "definition-model", expected: "definition-model" },
  { label: "tool override of definition model", definition: "definition-model", requested: "tool-model", expected: "tool-model" },
  { label: "tool inherit overrides explicit definition model", definition: "definition-model", requested: "inherit", expected: "selected" },
]) {
  test(`current-model inheritance preserves ${scenario.label}`, async t => {
    const exact = (value: string) => value === "inherit" ? value : `discovery-test/${value}`;
    const h = await discoverySession(t, {
      modelIds: ["startup", "selected", "definition-model", "tool-model"],
      setup: async (_root, dir) => {
        await mkdir(join(dir, "agents"));
        await writeFile(join(dir, "agents", "worker.md"), `---\nname: worker\ndescription: Model probe\nmodel: ${exact(scenario.definition)}\n---\n`);
      },
      respond: async (_context, index) => index === 0
        ? [{ type: "toolCall", name: "Agent", id: "launch", arguments: {
          subagent_type: "worker", description: "Model precedence probe", prompt: "Return fixture result",
          ...(scenario.requested ? { model: exact(scenario.requested) } : {}), run_in_background: false,
        } }]
        : [{ type: "text", text: "Done" }],
    });
    await h.session.setModel(h.models[1]!);
    await h.session.prompt("Delegate after switching");
    assert.deepEqual(h.parentModels, ["discovery-test/selected", "discovery-test/selected"]);
    assert.deepEqual(h.childModels, [`discovery-test/${scenario.expected}`]);
    assert.equal(h.session.messages.filter(m => m.role === "toolResult" && m.isError).length, 0);
  });
}
