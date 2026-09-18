/**
 * Goal UI dashboard rendering tests for the bordered widget design:
 * a box whose top border leads with "<icon> Goal: <status>" and trails with
 * "<tokens> tokens, <elapsed>". The bottom information bar is not used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  renderGoalDashboard,
  renderGoalBox,
  formatElapsed,
  consumptionText,
  abbreviateTokens,
  normalizeObjective,
  EXPAND_HINT,
  STATUS_COLORS,
} from "../../extensions/secretary/goal-ui.ts";
import { type ThreadGoal } from "../../extensions/secretary/goal/goal-record.ts";

function goal(partial: Partial<ThreadGoal>): ThreadGoal {
  return {
    threadId: "t",
    goalId: "g",
    objective: "default",
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

const top = (lines: string[]) => lines[0]!;

test("no goal renders no widget", () => {
  assert.deepEqual(renderGoalDashboard(null).widget, []);
});

test("active goal leads with the play icon and status behind one padding bar", () => {
  const d = renderGoalDashboard(goal({ objective: "ship the feature" }), 80, 1000);
  assert.ok(top(d.widget).startsWith("╭─ ▶ Goal: active"));
  assert.ok(d.widget.some((l) => l.includes("ship the feature")));
  assert.ok(d.widget.at(-1)!.startsWith("╰"));
});

test("status icons map to the documented marks", () => {
  const cases: Array<[ThreadGoal["status"], string]> = [
    ["active", "▶"], ["paused", "⏸"], ["complete", "⏹"],
    ["blocked", "ℹ"], ["budget_limited", "$"], ["usage_limited", "⚠"],
  ];
  for (const [status, icon] of cases) {
    const d = renderGoalDashboard(goal({ status }), 80, 1000);
    assert.ok(top(d.widget).includes(`${icon} Goal: ${status}`), `${status} renders ${icon}`);
  }
});

test("tokens collapse to K, M, B, and T abbreviations", () => {
  assert.equal(abbreviateTokens(42), "42");
  assert.equal(abbreviateTokens(999), "999");
  assert.equal(abbreviateTokens(1000), "1K");
  assert.equal(abbreviateTokens(1500), "1.5K");
  assert.equal(abbreviateTokens(150707), "150.7K");
  assert.equal(abbreviateTokens(1234567), "1.2M");
  assert.equal(abbreviateTokens(2_500_000_000), "2.5B");
  assert.equal(abbreviateTokens(3_000_000_000_000), "3T");
  assert.match(consumptionText(goal({ tokensUsed: 150707 }), 0), /150\.7K tokens/);
});

test("elapsed duration uses applicable abbreviated units", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(formatElapsed(t0, t0 + 42_000), "42 sec");
  assert.equal(formatElapsed(t0, t0 + 622_000), "10 min 22 sec");
  assert.equal(formatElapsed(t0, t0 + 3_723_000), "1 hr 2 min 3 sec");
  assert.equal(formatElapsed(t0, t0 + 90_061_000), "1 day 1 hr 1 min 1 sec");
});

test("elapsed years and months follow the calendar", () => {
  const t0 = Date.UTC(2025, 0, 31, 0, 0, 0); // Jan 31: February has no 31st
  const feb28 = Date.UTC(2025, 1, 28, 0, 0, 0);
  assert.equal(formatElapsed(t0, feb28), "28 day");
  const t1 = Date.UTC(2024, 1, 29, 0, 0, 0); // leap day: adding a year rolls to Mar 1
  assert.equal(formatElapsed(t1, Date.UTC(2025, 1, 28, 0, 0, 0)), "11 mo 30 day");
  assert.equal(formatElapsed(t1, Date.UTC(2025, 2, 1, 0, 0, 0)), "1 yr");
  const t2 = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(formatElapsed(t2, Date.UTC(2026, 2, 1, 0, 0, 0)), "2 mo");
});

test("top border trails with the consumption text against one padding bar", () => {
  const t0 = Date.UTC(2026, 0, 1);
  const d = renderGoalDashboard(goal({ tokensUsed: 1234567, createdAt: t0 }), 100, t0 + 622_000);
  assert.match(top(d.widget), /1\.2M tokens, 10 min 22 sec ─╮$/);
});

test("trailing segment is truncated when the width is tight", () => {
  const lines = renderGoalBox("▶ Goal: active", "150,707 tokens, 10 min 22 sec", ["body"], 44);
  assert.ok(top(lines).includes("…"));
  assert.ok(top(lines).endsWith("╮"));
  assert.ok(top(lines).includes("▶ Goal: active"));
});

test("the dashboard body is one fitted line at the inner width", () => {
  const d = renderGoalDashboard(goal({ objective: "one two three four five six seven eight" }), 24, 1000);
  const text = bodyText(d.widget).trimEnd();
  assert.ok(text.endsWith(EXPAND_HINT), "the objective is truncated with the hint");
});

test("status colors follow severity semantics", () => {
  assert.equal(STATUS_COLORS.active, "accent");
  assert.equal(STATUS_COLORS.complete, "success");
  assert.equal(STATUS_COLORS.paused, "muted");
  assert.equal(STATUS_COLORS.blocked, "error");
  assert.equal(STATUS_COLORS.budget_limited, "warning");
  assert.equal(STATUS_COLORS.usage_limited, "warning");
});

test("unavailable box renders without an icon", () => {
  const lines = renderGoalBox("Goal: unavailable", "", ["Goal status is unavailable."], 60);
  assert.ok(top(lines).startsWith("╭─ Goal: unavailable"));
  assert.ok(!top(lines).includes("╮ ") || top(lines).endsWith("╮"));
});

// --- One-line objective design: normalize → truncate → render -----------------
// The widget body is always exactly one line. The objective is normalized
// (whitespace runs collapsed, ends trimmed), truncated to the inner width at a
// word boundary, and suffixed with the `/goal` expansion hint when truncated.

const bodyText = (lines: string[]): string => {
  assert.equal(lines.length, 3, "the widget is exactly three lines");
  const body = lines[1]!;
  assert.ok(body.startsWith("│ ") && body.endsWith(" │"), "the body line carries the borders");
  return body.slice(2, -2);
};

/** A lone surrogate half renders as U+FFFD; ES2022 typings lack isWellFormed. */
const hasLoneSurrogate = (text: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

test("normalizeObjective collapses whitespace runs and trims the ends", () => {
  assert.equal(normalizeObjective("  leading and trailing  "), "leading and trailing");
  assert.equal(normalizeObjective(`paragraph one

paragraph two`), "paragraph one paragraph two");
  // The CR cannot be a literal source character; the line break after it is.
  assert.equal(normalizeObjective(`tabs\tand\r
 CRLF`), "tabs and CRLF");
  assert.equal(normalizeObjective("multiple   \t  spaces"), "multiple spaces");
  assert.equal(normalizeObjective("already clean"), "already clean");
});

test("a multi-line objective renders as a single bordered body line", () => {
  const objective = `First sentence explains context.

Second paragraph asks the real question.`;
  const d = renderGoalDashboard(goal({ objective }), 120, 1000);
  const text = bodyText(d.widget);
  assert.equal(text.trimEnd(), "First sentence explains context. Second paragraph asks the real question.");
  for (const line of d.widget) assert.equal(line.length, 120, "every line spans the full width");
});

test("the widget is always three lines regardless of objective length", () => {
  const long = "Develop a few mapping functions for converting boolean probability into real grayscale, render the images with the app, take snapshots, and tell me which mapping function works better for this drawing.";
  for (const width of [24, 44, 80, 120]) {
    const d = renderGoalDashboard(goal({ objective: long }), width, 1000);
    assert.equal(d.widget.length, 3, `width ${width} renders exactly three lines`);
    for (const line of d.widget) assert.equal(line.length, width);
  }
});

test("a long objective is truncated at a word boundary with the expansion hint", () => {
  const objective = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
  const width = 44;
  const d = renderGoalDashboard(goal({ objective }), width, 1000);
  const text = bodyText(d.widget).trimEnd();
  assert.ok(text.endsWith(EXPAND_HINT), `body ends with the hint: ${text}`);
  const shown = text.slice(0, -EXPAND_HINT.length).trimEnd();
  assert.ok(objective.startsWith(shown), "the shown text is a prefix of the objective");
  assert.equal(objective[shown.length], " ", "the cut happens at a word boundary");
});

test("an objective that fits renders without an ellipsis or hint", () => {
  const d = renderGoalDashboard(goal({ objective: "ship the feature" }), 80, 1000);
  const text = bodyText(d.widget).trimEnd();
  assert.equal(text, "ship the feature");
  assert.ok(!text.includes("…") && !text.includes("/goal"));
});

test("the hint is dropped when the width cannot carry it", () => {
  const objective = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
  const d = renderGoalDashboard(goal({ objective }), 12, 1000);
  const text = bodyText(d.widget).trimEnd();
  assert.ok(text.endsWith("…"), `body still ends with an ellipsis: ${text}`);
  assert.ok(!text.includes("/goal"), "the hint does not fit at this width");
});

test("leading and trailing whitespace do not shift the body text", () => {
  const objective = `
   ship the feature 
 `;
  const d = renderGoalDashboard(goal({ objective }), 80, 1000);
  assert.equal(bodyText(d.widget).trimEnd(), "ship the feature");
});

// --- Display-width reproducers ------------------------------------------------
// Width math must count terminal display cells, not UTF-16 code units: CJK
// ideographs are 2 cells, emoji are surrogate pairs, ZWJ sequences and
// combining marks form single glyphs. Every widget line must span exactly the
// requested width in cells, and truncation must never split a grapheme.

test("reproducer: CJK objective must not overflow the box width", () => {
  const objective = "开发几个映射函数，把布尔概率转换成真实灰度，渲染图片并截图对比效果";
  const d = renderGoalDashboard(goal({ objective }), 80, 1000);
  for (const line of d.widget) {
    assert.equal(visibleWidth(line), 80, `line spans the full width in cells: ${line}`);
  }
});

test("reproducer: CJK truncation respects the display-cell budget", () => {
  const objective = "开发几个映射函数用于把布尔概率转换成真实灰度，渲染图片截图对比不同映射函数的效果差异。";
  const d = renderGoalDashboard(goal({ objective }), 44, 1000);
  const text = bodyText(d.widget).trimEnd();
  assert.ok(text.endsWith(EXPAND_HINT), "the objective is truncated with the hint");
  assert.equal(visibleWidth(d.widget[1]!), 44, "the truncated body stays inside the box");
});

test("reproducer: truncation never splits an emoji surrogate pair", () => {
  const objective = "🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛";
  const d = renderGoalDashboard(goal({ objective }), 22, 1000);
  const text = bodyText(d.widget).trimEnd();
  assert.ok(!hasLoneSurrogate(text), "the truncated body contains no lone surrogate halves");
  assert.equal(visibleWidth(d.widget[1]!), 22, "the truncated body stays inside the box");
});

test("reproducer: a ZWJ emoji sequence is never split", () => {
  const objective = "👨‍💻👨‍💻👨‍💻👨‍💻👨‍💻👨‍💻👨‍💻👨‍💻";
  const d = renderGoalDashboard(goal({ objective }), 22, 1000);
  const text = bodyText(d.widget).trimEnd();
  assert.ok(!hasLoneSurrogate(text), "the truncated body contains no lone surrogate halves");
  assert.ok(!text.endsWith("‍" + EXPAND_HINT) && !text.includes("‍…"), "no dangling ZWJ before the ellipsis");
  assert.equal(visibleWidth(d.widget[1]!), 22, "the truncated body stays inside the box");
});

test("reproducer: combining marks do not consume display cells", () => {
  // “é” in decomposed form: the combining accent cannot be a reliable literal
  // source character, so it stays an escape.
  const objective = "fix the cafe\u0301 rendering bug";
  const d = renderGoalDashboard(goal({ objective }), 80, 1000);
  assert.equal(visibleWidth(d.widget[1]!), 80, "the body line spans the full width in cells");
});
