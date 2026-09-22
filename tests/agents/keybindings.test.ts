import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { bindingLabel, matchesInspectorAction, resolveInspectorKeybindings, validateInspectorKeybindings, DEFAULT_INSPECTOR_KEYBINDINGS, INSPECTOR_ACTIONS } from "../../extensions/secretary/agents/ui/keybindings.ts";
import { Inspector } from "../../extensions/secretary/agents/ui/inspector.ts";
import { transition } from "../../extensions/secretary/agents/ui/reducer.ts";
import { initialState } from "../../extensions/secretary/agents/ui/state.ts";
import type { AgentSnapshot } from "../../extensions/secretary/agents/records.ts";

function snapshot(id = "a"): AgentSnapshot {
  return { agent: { agentId: id, parentId: "p", definition: { name: "general-purpose", description: "test", prompt: "test", source: "packaged", hash: "hash", resumable: true }, model: "provider/model", tools: [], cwd: "/tmp", configCwd: "/tmp", sessionPath: "/tmp/session", resumable: true, createdAt: 0 }, run: { agentId: id, parentId: "p", runId: `${id}-run`, launchKey: id, prompt: "task", description: `${id} task`, status: "running", background: true, createdAt: 0, outputPath: "/tmp/output", output: "", toolCount: 0, turnCount: 0, revision: 0 } };
}
function ready(): ReturnType<typeof initialState> {
  let s = transition(initialState(), { type: "activate", parentId: "p", epoch: "e", viewId: "v" }, [snapshot("a"), snapshot("b")]).state;
  s = transition(s, { type: "open", viewId: "v1" }).state;
  s = transition(s, { type: "select", agentId: "a", requestId: "r" }).state;
  return transition(s, { type: "transcript", epoch: "e", viewId: "v1", agentId: "a", requestId: "r", events: [{ kind: "assistant", entryId: "e", text: "hello" }] }).state;
}

test("defaults preserve upstream actions with the requested cancellation mapping", () => {
  const resolved = resolveInspectorKeybindings();
  for (const action of INSPECTOR_ACTIONS) assert.ok(resolved[action].length > 0, action);
  assert.deepEqual(resolved.stop, ["shift+x", "x", "shift+d"]);
  assert.deepEqual(resolved.refresh, ["r", "shift+r"]);
  assert.deepEqual(resolved.toggleTools, ["o", "ctrl+o"]);
  assert.deepEqual(resolved.selectFirst, ["home"]);
  assert.deepEqual(resolved.selectLast, ["end"]);
});

test("overrides replace the action's defaults without touching sibling actions", () => {
  const resolved = resolveInspectorKeybindings({ stop: ["shift+t"], close: ["ctrl+q"] });
  assert.deepEqual(resolved.stop, ["shift+t"]);
  assert.deepEqual(resolved.close, ["ctrl+q"]);
  assert.deepEqual(resolved.selectUp, DEFAULT_INSPECTOR_KEYBINDINGS.selectUp);
  assert.ok(matchesInspectorAction("T", resolved, "stop"));
  assert.ok(!matchesInspectorAction("D", resolved, "stop"));
});

test("validation rejects unknown actions and malformed bindings", () => {
  assert.throws(() => validateInspectorKeybindings("nope", "cfg"), /must be an object/);
  assert.throws(() => validateInspectorKeybindings({ inspect: ["i"] }, "cfg"), /not a supported inspector action/);
  assert.throws(() => validateInspectorKeybindings({ stop: [] }, "cfg"), /non-empty array/);
  assert.throws(() => validateInspectorKeybindings({ stop: ["D", ""] }, "cfg"), /non-empty/);
  assert.deepEqual(validateInspectorKeybindings({ stop: ["shift+t"] }, "cfg"), { stop: ["shift+t"] });
  assert.throws(() => validateInspectorKeybindings({ toggleTools: ["x"] }, "cfg"), /reserved/);
  assert.throws(() => validateInspectorKeybindings({ close: ["ctrl+x"] }, "cfg"), /reserved/);
});

test("labels reflect configured keys and rendered footers match input handling", () => {
  const config = { stop: ["shift+t"], steer: ["m"], close: ["ctrl+q"], toggleTools: ["shift+z"] };
  const resolved = resolveInspectorKeybindings(config);
  assert.equal(bindingLabel(resolved, "stop"), "T");
  assert.equal(bindingLabel(resolved, "close"), "Ctrl+Q");
  assert.equal(bindingLabel(resolved, "selectUp"), "↑/k");
  const s = ready();
  const dispatched: string[] = [];
  const inspector = new Inspector(() => s, e => dispatched.push(e.type), () => "id", () => 22, { keybindings: config });
  inspector.handleInput("T");
  inspector.handleInput("Z");
  assert.deepEqual(dispatched, ["stop", "expand"]);
  const footer = stripVTControlCharacters(inspector.render(160).join("\n"));
  assert.match(footer, /T stop/);
  assert.match(footer, /m message/);
  assert.match(footer, /Ctrl\+Q close/);
  assert.match(footer, /Z tools/);
  assert.doesNotMatch(footer, /D stop/);
});
