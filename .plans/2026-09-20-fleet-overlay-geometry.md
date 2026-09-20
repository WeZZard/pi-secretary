# Fleet overlay geometry repair

## Scope and design

- This amendment implements the stable frame and pane proportions in [UX Section 2.4](../docs/ux/subagents.md#24-fleet-view-overlay) and the exact sizing contracts in [architecture Section 12.6.4](../docs/arch/subagents.md#1264-fleet-view-overlay-presentation-components).
- It supersedes the label-dependent navigation width in the [unified fleet plan](2026-09-19-unified-fleet-indicator.md), without changing runtime delegation or operation semantics.
- The overlay height is `min(terminalRows, max(18, floor(terminalRows * 0.618)))`, bounded below by one row. The minimum takes precedence over the proportional target on short terminals, but never exceeds the physical terminal height.

## Reproducer and confirmed causes

- `tests/agents/inspector.test.ts` routes keyboard input through pi's real TUI renderer and reducer, composes the real Inspector overlay, and checks ANSI output through `@xterm/headless`. Agent records and transcript arrivals are deterministic fixtures; neither the Inspector nor the overlay compositor is mocked.
- Before the repair, three regression cases failed: body rows lacked the right border, loading changed the centered frame's top row, and navigation failed its minimum width.
- The wide-row formatter reserved too few columns for the frame and separator. Its final truncation removed the right border. Correcting only that reservation made the border regression pass while the height and proportion regressions still failed.
- Rendering only occupied body rows changed the centered overlay's height between ready and loading states. The label-dependent list width also allowed navigation to shrink to eight columns.

## Delivery steps

1. Repair the row width budget in `extensions/secretary/agents/ui/inspector.ts` to satisfy architecture Section 12.6.4's complete-frame invariant. Verify the rightmost terminal cell, rather than merely checking that rows do not exceed the available width.
2. Apply viewport-based height in `extensions/secretary/agents/ui/commands.ts` and pad the Inspector body, feedback, and dialogs to satisfy UX Section 2.4's stable-position contract. Verify ready, loading, empty transcript, dialog, and terminal-resize states.
3. Replace label-dependent sizing with the navigation bounds and transcript minimum from architecture Section 12.6.4. The user's follow-up corrects the initial interpretation: navigation is bounded to 20–40 columns, and 61.8% is a transcript minimum rather than a maximum. Keep the selected roster row visible in bounded list viewports. Verify wide, narrow, Unicode, and overflowing-roster cases.
4. Extend the reviewed ACC-SA-02-12 assertions in `tests/acceptance/ui.test.ts` before updating the feature binding hash. These assertions make the revised [acceptance specification](../doc/acceptance/agent-inspection.feature) executable.
5. Run TypeScript checking, the regression suite, and documentation validation. Record concise results and limits in the [verification report](../docs/testing/subagent-verification.md), not generated terminal output in documentation.

## Composer and scrolling follow-up

- Share the top-border formatter between inspection and dialogs to implement the complete-frame contract in [UX Section 4](../docs/ux/subagents.md#4-navigation-and-accessibility) and architecture Section 12.6.4. The real-TUI composer test must fail for a blank rule and pass for a title surrounded by horizontal border glyphs.
- Decode dialog Enter and Escape with pi-tui's keyboard matcher to implement architecture Section 12.6.4's protocol-independent dialog handling. Real-TUI tests must close the composer for legacy and CSI-u Escape, retain its draft without dispatching a message, and return to the editor only on a subsequent Escape. Protocol-encoded Enter must dispatch only once.
- Consume wheel events while a dialog owns input, and retain transcript and roster wheel routing in the alternate-screen host, as specified by UX Section 2.4 and architecture Section 12.6.4. Feed SGR wheel sequences through the real host and verify that transcript content moves, selection remains unchanged over the transcript, and returning to the end restores following. Main-screen mode retains terminal scrollback.
- Prioritize keyboard page-scroll hints in the footer under UX Section 2.4. Verify visible hints and Page Up/Page Down through both host renderers.

## Exit criteria and limits

- Both pi main-screen and alternate-screen renderers retain complete borders and unchanged frame coordinates across selection, loading, and empty transcript states.
- Terminal resizing recalculates the frame and preserves borders in the stacked layout.
- Generated test output remains under ignored `test-results/`. No recording or screenshot from this run is promoted to an expected baseline.
- Automated terminal-cell checks do not establish human visual approval or reproduce a particular terminal application's animation timing. No live model request is needed for these layout regressions.
