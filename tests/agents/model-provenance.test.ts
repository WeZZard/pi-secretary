import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverySession } from "../support/discovery-session.ts";

/**
 * Reproducer for the 2026-09-21 discord-session incident: a definition that names a
 * fallback list whose first available candidate is the parent's current model launches
 * a child on the parent model. That outcome is a correct §5.3 resolution, but the
 * launch result must say where the model came from — an unexplained `Model: X` line is
 * indistinguishable from silent inheritance.
 */
async function provenanceLaunch(t: test.TestContext, options: {
  definitionModel?: string;
  lists: Record<string, string[]>;
  requestedModel?: string;
}) {
  const h = await discoverySession(t, {
    modelIds: ["main", "alt-a", "alt-b"],
    setup: async (_root, dir) => {
      await mkdir(join(dir, "agents"));
      await writeFile(join(dir, "agents", "worker.md"),
        `---\nname: worker\ndescription: Model provenance probe\n${options.definitionModel ? `model: ${options.definitionModel}\n` : ""}---\n`);
      await writeFile(join(dir, "secretary.json"),
        JSON.stringify({ agents: { modelFallbackLists: options.lists } }));
    },
    respond: async (_context, index) => index === 0
      ? [{ type: "toolCall", name: "Agent", id: "launch", arguments: {
        subagent_type: "worker", description: "Provenance probe", prompt: "Return fixture result",
        ...(options.requestedModel ? { model: options.requestedModel } : {}), run_in_background: false,
      } }]
      : [{ type: "text", text: "Done" }],
  });
  await h.session.prompt("Delegate the probe");
  const toolResults = h.session.messages.filter(m => m.role === "toolResult");
  assert.equal(toolResults.filter(m => m.isError).length, 0, "No tool errors");
  const text = toolResults.map(m => (m.content as { type: string; text?: string }[]).map(c => c.text ?? "").join("\n")).join("\n");
  return { ...h, text };
}

test("a definition list starting with the parent model is reported as a list resolution, not inheritance", async t => {
  const h = await provenanceLaunch(t, {
    definitionModel: "computer-use",
    lists: { "computer-use": ["discovery-test/main", "discovery-test/alt-a", "discovery-test/alt-b"] },
  });
  assert.deepEqual(h.childModels, ["discovery-test/main"],
    "The incident symptom: the child runs the parent's model because it is the list's first candidate");
  assert.match(h.text, /Model: discovery-test\/main \(definition list 'computer-use', candidate 1\/3\)/,
    "The launch result states the resolution source, list name, and candidate position");
});

test("a definition list starting with another model selects that model and says so", async t => {
  const h = await provenanceLaunch(t, {
    definitionModel: "computer-use",
    lists: { "computer-use": ["discovery-test/alt-a", "discovery-test/main"] },
  });
  assert.deepEqual(h.childModels, ["discovery-test/alt-a"], "The definition's model policy wins over inheritance");
  assert.match(h.text, /Model: discovery-test\/alt-a \(definition list 'computer-use', candidate 1\/2\)/);
});

test("an inherit definition is labeled as inheritance", async t => {
  const h = await provenanceLaunch(t, {
    definitionModel: "inherit",
    lists: { "computer-use": ["discovery-test/alt-a"] },
  });
  assert.deepEqual(h.childModels, ["discovery-test/main"]);
  assert.match(h.text, /Model: discovery-test\/main \(inherited from the parent model\)/,
    "Real inheritance carries its own label, distinct from a list resolution");
});

test("an invocation override is labeled with the invocation source", async t => {
  const h = await provenanceLaunch(t, {
    definitionModel: "computer-use",
    lists: {
      "computer-use": ["discovery-test/alt-a"],
      fast: ["discovery-test/alt-b", "discovery-test/main"],
    },
    requestedModel: "fast",
  });
  assert.deepEqual(h.childModels, ["discovery-test/alt-b"], "The invocation value wins over the definition");
  assert.match(h.text, /Model: discovery-test\/alt-b \(invocation list 'fast', candidate 1\/2\)/);
});

test("skipped candidates and the selected position survive on the run record's result", async t => {
  const h = await provenanceLaunch(t, {
    definitionModel: "computer-use",
    lists: { "computer-use": ["discovery-test/missing", "discovery-test/alt-a"] },
  });
  assert.deepEqual(h.childModels, ["discovery-test/alt-a"], "The unavailable first candidate is skipped");
  assert.match(h.text, /Model: discovery-test\/alt-a \(definition list 'computer-use', candidate 2\/2\)/);
  assert.match(h.text, /Fallback: skipped discovery-test\/missing \(model unavailable\)/,
    "Every result surface states which candidates were skipped and why, not only the background launch line");
});
