import assert from "node:assert/strict";
import { test } from "node:test";
import { timeline } from "../../extensions/secretary/vm-use/timeline.ts";
import type { ReviewPageStep, StepDetail } from "../../extensions/secretary/vm-use/viewer/page.ts";

/** One rule times every step of a trajectory (decisions PS-D43 and PS-D44, design §12.3, Time). */

const t = (s: number) => new Date(Date.UTC(2026, 9, 3, 10, 0, 0) + s * 1000).toISOString();
const agent = (id: string, kind: "prompt" | "call" | "result" | "agent", extra: Partial<NonNullable<ReviewPageStep["agent"]>> = {}): ReviewPageStep =>
  ({ id, agent: { kind, text: id, ...extra } as ReviewPageStep["agent"], title: id, execution: "completed", state: "recorded", inputMode: "agent" });
const plan = (id: string, cause: string, decisions: [number, number][], judgements: number[]): ReviewPageStep =>
  ({ id, cause, title: id, execution: "completed", state: "recorded", inputMode: "plan",
    plan: { runId: "run", stepId: id, result: "acted", decisions: decisions.map(([at, rt], i) => ({ attempt: i + 1, at: t(at), roundTripMs: rt, answers: {} })),
      judgements: judgements.map((at, i) => ({ attempt: i + 1, at: t(at), verdict: "proceed", requests: [] })) } });
const machine = (id: string, cause: string): ReviewPageStep =>
  ({ id, cause, machine: { name: "m", id }, title: id, execution: "completed", state: "recorded", inputMode: "cua" });

function run() {
  const steps = [
    agent("prompt", "prompt"),
    agent("call", "call", { pair: "result" }),
    plan("p1", "call", [[12, 2000]], [13]),
    machine("m1", "p1"),
    machine("m2", "p1"),
    plan("p2", "call", [[30, 1000]], [31]),
    machine("w", "p2"),
    plan("p3", "call", [], []),
    machine("read", "call"),
    agent("result", "result", { pair: "call" }),
    agent("said", "agent"),
  ];
  const details: Record<string, StepDetail> = {
    prompt: { at: t(0) }, call: { at: t(5) },
    m1: { at: t(14), beforeAt: t(14), afterAt: t(15.5) }, m2: { at: t(17), beforeAt: t(17.1), afterAt: t(18) },
    w: { at: t(28.5), beforeAt: t(28.5), afterAt: t(28.8) }, read: { beforeAt: t(40), afterAt: t(41) },
    result: { at: t(45) }, said: { at: t(45) },
  };
  timeline(steps, details);
  return details;
}

test("each kind of step lasts by its own rule", () => {
  const d = run();
  assert.equal(d.call!.endAt, t(45), "a call lasts until its result");
  assert.deepEqual([d.p1!.at, d.p1!.endAt], [t(10), t(18)], "a plan step runs from its grounder request to its last machine step");
  assert.deepEqual([d.p2!.at, d.p2!.endAt], [t(28.5), t(31)], "or from the read before its grounder request to its last judgement");
  assert.deepEqual(d.p3, {}, "a plan step that did not run has no time");
  assert.equal(d.m1!.endAt, t(15.5), "a machine step ends at its after snapshot");
  assert.equal(d.read!.endAt, t(41), "a machine step without an action start starts at its before snapshot");
  assert.equal(d.prompt!.endAt, undefined, "a prompt takes no time");
  assert.equal(d.result!.endAt, undefined, "a result takes no time");
});

test("each step's lead measures from the latest earlier point it follows", () => {
  const d = run();
  assert.equal(d.prompt!.lead, undefined, "the first step follows nothing");
  assert.deepEqual(d.call!.lead, { ms: 5000, from: "prompt", edge: "end" });
  assert.deepEqual(d.p1!.lead, { ms: 5000, from: "call", edge: "start" }, "a call's first plan step measures from the call's start");
  assert.deepEqual(d.m1!.lead, { ms: 4000, from: "p1", edge: "start" }, "a plan step's first machine step measures from the plan step's start");
  assert.deepEqual(d.m2!.lead, { ms: 1500, from: "m1", edge: "end" }, "the next machine step measures from the end of the one before");
  assert.deepEqual(d.p2!.lead, { ms: 10500, from: "m2", edge: "end" }, "of equal points, the later step's wins: the machine step that ends its plan step");
  assert.deepEqual(d.w!.lead, { ms: 0, from: "p2", edge: "start" }, "a plan step starts with its first machine step");
  assert.equal(d.p3!.lead, undefined, "a step without a start has no lead");
  assert.deepEqual(d.read!.lead, { ms: 9000, from: "p2", edge: "end" }, "a step without a start is passed over");
  assert.deepEqual(d.result!.lead, { ms: 4000, from: "read", edge: "end" }, "a result measures from the last step inside its call");
  assert.deepEqual(d.said!.lead, { ms: 0, from: "result", edge: "end" });
});

test("a lead that would be negative, from a clock difference, is not recorded", () => {
  const steps = [agent("call", "call", { pair: "result" }), machine("m", "call"), agent("result", "result", { pair: "call" })];
  // The guest's clock is behind the host's: its read seems to start before the call.
  const details: Record<string, StepDetail> = { call: { at: t(10) }, m: { at: t(8), beforeAt: t(8), afterAt: t(9) }, result: { at: t(20) } };
  timeline(steps, details);
  assert.equal(details.m!.lead, undefined);
  assert.deepEqual(details.result!.lead, { ms: 10000, from: "call", edge: "start" });
});
