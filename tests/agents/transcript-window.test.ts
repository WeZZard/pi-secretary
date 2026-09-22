import test from "node:test";
import assert from "node:assert/strict";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderEvent, transcriptWindow, logicalLines } from "../../extensions/secretary/agents/ui/transcript.ts";
import type { TranscriptEvent } from "../../extensions/secretary/agents/ui/transcript-events.ts";
import type { TranscriptView } from "../../extensions/secretary/agents/ui/state.ts";

// Reference: the earlier implementation, which rendered every event and then sliced the window.
// The windowed renderer must return exactly this output while rendering far fewer events.
function referenceWindow(t: TranscriptView, width: number, height: number): string[] {
  if (width <= 0 || height <= 0) return [];
  const rendered = t.events.map(event => renderEvent(event, width, { expanded: t.expanded }));
  if (t.follow === "following") return rendered.flat().slice(-height).map(line => truncateToWidth(line.trimEnd(), width, ""));
  const starts = logicalStarts(t.events);
  let index = starts.findIndex((start, i) => t.anchor >= start && t.anchor < (starts[i + 1] ?? Infinity));
  if (index < 0) index = Math.max(0, t.events.length - 1);
  const offset = Math.min(Math.max(0, t.anchor - starts[index]!), Math.max(0, rendered[index]!.length - 1));
  const lines = [...rendered[index]!.slice(offset), ...rendered.slice(index + 1).flat()];
  return lines.slice(0, height).map(line => truncateToWidth(line.trimEnd(), width, ""));
}
function logicalStarts(events: readonly TranscriptEvent[]): number[] {
  const starts: number[] = []; let total = 0;
  for (const event of events) { starts.push(total); total += logicalLines(event); }
  return starts;
}

// A long single-line paragraph is the case that separates logical lines from wrapped display lines:
// one logical line can occupy many display rows. Markdown-collapsing text goes the other way and can
// render fewer rows than its logical lines, which is what forces the anchor offset to be clamped.
const LONG = "This single logical line is deliberately long enough to wrap across many display rows at any tested width. ".repeat(3);
const events: readonly TranscriptEvent[] = [
  { kind: "assistant", entryId: "a0", text: "Short introduction." },
  { kind: "tool", entryId: "t1", name: "read", status: "complete", argsPreview: "{\n  \"path\": \"/tmp/x\"\n}", output: Array.from({ length: 9 }, (_, i) => `output line ${i}`).join("\n") },
  { kind: "assistant", entryId: "a2", text: LONG },
  { kind: "notice", entryId: "n3", tone: "warning", text: "A notice with\ntwo lines." },
  { kind: "tool", entryId: "t4", name: "read", status: "running", argsPreview: "", output: "" },
  { kind: "assistant", entryId: "a5", text: "## Heading\n\n- one\n- two\n\nClosing paragraph." },
  { kind: "user", entryId: "s6", text: "Supervisor guidance." },
  { kind: "assistant", entryId: "a7", text: LONG },
  { kind: "assistant", entryId: "a8", text: "First\n\n\n\n\nSecond" },
  { kind: "notice", entryId: "n9", tone: "error", text: "Failure summary." },
];

test("windowed rendering matches the full-render reference across widths, heights, and anchors", () => {
  const total = events.reduce((sum, event) => sum + logicalLines(event), 0);
  for (const width of [40, 80, 120]) {
    for (const height of [1, 5, 30]) {
      for (const follow of ["following", "paused"] as const) {
        for (let anchor = 0; anchor <= total; anchor++) {
          const view: TranscriptView = { events, follow, anchor, expanded: false };
          assert.deepEqual(
            transcriptWindow(view, width, height),
            referenceWindow(view, width, height),
            `follow=${follow} width=${width} height=${height} anchor=${anchor}`,
          );
        }
      }
    }
  }
});

test("the anchor offset is clamped against rendered rows, including markdown that collapses lines", () => {
  const starts = logicalStarts(events);
  const index = events.findIndex(event => event.entryId === "a8");
  assert.ok(index >= 0);
  const lastLogicalLineOfEvent = starts[index]! + logicalLines(events[index]!) - 1;
  const view: TranscriptView = { events, follow: "paused", anchor: lastLogicalLineOfEvent, expanded: false };
  const lines = transcriptWindow(view, 80, 6);
  assert.deepEqual(lines, referenceWindow(view, 80, 6));
  assert.match(lines[0] ?? "", /│/, "the wrapped event still renders inside its rail");
});

test("empty transcripts and non-positive dimensions render nothing", () => {
  const empty: TranscriptView = { events: [], follow: "following", anchor: 0, expanded: false };
  assert.deepEqual(transcriptWindow(empty, 80, 30), []);
  assert.deepEqual(transcriptWindow({ events, follow: "following", anchor: 0, expanded: false }, 0, 30), []);
  assert.deepEqual(transcriptWindow({ events, follow: "following", anchor: 0, expanded: false }, 80, 0), []);
});

test("a long transcript paints a fixed-size window without rendering the whole transcript", () => {
  // Rendering every event would cost seconds at this size; the windowed renderer stays near a millisecond.
  const large: TranscriptEvent[] = Array.from({ length: 5000 }, (_, i) => ({ kind: "assistant", entryId: `e-${i}`, text: `Paragraph ${i} with enough words to wrap at narrow widths.` }));
  const view: TranscriptView = { events: large, follow: "paused", anchor: Math.floor(large.length / 2), expanded: false };
  const start = Date.now();
  const lines = transcriptWindow(view, 100, 30);
  const elapsed = Date.now() - start;
  assert.equal(lines.length, 30);
  assert.ok(elapsed < 1000, `expected a bounded paint, took ${elapsed}ms`);
});
