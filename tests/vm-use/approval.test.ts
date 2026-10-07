import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVAL_TITLE, approvalMessage, channelApprover, confirmApprover, openApprovalChannel } from "../../extensions/secretary/vm-use/approval.ts";
import type { ApprovalRequest } from "../../extensions/secretary/vm-use/executor.ts";

const request: ApprovalRequest = {
  goal: "Add two reminders and share the list with Alex", app: "Reminders", window: "Groceries",
  steps: [{ id: "share_1", intent: "Share the Groceries list with Alex.", action: "click", ui_element: 'Button "Share"', why: "outside_guest" }],
};

test("the dialog lists the application, the window, each step that needs approval with why, and the agent's goal last (design §8.4)", () => {
  assert.deepEqual(approvalMessage(request, 300_000).split("\n"), [
    "Application: Reminders", "Window: Groceries", "This step needs approval:",
    '- share_1: click Button "Share"', "  The agent's step: Share the Groceries list with Alex.", "  Why: its effect leaves the virtual machine.",
    "The agent's goal: Add two reminders and share the list with Alex", "",
    "Approving runs the whole plan without stopping. Declining stops it. Without an answer in 5 min, the plan stops and nothing is sent."]);
  const several = approvalMessage({ goal: "Write to Bob", app: "Mail", steps: [
    { id: "body", intent: "Type the message", action: "type", ui_element: 'TextArea "(no name)"', text: "Hello\n  Bob", why: "requested" },
    { id: "send", intent: "Send it", keys: "cmd+shift+d", why: "outside_guest" }] }, 300_000);
  assert.match(several, /^Application: Mail\nWindow: \(as observed\)\nThese steps need approval:\n- body: type TextArea "\(no name\)"\n  Text to type: "Hello Bob"\n/);
  assert.match(several, /Why: the task asked for approval before this kind of step\.\n- send: action chosen at run time cmd\+shift\+d\n/);
  const failed = approvalMessage({ ...request, steps: [{ ...request.steps[0]!, why: "doubt" }], failure: "the online plan check returned HTTP 502: bad gateway" }, 60_000);
  assert.match(failed, /Why: the online plan check failed: the online plan check returned HTTP 502: bad gateway\./);
  const many = approvalMessage({ ...request, steps: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, intent: "Step", why: "doubt" as const })) }, 60_000);
  assert.match(many, /- s7: action chosen at run time\n[^]*- and 2 more\n/);
  assert.doesNotMatch(many, /- s8:/);
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
    return confirmApprover(dialog, 1000, now)(request, signal);
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
