import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverAgents } from "../../extensions/secretary/agents/registry.ts";
import { discoverySession } from "../support/discovery-session.ts";

const definition = (thinking?: string) => `---\nname: general-purpose\ndescription: Thinking probe\n${thinking ? `thinking: ${thinking}\n` : ""}---\n`;
const launch = (index: number) => index % 2 === 0
  ? [{ type: "toolCall" as const, name: "Agent", id: `launch-${index}`, arguments: { description: "Thinking probe", prompt: "Return fixture result", run_in_background: false } }]
  : [{ type: "text" as const, text: "Done" }];

test("a definition's thinking field replaces the parent's thinking level for the child", async t => {
  let definitionPath = "";
  const h = await discoverySession(t, {
    reasoning: true,
    setup: async (_root, dir) => {
      await mkdir(join(dir, "agents"));
      definitionPath = join(dir, "agents", "general-purpose.md");
      await writeFile(definitionPath, definition("low"));
    },
    respond: async (_context, index) => launch(index),
  });
  h.session.setThinkingLevel("high");
  await h.session.prompt("Delegate with the definition's thinking level.");
  await writeFile(definitionPath, definition());
  await h.session.prompt("Delegate after removing the thinking field.");
  assert.deepEqual(h.childReasoning, ["low", "high"], "the definition wins; without it the child inherits the parent");
  assert.equal(h.session.messages.filter(m => m.role === "toolResult" && m.isError).length, 0);
});

test("thinking off sends no reasoning request to the child's model", async t => {
  const h = await discoverySession(t, {
    reasoning: true,
    setup: async (_root, dir) => {
      await mkdir(join(dir, "agents"));
      await writeFile(join(dir, "agents", "general-purpose.md"), definition("off"));
    },
    respond: async (_context, index) => launch(index),
  });
  h.session.setThinkingLevel("high");
  await h.session.prompt("Delegate with thinking off.");
  assert.deepEqual(h.childReasoning, [undefined]);
});

test("the registry rejects a thinking value pi does not define", async t => {
  const h = await discoverySession(t, { setup: async (_root, dir) => {
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", "general-purpose.md"), definition("none"));
  } });
  assert.throws(() => discoverAgents(h.root, h.agentDir, true), /thinking must be one of off, minimal, low, medium, high, xhigh, max/);
});
