# Unified Fleet Indicator and Fleet View Overlay: Implementation Plan

**Project:** pi-secretary.

**Document type:** Implementation plan.

**Status:** Implemented, 2026-09-19. Stages 1 and 2 are complete: `npm run verify` passed with 591 tests, 158 acceptance scenarios, and 104 validated scenario identities; evidence is recorded in the [verification report](../docs/testing/subagent-verification.md). This document organized delivery against agreed design and introduced no new product behavior or technical protocol beyond the cited documents.

**Planning baseline:** the documentation revisions of 2026-09-19 that replace FleetView and the async widget with the unified fleet indicator and the split fleet view overlay: [requirements SA-02, SA-10, and SA-12](../docs/user-stories/subagents.md), [interaction design §2.2–2.4 and §4](../docs/ux/subagents.md#22-fleet-indicator), and [architecture §12, §12.1, and §12.6](../docs/arch/subagents.md#12-tui-implementation-boundary). The motivating defect is the duplicated agent display of 2026-09-19: the same background agent renders once in FleetView's focus-gated rows and again in the always-on async widget, with opposite visibility rules.

## 1. Authority and scope

- The [requirements](../docs/user-stories/subagents.md) define the required outcomes: [SA-02](../docs/user-stories/subagents.md#sa-02-observe-concurrent-work) (one list showing current-session work), [SA-10](../docs/user-stories/subagents.md#sa-10-recognize-delegated-work-through-the-ported-presentation) (ported presentation), and [SA-12](../docs/user-stories/subagents.md#sa-12-delegate-nested-work) (nested delegation).
- The [interaction design](../docs/ux/subagents.md) defines the visible behavior: [§2.2](../docs/ux/subagents.md#22-fleet-indicator) (the always-visible indicator: main row, non-terminal top-level agents, selection circles, status text labels, immediate removal of terminal rows), [§2.3](../docs/ux/subagents.md#23-async-widget-removed) (async widget removed), [§2.4](../docs/ux/subagents.md#24-fleet-view-overlay) (the vertically split overlay: one drill level, subagents only, `a` filter, transcript follows selection, optional host-dependent wheel scrolling), and [§4](../docs/ux/subagents.md#4-navigation-and-accessibility) (the key table).
- The [architecture](../docs/arch/subagents.md) defines the mechanisms: [§12.1](../docs/arch/subagents.md#121-ui-state-model) (navigation state machine, `InspectorLevel` drill path and filter, transitions UI-01 through UI-15), [§12.6.3](../docs/arch/subagents.md#1263-fleet-indicator-and-overlay-view-models) (view models with parent agent identity, indicator polling and render key), [§12.6.4](../docs/arch/subagents.md#1264-fleet-view-overlay-presentation-components) (split panes, 32-column list cap, bounded breadcrumb), and [§12.6.5](../docs/arch/subagents.md#1265-ui-configuration) (configuration, including the ignored `asyncWidget` key and the `drillIn`/`drillOut`/`toggleFinished` actions).
- The [documentation guide](../docs/README.md) defines document responsibilities, and the [test artifact policy](../docs/testing/test-artifacts.md) governs where generated output goes.

### Staging

Stage 1 delivers the unified indicator and the split overlay against the existing runtime; because no agent can have children yet, drilling is never available and the overlay shows only its root level. Stage 2 delivers nested delegation in the runtime and enables drill-down. Stage 2 begins only after Stage 1 exit criteria pass. Each stage is separately reviewable and revertible.

### Out of scope

- The below-editor indicator shows no nested tree, no activity sub-line, and no aggregate info bar; those presentations were considered and rejected in design discussion.
- Mouse wheel scrolling is host-dependent and optional per [UX §2.4](../docs/ux/subagents.md#24-fleet-view-overlay); it is implemented behind the host's mouse capture and is not a release blocker.
- No foreground detach, prompt audit, or external inspector surfaces; [§12.6.6](../docs/arch/subagents.md#1266-excluded-surfaces) is unchanged.

## 2. Stage 1: Unified indicator and split overlay

### Phase U1: Unified fleet indicator

- **File targets:** `extensions/secretary/agents/ui/fleet-view.ts` (rewrite), `extensions/secretary/agents/ui/async-widget.ts` (delete), `extensions/secretary/agents/ui/commands.ts` (single widget registration), `extensions/secretary/agents/ui/glyphs.ts` (selection circles), `extensions/secretary/agents/configuration.ts` (`asyncWidget` recognized and ignored), `tests/agents/fleet-view.test.ts` (rewrite), `tests/agents/async-widget.test.ts` (delete).
- **Design implemented:** [UX §2.2 and §2.3](../docs/ux/subagents.md#22-fleet-indicator); [architecture §12 intro and §12.6.3](../docs/arch/subagents.md#1263-fleet-indicator-and-overlay-view-models).
- **Dependencies:** none.
- **Work:**
  - Render the main row always, then non-terminal top-level rows in creation order; remove a row immediately on terminal status.
  - Render the selection circle (`○`/`●`, accent color permitted on the filled circle) and status as a text label; retire the status-glyph alphabet from these rows.
  - Move the bounded polling timer and render-key deduplication from the async widget onto the indicator; dispose both on deactivation.
  - Register exactly one widget under the existing fleet key with the configurable placement; delete the async widget key, fold behavior, and mouse handler.
  - Accept and ignore `agents.ui.asyncWidget` so existing configurations remain valid; unknown-key rejection is otherwise unchanged.
- **Tests:** render tests for the idle main-only list, row append order, immediate removal on terminal status, circle semantics without color dependence, right-aligned usage realignment after resize, and render-key deduplication; configuration tests for the ignored key.
- **Exit criteria:** the rewritten suites pass and no code path registers a second below-editor agent widget.

### Phase U2: Indicator navigation

- **File targets:** `extensions/secretary/agents/ui/reducer.ts`, `extensions/secretary/agents/ui/state.ts`, `extensions/secretary/agents/ui/commands.ts` (editor key capture), `tests/agents/fleet-view.test.ts`, `tests/acceptance/ui.test.ts`.
- **Design implemented:** [architecture §12.1.1 and §12.1.4](../docs/arch/subagents.md#1211-navigation-state-machine) (UI-01 revision), [UX §4](../docs/ux/subagents.md#4-navigation-and-accessibility).
- **Dependencies:** U1.
- **Work:**
  - Down in an empty focused editor enters the list and selects the first row; Left no longer activates.
  - Up/Down move the selection; Up on the first row and Escape return focus to the editor; Enter opens the overlay on the selected row (the root level when the main row is selected).
- **Tests:** transition-table and model-based reducer tests for the revised UI-01 and the new exit transitions; acceptance bindings for ACC-SA-02-02 and ACC-SA-02-02a/b/c.
- **Exit criteria:** the acceptance scenarios ACC-SA-02-01 through ACC-SA-02-03 pass with executable bindings.

### Phase U3: Split fleet view overlay

- **File targets:** `extensions/secretary/agents/ui/inspector.ts` (split layout, breadcrumb title, filter), `extensions/secretary/agents/ui/keybindings.ts` (`drillIn`, `drillOut`, `toggleFinished`), `extensions/secretary/agents/ui/state.ts` and `reducer.ts` (`InspectorLevel`, UI-13/14/15), `tests/tui/` layout snapshot baselines.
- **Design implemented:** [UX §2.4](../docs/ux/subagents.md#24-fleet-view-overlay); [architecture §12.1.6](../docs/arch/subagents.md#1216-internal-state-representation) and [§12.6.4](../docs/arch/subagents.md#1264-fleet-view-overlay-presentation-components).
- **Dependencies:** U2 (Enter opens the overlay).
- **Work:**
  - Wide terminals: left navigation list sized to the longest visible row label and capped at 32 columns, transcript pane on the right; narrow terminals keep the stacked fallback; below 36 columns keep the diagnostic line.
  - List shows subagents only, active and queued by default; rows render only the selection circle and the agent name; `a` toggles terminal agents at every level; selection moves to the nearest remaining row if its row leaves the list.
  - Title row carries the bounded breadcrumb (root label `Agents`, current level, nearest ancestor, middle elided as `…`) and the active count.
  - The transcript pane renders a fixed status header above its scroll viewport: name, status label, and stats on the first line, current activity on the second, one divider, no enclosing box; the header is excluded from the scroll anchor and follow state.
  - The transcript pane follows the selection; `s`, `D`, `r`, tool expansion, and scrolling are unchanged.
  - Drill actions exist in the state machine but are inert in Stage 1 because no row has children (UI-13's guard is never satisfiable); this must be covered by a reducer test so Stage 2 is a pure enablement.
  - Optional: wheel scrolling via the host's mouse capture, driving the existing transcript-following machine.
- **Tests:** layout snapshot baselines for the split and narrow fallbacks, breadcrumb bounding, and the 32-column cap; reducer tests for UI-13/14/15 including the Stage 1 inert guard; acceptance bindings for ACC-SA-02-11 and ACC-SA-02-12.
- **Exit criteria:** ACC-SA-02-11 and ACC-SA-02-12 pass; the recorded UI walkthrough covers the indicator, the overlay, resize, and focus return; visual verification is recorded separately from test execution per the [test artifact policy](../docs/testing/test-artifacts.md).

## 3. Stage 2: Nested delegation

### Phase N1: Runtime nested delegation

- **File targets:** `extensions/secretary/agents/tools/` (`Agent` registration by depth), `extensions/secretary/agents/records.ts` and storage (`parentAgentId` on `AgentRecord`), `extensions/secretary/agents/service.ts` (tree-wide stop and shutdown), `tests/agents/` and `tests/service/`.
- **Design implemented:** [SA-12](../docs/user-stories/subagents.md#sa-12-delegate-nested-work); [architecture §6.1](../docs/arch/subagents.md#61-entities), [§7.3](../docs/arch/subagents.md#73-limits-and-partial-output) (maximum depth three below the main session), and [§7.4](../docs/arch/subagents.md#74-shutdown-and-cancellation).
- **Dependencies:** Stage 1 complete.
- **Work:**
  - Child sessions below the maximum depth receive the delegation tools; at the maximum depth the tools are not registered, and direct launch attempts fail with an actionable error.
  - Record the parent agent identity at launch and publish it through the view models of §12.6.3.
  - Stopping an agent requests cancellation of its nested children before the parent settles; session shutdown stops the whole tree.
  - Goal attribution is unchanged; nested usage flows through the existing §11.2 formula.
- **Tests:** launch tests for depth registration and maximum-depth rejection, parent recording, tree-wide shutdown, and goal attribution; migration or default-value handling for records that predate `parentAgentId`.
- **Exit criteria:** the new runtime tests pass and existing delegation, cancellation, and session-recovery suites stay green.

### Phase N2: Overlay drill-down enablement

- **File targets:** `extensions/secretary/agents/ui/inspector.ts`, `reducer.ts`; no schema changes.
- **Design implemented:** [UX §2.4](../docs/ux/subagents.md#24-fleet-view-overlay) drill-down bullets; transitions UI-13/14/15; acceptance scenarios ACC-SA-02-13 and ACC-SA-02-14.
- **Dependencies:** N1.
- **Work:** group overlay rows by parent agent identity into drill levels; make Enter/Right drill in and Left drill out with selection restoration; the indicator continues to list top-level agents only.
- **Tests:** ACC-SA-02-13 and ACC-SA-02-14 bindings; reducer tests with real nested fixtures replacing the Stage 1 inert-guard test.
- **Exit criteria:** the drill-down acceptance scenarios pass, and the recorded walkthrough covers a two-level hierarchy.

## 4. Verification and release conditions

- Every phase keeps the full non-e2e suite green; acceptance scenario changes are bound before their phase is declared complete.
- Generated walkthrough recordings go to the ignored `test-results/` directory with a fresh directory per run, per the [test artifact policy](../docs/testing/test-artifacts.md); the [verification report](../docs/testing/subagent-verification.md) records dated executed checks and remaining limits rather than copied output.
- Human visual approval of the indicator and overlay is a separate recorded step and is not established by passing tests.
- Historical plans and their section citations are not rewritten; this plan supersedes the UI portions of the [TUI port plan](2026-09-18-subagent-tui-port.md) going forward.
