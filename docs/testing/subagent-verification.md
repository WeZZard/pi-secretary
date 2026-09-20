# Subagent Verification Report

**Document type:** Dated verification report, not a release approval or test procedure.

**Reviewed implementation:** `01f851a`, including the authentication, workspace, and child UI fixes.

**Execution date:** 2026-09-18 for the latest regression and real-provider runs summarized below. Earlier terminal and packaging observations are identified separately.

**Related documents:** [Architecture](../arch/subagents.md), [requirements](../user-stories/subagents.md), [interaction design](../ux/subagents.md), [testing guide](README.md), and [delivery record](../../.plans/2026-09-17-subagent-support.md).

## 2026-09-20: Session rewind and abandoned subagent work

- The reviewed implementation is the working tree based on `463b0cc`, implementing the [rewind repair plan](../../.plans/2026-09-20-subagent-session-rewind.md). The user selected cancellation of abandoned unfinished work; this is not approval of every implementation detail or interface.
- Before the repair, the real-SDK ten-agent reproducer failed because the repeated request received abandoned run IDs. A controlled roster-only filter removed those IDs but exposed ten name-conflict rejections. Both findings are recorded in the [investigation](../research/subagent-session-rewind.md).
- The repaired SDK test passes with twenty child executions across the original and repeated requests, reused names and provider tool-call IDs, unchanged original successful records, exclusion of a queued stale completion, and restoration of original outcomes when returning to that branch.
- RPC-mode SDK tests pass for cancellation of an abandoned live run while an ancestral run remains active, suppression of the abandoned completion turn, selection of the retained run by name after a later resumption is abandoned, and refusal to resume the advanced saved child conversation.
- Session-manager tests pass for reopened JSONL ancestry, a deterministic compaction entry retaining admission ancestry, and unique, missing, or ambiguous legacy provenance. Service tests pass for historical output and descendant-roster isolation, explicit historical-ID access, and preservation of live work whose legacy provenance is unknown. These checks do not establish whole-process restart behavior during navigation or hosted-model compaction.
- Updated ACC-SA-05-08 bindings pass for both running and finished abandoned work, fresh same-name admission, retained records, and return to the original branch. Adapter fixtures now supply structured generating assistant entries, as the real SDK does; they no longer invoke admission-sensitive tools without an originating entry.
- `npm run verify` passed TypeScript checking, all 650 tests, all 28 Mermaid blocks, and acceptance syntax validation for 11 feature files and 107 stable scenario identities. Generated output remains under ignored `test-results/agent-rewind/`, not in versioned documentation.
- Reproduce the focused checks with `node --experimental-strip-types --test tests/agents/rewind.test.ts tests/agents/service.test.ts tests/acceptance/runtime.test.ts`. No paid-provider request, GUI recording, production-session modification, or human visual approval is claimed. A parent turn already dispatched before navigation cannot be retracted by this repair.

## 2026-09-20: Composer input, navigation bounds, and scrolling follow-up

- The reviewed implementation is the working tree based on `fd8bdc3`, amending the [fleet geometry plan](../../.plans/2026-09-20-fleet-overlay-geometry.md) after user review. Navigation now stays within 20–40 content columns, and the transcript receives excess width; 61.8% is its minimum target rather than its maximum.
- Before this amendment, real-TUI tests failed for the composer's blank top rule and for CSI-u Escape leaving the composer open. Legacy Escape already passed. Sharing the frame formatter and using pi-tui key matching made the same tests pass in main-screen and alternate-screen modes.
- SGR wheel input already scrolled actual transcript content through the alternate-screen host. A new modal-isolation test exposed wheel sequences falling through into the composer's input handler. Consuming modal wheel events fixed that regression without changing the scroll state machine.
- Real-TUI checks passed for retained unsent drafts, a second Escape returning to the editor, protocol-encoded Enter dispatching once, Page Up/Page Down, wheel-driven transcript scrolling and follow resumption, and wheel-driven agent selection. Width checks passed from 100 through 600 terminal columns, including the 40-column navigation maximum on large terminals.
- `npm run verify` passed TypeScript checking, all 643 tests, all 28 Mermaid blocks, and acceptance syntax validation. Generated logs remain in ignored `test-results/`; no generated output is a versioned baseline.
- These checks use real pi renderers with deterministic agent fixtures and `@xterm/headless`. They do not identify the user's terminal keyboard protocol, establish GUI animation behavior, or constitute human visual approval. Mouse scrolling is supported in the mouse-enabled alternate-screen host; normal main-screen mode retains terminal-owned scrollback and uses keyboard transcript scrolling.

## 2026-09-20: Fleet overlay geometry

- The reviewed implementation is the working tree based on `fd8bdc3`, implementing the [fleet overlay geometry repair](../../.plans/2026-09-20-fleet-overlay-geometry.md).
- Before the repair, the real main-screen TUI regression tests failed for missing right borders, changed frame coordinates during transcript loading, and insufficient navigation width. Correcting only the wide-row width reservation fixed the border case while the other two cases still failed.
- After the repair, real main-screen and alternate-screen TUI composition tests passed through keyboard selection, loading, empty transcripts, and terminal resize. They inspect ANSI output using `@xterm/headless`; agent records and transcript arrivals are deterministic fixtures.
- Component checks additionally passed for Unicode labels, feedback, dialogs, very small dimensions, and keeping the selected row visible in an overflowing roster. The revised ACC-SA-02-12 binding checks the new frame and pane geometry before, during, and after loading an empty transcript.
- `npm run verify` passed TypeScript checking, all 631 tests, all 28 Mermaid blocks, and acceptance syntax validation for 11 feature files and 107 scenario identities. The earlier verification attempt stopped at the expected acceptance-specification hash mismatch; the scenario assertions were extended before its reviewed hash was updated.
- Reproduce the focused terminal checks with `node --experimental-strip-types --test tests/agents/inspector.test.ts`. Generated run logs remain under ignored `test-results/` and are not versioned baselines.
- No live-provider request, GUI terminal recording, or human visual approval is claimed. Terminal-cell checks establish frame geometry, not animation timing in a particular terminal application.

## 2026-09-20: Request-context composition and agent discovery

**Reviewed implementation:** The working tree based on `30c24e6`, implementing the [cited plan](../../.plans/2026-09-20-request-context-injection.md). The generic mechanism and subagent discovery have separate owners in [request-context architecture](../arch/request-context.md) and [subagent architecture Section 5.4](../arch/subagents.md#54-request-scoped-definition-catalog).

| Check | Observed result | Verification limit |
| --- | --- | --- |
| First-request reproducer | Before implementation, `tests/agents/discovery.test.ts` failed because the real parent SDK provider received only the user prompt at the request tail, without a catalog. The same assertion now passes. | The provider is deterministic and local; this does not measure real-model selection quality. |
| Generic composition | `tests/context/` passed independent tests for ordering, escaping, size bounds, omitted and failed contributors, cancellation, activation replacement, immutable captures, and owned-envelope replacement. | Contributors use synthetic state, not agent definitions. |
| Real Pi context integration | The generic SDK test passed image preservation, tool-result ordering, later-hook coexistence, transport-error recovery, and saved-JSONL checks. | It inspects the converted provider context, not hosted HTTP serialization, every provider adapter, or injection-specific compaction. |
| Subagent discovery integration | Real parent and child SDK tests passed first-request precedence, edits and removal during generation, parallel call binding, fallback-list snapshot consistency, malformed and oversized catalogs, startup recovery, and trust revocation. | Configuration races are controlled through a deterministic provider; a true concurrent-filesystem mutation stress test remains unexecuted. |
| Admission and incident-shaped execution | Missing and old-branch receipts were rejected. Cancellation while credential resolution was suspended admitted no child. Ten read-only children completed through the real runner without parent definition-file reads. | The ten-child case does not reproduce hosted quota conditions. The post-workspace admission guard was source-reviewed, but its asynchronous race was not independently exercised here. |
| Acceptance coverage | New ACC-SA-13-01 through ACC-SA-13-03 bindings passed through real SDK sessions. ACC-SA-07-01 now verifies a stable string schema and fallback-list publication in runtime context. | Approval tags retain their design-review meaning; passing bindings do not establish human approval. |
| Routine development gate | `npm run verify` passed TypeScript checking, all 623 test cases, Mermaid validation, and acceptance syntax validation. | This command excludes paid-provider E2E tests. |

- Reproduce the focused checks with `node --experimental-strip-types --test --test-concurrency=1 tests/context/*.test.ts tests/agents/discovery.test.ts tests/acceptance/discovery.test.ts`.
- Each local run used a fresh ignored directory under `test-results/`; request-context SDK captures also use fresh directories under `test-results/context/`. These generated files are not versioned baselines.
- The implementation does not rewrite persisted user content or append then delete reminders. It does not migrate goal-state or running-agent projections into the new envelope.
- SA-DISC-07 live-provider selection and RC-08 hosted cache evaluation were not run. No cache benefit, universal provider compatibility, package deployment, or human visual approval is claimed.

## 2026-09-20: Idle-hidden indicator and main-row focus return

**Reviewed implementation:** the working tree amending the unified fleet indicator so it renders nothing while no top-level execution is non-terminal, and so Enter on the main session row returns focus to the prompt input instead of opening the fleet view overlay. **Execution date:** 2026-09-20.

| Check | Observed result | Verification limit |
| --- | --- | --- |
| `npm run check` | TypeScript checking passed. | Static checking only. |
| `npm run test:subagents` | All tests passed, including the rewritten idle-rendering unit test and the new reducer guards (an empty indicator cannot receive focus; losing the last row returns focus to the editor). | Unit-level reducer and component checks, not a real terminal. |
| `npm run test:acceptance` | All 158 scenarios passed, including the amended ACC-SA-02-02a (Enter on the main row returns focus without opening the overlay), ACC-SA-02-02b (hidden when idle, appears when an agent starts), and ACC-SA-02-02c (overlay entry through a surviving agent row). | Scenario bindings are reviewed adapters, not independent specification. |

The screenshot showing the idle `○ main` row motivated this amendment; human visual approval of the amended indicator remains unrecorded and separate.

## 2026-09-19: Unified fleet indicator, split fleet view overlay, and nested delegation

**Reviewed implementation:** the working tree implementing the [unified fleet indicator plan](../../.plans/2026-09-19-unified-fleet-indicator.md) phases U1–U3 and N1–N2. **Execution date:** 2026-09-19.

| Check | Observed result | Verification limit |
| --- | --- | --- |
| `npm run check` | TypeScript checking passed. | Static checking only. |
| `npm run test:subagents` | All 175 tests passed, including the rewritten fleet view suite, the new nested-delegation suite (tree aggregation, stop cascade, sibling isolation, tree recovery, depth rejection), and the end-to-end runner tests where a real child session loads the extension and delegates a nested agent through the fixture provider. | Deterministic providers and fixtures, not real providers. |
| `npm run test:acceptance` | All 158 scenarios passed, including the new ACC-SA-02-02a/b/c indicator scenarios and the ACC-SA-02-11/12/13/14 overlay scenarios. | Scenario bindings are reviewed adapters, not independent specification. |
| `npm run lint:acceptance` and `npm run lint:mermaid` | 10 Gherkin files with 104 scenario identities validated; 27 Mermaid blocks valid. | Syntax and traceability checks, not behavioral execution. |
| ACC-SA-07-06 permission broadening | The runner admits delegation tool names to a child session's model and tool execution only while this extension's own registration marker stands for that session, so a foreign extension cannot hijack the names inside an allowlisted session. | The marker distinguishes registration origin, not the intent of a genuine registered tool. |

Human visual approval of the indicator and overlay remains unrecorded and separate. Mouse wheel scrolling depends on a mouse-enabled host and was verified by component-level tests only.

## 2026-09-19: Model fallback availability repair

**Reviewed implementation:** the working tree implementing the [model fallback availability repair plan](../../.plans/2026-09-19-model-fallback-availability-repair.md) phases R1–R3, in response to the AnyDict production failures of 2026-09-19. **Execution date:** 2026-09-19.

| Check | Observed result | Verification limit |
| --- | --- | --- |
| `npm run check` | TypeScript checking passed. | Static checking only. |
| `npm run test:subagents` | All 166 tests passed, including the five new regression tests: production-message classification, the resolution credential gate, first-request 401 advance, the per-attempt extension-runtime isolation, and chain-context abort reporting. | Deterministic providers and fixtures, not real providers. |
| `npm run test:acceptance` | All 151 scenarios passed, including the new ACC-SA-07-10, ACC-SA-07-11, and ACC-SA-07-12 scenarios. | Scenario bindings are reviewed adapters, not independent specification. |
| `npm run lint:acceptance` and `npm run lint:mermaid` | 10 Gherkin files with 97 scenario identities validated; 27 Mermaid blocks valid. | Syntax and traceability checks, not behavioral execution. |
| Live reproduction before the fix | Both incident mechanisms were reproduced against the real `~/.pi/agent` installation with a temporary fallback list: the credential-less `openai` head was selected and failed at launch without advancing, and the 429 advance died with the stale extension-context error. The runner regression test reproduces that error byte-for-byte. | The live reproduction used a fake provider replaying the recorded 429; the configuration file was restored afterwards. |

## 2026-09-19: Model fallback lists and the `/secretary` configuration menu

**Reviewed implementation:** the working tree implementing the [model fallback lists plan](../../.plans/2026-09-19-model-fallback-lists.md) phases P1–P3, including the same-day amendments that restyled the menu to pi's native full-screen selector presentation, restructured the Subagents section as a configuration-item navigation list, and added fallback-list renaming. **Execution date:** 2026-09-19.

| Check | Observed result | Verification limit |
| --- | --- | --- |
| `npm run check` | TypeScript checking passed. | Static checking only. |
| `npm run test:subagents` | All 161 tests passed, including availability classification, chain resolution, runner fallback, persistence, and the headless `/secretary` wiring test. | Deterministic providers and fixtures, not real providers. |
| `npm run test:acceptance` | All 148 scenarios passed, including the rewritten ACC-SA-07-01/02/03 and the new ACC-SA-07-09 ordered-fallback scenario. | Scenario bindings are reviewed adapters, not independent specification. |
| TUI suites | All 79 tests passed, including the menu interaction tests and the ten reviewed rendered-layout baselines in `tests/tui/secretary-menu-snapshots.test.ts`. | Baselines are reviewed captures of the implemented layout; layout changes require updating them with review. |
| `npm run lint:acceptance` and `npm run lint:mermaid` | 10 Gherkin files with 94 scenario identities validated; 27 Mermaid blocks valid. | Syntax and traceability checks, not behavioral execution. |
| TUI walkthrough recording | Run `test-results/tui/20260919T072335Z-182e61e6` completed 22 checkpoints; replay assertions passed for all checkpoints, including the ten menu checkpoints (07b–07k). | The walkthrough runs real Pi with a deterministic provider. A recorded walkthrough is not human visual approval; replay does not run a model. |

The recording's screen assertions cover the menu's top level, the Subagents section's configuration items, the list manager, the name prompt, list creation, the prefilled rename prompt, the rename result, the list detail, the filtered model picker, and model addition. Human visual approval of the menu remains unrecorded and separate.

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
| Definitions, trust, and model resolution. | `configuration.ts`, `registry.ts`, and `tools/schemas.ts` define the contracts. | Configuration and schema tests cover precedence, metadata-only definitions, stable string schemas, and runtime fallback-list validation. |
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
