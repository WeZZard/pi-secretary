import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { entryId } from "../transcript-format.ts";
import type { TranscriptView } from "./state.ts";
export function sanitize(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P_^X][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
}
export const clip = (text: string, width: number) => width <= 0 ? "" : truncateToWidth(sanitize(text).replace(/\n/g, " "), width, "");
export function captureAnchor(t: TranscriptView, anchor: number): Pick<TranscriptView, "anchor" | "anchorEntryId" | "anchorOffset"> {
  const lines = t.text.split("\n");
  for (let i = Math.min(anchor, lines.length - 1); i >= 0; i--) {
    const id = entryId(lines[i]);
    if (id) return { anchor, anchorEntryId: id, anchorOffset: anchor - i };
  }
  return { anchor, anchorEntryId: undefined, anchorOffset: undefined };
}
export function restoreTranscript(previous: TranscriptView | undefined, text: string): TranscriptView {
  const next: TranscriptView = { follow: "following", anchor: 0, expanded: false, ...previous, text };
  if (next.follow === "paused" && next.anchorEntryId) {
    const index = text.split("\n").findIndex(line => entryId(line) === next.anchorEntryId);
    if (index >= 0) next.anchor = index + (next.anchorOffset ?? 0);
    else { next.anchor = 0; next.anchorEntryId = undefined; next.text = "Earlier reading anchor is unavailable in this bounded view.\n\n" + text; }
  }
  return next;
}
export function transcriptWindow(t: TranscriptView, width: number, height: number): string[] {
  if (width <= 0 || height <= 0) return [];
  const source = sanitize(t.text).split("\n");
  const start = t.follow === "following" ? 0 : Math.min(t.anchor, Math.max(0, source.length - 1));
  const lines = source.slice(start).filter(line => !entryId(line));
  let text = lines.join("\n");
  if (!t.expanded) text = text.replace(/(^#{2,3} Tool (?:call|result):[^\n]*\n)[\s\S]*?(?=^## |$(?![\s\S]))/gm, "$1[Tool details collapsed]\n");
  let rendered: string[];
  try { rendered = new Markdown(text, 0, 0, getMarkdownTheme()).render(width); }
  catch { rendered = text.split("\n").map(line => clip(line, width)); }
  return (t.follow === "following" ? rendered.slice(-height) : rendered.slice(0, height)).map(line => truncateToWidth(line.trimEnd(), width, ""));
}
