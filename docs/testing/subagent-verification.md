# Subagent Verification Report

**Document type:** Dated verification report, not a release approval or test procedure.

**Reviewed implementation:** `01f851a`, including the authentication, workspace, and child UI fixes.

**Execution date:** 2026-09-18 for the latest regression and real-provider runs summarized below. Earlier terminal and packaging observations are identified separately.

**Related documents:** [Architecture](../arch/subagents.md), [requirements](../user-stories/subagents.md), [interaction design](../ux/subagents.md), [testing guide](README.md), and [delivery record](../../.plans/2026-09-17-subagent-support.md).

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

## Remaining verification and operational limits

- Human visual approval, real IME composition, screen-reader behavior, and additional terminal emulators remain unverified.
- Rediscovered trusted extension hooks are preserved, but arbitrary parent-only inline tools and permission hooks are not generically transferable. Complete custom-host policy parity is not claimed.
- No general certification of third-party extensions for headless or concurrent execution is provided.
- Noncooperative tools and detached external jobs can outlive cancellation requests. A shutdown timeout is not proof of process termination.
- Uncertain workspace allocations, cleanup reservations, or ownership locks can require manual recovery. Tests do not justify force deletion of uncertain user data.
- Automatic transcript retention and a complete historical-record deletion interface are not implemented.
- A passing test suite does not establish full Claude compatibility, a broader Pi version matrix, or a release decision.
