const marker = /^<!-- secretary-entry:([A-Za-z0-9_-]+) -->$/;
export function entryId(line: string): string | undefined { return marker.exec(line)?.[1]; }
function fence(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  const size = Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1));
  const ticks = "`".repeat(size); return `${ticks}\n${text}\n${ticks}`;
}
/** Convert persisted pi entries into bounded Markdown without treating their text as authority. */
export function formatSessionTranscript(jsonl: string): string {
  const entries: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try { row = JSON.parse(line); } catch { continue; } // A streaming tail may contain an incomplete line.
    const message = row.type === "message" ? row.message : row.type === "custom_message" ? row : undefined;
    if (!message) continue;
    const id = /^[A-Za-z0-9_-]+$/.test(String(row.id)) ? `<!-- secretary-entry:${row.id} -->\n` : "";
    const role = String(message.role ?? "notification");
    const blocks = typeof message.content === "string" ? [message.content] : (message.content ?? []).flatMap((c: Record<string, any>) => {
      if (c.type === "text") return [String(c.text ?? "")];
      if (c.type === "toolCall") return [`### Tool call: ${String(c.name)}\n${fence(c.arguments)}`];
      if (c.type === "image") return ["[Image attachment]"];
      return []; // Do not expose hidden reasoning by default.
    });
    const heading = role === "toolResult" ? `Tool result: ${String(message.toolName ?? "tool")}` : role;
    entries.push(`${id}## ${heading}\n${blocks.join("\n\n")}`);
  }
  return entries.join("\n\n");
}
