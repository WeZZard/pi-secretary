import { test } from "node:test";
import assert from "node:assert/strict";
import { goalHarness, assistant } from "../support/goal-harness.ts";
import { SNAPSHOT_TYPE } from "../../extensions/secretary/goal/synchronization.ts";

const snapshot = (messages: any[]) => messages.find((m) => m.customType === SNAPSHOT_TYPE)?.content as string;

test("tool create initializes UI and tool text without a command; every context has one current snapshot", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  assert.equal(h.state.widget, undefined);
  const result = await h.tool("create_goal", { objective: "Ship </objective> safely", token_budget: 100 });
  assert.match(h.state.widget?.[0] ?? "", /▶ Goal: active/);
  assert.match(result.content[0].text, /Token budget: 100/);
  assert.match(result.content[0].text, /Elapsed goal time: 0 seconds/);
  assert.ok(!result.content[0].text.includes("</objective>"));
  const first = await h.context();
  const next = await h.context(first);
  assert.equal(next.filter((m: any) => m.customType === SNAPSHOT_TYPE).length, 1);
  assert.match(snapshot(next), /Goal \[active\]/);
});

test("pause and clear agree across storage, UI, command text and subsequent model requests", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  await h.command("Ship it");
  const history = [{ role: "custom", customType: "secretary:goal", content: "Continue the active goal" },
    { role: "user", content: "Is the goal blocked?" },
    { role: "assistant", content: "The goal is active" }];
  await h.command("pause");
  assert.match(h.state.widget?.[0] ?? "", /⏸ Goal: paused/); assert.equal(h.notices.at(-1), "Goal paused.");
  const paused = await h.context(history);
  assert.equal(snapshot(paused), undefined, "no goal message is injected outside active pursuit");
  assert.ok(!paused.some((m: any) => m.customType === "secretary:goal"));
  assert.equal(paused[0], history[1]); assert.equal(history.length, 3);
  await h.command("clear");
  assert.equal(h.engine.service.getGoal(h.state.threadId), null);
  assert.equal(h.state.widget, undefined);
  assert.equal(snapshot(await h.context(paused)), undefined, "clear injects no replacement message");
  await h.flush(); assert.equal(h.sent.length, 0);
});

test("exhausted-budget resume and pause never claim success", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  await h.tool("create_goal", { objective: "Budget test", token_budget: 1 });
  h.engine.service.accountGoalUsage(h.state.threadId, 0, 2, "active_only");
  for (const command of ["resume", "pause"]) {
    await h.command(command);
    assert.match(h.state.widget?.[0] ?? "", /\$ Goal: budget_limited/);
    assert.match(h.notices.at(-1)!, /budget_limited/);
    assert.equal(snapshot(await h.context()), undefined, "a non-active status injects no goal message");
  }
});

test("terminal tools synchronize actual status, account known usage and finalize late usage", async (t) => {
  for (const status of ["paused", "blocked", "complete"]) {
    const h = goalHarness(); t.after(() => h.close()); await h.start();
    await h.tool("create_goal", { objective: "Terminal update" });
    h.state.idle = false;
    await h.emit("turn_start", { turnIndex: 0 });
    await h.emit("message_end", { message: assistant("toolUse", 10) });
    const result = await h.tool("update_goal", { status });
    assert.match(result.content[0].text, new RegExp(`Goal \\[${status}\\]`));
    assert.match(result.content[0].text, /plus output\): 10/);
    await h.emit("turn_end", { message: assistant("toolUse", 12) });
    assert.equal(h.engine.service.getGoal(h.state.threadId)?.tokensUsed, 12);
    assert.equal(h.engine.runtimeFor(h.state.threadId).accountingState().currentTurnId(), null);
    assert.match(h.state.widget?.[0] ?? "", new RegExp(`Goal: ${status}`));
  }
});

test("creation-turn baseline excludes pre-goal usage; late clear cannot recreate the goal", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); h.state.idle = false;
  await h.emit("turn_start", {});
  await h.emit("message_end", { message: assistant("toolUse", 30) });
  await h.tool("create_goal", { objective: "New goal" });
  await h.emit("turn_end", { message: assistant("toolUse", 30) });
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.tokensUsed, 0);
  await h.emit("turn_start", {});
  await h.emit("message_end", { message: assistant("toolUse", 5) });
  await h.command("clear");
  await h.emit("turn_end", { message: assistant("stop", 9) });
  assert.equal(h.engine.service.getGoal(h.state.threadId), null);
  assert.equal(h.engine.runtimeFor(h.state.threadId).accountingState().currentTurnId(), null);
});

test("intermediate provider error stays active after successful retry; unrecovered error stops at settlement", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("Recover");
  h.state.idle = false;
  await h.emit("turn_start", {});
  await h.emit("turn_end", { message: assistant("error", 0) });
  assert.match(h.state.widget?.[0] ?? "", /▶ Goal: active/);
  await h.emit("turn_start", {});
  await h.emit("turn_end", { message: assistant("stop", 10) });
  h.state.idle = true; await h.emit("agent_settled");
  assert.match(h.state.widget?.[0] ?? "", /▶ Goal: active/);
  h.state.idle = false; await h.emit("turn_start", {});
  await h.emit("turn_end", { message: assistant("error", 0) });
  h.state.idle = true; await h.emit("agent_settled");
  assert.match(h.state.widget?.[0] ?? "", /ℹ Goal: blocked/);
  assert.equal(snapshot(await h.context()), undefined, "a blocked goal injects no goal message");
});

test("a failed run cannot override intervening intent, and an abort is not an impasse", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First");
  h.state.idle = false; await h.emit("turn_start", {});
  await h.emit("turn_end", { message: assistant("error", 0) });
  await h.command("pause"); h.state.idle = true; await h.emit("agent_settled");
  assert.match(h.state.widget?.[0] ?? "", /⏸ Goal: paused/);
  await h.command("resume"); h.state.idle = false; await h.emit("turn_start", {});
  await h.emit("turn_end", { message: assistant("aborted", 0) });
  h.state.idle = true; await h.emit("agent_settled");
  assert.match(h.state.widget?.[0] ?? "", /▶ Goal: active/);
});

test("fork imports full snapshot and renders target immediately; unknown legacy cause is not invented", async (t) => {
  const h = goalHarness({ threadId: "target" }); t.after(() => h.close());
  h.engine.service.createGoal("source", "Inherited", 100);
  h.engine.service.accountGoalUsage("source", 7, 12, "active_only");
  h.engine.service.requestTerminalUpdate("source", "blocked", "agent");
  const original = h.engine.service.getGoal("source")!;
  await h.emit("session_start", { reason: "fork", previousSessionFile: "source" });
  assert.deepEqual(h.engine.service.getGoal("target"), { ...original, threadId: "target" });
  assert.match(h.state.widget?.[0] ?? "", /ℹ Goal: blocked/);
  assert.equal(snapshot(await h.context()), undefined, "a blocked goal injects no goal message");
});

test("every restored stopped status reaches both UI and agent without resuming", async (t) => {
  for (const status of ["paused", "blocked", "complete", "usage_limited", "budget_limited"] as const) {
    const h = goalHarness(); t.after(() => h.close());
    h.engine.service.createGoal(h.state.threadId, "Restored", 10);
    if (status === "budget_limited") h.engine.service.accountGoalUsage(h.state.threadId, 1, 10, "active_only");
    else h.engine.service.setGoal(h.state.threadId, { status }, "system");
    await h.start();
    assert.match(h.state.widget?.[0] ?? "", new RegExp(`Goal: ${status}`));
    assert.equal(snapshot(await h.context()), undefined, "a restored non-active status injects no goal message");
    await h.flush(); assert.equal(h.sent.length, status === "budget_limited" ? 1 : 0);
    if (status === "budget_limited") assert.equal(h.sent[0].details.kind, "budget_wrap_up");
    assert.equal(h.engine.service.getGoal(h.state.threadId)?.status, status);
  }
});

test("headless snapshots and automatic continuation work without a UI",  async (t) => {
  const h = goalHarness({ hasUI: false }); t.after(() => h.close()); await h.start();
  await h.tool("create_goal", { objective: "Headless" }); await h.flush();
  assert.match(snapshot(await h.context()), /Headless/);
  assert.equal(h.sent.length, 1); assert.equal(h.state.widget, undefined);
  assert.equal(h.engine.service.ordering.publication(h.state.threadId), undefined);
});

test("read failure reports unavailable once per process and injects no goal message", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const original = h.engine.service.getGoal.bind(h.engine.service);
  h.engine.service.getGoal = () => { throw new Error("Storage unavailable"); };
  const user = { role: "user", content: "Status?" };
  const context = await h.context([user]);
  assert.equal(context[0], user);
  assert.equal(snapshot(context), undefined, "a read fault injects no goal message");
  assert.match(h.state.widget?.[0] ?? "", /Goal: unavailable/);
  assert.equal(h.notices.filter((n) => /Goal synchronization/.test(n)).length, 1, "the fault is reported once");
  await h.context([user]);
  assert.equal(h.notices.filter((n) => /Goal synchronization/.test(n)).length, 1, "a repeated fault is not reported again in this process");
  h.engine.service.getGoal = original;
});

test("revision cursors and UI binding are isolated across threads", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First");
  h.engine.service.accountGoalUsage(h.state.threadId, 1, 1, "active_only");
  h.engine.service.accountGoalUsage(h.state.threadId, 1, 1, "active_only");
  h.state.threadId = "session-b"; await h.start(); await h.tool("create_goal", { objective: "Second" });
  assert.match(h.state.widget?.[0] ?? "", /▶ Goal: active/); assert.match(h.state.widget!.join("\n"), /Second/);
  await h.command("pause"); assert.match(h.state.widget?.[0] ?? "", /⏸ Goal: paused/);
  assert.equal(snapshot(await h.context()), undefined, "a paused goal injects no goal message");
});

test("late failure audit cannot block an edited objective with the same goal ID", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("Old objective");
  h.state.idle = false;
  for (let i = 0; i < 3; i++) {
    await h.emit("turn_start", {});
    await h.emit("tool_execution_end", { toolName: "bash", isError: true });
    if (i === 2) await h.command("New objective");
    await h.emit("turn_end", { message: assistant("toolUse", 1) });
  }
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.status, "active");
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.objective, "New objective");
});

test("reentrant accounting listeners cannot charge an uncommitted baseline twice", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("Once");
  h.state.idle = false; await h.emit("turn_start", {});
  let nested = false;
  h.engine.service.onGoalChanged((event) => {
    if (event.reason === "accounting" && !nested) {
      nested = true; h.engine.runtimeFor(h.state.threadId).checkpoint();
    }
  });
  await h.emit("message_end", { message: assistant("toolUse", 10) });
  await h.emit("turn_end", { message: assistant("toolUse", 10) });
  assert.equal(nested, true); assert.equal(h.engine.service.getGoal(h.state.threadId)?.tokensUsed, 10);
});

test("goal tools render calls and results with the specified formats", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  const theme: any = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
  const render = (component: any) => component.render(80).map((line: string) => line.trimEnd()).join("\n").trimEnd();

  const create = h.tools.get("create_goal");
  assert.equal(render(create.renderCall({ objective: "Ship the widget", token_budget: 25000 }, theme)),
    "Create Goal: Ship the widget, 25K tokens");
  assert.equal(render(create.renderCall({ objective: "Ship the widget" }, theme)), "Create Goal: Ship the widget");
  assert.equal(render(create.renderResult({ content: [{ type: "text", text: "x" }], details: { goal: null, remaining_tokens: null } }, { expanded: false, isPartial: false }, theme)), "Goal created.");
  assert.equal(render(create.renderResult({ content: [{ type: "text", text: "objective must not be empty" }], details: undefined }, { expanded: false, isPartial: false }, theme)),
    "Error: objective must not be empty");

  const update = h.tools.get("update_goal");
  assert.equal(render(update.renderCall({ status: "complete" }, theme)), "Completed Goal");
  assert.equal(render(update.renderCall({ status: "paused" }, theme)), "Paused Goal");
  await h.tool("create_goal", { objective: "Report format", token_budget: 25000 });
  h.engine.service.requestTerminalUpdate(h.state.threadId, "complete", "agent");
  const goal = h.engine.service.getGoal(h.state.threadId)!;
  const result = (expanded: boolean) => render(update.renderResult(
    { content: [{ type: "text", text: "x" }], details: { goal, remaining_tokens: 25000 } },
    { expanded, isPartial: false }, theme));
  assert.equal(result(false), "Completed Goal. Consumed 0 tokens; Used 0 sec; Budget 25K tokens");
  assert.equal(result(true), `Completed Goal. Consumed 0 tokens; Used 0 sec; Budget 25K tokens\n\nObjective: Report format`);
  const noBudget = { ...goal, tokenBudget: undefined };
  assert.equal(render(update.renderResult({ content: [{ type: "text", text: "x" }], details: { goal: noBudget, remaining_tokens: null } },
    { expanded: false, isPartial: false }, theme)), "Completed Goal. Consumed 0 tokens; Used 0 sec");
  assert.equal(render(update.renderResult({ content: [{ type: "text", text: "no goal" }], details: undefined },
    { expanded: false, isPartial: false }, theme)), "Error: no goal");
});

test("the first user message after completion hides the widget until the goal changes", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  await h.tool("create_goal", { objective: "Hide after done" });
  assert.match(h.state.widget?.[0] ?? "", /▶ Goal: active/);
  h.state.idle = false; await h.emit("turn_start");
  await h.emit("message_end", { message: assistant("toolUse", 5) });
  await h.tool("update_goal", { status: "complete" });
  await h.emit("turn_end", { message: assistant("toolUse", 5) });
  assert.match(h.state.widget?.[0] ?? "", /⏹ Goal: complete/);
  await h.emit("input", { source: "interactive", text: "Next task please" });
  h.sync.refresh();
  assert.equal(h.state.widget, undefined, "the first message after completion hides the widget");
  h.sync.refresh();
  assert.equal(h.state.widget, undefined, "per-request refreshes do not repaint the hidden widget");
  await h.tool("create_goal", { objective: "New work" });
  assert.match(h.state.widget?.[0] ?? "", /▶ Goal: active/, "a new goal repaints the widget");
});

test("renderer and diagnostic failures do not suppress authoritative model context", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  h.ctx.ui.setWidget = () => { throw new Error("renderer failed"); };
  h.ctx.ui.notify = () => { throw new Error("notification failed"); };
  h.sync.bind(h.ctx);
  const result = await h.tool("create_goal", { objective: "Keep both consumers independent" });
  assert.equal(result.details.goal.status, "active");
  assert.match(snapshot(await h.context()), /Goal \[active\]/);
});

test("clear confirmation cancellation and stale editor do not mutate a different goal", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First");
  h.state.confirm = false; await h.command("clear");
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.objective, "First");
  h.ctx.ui.editor = async () => {
    h.engine.service.requestTerminalUpdate(h.state.threadId, "complete", "agent");
    h.engine.service.createGoal(h.state.threadId, "Replacement");
    return "Stale edit";
  };
  await h.command("edit");
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.objective, "Replacement");
  assert.match(h.notices.at(-1)!, /changed while/);
});
