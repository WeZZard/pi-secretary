/**
 * pi-secretary goal UI wiring.
 *
 * Renders the single thread goal (Codex single-goal-per-thread semantics) as a
 * bordered above-editor widget: the top border carries "<icon> Goal: <status>"
 * on the leading edge and "<tokens> tokens, <elapsed>" on the trailing edge.
 * The bottom information bar is not used.
 */

import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type ThreadGoal, type ThreadGoalStatus } from "./goal/goal-record.ts";
import { type GoalEngine } from "./goal-engine.ts";
import { type GoalReceipt } from "./goal/ordering.ts";

export interface GoalStatusLine {
  /** Above-editor widget lines. */
  widget: string[];
}

const STATUS_ICONS: Record<ThreadGoalStatus, string> = {
  active: "▶",
  paused: "⏸",
  complete: "⏹",
  blocked: "ℹ",
  budget_limited: "$",
  usage_limited: "⚠",
};

/** Severity colors (theme keys): running/success/muted/resource-warning/error semantics. */
export const STATUS_COLORS: Record<ThreadGoalStatus, ThemeColor> = {
  active: "accent",
  paused: "muted",
  complete: "success",
  blocked: "error",
  budget_limited: "warning",
  usage_limited: "warning",
};

/** Collapsible token count: exact below 1,000; one-decimal K/M/B/T above. */
export function abbreviateTokens(value: number): string {
  const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  const v = Math.max(0, Math.floor(value));
  for (const [scale, suffix] of units) {
    if (v >= scale) {
      const n = Math.floor((v / scale) * 10) / 10;
      return `${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1)}${suffix}`;
    }
  }
  return String(v);
}

function groupThousands(value: number): string {
  const digits = String(Math.max(0, Math.floor(value)));
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Calendar-accurate duration: years and months from the epoch, then the remainder. */
export function formatElapsed(fromMs: number, toMs: number): string {
  let remaining = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  const cursor = new Date(fromMs);
  let years = 0;
  for (;;) {
    const next = new Date(cursor.getTime());
    next.setFullYear(next.getFullYear() + 1);
    const span = Math.floor((next.getTime() - cursor.getTime()) / 1000);
    if (span > remaining) break;
    years++; remaining -= span; cursor.setTime(next.getTime());
  }
  let months = 0;
  for (;;) {
    const next = new Date(cursor.getTime());
    next.setMonth(next.getMonth() + 1);
    const span = Math.floor((next.getTime() - cursor.getTime()) / 1000);
    if (span > remaining) break;
    months++; remaining -= span; cursor.setTime(next.getTime());
  }
  const days = Math.floor(remaining / 86400); remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600); remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60); remaining -= minutes * 60;
  const seconds = remaining;
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} yr`);
  if (months > 0) parts.push(`${months} mo`);
  if (days > 0) parts.push(`${days} day`);
  if (hours > 0) parts.push(`${hours} hr`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} sec`);
  return parts.join(" ");
}

/** Trailing consumption segment shared by the widget and tests. */
export function consumptionText(goal: ThreadGoal, nowMs: number): string {
  return `${abbreviateTokens(goal.tokensUsed)} tokens, ${elapsedText(goal, nowMs)}`;
}

/** Duration text: live wall-clock ticking while active, the frozen accounting otherwise. */
export function elapsedText(goal: ThreadGoal, nowMs: number): string {
  if (goal.status === "active") return formatElapsed(goal.createdAt, nowMs);
  return formatElapsed(0, goal.timeUsedSeconds * 1000);
}

const ELLIPSIS = "…";

/** Terminal display-cell width: CJK is 2 cells, combining marks 0, not UTF-16 units. */
const cellWidth = (text: string): number => visibleWidth(text);

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Grapheme clusters of the text: the only safe unit for truncation and cutting. */
function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

/**
 * Truncate to at most maxCells display cells at a grapheme boundary, so emoji
 * surrogate pairs and ZWJ sequences are never split.
 */
function truncateToCells(text: string, maxCells: number): string {
  if (cellWidth(text) <= maxCells) return text;
  let out = "";
  let cells = 0;
  for (const segment of graphemes(text)) {
    const width = cellWidth(segment);
    if (cells + width > maxCells) break;
    out += segment;
    cells += width;
  }
  return out;
}

function fitSegment(text: string, width: number): string {
  if (cellWidth(text) <= width) return text;
  if (width <= 1) return ELLIPSIS.slice(0, Math.max(width, 0));
  return truncateToCells(text, width - 1) + ELLIPSIS;
}

/**
 * Collapse every whitespace run (spaces, tabs, newlines, CRLF) into a single
 * space and trim the ends. Presentation only: the stored objective stays
 * verbatim for the `/goal` view dialog and `/goal edit` prefill.
 */
export function normalizeObjective(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Suffix marking a truncated objective; `/goal` is the expansion surface. */
export const EXPAND_HINT = "… (/goal)";

/**
 * Fit a normalized objective into one line at the given display-cell budget:
 * word-boundary truncation with the expansion hint; the hint drops to a bare
 * ellipsis when the width cannot carry it.
 */
function fitObjectiveLine(text: string, width: number): string {
  if (cellWidth(text) <= width) return text;
  const budget = width - cellWidth(EXPAND_HINT);
  if (budget >= 1) {
    // Cut at a grapheme boundary first, then look for a word boundary among
    // the graphemes: a UTF-16 space can hide inside a surrogate pair, so the
    // search must compare whole clusters, not code units.
    const head = graphemes(truncateToCells(text, budget));
    let wordEnd = head.length;
    for (let i = head.length - 1; i >= 0; i--) {
      if (head[i] === " ") { wordEnd = i; break; }
    }
    return head.slice(0, wordEnd).join("") + EXPAND_HINT;
  }
  return fitSegment(text, width);
}

/** The widget body is always exactly one fitted line of the objective. */
function objectiveBody(objective: string, width: number): string[] {
  // renderGoalBox reserves two border columns and one padding column per side.
  return [fitObjectiveLine(normalizeObjective(objective), Math.max(width - 4, 1))];
}

function wrapText(text: string, width: number): string[] {
  if (width < 1) return [""];
  const lines: string[] = [];
  let remaining = text;
  // Budget in display cells: a line fitted by cell width must never be
  // re-wrapped by UTF-16 length, and cuts stay on grapheme boundaries.
  while (cellWidth(remaining) > width) {
    const head = truncateToCells(remaining, width);
    const clusters = graphemes(head);
    // Prefer a word boundary: the last cluster that is exactly a space.
    let cut = head.length;
    for (let i = clusters.length - 1; i > 0; i--) {
      if (clusters[i] === " ") { cut = clusters.slice(0, i).join("").length; break; }
    }
    lines.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0 || lines.length === 0) lines.push(remaining);
  return lines;
}

/**
 * Render the bordered goal widget at a fixed width. Pure and unit-testable.
 * The top border leads with "<icon> Goal: <status>" and trails with the
 * consumption text; both segments carry one horizontal-bar padding against
 * their edges. The objective wraps inside the box.
 */
export function renderGoalBox(leading: string, trailing: string, body: string[], width: number): string[] {
  const inner = Math.max(width - 2, 1); // width of the body lines' inner column
  const lead = `─ ${leading} `;
  const trail = trailing ? ` ${trailing} ─` : "";
  // The top rule spans width-2 columns between the corners, shared by lead, fill, and trail.
  const rule = width - 2;
  const leadCells = cellWidth(lead);
  const trailCells = cellWidth(trail);
  let top: string;
  if (leadCells + trailCells > rule) {
    // Reserve one column per padding space around the fitted segment.
    const fitted = fitSegment(trail.trim(), Math.max(rule - leadCells - 2, 0)).trim();
    const trailPart = fitted ? ` ${fitted} ` : "";
    top = `╭${lead}${trailPart}${"─".repeat(Math.max(rule - leadCells - cellWidth(trailPart), 0))}╮`;
  } else {
    top = `╭${lead}${"─".repeat(Math.max(rule - leadCells - trailCells, 0))}${trail}╮`;
  }
  const bodyLines = body.flatMap((line) => wrapText(line, inner - 2)).map((line) =>
    `│ ${line}${" ".repeat(Math.max(inner - 2 - cellWidth(line), 0))} │`);
  const bottom = `╰${"─".repeat(rule)}╯`;
  return [top, ...bodyLines, bottom];
}

/**
 * Render goal widget lines from a single goal at a reference width and time.
 * Pure and unit-testable. No goal → no widget (cleared).
 */
export function renderGoalDashboard(goal: ThreadGoal | null, width = 80, nowMs = Date.now()): GoalStatusLine {
  if (!goal) return { widget: [] };
  const leading = `${STATUS_ICONS[goal.status]} Goal: ${goal.status}`;
  return { widget: renderGoalBox(leading, consumptionText(goal, nowMs), objectiveBody(goal.objective, width), width) };
}

/**
 * Apply a `/goal` command argument string to the engine, matching Codex's
 * slash command behavior:
 *   - `/goal <objective>`    set (create or replace) the goal
 *   - `/goal`                view the goal
 *   - `/goal clear`          clear the goal
 *   - `/goal pause|resume`   transition the goal status
 * Pure and unit-testable; returns a describe result.
 */
export type GoalCommandResult =
  | { kind: "view"; body: string[] }
  | { kind: "notify"; message: string; error?: boolean }
  | { kind: "edit"; current: ThreadGoal };

export function applyGoalCommand(
  engine: GoalEngine,
  threadId: string,
  args: string,
  expectedGoalId?: string,
  receipt?: GoalReceipt,
): GoalCommandResult {
  const trimmed = args.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "edit") {
    // Open an editor prefilled with the current objective, if one exists.
    const current = engine.service.getGoal(threadId);
    if (!current) {
      return { kind: "notify", message: "No goal to edit; set one with `/goal <objective>`.", error: true };
    }
    return { kind: "edit", current };
  }
  if (lower === "clear") {
    const outcome = engine.service.clearGoal(threadId, "user", expectedGoalId, receipt);
    return outcome.goal
      ? { kind: "notify", message: "Goal changed; it was not cleared. Inspect it and try again.", error: true }
      : { kind: "notify", message: outcome.previousGoal ? "Goal cleared." : "No current goal to clear." };
  }
  if (lower === "pause") {
    const update = engine.service.requestTerminalUpdate(threadId, "paused", "user", expectedGoalId, receipt);
    return { kind: "notify", message: update.goal?.status === "paused"
      ? "Goal paused." : `Goal remains ${update.goal?.status}; it was not paused.` };
  }
  if (lower === "resume") {
    const update = engine.service.setGoal(threadId, { status: "active" }, "user", receipt);
    return { kind: "notify", message: update.goal?.status === "active"
      ? "Goal resumed." : `Cannot resume: goal remains ${update.goal?.status}; no token budget is available.` };
  }

  if (trimmed === "") {
    // The view dialog is the expansion surface for the one-line widget, so it
    // presents the verbatim objective, not the fitted widget body.
    const goal = engine.service.getGoal(threadId);
    if (!goal) return { kind: "view", body: [] };
    return { kind: "view", body: [`Goal [${goal.status}]:`, "", goal.objective] };
  }

  // `/goal <objective>` sets (create or replace) the goal as Active, matching
  // Codex's draft behavior (a new objective reactivates a completed goal).
  try {
    const existing = engine.service.getGoal(threadId);
    const outcome = existing
      ? engine.service.setGoal(threadId, { objective: trimmed, status: "active" }, "user", receipt)
      : engine.service.createGoal(threadId, trimmed, undefined, "user", receipt);
    return {
      kind: "notify",
      message: outcome.goal ? `Goal [${outcome.goal.status}]: ${normalizeObjective(trimmed)}` : "No current goal.",
    };
  } catch (err) {
    return { kind: "notify", message: (err as Error).message, error: true };
  }
}

/**
 * Apply an edited objective from the `/goal edit` dialog. Reactivates a
 * completed goal (explicit active status, matching Codex's draft behavior),
 * validates non-empty text, and re-runs the external-goal-set effect.
 * Returns a notify result describing the outcome.
 */
export function applyGoalEdit(
  engine: GoalEngine,
  threadId: string,
  newObjective: string,
  receipt?: GoalReceipt,
): GoalCommandResult {
  const trimmed = newObjective.trim();
  if (trimmed === "") {
    return { kind: "notify", message: "Goal objective must not be empty.", error: true };
  }
  const previous = engine.service.getGoal(threadId);
  if (!previous) {
    return { kind: "notify", message: "No goal to edit.", error: true };
  }
  try {
    const outcome = engine.service.setGoal(
      threadId,
      { objective: trimmed, status: "active" },
      "user",
      receipt,
    );
    return { kind: "notify", message: `Goal [${outcome.goal?.status}]: ${normalizeObjective(trimmed)}` };
  } catch (err) {
    return { kind: "notify", message: (err as Error).message, error: true };
  }
}

/**
 * Register the goal UI: a `/goal` slash command for view/create/update/clear,
 * and live widget/status updates driven by goal_updated events.
 */
export function registerGoalUI(pi: ExtensionAPI, engine: GoalEngine): {
  bind(ctx: ExtensionContext): void;
  refresh(): void;
  unavailable(): void;
  dispose(): void;
} {
  // Session lifecycle binding is independent of command invocation.
  let disposed = false;
  let latestUi: ExtensionContext["ui"] | null = null;
  let tick: ReturnType<typeof setInterval> | undefined;

  const clearTick = (): void => { if (tick) clearInterval(tick); tick = undefined; };

  // After a goal completes, the first user message hides the widget. The hide
  // latches until the goal changes (id or status), so per-request refreshes do
  // not repaint it.
  let hiddenGoal: { goalId: string; status: ThreadGoalStatus } | undefined;

  const goalComponent = (goal: ThreadGoal) => (tui: { requestRender(force?: boolean): void }, theme: { fg(color: string, text: string): string }) => {
    const leading = `${STATUS_ICONS[goal.status]} Goal: ${goal.status}`;
    const color = STATUS_COLORS[goal.status];
    clearTick();
    if (goal.status === "active") tick = setInterval(() => tui.requestRender(), 1000);
    return {
      render: (width: number) => {
        const latest = engine.service.getGoal(goal.threadId) ?? goal;
        return renderGoalBox(leading, consumptionText(latest, Date.now()), objectiveBody(latest.objective, width), width)
          .map((line) => theme.fg(color, line));
      },
      invalidate: () => {},
      dispose: () => clearTick(),
    };
  };

  const refresh = (): void => {
    const goal = engine.getThreadId()
      ? engine.service.getGoal(engine.getThreadId()!) ?? null
      : null;
    if (!latestUi) return;
    if (!goal) { hiddenGoal = undefined; clearTick(); latestUi.setWidget("secretary:goal", undefined); return; }
    if (hiddenGoal && (hiddenGoal.goalId !== goal.goalId || hiddenGoal.status !== goal.status)) hiddenGoal = undefined;
    if (hiddenGoal) { clearTick(); latestUi.setWidget("secretary:goal", undefined); return; }
    latestUi.setWidget("secretary:goal", goalComponent(goal));
  };

  pi.on("input", () => {
    const threadId = engine.getThreadId();
    const goal = threadId ? engine.service.getGoal(threadId) : null;
    if (goal?.status === "complete") hiddenGoal = { goalId: goal.goalId, status: goal.status };
  });

  const bind = (ctx: ExtensionContext): void => {
    if (disposed) return;
    latestUi = ctx.hasUI ? ctx.ui : null;
    // A completed goal stays hidden across process restarts: the dismissal is
    // a session-scoped fact, not a process-scoped one. A blocked (unfinished)
    // goal always shows.
    if (latestUi && hiddenGoal === undefined) {
      try {
        const threadId = engine.getThreadId();
        const goal = threadId ? engine.service.getGoal(threadId) : null;
        if (goal?.status === "complete") hiddenGoal = { goalId: goal.goalId, status: goal.status };
      } catch { /* A read failure is handled by the normal unavailable path. */ }
    }
  };
  const unavailable = (): void => {
    if (!latestUi) return;
    clearTick();
    latestUi.setWidget("secretary:goal", (_tui: unknown, theme: { fg(color: string, text: string): string }) => ({
      render: (width: number) => renderGoalBox("Goal: unavailable", "", ["Goal status is unavailable; this does not establish that it was cleared."], width)
        .map((line) => theme.fg("error", line)),
      invalidate: () => {},
    }));
  };

  pi.registerCommand("goal", {
    description:
      "Set or view the goal for a long-running task. `/goal <objective>` sets a goal; `/goal` views it; `/goal clear|edit|pause|resume` control it.",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const threadId =
        ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
      let receipt: GoalReceipt | undefined;
      try {
        const expected = engine.service.getGoal(threadId);
        receipt = engine.service.ordering.receive(threadId, "command", expected?.goalId ?? null);
        if (disposed) return;
        bind(ctx);
        engine.setThreadId(threadId);
        const isCurrent = () => !disposed && engine.getThreadId() === threadId;
        if (args.trim().toLowerCase() === "clear" && expected) {
          engine.service.ordering.resolve(receipt);
          receipt = undefined;
          if (!await ctx.ui.confirm("Clear goal?", expected.objective)) return;
          receipt = engine.service.ordering.receive(threadId, "dialog", expected.goalId);
          if (!isCurrent()) return;
          if (engine.service.getGoal(threadId)?.goalId !== expected.goalId) {
            ctx.ui.notify("Goal changed while confirmation was open; inspect it and try again.", "warning");
            return;
          }
        }
        const result = applyGoalCommand(engine, threadId, args, expected?.goalId, receipt);
        if (result.kind === "view") {
          if (receipt) engine.service.ordering.resolve(receipt);
          receipt = undefined;
          const body = result.body.length ? result.body : [
            "No goal is currently set.", "",
            "Set one with `/goal <objective>`, or ask the agent (it calls create_goal).",
          ];
          await ctx.ui.input("Goal", body.join("\n"));
          if (!isCurrent()) return;
        } else if (result.kind === "edit") {
          if (receipt) engine.service.ordering.resolve(receipt);
          receipt = undefined;
          const edited = await ctx.ui.editor("Edit goal objective", result.current.objective);
          if (edited === undefined) return;
          receipt = engine.service.ordering.receive(threadId, "dialog", result.current.goalId);
          if (!isCurrent()) return;
          if (engine.service.getGoal(threadId)?.goalId !== result.current.goalId) {
            ctx.ui.notify("Goal changed while the editor was open; inspect it and try again.", "warning");
            return;
          }
          const editResult = applyGoalEdit(engine, threadId, edited, receipt);
          if (editResult.kind === "notify") ctx.ui.notify(editResult.message, editResult.error ? "error" : "info");
        } else {
          ctx.ui.notify(result.message, result.error ? "error" : "info");
        }
        refresh();
      } catch (error) {
        if (disposed) return;
        try { refresh(); } catch { unavailable(); }
        ctx.ui.notify((error as Error).message, "error");
      } finally {
        if (receipt) engine.service.ordering.resolve(receipt);
      }
    },
  });
  return {
    bind,
    refresh,
    unavailable,
    dispose: () => { disposed = true; clearTick(); latestUi = null; },
  };
}
