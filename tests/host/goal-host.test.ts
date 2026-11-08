import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, flushAutomaticScheduling, hostSession } from "../support/host-session.ts";
import { Type } from "typebox";

function snapshot(context: { messages: unknown[] }): string | undefined {
  const messages = context.messages.filter((message) => JSON.stringify(message).includes("Authoritative current goal state."));
  assert.ok(messages.length <= 1, "at most one snapshot reaches each provider request");
  return messages.length === 1 ? JSON.stringify(messages[0]) : undefined;
}

test("real Pi host synchronizes tool/command/service changes to UI and fresh provider context", { timeout: 15000 }, async (t) => {
  const h = await hostSession(t, { responses: ["create_goal", "success"] });
  assert.equal(h.lifecycle[0]?.event, "session_start");
  await h.session.prompt("Create the requested goal.");
  assert.equal(h.calls.length, 2, JSON.stringify(h.session.messages));
  assert.equal(h.engine.service.getGoal(h.threadId)?.objective, "Tool-created objective");
  assert.match(h.widgets.get("secretary:goal")?.[0] ?? "", /▶ Goal: active/);
  assert.match(snapshot(h.calls[1].context)!, /Tool-created objective/);

  h.api.sendMessage({ customType: "secretary:goal", content: "LEGACY_STALE_GOAL_SENTINEL", display: false });
  await h.session.prompt("/goal Updated command objective");
  assert.match(h.widgets.get("secretary:goal")!.join("\n"), /Updated command objective/);
  await h.session.prompt("Status only.");
  assert.match(snapshot(h.calls.at(-1)!.context)!, /Goal \[active\]/);
  assert.match(snapshot(h.calls.at(-1)!.context)!, /Updated command objective/);
  assert.doesNotMatch(JSON.stringify(h.calls.at(-1)!.context), /LEGACY_STALE_GOAL_SENTINEL/);
  assert.ok(h.session.messages.some((message) => message.role === "custom" && message.customType === "secretary:goal"),
    "filtering provider context must not rewrite session history");

  await h.session.prompt("/goal pause");
  assert.match(h.widgets.get("secretary:goal")?.[0] ?? "", /⏸ Goal: paused/);
  await h.session.prompt("What is the current status?");
  assert.equal(snapshot(h.calls.at(-1)!.context), undefined, "a paused goal injects no goal message");
  assert.equal(h.engine.service.getGoal(h.threadId)?.status, "paused");

  h.engine.service.clearGoal(h.threadId, "user");
  assert.equal(h.statuses.get("secretary:goal"), undefined);
  assert.equal(h.widgets.get("secretary:goal"), undefined);
  await h.session.prompt("What remains?");
  const cleared = snapshot(h.calls.at(-1)!.context);
  assert.equal(cleared, undefined, "clear injects no replacement message");
  assert.doesNotMatch(JSON.stringify(h.calls.at(-1)!.context), /Updated command objective/);
  assert.ok(h.lifecycle.some(({ event }) => event === "agent_settled"));
});

test("real host retry keeps persisted intent active until recovery succeeds", { timeout: 15000 }, async (t) => {
  const h = await hostSession(t, { responses: ["error", "success"] });
  await h.session.prompt("/goal Survive a transient provider failure");
  const retryStatuses: Array<string | undefined> = [];
  h.session.subscribe((event) => {
    if (event.type === "auto_retry_start") retryStatuses.push(h.engine.service.getGoal(h.threadId)?.status);
  });
  await h.session.prompt("Proceed once.");
  await h.session.waitForIdle();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(retryStatuses, ["active"]);
  assert.deepEqual(h.lifecycle.filter(({ event }) => event === "turn_end").map(({ status }) => status), ["active", "active"]);
  assert.equal(h.engine.service.getGoal(h.threadId)?.status, "active");
  assert.match(snapshot(h.calls[1].context)!, /Goal \[active\]/);
  assert.deepEqual(h.lifecycle.filter(({ event }) => event === "agent_settled").map(({ status }) => status), ["active"]);
});

test("host compaction recovery does not persist an intermediate blocked goal", { timeout: 15000 }, async (t) => {
  const h = await hostSession(t, { responses: ["success", "success", "overflow", "success", "success"], compaction: true });
  assert.equal(h.session.settingsManager.getCompactionSettings().enabled, true);
  const compactions: unknown[] = [];
  h.session.subscribe((event) => { if (event.type === "compaction_end") compactions.push(event); });
  await h.session.prompt("Earlier context. ".repeat(2000));
  await h.session.prompt("Recent context. ".repeat(2000));
  await h.session.prompt("/goal Recover after context overflow");
  await h.session.prompt("Continue the goal.");
  await h.session.waitForIdle();
  assert.equal(h.calls.length, 5, `two initial responses, overflow, compaction summary, recovered response: ${JSON.stringify(compactions)}`);
  assert.ok(h.session.messages.some((m) => m.role === "compactionSummary"));
  assert.equal(h.engine.service.getGoal(h.threadId)?.status, "active");
  assert.ok(!h.lifecycle.some((e) => e.status === "blocked"));
});

test("exhausted host retries block only at agent_settled", { timeout: 15000 }, async (t) => {
  const h = await hostSession(t, { responses: ["error", "error"] });
  await h.session.prompt("/goal Exhaust retry budget");
  await h.session.prompt("Proceed once.");
  await h.session.waitForIdle();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.lifecycle.filter(({ event }) => event === "turn_end").map(({ status }) => status), ["active", "active"]);
  assert.deepEqual(h.lifecycle.filter(({ event }) => event === "agent_settled").map(({ status }) => status), ["blocked"]);
  assert.equal(h.engine.service.getGoal(h.threadId)?.status, "blocked");
  assert.equal(h.engine.service.getLastChange(h.threadId)?.stopCause, "run_error");
});

test("Pi context abort reaches ModelRuntime but auth cancellation prevents the provider callback",  { timeout: 15000 }, async (t) => {
  const hooks: string[] = [];
  const h = await hostSession(t, { extension(pi) {
    pi.on("input", () => { hooks.push("input"); });
    pi.on("before_agent_start", () => { hooks.push("before_agent_start"); });
    pi.on("context", (_event, ctx) => { hooks.push("context"); ctx.abort(); });
  } });
  await h.session.prompt("/goal Do not mistake cancellation for failure");
  const runtimeAborts: boolean[] = [];
  const runtime = h.session.modelRuntime;
  const streamSimple = runtime.streamSimple.bind(runtime);
  t.mock.method(runtime, "streamSimple", (...args: Parameters<typeof streamSimple>) => {
    runtimeAborts.push(args[2]?.signal?.aborted ?? false);
    return streamSimple(...args);
  });
  h.api.sendMessage({ customType: "test:automatic-probe", content: "Local admission probe", display: false }, { triggerTurn: true });
  assert.equal(h.session.isStreaming, true, "custom message marks the host busy synchronously");
  await h.session.waitForIdle();
  assert.deepEqual(hooks, ["context"]);
  assert.deepEqual(runtimeAborts, [true], "the agent still enters ModelRuntime with its aborted run signal");
  // ModelRuntime.prepareRequest -> getAuth -> pi-ai resolveProviderAuthWithSignal
  // checks signal.throwIfAborted before invoking the inline provider. This is not
  // evidence that context abort necessarily sends a network request.
  assert.equal(h.calls.length, 0);
  const last = h.session.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.ok(last?.role === "assistant");
  // pi-ai lazyStream classifies auth setup failures (including abort) as error.
  assert.equal(last.stopReason, "error");
  assert.match(last.errorMessage ?? "", /abort/i);
  assert.equal(h.engine.service.getGoal(h.threadId)?.status, "active", "auth cancellation must not become a project blocker");
});

test("context abort cancels drained user steering and TUI-equivalent abort restores unrelated queued input", { timeout: 15000 }, async (t) => {
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const firstContext = gate();
  const releaseFirst = gate();
  const mixedContext = gate();
  const releaseMixed = gate();
  const contexts: string[] = [];
  const inputSources: string[] = [];
  const h = await hostSession(t, { tuiAbortHandler: true, extension(pi) {
    pi.on("input", (event) => { inputSources.push(event.source); });
    pi.on("context", async (event, ctx) => {
      contexts.push(JSON.stringify(event.messages));
      if (contexts.length === 1) {
        firstContext.resolve();
        await releaseFirst.promise;
      } else if (contexts.length === 2) {
        mixedContext.resolve();
        await releaseMixed.promise;
        ctx.abort();
      }
    });
  } });
  try {
    h.api.sendMessage({ customType: "test:automatic-probe", content: "AUTOMATIC_REQUEST", display: false }, { triggerTurn: true });
    await firstContext.promise;
    // Queue real user input after the initial steering drain, without timing sleeps.
    await h.session.prompt("USER_STEERING", { source: "interactive", streamingBehavior: "steer" });
    assert.deepEqual(h.session.getSteeringMessages(), ["USER_STEERING"]);
    releaseFirst.resolve();
    await mixedContext.promise;
    assert.match(contexts[1], /AUTOMATIC_REQUEST/);
    assert.match(contexts[1], /USER_STEERING/);
    assert.deepEqual(h.session.getSteeringMessages(), [], "user steering has entered the shared request context");
    await h.session.prompt("USER_FOLLOW_UP", { source: "interactive", streamingBehavior: "followUp" });
    assert.deepEqual(h.session.getFollowUpMessages(), ["USER_FOLLOW_UP"]);
    releaseMixed.resolve();
    await h.session.waitForIdle();
    assert.deepEqual(inputSources, ["interactive", "interactive"]);
    assert.equal(h.calls.length, 1, "only the initial automatic request executes; the mixed user request is aborted");
    assert.doesNotMatch(JSON.stringify(h.calls[0].context), /USER_STEERING|USER_FOLLOW_UP/);
    assert.deepEqual(h.restoredUserMessages, ["USER_FOLLOW_UP"], "TUI abort removes unrelated queued user work and restores it to the editor");
    assert.equal(h.session.pendingMessageCount, 0);
    assert.ok(h.session.messages.some((message) => message.role === "user" && JSON.stringify(message).includes("USER_STEERING")),
      "drained steering remains in history but receives no provider execution");
    const last = h.session.messages.at(-1);
    assert.ok(last?.role === "assistant");
    assert.equal(last.stopReason, "error");
    assert.match(last.errorMessage ?? "", /abort/i);
  } finally {
    releaseFirst.resolve();
    releaseMixed.resolve();
  }
});

for (const reason of ["reload", "new", "resume", "fork"] as const) {
  test(`host session_start ${reason} initializes the current UI and request context`, { timeout: 15000 }, async (t) => {
    const h = await hostSession(t, { startReason: reason, startupGoal: reason === "new" ? undefined : "Stopped session goal", startupPaused: true });
    if (reason === "new") assert.equal(h.widgets.get("secretary:goal"), undefined);
    else assert.match(h.widgets.get("secretary:goal")?.[0] ?? "", /⏸ Goal: paused/);
    await h.session.prompt("Inspect status without resuming.");
    assert.equal(snapshot(h.calls.at(-1)!.context), undefined, "a non-active session injects no goal message");
    if (reason === "fork") {
      assert.equal(h.engine.service.getGoal(h.threadId)?.goalId, h.engine.service.getGoal("fork-source")?.goalId);
    }
  });
}

for (const startup of [false, true]) {
  test(`real host dispatches automatic goal requests after ${startup ? "startup restoration" : "explicit commands"}`, { timeout: 15000 }, async (t) => {
    const h = await hostSession(t, { startupGoal: startup ? "Restored active goal" : undefined });
    if (!startup) await h.session.prompt("/goal Explicitly requested goal");
    await flushAutomaticScheduling();
    await h.session.waitForIdle();
    await flushAutomaticScheduling();
    assert.equal(h.engine.service.getGoal(h.threadId)?.status, "complete");
    assert.equal(h.calls.length, 2, "one continuation tool call followed by its final summary");
    assert.match(snapshot(h.calls[0].context)!, /Continue working toward the active thread goal\./);
    assert.equal(snapshot(h.calls[1].context), undefined, "a completed goal injects no goal message");
    assert.equal(h.notices.some(({ message }) => /Automatic goal turns are unavailable/.test(message)), false);
    assert.equal(h.session.messages.filter((m) => m.role === "custom" && m.customType === "secretary:goal-automatic").length, 1);
  });
}

test("pause before local dispatch cancels goal work without a provider call", async (t) => {
  const h = await hostSession(t);
  await h.session.prompt("/goal Wait for permission");
  await h.session.prompt("/goal pause");
  await flushAutomaticScheduling();
  assert.equal(h.calls.length, 0);
  assert.equal(h.engine.service.getGoal(h.threadId)?.status, "paused");
});

for (const response of ["sentinel", "complete_goal"] as const) {
  test(`newer pause blocks stale automatic ${response} without losing a queued status question`, { timeout: 15000 }, async (t) => {
    const entered = deferred();
    const release = deferred();
    let actions = 0;
    const h = await hostSession(t, {
      responses: [response, "success"],
      beforeResponse: async (_call, index) => { if (index === 0) { entered.resolve(); await release.promise; } },
      extension(pi) {
        pi.registerTool({ name: "sentinel", label: "Sentinel", description: "Record a local test action.", parameters: Type.Object({}),
          async execute() { actions++; return { content: [{ type: "text", text: "Executed." }], details: {} }; } });
      },
    });
    try {
      await h.session.prompt("/goal Do one local action");
      await entered.promise;
      await h.session.prompt("/goal pause");
      await h.session.prompt("QUEUED_STATUS_QUESTION", { source: "interactive", streamingBehavior: "followUp" });
      release.resolve();
      await h.session.waitForIdle();
      await flushAutomaticScheduling();
      assert.equal(actions, 0);
      assert.equal(h.engine.service.getGoal(h.threadId)?.status, "paused");
      assert.equal(h.calls[0].options?.signal?.aborted, false);
      const question = h.calls.find((call) => JSON.stringify(call.context).includes("QUEUED_STATUS_QUESTION"));
      assert.ok(question, "unrelated queued user question must reach the provider");
      assert.equal(snapshot(question.context), undefined, "a paused goal injects no goal message");
      assert.equal(h.restoredUserMessages.length, 0);
      assert.equal(h.session.pendingMessageCount, 0);
      assert.equal(h.session.messages.filter((m) => m.role === "custom" && m.customType === "secretary:goal-automatic").length, 1);
    } finally { release.resolve(); }
  });
}

test("late goal update rejects its old origin after tool-call admission", { timeout: 15000 }, async (t) => {
  const admitted = deferred();
  const release = deferred();
  const h = await hostSession(t, { responses: ["complete_goal", "success"], extension(pi) {
    // Registered after secretary's guard: the request is current at admission.
    pi.on("tool_call", async (event) => {
      if (event.toolName === "update_goal") { admitted.resolve(); await release.promise; }
    });
  } });
  try {
    await h.session.prompt("/goal Complete only while authorized");
    await admitted.promise;
    await h.session.prompt("/goal pause");
    release.resolve();
    await h.session.waitForIdle();
    await flushAutomaticScheduling();
    assert.equal(h.engine.service.getGoal(h.threadId)?.status, "paused");
    const result = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "update_goal");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /superseded|newer|old result/i);
  } finally { release.resolve(); }
});

test("already submitted automatic wakeup receives current state and is not replayed", { timeout: 15000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  const h = await hostSession(t, { extension(pi) {
    pi.on("turn_start", async () => { entered.resolve(); await release.promise; });
  } });
  try {
    await h.session.prompt("/goal Old automatic request");
    await entered.promise;
    await h.session.prompt("/goal pause");
    release.resolve();
    await h.session.waitForIdle();
    await flushAutomaticScheduling();
    assert.ok(h.calls.length > 0, "a submitted wakeup may still enter the provider");
    assert.equal(snapshot(h.calls[0].context), undefined, "a superseded wake-up for a paused goal injects no goal message");
    assert.doesNotMatch(JSON.stringify(h.calls[0].context), /Continue working toward the active thread goal\./);
    assert.equal(h.engine.service.getGoal(h.threadId)?.status, "paused");
    assert.equal(h.session.messages.filter((m) => m.role === "custom" && m.customType === "secretary:goal-automatic").length, 1);
  } finally { release.resolve(); }
});

test("budget exhaustion dispatches one wrap-up and no normal goal work", { timeout: 15000 }, async (t) => {
  const h = await hostSession(t);
  h.engine.service.createGoal(h.threadId, "Summarize only", 1, "user");
  h.engine.service.accountGoalUsage(h.threadId, 0, 1, "active_only");
  await flushAutomaticScheduling();
  await h.session.waitForIdle();
  await flushAutomaticScheduling();
  assert.equal(h.engine.service.getGoal(h.threadId)?.status, "budget_limited");
  assert.equal(h.calls.length, 1);
  const wrapUp = JSON.stringify(h.calls[0].context);
  assert.doesNotMatch(wrapUp, /Continue working toward the active thread goal\./);
  assert.match(wrapUp, /reached its token budget/);
  assert.equal(h.session.messages.filter((m) => m.role === "custom" && m.customType === "secretary:goal-automatic").length, 1);
});

test("an older input processed after a newer pause cannot acquire its authority", { timeout: 15000 }, async (t) => {
  const received = deferred(), release = deferred();
  const h = await hostSession(t, { responses: ["complete_goal", "success"], extension(pi) {
    pi.on("input", async (event) => {
      if (event.text === "DELAYED_GOAL_RESULT") { received.resolve(); await release.promise; }
    });
  } });
  try {
    await h.session.prompt("/goal Original work");
    const old = h.session.prompt("DELAYED_GOAL_RESULT");
    await received.promise;
    await h.session.prompt("/goal pause");
    const intent = h.engine.service.ordering.intentSeq(h.threadId);
    release.resolve(); await old; await h.session.waitForIdle();
    assert.equal(h.engine.service.ordering.intentSeq(h.threadId), intent);
    assert.equal(h.engine.service.getGoal(h.threadId)?.status, "paused");
    const update = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "update_goal");
    assert.ok(update?.role === "toolResult" && update.isError);
    assert.match(JSON.stringify(update.content), /superseded/);
  } finally { release.resolve(); }
});

test("ordinary input question does not advance accepted intent", async (t) => {
  const h = await hostSession(t, { startupGoal: "Remain paused", startupPaused: true });
  const accepted = h.engine.service.ordering.intentSeq(h.threadId);
  await h.session.prompt("What is the goal status?");
  assert.equal(h.engine.service.ordering.intentSeq(h.threadId), accepted);
  assert.equal(h.engine.service.ordering.hasPending(h.threadId), false);
  assert.equal(h.engine.service.getGoal(h.threadId)?.status, "paused");
});

test("valid no-op resume supersedes a pending older failure without blocking active goal", { timeout: 15000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  const h = await hostSession(t, {
    responses: ["error", "error"],
    beforeResponse: async (_call, index) => { if (index === 1) { entered.resolve(); await release.promise; } },
  });
  try {
    await h.session.prompt("/goal Preserve fresh intent");
    const run = h.session.prompt("Try the older request.");
    await entered.promise;
    const accepted = h.engine.service.ordering.intentSeq(h.threadId);
    await h.session.prompt("/goal resume");
    assert.ok(h.engine.service.ordering.intentSeq(h.threadId) > accepted);
    release.resolve();
    await run;
    await h.session.waitForIdle();
    assert.equal(h.engine.service.getGoal(h.threadId)?.status, "active");
    assert.ok(!h.lifecycle.some(({ status }) => status === "blocked"));
  } finally { release.resolve(); }
});
