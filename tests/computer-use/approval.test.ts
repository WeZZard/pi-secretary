import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVAL_TITLE, approvalMessage, channelApprover, confirmApprover, openApprovalChannel } from "../../extensions/secretary/computer-use/approval.ts";
import type { ApprovalRequest } from "../../extensions/secretary/computer-use/executor.ts";

const request: ApprovalRequest = {
  goal: "Clean up the notes", intent: "Press the default button",
  action: { app: "Safari", window: "Notes Cleanup", action: "click", ui_element: { role: "AXButton", name: "Delete" }, shownText: ["Delete all 12 notes? This cannot be undone."] },
  judgment: { verdict: "ask", reason: "guardian", mode: "auto", environment: "ephemeral", requests: [] },
};
const why = () => "the permission guardian judged that its effect leaves this machine";

test("the dialog shows the action's facts, why it asks, and the agent's own words last (design §8.5)", () => {
  const message = approvalMessage(request, why(), 300_000);
  assert.deepEqual(message.split("\n").slice(0, 7), [
    "Application: Safari", "Window: Notes Cleanup", 'Action: click Button "Delete"', "The window shows:",
    "  Delete all 12 notes? This cannot be undone.", "Why it asks: the permission guardian judged that its effect leaves this machine.",
    "The agent's step: Press the default button"]);
  assert.match(message, /Without an answer in 5 min, the plan stops and nothing is sent\.$/);
  const typing = approvalMessage({ ...request, action: { app: "Mail", window: "New Message", action: "type", text: "Hello\n  Bob" } }, why(), 300_000);
  assert.match(typing, /Action: type\nText to type: "Hello Bob"/);
});

test("the person's answer, a timeout, a cancelled run and a missing interface are told apart", async () => {
  const calls: { title: string; opts?: { timeout?: number } }[] = [];
  const ui = (answer: boolean | Error, elapsed = 0) => {
    let clock = 0;
    return { now: () => clock, ui: { confirm: async (title: string, _message: string, opts?: { timeout?: number }) => {
      calls.push({ title, ...(opts ? { opts } : {}) }); clock += elapsed;
      if (answer instanceof Error) throw answer; return answer;
    } } };
  };
  const answer = async (answerWith: boolean | Error, elapsed = 0, signal?: AbortSignal) => {
    const { ui: dialog, now } = ui(answerWith, elapsed);
    return confirmApprover(dialog, 1000, why, now)(request, signal);
  };
  assert.equal(await answer(true), "approved");
  assert.deepEqual(calls[0], { title: APPROVAL_TITLE, opts: { timeout: 1000 } });
  assert.equal(await answer(false, 10), "declined");
  assert.equal(await answer(false, 1000), "timeout");
  assert.equal(await answer(new Error("no dialog")), "no_interface");
  const cancelled = new AbortController();
  cancelled.abort();
  const before = calls.length;
  assert.equal(await answer(true, 0, cancelled.signal), "cancelled");
  assert.equal(calls.length, before, "A cancelled run shows no dialog");
});

test("without a registered channel nobody can be asked; the latest registration answers until it closes", async () => {
  assert.equal(await channelApprover(request), "no_interface");
  const closeFirst = openApprovalChannel(async () => "declined");
  const closeSecond = openApprovalChannel(async () => "approved");
  assert.equal(await channelApprover(request), "approved");
  closeFirst();
  assert.equal(await channelApprover(request), "approved", "Closing a replaced channel leaves the current one");
  closeSecond();
  assert.equal(await channelApprover(request), "no_interface");
});
