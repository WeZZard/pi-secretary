import type { Component } from "@earendil-works/pi-tui";
import { clip, sanitize } from "../ui/transcript.ts";
const component = (text: string, limit: number): Component => ({
  invalidate() {},
  render: width => sanitize(text).split("\n").slice(0, limit).map(line => clip(line, width)),
});
export function renderCall(args: Record<string, unknown>): Component {
  const target = args.description ?? args.to ?? args.task_id ?? args.shell_id ?? "agent operation";
  return component(`${args.subagent_type ?? "Agent"} · ${target}${"run_in_background" in args ? args.run_in_background ? " · background" : " · foreground" : ""}`, 2);
}
export function renderResult(result: { content: readonly { type: string; text?: string }[] }, options: { expanded: boolean; isPartial: boolean }): Component {
  const text = result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
  const lines = sanitize(text).split("\n");
  const limit = options.expanded ? 200 : 8;
  return component(`${options.isPartial ? "Progress (not a final outcome)\n" : ""}${lines.slice(0, limit).join("\n")}${lines.length > limit ? "\n[Display clipped; expand or inspect the recorded output path.]" : ""}`, limit + 2);
}
