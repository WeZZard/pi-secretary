import { Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_INSPECTOR_KEYBINDINGS, bindingLabel } from "./keybindings.ts";
import type { TranscriptEvent } from "./transcript-events.ts";
import type { TranscriptView } from "./state.ts";

/** The expansion hint names the resolved key, so it can never advertise the stop shortcut. */
const DEFAULT_EXPAND_KEY = bindingLabel(DEFAULT_INSPECTOR_KEYBINDINGS, "toggleTools", { firstOnly: true });

export function sanitize(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P_^X][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
}
export const clip = (text: string, width: number) => width <= 0 ? "" : truncateToWidth(sanitize(text).replace(/\n/g, " "), width, "");

const TOOL_PREVIEW_LINES = 7;

function bounded(text: string, width: number): string {
  return truncateToWidth(sanitize(text).replace(/\t/g, "    "), Math.max(0, width), "");
}
function wrapped(text: string, width: number): string[] {
  return wrapTextWithAnsi(sanitize(text), Math.max(1, width));
}
function toolGlyph(status: "running" | "complete" | "error", theme?: Theme): string {
  const glyph = status === "running" ? "●" : status === "error" ? "✗" : "✓";
  if (!theme) return glyph;
  return status === "running" ? theme.fg("warning", glyph) : status === "error" ? theme.fg("error", glyph) : theme.fg("success", glyph);
}
export const statusGlyph = toolGlyph;

/** Render one structured event to themed, width-bounded lines. Text is untrusted; sanitize before theming. */
export function renderEvent(event: TranscriptEvent, width: number, options: { expanded?: boolean; theme?: Theme; expandKey?: string } = {}): string[] {
  if (width <= 0) return [];
  const theme = options.theme;
  const expandKey = options.expandKey ?? DEFAULT_EXPAND_KEY;
  const rail = (content: string) => bounded(`${theme ? theme.fg("borderMuted", "│") : "│"} ${content}`, width);
  const lines: string[] = [];
  if (event.kind === "tool") {
    const glyph = toolGlyph(event.status, theme);
    const title = theme ? theme.fg("toolTitle", theme.bold(sanitize(event.name))) : sanitize(event.name);
    const suffix = event.status === "running" ? (theme ? theme.fg("warning", " running") : " running") : "";
    if (options.expanded && (event.argsPreview || event.output)) {
      lines.push(rail(`${glyph} ${title}${suffix}`));
      if (event.argsPreview) for (const line of event.argsPreview.split("\n")) for (const row of wrapped(line, Math.max(1, width - 4))) lines.push(rail(`  ${row}`));
      if (event.output) {
        lines.push(rail(theme ? theme.fg("dim", event.status === "error" ? "  error" : "  output") : event.status === "error" ? "  error" : "  output"));
        for (const line of event.output.replace(/\s+$/, "").split("\n")) for (const row of wrapped(line, Math.max(1, width - 4))) lines.push(rail(`  ${row}`));
      }
      if (event.truncated) lines.push(rail(theme ? theme.fg("dim", "  [Output truncated; read the recorded artifact for full output.]") : "  [Output truncated; read the recorded artifact for full output.]"));
      return lines;
    }
    lines.push(bounded(`${theme ? theme.fg("borderMuted", "├─") : "├─"} ${glyph} ${title}${suffix}`, width));
    if (event.output && event.status !== "error") {
      const outputLines = event.output.replace(/\s+$/, "").split("\n");
      const visible = outputLines.slice(-TOOL_PREVIEW_LINES);
      const hidden = outputLines.length - visible.length;
      for (const line of visible) for (const row of wrapped(line, Math.max(1, width - 4))) lines.push(rail(`  ${theme ? theme.fg("toolOutput", row) : row}`));
      if (hidden > 0) lines.push(rail(theme ? theme.fg("dim", `  … ${hidden} earlier lines · ${expandKey} to expand`) : `  … ${hidden} earlier lines · ${expandKey} to expand`));
      else if (event.output) lines.push(rail(theme ? theme.fg("dim", `  ${expandKey} to expand`) : `  ${expandKey} to expand`));
    }
    if (event.status === "error" && event.output) {
      const first = event.output.split("\n").find(line => line.trim()) ?? event.output;
      lines.push(rail(theme ? theme.fg("error", `  ${first}`) : `  ${first}`));
    }
    return lines;
  }
  if (event.kind === "notice") {
    const color = event.tone === "error" ? "error" : event.tone === "warning" ? "warning" : "dim";
    for (const line of event.text.split("\n")) for (const row of wrapped(line, Math.max(1, width - 2))) lines.push(rail(theme ? theme.fg(color, row) : row));
    return lines;
  }
  const assistant = event.kind === "assistant";
  const marker = assistant ? (theme ? theme.fg("accent", "◆") : "◆") : (theme ? theme.fg("warning", "◇") : "◇");
  const label = assistant ? "Assistant" : "Supervisor";
  lines.push(bounded(`${marker} ${theme ? theme.bold(label) : label}`, width));
  if (assistant) {
    let rendered: string[];
    try { rendered = new Markdown(sanitize(event.text), 0, 0, getMarkdownTheme()).render(Math.max(1, width - 2)); }
    catch { rendered = wrapped(event.text, Math.max(1, width - 2)); }
    for (const line of rendered) lines.push(rail(line));
  } else {
    for (const line of event.text.split("\n")) for (const row of wrapped(line, Math.max(1, width - 2))) lines.push(rail(row));
  }
  return lines;
}

/** Logical (unwrapped) line counts per event; the reducer scrolls in this width-independent space. */
export function logicalLines(event: TranscriptEvent): number {
  const text = event.kind === "tool" ? (event.output ?? event.argsPreview ?? "") : event.text;
  return 1 + Math.max(1, text.split("\n").length);
}
function logicalStarts(events: readonly TranscriptEvent[]): number[] {
  const starts: number[] = [];
  let total = 0;
  for (const event of events) { starts.push(total); total += logicalLines(event); }
  return starts;
}
export function transcriptLineCount(events: readonly TranscriptEvent[]): number {
  return events.reduce((total, event) => total + logicalLines(event), 0);
}

/**
 * Render a windowed transcript view. The anchor is a logical-line index recovered by entry id and offset.
 *
 * Only events intersecting the viewport are rendered. Rendering the whole transcript to display one
 * screen costs O(transcript length) per paint while the visible output is bounded by `height`, which
 * makes wheel scrolling unusable on long transcripts (§12.1.3). The anchor reconciliation is unchanged:
 * the offset is clamped against the rendered display lines of the anchor event, because a logical line
 * may wrap into several display lines.
 */
export function transcriptWindow(t: TranscriptView, width: number, height: number, theme?: Theme, expandKey?: string): string[] {
  if (width <= 0 || height <= 0 || !t.events.length) return [];
  const events = t.events;
  const paint = (event: TranscriptEvent) => renderEvent(event, width, { expanded: t.expanded, theme, ...(expandKey === undefined ? {} : { expandKey }) });
  const clip = (lines: readonly string[]) => lines.map(line => truncateToWidth(line.trimEnd(), width, ""));
  // Following: walk backwards from the tail only as far as the viewport reaches.
  if (t.follow === "following") {
    const blocks: string[][] = [];
    let total = 0;
    for (let index = events.length - 1; index >= 0 && total < height; index--) {
      const lines = paint(events[index]!);
      blocks.unshift(lines);
      total += lines.length;
    }
    return clip(blocks.flat().slice(-height));
  }
  // Paused: locate the anchor event, then render forward until the viewport is filled.
  const starts = logicalStarts(events);
  let eventIndex = starts.findIndex((start, i) => anchorIn(t.anchor, start, starts[i + 1] ?? Infinity));
  if (eventIndex < 0) eventIndex = Math.max(0, events.length - 1);
  const first = paint(events[eventIndex]!);
  const offset = Math.min(Math.max(0, t.anchor - starts[eventIndex]!), Math.max(0, first.length - 1));
  const lines = first.slice(offset);
  for (let index = eventIndex + 1; index < events.length && lines.length < height; index++) lines.push(...paint(events[index]!));
  return clip(lines.slice(0, height));
}
function anchorIn(anchor: number, start: number, end: number): boolean { return anchor >= start && anchor < end; }

/** Capture a stable anchor: the event containing the requested logical line, with its relative offset. */
export function captureAnchor(t: TranscriptView, anchor: number): Pick<TranscriptView, "anchor" | "anchorEntryId" | "anchorOffset"> {
  if (!t.events.length) return { anchor: 0, anchorEntryId: undefined, anchorOffset: undefined };
  const starts = logicalStarts(t.events);
  const clamped = Math.max(0, Math.min(anchor, transcriptLineCount(t.events) - 1));
  let index = starts.findIndex((start, i) => anchorIn(clamped, start, starts[i + 1] ?? Infinity));
  if (index < 0) index = t.events.length - 1;
  return { anchor: clamped, anchorEntryId: t.events[index]!.entryId, anchorOffset: clamped - starts[index]! };
}

/** Restore a transcript across reloads, recovering the paused reading anchor by stable entry id. */
export function restoreTranscript(previous: TranscriptView | undefined, events: readonly TranscriptEvent[]): TranscriptView {
  const next: TranscriptView = { follow: "following", anchor: 0, expanded: false, ...previous, events };
  if (next.follow === "paused" && next.anchorEntryId) {
    const index = events.findIndex(event => event.entryId === next.anchorEntryId);
    if (index >= 0) next.anchor = logicalStarts(events)[index]! + (next.anchorOffset ?? 0);
    else {
      // Missing anchors fall back with an explicit indication; never a fabricated position (§12.4).
      const notice: TranscriptEvent = { kind: "notice", entryId: "anchor-unavailable", tone: "warning", text: "Earlier reading anchor is unavailable in this bounded view." };
      next.events = [notice, ...events]; next.anchor = 0; next.anchorEntryId = undefined;
    }
  }
  return next;
}
