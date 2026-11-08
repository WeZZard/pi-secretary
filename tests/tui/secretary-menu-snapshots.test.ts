/**
 * Reviewed rendered-layout baselines for the /secretary configuration menu
 * (interaction design §2.5 wireframes). Baselines are captured from the implemented
 * layout and versioned intentionally per docs/testing/test-artifacts.md; a layout
 * change requires updating this file with review.
 *
 * The focused filter and name inputs render pi's native cursor affordance: an APC
 * hardware-cursor marker and an inverse-video cursor column. Baselines verify layout,
 * so `normalize` strips those escape sequences; the cursor column itself remains as
 * the space it occupies.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SecretaryConfigMenu } from "../../extensions/secretary/agents/ui/config-menu.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "secretary-menu-snap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: { primary: ["p/one", "p/two"], empty: [] } } }));
  return new SecretaryConfigMenu({ agentDir, models: () => ["p/one", "p/two", "q/three"], definitions: () => [{ name: "Explore", declared: "fast" }, { name: "Plan" }, { name: "general-purpose" }], onDismiss: () => {} });
}

function normalize(lines: string[]): string {
  return lines.join("\n").replaceAll("\x1b_pi:c\x07", "").replaceAll("\x1b[7m", "").replaceAll("\x1b[27m", "");
}

test("layout baseline: top level", (t) => {
  const menu = fixture(t);
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nSecretary\nEdits the user-global configuration only.\n\n→ Subagents\n\n  ↑/↓ select · Enter/→ open · Esc dismiss\n────────────────────────────────────────────────────────────");
});

test("layout baseline: Subagents section items", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nSecretary › Subagents\n\n→ Model Fallback Lists\n  Subagent Models\n  Runtime Limits\n\n  ↑/↓ select · Enter/→ open · ← back · Esc dismiss\n────────────────────────────────────────────────────────────");
});

test("layout baseline: runtime limits", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[B");
  menu.handleInput("\x1b[B");
  menu.handleInput("\x1b[C");
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nSecretary › Subagents › Runtime Limits\nEdits the user-global configuration only.\n\n→ Max Concurrent  4\n  Max Queued  16\n  Shutdown Timeout  5000 ms\n  Max Nesting Depth  3\n\n  ↑/↓ select · Enter edit · ← back · Esc dismiss\n────────────────────────────────────────────────────────────");
});

test("layout baseline: runtime limit value prompt", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[B");
  menu.handleInput("\x1b[B");
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[C");
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nMax Concurrent\nAgents allowed to run at the same time.\nWhole number of at least 1.\n\n> 4                                                         \n\n  Enter confirm · Esc cancel\n────────────────────────────────────────────────────────────");
});

test("layout baseline: list manager", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[C");
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nSecretary › Subagents › Model Fallback Lists\nEdits the user-global configuration only.\n\n→ primary  2 models\n  empty  0 models\n  ＋ Add List\n\n  a add list · r rename list · d remove list\n  Shift+K/J move up/down\n  ↑/↓ select · Enter/→ open · ← back · Esc dismiss\n────────────────────────────────────────────────────────────");
});

test("layout baseline: populated list", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[C");
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nSecretary › Subagents › Model Fallback Lists › primary\nModels are tried from first to last.\n\n→ one [p]\n  two [p]\n  ＋ Add Model\n\n  a add · d remove · Shift+K/J move up/down\n  ↑/↓ select · Enter/→ open · ← back · Esc dismiss\n────────────────────────────────────────────────────────────");
});

test("layout baseline: empty list", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[B");
  menu.handleInput("\x1b[C");
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nSecretary › Subagents › Model Fallback Lists › empty\nModels are tried from first to last.\n\n→ ＋ Add Model\n\n  Enter/→ add\n  ← back · Esc dismiss\n────────────────────────────────────────────────────────────");
});

test("layout baseline: model picker with filter", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[B");
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[C");
  for (const ch of "q") menu.handleInput(ch);
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nAdd Model › empty\n\n> q                                                         \n\n→ three [q]\n\n  Enter add\n  ↑/↓ select · Esc cancel\n────────────────────────────────────────────────────────────");
});

test("layout baseline: list name prompt with draft", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[C");
  menu.handleInput("a");
  for (const ch of "fast") menu.handleInput(ch);
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nAdd List\nName the fallback list.\n\n> fast                                                      \n\n  Enter confirm · Esc cancel\n────────────────────────────────────────────────────────────");
});

test("layout baseline: rename prompt prefilled with the current name", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[C");
  menu.handleInput("r");
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nRename List\nRenaming preserves the list's models.\nDefinitions that reference the old name fail at launch\nuntil they are updated.\n\n> primary                                                   \n\n  Enter confirm · Esc cancel\n────────────────────────────────────────────────────────────");
});

test("layout baseline: remove list confirmation", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[C");
  menu.handleInput("d");
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nRemove List\n\nRemove fallback list \"primary\"?\nDefinitions that reference it will fail at launch\nuntil they are updated.\n\n  Enter confirm · Esc cancel\n────────────────────────────────────────────────────────────");
});

test("layout baseline: narrow width diagnostic", (t) => {
  const menu = fixture(t);
  assert.equal(menu.render(30).join("\n"), "Secretary configuration requires a wider terminal.");
});

test("layout baseline: subagent model assignments", (t) => {
  const menu = fixture(t);
  menu.handleInput("\x1b[C");
  menu.handleInput("\x1b[B");
  menu.handleInput("\x1b[C");
  assert.equal(normalize(menu.render(60)), "────────────────────────────────────────────────────────────\n\nSecretary › Subagents › Subagent Models\nAssignments override a definition's own model.\n\n→ Explore  fast  declared\n  Plan  inherit  inherited\n  general-purpose  inherit  inherited\n\n  ↑/↓ select · Enter/→ open · ← back · Esc dismiss\n────────────────────────────────────────────────────────────");
});
