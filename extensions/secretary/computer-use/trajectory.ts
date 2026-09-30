import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { reviewData, type ReviewData as MachineData } from "@wezzard/mcp-vm-relay/review-data";
import type { MachineSummary, Reason, ReviewData, ReviewPageStep, StepDetail } from "./viewer/page.ts";

/**
 * The trajectory of one computer-use agent (decisions PS-D17 and PS-D18, design §12.3): the model
 * of the viewer app, joining the agent's session with the review data of each machine it used.
 * The relay interprets its own packages (`reviewData`); this joins them to the agent's prompts,
 * messages, tool calls and results by time. It only reads.
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
  /** Package names from the session's lease records; without them, packages are chosen by time. */
  packages?: string[];
  agentId?: string;
  /** How a machine's package is read; the relay's own derivation unless given. */
  review?: (dir: string) => Promise<MachineData>;
}

const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };
const readLines = (path: string): Record<string, unknown>[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } }) : [];
const time = (at: string | undefined) => at ? Date.parse(at) : NaN;
const PACKAGE = /^relay-computer-use-[0-9a-f]+$/;
/** A verdict's severity, as the page's tones order them. */
const severity = (value: string | undefined) => ["passed", "complete", "completed"].includes(value ?? "") ? 0 : ["failed", "refused"].includes(value ?? "") ? 2 : 1;
const worst = (values: (string | undefined)[], none: string) => values.reduce<string | undefined>((all, value) => all === undefined || severity(value) > severity(all) ? value : all, undefined) ?? none;

interface SessionPart { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string }
interface SessionMessage { role: string; content: string | SessionPart[]; toolCallId?: string; isError?: boolean }

/** The package names in a session's lease records under its computer-use state directory, in acquisition order (design §12.3). */
export function leasedPackages(state: string): string[] | undefined {
  const directory = join(state, "leases");
  if (!existsSync(directory)) return undefined;
  const leases = readdirSync(directory).filter(file => file.endsWith(".json"))
    .flatMap(file => { const lease = readJson<{ package?: string; recordedAt?: string }>(join(directory, file)); return lease?.package ? [lease] : []; })
    .sort((a, b) => (time(a.recordedAt) || 0) - (time(b.recordedAt) || 0));
  return leases.length ? leases.map(lease => lease.package!) : undefined;
}

const firstAt = (data: MachineData) => Math.min(...Object.values(data.details).map(detail => time(detail.at)).filter(Number.isFinite));

/** The session's prompts, messages, calls and results as steps, with the pictures the agent received. */
function sessionSteps(session: string) {
  const lines = readLines(session);
  const header = lines.find(line => line.type === "session");
  const model = lines.filter(line => line.type === "model_change").at(-1);
  const messages = lines.filter(line => line.type === "message") as { timestamp: string; message: SessionMessage }[];
  const steps: ReviewPageStep[] = [], details: Record<string, StepDetail> = {}, images: SessionImage[] = [];
  const calls = new Map<string, ReviewPageStep>();
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
        if (part.type === "toolCall" && part.id) calls.set(part.id, add(timestamp, { kind: "call", name: part.name ?? "?", text: JSON.stringify(part.arguments ?? {}, null, 2) }));
      }
    } else if (message.role === "toolResult") {
      const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      const picture = parts.find(part => part.type === "image" && part.data);
      const image = picture ? { path: `.session/${images.length + 1}.${picture.mimeType === "image/jpeg" ? "jpg" : "png"}`, mimeType: picture.mimeType ?? "image/png", data: picture.data! } : undefined;
      if (image) images.push(image);
      const result = add(timestamp, { kind: "result", name: call?.agent?.name ?? "?", text, ...(image ? { image: image.path } : {}), ...(call ? { pair: call.id } : {}) },
        message.isError ? "failed" : "completed");
      if (call?.agent) { call.agent.pair = result.id; call.agent.endAt = timestamp; }
    }
  }
  return { header, model, steps, details, images, calls: [...calls.values()],
    first: messages[0]?.timestamp ?? String(header?.timestamp ?? ""), last: messages.at(-1)?.timestamp ?? String(header?.timestamp ?? "") };
}

/** A machine's review data with its step identifiers and file paths prefixed by its package, since two machines share step names. */
function machineSteps(name: string, data: MachineData) {
  const short = name.replace(/^relay-computer-use-/, "");
  const id = (step: string) => `${short}-${step}`;
  const reason = (r: Reason): Reason => ({ ...r, stepIds: r.stepIds.map(id) });
  return {
    steps: data.steps.map(step => ({ ...step, id: id(step.id), machine: { name, id: step.id },
      ...(step.snapshots ? { snapshots: { ...step.snapshots, ...(step.snapshots.before ? { before: `${name}/${step.snapshots.before}` } : {}), ...(step.snapshots.after ? { after: `${name}/${step.snapshots.after}` } : {}) } } : {}) })),
    details: Object.fromEntries(Object.entries(data.details).map(([step, detail]) => [id(step), detail])),
    reasons: { snapshots: data.reasons.snapshots.map(reason), execution: data.reasons.execution.map(reason), defects: (data.reasons.defects ?? []).map(reason) },
    outputs: data.outputs.map(output => ({ ...output, path: `${name}/${output.path}` })),
    files: data.files.map(file => ({ ...file, path: `${name}/${file.path}` })),
  };
}

export async function buildTrajectory(input: TrajectoryInput): Promise<AgentTrajectory> {
  const session = sessionSteps(input.session);
  const derive = input.review ?? reviewData;
  const review = async (name: string) => { try { return await derive(join(input.evidence, name)); } catch { return undefined; } };
  let machines: { name: string; data?: MachineData }[];
  if (input.packages) machines = await Promise.all(input.packages.map(async name => ({ name, data: await review(name) })));
  else {
    // Without a lease record: a machine is acquired during the agent's first computer call, so its
    // first step starts inside the session. Its checks come after the last message and are kept.
    const names = existsSync(input.evidence) ? readdirSync(input.evidence).filter(name => PACKAGE.test(name)) : [];
    const all = await Promise.all(names.map(async name => ({ name, data: await review(name) })));
    machines = all.filter(machine => machine.data && firstAt(machine.data) >= time(session.first) && firstAt(machine.data) <= time(session.last))
      .sort((a, b) => firstAt(a.data!) - firstAt(b.data!));
  }
  const joined = machines.flatMap(machine => machine.data ? [machineSteps(machine.name, machine.data)] : []);
  const details: Record<string, StepDetail> = Object.assign({}, session.details, ...joined.map(machine => machine.details));
  // A machine step belongs to the tool call whose call and result enclose its start (design §12.3, Join).
  const machineStepList = joined.flatMap(machine => machine.steps).map(step => {
    const at = time(details[step.id]?.at);
    const call = session.calls.find(call => at >= time(details[call.id]?.at) && at <= time(call.agent?.endAt ?? session.last));
    return call ? { ...step, cause: call.id } : step;
  });
  const summaries: MachineSummary[] = machines.map(machine => ({ name: machine.name, found: !!machine.data,
    ...(machine.data ? { completeness: machine.data.completeness, execution: machine.data.execution } : {}),
    steps: machine.data?.steps.length ?? 0, findings: machine.data?.findings.length ?? 0 }));
  const sessionId = String(session.header?.id ?? basename(input.session));
  const data: ReviewData = {
    agent: { ...(input.agentId ? { id: input.agentId } : {}), sessionId, ...(session.model ? { model: `${session.model.provider}/${session.model.modelId}` } : {}),
      runs: session.steps.filter(step => step.agent?.kind === "prompt").length, machinesBy: input.packages ? "lease" : "time", machines: summaries },
    packageId: input.agentId ?? sessionId,
    sessionId,
    taskId: machines.map(machine => machine.name).join(", "),
    completeness: worst(machines.map(machine => machine.data?.completeness ?? "missing"), "no machine"),
    execution: worst(machines.map(machine => machine.data?.execution ?? "missing"), "no machine"),
    findings: machines.flatMap(machine => machine.data?.findings ?? []),
    reasons: { snapshots: joined.flatMap(machine => machine.reasons.snapshots), execution: joined.flatMap(machine => machine.reasons.execution), defects: joined.flatMap(machine => machine.reasons.defects) },
    // The agent's steps come first, so a step that shares its time with a machine step keeps the session's order.
    steps: [...session.steps, ...machineStepList],
    details,
    outputs: joined.flatMap(machine => machine.outputs),
    files: joined.flatMap(machine => machine.files),
  };
  return { data, images: session.images, packages: new Map(machines.map(machine => [machine.name, join(input.evidence, machine.name)])) };
}
