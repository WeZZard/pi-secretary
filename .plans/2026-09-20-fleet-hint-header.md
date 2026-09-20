# Single focus-dependent fleet hint

## Contract

- [UX Section 2.2](../docs/ux/subagents.md#22-fleet-indicator) requires one hint line above the agent rows. Editor focus shows the empty-editor Down-arrow instruction; fleet focus replaces it with the cancellation shortcuts.
- [Architecture Section 12.6.3](../docs/arch/subagents.md#1263-fleet-indicator-and-overlay-view-models) makes the header a single clipped row before the bounded agent window. Focus changes do not change the widget height.

## Implementation and verification

- Added real main-screen and alternate-screen input-routing regressions in `tests/agents/fleet-cancellation.test.ts`. Both failed before the change because the widget began with the main row instead of the hint.
- Changed `FleetView.render()` to prepend the focus-dependent hint rather than append two hints. Existing cancellation behavior and idle hiding are unchanged.
- Updated component row assertions and ACC-SA-UI-18 to verify hint replacement, placement, focus return, and constant height. Revised its reviewed feature hash after updating assertions.
- `npm run verify` passes all 676 tests, TypeScript checking, all 28 Mermaid blocks, and acceptance syntax validation for 11 feature files and 110 scenario identities.
- Generated output remains under ignored `test-results/fleet-hint/`. No live provider or human visual approval is claimed.
- Pre-existing unrelated changes in `docs/ux/subagents.md` were preserved.
