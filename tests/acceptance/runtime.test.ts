import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import { AgentRepository, acquireParentLock } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { transition } from "../../extensions/secretary/agents/ui/reducer.ts";
import { initialState, type UiEvent } from "../../extensions/secretary/agents/ui/state.ts";
import { runEffect } from "../../extensions/secretary/agents/ui/effects.ts";
import { deferred, runFeatures, type ScenarioBindings } from "./support.ts";
import { publicHarness, serviceHarness, task, turn } from "./runtime-harness.ts";

const textOf = (result: any) => result.content.map((part: any) => part.text ?? "").join("\n");
const noWorktrees = (root: string) => {
  const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? [e.name, ...walk(join(path, e.name))] : []);
  assert.equal(walk(root).includes("worktrees"), false);
};
function gitFixture(root: string) {
  for (const args of [["init", "--quiet"], ["config", "user.name", "Acceptance"], ["config", "user.email", "acceptance@example.invalid"]]) execFileSync("git", args, { cwd: root });
  writeFileSync(join(root, "tracked.txt"), "original\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root }); execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
}
function inspector(snapshots: ReturnType<ReturnType<typeof serviceHarness>["service"]["list"]>) {
  let state = initialState();
  const send = (event: UiEvent, next = snapshots) => { const result = transition(state, event, next); state = result.state; return result; };
  send({ type: "activate", parentId: "parent", epoch: "epoch", viewId: "view" });
  send({ type: "open", viewId: "view" });
  send({ type: "select", agentId: snapshots[0]!.agent.agentId, requestId: "load" });
  send({ type: "transcript", agentId: snapshots[0]!.agent.agentId, requestId: "load", epoch: "epoch", viewId: "view", text: "" });
  return { send, state: () => state };
}

const bindings: ScenarioBindings = {
  "ACC-SA-01-01": async ({ t }) => {
    const h = await publicHarness(t); await h.start();
    const schema = h.tools.get("Agent").parameters;
    assert.deepEqual(new Set(schema.required), new Set(["prompt", "description"]));
    for (const field of ["task", "agent", "inherit_context", "resume"]) assert.equal(Object.hasOwn(schema.properties, field), false);
    assert.equal(schema.additionalProperties, false);
  },
  "ACC-SA-01-02": async ({ t }) => {
    const h = await publicHarness(t); await h.start();
    const launched = await h.tool("Agent", { ...task, run_in_background: true });
    await h.call();
    assert.match(launched.details.agentId, /^agent_/); assert.match(launched.details.runId, /^run_/);
    assert.match(textOf(launched), /Model: acceptance-runtime\/fixture/);
    assert.ok(existsSync(launched.details.outputPath)); assert.match(textOf(launched), /not yet complete/);
    assert.equal(h.repository.getRun(launched.details.runId)!.status, "running");
    const context = await h.emit("context", { messages: [{ role: "user", content: "Independent parent task" }] });
    assert.equal(context.messages[0].content, "Independent parent task");
    const other = await h.tool("Agent", { ...task, description: "Independent child", run_in_background: true });
    assert.notEqual(other.details.agentId, launched.details.agentId);
  },
  "ACC-SA-01-03": async ({ t }) => {
    const h = await publicHarness(t); await h.start();
    let returned = false;
    const pending = h.tool("Agent", { ...task, run_in_background: false }).then(result => { returned = true; return result; });
    const child = await h.call(); assert.equal(returned, false);
    child.finish("Foreground result"); const result = await pending;
    assert.equal(result.details.status, "succeeded"); assert.equal(result.details.output, "Foreground result");
    assert.match(result.details.agentId, /^agent_/); assert.match(result.details.runId, /^run_/);
    assert.equal(h.sent.filter(s => s.delivery?.triggerTurn).length, 0);
  },
  "ACC-SA-01-04": async ({ t }) => {
    const h = await publicHarness(t, { automatic: true });
    writeFileSync(join(h.root, "AGENTS.md"), "Child project instruction: name the violet satellite.\n");
    h.entries.push({ type: "message", message: { role: "user", content: "PARENT_PRIVATE_SENTENCE_94721", timestamp: 1 } });
    await h.start(); const before = { entries: structuredClone(h.entries), model: h.ctx.model, tools: h.pi.getActiveTools() };
    await h.tool("Agent", { ...task, prompt: "CHILD_EXPLICIT_TASK_285", run_in_background: false });
    assert.match(JSON.stringify(h.calls[0]), /CHILD_EXPLICIT_TASK_285/);
    assert.match(h.calls[0]!.systemPrompt ?? "", /name the violet satellite/);
    assert.doesNotMatch(JSON.stringify(h.calls[0]), /PARENT_PRIVATE_SENTENCE_94721/);
    assert.deepEqual(h.entries, before.entries); assert.equal(h.ctx.model, before.model); assert.deepEqual(h.pi.getActiveTools(), before.tools);
    assert.equal(h.engine.service.getGoal("parent"), null);
  },
  "ACC-SA-01-05": async ({ t, text }) => {
    const h = await publicHarness(t, { automatic: true }); await h.start();
    let args: any = { ...task, run_in_background: false }, diagnostic: RegExp;
    if (text.includes("unknown explicit agent")) { args.subagent_type = "not-installed"; diagnostic = /Unknown|unavailable/i; }
    else if (text.includes("unavailable resolved model")) { h.ctx.model = { ...h.ctx.model, id: "unavailable" }; diagnostic = /Model unavailable/; }
    else if (text.includes("empty task")) { args.prompt = " \n"; diagnostic = /prompt.*nonempty/i; }
    else if (text.includes("name reserved")) { await h.tool("Agent", { ...task, name: "reserved", run_in_background: false }); args.name = "reserved"; diagnostic = /already exists|already in use/i; }
    else if (text.includes("remote isolation")) { args.isolation = "remote"; diagnostic = /Remote execution.*not supported/; }
    else { assert.match(text, /conversation fork/); args.subagent_type = "fork"; diagnostic = /fork|unsupported/i; }
    const calls = h.calls.length, runs = h.repository.runs("parent").length;
    await assert.rejects(h.tool("Agent", args), diagnostic!);
    assert.equal(h.calls.length, calls); assert.equal(h.repository.runs("parent").length, runs); noWorktrees(h.root);
  },
  "ACC-SA-01-06": async ({ t }) => {
    const h = serviceHarness(t);
    const a = await h.service.launch(h.spec("a")); await h.running(a.run!.runId);
    const b = await h.service.launch(h.spec("b")), c = await h.service.launch(h.spec("c"));
    assert.equal(b.run!.status, "queued"); assert.equal(c.run!.status, "queued"); assert.equal(h.starts.length, 1);
    h.children.get(a.run!.runId)!.finish(); await h.running(b.run!.runId);
    assert.deepEqual(h.starts.map(o => o.run.runId), [a.run!.runId, b.run!.runId]); assert.equal(h.service.run(c.run!.runId).status, "queued");
  },
  "ACC-SA-01-07": async ({ t }) => {
    const h = serviceHarness(t, { concurrent: 1, queued: 1 });
    await h.service.launch(h.spec("a")); await h.service.launch(h.spec("b"));
    const before = h.repository.runs("parent").length;
    await assert.rejects(h.service.launch(h.spec("overflow")), /capacity.*full/);
    assert.equal(h.repository.runs("parent").length, before); assert.equal(h.starts.length, 1); assert.equal(h.repository.agents("parent").length, 2);
  },
  "ACC-SA-01-08": async ({ t }) => {
    const h = await publicHarness(t, { collision: "Agent" }); const original = h.tools.get("Agent"); await h.start();
    assert.equal(h.tools.get("Agent"), original); assert.match(h.notices.join("\n"), /another extension provides.*Agent/); assert.match(h.notices.join("\n"), /Disable.*reloading/);
    assert.equal(h.tools.has("SendMessage"), false); assert.equal(h.calls.length, 0);
    for (const name of ["get_goal", "create_goal", "update_goal"]) assert.ok(h.tools.has(name));
  },
  "ACC-SA-03-01": async ({ t }) => {
    const h = serviceHarness(t); const a = await h.service.launch({ ...h.spec("review"), name: "reviewer" });
    const child = await h.running(a.run!.runId); child.options.hooks.activity("controlled-tool");
    const ack = await h.service.message("reviewer", "Check error paths", "guide");
    assert.equal(ack.agentId, a.agent.agentId); assert.equal(ack.runId, a.run!.runId); assert.equal(ack.status, "running");
    assert.equal(child.aborts, 0); assert.deepEqual(child.consumed, []);
    assert.equal(h.repository.guidance(ack.runId)[0]!.state, "transport-accepted");
    child.boundary(); assert.deepEqual(child.consumed, ["Check error paths"]);
    assert.notEqual(h.repository.guidance(ack.runId)[0]!.state, "consumed");
  },
  "ACC-SA-03-02": async ({ t }) => {
    const h = await publicHarness(t, { mode: "rpc" }); await h.start();
    const a = await h.tool("Agent", { ...task, prompt: "Remember FIRST_CONVERSATION", run_in_background: true });
    (await h.call()).finish("Prior answer FIRST_ANSWER"); await h.outcome(a.details.runId);
    const session = h.repository.getAgent(a.details.agentId)!.sessionPath!; assert.ok(existsSync(session));
    const b = await h.tool("SendMessage", { to: a.details.agentId, message: "Continue SECOND_INSTRUCTION" });
    await h.call(1); assert.equal(b.details.agentId, a.details.agentId); assert.notEqual(b.details.runId, a.details.runId); assert.equal(b.details.background, true);
    assert.match(JSON.stringify(h.calls[1]!.messages), /FIRST_CONVERSATION/); assert.match(JSON.stringify(h.calls[1]!.messages), /FIRST_ANSWER/); assert.match(JSON.stringify(h.calls[1]!.messages), /SECOND_INSTRUCTION/);
    assert.equal(h.repository.getAgent(a.details.agentId)!.sessionPath, session);
  },
  "ACC-SA-03-03": async ({ t }) => {
    const h = serviceHarness(t, { concurrent: 3 }); const a = await h.service.launch(h.spec("a")); (await h.running(a.run!.runId)).finish(); await h.terminal(a.run!.runId);
    const [b, c] = await Promise.all([h.service.message(a.agent.agentId, "FIRST", "first"), h.service.message(a.agent.agentId, "SECOND", "second")]);
    const child = await h.running(b.runId);
    assert.equal(b.runId, c.runId); assert.equal(h.repository.runs("parent").length, 2); assert.equal(h.starts.length, 2);
    assert.equal(child.options.run.prompt, "FIRST"); assert.deepEqual(child.messages, ["SECOND"]);
    assert.equal(child.options.agent.sessionPath, h.service.resolve(a.agent.agentId).sessionPath);
  },
  "ACC-SA-03-04": async ({ t, text }) => {
    const h = await publicHarness(t); await h.start();
    const a = await h.tool("Agent", { ...task, subagent_type: text.includes("one-shot Explore") ? "Explore" : "general-purpose", run_in_background: true });
    (await h.call()).finish(); await h.outcome(a.details.runId);
    const agent = h.repository.getAgent(a.details.agentId)!; let reason: RegExp;
    if (text.includes("one-shot Explore")) reason = /not resumable/i;
    else if (text.includes("missing saved")) { rmSync(agent.sessionPath!); reason = /conversation|history/i; }
    else if (text.includes("corrupted saved")) { writeFileSync(agent.sessionPath!, "invalid json"); reason = /conversation|history/i; }
    else if (text.includes("unavailable recorded model")) { agent.model = "absent/model"; reason = /model.*unavailable|recorded model/i; }
    else if (text.includes("still stopping")) {
      // A held runner makes the stopping prerequisite deterministic rather than racing SDK abort.
      const s = serviceHarness(t, { cooperative: false }); const active = await s.service.launch(s.spec("stopping")); await s.running(active.run!.runId); await s.service.stop(active.run!.runId, "stop");
      await assert.rejects(s.service.message(active.agent.agentId, "Resume", "resume"), /still stopping/); assert.equal(s.starts.length, 1); assert.equal(s.repository.runs("parent").length, 1); return;
    } else if (text.includes("missing recorded worktree")) { agent.cwd = join(h.root, "missing-worktree"); agent.worktree = { id: "missing", repo: h.root, path: agent.cwd, branch: "fixture", baseCommit: "fixture", state: "allocated" }; reason = /directory|worktree|missing/i; }
    else { assert.match(text, /reserved for worktree cleanup/); agent.worktree = { id: "cleaning", repo: h.root, path: h.root, branch: "fixture", baseCommit: "fixture", state: "cleaning" }; reason = /cleanup/; }
    h.repository.putAgent(agent); const before = h.repository.runs("parent").length;
    await assert.rejects(h.tool("SendMessage", { to: agent.agentId, message: "Resume" }), reason!);
    assert.equal(h.repository.runs("parent").length, before); assert.equal(h.calls.length, 1);
  },
  "ACC-SA-03-05": async ({ t }) => {
    const gate = deferred<void>(); const h = serviceHarness(t, { initialize: gate, failInitialization: true });
    const a = await h.service.launch(h.spec("init"));
    await h.service.message(a.agent.agentId, "Retain this draft", "queued-guide");
    assert.equal(h.repository.guidance(a.run!.runId)[0]!.state, "pending"); gate.resolve(); await h.terminal(a.run!.runId);
    const guidance = h.repository.guidance(a.run!.runId)[0]!;
    assert.equal(guidance.state, "undelivered"); assert.equal(guidance.text, "Retain this draft");
    const visible = await h.service.transcript(a.agent.agentId);
    // Recover a usable saved history explicitly; a new instruction must not replay old guidance.
    const agent = h.service.resolve(a.agent.agentId); agent.sessionPath = join(h.root, "repaired.jsonl"); writeFileSync(agent.sessionPath, '{"type":"session"}\n'); h.repository.putAgent(agent); h.runnerOptions.failInitialization = false;
    const resumed = await h.service.message(agent.agentId, "Only this new instruction", "resume"); const child = await h.running(resumed.runId);
    assert.equal(child.options.run.prompt, "Only this new instruction"); assert.deepEqual(child.messages, []);
    assert.deepEqual({ explainsInitializationFailure: /initialization failure/i.test(guidance.reason ?? ""), inspectableDraft: visible.includes("Retain this draft") },
      { explainsInitializationFailure: true, inspectableDraft: true }, "Undelivered guidance must expose its failure reason and copyable text through inspection");
  },
  "ACC-SA-03-06": async ({ t }) => {
    const h = serviceHarness(t); const a = await h.service.launch(h.spec("a")); const child = await h.running(a.run!.runId);
    await h.service.message(a.agent.agentId, "Maybe consumed", "uncertain-guide"); assert.deepEqual(child.messages, ["Maybe consumed"]);
    await h.service.stop(a.run!.runId, "cancel"); await h.terminal(a.run!.runId);
    assert.equal(h.repository.guidance(a.run!.runId)[0]!.state, "uncertain");
    const resumed = await h.service.message(a.agent.agentId, "New instruction", "new"); const next = await h.running(resumed.runId);
    assert.equal(next.options.run.prompt, "New instruction"); assert.deepEqual(next.messages, []);
  },
  "ACC-SA-03-07": async ({ t }) => {
    const h = serviceHarness(t, { concurrent: 2 }); const a = await h.service.launch(h.spec("race")); const child = await h.running(a.run!.runId);
    child.finish(); const ack = await h.service.message(a.agent.agentId, "Racing guidance", "race-message");
    await h.terminal(a.run!.runId);
    assert.equal(ack.agentId, a.agent.agentId); assert.ok(h.repository.getRun(ack.runId));
    const accepted = h.repository.runs("parent").filter(r => r.prompt === "Racing guidance").length + h.repository.runs("parent").flatMap(r => h.repository.guidance(r.runId)).filter(g => g.text === "Racing guidance").length;
    assert.equal(accepted, 1); assert.ok(h.starts.length <= 2);
    assert.ok(h.repository.runs("parent").filter(r => ["running", "starting"].includes(r.status)).length <= 1);
  },
  "ACC-SA-03-08": async ({ t }) => {
    const h = serviceHarness(t); const a = await h.service.launch(h.spec("draft")); (await h.running(a.run!.runId)).finish(); await h.terminal(a.run!.runId);
    const ui = inspector(h.service.list()); ui.send({ type: "compose" }); ui.send({ type: "draft", text: "Keep my rejected draft" });
    const effects = ui.send({ type: "submit", operationId: "draft-submit" }).effects;
    const agent = h.service.resolve(a.agent.agentId); agent.resumable = false; h.repository.putAgent(agent);
    const effect = effects.find(e => e.type === "operate")!; assert.ok(effect);
    await runEffect(effect, { list: () => h.service.list(), message: (id, text, op) => h.service.message(id, text, op), stop: (id, op) => h.service.stop(id, op), cleanup: (id, op) => h.service.cleanup(id, op), transcript: id => h.service.transcript(id), receipt: async () => undefined, subscribe: () => () => {} }, event => ui.send(event));
    assert.equal(ui.state().dialog.kind, "composing");
    assert.equal((ui.state().dialog as any).draft, "Keep my rejected draft"); assert.match((ui.state().dialog as any).error, /not resumable/);
    assert.equal(h.service.receipt("draft-submit"), undefined); assert.doesNotMatch(ui.state().feedback ?? "", /accepted|queued/i);
  },
  "ACC-SA-04-01": async ({ t }) => {
    const h = serviceHarness(t); const a = await h.service.launch(h.spec("running")); await h.running(a.run!.runId);
    const b = await h.service.launch(h.spec("cancel")), c = await h.service.launch(h.spec("unrelated"));
    assert.equal((await h.service.stop(b.run!.runId, "cancel")).status, "cancelled");
    assert.equal(h.starts.length, 1); assert.equal(h.service.run(a.run!.runId).status, "running"); assert.equal(h.service.run(c.run!.runId).status, "queued");
    h.children.get(a.run!.runId)!.finish(); await h.running(c.run!.runId); assert.equal(h.children.has(b.run!.runId), false);
  },
  "ACC-SA-04-02": async ({ t }) => {
    const h = serviceHarness(t, { cooperative: false }); const a = await h.service.launch(h.spec("stubborn")); const child = await h.running(a.run!.runId);
    child.options.hooks.text("Retained partial evidence"); const file = join(h.root, "changed.txt"); writeFileSync(file, "child change");
    assert.equal((await h.service.stop(a.run!.runId, "stop")).status, "cancelling"); assert.equal(child.aborts, 1);
    assert.match(h.service.run(a.run!.runId).output, /Retained partial/); assert.equal(readFileSync(file, "utf8"), "child change");
    child.finish("", "cancelled"); assert.equal((await h.terminal(a.run!.runId)).status, "cancelled"); await turn(); assert.equal(h.starts.length, 1);
    assert.match(readFileSync(a.run!.outputPath, "utf8"), /Retained partial/);
  },
  "ACC-SA-04-03": async ({ t }) => {
    const h = serviceHarness(t); const a = await h.service.launch(h.spec("a")); const child = await h.running(a.run!.runId);
    const ui = inspector(h.service.list()); ui.send({ type: "control", action: "stop", agentId: a.agent.agentId }); assert.equal(ui.state().dialog.kind, "confirming");
    child.finish(); await h.terminal(a.run!.runId); const b = await h.service.message(a.agent.agentId, "new run", "new"); const newer = await h.running(b.runId);
    ui.send({ type: "snapshot", epoch: "epoch" }, h.service.list()); const confirmation = ui.send({ type: "submit", operationId: "stale-stop" });
    assert.equal(confirmation.effects.some(e => e.type === "operate"), false); assert.match(ui.state().feedback ?? "", /no longer eligible/);
    assert.equal(h.service.run(b.runId).status, "running"); assert.equal(newer.aborts, 0);
  },
  "ACC-SA-04-04": async ({ t }) => {
    const h = await publicHarness(t); await h.start();
    const unrelated = await h.tool("Agent", { ...task, name: "unrelated", run_in_background: true }); await h.call();
    const abort = new AbortController(); const foreground = h.tool("Agent", { ...task, name: "foreground", run_in_background: false }, abort.signal);
    const rejected = assert.rejects(foreground, /cancelled/i); await h.call(1);
    const owned = h.repository.agents("parent").find(a => a.name === "foreground")!; const run = h.repository.activeRun(owned.agentId)!;
    abort.abort(); await rejected; const result = await h.outcome(run.runId);
    assert.equal(result.details.status, "cancelled"); assert.equal(h.repository.getRun(unrelated.details.runId)!.status, "running");
    assert.equal(h.sent.filter(s => s.message.details?.runId === run.runId && s.delivery.triggerTurn).length, 0);
  },
  "ACC-SA-04-05": async ({ t }) => {
    const h = await publicHarness(t); await h.start(); const abort = new AbortController(); let recorded: any;
    const pending = h.tool("Agent", { ...task, run_in_background: false }, abort.signal, "late-abort", update => { if (update.details.status === "succeeded") { recorded = update.details; abort.abort(); } });
    // Attach rejection before the controlled terminal transition; cancellation may reject the wait.
    const response = pending.then(value => ({ value }), error => ({ error })); (await h.call()).finish("Successful result"); await response;
    assert.ok(recorded, "Cancellation is injected after recording and before foreground delivery");
    const result = await h.outcome(recorded.runId); assert.equal(result.details.status, "succeeded"); assert.equal(result.details.output, "Successful result"); assert.equal(h.calls.length, 1);
  },
  "ACC-SA-04-06": async ({ t }) => {
    const h = await publicHarness(t); await h.start(); const a = await h.tool("Agent", { ...task, run_in_background: true }); const child = await h.call();
    const abort = new AbortController(); const waiting = h.tool("TaskOutput", { task_id: a.details.runId, block: true }, abort.signal); const rejected = assert.rejects(waiting, /wait cancelled/); abort.abort(); await rejected;
    assert.equal(h.repository.getRun(a.details.runId)!.status, "running"); child.finish("Eventual output"); assert.equal((await h.outcome(a.details.runId)).details.output, "Eventual output");
  },
  "ACC-SA-04-07": async ({ t }) => {
    const h = serviceHarness(t, { cooperative: false, shutdownTimeoutMs: 7 }); gitFixture(h.root);
    const a = await h.service.launch({ ...h.spec("noncooperative"), isolation: "worktree" }); const child = await h.running(a.run!.runId);
    const worktree = h.service.resolve(a.agent.agentId).worktree!; assert.ok(existsSync(worktree.path)); await h.service.stop(a.run!.runId, "stop");
    t.mock.timers.enable({ apis: ["setTimeout"] }); const closing = h.service.shutdown(); await turn(); t.mock.timers.tick(7); assert.equal(await closing, false); t.mock.timers.reset();
    assert.equal(h.service.run(a.run!.runId).status, "cancelling"); assert.ok(existsSync(worktree.path)); assert.equal(h.service.resolve(a.agent.agentId).worktree!.state, "allocated");
    await assert.rejects(h.service.message(a.agent.agentId, "resume", "resume"), /shutting down|still stopping/); assert.equal(child.aborts > 0, true);
  },
  "ACC-SA-05-01": async ({ t }) => {
    const h = await publicHarness(t); await h.start(); const a = await h.tool("Agent", { ...task, run_in_background: true }); await h.call();
    const session = h.repository.getAgent(a.details.agentId)!.sessionPath!;
    await h.emit("session_shutdown", { reason: "quit" });
    const db = new DatabaseSync(join(h.root, "state.sqlite")); try { const repository = new AgentRepository(db); assert.equal(repository.getRun(a.details.runId)!.status, "cancelled"); assert.ok(existsSync(session)); assert.ok(existsSync(a.details.outputPath)); } finally { db.close(); }
    assert.equal(h.calls.length, 1); await assert.rejects(h.tool("Agent", task), /unavailable|shutting down/);
  },
  "ACC-SA-05-02": async ({ t, text }) => {
    const h = await publicHarness(t); await h.start(); const a = await h.tool("Agent", { ...task, name: "departing", run_in_background: true }); await h.call();
    if (text.includes("reloads extensions")) {
      await h.emit("session_shutdown", { reason: "reload" });
      const db = new DatabaseSync(join(h.root, "state.sqlite")); try { assert.equal(new AgentRepository(db).getRun(a.details.runId)!.status, "cancelled"); } finally { db.close(); }
      await assert.rejects(h.tool("SendMessage", { to: a.details.agentId, message: "resume" }), /unavailable|shutting down/);
    } else {
      const fork = text.includes("forks"), reason = text.includes("starts a new") ? "new" : "resume";
      await h.emit(fork ? "session_before_fork" : "session_before_switch", fork ? { entryId: "fork-entry" } : { reason });
      // Pi 0.85.1 accepts the transition, then emits session_shutdown and rebuilds
      // the extension runtime. It does not emit session_switch/session_fork events.
      await h.emit("session_shutdown", { reason: fork ? "fork" : reason });
      h.setParent("other-parent");
      const db = new DatabaseSync(join(h.root, "state.sqlite"));
      try { assert.equal(new AgentRepository(db).getRun(a.details.runId)!.status, "cancelled", "Departing session lifecycle must stop children"); }
      finally { db.close(); }
      await assert.rejects(h.tool("SendMessage", { to: "departing", message: "foreign control" }), /not found|unavailable|shutting down/);
    }
    assert.equal(h.calls.length, 1);
  },
  "ACC-SA-05-03": async ({ t }) => {
    const h = serviceHarness(t, { concurrent: 2 }); const a = await h.service.launch(h.spec("success")), b = await h.service.launch(h.spec("cancel"));
    (await h.running(a.run!.runId)).finish("Retained success"); await h.running(b.run!.runId); await h.service.stop(b.run!.runId, "cancel"); await h.terminal(a.run!.runId); await h.terminal(b.run!.runId); await h.service.shutdown();
    const restored = h.makeService(); await restored.recover(); const ui = inspector(restored.list());
    assert.deepEqual(ui.state().snapshots.map(s => s.run!.status), ["succeeded", "cancelled"]); assert.equal(restored.run(a.run!.runId).output, "Retained success"); assert.equal(h.starts.length, 2);
    const resumed = await restored.message(a.agent.agentId, "explicit eligible resume", "resume"); await h.until(() => restored.run(resumed.runId).status === "running", restored); assert.equal(h.starts.length, 3);
  },
  "ACC-SA-05-04": async ({ t }) => {
    const h = serviceHarness(t);
    const moduleUrl = (name: string) => pathToFileURL(resolve(`extensions/secretary/agents/${name}.ts`)).href;
    const code = `import {DatabaseSync} from 'node:sqlite'; import {AgentRepository,acquireParentLock} from ${JSON.stringify(moduleUrl("storage/agent-repository"))}; import {AgentService} from ${JSON.stringify(moduleUrl("service"))};
      const db=new DatabaseSync(${JSON.stringify(join(h.root, "agents.sqlite"))}); const repository=new AgentRepository(db); await acquireParentLock(${JSON.stringify(h.root)},'crashed');
      const service=new AgentService({parentId:'crashed',root:${JSON.stringify(h.root)},repository,ctx:{cwd:${JSON.stringify(h.root)},mode:'tui'},config:{modelAliases:{},maxConcurrent:1,maxQueued:1,shutdownTimeoutMs:10},runner:async o=>{o.hooks.text('Evidence from dead process');return {result:new Promise(()=>{}),steer:async()=>{},abort:async()=>{},dispose:async()=>{}}}});
      const result=await service.launch(${JSON.stringify(h.spec("crash"))}); process.stdout.write(JSON.stringify(result)+'\\n'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = ""; child.stderr.on("data", data => { errors += data; });
    const ready = deferred<any>(); child.stdout.on("data", data => { output += data; if (output.includes("\n")) ready.resolve(JSON.parse(output.split("\n")[0]!)); }); child.on("error", error => ready.reject(error)); child.on("exit", code => { if (!output.includes("\n")) ready.reject(new Error(`Fixture process exited ${code}: ${errors}`)); });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const a = await ready.promise; const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const release = await acquireParentLock(h.root, "crashed");
    try {
      const restored = h.makeService("crashed"); await restored.recover();
      assert.equal(restored.run(a.run.runId).status, "interrupted"); assert.match(restored.run(a.run.runId).output, /Evidence from dead process/); assert.equal(h.starts.length, 0);
    } finally { await release(); }
  },
  "ACC-SA-05-05": async ({ t }) => {
    const h = serviceHarness(t); const release = await acquireParentLock(h.root, "parent");
    try {
      const a = await h.service.launch(h.spec("owned")); await h.running(a.run!.runId);
      const url = pathToFileURL(resolve("extensions/secretary/agents/storage/parent-lock.ts")).href;
      const code = `import {acquireParentLock} from ${JSON.stringify(url)}; try {await acquireParentLock(${JSON.stringify(h.root)},'parent'); console.log('UNEXPECTED OWNERSHIP'); process.exitCode=2;} catch(e) {console.log(String(e));}`;
      const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { encoding: "utf8" });
      assert.match(output, /locked by process/); assert.doesNotMatch(output, /UNEXPECTED/); assert.equal(h.starts.length, 1); assert.equal(h.service.run(a.run!.runId).status, "running");
    } finally { await release(); }
  },
  "ACC-SA-05-06": async ({ t }) => {
    const h = serviceHarness(t); const a = await h.service.launch({ ...h.spec("owned"), name: "reviewer" }); const child = await h.running(a.run!.runId); const b = h.makeService("other-parent");
    for (const ref of ["reviewer", a.agent.agentId, a.run!.runId]) { await assert.rejects(b.message(ref, "unauthorized", `message-${ref}`), /not found/); await assert.rejects(b.stop(ref, `stop-${ref}`), /not found/); }
    assert.equal(h.service.run(a.run!.runId).status, "running"); assert.equal(child.aborts, 0); assert.deepEqual(child.messages, []);
  },
  "ACC-SA-05-07": async ({ t }) => {
    const h = await publicHarness(t, { automatic: true });
    // Seed a retained outcome before installer activation, as a previous process would leave it.
    const saved = serviceHarness(t); const a = await saved.service.launch(saved.spec("saved")); (await saved.running(a.run!.runId)).finish(); await saved.terminal(a.run!.runId);
    h.repository.putAgent(saved.service.resolve(a.agent.agentId)); h.repository.putRun(saved.service.run(a.run!.runId));
    h.repository.putCompletion({ id: `completion:${a.run!.runId}`, parentId: "parent", runId: a.run!.runId, state: "uncertain", trigger: false });
    h.entries.push({ type: "custom_message", customType: "secretary:agent-completion", details: { deliveryId: `completion:${a.run!.runId}` } });
    await h.start(); assert.equal(h.repository.completions("parent")[0]!.state, "observed"); assert.equal(h.sent.filter(s => s.delivery?.triggerTurn).length, 0); assert.equal(h.calls.length, 0);
  },
  "ACC-SA-05-08": async ({ t }) => {
    const h = await publicHarness(t); await h.start(); const a = await h.tool("Agent", { ...task, run_in_background: true }); await h.call();
    const before = h.repository.getRun(a.details.runId)!;
    await h.emit("session_before_tree", { preparation: { targetId: "earlier-entry" } }); h.entries.splice(0);
    await h.emit("session_tree", { newLeafId: "earlier-entry", oldLeafId: "launch-entry" });
    const context = await h.emit("context", { messages: [] }); assert.match(JSON.stringify(context), new RegExp(a.details.agentId)); assert.match(JSON.stringify(context), /running/);
    assert.deepEqual(h.repository.getRun(a.details.runId), before); assert.equal(h.calls.length, 1);
  },
  "ACC-SA-09-01": async ({ t }) => {
    const h = await publicHarness(t); await h.start(); const a = await h.tool("Agent", { ...task, run_in_background: true }); (await h.call()).partial("Partial output now"); await turn();
    const result = await h.tool("TaskOutput", { task_id: a.details.runId, block: false });
    assert.equal(result.details.status, "running"); assert.match(textOf(result), /Partial output now/); assert.match(textOf(result), /Partial: true/); assert.equal(h.calls.length, 1);
  },
  "ACC-SA-09-02": async ({ t }) => {
    const h = await publicHarness(t); await h.start(); const a = await h.tool("Agent", { ...task, run_in_background: true }); await h.call();
    t.mock.timers.enable({ apis: ["setTimeout"] }); const waiting = h.tool("TaskOutput", { task_id: a.details.runId, block: true, timeout: 25 }); t.mock.timers.tick(25); const result = await waiting; t.mock.timers.reset();
    assert.equal(result.details.status, "running"); assert.equal(h.repository.getRun(a.details.runId)!.status, "running");
    assert.match(textOf(result), /timed? ?out|timeout|wait expired/i, "TaskOutput must distinguish an expired wait from a nonblocking snapshot");
  },
  "ACC-SA-09-03": async ({ t }) => {
    const h = serviceHarness(t); const a = await h.service.launch(h.spec("a")); const child = await h.running(a.run!.runId);
    const waiting = h.service.wait(a.agent.agentId, 10000); child.finish("Run A only"); await h.terminal(a.run!.runId);
    const b = await h.service.message(a.agent.agentId, "Start B", "b"); await h.running(b.runId); const result = await waiting;
    assert.equal(result.runId, a.run!.runId); assert.equal(result.status, "succeeded"); assert.equal(result.output, "Run A only"); assert.equal(h.service.run(b.runId).status, "running");
  },
  "ACC-SA-09-04": async ({ t }) => {
    const h = await publicHarness(t); await h.start(); const pending = h.tool("Agent", { ...task, run_in_background: false });
    const full = "FULL_OUTPUT_START\n" + "x".repeat(55000) + "\nFULL_OUTPUT_END"; (await h.call()).finish(full); const a = await pending;
    const result = await h.tool("TaskOutput", { task_id: a.details.runId, block: false }); assert.match(textOf(result), /Truncated.*Full output:/); assert.ok(existsSync(result.details.outputPath)); assert.equal(readFileSync(result.details.outputPath, "utf8"), full);
    const read = await h.read(result.details.outputPath); assert.match(textOf(read), /FULL_OUTPUT_START/);
  },
  "ACC-SA-09-05": async ({ t, text }) => {
    const h = await publicHarness(t, { mode: text.includes("JSON mode") ? "json" : "print" }); h.ctx.hasUI = false; await h.start();
    let returned = false; const pending = h.tool("Agent", task).then(result => { returned = true; return result; }); const child = await h.call(); assert.equal(returned, false); child.finish("Headless outcome");
    const result = await pending; assert.equal(result.details.status, "succeeded"); assert.equal(result.details.background, false); assert.equal(h.widgets.length, 0); assert.equal(h.sent.length, 0);
  },
  "ACC-SA-09-06": async ({ t, text }) => {
    const h = await publicHarness(t, { mode: "print", automatic: true }); h.ctx.hasUI = false; await h.start();
    let operation: () => Promise<any>;
    if (text.includes("resumption of an idle")) { const a = await h.tool("Agent", task); operation = () => h.tool("SendMessage", { to: a.details.agentId, message: "Resume" }); }
    else if (text.includes("definition requires")) {
      const dir = join(h.root, "agent", "agents"); mkdirSync(dir); writeFileSync(join(dir, "background.md"), "---\nname: background\ndescription: Requires background\nbackground: true\n---\nWork on the explicit task.\n"); operation = () => h.tool("Agent", { ...task, subagent_type: "background" });
    } else { assert.match(text, /run_in_background set to true/); operation = () => h.tool("Agent", { ...task, run_in_background: true }); }
    const count = h.calls.length, runs = h.repository.runs("parent").length;
    for (const mode of ["print", "json"]) { h.ctx.mode = mode; await assert.rejects(operation!, /persistent TUI.*RPC/); assert.equal(h.calls.length, count); assert.equal(h.repository.runs("parent").length, runs); }
  },
  "ACC-SA-09-07": async ({ t }) => {
    const h = await publicHarness(t, { mode: "rpc" }); h.ctx.hasUI = false; await h.start();
    const a = await h.tool("Agent", { ...task, run_in_background: true }); const child = await h.call(); assert.equal(h.repository.getRun(a.details.runId)!.status, "running");
    assert.match(a.details.agentId, /^agent_/); child.finish("RPC outcome"); await h.outcome(a.details.runId);
    const delivered = h.sent.filter(s => s.message.details?.runId === a.details.runId); assert.equal(delivered.length, 1); assert.equal(delivered[0]!.delivery.triggerTurn, true); assert.equal(delivered[0]!.message.details.parentId, "parent"); assert.equal(h.widgets.length, 0);
  },
  "ACC-SA-09-08": async ({ t }) => {
    const h = await publicHarness(t, { mode: "rpc" }); h.ctx.hasUI = false; gitFixture(h.root); await h.start();
    const idle = await h.tool("Agent", { ...task, name: "idle", isolation: "worktree", run_in_background: true }); (await h.call()).finish(); await h.outcome(idle.details.runId);
    const tree = h.repository.getAgent(idle.details.agentId)!.worktree!; const before = readFileSync(join(tree.path, "tracked.txt"), "utf8");
    const running = await h.tool("Agent", { ...task, run_in_background: true }); await h.call(1); const stopped = await h.tool("TaskStop", { task_id: running.details.runId }); assert.ok(["cancelling", "cancelled"].includes(stopped.details.status));
    await h.commands.get("agents").handler("cleanup idle", h.ctx); assert.match(h.sent.map(s => s.message.content).join("\n"), /require TUI confirmation/);
    assert.equal(readFileSync(join(tree.path, "tracked.txt"), "utf8"), before); assert.equal(h.repository.getAgent(idle.details.agentId)!.worktree!.state, "allocated");
  },
  "ACC-SA-09-09": async ({ t, text }) => {
    const h = await publicHarness(t, { mode: "print", automatic: true }); await h.start(); const a = await h.tool("Agent", task);
    const timeout = Number(text.match(/timeout (-?[\d.]+) milliseconds/)![1]); const args = { task_id: a.details.runId, timeout }; const valid = timeout >= 0 && timeout <= 600000;
    assert.equal(Value.Check(h.tools.get("TaskOutput").parameters, args), valid);
    if (valid) assert.equal((await h.tool("TaskOutput", args)).details.runId, a.details.runId);
    else await assert.rejects(h.tool("TaskOutput", args), /Invalid TaskOutput input/);
    assert.equal(h.calls.length, 1);
  },
};

runFeatures(["delegation", "messaging", "cancellation", "session-recovery", "output-and-headless"], bindings, {
  delegation: "d02d850b85e528e20e965ddbb442a76bf3dc8b807460d50dd04ab26e08710c6d",
  messaging: "92bdf9ed1c321276fdb56c19ffc08e4eb7d591518741015a1689d561aa2f5555",
  cancellation: "19f34013acff66973c725eeb33afbc16248c527ce8b79bef06d3a1deace09709",
  "session-recovery": "c61448a5697766d789537c4d869a16f55c3a4504fd42213a601f19aad4a42773",
  "output-and-headless": "0e08fffc830e2f331f5136eeea0852525af356103c68a113d04679ed15371006",
});
