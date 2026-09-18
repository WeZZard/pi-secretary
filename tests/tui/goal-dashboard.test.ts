/**
 * Goal UI dashboard rendering tests for the bordered widget design:
 * a box whose top border leads with "<icon> Goal: <status>" and trails with
 * "<tokens> tokens, <elapsed>". The bottom information bar is not used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderGoalDashboard,
  renderGoalBox,
  formatElapsed,
  consumptionText,
  abbreviateTokens,
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

test("body wraps at the inner width", () => {
  const lines = renderGoalBox("▶ Goal: active", "1 tokens, 1 sec", ["one two three four five six seven eight"], 24);
  assert.ok(lines.length > 3, "the objective wraps to multiple lines");
  for (const line of lines.slice(1, -1)) assert.ok(line.startsWith("│ ") && line.endsWith(" │"));
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
