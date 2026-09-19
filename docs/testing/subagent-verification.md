# Subagent Verification Report

**Document type:** Dated verification report, not a release approval or test procedure.

**Reviewed implementation:** `01f851a`, including the authentication, workspace, and child UI fixes.

**Execution date:** 2026-09-18 for the latest regression and real-provider runs summarized below. Earlier terminal and packaging observations are identified separately.

**Related documents:** [Architecture](../arch/subagents.md), [requirements](../user-stories/subagents.md), [interaction design](../ux/subagents.md), [testing guide](README.md), and [delivery record](../../.plans/2026-09-17-subagent-support.md).

## 2026-09-19: Model fallback lists and the `/secretary` configuration menu

**Reviewed implementation:** the working tree implementing the [model fallback lists plan](../../.plans/2026-09-19-model-fallback-lists.md) phases P1–P3, including the same-day presentation amendment that restyled the menu from a bordered overlay to pi's native full-screen selector presentation. **Execution date:** 2026-09-19.

| Check | Observed result | Verification limit |
| --- | --- | --- |
| `npm run check` | TypeScript checking passed. | Static checking only. |
| `npm run test:subagents` | All 161 tests passed, including availability classification, chain resolution, runner fallback, persistence, and the headless `/secretary` wiring test. | Deterministic providers and fixtures, not real providers. |
| `npm run test:acceptance` | All 148 scenarios passed, including the rewritten ACC-SA-07-01/02/03 and the new ACC-SA-07-09 ordered-fallback scenario. | Scenario bindings are reviewed adapters, not independent specification. |
| TUI suites | All 75 tests passed, including the menu interaction tests and the eight reviewed rendered-layout baselines in `tests/tui/secretary-menu-snapshots.test.ts`. | Baselines are reviewed captures of the implemented layout; layout changes require updating them with review. |
| `npm run lint:acceptance` and `npm run lint:mermaid` | 10 Gherkin files with 94 scenario identities validated; 27 Mermaid blocks valid. | Syntax and traceability checks, not behavioral execution. |
| TUI walkthrough recording | Run `test-results/tui/20260919T061043Z-efb4d51f` completed 19 checkpoints; replay assertions passed for all checkpoints, including the seven menu checkpoints (07b–07h). | The walkthrough runs real Pi with a deterministic provider. A recorded walkthrough is not human visual approval; replay does not run a model. |

The recording's screen assertions cover the menu's top level, list manager, name prompt, list creation, list detail, filtered model picker, and model addition. Human visual approval of the menu remains unrecorded and separate.

## Scope and provenance

The implementation is committed through `01f851a`. That does not establish package publication, deployment into every user's active session, or human visual approval.

The latest behavioral runs tested the UI fix and strengthened interactive assertions before they were committed. Subsequent changes moved the case files under `cases/interactive/` and `cases/non-interactive/` and renamed the npm commands. Type checking was repeated after those path and command changes; the paid-provider scenarios were not rerun solely for those changes. Commands below identify the current reproduction entry points, not a claim that their final names were used in the earlier runs.

Generated logs and recordings remain under ignored `test-results/`. They are not distributed with a clean clone. Use the linked procedures to reproduce them; do not treat an absent local recording as a reviewed baseline.

## Executed verification

| Check | Observed result | Verification limit |
| --- | --- | --- |
| `npm run verify` | All 429 tests passed, TypeScript checking passed, all 26 Mermaid blocks validated, and 10 Gherkin files with 89 scenario identities validated. | Diagram and Gherkin linting are syntax checks, distinct from the executable tests. |
| Headless real-provider matrix | All six repository-state and isolation combinations passed with Secretary and LiteLLM. | The runs use one configured model and provider installation, not a provider compatibility matrix. |
| Widget-enabled headless matrix | All six combinations passed with `pi-recap` and `rpiv-todo` enabled. | Other extension combinations remain unverified. |
| Interactive real-provider test | The committed-project isolated spawn passed. The parent remained a TUI, and the child read the fixture and completed using the native headless UI context. | This is an owned pseudo-terminal test, not a desktop-window test or human approval. |
| Real-SDK UI regressions | Startup, resumption, concurrent children, cancellation, idempotent shutdown, optional dialog cancellation, UI-required tool rejection, and genuine startup failure propagation passed. | The unit fixtures use deterministic providers and purpose-built extensions. |
| Recovery regressions | The full suite includes SDK overflow compaction, transient-error retry, cancellation during compaction, and persisted usage-source tests. | These do not establish every external provider's recovery behavior. |

The real-provider runs used Pi 0.85.1, `pi-provider-litellm` 3.1.0, `litellm/gpt-6-astra`, `pi-recap` 0.8.21, and `@juicesharp/rpiv-todo` 2.10.1. The interactive profile limits its catalog to the selected real test model; the [E2E guide](subagent-e2e.md) explains that restriction.

Earlier implementation work recorded a successful deterministic terminal walkthrough and `npm pack --dry-run`. Neither was repeated as part of the child UI fix. A packaging dry run is not a packaged installation test, and a recorded walkthrough is not human visual approval.

## Implementation and test map

| Responsibility | Implementation | Verification source |
| --- | --- | --- |
| Tool registration, parent lifecycle, and goal integration. | `installation.ts` and `service.ts` compose the subsystem. | `tests/agents/installation.test.ts`, `service.test.ts`, and `goal-integration.test.ts` exercise the boundaries. |
| Definitions, trust, and model resolution. | `configuration.ts`, `registry.ts`, and `tools/schemas.ts` define the contracts. | Configuration and schema tests cover precedence, metadata-only definitions, and configured-only aliases. |
| Child execution and authentication. | `runner.ts` delegates authentication and composes SDK execution hooks. | Runner tests cover provider-registration ordering, later replacement rejection, permissions, guidance, limits, and resumption. |
| Workspace allocation and cleanup. | `workspaces.ts` selects directory snapshots or `worktrees.ts` Git allocation. | `tests/agents/workspaces.test.ts` and `worktrees.test.ts` cover bounds, ownership, preserved changes, and conservative cleanup. |
| Persistence and ownership. | `storage/` implements additive records, transactions, receipts, and parent locking. | Storage, service, and recovery tests cover ownership and interruption handling. |
| Parent presentation. | `ui/` implements the state machine, FleetView, inspector, and commands. | UI and acceptance tests cover effects and input handling; terminal tests separately exercise real Pi rendering. |
| Acceptance specifications. | `doc/acceptance/` defines stable scenario identities. | `tests/acceptance/` executes scenario-specific adapters and checks reviewed source hashes. |
| Real-provider spawning. | `tests/e2e/environment/` provides isolated CLI and terminal drivers. | `tests/e2e/cases/non-interactive/` and `cases/interactive/` exercise the actual provider and installed extensions. |

Implementation paths in the table are relative to `extensions/secretary/agents/` unless a full repository path is shown.

## Defects reproduced and resolved

### Workspace selection

Ordinary spawning previously attempted unsupported or unavailable isolation. Shared-directory execution now requires no Git history. Requested isolation creates a real worktree for a committed checkout or an explicitly reported directory snapshot for a non-Git or unborn project. The original project is never initialized or committed by this fallback.

### Provider initialization

Loaded extensions could replace the parent-authentication adapter during `createAgentSession()`. The runner now restores that adapter after queued registrations are flushed, before startup handlers run, and rejects later replacement. Unit tests and the real-provider matrix verify the repair. Pi and the provider extension were not patched.

### Child UI capabilities

The synthetic child UI proxy advertised `hasUI: true`, but Pi's object-spread wrapper discarded its getter-generated methods. The interactive reproducer traced the resulting `setWidget` failure to `pi-recap` during startup and observed a related disposal error during shutdown.

The runner now retains Pi's complete native headless UI context. The parent remains interactive; child extensions see `hasUI: false`. The passing terminal test verifies this separation and the actual child file read. Unrelated extension errors are not suppressed.

## TUI presentation port (2026-09-18)

This section records verification of the nicobailon/pi-subagents TUI port onto Secretary's `AgentService` runtime (architecture §12.6, delivery record `.plans/2026-09-18-subagent-tui-port.md`). The port is presentation-only: no runtime launch, stop, or message capability changed.

**Verified by automated tests:** structured transcript events (typed assistant/user/tool/notice events paired by stable entry id, header-form tool lines, bounded argument/output expansion, redacted-harness coverage) in `tests/agents/transcript-events.test.ts`; derived view models and usage labels (separate formula from the goal progress formula) in `tests/agents/view-models.test.ts`; FleetView rows and the foldable async widget in `tests/agents/fleet-view.test.ts` and `async-widget.test.ts`; the bordered inspector (position indicator, contextual footer, Home/End, `r`/`R` reload, width fallbacks below the two-pane threshold) in `tests/agents/inspector.test.ts`; summary/rich inline display modes in `tests/agents/inline-rendering.test.ts`; `agents.ui` configuration validation, trust precedence, and keybinding hint/input consistency in `tests/agents/configuration.test.ts` and `keybindings.test.ts`.

**Acceptance:** four new scenarios (`ACC-SA-UI-14` through `ACC-SA-UI-17`) in `doc/acceptance/ui-state-machine.feature` with bindings in `tests/acceptance/ui.test.ts`; existing inspector scenarios were re-bound to the ported presentation. The reviewed specification hash was updated after the bindings passed.

**Terminal walkthrough:** `npm run record:tui` succeeded against real interactive Pi (`test-results/tui/20260918T172515Z-1275ad6d`, git revision recorded in `manifest.json`). Twelve checkpoints replay through `scripts/render-tui-recording.ts`, including the bordered wide/narrow inspector, paused-then-following transcript scrolling, tool-detail expansion, the composer, and stop confirmation. Generated frames remain under the ignored `test-results/` tree per the artifact policy.

**Reproduction commands:** `npm run check`, `npm run test:subagents` (153 pass), `npm run test:acceptance` (147 pass), `npm run test` (521 pass), `npm run lint:mermaid`, `npm run lint:acceptance`.

**Not verified:** human visual approval of the new layout, real IME composition, screen readers, other terminal emulators, and the real-provider E2E matrix (unchanged by this presentation-only port, but not re-run).

## Remaining verification and operational limits

- Human visual approval, real IME composition, screen-reader behavior, and additional terminal emulators remain unverified.
- Rediscovered trusted extension hooks are preserved, but arbitrary parent-only inline tools and permission hooks are not generically transferable. Complete custom-host policy parity is not claimed.
- No general certification of third-party extensions for headless or concurrent execution is provided.
- Noncooperative tools and detached external jobs can outlive cancellation requests. A shutdown timeout is not proof of process termination.
- Uncertain workspace allocations, cleanup reservations, or ownership locks can require manual recovery. Tests do not justify force deletion of uncertain user data.
- Automatic transcript retention and a complete historical-record deletion interface are not implemented.
- A passing test suite does not establish full Claude compatibility, a broader Pi version matrix, or a release decision.
