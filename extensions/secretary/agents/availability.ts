/**
 * Availability failure classification and the per-parent-session availability cache
 * (subagent architecture §5.3). Only availability failures — rate limiting, quota
 * exhaustion, provider-side cooldown, and unknown-model responses — advance a
 * fallback chain. Content rejections, tool errors, and timeouts never do.
 */

const AVAILABILITY_PATTERN = /429|rate.?limit|throttl|usage.?limit|quota|cool[a-z]*[\s-]?down|insufficient|unknown model/i;
const RESET_PATTERN = /reset_seconds["']?\s*[:=]\s*(\d+)/;

/** Classify a provider or launch error. Availability failures may advance a fallback chain. */
export function isAvailabilityError(message: string): boolean {
  return AVAILABILITY_PATTERN.test(message);
}

/** Parse a provider-reported `reset_seconds` hint into an absolute timestamp. */
export function availabilityResetAt(message: string, now = Date.now()): number | undefined {
  const match = RESET_PATTERN.exec(message);
  return match ? now + Number(match[1]) * 1000 : undefined;
}

/**
 * Per-parent-session record of candidates observed cooling down or quota-limited.
 * Later launches skip recorded candidates until their reset time passes; a failure
 * without a reset time lasts for the session.
 */
export class ModelAvailability {
  private readonly entries = new Map<string, number | undefined>();
  private readonly clock: () => number;
  constructor(clock: () => number = () => Date.now()) { this.clock = clock; }
  record(id: string, resetAt?: number): void {
    this.entries.set(id, resetAt);
  }
  /** Return the skip reason while the candidate is unavailable, or undefined once it may be retried. */
  unavailable(id: string): string | undefined {
    if (!this.entries.has(id)) return undefined;
    const resetAt = this.entries.get(id);
    if (resetAt === undefined) return "cooling down or quota-limited (recorded this session)";
    const remaining = resetAt - this.clock();
    if (remaining <= 0) { this.entries.delete(id); return undefined; }
    return `cooling down for another ${Math.ceil(remaining / 1000)}s (recorded this session)`;
  }
}
