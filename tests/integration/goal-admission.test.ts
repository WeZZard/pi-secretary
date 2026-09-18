import { test } from "node:test";
import assert from "node:assert/strict";
import { goalHarness, assistant } from "../support/goal-harness.ts";
import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";

// Admission is now the controller's local check-and-submit boundary, not a host veto.
test("continuation submits through Pi only when idle with no pending input and available tools", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  h.state.idle = false; await h.command("Work"); await h.flush(); assert.equal(h.sent.length, 0);
  h.state.idle = true; h.state.pending = true; h.sync.requestAutomatic(); await h.flush(); assert.equal(h.sent.length, 0);
  h.state.pending = false; h.state.activeTools = []; h.sync.requestAutomatic(); await h.flush(); assert.equal(h.sent.length, 0);
  h.state.activeTools = ["get_goal", "create_goal", "update_goal"];
  h.sync.requestAutomatic(); await h.flush(); assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].details.kind, "continuation");
  assert.equal(h.sent[0].details.intentSeq, h.engine.service.ordering.intentSeq(h.state.threadId));
});

test("a decision received before local dispatch prevents obsolete pending work", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  await h.command("First"); await h.command("pause"); await h.flush(); assert.equal(h.sent.length, 0);
  await h.command("resume"); await h.command("Revised"); await h.flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].details.intentSeq, h.engine.service.ordering.intentSeq(h.state.threadId));
});

test("already-dispatched work can finish but cannot act or change status after a newer pause", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First"); await h.flush();
  const request = h.sent[0]; h.state.idle = false;
  await h.emit("turn_start"); await h.context([request]);
  await h.command("pause");
  const blocked = await h.emit("tool_call", { toolName: "bash", input: { command: "echo obsolete" } });
  assert.equal(blocked.block, true);
  await assert.rejects(h.tool("update_goal", { status: "blocked" }), /superseded/);
  await h.emit("turn_end", { message: assistant("error", 7) });
  h.state.idle = true; await h.emit("agent_settled"); await h.flush();
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.status, "paused");
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.tokensUsed, 7);
  assert.equal(h.sent.length, 1); assert.equal(h.state.aborts, 0);
});

test("stale wake-up receives current state and preserves an unrelated status question", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First"); await h.flush();
  await h.command("clear"); h.state.idle = false; await h.emit("turn_start");
  const stale = await h.context([h.sent[0]]);
  assert.equal(stale.length, 0, "a stale wake-up for a cleared goal leaves no extension message in context");
  await h.emit("input", { source: "interactive", text: "What is the status?" });
  const user = await h.userMessage("What is the status?", 17);
  const context = await h.context([h.sent[0], user]);
  assert.equal(context[0], user);
  assert.equal((await h.tool("get_goal")).details.goal, null);
  assert.equal(h.state.aborts, 0);
  await h.emit("turn_end", { message: assistant() });
  h.state.idle = true; await h.emit("agent_settled"); await h.flush();
  assert.equal(h.sent.length, 1);
});

test("valid no-op resume supersedes an older failure without requiring a state revision", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First");
  h.state.idle = false; await h.emit("turn_start");
  await h.emit("turn_end", { message: assistant("error", 0) });
  const version = h.engine.service.getVersion(h.state.threadId);
  const intent = h.engine.service.ordering.intentSeq(h.state.threadId);
  await h.command("resume");
  assert.deepEqual(h.engine.service.getVersion(h.state.threadId), version);
  assert.ok(h.engine.service.ordering.intentSeq(h.state.threadId) > intent);
  h.state.idle = true; await h.emit("agent_settled");
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.status, "active");
});

test("a delayed user's goal tool cannot borrow a newer decision's authority", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First");
  await h.emit("input", { text: "Pause the goal.", source: "interactive" });
  h.state.idle = false; await h.emit("turn_start");
  await h.context([await h.userMessage("Pause the goal.", 1)]);
  await h.command("New objective");
  await assert.rejects(h.tool("update_goal", { status: "paused" }), /superseded|older|stale/i);
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.status, "active");
});

test("unresolved input holds dispatch and a status question does not advance accepted intent", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First");
  const intent = h.engine.service.ordering.intentSeq(h.state.threadId);
  await h.emit("input", { text: "Status?", source: "interactive" }); await h.flush(); assert.equal(h.sent.length, 0);
  h.state.idle = false; await h.emit("turn_start");
  await h.context([await h.userMessage("Status?", 2)]);
  await h.tool("get_goal"); await h.emit("turn_end", { message: assistant() });
  assert.equal(h.engine.service.ordering.intentSeq(h.state.threadId), intent);
  h.state.idle = true; await h.emit("agent_settled"); await h.flush(); assert.equal(h.sent.length, 1);
});

test("budget summary is dispatched once across reload and a new exhaustion allows a fresh summary", async () => {
  const h = goalHarness(); await h.start();
  await h.tool("create_goal", { objective: "Budget", token_budget: 10 });
  h.engine.service.accountGoalUsage(h.state.threadId, 0, 10, "active_only"); await h.flush();
  assert.equal(h.sent[0].details.kind, "budget_wrap_up");
  h.state.idle = false; await h.emit("turn_start"); await h.context([h.sent[0]]);
  await h.emit("turn_end", { message: assistant("stop", 0) });
  h.state.idle = true; await h.emit("agent_settled"); await h.flush(); assert.equal(h.sent.length, 1);
  const goal = h.engine.service.getGoal(h.state.threadId)!; const entries = h.entries;
  await h.close();
  const engine = new GoalEngine({ dbPath: ":memory:" }); engine.service.importGoal(goal, "session-a");
  const resumed = goalHarness({ engine, entries });
  try {
    await resumed.start(); await resumed.flush(); assert.equal(resumed.sent.length, 0);
    resumed.engine.service.setGoal("session-a", { status: "active", tokenBudget: 20 }, "user");
    resumed.engine.service.accountGoalUsage("session-a", 0, 10, "active_only"); await resumed.flush();
    assert.equal(resumed.sent.length, 1); assert.equal(resumed.sent[0].details.kind, "budget_wrap_up");
  } finally { await resumed.close(); }
});

test("input receipt captures the UI publication before the input-triggered repaint", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First");
  const publication = h.engine.service.ordering.publication(h.state.threadId)!;
  await h.emit("input", { text: "Pause the goal.", source: "interactive" });
  h.state.idle = false; await h.emit("turn_start");
  await h.context([await h.userMessage("Pause the goal.", 3)]);
  const receipt = h.sync.work()!.receipt!;
  assert.equal(receipt.publication, publication);
  assert.ok(receipt.sequence > publication.sequence);
  await h.tool("update_goal", { status: "paused" });
  assert.equal(h.engine.service.ordering.intentSeq(h.state.threadId), receipt.sequence);
});

test("dialog submission is a new decision even if the same goal finished while the dialog was open", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First");
  const before = h.engine.service.ordering.intentSeq(h.state.threadId);
  h.ctx.ui.editor = async () => {
    assert.equal(h.engine.service.ordering.hasPending(h.state.threadId), false, "opening an editor is not a decision");
    h.engine.service.stopActiveGoal(h.state.threadId, "blocked", undefined, "run_error");
    return "Revised";
  };
  await h.command("edit");
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.status, "active");
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.objective, "Revised");
  assert.ok(h.engine.service.ordering.intentSeq(h.state.threadId) > before);
  h.ctx.ui.confirm = async () => { h.engine.service.requestTerminalUpdate(h.state.threadId, "complete", "agent"); return true; };
  await h.command("clear"); assert.equal(h.engine.service.getGoal(h.state.threadId), null);
});

test("inspection, invalid edits and cancelled dialogs do not accept a new intent", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First");
  const before = h.engine.service.ordering.intentSeq(h.state.threadId);
  await h.command(""); h.state.editor = undefined; await h.command("edit");
  h.state.editor = " "; await h.command("edit"); h.state.confirm = false; await h.command("clear");
  assert.equal(h.engine.service.ordering.intentSeq(h.state.threadId), before);
  assert.equal(h.engine.service.ordering.hasPending(h.state.threadId), false);
});

test("ambiguous identical concurrent input is not assigned a guessed receipt", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("First");
  await h.emit("input", { text: "Pause the goal.", source: "interactive" });
  await h.emit("input", { text: "Pause the goal.", source: "interactive" });
  h.state.idle = false; await h.emit("turn_start");
  const context = await h.context([await h.userMessage("Pause the goal.", 4)]);
  assert.match(context.at(-1).content, /provenance is unresolved/);
  await assert.rejects(h.tool("update_goal", { status: "paused" }), /cannot establish/);
  await h.command("pause");
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.status, "paused");
  assert.equal(h.engine.service.ordering.hasPending(h.state.threadId), false);
});

test("a request from an older epoch cannot execute tools or charge a replacement goal", async () => {
  const first = goalHarness(); await first.start(); await first.command("Old epoch"); await first.flush();
  const old = first.sent[0]; await first.close();
  const next = goalHarness();
  try {
    await next.start(); await next.command("New epoch"); next.state.idle = false; await next.emit("turn_start");
    const context = await next.context([old]);
    assert.ok(!context.some((m: any) => m.customType === "secretary:goal-automatic"), "the replayed wake-up marker is removed");
    assert.equal((await next.emit("tool_call", { toolName: "bash", input: {} })).block, true);
    await next.emit("turn_end", { message: assistant("stop", 15) });
    assert.equal(next.engine.service.getGoal(next.state.threadId)?.tokensUsed, 0);
  } finally { await next.close(); }
});

test("historical same-text input cannot consume a newly received message's authority", async (t) => {
  const historical = { role: "user", content: "Pause the goal.", timestamp: 1 };
  const h = goalHarness({ entries: [{ type: "message", message: historical }] });
  t.after(() => h.close()); await h.start(); await h.command("Current goal");
  await h.emit("input", { text: "Pause the goal.", source: "interactive" });
  h.state.idle = false; await h.emit("turn_start");
  await h.context([historical]);
  await assert.rejects(h.tool("update_goal", { status: "paused" }), /cannot establish/);
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.status, "active");
  const actual = await h.userMessage("Pause the goal.", 2);
  await h.context([historical, actual]);
  await h.tool("update_goal", { status: "paused" });
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.status, "paused");
});

test("a budget marker without an authorized wrap-up does not consume delivery", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  await h.tool("create_goal", { objective: "Budget", token_budget: 1 });
  h.engine.service.accountGoalUsage(h.state.threadId, 0, 1, "active_only"); await h.flush();
  await h.command("resume"); h.state.idle = false; await h.emit("turn_start");
  const old = await h.context([h.sent[0]]); assert.equal(old.length, 0, "a superseded wake-up leaves no extension message in context");
  await h.emit("turn_end", { message: assistant("stop", 0) });
  h.state.idle = true; await h.emit("agent_settled"); await h.flush();
  assert.equal(h.sent.length, 2);
  h.state.idle = false; await h.emit("turn_start");
  const fresh = await h.context([h.sent[0], h.sent[1]]);
  assert.match(fresh.at(-1).content, /do not start new substantive work/);
  await h.emit("turn_end", { message: assistant("stop", 0) });
  h.state.idle = true; await h.emit("agent_settled"); await h.flush(); assert.equal(h.sent.length, 2);
});

test("late cancellation of earlier work does not suppress a newer accepted resume", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("Work"); await h.flush();
  h.state.idle = false; await h.emit("turn_start"); await h.context([h.sent[0]]);
  await h.command("resume");
  await h.emit("turn_end", { message: assistant("aborted", 0) });
  h.state.idle = true; await h.emit("agent_settled"); await h.flush();
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.status, "active");
  assert.equal(h.sent.length, 2);
});

test("a delayed user request is not charged to a replacement goal", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("Original");
  await h.emit("input", { text: "Continue earlier work", source: "interactive" });
  h.engine.service.requestTerminalUpdate(h.state.threadId, "complete", "agent");
  h.engine.service.createGoal(h.state.threadId, "Replacement", undefined, "user");
  h.state.idle = false; await h.emit("turn_start");
  await h.context([await h.userMessage("Continue earlier work", 5)]);
  await h.emit("turn_end", { message: assistant("stop", 11) });
  assert.equal(h.engine.service.getGoal(h.state.threadId)?.tokensUsed, 0);
});

test("a failed publication is not attached to a later input as an acknowledgment", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start(); await h.command("Visible");
  assert.ok(h.engine.service.ordering.publication(h.state.threadId));
  h.ctx.ui.setWidget = () => { throw new Error("Renderer failed"); };
  h.sync.bind(h.ctx);
  const receipt = h.sync.receiveInput("Status?", h.ctx);
  assert.equal(receipt.publication, undefined);
});

test("uncertain submission is not replayed by repeated idle callbacks", async (t) => {
  const h = goalHarness(); t.after(() => h.close()); await h.start();
  let attempts = 0;
  h.pi.sendMessage = () => { attempts++; throw new Error("Unknown submission outcome"); };
  await h.command("Work"); await h.flush();
  h.sync.requestAutomatic(); await h.flush(); assert.equal(attempts, 1);
});
