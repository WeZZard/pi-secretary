import type { Component } from "@earendil-works/pi-tui";
import { active, fleetRows } from "./reducer.ts";
import type { UiState } from "./state.ts";
import { clip } from "./transcript.ts";
export class FleetView implements Component {
  private readonly state: () => UiState;
  constructor(state: () => UiState) { this.state = state; }
  invalidate(): void {}
  render(width: number): string[] {
    const s = this.state(), rows = fleetRows(s);
    if (s.navigation.kind === "inactive" || !rows.length) return [];
    const summary = `${rows.filter(a => active(a) && a.run?.status !== "queued").length} active agents · ${rows.filter(a => a.run?.status === "queued").length} queued · ↓/← inspect · /agents`;
    if (s.navigation.kind !== "fleet") return [clip(summary, width)];
    const selected = s.navigation.selectedAgentId;
    const index = rows.findIndex(a => a.agent.agentId === selected);
    return [summary, `${selected === null ? ">" : " "} main`, ...rows.slice(Math.max(0, index - 5), Math.max(10, index + 5)).map(a => `${a.agent.agentId === selected ? ">" : " "} ${a.agent.name ?? a.agent.definition.name} · ${a.run?.description ?? a.agent.agentId} · ${a.run?.status ?? "idle"} · ${a.agent.model}`)].map(l => clip(l, width));
  }
}
