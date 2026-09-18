import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentRun } from "../records.ts";
import { sanitize } from "../ui/transcript.ts";
import { statusGlyph } from "../ui/glyphs.ts";
import { formatElapsed } from "../ui/usage-labels.ts";

export type InlineToolDisplay = "rich" | "summary";
export interface InlineRenderOptions {
  mode?: InlineToolDisplay;
  theme?: Theme;
  now?: () => number;
}

const component = (render: (width: number) => string[]): Component => ({ invalidate() {}, render });
const truncLine = (line: string, width: number) => width <= 0 ? "" : truncateToWidth(sanitize(line).replace(/\n/g, " "), width, "");

/** A bounded single-line task summary for inline display. */
export function taskLine(text: string, max = 120): string {
  const oneLine = sanitize(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function tokenStats(run: AgentRun, now: number): string {
  const parts: string[] = [];
  if (run.turnCount > 0) parts.push(`⟳ ${run.turnCount}`);
  if (run.toolCount > 0) parts.push(`${run.toolCount} tools`);
  const elapsed = formatElapsed(run.startedAt, now);
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

/** The live card for a running foreground call in rich mode. */
export function renderLiveAgentCall(run: AgentRun, name: string | undefined, options: InlineRenderOptions = {}): Component {
  const theme = options.theme;
  const now = options.now ?? Date.now;
  return component(width => {
    const glyph = statusGlyph(run.status, theme);
    const title = theme ? theme.fg("toolTitle", theme.bold(name ?? run.agentId)) : name ?? run.agentId;
    const stats = tokenStats(run, now());
    const lines = [
      `${glyph} ${title} · ${run.status}`,
      `  task: ${taskLine(run.description)}`,
      `  ⎿  ${run.activity ?? (run.status === "running" ? "thinking…" : run.status)}`,
      stats ? `  ${stats}` : `  ${run.status}`,
      `  expand for task details and result`,
    ];
    return lines.map(line => truncLine(line, width));
  });
}

/** Rich mode: status glyph, name, bounded task line, activity, live status, and expansion. */
export function renderAgentResultRich(result: { content: readonly { type: string; text?: string }[]; details?: AgentRun }, options: { expanded: boolean; isPartial: boolean }, inline: InlineRenderOptions = {}): Component {
  const theme = inline.theme;
  const run = result.details;
  const text = result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
  const lines = sanitize(text).split("\n");
  const truncated = run && (run.output.length >= 50000 || lines.length > (options.expanded ? 200 : 8));
  const artifact = run ? `\n[Display clipped; full output: ${run.outputPath}]` : "\n[Display clipped; inspect the recorded output path.]";
  return component(width => {
    if (run && !TERMINAL.has(run.status) && options.isPartial) {
      return renderLiveAgentCall(run, undefined, inline).render(width);
    }
    const limit = options.expanded ? 200 : 8;
    const header = run ? `${statusGlyph(run.status, theme)} ${taskLine(run.description)} · ${run.status}` : "";
    const body = `${options.isPartial ? "Progress (not a final outcome)\n" : ""}${lines.slice(0, limit).join("\n")}${lines.length > limit || truncated ? artifact : ""}`;
    return [header, ...body.split("\n")].filter(line => line !== "").slice(0, limit + 2).map(line => truncLine(line, width));
  });
}

/** Summary mode: one static result row per call; expansion is ignored. */
export function renderAgentResultSummary(result: { content: readonly { type: string; text?: string }[]; details?: AgentRun }, inline: InlineRenderOptions = {}): Component {
  const theme = inline.theme;
  const run = result.details;
  return component(width => {
    if (!run) {
      const text = result.content.filter(part => part.type === "text").map(part => part.text ?? "").join(" ");
      return [truncLine(`Agent result · ${taskLine(text, 80)}`, width)];
    }
    const glyph = statusGlyph(run.status, theme);
    const stats = tokenStats(run, run.endedAt ?? (inline.now ?? Date.now)());
    return [truncLine(`${glyph} ${taskLine(run.description)} · ${run.status}${stats ? ` · ${stats}` : ""} · output: ${run.outputPath}`, width)];
  });
}

export function renderAgentResult(result: { content: readonly { type: string; text?: string }[]; details?: AgentRun }, options: { expanded: boolean; isPartial: boolean }, inline: InlineRenderOptions = {}): Component {
  return (inline.mode ?? "rich") === "summary" ? renderAgentResultSummary(result, inline) : renderAgentResultRich(result, options, inline);
}

const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "partial", "failed", "cancelled", "interrupted"]);

export function renderCall(args: Record<string, unknown>): Component {
  const target = args.description ?? args.to ?? args.task_id ?? args.shell_id ?? "agent operation";
  return component(width => [truncLine(`${args.subagent_type ?? "Agent"} · ${String(target)}${"run_in_background" in args ? args.run_in_background ? " · background" : " · foreground" : ""}`, width)].slice(0, 2));
}

/** Legacy entry point retained for the acceptance binding; renders the bounded result text. */
export function renderResult(result: { content: readonly { type: string; text?: string }[] }, options: { expanded: boolean; isPartial: boolean }): Component {
  const text = result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
  const lines = sanitize(text).split("\n");
  const limit = options.expanded ? 200 : 8;
  return component(width => `${options.isPartial ? "Progress (not a final outcome)\n" : ""}${lines.slice(0, limit).join("\n")}${lines.length > limit ? "\n[Display clipped; expand or inspect the recorded output path.]" : ""}`.split("\n").map(line => truncLine(line, width)));
}
