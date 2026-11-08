/** Return Secretary's run-shaped tool details in tests without weakening production tool types. */
export function runDetails(result: { details?: unknown }): any {
  return result.details as any;
}
