import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import type { InlineAgentDetails } from "./presentation.ts";
import { sanitize } from "../ui/transcript.ts";
import { statusGlyph } from "../ui/glyphs.ts";
import { formatElapsed } from "../ui/usage-labels.ts";

export const EXPANDED_FIELD_LINES = 200;
export interface InlineRenderOptions {
  theme?: Theme;
  now?: () => number;
  args?: Record<string, unknown>;
  isError?: boolean;
}
export interface InlineResult {
  content: readonly { type: string; text?: string }[];
  details?: InlineAgentDetails;
}
export interface InlineRowState { inlineResult?: InlineResult; inlineIdentity?: InlineAgentDetails }
const component = (render: (width: number) => string[]): Component => ({ invalidate() {}, render });
const oneLine = (text: string) => sanitize(text).replace(/\s+/g, " ").trim();
// A terminal narrower than a single wide glyph cannot display that glyph. The
// visible ellipsis is an explicit fallback rather than an over-width cell.
const wrapped = (text: string, width: number): string[] => width <= 0 ? [] : wrapTextWithAnsi(text, width).map(line => truncateToWidth(line, width, "…"));
const wrap = (text: string, width: number): string[] => width <= 0 ? [] : sanitize(text).split("\n").flatMap(line => wrapped(line, width));
const clipped = (text: string, width: number) => width <= 0 ? "" : truncateToWidth(oneLine(text), width, "…");
const textOf = (result: InlineResult) => result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled", "interrupted"]);

export function taskLine(text: string, max = 120): string {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function stats(run: InlineAgentDetails, now: number): string {
  const parts: string[] = [];
  if (run.turnCount > 0) parts.push(`⟳ ${run.turnCount}`);
  if (run.toolCount > 0) parts.push(`${run.toolCount} tools`);
  const elapsed = formatElapsed(run.startedAt, run.endedAt ?? now);
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

/** Count wrapped content rows, not source lines; section labels and notices are outside the allowance. */
export function renderField(text: string, width: number, path?: string, label = "content", knownClipped = false): string[] {
  if (width <= 0) return [];
  const rows: string[] = [];
  let clippedContent = knownClipped;
  outer: for (const line of sanitize(text).split("\n")) {
    for (const row of wrapped(line, width)) {
      if (rows.length === EXPANDED_FIELD_LINES) { clippedContent = true; break outer; }
      rows.push(row);
    }
  }
  if (clippedContent) rows.push(...wrap(path
    ? `[Display clipped; full ${label}: ${path}]`
    : `[Display clipped; full ${label} artifact unavailable.]`, width));
  return rows;
}

/** The component reads row state at paint time, after both host rendering hooks have run. */
export function renderToolCall(name: "Agent" | "SendMessage", args: Record<string, unknown>, theme: Theme | undefined,
  context: { state: InlineRowState }): Component {
  return component(width => {
    const result = context.state.inlineResult;
    const run = result?.details ?? context.state.inlineIdentity;
    const p = run?.presentation;
    const type = p?.agentType ?? (name === "Agent" ? String(args.subagent_type ?? "general-purpose") : "type unavailable");
    const instance = p?.name ?? run?.agentId ?? String(args.name ?? args.to ?? "name pending");
    let title = `${name} · ${oneLine(type)} · ${oneLine(instance)}`;
    if (name === "Agent") {
      title += ` · ${oneLine(p?.model ?? (run ? "model unavailable" : "model pending"))}`;
      if (run?.background ?? args.run_in_background === true) title += " · background";
    }
    return wrap(title, width).map(line => theme ? theme.fg("toolTitle", theme.bold(line)) : line);
  });
}

/** Only the body is returned; the registered call hook owns the destination header. */
export function renderAgentResult(result: InlineResult, options: { expanded: boolean; isPartial: boolean }, inline: InlineRenderOptions = {}): Component {
  return component(width => {
    if (width <= 0) return [];
    const run = result.details;
    if (!run || inline.isError) {
      const text = textOf(result);
      return options.expanded ? renderField(text, width, undefined, "error") : [clipped(`Error: ${text}`, width)];
    }
    const p = run.presentation;
    const status = `${statusGlyph(run.status, inline.theme)} ${run.status}`;
    if (!options.expanded) {
      if (run.background && !["failed", "cancelled", "interrupted", "partial"].includes(run.status)) return [];
      if (!TERMINAL.has(run.status) && options.isPartial) {
        const activity = oneLine(run.activity ?? (run.status === "running" ? "thinking…" : run.status));
        const statistics = stats(run, (inline.now ?? Date.now)());
        return [status, `  ⎿  ${activity}`, ...(statistics ? [`  ${statistics}`] : []),
          `  ${keyHint("app.tools.expand", "expand for task details and result")}`]
          .map(line => truncateToWidth(line, width, "…"));
      }
      const statistics = run.turnCount > 0 || run.toolCount > 0 ? stats(run, (inline.now ?? Date.now)()) : "";
      const rows = wrapped(`${status}${statistics ? ` · ${statistics}` : ""}`, width);
      if (run.error) rows.push(clipped(`Error: ${run.error}`, width));
      return rows;
    }
    const rows = [status, ...wrap([
      `Agent ID: ${run.agentId}`, `Run: ${run.runId}`, `Working directory: ${p?.cwd ?? "unavailable"}`,
      ...(p?.workspaceLines ?? ["Isolation: unavailable (historical result)."]),
      `Output: ${run.outputPath}`, `Partial: ${run.status !== "succeeded"}`,
    ].join("\n"), width)];
    if (run.error) rows.push(...wrap("Error:", width), ...renderField(run.error, width, undefined, "error"));
    if (p?.artifactError) rows.push(...wrap(`Input artifact unavailable: ${p.artifactError}`, width));
    rows.push(...wrap("Prompt:", width), ...renderField(String(inline.args?.prompt ?? run.prompt), width, p?.promptPath, "prompt"));
    rows.push(...wrap("Result:", width), ...renderField(run.output, width, run.outputPath, "output", run.output.length >= 50000));
    return rows.flatMap(line => wrapped(line, width));
  });
}

export function renderMessageResult(result: InlineResult, options: { expanded: boolean; isPartial: boolean }, inline: InlineRenderOptions = {}): Component {
  return component(width => {
    if (width <= 0) return [];
    const run = result.details, p = run?.presentation;
    const message = typeof inline.args?.message === "string" ? inline.args.message : "Message unavailable in historical call.";
    const error = inline.isError || !run;
    if (!options.expanded) return [clipped(`Message: ${message}`, width),
      ...(error ? [clipped(`Error: ${textOf(result)}`, width)] : [])];
    const rows = [...wrap("Message:", width), ...renderField(message, width, p?.messagePath, "message")];
    if (run) rows.push(...wrap(`Run: ${run.runId}`, width));
    if (p?.artifactError) rows.push(...wrap(`Input artifact unavailable: ${p.artifactError}`, width));
    if (error) rows.push(...wrap("Error:", width), ...renderField(textOf(result), width, undefined, "error"));
    else rows.push(...wrap(p?.acknowledgment ?? "Acknowledgment unavailable in historical result.", width));
    return rows;
  });
}

/** Legacy helper retained for callers outside registered Agent/SendMessage rendering. */
export function renderCall(args: Record<string, unknown>): Component {
  return component(width => width <= 0 ? [] : [clipped(`${args.subagent_type ?? "Agent"} · ${args.description ?? args.to ?? args.task_id ?? "agent operation"}`, width)]);
}
/** Legacy generic acceptance adapter, not the Agent/SendMessage renderer. */
export function renderResult(result: InlineResult, options: { expanded: boolean; isPartial: boolean }): Component {
  const lines = sanitize(textOf(result)).split("\n"), limit = options.expanded ? 200 : 8;
  return component(width => width <= 0 ? [] : [
    ...(options.isPartial ? ["Progress (not a final outcome)"] : []), ...lines.slice(0, limit),
    ...(lines.length > limit ? ["[Display clipped; expand or inspect the recorded output path.]"] : []),
  ].map(line => truncateToWidth(line, width, "")));
}
