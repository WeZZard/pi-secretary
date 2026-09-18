import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface TranscriptEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  cwd?: string;
  version?: number;
  message?: {
    role: string;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    stopReason?: string;
    errorMessage?: string;
    details?: Record<string, unknown>;
    content: string | Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
  };
}
export function readTranscript(path: string): TranscriptEntry[] {
  const rows = readFileSync(path, "utf8").trim().split("\n").map((line, index) => {
    try { return JSON.parse(line) as TranscriptEntry; }
    catch { throw new Error(`Invalid persisted JSONL at ${path}:${index + 1}`); }
  });
  if (rows[0]?.type !== "session" || !rows[0]?.id) throw new Error(`Missing persisted session header: ${path}`);
  return rows;
}
export function sessionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sessionFiles(join(directory, entry.name)) : entry.name.endsWith(".jsonl") ? [join(directory, entry.name)] : []);
}
export function messageText(message: NonNullable<TranscriptEntry["message"]>): string {
  return typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}
