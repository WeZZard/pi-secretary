# Fleet cancellation UI

## Scope and design references

- The user requested X to stop the selected agent and Ctrl+X to stop the current parent fleet. Both shortcuts remain visible whenever the bottom list appears.
- The parent owns the shared documentation updates in [UX Section 2.2](../docs/ux/subagents.md), Section 3.3, and Section 4. These sections describe the indicator, confirmation, and key mappings.
- The parent also owns [architecture Section 12.1](../docs/arch/subagents.md) and Section 12.6.3. These sections describe cancellation state, receipt reconciliation, and indicator input routing.
- This work changes UI code, its tests and acceptance bindings, and the explicitly authorized `stopMany` service and installation wiring. It does not change model selection or other installation behavior.

## Implementation

- [x] Route x and Shift+X to selected-agent confirmation only while the fleet list or inspector owns input. Preserve editor and composer text. This implements UX Sections 2.2, 3.3, and 4.
- [x] Route Ctrl+X to fleet confirmation when this parent has active top-level agents. Leave unrelated modal input and idle Ctrl+X to the host. This implements UX Sections 2.2 and 4 and architecture Section 12.6.3.
- [x] Preserve Shift+D as a compatibility alias. Move default tool expansion to o and Ctrl+O, and continue honoring the host's configured expansion action. Reject configured overlay actions that claim the reserved cancellation keys. This implements UX Section 4.
- [x] Add a separate `confirming-all` dialog that captures immutable `StopTarget` values. Filter finished or replaced executions at submission without adding later admissions. Keep pending operation identity and reconcile receipts without repeating mutations. This implements UX Section 3.3 and architecture Section 12.1.
- [x] Add `AgentUIPort.stopMany(runIds, operationId)` and wire the installed UI to `AgentService.stopMany`. Validate all exact parent-owned IDs before mutation, commit all cancellation states and the receipt before publishing changes, and abort children only afterward. This implements architecture Section 12.1.
- [x] Keep cancellation acceptance distinct from observed termination. A noncooperative running child stays `cancelling`; captured queued runs become `cancelled` without starting. This implements UX Section 3.3 and architecture Section 12.1.
- [x] Preserve the hidden idle indicator and remove departed selected IDs rather than redirecting X to another row. This implements UX Section 2.2 and architecture Section 12.6.3.
- [x] Bind acceptance scenarios ACC-SA-UI-18 through ACC-SA-UI-20 to the selected-stop, captured-fleet, and uncertain-receipt contracts.

## Reproduction and verification

- `tests/agents/fleet-cancellation.test.ts` runs the production registration adapter, input listener, Inspector, reducer, effect runner, and both real Pi TUI renderers against a headless terminal. Only the extension context facade and service boundary are fixtures. Its original eight regressions failed before the implementation and passed afterward.
- The failing terminal assertions established that selected X did not open confirmation, Ctrl+X did not open fleet confirmation, overlay X retained the former expansion behavior, and the bottom list had no cancellation hints.
- `tests/agents/stop-many.test.ts` exercises the production service, SQLite repository, queue, commit notifications, and receipts with controlled child execution. Before `stopMany`, the concurrent per-run fallback exposed a partially cancelled queue to listeners. After the batch commit, every notification observes the whole captured batch in cancellation states, and captured queued runs never reach the child runner.
- The service test deliberately rejects child abort acknowledgment and delays settlement. It verifies that cancellation acceptance remains recorded, later targets are not abandoned, and the noncooperative child is not reported as terminated.
- Additional UI tests cover editor and composer drafts, unrelated modal and idle host fallback, replacement exclusion, selected-row removal, repeated cancellation after dismissal, and partial per-run receipt reconciliation.
- Run focused checks with `npm run check`, `node --experimental-strip-types --test --test-concurrency=1 tests/agents/{fleet-cancellation,stop-many,ui,inspector,fleet-view,keybindings,service,installation}.test.ts tests/tui/agents-ui-config-fault.test.ts tests/acceptance/ui.test.ts`, and `npm run lint:acceptance`.
- Generated logs remain under ignored `test-results/fleet-cancellation/`. The parent runs the full repository gate and owns the shared verification report.

## Compatibility and verification limits

- Pi's default Ctrl+X copies a message. Fleet cancellation intentionally takes precedence while the fleet is active. The installed keybinding file has no tool-expansion override, so the host expansion key remains Ctrl+O.
- The optional port fallback dispatches exact run IDs concurrently with stable per-run receipt IDs and aggregates partial outcomes. It does not guarantee a queue admission barrier. The installed production adapter supplies `stopMany` instead.
- Cancellation continues to use the existing top-level abort and child-session shutdown path for descendant cleanup. This change does not introduce a separate descendant termination protocol.
- These deterministic checks are not a live-provider run, a foreground terminal recording, or human interface approval. Hints still require enough physical terminal columns to display their text.
