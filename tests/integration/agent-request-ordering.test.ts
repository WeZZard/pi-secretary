import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { goalAgentCompositionSession } from "../support/goal-agent-composition-session.ts";
import { AgentAssociationStore } from "../../extensions/secretary/composition/association-store.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const launch = (id: string, background = true) => call(id, "Agent", {
  description: "Ordering regression", prompt: `WORK_${id}`, name: id, subagent_type: "ordering-worker", run_in_background: background,
});
const results = (context: Context) => context.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean, description: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < end, `Timed out waiting for ${description}`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}
async function setup(_root: string, dir: string) {
  await mkdir(join(dir, "agents"));
  await writeFile(join(dir, "agents", "ordering-worker.md"), "---\nname: ordering-worker\ndescription: Isolated ordering worker\ntools: [read]\n---\nReturn only the requested fixture result.\n");
}
const automatic = (context: Context) => JSON.stringify(context.messages).includes("Continue working toward the active thread goal.");
type Harness = Awaited<ReturnType<typeof goalAgentCompositionSession>>;
async function retain(h: Harness, error?: unknown) {
  const store = new AgentAssociationStore(h.engine.db.connection);
  await h.retain({
    associations: h.repository.runs(h.threadId).map(run => ({ runId: run.runId, association: store.run(run.runId) })),
    failure: error instanceof Error ? { message: error.message, stack: error.stack } : error,
  });
}

for (const status of ["active", "blocked", "paused", "complete", "usage_limited", "budget_limited"] as const) {
  test(`fresh user delegation executes with a ${status} goal without changing its state`, { timeout: 15000 }, async t => {
    const h = await goalAgentCompositionSession(t, { setup,
      respond: async context => results(context).some(m => m.toolCallId === "fresh")
        ? text("User task complete; no goal mutation requested.") : [launch("fresh", false)],
      respondChild: async () => text("FRESH_USER_DONE"),
    });
    let failure: unknown;
    try {
      h.engine.service.createGoal(h.goalThreadId, "Independent objective", status === "budget_limited" ? 1 : undefined, "user");
      if (status === "budget_limited") h.engine.service.accountGoalUsage(h.goalThreadId, 0, 1, "active_only");
      else if (status !== "active") h.engine.service.setGoal(h.goalThreadId, { status }, "system");
      const before = h.engine.service.getGoal(h.goalThreadId)!;
      assert.equal(before.status, status);
      await h.session.prompt(`Fresh user task while ${status}: delegate the fixture task, without changing the goal.`, { source: "rpc" });
      const outcome = h.session.messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "fresh");
      assert.ok(outcome && !outcome.isError, JSON.stringify(outcome));
      const runs = h.repository.runs(h.threadId);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, "succeeded");
      assert.match(runs[0].output, /FRESH_USER_DONE/);
      const store = new AgentAssociationStore(h.engine.db.connection);
      assert.equal(store.run(runs[0].runId)?.authority, "user");
      assert.equal(h.engine.service.getGoal(h.goalThreadId)!.goalId, before.goalId);
      assert.equal(h.engine.service.getGoal(h.goalThreadId)!.status, status);
    } catch (error) { failure = error; throw error; }
    finally {
      await retain(h, failure);
      if (h.engine.service.getGoal(h.goalThreadId)?.status === "active") h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user");
    }
  });
}

test("a user-originated background run survives a later goal pause", { timeout: 15000 }, async t => {
  const childGate = deferred(); const parentGate = deferred();
  let childStarted = false; let parentHeld = false;
  const h = await goalAgentCompositionSession(t, { setup,
    respond: async context => {
      if (!results(context).some(m => m.toolCallId === "user-run")) return [launch("user-run")];
      parentHeld = true; await parentGate.promise; return text("No goal change requested.");
    },
    respondChild: async () => { childStarted = true; await childGate.promise; return text("USER_RUN_DONE"); },
  });
  let failure: unknown;
  try {
    h.engine.service.createGoal(h.goalThreadId, "Original objective", undefined, "user");
    const prompt = h.session.prompt("Delegate my explicit background task.", { source: "rpc" });
    await until(() => childStarted && parentHeld, "user child and held parent response");
    const run = h.repository.runs(h.threadId)[0];
    assert.equal(new AgentAssociationStore(h.engine.db.connection).run(run.runId)?.authority, "user");
    h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user");
    assert.equal(h.repository.getRun(run.runId)!.status, "running");
    childGate.resolve(); parentGate.resolve(); await prompt;
    await until(() => h.repository.getRun(run.runId)!.status === "succeeded", "user child completion after pause");
    assert.match(h.repository.getRun(run.runId)!.output, /USER_RUN_DONE/);
    assert.equal(h.engine.service.getGoal(h.goalThreadId)!.status, "paused");
  } catch (error) { failure = error; throw error; }
  finally { childGate.resolve(); parentGate.resolve(); await retain(h, failure); }
});

test("a delayed automatic Agent response cannot dispatch after a later goal decision", { timeout: 15000 }, async t => {
  const gate = deferred(); let automaticHeld = false;
  const h = await goalAgentCompositionSession(t, { setup,
    respond: async context => {
      if (!results(context).some(m => m.toolCallId === "create")) return [call("create", "create_goal", { objective: "Automatic fixture objective" })];
      if (automatic(context) && !automaticHeld) { automaticHeld = true; await gate.promise; return [launch("stale-auto")]; }
      return text("Waiting for the next authorized request.");
    },
  });
  let failure: unknown;
  try {
    await h.session.prompt("Create the fixture goal.", { source: "rpc" });
    await until(() => automaticHeld, "real automatic parent request");
    assert.ok(h.session.messages.some(m => m.role === "custom" && m.customType === "secretary:goal-automatic"));
    h.engine.service.requestTerminalUpdate(h.goalThreadId, "blocked", "user");
    gate.resolve(); await h.session.waitForIdle();
    const rejected = h.session.messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "stale-auto");
    assert.ok(rejected?.isError, JSON.stringify(h.session.messages));
    assert.match(JSON.stringify(rejected.content), /superseded|expired|abort|stale/i);
    assert.deepEqual(h.repository.runs(h.threadId), []);
    assert.equal(h.childCalls.length, 0);
    assert.equal(h.engine.service.getGoal(h.goalThreadId)!.status, "blocked");
  } catch (error) { failure = error; throw error; }
  finally { gate.resolve(); h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user"); await retain(h, failure); }
});

test("an admitted automatic run is cancelled when its originating goal authority expires", { timeout: 15000 }, async t => {
  const childGate = deferred(); const parentGate = deferred();
  let childStarted = false; let parentHeld = false; let aborted = false;
  const h = await goalAgentCompositionSession(t, { setup,
    respond: async context => {
      const seen = results(context);
      if (!seen.some(m => m.toolCallId === "create")) return [call("create", "create_goal", { objective: "Automatic fixture objective" })];
      if (automatic(context)) {
        if (!seen.some(m => m.toolCallId === "auto-run")) return [launch("auto-run")];
        parentHeld = true; await parentGate.promise;
      }
      return text("Automatic request finished.");
    },
    respondChild: async (_context, _index, signal) => {
      childStarted = true;
      const onAbort = () => { aborted = true; childGate.resolve(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try { await childGate.promise; return text("PARTIAL_AUTOMATIC_RESULT"); }
      finally { signal?.removeEventListener("abort", onAbort); }
    },
  });
  let failure: unknown;
  try {
    await h.session.prompt("Create the fixture goal.", { source: "rpc" });
    await until(() => childStarted && parentHeld, "automatic child admission");
    const run = h.repository.runs(h.threadId)[0];
    assert.equal(new AgentAssociationStore(h.engine.db.connection).run(run.runId)?.authority, "automatic");
    h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user");
    parentGate.resolve();
    await until(() => h.repository.getRun(run.runId)!.status === "cancelled", "automatic cancellation settlement");
    assert.equal(aborted, true);
    await h.session.waitForIdle();
    assert.equal(h.engine.service.getGoal(h.goalThreadId)!.status, "paused");
    assert.ok(h.repository.completions(h.threadId).some(item => item.runId === run.runId));
  } catch (error) { failure = error; throw error; }
  finally { childGate.resolve(); parentGate.resolve(); h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user"); await retain(h, failure); }
});

test("a delayed completion notification cannot borrow a later fresh user's delegation authority", { timeout: 15000 }, async t => {
  const childGate = deferred(); const notificationGate = deferred();
  let childStarted = false; let notificationHeld = false; let notificationRequest = false;
  const freshText = "FRESH_AFTER_NOTIFICATION: delegate a new unrelated fixture task without resuming the goal.";
  const h = await goalAgentCompositionSession(t, { setup,
    extension(pi) {
      pi.on("context", event => {
        let source: typeof event.messages[number] | undefined;
        for (const message of event.messages) {
          if (message.role === "user" || (message.role === "custom" && message.customType === "secretary:agent-completion")) source = message;
        }
        notificationRequest = source?.role === "custom" && source.customType === "secretary:agent-completion";
      });
    },
    respond: async context => {
      const seen = results(context);
      if (notificationRequest && !notificationHeld) {
        notificationHeld = true; await notificationGate.promise; return [launch("stale-notification")];
      }
      if (context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(freshText))) {
        return seen.some(message => message.toolCallId === "fresh-recovery") ? text("Fresh recovery finished.") : [launch("fresh-recovery", false)];
      }
      if (!seen.some(message => message.toolCallId === "create")) return [call("create", "create_goal", { objective: "Notification ordering objective" })];
      if (automatic(context) && !seen.some(message => message.toolCallId === "notification-source")) return [launch("notification-source")];
      return text("Wait for the child result.");
    },
    respondChild: async context => {
      if (JSON.stringify(context.messages).includes("WORK_notification-source")) {
        childStarted = true; await childGate.promise;
      }
      return text("NOTIFICATION_FIXTURE_DONE");
    },
  });
  let failure: unknown;
  try {
    await h.session.prompt("Create the fixture goal.", { source: "rpc" });
    await until(() => childStarted, "automatic notification source child");
    await h.session.waitForIdle();
    const original = h.repository.runs(h.threadId)[0];
    const store = new AgentAssociationStore(h.engine.db.connection);
    assert.equal(store.run(original.runId)?.authority, "automatic");
    childGate.resolve();
    await until(() => notificationHeld, "real completion-triggered parent request");
    assert.equal(h.repository.getRun(original.runId)!.status, "succeeded");
    assert.ok(h.session.messages.some(message => message.role === "custom" && message.customType === "secretary:agent-completion"));
    h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user");
    const fresh = h.session.prompt(freshText, { source: "rpc", streamingBehavior: "followUp" });
    await until(() => h.inputs.some(input => input.text === freshText), "fresh user request receipt while notification response is held");
    notificationGate.resolve(); await fresh; await h.session.waitForIdle();
    const outcomes = h.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
    const stale = outcomes.find(message => message.toolCallId === "stale-notification");
    assert.ok(stale?.isError, JSON.stringify(stale));
    assert.match(JSON.stringify(stale.content), /superseded|expired|abort|stale/i);
    const accepted = outcomes.find(message => message.toolCallId === "fresh-recovery");
    assert.ok(accepted && !accepted.isError, JSON.stringify(outcomes));
    assert.equal(h.repository.runs(h.threadId).length, 2);
    assert.equal(store.run(accepted.details.runId)?.authority, "user");
    assert.equal(h.repository.getRun(accepted.details.runId)!.status, "succeeded");
    assert.equal(h.engine.service.getGoal(h.goalThreadId)!.status, "paused");
  } catch (error) { failure = error; throw error; }
  finally { childGate.resolve(); notificationGate.resolve(); h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user"); await retain(h, failure); }
});

test("automatic work after a user-child completion retains automatic authority and cancellation", { timeout: 15000 }, async t => {
  const firstChild = deferred(); const laterChild = deferred(); const parentGate = deferred();
  let initialStarted = false; let laterStarted = false; let parentHeld = false;
  const h = await goalAgentCompositionSession(t, { setup,
    respond: async context => {
      const seen = results(context);
      if (!seen.some(message => message.toolCallId === "create")) return [call("create", "create_goal", { objective: "Continue after user child" })];
      if (!seen.some(message => message.toolCallId === "user-source")) return [launch("user-source")];
      const hasCompletion = h.session.messages.some(message => message.role === "custom" && message.customType === "secretary:agent-completion");
      const source = h.session.messages.filter(message => message.role === "user" || (message.role === "custom" && ["secretary:goal-automatic", "secretary:agent-completion"].includes(message.customType))).at(-1);
      if (hasCompletion && source?.role === "custom" && source.customType === "secretary:goal-automatic") {
        if (!seen.some(message => message.toolCallId === "after-completion-auto")) return [launch("after-completion-auto")];
        parentHeld = true; await parentGate.promise;
      }
      return text("Observed this request; wait for authorized continuation.");
    },
    respondChild: async (context, _index, signal) => {
      const later = JSON.stringify(context.messages).includes("WORK_after-completion-auto");
      const gate = later ? laterChild : firstChild;
      if (later) laterStarted = true; else initialStarted = true;
      const onAbort = () => gate.resolve();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try { await gate.promise; return text("SOURCE_RESULT"); }
      finally { signal?.removeEventListener("abort", onAbort); }
    },
  });
  let failure: unknown;
  try {
    await h.session.prompt("Create a goal and delegate this explicit user task.", { source: "rpc" });
    await until(() => initialStarted, "user-originated source child");
    firstChild.resolve();
    await until(() => laterStarted && parentHeld, "automatic work after the user completion notification");
    const runs = h.repository.runs(h.threadId);
    const store = new AgentAssociationStore(h.engine.db.connection);
    assert.equal(store.run(runs[0].runId)?.authority, "user");
    const authority = store.run(runs[1].runId)?.authority;
    h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user");
    parentGate.resolve();
    assert.ok(["cancelling", "cancelled"].includes(h.repository.getRun(runs[1].runId)!.status),
      `Automatic work after a historical completion must cancel on pause; recorded authority=${authority}, status=${h.repository.getRun(runs[1].runId)!.status}`);
    await until(() => h.repository.getRun(runs[1].runId)!.status === "cancelled", "automatic cancellation after a historical completion");
    assert.equal(authority, "automatic", "An older completion must not replace the actual automatic request's provenance");
    await h.session.waitForIdle();
  } catch (error) { failure = error; throw error; }
  finally {
    h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user");
    firstChild.resolve(); laterChild.resolve(); parentGate.resolve(); await retain(h, failure);
  }
});

test("accepted automatic guidance does not acquire cancellation authority over a user-owned run", { timeout: 15000 }, async t => {
  const childGate = deferred(); const parentGate = deferred();
  let childStarted = false; let guidanceAccepted = false; let childAborted = false;
  const h = await goalAgentCompositionSession(t, { setup,
    respond: async context => {
      const seen = results(context);
      if (!seen.some(message => message.toolCallId === "create")) return [call("create", "create_goal", { objective: "Guidance ordering objective" })];
      if (!seen.some(message => message.toolCallId === "user-guidance")) return [launch("user-guidance")];
      if (automatic(context)) {
        if (!seen.some(message => message.toolCallId === "automatic-guidance")) return [call("automatic-guidance", "SendMessage", { to: "user-guidance", message: "Also report unresolved limitations." })];
        guidanceAccepted = true; await parentGate.promise;
      }
      return text("The original user child remains independently owned.");
    },
    respondChild: async (_context, _index, signal) => {
      childStarted = true;
      const onAbort = () => { childAborted = true; childGate.resolve(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try { await childGate.promise; return text("USER_GUIDANCE_RESULT"); }
      finally { signal?.removeEventListener("abort", onAbort); }
    },
  });
  let failure: unknown;
  try {
    await h.session.prompt("Create the goal and delegate this explicit user-owned task.", { source: "rpc" });
    await until(() => childStarted && guidanceAccepted, "automatic guidance accepted by the running user child");
    const run = h.repository.runs(h.threadId)[0];
    const outcome = h.session.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "automatic-guidance");
    assert.ok(outcome && !outcome.isError, JSON.stringify(outcome));
    assert.equal(outcome.details.runId, run.runId);
    assert.equal(new AgentAssociationStore(h.engine.db.connection).run(run.runId)?.authority, "user");
    h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user");
    assert.equal(childAborted, false);
    assert.equal(h.repository.getRun(run.runId)!.status, "running", "Cancelling the guidance sender must not cancel the recipient's original user assignment");
    parentGate.resolve(); childGate.resolve(); await h.session.waitForIdle();
    await until(() => h.repository.getRun(run.runId)!.status === "succeeded", "independent user run completion");
    assert.equal(h.repository.runs(h.threadId).length, 1);
    assert.equal(childAborted, false);
  } catch (error) { failure = error; throw error; }
  finally {
    h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user");
    childGate.resolve(); parentGate.resolve(); await retain(h, failure);
  }
});

test("a deferred nextTurn completion appended after fresh input does not replace user provenance", { timeout: 15000 }, async t => {
  const childGate = deferred(); let childStarted = false;
  const freshText = "FRESH_WITH_DEFERRED_RESULT: delegate an unrelated recovery task without resuming the goal.";
  const h = await goalAgentCompositionSession(t, { setup,
    respond: async context => {
      const seen = results(context);
      if (context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(freshText))) {
        return seen.some(message => message.toolCallId === "fresh-nextturn") ? text("Fresh user work complete.") : [launch("fresh-nextturn", false)];
      }
      return seen.some(message => message.toolCallId === "deferred-source") ? text("Wait for the child result.") : [launch("deferred-source")];
    },
    respondChild: async context => {
      if (JSON.stringify(context.messages).includes("WORK_deferred-source")) { childStarted = true; await childGate.promise; }
      return text("DEFERRED_RESULT_DONE");
    },
  });
  let failure: unknown;
  try {
    h.engine.service.createGoal(h.goalThreadId, "Original objective", undefined, "user");
    await h.session.prompt("Delegate my initial fixture task.", { source: "rpc" });
    await until(() => childStarted, "initial user child");
    h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user");
    const original = h.repository.runs(h.threadId)[0];
    const before = h.parentCalls.length;
    childGate.resolve();
    await until(() => h.repository.getRun(original.runId)!.status === "succeeded" && h.repository.completions(h.threadId).some(item => item.runId === original.runId && item.state === "submitted"), "deferred completion submission");
    assert.equal(h.parentCalls.length, before, "A paused-goal completion must not trigger its own request");
    await h.session.prompt(freshText, { source: "rpc" });
    await h.session.waitForIdle();
    const userIndex = h.session.messages.findIndex(message => message.role === "user" && JSON.stringify(message.content).includes(freshText));
    const completionIndex = h.session.messages.findIndex(message => message.role === "custom" && message.customType === "secretary:agent-completion");
    assert.ok(completionIndex > userIndex && userIndex >= 0, "The real SDK must exercise nextTurn completion insertion after the fresh user message");
    const outcome = h.session.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "fresh-nextturn");
    assert.ok(outcome && !outcome.isError, JSON.stringify(outcome));
    assert.equal(h.repository.getRun(outcome.details.runId)!.status, "succeeded");
    assert.equal(new AgentAssociationStore(h.engine.db.connection).run(outcome.details.runId)?.authority, "user", "A deferred result is data attached to the new user request, not its producing authority");
    assert.equal(h.engine.service.getGoal(h.goalThreadId)!.status, "paused");
  } catch (error) { failure = error; throw error; }
  finally { childGate.resolve(); h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user"); await retain(h, failure); }
});

test("a real budget wrap-up request can read and complete its budget-limited goal", { timeout: 15000 }, async t => {
  let sawWrapUp = false;
  const h = await goalAgentCompositionSession(t, { setup,
    respond: async context => {
      const source = h.session.messages.filter(message => message.role === "user" || (message.role === "custom" && message.customType === "secretary:goal-automatic")).at(-1);
      if (source?.role === "custom" && (source.details as { kind?: string })?.kind === "budget_wrap_up") {
        sawWrapUp = true;
        const seen = results(context);
        if (!seen.some(message => message.toolCallId === "wrap-read")) return [call("wrap-read", "get_goal", {})];
        if (!seen.some(message => message.toolCallId === "wrap-complete")) return [call("wrap-complete", "update_goal", { status: "complete" })];
      }
      return text("Budget wrap-up report delivered.");
    },
  });
  let failure: unknown;
  try {
    h.engine.service.createGoal(h.goalThreadId, "Already finished fixture objective", 1, "user");
    h.engine.service.accountGoalUsage(h.goalThreadId, 0, 1, "active_only");
    const goalId = h.engine.service.getGoal(h.goalThreadId)!.goalId;
    assert.equal(h.engine.service.getGoal(h.goalThreadId)!.status, "budget_limited");
    await h.session.prompt("Report the current situation, then permit the scheduled budget wrap-up.", { source: "rpc" });
    await until(() => h.session.messages.some(message => message.role === "toolResult" && message.toolCallId === "wrap-complete"), "real budget wrap-up read and update tools");
    await h.session.waitForIdle();
    assert.equal(sawWrapUp, true);
    const outcomes = h.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
    for (const id of ["wrap-read", "wrap-complete"]) {
      const outcome = outcomes.find(message => message.toolCallId === id);
      assert.ok(outcome && !outcome.isError, JSON.stringify(outcome));
    }
    assert.equal(outcomes.find(message => message.toolCallId === "wrap-read")!.details.goal.status, "budget_limited");
    assert.equal(h.engine.service.getGoal(h.goalThreadId)!.goalId, goalId);
    assert.equal(h.engine.service.getGoal(h.goalThreadId)!.status, "complete");
    assert.equal(h.repository.runs(h.threadId).length, 0);
  } catch (error) { failure = error; throw error; }
  finally { await retain(h, failure); }
});

for (const mutation of ["create_goal", "update_goal"] as const) {
  test(`a user-run completion can report and read but cannot authorize ${mutation}`, { timeout: 15000 }, async t => {
    const childGate = deferred(); const parentGate = deferred();
    let childStarted = false; let parentHeld = false; let notificationObserved = false;
    const h = await goalAgentCompositionSession(t, { setup,
      respond: async context => {
        const source = h.session.messages.filter(message => message.role === "user" || (message.role === "custom" && ["secretary:agent-completion", "secretary:goal-automatic"].includes(message.customType))).at(-1);
        const seen = results(context);
        if (source?.role === "custom" && source.customType === "secretary:agent-completion") {
          notificationObserved = true;
          if (!seen.some(message => message.toolCallId === "notification-read")) return [
            ...text("CHILD_COMPLETION_REPORT: the delegated fixture returned its result."), call("notification-read", "get_goal", {}),
          ];
          if (!seen.some(message => message.toolCallId === "notification-mutation")) return [call("notification-mutation", mutation,
            mutation === "create_goal" ? { objective: "Unauthorized result-created objective" } : { status: "complete" })];
        }
        if (!seen.some(message => message.toolCallId === "notification-user-source")) return [launch("notification-user-source")];
        parentHeld = true; await parentGate.promise;
        return text("Wait for authorized work.");
      },
      respondChild: async () => { childStarted = true; await childGate.promise; return text("USER_COMPLETION_DONE"); },
    });
    let failure: unknown;
    try {
      if (mutation === "update_goal") h.engine.service.createGoal(h.goalThreadId, "Unfinished independent objective", undefined, "user");
      const before = h.engine.service.getGoal(h.goalThreadId);
      const prompt = h.session.prompt("Delegate this explicit user task; report its completion without changing any goal.", { source: "rpc" });
      await until(() => childStarted && parentHeld, "user-originated completion source and held parent response");
      childGate.resolve();
      await until(() => h.repository.completions(h.threadId).some(item => item.state === "submitted"), "completion queued before automatic continuation can dispatch");
      parentGate.resolve(); await prompt;
      await until(() => h.session.messages.some(message => message.role === "toolResult" && message.toolCallId === "notification-mutation"), "completion-originated goal mutation refusal");
      assert.equal(notificationObserved, true);
      const run = h.repository.runs(h.threadId)[0];
      assert.equal(new AgentAssociationStore(h.engine.db.connection).run(run.runId)?.authority, "user");
      assert.equal(run.status, "succeeded");
      assert.ok(h.session.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("CHILD_COMPLETION_REPORT")));
      const outcomes = h.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
      assert.equal(outcomes.find(message => message.toolCallId === "notification-read")?.isError, false);
      const rejected = outcomes.find(message => message.toolCallId === "notification-mutation");
      assert.ok(rejected?.isError, JSON.stringify(rejected));
      assert.match(JSON.stringify(rejected.content), /result data|provenance|explicit user|notification/i);
      const after = h.engine.service.getGoal(h.goalThreadId);
      if (!before) assert.equal(after, null);
      else { assert.equal(after?.goalId, before.goalId); assert.equal(after?.status, "active"); }
    } catch (error) { failure = error; throw error; }
    finally {
      childGate.resolve(); parentGate.resolve();
      if (h.engine.service.getGoal(h.goalThreadId)?.status === "active") h.engine.service.requestTerminalUpdate(h.goalThreadId, "paused", "user");
      await retain(h, failure);
    }
  });
}

test("a real SDK retry preserves notification provenance and cannot create a goal", { timeout: 15000 }, async t => {
  const childGate = deferred(); const parentGate = deferred();
  let childStarted = false; let parentHeld = false; let failedNotification = false;
  const retries: string[] = [];
  const h = await goalAgentCompositionSession(t, { setup,
    respond: async context => {
      const source = h.session.messages.filter(message => message.role === "user" || (message.role === "custom" && message.customType === "secretary:agent-completion")).at(-1);
      if (source?.role === "custom") return [call("retry-notification-create", "create_goal", { objective: "Unauthorized retry objective" })];
      if (!results(context).some(message => message.toolCallId === "retry-user-source")) return [launch("retry-user-source")];
      parentHeld = true; await parentGate.promise; return text("Wait for completion.");
    },
    respondChild: async () => { childStarted = true; await childGate.promise; return text("RETRY_SOURCE_DONE"); },
  });
  h.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
  const unsubscribe = h.session.subscribe(event => {
    if (event.type === "auto_retry_start" || event.type === "auto_retry_end") retries.push(event.type);
  });
  const stream = h.session.agent.streamFunction;
  h.session.agent.streamFunction = (model, context, options) => {
    const source = h.session.messages.filter(message => message.role === "user" || (message.role === "custom" && message.customType === "secretary:agent-completion")).at(-1);
    if (source?.role === "custom" && !failedNotification) {
      failedNotification = true;
      const result = createAssistantMessageEventStream();
      const error: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], stopReason: "error", errorMessage: "503 service unavailable", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { result.push({ type: "error", reason: "error", error }); result.end(); });
      return result;
    }
    return stream(model, context, options);
  };
  let failure: unknown;
  try {
    const prompt = h.session.prompt("Delegate a user task and report its completion without creating a goal.", { source: "rpc" });
    await until(() => childStarted && parentHeld, "user source and held parent response before completion");
    childGate.resolve();
    await until(() => h.repository.completions(h.threadId).some(item => item.state === "submitted"), "retry notification queued");
    parentGate.resolve(); await prompt; await h.session.waitForIdle();
    assert.equal(failedNotification, true);
    assert.deepEqual(retries, ["auto_retry_start", "auto_retry_end"], "The SDK must perform a real configured retry, not a manually emitted lifecycle");
    const outcome = h.session.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "retry-notification-create");
    assert.ok(outcome?.isError, JSON.stringify(outcome));
    assert.match(JSON.stringify(outcome.content), /result data|provenance|explicit user|notification/i);
    assert.equal(h.engine.service.getGoal(h.goalThreadId), null);
  } catch (error) { failure = error; throw error; }
  finally { childGate.resolve(); parentGate.resolve(); unsubscribe(); await retain(h, failure); }
});

test("generic cancellation during an asynchronous public tool admission prevents child execution", { timeout: 15000 }, async t => {
  const gate = deferred(); let admissionHeld = false;
  const h = await goalAgentCompositionSession(t, { setup,
    extension(pi) {
      pi.on("tool_call", async event => {
        if (event.toolName === "Agent") { admissionHeld = true; await gate.promise; }
      });
    },
    respond: async () => [launch("cancelled-admission")],
  });
  let failure: unknown;
  try {
    const prompt = h.session.prompt("Delegate a task that I will cancel during admission.", { source: "rpc" });
    await until(() => admissionHeld, "asynchronous tool admission");
    const abort = h.session.abort(); gate.resolve(); await abort; await prompt;
    assert.deepEqual(h.repository.runs(h.threadId), []);
    assert.equal(h.childCalls.length, 0);
  } catch (error) { failure = error; throw error; }
  finally { gate.resolve(); await retain(h, failure); }
});
