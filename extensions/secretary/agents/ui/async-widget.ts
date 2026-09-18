import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TERMINAL_STATUSES, type AgentRowView } from "../records.ts";
import { statusGlyph } from "./glyphs.ts";
import { clip } from "./transcript.ts";
import { formatElapsed, formatUsageLabels } from "./usage-labels.ts";

export const ASYNC_WIDGET_KEY = "secretary.agents.async";
const MAX_WIDGET_ROWS = 6;

/** Active background executions only; foreground work is already visible inline. */
export function activeBackground(rows: readonly AgentRowView[]): AgentRowView[] {
  return rows.filter(row => row.background && !TERMINAL_STATUSES.has(row.status as never));
}

/**
 * A change in this key requires a repaint; an unchanged key with no running row does not.
 * The key is derived from the full rendered view-model snapshot (§12.6.3).
 */
export function widgetRenderKey(rows: readonly AgentRowView[], folded: boolean): string {
  return JSON.stringify([folded, rows.map(row => [row.agentId, row.name, row.status, row.description, row.model,
    row.startedAt, row.activity, row.windowTokens, row.cumulativeTokens])]);
}

export interface AsyncWidgetOptions {
  rows: () => readonly AgentRowView[];
  theme?: Theme;
  now?: () => number;
  /** The configured pi tool-expansion state reveals live detail lines. */
  expanded?: () => boolean;
}

/** The async widget lists active background executions independently of FleetView (§12.6.3, UX §2.3). */
export class AsyncWidget implements Component {
  private readonly options: Required<Pick<AsyncWidgetOptions, "rows" | "now">> & AsyncWidgetOptions;
  private folded = false;
  constructor(options: AsyncWidgetOptions) {
    this.options = { now: Date.now, ...options };
  }
  invalidate(): void {}
  isFolded(): boolean { return this.folded; }
  /** Clicking the header folds the widget into a one-line summary; it never changes execution. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left" || event.y !== 0 || event.shift || event.alt || event.ctrl) return undefined;
    this.folded = !this.folded;
    return { handled: true };
  }
  render(width: number): string[] {
    if (width <= 0) return [];
    const theme = this.options.theme;
    const now = this.options.now();
    const rows = activeBackground(this.options.rows());
    if (!rows.length) return [];
    const expanded = this.options.expanded?.() ?? false;
    const stats = (row: AgentRowView) => [formatElapsed(row.startedAt, now), ...formatUsageLabels(row)].filter(Boolean).join(" · ");
    const header = `${rows.some(row => row.status === "running") ? theme?.fg("accent", "●") ?? "●" : theme?.fg("muted", "◦") ?? "◦"} ${theme ? theme.fg("accent", "Async agents") : "Async agents"} ${theme ? theme.fg("dim", "· background") : "· background"}`;
    if (this.folded) return [truncateToWidth(`${header} ${theme ? theme.fg("dim", `· ${rows.length} active · click to unfold`) : `· ${rows.length} active · click to unfold`}`, width, "")];
    const lines: string[] = [truncateToWidth(header, width, "")];
    const visible = rows.slice(0, MAX_WIDGET_ROWS);
    const hidden = rows.length - visible.length;
    for (const [index, row] of visible.entries()) {
      const last = index === visible.length - 1 && hidden <= 0;
      const branch = theme ? theme.fg("dim", last ? "└─" : "├─") : last ? "└─" : "├─";
      const continuation = theme ? theme.fg("dim", last ? "  " : "│  ") : last ? "  " : "│  ";
      const name = theme ? theme.bold(row.name ?? row.agentId) : row.name ?? row.agentId;
      const rowStats = stats(row);
      const separator = theme ? theme.fg("dim", "·") : "·";
      const statsText = rowStats ? ` ${separator} ${theme ? theme.fg("dim", rowStats) : rowStats}` : "";
      lines.push(truncateToWidth(`${branch} ${statusGlyph(row.status, theme)} ${name}${statsText}`, width, ""));
      const activity = row.status === "queued" ? "queued…" : row.activity ?? (row.status === "running" ? "thinking…" : row.status);
      lines.push(truncateToWidth(`${continuation}   ${theme ? theme.fg("dim", `⎿  ${activity}`) : `⎿  ${activity}`}`, width, ""));
      if (expanded) {
        const detail = `status ${row.status} · model ${row.model}${row.startedAt !== undefined ? ` · started ${formatElapsed(row.startedAt, now)} ago` : ""}`;
        lines.push(truncateToWidth(`${continuation}   ${theme ? theme.fg("dim", detail) : detail}`, width, ""));
      }
    }
    if (hidden > 0) lines.push(clip(`+${hidden} more active background executions`, width));
    return lines;
  }
}

/**
 * The bounded polling loop: an unreferenced timer advances elapsed time between service events.
 * A repaint is requested only when the render key changed or a row is running. Both the timer and
 * the subscription are disposed on deactivation.
 */
export function startAsyncWidgetPolling(options: {
  intervalMs?: number;
  folded?: () => boolean;
  rows: () => readonly AgentRowView[];
  hasRunning?: (rows: readonly AgentRowView[]) => boolean;
  repaint: () => void;
  subscribe: (listener: () => void) => () => void;
}): { dispose(): void; renderKey(): string } {
  const intervalMs = Math.max(5, options.intervalMs ?? 500);
  const folded = options.folded ?? (() => false);
  const hasRunning = options.hasRunning ?? (rows => activeBackground(rows).some(row => row.status === "running" || row.status === "starting"));
  let key = "";
  const tick = () => {
    const rows = options.rows();
    const next = widgetRenderKey(rows, folded());
    const repaint = next !== key || hasRunning(rows);
    key = next;
    if (repaint) options.repaint();
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const unsubscribe = options.subscribe(tick);
  return {
    renderKey: () => key,
    dispose() { clearInterval(timer); unsubscribe(); },
  };
}
