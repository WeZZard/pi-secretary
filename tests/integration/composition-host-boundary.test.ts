import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { goalAgentCompositionSession } from "../support/goal-agent-composition-session.ts";
import { flushAutomaticScheduling } from "../support/host-session.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

for (const pauseAt of ["before-admission", "after-admission"] as const) {
  test(`ordinary non-agent host boundary: pause ${pauseAt} preserves queued user input`, { timeout: 15000 }, async t => {
    const release = deferred();
    const question = `USER_STATUS_QUESTION_${pauseAt}`;
    let held = false, issued = false, executions = 0, laterHookCalls = 0, blanketAborts = 0, queueClears = 0;
    const requestSignals: AbortSignal[] = [];
    const observedStatuses: Array<string | undefined> = [];
    const h = await goalAgentCompositionSession(t, {
      respond: async context => {
        if (!issued) {
          assert.match(JSON.stringify(context.messages), /Continue working toward the active thread goal\./);
          issued = true;
          if (pauseAt === "before-admission") { held = true; await release.promise; }
          return [{ type: "toolCall", id: "ordinary-sentinel", name: "boundary_sentinel", arguments: {} }];
        }
        return [{ type: "text", text: JSON.stringify(context.messages).includes(question)
          ? "USER_QUESTION_ANSWERED" : "Already-admitted operation observed." }];
      },
      extension(pi) {
        pi.registerTool({ name: "boundary_sentinel", label: "Boundary sentinel", description: "Record an isolated non-agent action.",
          parameters: Type.Object({}), async execute(_id, _params, signal) {
            assert.equal(signal?.aborted, false);
            executions++;
            observedStatuses.push(h.engine.service.getGoal(h.goalThreadId)?.status);
            return { content: [{ type: "text", text: "SENTINEL_FINISHED" }], details: { executed: true } };
          } });
        pi.on("context", (_event, ctx) => { if (ctx.signal) requestSignals.push(ctx.signal); });
        pi.on("tool_call", async event => {
          if (event.toolName !== "boundary_sentinel") return;
          laterHookCalls++;
          if (pauseAt === "after-admission") { held = true; await release.promise; }
        });
      },
    });
    const originalAbort = h.session.agent.abort.bind(h.session.agent);
    const originalClearQueue = h.session.clearQueue.bind(h.session);
    const abortSpy = t.mock.method(h.session.agent, "abort", () => { blanketAborts++; return originalAbort(); });
    const queueSpy = t.mock.method(h.session, "clearQueue", () => { queueClears++; return originalClearQueue(); });
    let failure: unknown;
    try {
      await h.session.prompt("/goal Exercise the isolated ordinary tool admission boundary", { source: "rpc" });
      await until(() => held, pauseAt === "before-admission" ? "automatic provider response before tool admission" : "third-party hook after Secretary admission");
      assert.equal(h.session.isStreaming, true);
      assert.equal(h.engine.service.getGoal(h.goalThreadId)?.status, "active");
      assert.equal(executions, 0);
      assert.equal(laterHookCalls, pauseAt === "after-admission" ? 1 : 0);
      await h.session.prompt("/goal pause", { source: "rpc" });
      assert.equal(h.engine.service.getGoal(h.goalThreadId)?.status, "paused");
      await h.session.prompt(question, { source: "rpc", streamingBehavior: "followUp" });
      assert.deepEqual(h.session.getFollowUpMessages(), [question]);
      release.resolve();
      await h.session.waitForIdle();
      await flushAutomaticScheduling();
      await h.session.waitForIdle();

      const result = h.session.messages.find((message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "ordinary-sentinel");
      assert.ok(result, JSON.stringify(h.session.messages));
      if (pauseAt === "before-admission") {
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /superseded|expired|stale|abort/i);
        assert.equal(executions, 0);
        assert.equal(laterHookCalls, 0, "Secretary rejection prevents downstream hooks and execution");
      } else {
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.equal(executions, 1);
        assert.deepEqual(observedStatuses, ["paused"], "The admitted non-agent operation can execute after the later pause");
        assert.match(JSON.stringify(result.content), /SENTINEL_FINISHED/);
      }
      assert.equal(blanketAborts, 0, "Goal ordering must not abort the entire parent run");
      assert.equal(queueClears, 0, "Goal ordering must not clear unrelated queued input");
      assert.ok(requestSignals.length >= 2);
      assert.ok(requestSignals.every(signal => !signal.aborted));
      assert.ok(h.parentCalls.some(context => JSON.stringify(context.messages).includes(question)), "The queued question must reach the provider");
      assert.ok(h.session.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "USER_QUESTION_ANSWERED")));
      assert.equal(h.inputs.filter(input => input.text === question && input.source === "rpc").length, 1);
      assert.equal(h.session.pendingMessageCount, 0);
      assert.equal(h.engine.service.getGoal(h.goalThreadId)?.status, "paused");
      assert.equal(h.session.messages.filter(message => message.role === "custom" && message.customType === "secretary:goal-automatic").length, 1);
      assert.deepEqual(h.repository.runs(h.threadId), [], "This characterizes an ordinary host tool, not owned agent dispatch");
    } catch (error) { failure = error; throw error; }
    finally {
      release.resolve();
      abortSpy.mock.restore(); queueSpy.mock.restore();
      await h.retain({ pauseAt, executions, laterHookCalls, blanketAborts, queueClears, observedStatuses,
        requestSignalsAborted: requestSignals.map(signal => signal.aborted),
        failure: failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure });
    }
  });
}
