import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SecretaryConfigMenu, headlessSecretaryConfig } from "../../extensions/secretary/agents/ui/config-menu.ts";

const UP = "\x1b[A", DOWN = "\x1b[B", RIGHT = "\x1b[C", LEFT = "\x1b[D", ENTER = "\r", ESC = "\x1b", BACKSPACE = "\x7f";

function fixture(t: TestContext, options: { lists?: Record<string, string[]>; models?: string[]; seedFile?: string; definitions?: { name: string; declared?: string }[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "secretary-menu-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  if (options.seedFile !== undefined) writeFileSync(join(agentDir, "secretary.json"), options.seedFile);
  else if (options.lists) writeFileSync(join(agentDir, "secretary.json"), JSON.stringify({ agents: { modelFallbackLists: options.lists } }));
  let dismissals = 0;
  const menu = new SecretaryConfigMenu({
    agentDir,
    models: () => options.models ?? ["p/one", "p/two", "q/three"],
    definitions: () => options.definitions ?? [{ name: "Explore", declared: "fast" }, { name: "Plan" }, { name: "general-purpose" }],
    onDismiss: () => { dismissals++; },
  });
  return {
    menu,
    agentDir,
    view: (width = 60) => menu.render(width).join("\n"),
    dismissed: () => dismissals,
    type: (text: string) => { for (const ch of text) menu.handleInput(ch); },
    file: () => JSON.parse(readFileSync(join(agentDir, "secretary.json"), "utf8")),
  };
}

test("top level shows the Subagents section and dismisses on Escape", (t) => {
  const f = fixture(t);
  const top = f.view();
  assert.match(top, /^Secretary$/m);
  assert.match(top, /Edits the user-global configuration only\./);
  assert.match(top, /→ Subagents/);
  assert.match(top, /↑\/↓ select · Enter\/→ open · Esc dismiss/);
  assert.doesNotMatch(top, /a add list/, "The top level has no list operations line");
  f.menu.handleInput(ESC);
  assert.equal(f.dismissed(), 1);
});

test("manager lists configured lists with model counts and states the user-global boundary", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one", "p/two"], cheap: [] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  const view = f.view(72);
  assert.match(view, /Secretary › Subagents › Model Fallback Lists/);
  assert.match(view, /user-global/, "The menu states that it edits the user-global configuration only");
  assert.match(view, /→ primary {2}2 models/);
  assert.match(view, / {2}cheap {2}0 models/);
  assert.match(view, /＋ Add List/);
  assert.match(view, /a add list · r rename list · d remove list/);
  assert.match(view, /↑\/↓ select · Enter\/→ open · ← back · Esc dismiss/);
});

test("Right enters and Left returns per level; Left at the top level does nothing", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one"] } });
  f.menu.handleInput(RIGHT);
  assert.match(f.view(), /^Secretary › Subagents$/m);
  assert.match(f.view(), /→ Model Fallback Lists/);
  assert.doesNotMatch(f.view(), /a add list/, "The section page is a pure navigation list");
  f.menu.handleInput(RIGHT);
  assert.match(f.view(), /^Secretary › Subagents › Model Fallback Lists$/m);
  f.menu.handleInput(RIGHT);
  assert.match(f.view(), /Model Fallback Lists › primary/);
  f.menu.handleInput(LEFT);
  assert.match(f.view(), /^Secretary › Subagents › Model Fallback Lists$/m);
  assert.doesNotMatch(f.view(), /› primary/);
  f.menu.handleInput(LEFT);
  assert.match(f.view(), /^Secretary › Subagents$/m);
  f.menu.handleInput(LEFT);
  f.menu.handleInput(LEFT);
  assert.match(f.view(), /^Secretary$/m);
  assert.doesNotMatch(f.view(), /Subagents ›/, "Left at the top level does nothing");
  assert.equal(f.dismissed(), 0);
});

test("Escape dismisses the entire menu from a deep level", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one"] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(ESC);
  assert.equal(f.dismissed(), 1);
});

test("an empty list shows only the add-model row with its reduced footer", (t) => {
  const f = fixture(t, { lists: { cheap: [] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  const view = f.view();
  assert.match(view, /→ ＋ Add Model/);
  assert.doesNotMatch(view, /one \[p\]|three \[q\]/);
  assert.match(view, /Enter\/→ add/);
  assert.match(view, /← back · Esc dismiss/);
});

test("adding a list persists it and reports the change", (t) => {
  const f = fixture(t);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("a");
  assert.match(f.view(), /^Add List$/m);
  f.type("fast");
  f.menu.handleInput(ENTER);
  assert.match(f.view(), /fast {2}0 models/);
  assert.match(f.view(), /Added list fast/);
  assert.deepEqual(f.file().agents.modelFallbackLists, { fast: [] });
  assert.equal(f.dismissed(), 0);
});

test("duplicate, reserved, and invalid names are rejected with the draft retained", (t) => {
  const f = fixture(t, { lists: { fast: [] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("a");
  f.type("fast");
  f.menu.handleInput(ENTER);
  assert.match(f.view(), /already exists/, "A duplicate name is rejected inline");
  assert.match(f.view(), /fast/, "The rejected draft is retained for editing");
  f.type("er");
  f.menu.handleInput(ENTER);
  assert.deepEqual(f.file().agents.modelFallbackLists, { fast: [], faster: [] }, "Editing the retained draft succeeds");
  f.menu.handleInput("a");
  f.type("inherit");
  f.menu.handleInput(ENTER);
  assert.match(f.view(), /reserved/);
  f.menu.handleInput(ESC);
  assert.equal(f.dismissed(), 0, "Escape cancels the prompt before dismissing the menu");
  assert.match(f.view(), /Model Fallback Lists/);
});

test("renaming a list keeps its models and manager position and follows the selection", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one"], cheap: [] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("r");
  const prompt = f.view();
  assert.match(prompt, /^Rename List$/m);
  assert.match(prompt, /Renaming preserves the list's models\./);
  assert.match(prompt, /fail at launch/);
  assert.match(prompt, /> primary/, "The prompt is prefilled with the current name");
  for (let index = 0; index < 7; index++) f.menu.handleInput(BACKSPACE);
  f.type("standard");
  f.menu.handleInput(ENTER);
  assert.match(f.view(), /Renamed primary to standard\./);
  assert.match(f.view(), /→ standard/, "The selection follows the renamed list");
  assert.deepEqual(Object.keys(f.file().agents.modelFallbackLists), ["standard", "cheap"], "The renamed list keeps its position");
  assert.deepEqual(f.file().agents.modelFallbackLists.standard, ["p/one"], "The models move with the name");
});

test("a same-name rename is a no-op and duplicate renames are rejected with the draft retained", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one"], cheap: [] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("r");
  f.menu.handleInput(ENTER);
  assert.match(f.view(), /→ primary/, "A same-name confirm closes the prompt");
  assert.doesNotMatch(f.view(), /Renamed/, "No change is reported");
  assert.deepEqual(Object.keys(f.file().agents.modelFallbackLists), ["primary", "cheap"]);
  f.menu.handleInput("r");
  for (let index = 0; index < 7; index++) f.menu.handleInput(BACKSPACE);
  f.type("cheap");
  f.menu.handleInput(ENTER);
  assert.match(f.view(), /already exists/);
  assert.match(f.view(), /> cheap/, "The rejected draft is retained");
  f.menu.handleInput(ESC);
  assert.match(f.view(), /→ primary/, "Escape cancels the rename prompt without dismissing the menu");
  assert.equal(f.dismissed(), 0);
  assert.deepEqual(Object.keys(f.file().agents.modelFallbackLists), ["primary", "cheap"], "No rename was persisted");
});

test("removing a list requires confirmation; Escape cancels and Enter confirms", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one"] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("d");
  assert.match(f.view(), /Remove fallback list "primary"\?/);
  assert.match(f.view(), /will fail at launch/);
  f.menu.handleInput(ESC);
  assert.match(f.view(), /→ primary/, "Cancellation keeps the list and the menu open");
  assert.equal(f.dismissed(), 0);
  f.menu.handleInput("d");
  f.menu.handleInput(ENTER);
  assert.doesNotMatch(f.view(), /primary {2}1 models/, "The confirmed list row is gone");
  assert.match(f.view(), /Removed list primary/);
  assert.deepEqual(f.file().agents.modelFallbackLists, {});
});

test("the model picker excludes present models, filters by typing, and appends the selection", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one"] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("a");
  const picker = f.view();
  assert.match(picker, /Add Model › primary/);
  assert.match(picker, /two \[p\]/);
  assert.match(picker, /three \[q\]/);
  assert.doesNotMatch(picker, /one \[p\]/, "Models already in the list are excluded");
  f.type("q");
  const filtered = f.view();
  assert.match(filtered, /> q/);
  assert.match(filtered, /three \[q\]/);
  assert.doesNotMatch(filtered, /two \[p\]/, "Typing filters the candidates");
  f.menu.handleInput(ENTER);
  assert.deepEqual(f.file().agents.modelFallbackLists.primary, ["p/one", "q/three"], "The picked model is appended at the end");
  assert.match(f.view(), /Added q\/three to primary/);
  f.menu.handleInput("a");
  f.menu.handleInput(ESC);
  assert.equal(f.dismissed(), 0, "Escape cancels the picker before dismissing the menu");
  assert.match(f.view(), /Model Fallback Lists › primary/);
});

test("adding a model reports exhaustion when every session model is already present", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one", "p/two", "q/three"] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("a");
  assert.match(f.view(), /already in this list/);
  assert.match(f.view(), /Model Fallback Lists › primary/, "The picker does not open");
});

test("removing a model does not ask for confirmation", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one", "p/two"] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("d");
  assert.deepEqual(f.file().agents.modelFallbackLists.primary, ["p/two"]);
  assert.match(f.view(), /Removed p\/one from primary/);
  assert.doesNotMatch(f.view(), /Remove fallback list/);
});

test("Shift+K and Shift+J reorder models and persist the resolution order", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one", "p/two", "q/three"] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(DOWN);
  f.menu.handleInput("K");
  assert.deepEqual(f.file().agents.modelFallbackLists.primary, ["p/two", "p/one", "q/three"]);
  const view = f.view();
  assert.ok(view.indexOf("→ two [p]") < view.indexOf("one [p]"), "The selection follows the moved model");
  assert.match(view, /Shift\+K\/J move up\/down/);
  f.menu.handleInput("J");
  assert.deepEqual(f.file().agents.modelFallbackLists.primary, ["p/one", "p/two", "q/three"]);
});

/** Walk from the top level to the model fallback list manager (ux §2.5). */
function openManager(f: ReturnType<typeof fixture>) {
  f.menu.handleInput(RIGHT);          // Subagents
  f.menu.handleInput(RIGHT);          // Model Fallback Lists
}

test("Shift+J and Shift+K reorder the fallback lists and persist the manager order", (t) => {
  const f = fixture(t, { lists: { alpha: ["p/one"], beta: ["p/two"], gamma: ["q/three"] } });
  openManager(f);
  f.menu.handleInput("J");            // alpha moves down past beta
  assert.deepEqual(Object.keys(f.file().agents.modelFallbackLists), ["beta", "alpha", "gamma"], "The persisted key order is the manager order");
  assert.deepEqual(f.file().agents.modelFallbackLists.alpha, ["p/one"], "Reordering a list leaves its models alone");
  const view = f.view();
  assert.match(view, /Moved alpha down\./);
  assert.ok(view.indexOf("beta") < view.indexOf("→ alpha"), "The selection follows the moved list");
  assert.match(headlessSecretaryConfig(f.agentDir), /beta: p\/two\n  alpha: p\/one/, "The headless summary reads the same persisted order");
  f.menu.handleInput("K");            // and back
  assert.deepEqual(Object.keys(f.file().agents.modelFallbackLists), ["alpha", "beta", "gamma"]);
});

test("an end-of-list list reorder is a no-op that reports no warning", (t) => {
  const f = fixture(t, { lists: { alpha: ["p/one"], beta: ["p/two"] } });
  openManager(f);
  f.menu.handleInput("K");            // alpha is already first
  assert.deepEqual(Object.keys(f.file().agents.modelFallbackLists), ["alpha", "beta"]);
  assert.doesNotMatch(f.view(), /Not saved/, "A boundary press is a no-op, not an error");
  f.menu.handleInput(DOWN);
  f.menu.handleInput(DOWN);           // the `＋ Add List` row names no list to move
  f.menu.handleInput("J");
  assert.deepEqual(Object.keys(f.file().agents.modelFallbackLists), ["alpha", "beta"]);
  assert.doesNotMatch(f.view(), /Not saved/);
});

test("an end-of-list model reorder is a no-op that reports no warning", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one", "p/two"] } });
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("K");            // first model
  assert.deepEqual(f.file().agents.modelFallbackLists.primary, ["p/one", "p/two"]);
  assert.doesNotMatch(f.view(), /Not saved/);
});

test("an invalid stored configuration is reported and offers no editing", (t) => {
  const f = fixture(t, { seedFile: '{"agents":{"modelFallbackLists":{"bad name":[]}}}' });
  const before = f.view();
  assert.match(before, /invalid/i);
  assert.match(before, /secretary\.json/);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("a");
  f.menu.handleInput("d");
  assert.equal(f.view(), before, "No editing is offered until the file is corrected by hand");
  f.menu.handleInput(ESC);
  assert.equal(f.dismissed(), 1);
});

test("a failed write keeps the previous configuration in effect", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one", "p/two"] } });
  rmSync(join(f.agentDir, "secretary.json"));
  mkdirSync(join(f.agentDir, "secretary.json"));
  t.after(() => rmSync(join(f.agentDir, "secretary.json"), { recursive: true, force: true }));
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput(RIGHT);
  f.menu.handleInput("d");
  assert.match(f.view(), /Not saved/);
  assert.match(f.view(), /one \[p\]/, "The failed change is not adopted");
});

test("terminals below the supported width render the diagnostic line", (t) => {
  const f = fixture(t);
  const lines = f.menu.render(30);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /wider terminal/);
});

test("headless modes receive the configuration path and a list summary as text", (t) => {
  const f = fixture(t, { lists: { primary: ["p/one", "p/two"], empty: [] } });
  const text = headlessSecretaryConfig(f.agentDir);
  assert.match(text, /secretary\.json/);
  assert.match(text, /primary: p\/one, p\/two/);
  assert.match(text, /empty: \(no models\)/);
  assert.match(text, /does not accept edits|interactive session/, "Headless output does not accept edits");
  assert.match(text, /Max concurrent: 4/);
  assert.match(text, /Shutdown timeout: 5000 ms/);
  const none = fixture(t);
  assert.match(headlessSecretaryConfig(none.agentDir), /No model fallback lists configured/);
  const broken = fixture(t, { seedFile: '{"agents":{"modelFallbackLists":{"bad name":[]}}}' });
  assert.match(headlessSecretaryConfig(broken.agentDir), /invalid/i);
});

/** Walk from the top level to the Subagent Models assignments page (architecture §5.3, ux §3.11). */
function openAssignments(f: ReturnType<typeof fixture>) {
  f.menu.handleInput(RIGHT);          // Subagents
  f.menu.handleInput(DOWN);           // Subagent Models
  f.menu.handleInput(RIGHT);          // the assignments page
}

test("a model assignment is written for the chosen definition and reported on the page", (t) => {
  const f = fixture(t, { lists: { fast: ["p/one", "p/two"], slow: ["q/three"] } });
  openAssignments(f);
  assert.match(f.view(), /Explore  fast  declared/, "Before an assignment the definition's own model is disclosed, not reported as inheritance");
  f.menu.handleInput(RIGHT);          // Explore's assignment page
  assert.match(f.view(), /Resolution order: invocation/, "The page states the resolution order it implements");
  f.menu.handleInput(DOWN);           // inherit -> fast
  f.menu.handleInput(ENTER);
  assert.deepEqual(f.file().agents.subagentModels, { Explore: "fast" }, "The assignment is persisted under the definition's name");
  assert.match(f.view(), /Explore assigned to fast\./, "The outcome is stated on the page");
  assert.match(f.view(), /Explore  fast  assigned/);
});

test("choosing inherit removes the assignment instead of storing the word", (t) => {
  const f = fixture(t, { seedFile: JSON.stringify({ agents: { modelFallbackLists: { fast: ["p/one"] }, subagentModels: { Explore: "fast" } } }) });
  openAssignments(f);
  assert.match(f.view(), /Explore  fast  assigned/);
  f.menu.handleInput(RIGHT);          // Explore's assignment page, cursor on inherit
  f.menu.handleInput(ENTER);
  assert.deepEqual(f.file().agents.subagentModels, {}, "Clearing removes the key, so a later definition edit governs again");
  assert.match(f.view(), /Explore now inherits the parent model\./, "The outcome is stated on the page");
  assert.match(f.view(), /Explore  fast  declared/, "The definition's own model is disclosed once the assignment is gone");
});

/** Walk from the top level to the Runtime Limits page (ux §2.5). */
function openLimits(f: ReturnType<typeof fixture>) {
  f.menu.handleInput(RIGHT);          // Subagents
  f.menu.handleInput(DOWN);           // Subagent Models
  f.menu.handleInput(DOWN);           // Runtime Limits
  f.menu.handleInput(RIGHT);          // the limits page
}

test("the runtime limits page shows the effective values and the user-global boundary", (t) => {
  const f = fixture(t);
  openLimits(f);
  assert.match(f.view(), /Runtime Limits/);
  assert.match(f.view(), /Edits the user-global configuration only\./);
  assert.match(f.view(), /Max Concurrent {2}4/);
  assert.match(f.view(), /Max Queued {2}16/);
  assert.match(f.view(), /Shutdown Timeout {2}5000 ms/);
  assert.match(f.view(), /Max Nesting Depth {2}3/);
});

test("editing a limit persists it, reports the change, and preserves the other limits", (t) => {
  const f = fixture(t);
  openLimits(f);
  f.menu.handleInput(DOWN);           // Max Queued, prefilled "16"
  f.menu.handleInput(RIGHT);          // the value prompt
  f.menu.handleInput(BACKSPACE);
  f.menu.handleInput(BACKSPACE);
  f.type("32");
  f.menu.handleInput(ENTER);
  assert.equal(f.file().agents.maxQueued, 32, "The edited limit is persisted");
  assert.equal(f.file().agents.maxConcurrent, 4, "Untouched limits keep their effective value");
  assert.match(f.view(), /Max Queued set to 32\./, "The outcome is stated on the page");
  assert.match(f.view(), /Max Queued {2}32/);
});

test("a below-minimum limit is rejected with the draft retained and nothing written", (t) => {
  const f = fixture(t, { lists: { fast: ["p/one"] } });
  openLimits(f);
  f.menu.handleInput(RIGHT);          // Max Concurrent (minimum 1), prefilled "4"
  f.menu.handleInput(BACKSPACE);
  f.type("0");
  f.menu.handleInput(ENTER);
  assert.match(f.view(), /Enter a whole number of at least 1\./);
  assert.equal(f.file().agents.maxConcurrent, undefined, "A rejected edit writes nothing");
  f.type("9");                        // the draft survives, so it can be corrected in place
  f.menu.handleInput(ENTER);
  assert.equal(f.file().agents.maxConcurrent, 9, "The retained draft is confirmed once valid");
});
