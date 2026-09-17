# Subagent Implementation Evidence

**Document type:** Implementation and verification report.

**Status:** Core implementation, executable BDD acceptance, automatic recovery tests, and an automated recorded terminal walkthrough are available. Human visual approval and the custom-host limitations below remain separate release considerations.

**Date:** 2026-09-17.

**References:** [Software design](../arch/subagents.md), [interaction design](../ux/subagents.md), [acceptance specifications](../../doc/acceptance/README.md), and [implementation plan](../../.plans/2026-09-17-subagent-support.md).

## 1. Implemented Components

- `extensions/secretary/agents/installation.ts` registers the four control tools after collision checks and connects the service to the parent session and goal subsystem.
- `service.ts` coordinates launch, queue admission, guidance, resumption, cancellation, output retrieval, completion records, cleanup, and shutdown.
- `storage/` contains additive SQLite tables, synchronous transactions, uniqueness constraints, operation receipts, and per-parent ownership locking.
- `configuration.ts` and `registry.ts` implement trusted definition discovery, strict frontmatter validation, exact model aliases, and saved-definition provenance.
- `runner.ts` creates real pi SDK child sessions through public provider/authentication interfaces, preserves discovered extension hooks, applies current tool restrictions, and supports persistent resumption.
- `child-context.ts` prevents a loaded Secretary extension from constructing another root controller inside a child.
- `worktrees.ts` implements owned Git worktrees and conservative cleanup without automatic commits, merges, or force deletion.
- `ui/` contains the architectural UI state machine, correlated effects, FleetView, inspector, message composition, and confirmations.
- `transcript-format.ts` converts persisted pi messages into bounded readable Markdown while retaining entry identifiers for reading anchors.
- The existing goal service now exposes atomic, source-deduplicated descendant accounting. The public goal tools and existing goal-budget formula are unchanged.

## 2. Verification Boundaries

| Check | Observed result and limit |
| --- | --- |
| Type checking | `npm run check` passes against installed pi 0.85.1. |
| Focused tests | `npm run test:subagents` passes the implemented configuration, schema, storage, Git, runner, service, installer, accounting, and UI tests. |
| Existing regression tests | The full suite includes the existing goal tests alongside the new agent tests. Final command results should be retained with the implementation review. |
| Mermaid validation | `npm run lint:mermaid` validates diagram syntax. It does not establish UI conformance. |
| Acceptance syntax | `npm run lint:acceptance` parses Gherkin and checks scenario identities and example columns. It does not execute the feature files. |
| Executable acceptance | `npm run test:acceptance` passes all scenario bindings and expanded Examples, with no skipped cases. The suite uses the official Gherkin compiler and reviewed source hashes. |
| Automatic recovery | `tests/agents/runner-recovery.test.ts` exercises real SDK overflow compaction, transient-error retry, cancellation during compaction, and persisted usage-source identity. |
| Packaging | `npm pack --dry-run` includes the new extension modules and does not publish or install the package. |
| Terminal interaction | The [isolated real-pi recording procedure](../../doc/acceptance/tui-recording.md) passes its input sequence and replayed-screen assertions. It is an automated pseudo-terminal walkthrough, not human visual approval. |

- Tests use isolated state, fake providers, and disposable repositories rather than real paid model requests or the user's live goals.
- Real SDK tests establish execution behavior on pi 0.85.1. They are stronger evidence than adapter mocks, but do not establish compatibility with other pi versions.
- The peer dependency declarations are narrowed to the tested pi versions rather than advertising an unverified broader range.
- The code is not committed, installed into a live session, or released by these checks.
- Generated recordings and derived reports are local artifacts under ignored `test-results/`, not versioned documentation. The [artifact policy](../testing/test-artifacts.md) defines storage and retention; the recording procedure explains how to reproduce or locate them.

## 3. Concrete Test Targets

| File | Verified behavior |
| --- | --- |
| `tests/agents/configuration.test.ts` | The tests exercise configuration merging, trust, definition precedence, and model resolution. |
| `tests/agents/schemas.test.ts` | The tests exercise strict tool inputs, allowed fields, and timeout boundaries. |
| `tests/agents/storage.test.ts` | The tests exercise transaction rollback, identity constraints, ownership locks, and durable receipts. |
| `tests/agents/worktrees.test.ts` | The tests exercise real Git allocation, ownership verification, and refusal to delete retained changes or submodules. |
| `tests/agents/runner.test.ts` | The tests execute real SDK children with deterministic providers and cover provider inheritance, literal guidance, cancellation, restrictions, limits, resumption, and cleanup. |
| `tests/agents/service.test.ts` | The tests exercise queuing, launch deduplication, messaging, waits, goal-attribution preservation, output retention, and shutdown coordination. |
| `tests/agents/installation.test.ts` | The tests exercise production registration, name collisions, headless rejection, foreground output, and suppression of root initialization in child sessions. |
| `tests/agents/goal-integration.test.ts` | The tests exercise usage deduplication, late usage, replaced or cleared goals, and accounting rollback. |
| `tests/agents/ui.test.ts` | The tests exercise transitions and effects, stale responses, modal behavior, width constraints, and keyboard adapter guards. |
| `tests/agents/runner-recovery.test.ts` | The tests exercise automatic compaction and retry through the real SDK, cancellation during recovery, and exact association with persisted usage sources. |
| `tests/acceptance/` | The scenario-specific adapters execute every current Gherkin scenario and Examples row. Source-hash checks require assertion review when a feature changes. |

## 4. Review Findings Addressed

- Inspector resumption no longer silently removes prior goal attribution. A goal-attributed conversation requires current goal authority before resumption.
- Shutdown waits for accepted cleanup operations as well as active child runners before allowing shared storage and ownership to be released.
- Settlement preserves accumulated streamed output when the runner returns only its last assistant message.
- Cancelling a queued background run creates its completion record without starting a provider request.
- Definitive preflight failures are distinguished from uncertain operation outcomes so rejected guidance can return to its composer safely.
- Transcript display now uses structured pi message content and Markdown rendering rather than exposing raw JSONL as the default conversation view.
- Resumption validates the recorded model and worktree before accepting a new run. Per-agent message serialization preserves single-run execution across asynchronous preflight checks.
- Undelivered guidance retains the actual settlement reason and remains inspectable without being replayed automatically.
- Blocking output retrieval identifies an expired wait explicitly without cancelling the child.
- OSC sanitization preserves readable text after an ST-terminated control sequence.
- Assistant usage is associated with its actual persisted message entry after the SDK persistence boundary, rather than with the previous session leaf. Compaction usage is associated with its compaction entry.
- Recorded terminal testing exposed clipped feedback and a header displaced by host output. The inspector now reserves feedback space and uses a bounded in-process overlay.

## 5. Remaining Acceptance Work and Limitations

- The complete current Gherkin set has scenario-specific executable bindings. This is not a general-purpose Cucumber step-definition library; reviewed source hashes prevent silent drift between prose and assertions.
- The automated recording verifies actual terminal interaction and reconstructed character grids. Human visual approval, real IME composition, screen-reader behavior, and additional terminal emulators remain unverified.
- The recorded recovery tests establish behavior for the deterministic provider and installed SDK version. They do not establish recovery behavior for every external provider.
- Parent-only inline tools that cannot be rediscovered in a child fail explicitly. Arbitrary parent-only inline permission hooks do not have a general public copying mechanism; discovered trusted extension hooks are preserved, and complete custom-host policy parity is not claimed.
- Failed or cancelled worktree allocations retain allocation manifests and any uncertain partial Git resources. They can require manual recovery rather than speculative deletion.
- Incomplete lock metadata, PID reuse uncertainty, and interrupted lock reclamation fail conservatively and can require manual recovery.
- Tools that ignore cancellation can delay settlement. The cleanup deadline does not prove that external tool processes have stopped, and storage ownership remains retained when settlement is uncertain.
- Transcript and artifact retention is explicit. This release does not implement an automatic retention policy or a complete historical-record deletion interface.

## 6. Configuration Decision Recorded During Implementation

- Global agent configuration is read from `<getAgentDir()>/secretary.json`.
- Trusted project configuration is read from `<cwd>/<CONFIG_DIR_NAME>/secretary.json`.
- Both files use the `agents` object documented in the README, and project fields override corresponding global fields.
- This resolves the file-location detail identified in the implementation plan without adding fields to the public `Agent` schema.
