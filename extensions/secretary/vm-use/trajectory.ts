import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { reviewData, type ReviewData as MachineData } from "@wezzard/mcp-vm-relay/review-data";
import { timeline } from "./timeline.ts";
import type { Answers, CallRecord, MachineSummary, ObservationItem, PlanCheckItem, PlanStepItem, Reason, ReviewData, ReviewPageStep, StepDetail } from "./viewer/page.ts";

/**
 * The trajectory of one vm-use agent (decisions PS-D17, PS-D18 and PS-D40, design §12.3):
 * the model of the viewer app. The agent's session is its one source of items, in the session's
 * order. The extension's records extend the vm-use calls: a plan's steps with the grounder's
 * decisions and the plan check, an observation's read, and the machine steps those
 * records name. The relay interprets its own packages (`reviewData`). It only reads.
 */

/** A picture the agent received in a tool result, served to the page at `path`. */
export interface SessionImage { path: string; mimeType: string; data: string }

export interface AgentTrajectory {
  data: ReviewData;
  images: SessionImage[];
  /** The machines' package directories, by package name. */
  packages: Map<string, string>;
}

export interface TrajectoryInput {
  /** The agent's Pi session file. */
  session: string;
  /** The directory that holds the relay evidence packages. */
  evidence: string;
  /** The session's vm-use state directory, which holds the extension's records. */
  state?: string;
  /** Package names from the session's lease records; without them, the state's lease records, or else packages chosen by time. */
  packages?: string[];
  agentId?: string;
  /** How a machine's package is read; the relay's own derivation unless given. */
  review?: (dir: string) => Promise<MachineData>;
}

const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };
const readLines = (path: string): Record<string, unknown>[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } }) : [];
const list = (directory: string) => existsSync(directory) ? readdirSync(directory) : [];
const time = (at: string | undefined) => at ? Date.parse(at) : NaN;
// Evidence recorded before the rename is named relay-computer-use-… (decision PS-D48).
const PACKAGE = /^relay-(?:vm-use|computer-use)-[0-9a-f]+$/;
/** A verdict's severity, as the page's tones order them. */
const severity = (value: string | undefined) => ["passed", "complete", "completed"].includes(value ?? "") ? 0 : ["failed", "refused"].includes(value ?? "") ? 2 : 1;
const worst = (values: (string | undefined)[], none: string) => values.reduce<string | undefined>((all, value) => all === undefined || severity(value) > severity(all) ? value : all, undefined) ?? none;

interface SessionPart { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string }
interface SessionMessage { role: string; content: string | SessionPart[]; toolCallId?: string; toolName?: string; isError?: boolean; details?: Record<string, unknown> }

/** The records the extension writes (telemetry.ts), as far as the trajectory reads them. */
interface PlanSpecStep { id: string; intent?: string; action?: string; operation?: string; keys?: string; text?: string; ui_element?: { name?: string } }
interface PlanRecord {
  recordedAt?: string; runId: string; outcome?: string;
  /** The permission check mode (design §8.1). Runs before decision PS-D53 recorded an object here. */
  permissionCheck?: unknown;
  /** Who chose the mode (decision PS-D54). */
  permissionCheckSource?: unknown;
  steps: { id: string; result: string; action?: string; element?: string; detail?: string; evidence?: string[] }[];
  plan?: { goal?: string; steps?: PlanSpecStep[] };
}
interface StepRecord { recordedAt?: string; stepId: string; attempt: number; roundTripMs?: number; answers?: Answers; decision?: { kind?: string; operation?: string; element?: string; group?: string; reason?: string } }
/** The online plan check of a plan (design §12.1): one record per checked plan. */
interface PlanCheckRecord {
  schema?: string; recordedAt?: string; approval?: { answer: string; ms?: number };
  check?: { failure?: string; roundTripMs?: number; steps?: { id: string; reach?: string; requested?: string; needsApproval?: boolean; why?: string }[] };
}
/** Runs before decision PS-D53: the guardian's judgement of one action. */
interface PermissionRecord {
  recordedAt?: string; stepId: string; attempt: number; approval?: { answer: string; ms?: number };
  judgment?: { verdict?: string; reason?: string; requests?: { purpose: string; answers?: Answers; roundTripMs?: number }[] };
}
interface ObservationRecord { recordedAt?: string; status?: string; readMs?: number; window?: { app?: string; title?: string }; groups?: { elements?: unknown[] }[]; evidence?: string[] }
interface Lease { package: string; recordedAt?: string }

/** The lease records under a session's vm-use state directory, in acquisition order (design §12.3). */
function leases(state: string): Lease[] {
  const directory = join(state, "leases");
  return list(directory).filter(file => file.endsWith(".json")).flatMap(file => { const lease = readJson<Lease>(join(directory, file)); return lease?.package ? [lease] : []; })
    .sort((a, b) => (time(a.recordedAt) || 0) - (time(b.recordedAt) || 0));
}

/** The package names in a session's lease records, in acquisition order; undefined without any. */
export function leasedPackages(state: string): string[] | undefined {
  const found = leases(state);
  return found.length ? found.map(lease => lease.package) : undefined;
}

const firstAt = (data: MachineData) => Math.min(...Object.values(data.details).map(detail => time(detail.at)).filter(Number.isFinite));

/** The session's prompts, messages, calls and results, in the session's order, with the pictures the agent received. */
function sessionItems(session: string) {
  const lines = readLines(session);
  const header = lines.find(line => line.type === "session");
  const model = lines.filter(line => line.type === "model_change").at(-1);
  const messages = lines.filter(line => line.type === "message") as { timestamp: string; message: SessionMessage }[];
  const steps: ReviewPageStep[] = [], details: Record<string, StepDetail> = {}, images: SessionImage[] = [];
  const calls = new Map<string, { step: ReviewPageStep; arguments: Record<string, unknown> }>();
  /** A call's result, with the details the tool returned. */
  const results = new Map<string, { details?: Record<string, unknown> }>();
  let prompts = 0;
  const add = (at: string, agent: NonNullable<ReviewPageStep["agent"]>, execution = "completed") => {
    const step: ReviewPageStep = { id: `agent-${steps.length + 1}`, agent, title: agent.text, execution, state: "recorded", inputMode: "agent" };
    steps.push(step);
    details[step.id] = { at };
    return step;
  };
  for (const { timestamp, message } of messages) {
    const parts: SessionPart[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const text = parts.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
    if (message.role === "user") add(timestamp, { kind: "prompt", origin: prompts++ === 0 ? "spawn" : "message", text });
    else if (message.role === "assistant") {
      for (const part of parts) {
        if (part.type === "thinking" && part.thinking?.trim()) add(timestamp, { kind: "thinking", text: part.thinking.trim() });
        if (part.type === "text" && part.text?.trim()) add(timestamp, { kind: "agent", text: part.text.trim() });
        if (part.type === "toolCall" && part.id) calls.set(part.id, { step: add(timestamp, { kind: "call", name: part.name ?? "?", text: JSON.stringify(part.arguments ?? {}, null, 2) }),
          arguments: (part.arguments ?? {}) as Record<string, unknown> });
      }
    } else if (message.role === "toolResult") {
      const call = message.toolCallId ? calls.get(message.toolCallId)?.step : undefined;
      const picture = parts.find(part => part.type === "image" && part.data);
      const image = picture ? { path: `.session/${images.length + 1}.${picture.mimeType === "image/jpeg" ? "jpg" : "png"}`, mimeType: picture.mimeType ?? "image/png", data: picture.data! } : undefined;
      if (image) images.push(image);
      const result = add(timestamp, { kind: "result", name: call?.agent?.name ?? message.toolName ?? "?", text, ...(image ? { image: image.path } : {}), ...(call ? { pair: call.id } : {}) },
        message.isError ? "failed" : "completed");
      if (call?.agent) { call.agent.pair = result.id; call.agent.endAt = timestamp; }
      results.set(result.id, { ...(message.details ? { details: message.details } : {}) });
    }
  }
  return { header, model, steps, details, images, calls: [...calls.values()], results,
    first: messages[0]?.timestamp ?? String(header?.timestamp ?? ""), last: messages.at(-1)?.timestamp ?? String(header?.timestamp ?? "") };
}

/** A machine's review data with its step identifiers and file paths prefixed by its package, since two machines share step names. */
function machineSteps(name: string, data: MachineData) {
  const short = name.replace(/^relay-(?:vm-use|computer-use)-/, "");
  const id = (step: string) => `${short}-${step}`;
  const reason = (r: Reason): Reason => ({ ...r, stepIds: r.stepIds.map(id) });
  const steps = new Map(data.steps.map(step => [step.id, { ...step, id: id(step.id), machine: { name, id: step.id },
    ...(step.snapshots ? { snapshots: { ...step.snapshots, ...(step.snapshots.before ? { before: `${name}/${step.snapshots.before}` } : {}), ...(step.snapshots.after ? { after: `${name}/${step.snapshots.after}` } : {}) } } : {}) } as ReviewPageStep]));
  // The extension names a step by the identifier it gave the relay (relay-client.ts). The relay keeps
  // that identifier for a read, and names a tool call by its tool, with the identifier in `because`.
  const named = new Map<string, ReviewPageStep>();
  for (const [relayId, step] of steps) {
    named.set(relayId, step);
    const given = /\(((?:vu|cu)-\d+)\)\s*$/.exec(step.because ?? "")?.[1];
    if (given && !named.has(given)) named.set(given, step);
  }
  return {
    name,
    steps,
    named,
    details: Object.fromEntries(Object.entries(data.details).map(([step, detail]) => [id(step), detail])),
    reasons: { snapshots: data.reasons.snapshots.map(reason), execution: data.reasons.execution.map(reason), defects: (data.reasons.defects ?? []).map(reason) },
    outputs: data.outputs.map(output => ({ ...output, path: `${name}/${output.path}` })),
    files: data.files.map(file => ({ ...file, path: `${name}/${file.path}` })),
  };
}
type Machine = ReturnType<typeof machineSteps> & { since: number };

/** The plan's planned action in words, such as `key return` or `click "Add Reminder"`. */
function plannedAction(spec: PlanSpecStep) {
  const action = spec.action ?? spec.operation;
  return action ? [action, spec.keys, spec.text !== undefined ? JSON.stringify(spec.text) : undefined, spec.ui_element?.name !== undefined ? JSON.stringify(spec.ui_element.name) : undefined].filter(Boolean).join(" ") : undefined;
}
const decisionWords = (d: StepRecord["decision"]) => d?.kind === "act"
  ? [d.operation, d.element !== undefined ? JSON.stringify(d.element) : undefined, d.group ? `in ${d.group}` : undefined].filter(Boolean).join(" ")
  : d?.kind ? [d.kind, d.reason].filter(Boolean).join(": ") : undefined;
/**
 * A plan's permission check, from its plan record's mode and its plan-check record (design §12.3). Runs before decision
 * PS-D53 recorded no mode as a word; their checks are the per-action judgements on the plan steps.
 */
function planCheckOf(plan: PlanRecord, record: PlanCheckRecord | undefined): PlanCheckItem | undefined {
  const mode = typeof plan.permissionCheck === "string" ? plan.permissionCheck : record ? "online" : undefined;
  if (!mode) return undefined;
  const c = record?.check;
  return { mode, ...(typeof plan.permissionCheckSource === "string" ? { source: plan.permissionCheckSource } : {}), ...(c?.roundTripMs !== undefined ? { roundTripMs: c.roundTripMs } : {}), ...(c?.failure ? { failure: c.failure } : {}),
    marked: (c?.steps ?? []).filter(step => step.needsApproval).map(step => ({ id: step.id, ...(step.why ? { why: step.why } : {}) })),
    ...(record?.approval ? { approval: record.approval } : {}) };
}
const stepExecution = (result: string) => result === "acted" ? "completed" : result === "not_run" ? "not run" : result;

/** The extension's records under a session's vm-use state directory (design §12.1). */
function records(state: string | undefined) {
  const runs = state ? join(state, "runs") : undefined;
  const plans = runs ? list(runs).flatMap(run => { const plan = readJson<PlanRecord>(join(runs, run, "plan.json")); return plan ? [plan] : []; }) : [];
  const files = (runId: string, prefix: string) => runs ? list(join(runs, runId)).filter(file => file.startsWith(prefix)).map(file => join(runs, runId, file)) : [];
  const ofStep = <T extends { stepId: string; attempt: number; recordedAt?: string }>(runId: string, prefix: string, stepId: string) =>
    files(runId, prefix).flatMap(file => { const record = readJson<T>(file); return record?.stepId === stepId ? [record] : []; })
      .sort((a, b) => a.attempt - b.attempt || (time(a.recordedAt) || 0) - (time(b.recordedAt) || 0));
  return {
    plan: (runId: string) => plans.find(plan => plan.runId === runId),
    /** A session recorded before the result named its run: the plan with the call's goal, written while the call ran (design §12.3). */
    planByGoal: (goal: unknown, from: number, to: number) => plans.find(plan => plan.plan?.goal === goal && time(plan.recordedAt) >= from && time(plan.recordedAt) <= to),
    decisions: (runId: string, stepId: string) => ofStep<StepRecord>(runId, "step-", stepId),
    judgements: (runId: string, stepId: string) => ofStep<PermissionRecord>(runId, "permission-", stepId),
    planCheck: (runId: string) => files(runId, "permission-").map(file => readJson<PlanCheckRecord>(file)).find(record => record?.schema === "secretary.vm-use.plan-check/1"),
    observation: (file: string) => state ? readJson<ObservationRecord>(join(state, "observations", basename(file))) : undefined,
  };
}

export async function buildTrajectory(input: TrajectoryInput): Promise<AgentTrajectory> {
  const session = sessionItems(input.session);
  const derive = input.review ?? reviewData;
  const review = async (name: string) => { try { return await derive(join(input.evidence, name)); } catch { return undefined; } };
  const leased = input.state ? leases(input.state) : [];
  const names = input.packages ?? (leased.length ? leased.map(lease => lease.package) : undefined);
  let machines: { name: string; data?: MachineData }[];
  if (names) machines = await Promise.all(names.map(async name => ({ name, data: await review(name) })));
  else {
    // Without a lease record: a machine is acquired during the agent's first computer call, so its
    // first step starts inside the session.
    const all = await Promise.all(list(input.evidence).filter(name => PACKAGE.test(name)).map(async name => ({ name, data: await review(name) })));
    machines = all.filter(machine => machine.data && firstAt(machine.data) >= time(session.first) && firstAt(machine.data) <= time(session.last))
      .sort((a, b) => firstAt(a.data!) - firstAt(b.data!));
  }
  const joined: Machine[] = machines.flatMap(machine => machine.data
    ? [{ ...machineSteps(machine.name, machine.data), since: time(leased.find(lease => lease.package === machine.name)?.recordedAt) || firstAt(machine.data) }] : []);
  const details: Record<string, StepDetail> = { ...session.details };
  const record = records(input.state);
  const asked = new Set<string>();
  const steps: ReviewPageStep[] = [];
  /** The machine of a call: the one whose lease is the latest written before the call's result (design §12.3). */
  const machineAt = (at: number) => joined.filter(machine => machine.since <= at).at(-1) ?? joined[0];
  /** The machine steps a record names, asked for by `cause`. */
  const machineStepsOf = (ids: string[] | undefined, machine: Machine | undefined, cause: string) => (ids ?? []).flatMap(id => {
    const step = machine?.named.get(id);
    if (!step || asked.has(step.id)) return [];
    asked.add(step.id);
    details[step.id] = { ...machine!.details[step.id] };
    return [{ ...step, cause }];
  });
  const observationOf = (id: string, file: ObservationRecord | undefined): ObservationItem | undefined => file
    ? { id, status: file.status ?? "unknown", ...(file.window?.app ? { app: file.window.app } : {}), ...(file.window?.title ? { window: file.window.title } : {}),
      elements: (file.groups ?? []).reduce((sum, group) => sum + (group.elements?.length ?? 0), 0), ...(file.readMs !== undefined ? { readMs: file.readMs } : {}) } : undefined;

  // Transcripts recorded before the rename call the tools computer_observe and computer_run_plan (decision PS-D48).
  const OBSERVE = new Set(["vm_observe", "computer_observe"]), RUN_PLAN = new Set(["vm_run_plan", "computer_run_plan"]);
  /** What the extension recorded for a call, as items to place before its result (design §12.3, Extension). */
  const extend = (call: ReviewPageStep, args: Record<string, unknown>, result: ReviewPageStep): ReviewPageStep[] => {
    const a = call.agent!, returned = session.results.get(result.id)?.details ?? {};
    const from = time(details[call.id]?.at), to = time(details[result.id]?.at), machine = machineAt(to);
    if (OBSERVE.has(a.name ?? "")) {
      const file = typeof returned.recordPath === "string" ? record.observation(returned.recordPath) : undefined;
      const id = String(returned.observationId ?? "");
      a.record = { kind: "observation", found: !!file, ...(file ? { observation: observationOf(id, file)! } : {}) };
      return machineStepsOf(file?.evidence, machine, call.id);
    }
    if (!RUN_PLAN.has(a.name ?? "") || returned.outcome === "rejected") return [];
    const plan = typeof returned.runId === "string" ? record.plan(returned.runId) : record.planByGoal(args.goal, from, to);
    const checked = plan ? record.planCheck(plan.runId) : undefined;
    const check = plan ? planCheckOf(plan, checked) : undefined;
    a.record = { kind: "plan", found: !!plan, ...(plan ? { runId: plan.runId, outcome: plan.outcome ?? "unknown", by: typeof returned.runId === "string" ? "run" as const : "goal" as const } : {}),
      ...(check ? { check } : {}) };
    const items: ReviewPageStep[] = [];
    for (const outcome of plan?.steps ?? []) {
      const spec = plan!.plan?.steps?.find(step => step.id === outcome.id);
      const decisions = record.decisions(plan!.runId, outcome.id), judgements = record.judgements(plan!.runId, outcome.id);
      const answered = checked?.check?.steps?.find(entry => entry.id === outcome.id);
      const item: PlanStepItem = { runId: plan!.runId, stepId: outcome.id, ...(spec?.intent ? { intent: spec.intent } : {}),
        ...(answered ? { check: { ...(answered.reach ? { reach: answered.reach } : {}), ...(answered.requested ? { requested: answered.requested } : {}),
          needsApproval: answered.needsApproval === true, ...(answered.why ? { why: answered.why } : {}) } } : {}),
        ...(spec && plannedAction(spec) ? { action: plannedAction(spec)! } : outcome.action ? { action: outcome.action } : {}),
        result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}),
        decisions: decisions.map(d => ({ attempt: d.attempt, ...(d.recordedAt ? { at: d.recordedAt } : {}), ...(d.roundTripMs !== undefined ? { roundTripMs: d.roundTripMs } : {}),
          answers: d.answers ?? {}, ...(decisionWords(d.decision) ? { decision: decisionWords(d.decision)! } : {}) })),
        judgements: judgements.map(j => ({ attempt: j.attempt, ...(j.recordedAt ? { at: j.recordedAt } : {}), verdict: j.judgment?.verdict ?? "unknown",
          ...(j.judgment?.reason ? { reason: j.judgment.reason } : {}),
          requests: (j.judgment?.requests ?? []).map(r => ({ purpose: r.purpose, answers: r.answers ?? {}, ...(r.roundTripMs !== undefined ? { roundTripMs: r.roundTripMs } : {}) })),
          ...(j.approval ? { approval: j.approval } : {}) })) };
      const step: ReviewPageStep = { id: `plan-${plan!.runId}-${outcome.id}`, plan: item, cause: call.id, title: `${outcome.id}${item.action ? ` · ${item.action}` : ""}`,
        execution: stepExecution(outcome.result), state: "recorded", inputMode: "plan" };
      items.push(step, ...machineStepsOf(outcome.evidence, machine, step.id));
    }
    // The window after the plan, which the result shows the agent (design §5.4).
    const after = typeof returned.observationId === "string" ? record.observation(`${returned.observationId}.json`) : undefined;
    return [...items, ...machineStepsOf(after?.evidence, machine, call.id)];
  };

  const calls = new Map(session.calls.map(call => [call.step.id, call]));
  for (const step of session.steps) {
    const call = step.agent?.kind === "result" && step.agent.pair ? calls.get(step.agent.pair) : undefined;
    if (call) steps.push(...extend(call.step, call.arguments, step));
    steps.push(step);
  }
  // Every step's start, end and the time before it, by one rule (design §12.3, Time).
  timeline(steps, details);
  const items = new Set(steps.map(step => step.id));
  const shown = (r: Reason): Reason => ({ ...r, stepIds: r.stepIds.filter(id => items.has(id)) });
  const summaries: MachineSummary[] = machines.map(machine => {
    const found = joined.find(m => m.name === machine.name);
    return { name: machine.name, found: !!machine.data,
      ...(machine.data ? { completeness: machine.data.completeness, execution: machine.data.execution } : {}),
      steps: machine.data?.steps.length ?? 0, findings: machine.data?.findings.length ?? 0,
      ...(found ? { unasked: [...found.steps.values()].filter(step => !asked.has(step.id)).length } : {}) };
  });
  const sessionId = String(session.header?.id ?? basename(input.session));
  const data: ReviewData = {
    agent: { ...(input.agentId ? { id: input.agentId } : {}), sessionId, ...(session.model ? { model: `${session.model.provider}/${session.model.modelId}` } : {}),
      runs: session.steps.filter(step => step.agent?.kind === "prompt").length, machinesBy: names ? "lease" : "time", machines: summaries },
    packageId: input.agentId ?? sessionId,
    sessionId,
    taskId: machines.map(machine => machine.name).join(", "),
    completeness: worst(machines.map(machine => machine.data?.completeness ?? "missing"), "no machine"),
    execution: worst(machines.map(machine => machine.data?.execution ?? "missing"), "no machine"),
    findings: machines.flatMap(machine => machine.data?.findings ?? []),
    reasons: { snapshots: joined.flatMap(machine => machine.reasons.snapshots.map(shown)), execution: joined.flatMap(machine => machine.reasons.execution.map(shown)),
      defects: joined.flatMap(machine => machine.reasons.defects.map(shown)) },
    // The session's order, with each call's extension before its result (design §12.3, Order).
    steps,
    details,
    outputs: joined.flatMap(machine => machine.outputs),
    files: joined.flatMap(machine => machine.files),
  };
  return { data, images: session.images, packages: new Map(machines.map(machine => [machine.name, join(input.evidence, machine.name)])) };
}
