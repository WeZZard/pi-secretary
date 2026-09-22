import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { runFeatures, deferred, tick, type ScenarioBindings } from "./support.ts";
import { UIHarness, adapter, durableService, fixtureEvents, plain, port, snapshot } from "./ui-harness.ts";
import { agentHarness } from "../support/agent-harness.ts";
import { renderAgentResult, renderResult } from "../../extensions/secretary/agents/tools/rendering.ts";
import { loadAgentConfiguration } from "../../extensions/secretary/agents/configuration.ts";
import { transcriptWindow } from "../../extensions/secretary/agents/ui/transcript.ts";
import type { TranscriptEvent } from "../../extensions/secretary/agents/ui/transcript-events.ts";
import { FleetView } from "../../extensions/secretary/agents/ui/fleet-view.ts";
import { Inspector } from "../../extensions/secretary/agents/ui/inspector.ts";
import { transition } from "../../extensions/secretary/agents/ui/reducer.ts";
import type { AgentSnapshot, RunStatus } from "../../extensions/secretary/agents/records.ts";

initTheme("dark", false);
const bindings: ScenarioBindings = {
  "ACC-SA-02-01": async ({ t }) => {
    const installed = await agentHarness(t, { mode: "rpc" });
    const stream = createAssistantMessageEventStream(), started = deferred<void>();
    installed.ctx.modelRegistry.registerProvider(installed.ctx.model.provider, { api: installed.ctx.model.api, baseUrl: installed.ctx.model.baseUrl, apiKey: "fake", models: [installed.ctx.model], streamSimple() { started.resolve(); return stream; } });
    await installed.start();
    try {
      const result = await installed.tool("Agent", { prompt: "Inspect", description: "Background inspection", run_in_background: true });
      await started.promise;
      const historical = plain(renderResult(result, { expanded: true, isPartial: false }).render(160));
      assert.match(historical, /Launch accepted; execution is not yet complete/);
      const current = (await installed.tool("TaskOutput", { task_id: result.details.runId, block: false })).details;
      assert.equal(current.status, "running");
      const record = snapshot(current.agentId, "parent"); record.run = current;
      const ui = new UIHarness([record]); ui.send({ type: "fleet", downAtLastLine: true });
      assert.match(plain(ui.fleet.render(160)), /running/);
      assert.doesNotMatch(plain(ui.fleet.render(160)), /succeeded|completed/);
      assert.equal(plain(renderResult(result, { expanded: true, isPartial: false }).render(160)), historical);
      assert.equal(installed.sent.length, 0, "No completion announcement while the child is running");
    } finally {
      const model = installed.ctx.model;
      stream.push({ type: "done", reason: "stop", message: { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }); stream.end(); await tick();
    }
  },
  "ACC-SA-02-02": async ({ t }) => {
    let loads = 0;
    const h = adapter(t, port({ transcript: async id => { loads++; return [{ kind: "assistant", entryId: `selected-${id}`, text: `Selected ${id}` }]; } }));
    assert.match(h.fleet(), /○ main/, "the indicator is visible with an unfocused main row");
    h.prompt(true); h.prompt(true);
    assert.equal(h.input("\x1b[B"), undefined); h.prompt(false); assert.equal(h.input("\x1b[B"), undefined); h.prompt(false);
    assert.equal(h.input("\x1b[D"), undefined, "Left no longer activates the indicator");
    assert.deepEqual(h.input("\x1b[B"), { consume: true });
    assert.match(h.fleet(), /● main/, "Down enters the indicator and selects the first row");
    assert.match(h.fleet(), /○ a/, "other rows stay hollow");
    h.input("\x1b[B"); h.input("\r"); await tick();
    assert.equal(h.opens, 1); assert.equal(loads, 1); assert.match(h.render(), /a · test\/model · running/);
    assert.equal(h.input("\x1b[B"), undefined, "Open custom UI owns input, not the indicator's terminal hook");
    assert.equal(h.modelTurns, 0); h.inspector!.handleInput("\x1b"); await tick();
    assert.equal(h.closes, 1); assert.equal(h.editor, "");
    // The trigger is the caret's last line, not editor emptiness (UX §2.2).
    h.editor = "first line\nsecond line";
    assert.match(h.fleet(), /↓ to focus a subagent · Ctrl\+X stop all/, "the hint names the last-line action");
    assert.equal(h.input("\x1b[A"), undefined, "Up stays in the editor");
    assert.match(h.fleet(), /↓ to move down · Ctrl\+X stop all/, "the hint follows the caret away from the last line");
    assert.equal(h.input("\x1b[B"), undefined, "Down above the last line stays in the editor");
    assert.match(h.fleet(), /↓ to focus a subagent · Ctrl\+X stop all/, "the caret is now on the last line, so the hint names fleet focus");
    assert.doesNotMatch(h.fleet(), /●/);
    assert.deepEqual(h.input("\x1b[B"), { consume: true }, "Down on the last line enters the indicator");
    assert.match(h.fleet(), /● main/);
    h.input("\x1b");
    assert.match(h.fleet(), /↓ to focus a subagent · Ctrl\+X stop all/, "returning focus restores the last-line hint");
    assert.equal(h.editor, "first line\nsecond line", "the draft is unchanged");
  },
  "ACC-SA-02-02a": async ({ t }) => {
    const h = adapter(t);
    h.input("\x1b[B"); assert.match(h.fleet(), /● main/);
    h.input("\x1b"); await tick();
    assert.doesNotMatch(h.fleet(), /●/, "Escape returns focus and every circle goes hollow");
    assert.equal(h.input("j"), undefined, "the editor owns input again");
    h.input("\x1b[B"); assert.match(h.fleet(), /● main/);
    h.input("\x1b[A"); await tick();
    assert.doesNotMatch(h.fleet(), /●/, "Up on the first row returns focus to the editor");
    assert.equal(h.input("j"), undefined);
    h.input("\x1b[B"); assert.match(h.fleet(), /● main/);
    const opensBefore = h.opens;
    h.input("\r"); await tick();
    assert.equal(h.opens, opensBefore, "Enter on the main row does not open the fleet view overlay");
    assert.equal(h.input("j"), undefined, "Enter on the main row returns focus to the prompt input");
    assert.equal(h.modelTurns, 0);
  },
  "ACC-SA-02-02b": async ({ t }) => {
    const snapshots: AgentSnapshot[] = [];
    const listeners: (() => void)[] = [];
    const h = adapter(t, port({ list: () => snapshots, subscribe: listener => { listeners.push(listener); return () => {}; } }));
    assert.equal(h.fleet(), "", "nothing renders below the editor while no agent is active");
    assert.equal(h.input("\x1b[B"), undefined, "Down stays in the editor while the indicator is hidden");
    snapshots.push(snapshot("a")); for (const listener of listeners) listener(); await tick();
    const rows = h.fleet().split("\n");
    assert.equal(rows[0], "↓ to focus a subagent · Ctrl+X stop all");
    assert.equal(rows[1], "○ main", "the main session is the first agent row below the hint");
    assert.match(rows[2]!, /○ a · running/);
  },
  "ACC-SA-02-02c": async ({ t }) => {
    const service = await durableService(t), id = service.service.list()[0]!.agent.agentId;
    const h = adapter(t, service.port);
    h.input("\x1b[B"); assert.match(h.fleet(), new RegExp(`○ ${id.slice(0, 20)}`));
    await service.service.stop(service.service.run(id).runId, "op-stop");
    for (let i = 0; i < 50 && h.fleet().includes(id.slice(0, 20)); i++) await tick();
    assert.doesNotMatch(h.fleet(), new RegExp(id.slice(0, 20)), "the terminal row leaves the indicator immediately");
    h.input("\x1b[B"); h.input("\x1b[B"); h.input("\r"); await tick(); // Select the surviving agent and open its overlay.
    h.inspector!.handleInput("a"); await tick();
    assert.match(h.render(), new RegExp(`○ ${id.slice(0, 20)}`), "the finished agent stays inspectable in the overlay");
    h.inspector!.handleInput("\x1b"); await tick();
  },
  "ACC-SA-02-03": ({ t }) => {
    const draft = "Unsent draft 界\nsecond line";
    const h = adapter(t); h.editor = draft;
    assert.equal(h.input("\x1b[A"), undefined, "Up moves the caret within the editor");
    for (const key of ["\x1b[B", "\x1b[C", "\x1b[D"]) {
      assert.equal(h.input(key), undefined, "the editor receives cursor movement above its last line");
      assert.equal(h.editor, draft); assert.equal(h.opens, 0); assert.doesNotMatch(h.fleet(), /●/);
    }
    for (const key of ["j", "k"]) {
      assert.equal(h.input(key), undefined, "the editor receives ordinary typing");
      assert.match(h.editor, /Unsent draft 界/, "the indicator neither captures nor erases the draft");
      assert.equal(h.opens, 0); assert.doesNotMatch(h.fleet(), /●/);
    }
    assert.equal(h.modelTurns, 0);
  },
  "ACC-SA-02-04": async ({ t }) => {
    const service = await durableService(t), id = service.service.list()[0]!.agent.agentId;
    const h = adapter(t, service.port); h.editor = "Main draft";
    const closed = h.command(id); await tick(); assert.ok(h.inspector);
    h.inspector.handleInput("\x1b"); await closed;
    assert.equal(h.editor, "Main draft"); assert.equal(h.inspector, undefined); assert.equal(h.closes, 1);
    assert.equal(service.service.run(id).status, "running"); assert.equal(h.input("j"), undefined);
  },
  "ACC-SA-02-05": async () => {
    const h = new UIHarness().ready(); assert.equal(h.transcript().follow, "following");
    h.render(60); // A real inspector measures its viewport before receiving scroll input.
    h.inspector.handleInput("\x1b[5~"); const before = { ...h.transcript() };
    assert.equal(before.follow, "paused"); assert.ok(before.anchorEntryId);
    const window = plain(transcriptWindow(before, 60, 8));
    const load = h.select("a");
    await h.execute(load, port({ transcript: async () => [{ kind: "user", entryId: "prefix", text: "Earlier inserted content" }, ...fixtureEvents, { kind: "assistant", entryId: "arrival", text: "New arrival" }] }));
    assert.equal(h.transcript().anchorEntryId, before.anchorEntryId); assert.equal(h.transcript().anchorOffset, before.anchorOffset);
    assert.equal(h.transcript().follow, "paused"); assert.equal(plain(transcriptWindow(h.transcript(), 60, 8)), window);
    h.send({ type: "scroll", delta: 10000, pageSize: 8 }); assert.equal(h.transcript().follow, "following");
    assert.match(plain(transcriptWindow(h.transcript(), 60, 8)), /New arrival/);
  },
  "ACC-SA-02-06": () => {
    const h = new UIHarness().ready(); h.compose("Draft survives completion"); const dialog = h.state.dialog;
    const final = snapshot(); final.run!.status = "succeeded";
    const effects = h.send({ type: "snapshot", epoch: "e" }, [final]);
    assert.deepEqual(h.state.dialog, dialog); assert.ok(!effects.some(e => e.type === "focus" || e.type === "operate"));
    h.inspector.handleInput("\x1b"); assert.equal(h.state.navigation.kind, "inspector");
    assert.match(h.render(), /a · test\/model · succeeded/); assert.match(h.render(), /Output: \/output\/a.txt/);
  },
  "ACC-SA-02-07": ({ text }) => {
    const row: [string, RunStatus, RegExp][] = [["an unrecovered provider error", "failed", /failed/], ["a supported execution limit", "partial", /partial/], ["confirmed cancellation", "cancelled", /cancelled/], ["interruption after process death", "interrupted", /interrupted/]];
    const example = row.find(([given]) => text.includes(`ends with ${given}.`)); assert.ok(example, "Examples row must have an explicit status mapping");
    const record = snapshot(); record.run!.status = example[1];
    const h = new UIHarness([record]);
    h.send({ type: "open", viewId: "view" });
    h.inspector.handleInput("a"); // Terminal agents join the list only under the toggle.
    const load = h.select("a"); h.send({ ...load, type: "transcript", events: fixtureEvents });
    assert.match(h.render(), example[2]); assert.doesNotMatch(h.render(), /succeeded|successful completion/);
    const indicator = plain(new FleetView(() => h.state).render(120));
    assert.doesNotMatch(indicator, /failed|partial|cancelled|interrupted/, "terminal rows leave the indicator immediately");
    assert.equal(indicator.trim(), "", "the indicator renders nothing when only terminal agents exist");
  },
  "ACC-SA-02-08": () => {
    const h = new UIHarness().ready(); h.inspector.handleInput("\x1b[5~"); const before = structuredClone(h.state.navigation);
    assert.match(h.render(140), /│ .* │ /, "wide terminals show the roster beside the detail pane");
    for (const width of [72, 38]) {
      const lines = h.inspector.render(width); assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.doesNotMatch(plain(lines).split("\n")[0]!, / │ /, "narrow terminals stack panes without a side-by-side separator");
      assert.match(plain(lines), /a · test\/model/);
      assert.deepEqual(h.state.navigation, before);
    }
    h.inspector.handleInput("s"); assert.equal(h.state.dialog.kind, "composing"); h.inspector.handleInput("\x1b");
    h.inspector.handleInput("D");
    assert.equal(h.state.dialog.kind, "submitting", "the stop shortcut submits with no dialog to confirm");
    assert.ok(h.effects.some(e => e.type === "operate" && e.operation.action === "stop" && e.operation.agentId === "a"));
  },
  "ACC-SA-02-09": async ({ t }) => {
    const attacks = { "CSI clear screen": "\x1b[2J", "OSC clipboard BEL": "\x1b]52;c;Y2xpcGJvYXJk\x07", "OSC title ST": "\x1b]0;forged title\x1b\\", "DCS payload": "\x1bPmalicious payload\x1b\\", "C1 CSI": "\x9b2J" };
    for (const [name, attack] of Object.entries(attacks)) await t.test(name, () => {
      const h = new UIHarness().ready([{ kind: "tool", entryId: "shell-1", name: "shell", status: "complete", output: `Readable before ${attack} readable after` }]);
      h.inspector.handleInput("o");
      const rendered = h.inspector.render(120).join("\n");
      assert.ok(!rendered.includes(attack));
      assert.doesNotMatch(rendered, /Y2xpcGJvYXJk|forged title|malicious payload/);
      assert.match(plain([rendered]), /Readable before.*readable after/);
      assert.ok(!h.effects.some(e => e.type === "operate"));
    });
  },
  "ACC-SA-02-10": () => {
    const record = snapshot();
    assert.equal(Object.hasOwn(record.run!, "goal"), false, "Goal attribution belongs to composition, not UI snapshots");
    const h = new UIHarness([record]).ready(); const inspector = h.render();
    h.send({ type: "escape" }); h.send({ type: "fleet", downAtLastLine: true });
    for (const surface of [inspector, plain(h.fleet.render(140))]) {
      assert.doesNotMatch(surface, /(?:context|window).*\b0(?:%|\s*tokens?)|\b0%/i);
      assert.doesNotMatch(surface, /context|window|budget|token usage/i, "The current snapshot API exposes neither context nor goal-budget measurements; omit rather than invent either");
    }
  },
  "ACC-SA-02-11": () => {
    const running = snapshot("a"), running2 = snapshot("b"), queued = snapshot("c"), finished = snapshot("d");
    queued.run!.status = "queued"; finished.run!.status = "succeeded";
    const h = new UIHarness([running, running2, queued, finished]);
    h.send({ type: "open", viewId: "view" });
    let rendered = h.render(140);
    for (const id of ["a", "b", "c"]) assert.match(rendered, new RegExp(`○ ${id} `));
    assert.doesNotMatch(rendered, /○ d\b/, "the finished agent is absent by default");
    assert.doesNotMatch(rendered, /○ main/, "the main session is not a row in the overlay");
    h.inspector.handleInput("a");
    rendered = h.render(140);
    assert.match(rendered, /○ d\b/, "the toggle lists terminal agents");
    h.inspector.handleInput("a");
    assert.doesNotMatch(h.render(140), /○ d\b/, "toggling again hides terminal agents");
  },
  "ACC-SA-02-12": async () => {
    const h = new UIHarness().ready();
    const lines = plain(h.inspector.render(140)).split("\n");
    const assertGeometry = () => {
      const current = plain(h.inspector.render(140)).split("\n");
      assert.equal(current.length, h.height);
      for (const line of current) assert.equal(visibleWidth(line), 140);
      for (const line of current.slice(1, -1)) assert.equal(line.at(-1), "│");
      assert.equal(current[1]!.indexOf("│", 1), lines[1]!.indexOf("│", 1));
    };
    const divider = lines[1]!.indexOf("│", 1);
    assert.ok(divider - 3 >= 20 && divider - 3 <= 40);
    assert.ok(140 - divider - 4 >= Math.ceil(140 * 0.618));
    const larger = plain(h.inspector.render(300)).split("\n")[1]!;
    assert.equal(larger.indexOf("│", 1) - 3, 40);
    assertGeometry();
    assertGeometry();
    assert.match(lines[1]!, /│ ● a\b/, "the selected row carries the filled circle");
    assert.match(lines[1]!, /│ [^│]+│ a · running/, "the status header's first line shows name and status at the top of the transcript pane");
    assert.match(lines[2]!, /activity: /, "the header's second line shows current activity");
    assert.match(lines[3]!, /│ [^│]*│ ─{4,}/, "a single divider separates the header from the transcript");
    assert.doesNotMatch(lines.slice(1, 4).join("\n"), /┌|┐|└|┘/, "the header is an inline panel without an enclosing box");
    assert.match(lines[2]!, /│ ○ b +│/, "a list row shows only the selection circle and the agent name");
    h.inspector.handleInput("K"); // Scroll up: the header is fixed and does not scroll away.
    const scrolled = plain(h.inspector.render(140)).split("\n");
    assert.match(scrolled[1]!, /a · running/, "the status header does not scroll with the transcript");
    const load = h.select("b");
    assertGeometry(); // Loading retains the same frame and divider.
    await h.execute(load, port({ transcript: async () => [] }));
    assertGeometry(); // An empty transcript retains the same padded frame.
    assert.match(plain(h.inspector.render(140)).split("\n")[1]!, /b · running/, "the transcript pane follows the selection");
  },
  "ACC-SA-02-13": async () => {
    const a = snapshot("a"), c1 = snapshot("c1", "session-a"), c2 = snapshot("c2", "session-a");
    c1.agent.parentAgentId = "a"; c2.agent.parentAgentId = "a";
    const h = new UIHarness([a, c1, c2]);
    await h.execute(h.open("a"), port());
    let rendered = h.render(140);
    assert.match(rendered, /● a\b/); assert.doesNotMatch(rendered, /c1|c2/, "the root level lists top-level agents only");
    assert.match(rendered, /╭─ Agents · 1\/1/, "the root breadcrumb has no parent segment");
    h.inspector.handleInput("\r");
    const drill = h.effects.filter(e => e.type === "load").at(-1)!;
    assert.equal(drill.type === "load" && drill.agentId, "c1", "Enter drills in and selects the first child");
    await h.execute(drill, port());
    rendered = h.render(140);
    assert.match(rendered, /● c1/); assert.match(rendered, /○ c2/); assert.doesNotMatch(rendered, /○ a\b/);
    assert.match(rendered, /Agents › a/, "the title row shows the drill path");
    assert.match(rendered, /c1 · test\/model · running/, "the transcript pane shows the selected child");
    h.inspector.handleInput("\x1b[D");
    const back = h.effects.filter(e => e.type === "load").at(-1)!;
    assert.equal(back.type === "load" && back.agentId, "a", "Left returns to the parent level and re-selects the agent the user came from");
    await h.execute(back, port());
    rendered = h.render(140);
    assert.match(rendered, /● a\b/); assert.match(rendered, /╭─ Agents · 1\/1/);
    h.inspector.handleInput("\x1b[C");
    const again = h.effects.filter(e => e.type === "load").at(-1)!;
    assert.equal(again.type === "load" && again.agentId, "c1", "Right enters the level as Enter does");
    await h.execute(again, port());
    h.inspector.handleInput("\x1b[D"); await h.execute(h.effects.filter(e => e.type === "load").at(-1)!, port());
    const atRoot = h.state;
    h.inspector.handleInput("\x1b[D");
    assert.equal(h.state, atRoot, "Left at the root level does nothing");
  },
  "ACC-SA-02-14": async () => {
    const h = new UIHarness().ready();
    const before = h.state;
    h.inspector.handleInput("\r");
    assert.equal(h.state, before, "Enter on a childless agent does not change state");
    h.inspector.handleInput("\x1b[C");
    assert.equal(h.state, before, "Right on a childless agent does not change state");
    assert.match(h.render(), /a · test\/model · running/, "the transcript pane still shows the selected agent");
  },
  "ACC-SA-02-15": async () => {
    const a = snapshot("a"), b = snapshot("b", "session-a"), c = snapshot("c", "session-b");
    b.agent.parentAgentId = "a"; c.agent.parentAgentId = "b";
    const h = new UIHarness([a, b, c]);
    await h.execute(h.open("a"), port());
    h.inspector.handleInput("\r");
    const intoA = h.effects.filter(e => e.type === "load").at(-1)!;
    assert.equal(intoA.type === "load" && intoA.agentId, "b", "Enter drills into A and selects B");
    await h.execute(intoA, port());
    assert.match(h.render(140), /● b/, "A's level selects B");
    h.inspector.handleInput("\r");
    const intoB = h.effects.filter(e => e.type === "load").at(-1)!;
    assert.equal(intoB.type === "load" && intoB.agentId, "c", "Enter drills into B and selects C");
    await h.execute(intoB, port());
    const deep = h.render(140);
    assert.match(deep, /● c/, "B's level selects C");
    assert.match(deep, /Agents › /, "the title row shows the drill path at depth two");
    h.inspector.handleInput("\x1b[D");
    const back = h.effects.filter(e => e.type === "load").at(-1)!;
    assert.equal(back.type === "load" && back.agentId, "b", "Left returns to A's level with B re-selected");
    await h.execute(back, port());
    h.inspector.handleInput("\x1b[D");
    const root = h.effects.filter(e => e.type === "load").at(-1)!;
    assert.equal(root.type === "load" && root.agentId, "a", "Left returns to the root with A re-selected");
  },
  "ACC-SA-UI-01": async ({ t }) => {
    const service = await durableService(t), id = service.service.list()[0]!.agent.agentId;
    const h = adapter(t, service.port); h.editor = "Original main draft";
    const closed = h.command(id); await tick(); h.inspector!.handleInput("s"); h.inspector!.handleInput("unsent guidance");
    assert.match(h.render(), /unsent guidance/);
    assert.match(h.render().split("\n")[0]!, /^╭─ Agents ─+╮$/);
    h.inspector!.handleInput("\x1b[27u");
    assert.ok(h.inspector); assert.equal(h.closes, 0); assert.match(h.render(), /^╭─ Agents/m, "the fleet view overlay remains open"); assert.deepEqual(service.delivered, []);
    assert.equal(service.service.run(id).status, "running"); h.inspector!.handleInput("\x1b"); await closed;
    assert.equal(h.editor, "Original main draft"); assert.equal(h.input("k"), undefined); assert.equal(service.service.run(id).status, "running");
  },
  "ACC-SA-UI-02": async () => {
    const h = new UIHarness(), a = deferred<readonly TranscriptEvent[]>(), b = deferred<readonly TranscriptEvent[]>();
    const p = port({ transcript: id => id === "a" ? a.promise : b.promise });
    const first = h.execute(h.open("a"), p), loadB = h.select("b"), second = h.execute(loadB, p);
    assert.equal(loadB.type, "load");
    if (loadB.type === "load") for (const stale of [{ epoch: "old" }, { viewId: "old" }, { requestId: "old" }]) {
      const waiting = h.state;
      assert.deepEqual(h.send({ ...loadB, type: "transcript", events: [], ...stale }), []);
      assert.equal(h.state, waiting);
    }
    b.resolve([{ kind: "assistant", entryId: "b-1", text: "B visible" }]); await second; const before = h.state; const count = h.effects.length;
    a.resolve([{ kind: "assistant", entryId: "a-1", text: "A stale" }]); await first;
    assert.equal(h.state, before); assert.match(h.render(), /B visible/); assert.doesNotMatch(h.render(), /A stale/);
    assert.ok(!h.effects.slice(count).some(e => e.type === "focus"));
    assert.equal(h.state.navigation.kind === "inspector" && h.state.navigation.detail.kind !== "list" && h.state.navigation.detail.agentId, "b");
  },
  "ACC-SA-UI-03": async ({ t }) => {
    const service = await durableService(t), h = new UIHarness(service.service.list()).ready(), ack = deferred<void>(); let calls = 0;
    const p = port({ ...service.port, message: async (...args) => { calls++; const result = await service.port.message(...args); await ack.promise; return result; } });
    h.compose(); const op = h.submit(), pending = h.execute(op, p);
    h.inspector.handleInput("\r"); h.inspector.handleInput("\r");
    assert.equal(h.state.dialog.kind, "submitting"); assert.match(h.render(), /Waiting for acceptance/);
    assert.equal(h.effects.filter(e => e.type === "operate").length, 1); assert.equal(calls, 1);
    ack.resolve(); await pending; assert.equal(service.starts(), 2); assert.deepEqual(service.delivered, ["Check the edge cases"]);
    assert.equal(service.repository.guidance(service.service.run(op.operation.agentId).runId).length, 1);
  },
  "ACC-SA-UI-04": async () => {
    const h = new UIHarness().ready(); h.compose("Original guidance");
    await h.execute(h.submit(), port({ message: async () => { throw Object.assign(new Error("Recipient unavailable; revise recipient or retry after recovery."), { definitive: true }); } }));
    assert.equal(h.state.dialog.kind, "composing"); assert.match(h.render(), /Original guidance/); assert.match(h.render(), /revise recipient/); assert.doesNotMatch(h.render(), /accepted|Recorded acceptance/);
    assert.deepEqual(h.state.pending, {}); h.inspector.handleInput("!");
    assert.equal(h.state.dialog.kind === "composing" && h.state.dialog.draft, "!Original guidance");
  },
  "ACC-SA-UI-05": async ({ t }) => {
    const service = await durableService(t), h = new UIHarness(service.service.list()).ready(); let calls = 0;
    const p = port({ ...service.port, message: async (...args) => { calls++; await service.port.message(...args); throw new Error("Acknowledgment connection lost"); } });
    h.compose("Keep this target and text"); const op = h.submit(); await h.execute(op, p);
    assert.equal(h.state.dialog.kind, "uncertain"); assert.match(h.render(180), /Keep this target and text/); assert.match(h.render(180), new RegExp(op.operation.agentId));
    h.inspector.handleInput("\r"); h.send({ type: "submit", operationId: "replacement" });
    h.inspector.handleInput("\x1b"); h.inspector.handleInput("s"); assert.equal(h.state.dialog.kind, "uncertain");
    const receipt = h.effects.find(e => e.type === "receipt"); assert.ok(receipt); assert.deepEqual(receipt.operation, op.operation);
    await h.execute(receipt, p); assert.equal(h.state.dialog.kind, "closed"); assert.match(h.render(180), /Operation acceptance is recorded/);
    assert.deepEqual(h.state.pending, {}); assert.equal(calls, 1); assert.equal(service.starts(), 2); assert.deepEqual(service.delivered, ["Keep this target and text"]);
  },
  "ACC-SA-UI-06": async ({ t }) => {
    const service = await durableService(t), h = new UIHarness(service.service.list()).ready(), ack = deferred<void>(); let calls = 0;
    h.compose("First operation"); const op = h.submit();
    const pending = h.execute(op, port({ ...service.port, message: async (...args) => { calls++; const result = await service.port.message(...args); await ack.promise; return result; } }));
    h.inspector.handleInput("\x1b"); const b = service.service.list()[1]!.agent.agentId;
    await h.execute(h.select(b), service.port); h.compose("New unrelated draft");
    const dialog = h.state.dialog, before = h.effects.length;
    ack.resolve(); await pending;
    assert.deepEqual(h.state.dialog, dialog); assert.match(h.render(180), /New unrelated draft/); assert.ok(!h.effects.slice(before).some(e => e.type === "focus"));
    assert.equal(calls, 1); assert.equal(service.starts(), 2);
    const originalRun = service.service.run(op.operation.agentId);
    assert.equal(service.repository.guidance(originalRun.runId)[0]?.text, "First operation"); assert.ok(service.service.receipt(op.operation.id));
    assert.equal(originalRun.parentId, "p"); assert.deepEqual(service.delivered, ["First operation"]);
  },
  "ACC-SA-UI-07": () => {
    const h = new UIHarness().ready(); h.compose("Unsent follow-up"); assert.match(h.render(), /Queue guidance/); const before = h.state.dialog;
    const final = snapshot(); final.run!.status = "succeeded";
    const effects = h.send({ type: "snapshot", epoch: "e" }, [final]);
    assert.deepEqual(h.state.dialog, before); assert.match(h.render(), /Resume conversation: a/); assert.match(h.render(), /Unsent follow-up/);
    assert.ok(!effects.some(e => e.type === "operate" || e.type === "focus")); assert.deepEqual(h.state.pending, {});
  },
  "ACC-SA-UI-08": () => {
    const h = new UIHarness().ready();
    const finished = snapshot(); finished.run!.status = "succeeded";
    h.send({ type: "snapshot", epoch: "e" }, [finished]);
    h.inspector.handleInput("D");
    assert.equal(h.state.dialog.kind, "closed");
    assert.match(h.state.feedback ?? "", /not eligible/i);
    assert.ok(!h.effects.some(e => e.type === "operate"), "no stop request is submitted for an ineligible row");
  },
  "ACC-SA-UI-09": async () => {
    const idle = snapshot(); idle.run!.status = "succeeded";
    const h = new UIHarness([idle]);
    h.send({ type: "cleanup", agentId: "a" });
    const dialog = structuredClone(h.state.dialog); assert.equal(dialog.kind, "confirming");
    const changed = snapshot(); changed.run!.status = "succeeded"; changed.run!.revision = 20; changed.run!.output += "ordinary progress";
    h.send({ type: "snapshot", epoch: "e" }, [changed]);
    assert.deepEqual(h.state.dialog, dialog, "ordinary progress does not dismiss or redirect the confirmation");
    const calls: string[][] = [];
    await h.execute(h.submit(), port({ cleanup: async (agentId, operationId) => { calls.push([agentId, operationId]); } }));
    assert.equal(calls.length, 1); assert.equal(calls[0]![0], "a");
  },
  "ACC-SA-UI-10": async ({ t }) => {
    const service = await durableService(t), load = deferred<readonly TranscriptEvent[]>(), ack = deferred<void>();
    const id = service.service.list()[0]!.agent.agentId; let operationId = "";
    const h = adapter(t, port({ ...service.port, transcript: () => load.promise, message: async (target, text, op) => { operationId = op; const result = await service.port.message(target, text, op); await ack.promise; return result; } }));
    const first = h.command(id); await tick(); h.inspector!.handleInput("s"); h.inspector!.handleInput("Old-parent guidance"); h.inspector!.handleInput("\r"); await tick();
    assert.ok(operationId); h.replaceSession("new-parent", "New session draft"); await first;
    const opens = h.opens; load.resolve([{ kind: "assistant", entryId: "old", text: "Old parent transcript" }]); ack.resolve(); await tick();
    assert.equal(h.opens, opens); assert.equal(h.inspector, undefined); assert.equal(h.editor, "New session draft"); assert.equal(h.input("\x1b[B"), undefined);
    assert.equal(service.repository.guidance(service.service.run(id).runId)[0]?.text, "Old-parent guidance"); assert.equal(service.service.run(id).parentId, "p"); assert.ok(service.service.receipt(operationId));
    assert.equal(h.modelTurns, 0);
  },
  "ACC-SA-UI-11": () => {
    const h = new UIHarness().ready(); h.inspector.handleInput("\x1b[5~"); const before = structuredClone(h.transcript());
    const window = plain(transcriptWindow(before, 60, 5)); h.height = 22; h.inspector.render(60);
    const final = snapshot(); final.run!.status = "succeeded";
    h.send({ type: "snapshot", epoch: "e" }, [final]);
    assert.deepEqual(h.transcript(), before); assert.equal(plain(transcriptWindow(h.transcript(), 60, 5)), window);
    const load = h.select("a"); assert.equal(load.type, "load"); if (load.type === "load") h.send({ ...load, type: "transcript", events: [...fixtureEvents, { kind: "assistant", entryId: "final", text: "Final output" }] });
    assert.equal(h.transcript().follow, "paused"); assert.equal(h.transcript().anchorEntryId, before.anchorEntryId);
    h.send({ type: "scroll", delta: 10000, pageSize: 10 }); assert.equal(h.transcript().follow, "following");
    assert.match(plain(transcriptWindow(h.transcript(), 60, 10)), /Final output/);
  },
  "ACC-SA-UI-12": async ({ t }) => {
    const record = snapshot(); record.run!.status = "succeeded"; let cleanups = 0;
    const h = adapter(t, port({ list: () => [record], cleanup: async () => { cleanups++; } })); h.editor = "Draft originating editor";
    const closed = h.command("cleanup a"); await tick(); assert.match(h.render(), /Confirm cleanup: a/); assert.doesNotMatch(h.render(), /Agents ·/);
    h.inspector!.handleInput("\x1b"); await closed;
    assert.equal(h.editor, "Draft originating editor"); assert.equal(h.inspector, undefined); assert.equal(h.closes, 1); assert.equal(cleanups, 0); assert.equal(h.input("j"), undefined);
    const reducer = new UIHarness([record]); reducer.send({ type: "cleanup", agentId: "a" });
    assert.equal(reducer.state.navigation.kind, "editor"); assert.ok(reducer.send({ type: "escape" }).some(e => e.type === "focus" && e.target === "editor"));
  },
  "ACC-SA-UI-13": async () => {
    const h = new UIHarness(); await h.execute(h.open("a"), port({ transcript: async () => { throw new Error("Transcript file missing: a.jsonl"); } }));
    assert.match(h.render(), /a · test\/model/); assert.match(h.render(), /Transcript file missing: a.jsonl/); assert.match(h.render(), /r\/R retries/);
    assert.equal(h.state.navigation.kind === "inspector" && h.state.navigation.detail.kind !== "list" && h.state.navigation.detail.agentId, "a");
    h.inspector.handleInput("r"); const retry = h.effects.filter(e => e.type === "load").at(-1)!; assert.equal(retry.type === "load" && retry.agentId, "a");
    await h.execute(retry, port({ transcript: async () => [{ kind: "assistant", entryId: "recovered", text: "A recovered" }] })); assert.match(h.render(), /A recovered/);
    h.inspector.handleInput("j"); const next = h.effects.filter(e => e.type === "load").at(-1)!;
    assert.equal(next.type === "load" && next.agentId, "b"); await h.execute(next, port());
    h.inspector.handleInput("\x1b"); assert.equal(h.state.navigation.kind, "editor");
  },
  "ACC-SA-UI-14": async ({ t }) => {
    const service = await durableService(t);
    const rows = service.service.viewModels();
    assert.equal(rows.filter(r => r.background && r.status === "running").length, 2, "both launched runs are active background executions");
    const h = new UIHarness(service.service.list()); h.send({ type: "fleet", downAtLastLine: true });
    const rendered = plain(h.fleet.render(140));
    assert.match(rendered.split("\n")[1]!, /● main/, "the first agent row below the hint is the main session");
    for (const row of rows) assert.match(rendered, new RegExp(`○ ${row.agentId} · running`), "each active execution lists a status label");
    const finished = snapshot("done"); finished.run!.status = "succeeded";
    const withFinished = transition(h.state, { type: "snapshot", epoch: "e" }, [...h.state.snapshots, finished]).state;
    const after = plain(new FleetView(() => withFinished, { rows: () => [...rows, { agentId: "done", status: "succeeded", description: "done", model: "test/model", background: true }] }).render(140));
    assert.doesNotMatch(after, /done/, "the completed execution is absent from the indicator");
    const output = service.service.run(rows[0]!.agentId);
    assert.equal(rows[0]!.status, output.status, "indicator rows and tool responses share the same underlying state");
  },
  "ACC-SA-UI-15": async ({ t }) => {
    const root = mkdtempSync(join(tmpdir(), "inline-mode-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const record = snapshot(); record.run!.status = "succeeded"; record.run!.endedAt = 4600; record.run!.startedAt = 1000;
    record.run!.background = false;
    record.run!.prompt = "Original delegated prompt";
    record.run!.output = "Original child result";
    const result = { content: [{ type: "text" as const, text: "Agent: a\nStatus: succeeded" }], details: record.run! };
    for (const legacy of ["rich", "summary"]) {
      writeFileSync(join(root, "secretary.json"), JSON.stringify({ agents: { ui: { inlineToolDisplay: legacy } } }));
      const config = loadAgentConfiguration(root, root, false);
      assert.ok(!("inlineToolDisplay" in config.ui), "the accepted legacy key is not a rendering mode");
      const compact = renderAgentResult(result, { expanded: false, isPartial: false }).render(100);
      assert.equal(compact.length, 1);
      assert.match(plain(compact), /^✓ succeeded/);
      assert.doesNotMatch(plain(compact), /Original delegated prompt|Original child result/);
      const full = plain(renderAgentResult(result, { expanded: true, isPartial: false }).render(100));
      assert.match(full, /Prompt:\nOriginal delegated prompt\nResult:\nOriginal child result/);
    }
    record.run!.status = "running"; record.run!.endedAt = undefined;
    const live = plain(renderAgentResult(result, { expanded: false, isPartial: true }, { now: () => 6500 }).render(100));
    assert.match(live, /● running/); assert.doesNotMatch(live, /task: a inspection/); assert.match(live, /expand.*task details.*result/i);
  },
  "ACC-SA-UI-16": async ({ t }) => {
    const root = mkdtempSync(join(tmpdir(), "keybindings-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "secretary.json"), JSON.stringify({ agents: { ui: { fleetKeybindings: { stop: ["shift+t"], close: ["ctrl+q"] } } } }));
    const config = loadAgentConfiguration(root, root, false);
    const h = new UIHarness().ready();
    const dispatched: string[] = [];
    const inspector = new Inspector(() => h.state, e => { dispatched.push(e.type); }, () => "id", () => 22, { keybindings: config.ui.fleetKeybindings });
    inspector.handleInput("T");
    assert.deepEqual(dispatched, ["stop"], "the configured stop key submits without a confirmation step");
    const footer = plain(inspector.render(200));
    assert.match(footer, /T Stop/); assert.match(footer, /Ctrl\+Q Close/); assert.doesNotMatch(footer, /· X Stop ·/);
    writeFileSync(join(root, "secretary.json"), JSON.stringify({ agents: { ui: { fleetKeybindings: { inspect: ["i"] } } } }));
    assert.throws(() => loadAgentConfiguration(root, root, false), /not a supported inspector action/);
  },
  "ACC-SA-UI-18": async ({ t }) => {
    const stopped: string[] = [];
    const h = adapter(t, port({ stop: async id => { stopped.push(id); } }));
    assert.match(h.fleet(), /^↓ to focus a subagent · Ctrl\+X stop all\n○ main/);
    assert.doesNotMatch(h.fleet(), /X Stop · Ctrl\+X Stop all/);
    const initialHeight = h.fleet().split("\n").length;
    h.input("\x1b[B");
    assert.match(h.fleet(), /^X Stop · Ctrl\+X Stop all\n● main/);
    // A terminal that reports kitty-protocol event types delivers press and release for one key.
    h.input("\x1b[1;1:3B");
    assert.match(h.fleet(), /^X Stop · Ctrl\+X Stop all\n● main/, "the release does not advance the selection again");
    assert.equal(h.fleet().split("\n").length, initialHeight);
    h.input("\x1b");
    assert.match(h.fleet(), /^↓ to focus a subagent · Ctrl\+X stop all\n○ main/);
    assert.equal(h.fleet().split("\n").length, initialHeight);
    assert.equal(h.input("X"), undefined, "the editor receives X unchanged");
    h.input("\x1b[B");
    assert.match(h.fleet(), /^X Stop · Ctrl\+X Stop all\n● main/);
    assert.doesNotMatch(h.fleet(), /focus a subagent/);
    h.input("\x1b[B"); h.input("X"); await tick();
    assert.deepEqual(stopped, ["a-run"], "X submits the selected stop with no confirmation step");
    assert.equal(h.inspector, undefined, "the settled request closes the overlay");
    assert.match(h.fleet(), /^X Stop · Ctrl\+X Stop all/, "the list regains focus");
  },
  "ACC-SA-UI-19": async ({ t }) => {
    let snapshots = [snapshot(), snapshot("b"), snapshot("foreign", "other")];
    const listeners = new Set<() => void>(), stopped: string[] = [];
    const h = adapter(t, port({ list: () => snapshots, stop: async id => { stopped.push(id); }, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; } }));
    h.editor = "Main draft"; h.input("\x18"); await tick();
    assert.deepEqual(stopped, ["a-run", "b-run"], "Ctrl+X submits the captured batch without a confirmation step");
    snapshots = snapshots.map(s => s.agent.agentId === "a" ? { ...s, run: { ...s.run!, runId: "replacement" } } : s);
    snapshots.push(snapshot("new")); for (const fn of listeners) fn();
    await tick();
    assert.deepEqual(stopped, ["a-run", "b-run"], "a later admission is not added to the captured batch");
    assert.equal(h.editor, "Main draft");
    assert.match(h.fleet(), /b · running/, "UI acceptance does not manufacture completion");
  },
  "ACC-SA-UI-20": async () => {
    const h = new UIHarness().ready(); let calls = 0;
    const p = port({ stopMany: async () => { calls++; throw new Error("Acknowledgment lost"); }, receipt: () => ({ outcome: "accepted", message: "Cancellation accepted, not completed." }) });
    h.inspector.handleInput("\x18"); const op = h.effects.find(e => e.type === "operate"); assert.ok(op, "Ctrl+X submits in the same event"); await h.execute(op, p);
    assert.equal(h.state.dialog.kind, "uncertain");
    for (const key of ["x", "\x18"]) {
      h.inspector.handleInput("\x1b"); h.inspector.handleInput(key);
      assert.equal(h.state.dialog.kind, "uncertain");
      assert.ok(!h.send({ type: "submit", operationId: "duplicate" }).some(e => e.type === "operate"));
    }
    const receipt = h.effects.find(e => e.type === "receipt"); assert.ok(receipt);
    await h.execute(receipt, p); assert.equal(h.state.dialog.kind, "closed"); assert.equal(calls, 1);
    assert.match(h.render(), /Cancellation accepted, not completed/);
  },
  "ACC-SA-UI-17": () => {
    const h = new UIHarness().ready();
    const wide = plain(h.inspector.render(140));
    assert.match(wide, /╭─ Agents · 1\/2 · 2 active ─+╮/); assert.match(wide, /╰─+╯/); assert.match(wide, /Esc Close/);
    const narrow = h.inspector.render(60);
    assert.match(plain(narrow), /╭─ Agents · 1\/2/);
    assert.doesNotMatch(plain(narrow).split("\n")[1]!, / │ /);
    for (const width of [0, 10, 35]) {
      const lines = h.inspector.render(width);
      assert.ok(lines.length <= 1, `sub-minimum width ${width} renders only the diagnostic line`);
    }
  },
};
runFeatures(["agent-inspection", "ui-state-machine"], bindings, {
  "agent-inspection": "0f1a90637b99402a03c906c2d71df18105ae36a7b64c45c113d365dc383c0d83",
  "ui-state-machine": "4b6b3f33863aba14aca996503ca03b73574b2ad9e555a5e79d17a8fc932cdd81",
});
