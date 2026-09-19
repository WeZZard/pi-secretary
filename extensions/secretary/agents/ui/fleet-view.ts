import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TERMINAL_STATUSES, type AgentRowView, type RunStatus } from "../records.ts";
import { fleetRows } from "./reducer.ts";
import type { UiState } from "./state.ts";
import { clip } from "./transcript.ts";
import { selectionCircle } from "./glyphs.ts";
import { formatElapsed, formatUsageLabels } from "./usage-labels.ts";

const MAX_VISIBLE_ROWS = 10;

function rightAlign(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const maxLeftWidth = Math.max(0, width - rightWidth - 1);
  const leftClamped = truncateToWidth(left, maxLeftWidth, "");
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
  return truncateToWidth(`${leftClamped}${" ".repeat(gap)}${right}`, width, "");
}

/**
 * The indicator lists the main row followed by top-level agents whose run is non-terminal;
 * a row leaves the list immediately when its run reaches a terminal status (UX §2.2, §12.6.3).
 */
export function indicatorRows(rows: readonly AgentRowView[]): AgentRowView[] {
  return rows.filter(row => !row.parentAgentId && !TERMINAL_STATUSES.has(row.status as RunStatus));
}

/**
 * A change in this key requires a repaint; an unchanged key with no running row does not.
 * The key is derived from the full rendered view-model snapshot (§12.6.3).
 */
export function indicatorRenderKey(rows: readonly AgentRowView[], selected: string | null | undefined): string {
  return JSON.stringify([selected ?? null, indicatorRows(rows).map(row => [row.agentId, row.name, row.status,
    row.startedAt, row.windowTokens, row.cumulativeTokens])]);
}

/** FleetView renders the unified fleet indicator: the reducer's session state plus service view-model rows. */
export class FleetView implements Component {
  private readonly state: () => UiState;
  private readonly theme?: Theme;
  private readonly now: () => number;
  private readonly viewRows?: () => readonly AgentRowView[];
  constructor(state: () => UiState, options: { theme?: Theme; rows?: () => readonly AgentRowView[]; now?: () => number } = {}) {
    this.state = state; this.theme = options.theme; this.now = options.now ?? Date.now; this.viewRows = options.rows;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const s = this.state();
    if (s.navigation.kind === "inactive") return [];
    const theme = this.theme;
    const owned = fleetRows(s);
    const published = this.viewRows?.();
    const rows: AgentRowView[] = published?.length ? indicatorRows(published).filter(row => owned.some(a => a.agent.agentId === row.agentId)) : owned.map(a => ({
      agentId: a.agent.agentId, name: a.agent.name, status: a.run?.status ?? "idle" as const,
      description: a.run?.description ?? a.agent.definition.description, model: a.agent.model,
      ...(a.run?.startedAt !== undefined ? { startedAt: a.run.startedAt } : {}),
      ...(a.run?.activity !== undefined ? { activity: a.run.activity } : {}),
      background: a.run?.background ?? false,
    }));
    const focused = s.navigation.kind === "fleet";
    const selected = s.navigation.kind === "fleet" ? s.navigation.selectedAgentId : undefined;
    const ids: (string | null)[] = [null, ...rows.map(row => row.agentId)];
    const index = Math.max(0, ids.indexOf(selected ?? null));
    const start = Math.max(0, Math.min(index - Math.floor(MAX_VISIBLE_ROWS / 2), Math.max(0, ids.length - MAX_VISIBLE_ROWS)));
    const renderRow = (id: string | null) => {
      const circle = selectionCircle(focused && selected === id, theme);
      if (id === null) return clip(`${circle} main`, width);
      const row = rows.find(r => r.agentId === id)!;
      const right = [formatElapsed(row.startedAt, this.now()), ...formatUsageLabels(row)].filter(Boolean).join(" · ");
      const left = `${circle} ${theme ? theme.bold(row.name ?? row.agentId) : row.name ?? row.agentId} · ${row.status}`;
      return right ? rightAlign(left, right, width) : clip(left, width);
    };
    return ids.slice(start, start + MAX_VISIBLE_ROWS).map(id => width <= 0 ? "" : truncateToWidth(renderRow(id), width, ""));
  }
}

/**
 * The bounded polling loop: an unreferenced timer advances elapsed time between service events.
 * A repaint is requested only when the render key changed or a row is running. Both the timer and
 * the subscription are disposed on deactivation.
 */
export function startFleetPolling(options: {
  intervalMs?: number;
  selected?: () => string | null | undefined;
  rows: () => readonly AgentRowView[];
  hasRunning?: (rows: readonly AgentRowView[]) => boolean;
  repaint: () => void;
  subscribe: (listener: () => void) => () => void;
}): { dispose(): void; renderKey(): string } {
  const intervalMs = Math.max(5, options.intervalMs ?? 500);
  const hasRunning = options.hasRunning ?? (rows => indicatorRows(rows).some(row => row.status === "running" || row.status === "starting"));
  let key = "";
  const tick = () => {
    const rows = options.rows();
    const next = indicatorRenderKey(rows, options.selected?.());
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
