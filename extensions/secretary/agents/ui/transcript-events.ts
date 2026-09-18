import type { GuidanceRecord } from "../records.ts";

/** Structured inspector transcript events (architecture §12.6.2). All text is untrusted session data. */
export type TranscriptEvent =
  | { kind: "assistant"; entryId?: string; text: string; timestamp?: number }
  | { kind: "user"; entryId?: string; text: string; timestamp?: number }
  | { kind: "tool"; entryId?: string; name: string; status: "running" | "complete" | "error";
      argsPreview?: string; output?: string; truncated?: boolean }
  | { kind: "notice"; entryId?: string; tone: "muted" | "warning" | "error"; text: string; timestamp?: number };

export interface TranscriptParseOptions {
  /** Maximum persisted lines consumed from the tail; earlier lines are omitted with a marker. */
  maxLines?: number;
  /** Maximum bytes of JSONL consumed from the tail. */
  maxBytes?: number;
  /** Maximum characters retained for one message, argument, or output field. */
  maxFieldChars?: number;
}
export interface ParsedTranscript { events: TranscriptEvent[]; truncated: boolean; malformed: number }

const DEFAULT_MAX_LINES = 240;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FIELD_CHARS = 64 * 1024;
const ENTRY_ID = /^[A-Za-z0-9_-]+$/;

function clampText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[Truncated in this bounded view]`;
}
function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); if (!Number.isNaN(parsed)) return parsed; }
  return undefined;
}
function entryIdOf(row: Record<string, unknown>, index: number): string {
  const id = row.id;
  return typeof id === "string" && ENTRY_ID.test(id) ? id : `line-${index}`;
}

type MutableTool = Extract<TranscriptEvent, { kind: "tool" }> & { callId?: string; resultSeen?: boolean };

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text")
    .map(block => String((block as { text?: unknown }).text ?? "")).join("\n");
}
function fenced(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  const size = Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1));
  return `${"`".repeat(size)}\n${text}\n${"`".repeat(size)}`;
}
/** Guidance delivery records render as notices; a notice never claims model compliance. */
export function guidanceNotice(record: GuidanceRecord, max = DEFAULT_MAX_FIELD_CHARS): TranscriptEvent {
  const tone = record.state === "undelivered" || record.state === "uncertain" ? "warning" as const : "muted" as const;
  const disposition = record.state === "transport-accepted"
    ? "Guidance accepted for transport; consumption has not been established."
    : record.state === "pending"
      ? "Guidance is queued for delivery."
      : record.state === "undelivered"
        ? "Guidance was not delivered before the run settled."
        : record.state === "uncertain"
          ? "Guidance delivery is uncertain."
          : "Guidance was consumed.";
  return { kind: "notice", entryId: `guidance-${record.id}`, tone,
    text: clampText(`${disposition}\n${record.reason ? `Reason: ${record.reason}\n` : ""}> ${record.text.replace(/\n/g, "\n> ")}`, max) };
}

/** Parse persisted pi session JSONL into typed events, pairing tool calls with their results. */
export function parseTranscriptEvents(jsonl: string, options: TranscriptParseOptions = {}): ParsedTranscript {
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
  const maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxField = Math.max(1, options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS);
  const bytes = Buffer.byteLength(jsonl, "utf8");
  const overBytes = bytes > maxBytes;
  let source = overBytes ? Buffer.from(jsonl, "utf8").subarray(bytes - maxBytes).toString("utf8") : jsonl;
  if (overBytes) { const first = source.indexOf("\n"); source = first >= 0 ? source.slice(first + 1) : source; }
  let lines = source.split("\n");
  // A partial trailing line from concurrent writing is ignored rather than rendered.
  if (source.length > 0 && !source.endsWith("\n")) {
    const tail = lines[lines.length - 1]!;
    try { JSON.parse(tail); } catch { lines = lines.slice(0, -1); }
  }
  const overLines = lines.length > maxLines;
  if (overLines) lines = lines.slice(-maxLines);
  const truncated = overBytes || overLines;
  const events: TranscriptEvent[] = [];
  let malformed = 0;
  if (truncated) events.push({ kind: "notice", entryId: "transcript-truncation", tone: "muted", text: "Earlier transcript content is outside this bounded view." });

  const findTool = (toolCallId: string | undefined, name: string): MutableTool | undefined => {
    if (toolCallId) for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i] as MutableTool;
      if (event?.kind === "tool" && event.callId === toolCallId) return event;
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i] as MutableTool;
      if (event?.kind === "tool" && !event.resultSeen && (!name || event.name === name)) return event;
    }
    return undefined;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (!row || typeof row !== "object" || Array.isArray(row)) { malformed++; continue; }
    const entryId = entryIdOf(row, index);
    const ts = timestamp(row.timestamp) ?? timestamp(row.ts);
    if (row.type === "message") {
      const message = row.message as Record<string, unknown> | undefined;
      if (!message || typeof message !== "object") continue;
      const role = typeof message.role === "string" ? message.role : "notification";
      const content = message.content;
      if (role === "toolResult") {
        const name = typeof message.toolName === "string" ? message.toolName : "tool";
        const failed = message.isError === true;
        const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
        let tool = findTool(toolCallId, name);
        if (!tool) { tool = { kind: "tool", entryId, name, status: "running", callId: toolCallId } as MutableTool; events.push(tool); }
        if (!tool.resultSeen) {
          tool.resultSeen = true;
          tool.status = failed ? "error" : "complete";
          const output = textOf(content).trim();
          if (output) { tool.output = clampText(output, maxField); tool.truncated = output.length > maxField; }
        }
        continue;
      }
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content as Record<string, unknown>[] : [];
      for (const block of blocks) {
        if (block.type === "text") {
          const text = String(block.text ?? "").trim();
          if (!text) continue;
          if (role === "assistant") events.push({ kind: "assistant", entryId, text: clampText(text, maxField), ...(ts !== undefined ? { timestamp: ts } : {}) });
          else if (role === "user") events.push({ kind: "user", entryId, text: clampText(text, maxField), ...(ts !== undefined ? { timestamp: ts } : {}) });
          else events.push({ kind: "notice", entryId, tone: "muted", text: clampText(`${role}: ${text}`, maxField), ...(ts !== undefined ? { timestamp: ts } : {}) });
        } else if (block.type === "toolCall") {
          const name = typeof block.name === "string" ? block.name : "tool";
          const tool: MutableTool = { kind: "tool", entryId, name, status: "running", argsPreview: clampText(fenced(block.arguments), maxField) };
          if (typeof block.id === "string" && block.id) tool.callId = block.id;
          events.push(tool);
        } else if (block.type === "image") {
          events.push({ kind: "notice", entryId, tone: "muted", text: "[Image attachment]" });
        }
        // Hidden reasoning blocks are never exposed.
      }
      continue;
    }
    if (row.type === "custom_message") {
      const text = textOf(row.content).trim();
      if (text) events.push({ kind: "notice", entryId, tone: "muted", text: clampText(`Extension message (${typeof row.customType === "string" ? row.customType : "custom"}): ${text}`, maxField), ...(ts !== undefined ? { timestamp: ts } : {}) });
      continue;
    }
  }
  for (const event of events) if (event.kind === "tool") { const tool = event as MutableTool; delete tool.resultSeen; delete tool.callId; }
  return { events, truncated, malformed };
}
