import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { active, fleetRows } from "./reducer.ts";
import type { AgentRowView } from "../records.ts";
import type { UiState } from "./state.ts";
import { clip } from "./transcript.ts";
import { statusGlyph } from "./glyphs.ts";
import { aggregateUsageLabels, formatElapsed, formatUsageLabels } from "./usage-labels.ts";

function rightAlign(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const maxLeftWidth = Math.max(0, width - rightWidth - 1);
  const leftClamped = truncateToWidth(left, maxLeftWidth, "");
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
  return truncateToWidth(`${leftClamped}${" ".repeat(gap)}${right}`, width, "");
}

/** FleetView renders the reducer's session state; view-model rows come from the service through the port. */
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
    const s = this.state(), snapshots = fleetRows(s);
    if (s.navigation.kind === "inactive" || !snapshots.length) return [];
    const theme = this.theme;
    const published = this.viewRows?.();
    const rows: AgentRowView[] = published?.length ? published.filter(row => snapshots.some(a => a.agent.agentId === row.agentId)) : snapshots.map(a => ({
      agentId: a.agent.agentId, name: a.agent.name, status: a.run?.status ?? "idle" as const,
      description: a.run?.description ?? a.agent.definition.description, model: a.agent.model,
      ...(a.run?.startedAt !== undefined ? { startedAt: a.run.startedAt } : {}),
      ...(a.run?.activity !== undefined ? { activity: a.run.activity } : {}),
      background: a.run?.background ?? false,
    }));
    const usage = formatUsageLabels(aggregateUsageLabels(rows));
    const counts = `${rows.filter(a => active(snapshots.find(snap => snap.agent.agentId === a.agentId)!) && a.status !== "queued").length} active agents · ${rows.filter(a => a.status === "queued").length} queued`;
    const summary = clip(`${counts}${usage.length ? ` · ${usage.join(" · ")}` : ""} · ↓/← inspect · /agents`, width);
    if (s.navigation.kind !== "fleet") return [summary];
    const selected = s.navigation.selectedAgentId;
    const index = rows.findIndex(a => a.agentId === selected);
    const visible = rows.slice(Math.max(0, index - 5), Math.max(10, index + 5));
    const renderRow = (row: (typeof rows)[number]) => {
      const marker = row.agentId === selected ? ">" : " ";
      const name = row.name ?? row.agentId;
      const right = [formatElapsed(row.startedAt, this.now()), ...formatUsageLabels(row)].filter(Boolean).join(" · ");
      const left = `${marker} ${statusGlyph(row.status, theme)} ${name} · ${row.description} · ${row.status}`;
      return right ? rightAlign(left, right, width) : clip(left, width);
    };
    return [summary, `${selected === null ? ">" : " "} main`, ...visible.map(renderRow)].map(l => width <= 0 ? "" : truncateToWidth(l, width, ""));
  }
}
