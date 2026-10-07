import type { ReviewPageStep, StepDetail } from "./viewer/page.ts";

/**
 * When each step of a trajectory started and ended, and the time before it
 * started (decisions PS-D43 and PS-D44, design §12.3, Time). One rule times
 * every step, so the page shows the model's times and computes none.
 */

const time = (value: string | undefined) => Date.parse(value ?? "");
const iso = (ms: number) => new Date(ms).toISOString();

/** A step's start: its `at`, or its before snapshot when the start is missing. */
const startOf = (detail: StepDetail | undefined) => {
  const at = time(detail?.at);
  return Number.isFinite(at) ? at : time(detail?.beforeAt);
};

/**
 * A plan step's span: from its first activity, the grounder request or the read of the window
 * that comes before it, to its latest judgement, decision or machine step end.
 */
function planSpan(step: ReviewPageStep, ran: ReviewPageStep[], details: Record<string, StepDetail>) {
  const plan = step.plan!;
  const start = Math.min(...[...plan.decisions.map(d => time(d.at) - (d.roundTripMs ?? 0)), ...ran.map(s => startOf(details[s.id]))].filter(Number.isFinite));
  const end = Math.max(...plan.judgements.map(j => time(j.at)), ...plan.decisions.map(d => time(d.at)),
    ...ran.map(s => time(details[s.id]?.endAt ?? details[s.id]?.at)));
  return { start, end };
}

/**
 * Sets each step's `at` and `endAt` by its kind, then each step's `lead`: the
 * time from the latest earlier point the step follows to its start. A step
 * follows the start of each earlier step it lies inside and the end of every
 * other earlier step. A step lies inside the step named by its `cause`, and a
 * result inside its call; lying inside is transitive.
 */
export function timeline(steps: readonly ReviewPageStep[], details: Record<string, StepDetail>) {
  const byId = new Map(steps.map(step => [step.id, step]));
  const container = (step: ReviewPageStep) => step.cause ?? (step.agent?.kind === "result" ? step.agent.pair : undefined);

  // Spans. Machine steps first, since a plan step ends with its machine steps.
  for (const step of steps) {
    if (!step.machine) continue;
    const detail = details[step.id] ??= {};
    if (detail.afterAt && !Number.isNaN(startOf(detail)) && time(detail.afterAt) >= startOf(detail)) detail.endAt = detail.afterAt;
  }
  for (const step of steps) {
    if (!step.plan) continue;
    const { start, end } = planSpan(step, steps.filter(s => s.machine && s.cause === step.id), details);
    details[step.id] = Number.isFinite(start) ? { at: iso(start), ...(Number.isFinite(end) && end >= start ? { endAt: iso(end) } : {}) } : {};
  }
  for (const step of steps) {
    const a = step.agent;
    if (a?.kind !== "call" || !a.pair) continue;
    const detail = details[step.id] ??= {}, end = time(details[a.pair]?.at);
    if (Number.isFinite(end) && end >= startOf(detail)) detail.endAt = iso(end);
  }

  // Leads.
  const inside = (step: ReviewPageStep, outer: string) => {
    for (let id = container(step), seen = 0; id && seen < steps.length; id = byId.get(id) ? container(byId.get(id)!) : undefined, seen++)
      if (id === outer) return true;
    return false;
  };
  const timed = steps.filter(step => Number.isFinite(startOf(details[step.id])));
  timed.forEach((step, i) => {
    const start = startOf(details[step.id]);
    let mark = -Infinity, from: ReviewPageStep | undefined, edge: "start" | "end" = "end";
    for (const earlier of timed.slice(0, i)) {
      const detail = details[earlier.id], within = inside(step, earlier.id);
      const point = within ? startOf(detail) : Number.isFinite(time(detail?.endAt)) ? time(detail!.endAt) : startOf(detail);
      if (point >= mark) { mark = point; from = earlier; edge = within ? "start" : "end"; }
    }
    if (from && start >= mark) details[step.id]!.lead = { ms: start - mark, from: from.id, edge };
  });
}
