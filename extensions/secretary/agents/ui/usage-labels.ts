import type { UsageRecord } from "../records.ts";

/**
 * Widget usage labels (architecture §12.6.3). These are display quantities derived from persisted
 * usage events. They are NOT the goal-budget formula of §11.2 and must never be reused for it.
 * Unknown usage is omitted rather than shown as zero.
 */
export interface UsageLabels {
  /** Latest assistant turn's input plus cache-read tokens. Omitted when per-turn reporting is unavailable. */
  windowTokens?: number;
  /** Accumulated input-plus-output total across persisted usage events. */
  cumulativeTokens?: number;
}

function field(usage: UsageRecord["usage"], key: keyof UsageRecord["usage"]): number | undefined {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function deriveUsageLabels(records: readonly UsageRecord[]): UsageLabels {
  if (!records.length) return {};
  const latest = records.at(-1)!.usage;
  const input = field(latest, "inputTokens");
  const cached = field(latest, "cachedInputTokens");
  const windowTokens = input !== undefined && cached !== undefined ? input + cached : undefined;
  let cumulative = 0;
  let known = false;
  for (const record of records) {
    const inTokens = field(record.usage, "inputTokens");
    const outTokens = field(record.usage, "outputTokens");
    if (inTokens === undefined && outTokens === undefined) continue;
    cumulative += (inTokens ?? 0) + (outTokens ?? 0);
    known = true;
  }
  return { ...(windowTokens !== undefined ? { windowTokens } : {}), ...(known ? { cumulativeTokens: cumulative } : {}) };
}

const compact = (value: number): string => value >= 1_000_000
  ? `${(value / 1_000_000).toFixed(1)}M`
  : value >= 1000
    ? `${(value / 1000).toFixed(1)}k`
    : `${Math.max(0, Math.round(value))}`;

/** One display fragment per label; absent labels contribute nothing. */
export function formatUsageLabels(labels: UsageLabels & { windowCount?: number }): string[] {
  const parts: string[] = [];
  if (labels.windowTokens !== undefined) parts.push(`↓ ${compact(labels.windowTokens)} ${(labels.windowCount ?? 1) > 1 ? "Σ windows" : "window"}`);
  if (labels.cumulativeTokens !== undefined) parts.push(`${compact(labels.cumulativeTokens)} spent`);
  return parts;
}

/** Aggregate row labels for collapsed summaries; a contributor count above one marks the window as a sum. */
export function aggregateUsageLabels(rows: readonly UsageLabels[]): UsageLabels & { windowCount: number } {
  let windowTokens = 0, windowCount = 0, cumulativeTokens = 0, cumulativeCount = 0;
  for (const row of rows) {
    if (row.windowTokens !== undefined) { windowTokens += row.windowTokens; windowCount++; }
    if (row.cumulativeTokens !== undefined) { cumulativeTokens += row.cumulativeTokens; cumulativeCount++; }
  }
  return { ...(windowCount ? { windowTokens } : {}), windowCount, ...(cumulativeCount ? { cumulativeTokens } : {}) };
}

export function formatElapsed(startedAt: number | undefined, now: number): string | undefined {
  if (startedAt === undefined || !Number.isFinite(startedAt)) return undefined;
  return `${Math.max(0, Math.round((now - startedAt) / 1000))}s`;
}
