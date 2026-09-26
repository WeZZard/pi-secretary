import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appsOf, classify, score, toCommands, type MacArenaTask } from "../../scripts/computer-use/support/macarena.ts";

/** Evaluation plan phase E1: MacArena tasks as relay setup and checks, scored and classified (design §3, §4). */

const task: MacArenaTask = {
  id: "t1", instruction: "Create a list called Project Alpha.", pre_command: "osascript -e 'tell application \"Reminders\" to quit'",
  before_action_delay_seconds: 4, before_grading_delay_seconds: 5, related_apps: ["Reminders"],
  evaluator: [["echo True", 100], ["echo partial", 50], ["echo False", 100]],
};
const ran = (stdout: string[]) => [{ argv: ["/bin/sleep", "5"], completed: true, stdout: "" },
  ...stdout.map((out, index) => ({ argv: ["/bin/zsh", "-c", `check ${index}`], completed: out !== "error", stdout: out === "error" ? "" : out }))];

test("a task becomes setup commands, with the app opened only for the ship gate, and checks worth 100 after the grading delay", () => {
  assert.deepEqual(toCommands(task, {}), {
    prepare: [["/bin/sh", "-c", `${task.pre_command}\ntrue`], ["/bin/sleep", "4"]],
    check: [["/bin/sleep", "5"], ["/bin/bash", "-c", "echo True"], ["/bin/bash", "-c", "echo False"]],
  });
  assert.deepEqual(toCommands(task, { openApp: "Reminders" }).prepare.slice(1, 3), [["/usr/bin/open", "-a", "Reminders"], ["/bin/sleep", "3"]]);
});

test("a task's applications are its related apps, or the applications its scripts address", () => {
  assert.deepEqual(appsOf(task), ["Reminders"]);
  assert.deepEqual(appsOf({ id: "m", instruction: "Change the default language.", pre_command: "osascript -e 'tell application \"Script Editor\" to activate'",
    evaluator: [["osascript -e 'tell application \"System Events\" to tell process \"Script Editor\" to get value of pop up button 1'", 100]] }), ["Script Editor"]);
  assert.deepEqual(appsOf({ id: "m", instruction: "Add a contact.", evaluator: [["osascript -e 'tell application \"Contacts\" to get phones'", 100]] }), ["Contacts"]);
});

test("the score follows MacArena: the first check printing true scores 1, false lets the next try, a check that did not run scores 0", () => {
  assert.equal(score(task, ran(["True\n", "False\n"])), 1);
  assert.equal(score(task, ran(["False\n", "True\n"])), 1);
  assert.equal(score(task, ran(["False\n", "False\n"])), 0);
  assert.equal(score(task, ran(["error", "True\n"])), 0);
  assert.equal(score(task, undefined), undefined, "No checks ran");
  assert.equal(score(task, ran(["True\n"])), undefined, "A missing check result is not a score");
});

function state(t: TestContext, records: { plans?: { outcome: string; escalation?: { reason: string } }[]; steps?: unknown[]; rejections?: string[]; session?: string }) {
  const root = mkdtempSync(join(tmpdir(), "macarena-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records_ = join(root, "computer-use", "session");
  records.plans?.forEach((plan, index) => {
    mkdirSync(join(records_, "runs", `run-${index}`), { recursive: true });
    writeFileSync(join(records_, "runs", `run-${index}`, "plan.json"), JSON.stringify({ recordedAt: `2026-09-26T00:00:0${index}Z`, ...plan }));
  });
  records.steps?.forEach((step, index) => {
    mkdirSync(join(records_, "runs", "run-0"), { recursive: true });
    writeFileSync(join(records_, "runs", "run-0", `step-s-${index}.json`), JSON.stringify(step));
  });
  records.rejections?.forEach((rule, index) => {
    mkdirSync(join(records_, "rejections"), { recursive: true });
    writeFileSync(join(records_, "rejections", `${1000 + index}-${rule}.json`), JSON.stringify({ rule }));
  });
  if (records.session) {
    mkdirSync(join(root, "agents", "a", "sessions"), { recursive: true });
    writeFileSync(join(root, "agents", "a", "sessions", "s.jsonl"), records.session);
  }
  return root;
}

test("a failed run gets one cause from its records", (t) => {
  const failed = ran(["False\n", "False\n"]);
  assert.equal(classify({ score: 1, checks: ran(["True\n", "False\n"]), state: state(t, {}) }), "passed");
  assert.equal(classify({ score: 0, checks: failed, state: state(t, { plans: [{ outcome: "completed" }] }) }), "false_success",
    "The agent's own checks passed and the task's check did not");
  assert.equal(classify({ score: 0, checks: failed, state: state(t, { plans: [{ outcome: "escalated", escalation: { reason: "no_progress" } }],
    steps: [{ decision: { kind: "act", risk: "destructive" } }] }) }), "destructive");
  assert.equal(classify({ score: 0, checks: failed, state: state(t, { plans: [{ outcome: "completed" }, { outcome: "escalated", escalation: { reason: "target_not_found" } }] }) }),
    "escalation:target_not_found", "The last plan decides");
  assert.equal(classify({ score: 0, checks: failed, state: state(t, { rejections: ["needs_text"] }) }), "rejection:needs_text");
  assert.equal(classify({ score: 0, checks: failed, state: state(t, { session: "No window of Reminders is open. This tool does not launch applications." }) }), "out_of_scope");
  assert.equal(classify({ score: 0, checks: failed, state: state(t, {}) }), "no_plan");
  assert.equal(classify({ score: 0, checks: failed, state: state(t, { session: "relay_exec cu-0001 (Prepare: /bin/zsh -c osascript -e 'tell application \\\"Reminders\\\" to quit') was completed: exit 1" }) }), "setup_failed",
    "Quotes in the command are escaped in the session record");
  assert.equal(classify({ score: undefined, checks: undefined, state: state(t, { plans: [{ outcome: "completed" }] }) }), "check_failed",
    "A run whose checks never ran is not blamed on the agent");
});
