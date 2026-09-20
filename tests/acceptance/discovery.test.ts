import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { discoverySession } from "../support/discovery-session.ts";
import { runFeatures, type ScenarioBindings } from "./support.ts";

function catalog(context: Context) {
  const message = context.messages.at(-1)!;
  const content = typeof message.content === "string" ? message.content : message.content.filter(b => b.type === "text").map(b => b.text).join("");
  assert.match(content, /^<secretary-runtime-state>/);
  const data = JSON.parse(content.slice("<secretary-runtime-state>".length, -"</secretary-runtime-state>".length));
  return data.contributions.find((c: any) => c.id === "secretary.agent-catalog").data;
}
async function define(dir: string, description: string, prompt = "PRIVATE_ROLE") {
  await mkdir(join(dir, "agents"), { recursive: true });
  await writeFile(join(dir, "agents", "custom.md"), `---\nname: custom\ndescription: ${description}\ntools: [read]\n---\n${prompt}`);
}
const call = (id: string) => ({ type: "toolCall" as const, id, name: "Agent",
  arguments: { subagent_type: "custom", description: "Read fixture", prompt: "Return fixture result", run_in_background: false } });
const bindings: ScenarioBindings = {
  "ACC-SA-13-01": async ({ t }) => {
    const h = await discoverySession(t, { setup: async (_root, dir) => define(dir, "Installed custom description") });
    const prompt = "Describe delegation types.";
    await h.session.prompt(prompt);
    assert.equal(catalog(h.parentCalls[0]!).definitions.find((d: any) => d.type === "custom").description, "Installed custom description");
    assert.equal(h.session.messages.filter(m => m.role === "toolResult").length, 0);
    assert.equal(h.childCalls.length, 0);
    assert.doesNotMatch(await readFile(h.session.sessionFile!, "utf8"), /<secretary-runtime-state>/);
    assert.deepEqual(h.session.messages.find(m => m.role === "user")?.content, [{ type: "text", text: prompt }]);
  },
  "ACC-SA-13-02": async ({ t }) => {
    let directory = "";
    const h = await discoverySession(t, { setup: async (_root, dir) => { directory = dir; await define(dir, "Original", "ORIGINAL_ROLE"); },
      respond: async (_context, index) => {
        if (index === 0) { await define(directory, "Edited", "EDITED_ROLE"); return [call("left"), call("right")]; }
        return [{ type: "text", text: "Observed results." }];
      } });
    await h.session.prompt("Delegate twice.");
    assert.equal(h.childCalls.length, 2);
    for (const request of h.childCalls) assert.match(request.systemPrompt ?? "", /ORIGINAL_ROLE/);
    assert.equal(catalog(h.parentCalls[1]!).definitions.find((d: any) => d.type === "custom").description, "Edited");
    for (const result of h.session.messages.filter(m => m.role === "toolResult")) {
      assert.equal(result.isError, false); assert.equal(result.details.status, "succeeded");
    }
  },
  "ACC-SA-13-03": async ({ t }) => {
    let directory = "";
    const h = await discoverySession(t, { setup: async (_root, dir) => {
      directory = dir; await define(dir, "Invalid"); await writeFile(join(dir, "agents", "custom.md"), "not a definition");
    }, respond: async (_context, index) => index % 2 === 0 ? [call(`attempt-${index}`)] : [{ type: "text", text: "Done." }] });
    await h.session.prompt("Try delegation.");
    assert.equal(catalog(h.parentCalls[0]!).status, "unavailable");
    assert.equal(h.childCalls.length, 0);
    await define(directory, "Repaired");
    await h.session.prompt("Try again.");
    assert.equal(h.childCalls.length, 1);
    assert.deepEqual(h.session.messages.filter(m => m.role === "toolResult").map(m => m.isError), [true, false]);
  },
};

runFeatures(["agent-discovery"], bindings, { "agent-discovery": "6aa8e532c89302a79586b49fa39cdb7e7f2ce514f6ddf92f7ae30f39a1574ccb" });
