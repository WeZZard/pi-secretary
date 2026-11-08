import assert from "node:assert/strict";

/** Reject persisted request-context envelopes without matching the marker inside tool schemas. */
export function assertNoPersistedRequestContext(transcript: string): void {
  for (const line of transcript.split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line) as { customType?: unknown; message?: { customType?: unknown } };
    assert.notEqual(entry.customType, "secretary:request-context");
    assert.notEqual(entry.message?.customType, "secretary:request-context");
  }
}
