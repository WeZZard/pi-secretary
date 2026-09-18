import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RunStatus } from "../records.ts";

/** Themed status glyphs; color is never the only channel because the glyph itself differs per status. */
export function statusGlyph(status: RunStatus | "idle", theme?: Theme): string {
  const glyph = status === "queued" ? "◦"
    : status === "starting" || status === "running" ? "●"
    : status === "cancelling" ? "■"
    : status === "succeeded" ? "✓"
    : status === "partial" ? "■"
    : status === "failed" ? "✗"
    : status === "interrupted" ? "!"
    : status === "cancelled" ? "✗"
    : "○";
  if (!theme) return glyph;
  const color = status === "queued" ? "muted"
    : status === "starting" || status === "running" ? "accent"
    : status === "succeeded" ? "success"
    : status === "failed" || status === "interrupted" ? "error"
    : status === "cancelling" || status === "partial" ? "warning"
    : "dim";
  return theme.fg(color, glyph);
}
