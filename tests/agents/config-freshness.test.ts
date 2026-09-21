import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { discoverySession } from "../support/discovery-session.ts";
import { SecretaryConfigMenu } from "../../extensions/secretary/agents/ui/config-menu.ts";

/**
 * Freshness review for the 2026-09-21 follow-up: a fallback list edited just before a
 * launch. The read side re-reads secretary.json on every request, so a persisted edit
 * lands in the next launch. The write side must not silently revert a newer edit made
 * after the menu loaded its in-memory copy.
 */

test("an on-disk list edit between turns resolves in the very next launch", async t => {
  const h = await discoverySession(t, {
    modelIds: ["main", "alt-a"],
    setup: async (_root, dir) => {
      await mkdir(join(dir, "agents"));
      await writeFile(join(dir, "agents", "worker.md"),
        "---\nname: worker\ndescription: Freshness probe\nmodel: computer-use\n---\n");
      await writeFile(join(dir, "secretary.json"),
        JSON.stringify({ agents: { modelFallbackLists: { "computer-use": ["discovery-test/main", "discovery-test/alt-a"] } } }));
    },
    respond: async (_context, index) => index % 2 === 0
      ? [{ type: "toolCall", name: "Agent", id: `launch-${index}`, arguments: {
        subagent_type: "worker", description: "Freshness probe", prompt: "Return fixture result", run_in_background: false,
      } }]
      : [{ type: "text", text: "Done" }],
  });
  await h.session.prompt("Delegate before the edit");
  await writeFile(join(h.agentDir, "secretary.json"),
    JSON.stringify({ agents: { modelFallbackLists: { "computer-use": ["discovery-test/alt-a", "discovery-test/main"] } } }));
  await h.session.prompt("Delegate after the edit");
  assert.deepEqual(h.childModels, ["discovery-test/main", "discovery-test/alt-a"],
    "A persisted edit lands in the next request's resolution; the catalog is captured fresh per request");
  assert.equal(h.session.messages.filter(m => m.role === "toolResult" && m.isError).length, 0);
});

test("a menu action does not revert a newer edit made after the menu loaded", t => {
  const dir = mkdtempSync(join(tmpdir(), "secretary-menu-freshness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const file = () => JSON.parse(readFileSync(join(agentDir, "secretary.json"), "utf8"));
  const seed = { agents: { modelFallbackLists: { "computer-use": ["p/old-head", "p/two"], cheap: ["q/three"] } } };
  writeFileSync(join(agentDir, "secretary.json"), JSON.stringify(seed));
  const menu = new SecretaryConfigMenu({ agentDir, models: () => ["p/old-head", "p/two", "p/new-head", "q/three"], onDismiss: () => {} });
  // A newer edit lands after the menu loaded its in-memory copy: the list head is replaced.
  writeFileSync(join(agentDir, "secretary.json"),
    JSON.stringify({ agents: { modelFallbackLists: { "computer-use": ["p/new-head", "p/two"], cheap: ["q/three"] } } }));
  // The stale menu performs an unrelated action: add an empty list named "extra".
  menu.handleInput("\x1b[C"); // top → section
  menu.handleInput("\x1b[C"); // section → manager
  menu.handleInput("a");
  for (const ch of "extra") menu.handleInput(ch);
  menu.handleInput("\r");
  const lists = file().agents.modelFallbackLists;
  assert.deepEqual(lists["computer-use"], ["p/new-head", "p/two"],
    "The newer external edit survives an unrelated stale-menu action");
  assert.deepEqual(lists.cheap, ["q/three"]);
  assert.deepEqual(lists.extra, [], "The menu's own action is still applied");
});
