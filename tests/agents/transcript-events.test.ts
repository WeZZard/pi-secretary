import test from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptEvents, guidanceNotice } from "../../extensions/secretary/agents/ui/transcript-events.ts";
import { sanitize, renderEvent, transcriptWindow, captureAnchor, restoreTranscript } from "../../extensions/secretary/agents/ui/transcript.ts";
import type { GuidanceRecord } from "../../extensions/secretary/agents/records.ts";

const message = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "message", id, timestamp: "2026-09-18T01:02:03.000Z", message: { role, content, ...extra } });

test("tool calls pair with results by toolCallId; unmatched results attach to the latest open call", () => {
  const jsonl = [
    message("m1", "user", "Do the task"),
    message("m2", "assistant", [{ type: "text", text: "Reading now." }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/a" } }, { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "ls" } }]),
    message("m3", "toolResult", "file contents", { toolCallId: "call-2", toolName: "bash" }),
    message("m4", "toolResult", "first line", { toolCallId: "call-1", toolName: "read" }),
    message("m5", "assistant", "Done."),
  ].join("\n");
  const { events, truncated, malformed } = parseTranscriptEvents(jsonl);
  assert.equal(truncated, false); assert.equal(malformed, 0);
  assert.deepEqual(events.map(e => e.kind), ["user", "assistant", "tool", "tool", "assistant"]);
  const [read, bash] = events.filter(e => e.kind === "tool");
  assert.equal(read!.kind === "tool" && read!.name, "read");
  assert.equal(read!.kind === "tool" && read!.status, "complete");
  assert.equal(read!.kind === "tool" && read!.output, "first line");
  assert.equal(bash!.kind === "tool" && bash!.name, "bash");
  assert.equal(bash!.kind === "tool" && bash!.status, "complete");
  assert.equal(bash!.kind === "tool" && bash!.output, "file contents");
});

test("a call without a result renders running; an error result renders error", () => {
  const jsonl = [
    message("m1", "assistant", [{ type: "toolCall", id: "pending", name: "bash", arguments: { command: "sleep 60" } }]),
    message("m2", "assistant", [{ type: "toolCall", id: "broken", name: "read", arguments: { path: "/missing" } }]),
    message("m3", "toolResult", "No such file", { toolCallId: "broken", toolName: "read", isError: true }),
  ].join("\n");
  const { events } = parseTranscriptEvents(jsonl);
  const [pending, broken] = events.filter(e => e.kind === "tool");
  assert.equal(pending!.kind === "tool" && pending!.status, "running");
  assert.equal(broken!.kind === "tool" && broken!.status, "error");
  assert.match(renderEvent(broken!, 80).join("\n"), /✗/);
  assert.match(renderEvent(pending!, 80).join("\n"), /●.*running/);
});

test("an orphan result without any call still renders as a complete tool event", () => {
  const { events } = parseTranscriptEvents(message("m1", "toolResult", [{ type: "text", text: "orphan output" }], { toolCallId: "gone", toolName: "ls" }));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind === "tool" && events[0]!.status, "complete");
  assert.equal(events[0]!.kind === "tool" && events[0]!.output, "orphan output");
});

test("parsing is bounded by lines and bytes with an explicit truncation marker; partial trailing lines are ignored", () => {
  const rows = Array.from({ length: 20 }, (_, i) => message(`m${i}`, "assistant", `paragraph ${i}`));
  const byLines = parseTranscriptEvents(rows.join("\n") + "\n", { maxLines: 5 });
  assert.equal(byLines.truncated, true);
  assert.ok(byLines.events[0]!.kind === "notice" && /bounded view/.test(byLines.events[0]!.text));
  assert.equal(byLines.events.filter(e => e.kind === "assistant").length, 4, "the marker occupies one of the bounded lines");
  const byBytes = parseTranscriptEvents(rows.join("\n") + "\n", { maxBytes: 1024 });
  assert.equal(byBytes.truncated, true);
  const partial = parseTranscriptEvents(`${message("ok", "user", "complete line")}\n{"type":"message","id":"cut`);
  assert.equal(partial.truncated, false);
  assert.deepEqual(partial.events.map(e => e.entryId), ["ok"]);
  assert.equal(partial.malformed, 0);
});

test("entries without a usable id derive a stable identifier from their line index", () => {
  const { events } = parseTranscriptEvents([JSON.stringify({ type: "message", message: { role: "user", content: "no id" } }), message("with-id", "assistant", "has id")].join("\n"));
  assert.equal(events[0]!.entryId, "line-0");
  assert.equal(events[1]!.entryId, "with-id");
});

test("guidance delivery states render as notices that never claim compliance", () => {
  const base: GuidanceRecord = { id: "g1", runId: "r1", text: "Check the edge cases", state: "undelivered", reason: "Execution settled before correlated consumption was established." };
  const notice = guidanceNotice(base);
  assert.equal(notice.kind, "notice");
  assert.equal(notice.entryId, "guidance-g1");
  if (notice.kind === "notice") {
    assert.equal(notice.tone, "warning");
    assert.match(notice.text, /not delivered/);
    assert.match(notice.text, /> Check the edge cases/);
    assert.doesNotMatch(notice.text, /followed|complied/i);
  }
  assert.equal(guidanceNotice({ ...base, state: "transport-accepted", reason: undefined }).kind === "notice" && (guidanceNotice({ ...base, state: "transport-accepted" }) as { tone: string }).tone, "muted");
});

test("control sequences and C1 codes are stripped from parsed text before rendering", () => {
  const attacks = ["\x1b[2J", "\x1b]52;c;Y2xpcGJvYXJk\x07", "\x1b]0;forged\x1b\\", "\x1bPmalicious\x1b\\", "\x9b2J"];
  for (const attack of attacks) {
    const { events } = parseTranscriptEvents(message("m1", "assistant", `before ${attack} after`));
    assert.equal(events.length, 1);
    const rendered = renderEvent(events[0]!, 80).join("\n");
    assert.ok(!rendered.includes(attack));
    assert.doesNotMatch(rendered, /Y2xpcGJvYXJk|forged|malicious/);
    assert.match(sanitize(rendered), /before.*after/);
  }
});

test("hidden reasoning blocks are never exposed and image attachments render as notices", () => {
  const { events } = parseTranscriptEvents(message("m1", "assistant", [
    { type: "thinking", thinking: "secret chain of thought" },
    { type: "text", text: "visible" },
    { type: "image", data: "base64", mimeType: "image/png" },
  ]));
  assert.deepEqual(events.map(e => e.kind), ["assistant", "notice"]);
  assert.ok(!JSON.stringify(events).includes("secret chain of thought"));
});

test("anchors follow stable entry identifiers across reloads with inserted content", () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ kind: "assistant" as const, entryId: `e-${i}`, text: `line ${i}` }));
  const view = restoreTranscript(undefined, events);
  // Anchors are logical lines; each assistant event contributes a header and a content line.
  const anchored = { ...view, follow: "paused" as const, ...captureAnchor(view, 8) };
  assert.equal(anchored.anchorEntryId, "e-4");
  const reloaded = restoreTranscript(anchored, [{ kind: "user", entryId: "inserted", text: "earlier" }, ...events, { kind: "assistant", entryId: "new", text: "new" }]);
  assert.equal(reloaded.follow, "paused");
  assert.equal(reloaded.events.find(event => event.entryId === reloaded.anchorEntryId)?.entryId, "e-4", "the anchor recovers by stable entry id, not by position");
  const missing = restoreTranscript(anchored, [{ kind: "assistant", entryId: "other", text: "replacement" }]);
  assert.equal(missing.anchor, 0);
  assert.ok(missing.events[0]!.kind === "notice" && /anchor is unavailable/.test(missing.events[0]!.text));
});

test("the windowed transcript renders bounded rows for following and paused modes", () => {
  const events = Array.from({ length: 40 }, (_, i) => ({ kind: "assistant" as const, entryId: `e-${i}`, text: `paragraph ${i}` }));
  const following = transcriptWindow({ events, follow: "following", anchor: 0, expanded: false }, 60, 5);
  assert.equal(following.length, 5);
  assert.match(following.join("\n"), /paragraph 39/);
  const paused = transcriptWindow({ events, follow: "paused", anchor: 7, anchorEntryId: "e-3", expanded: false }, 60, 4);
  assert.match(paused.join("\n"), /paragraph 3/);
  assert.ok(!paused.join("\n").includes("paragraph 5"));
  assert.deepEqual(transcriptWindow({ events, follow: "following", anchor: 0, expanded: false }, 0, 5), []);
});

test("tool detail expansion toggles bounded argument and output blocks", () => {
  const tool = { kind: "tool" as const, entryId: "t1", name: "bash", status: "complete" as const, argsPreview: "```\n{\"command\":\"ls\"}\n```", output: "one\ntwo" };
  const collapsed = renderEvent(tool, 80);
  assert.ok(collapsed.every(line => !line.includes('"command"')));
  // The expansion hint must name the key the footer advertises, never the stop shortcut.
  assert.match(collapsed.join("\n"), /o to expand/);
  assert.doesNotMatch(collapsed.join("\n"), /x to expand/);
  const expanded = renderEvent(tool, 80, { expanded: true });
  assert.match(expanded.join("\n"), /"command"/);
  assert.match(expanded.join("\n"), /one/);
});
