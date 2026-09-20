# Repair subagent visibility after session rewind

## Status and design ownership

- The repair is implemented in the working tree based on `463b0cc`. That commit contains the preceding fleet-view work, not this rewind repair.
- The user selected cancellation of abandoned unfinished work on 2026-09-20. Requirements belong to [SA-05](../docs/user-stories/subagents.md#sa-05-retain-and-recover-conversations), interactions belong to [UX Section 5.2](../docs/ux/subagents.md#52-rewind-the-parent-conversation), and the technical contract belongs to [architecture Section 6.4.1](../docs/arch/subagents.md#641-branch-visibility-and-rewind-cancellation).
- The [investigation](../docs/research/subagent-session-rewind.md) records the failing real-SDK reproducer and the controlled experiment that exposed the independent name conflict.

## Completed delivery

1. Reproduced the incident through real SDK parent and child sessions, SQLite, provider-context capture, and `navigateTree`. A roster-only diagnostic filter exposed the remaining name conflict and was reverted.
2. Added immutable launch and resumption admission metadata in `records.ts`, `branch-scope.ts`, the service, and the repository. Full ancestry governs visibility; conservative structured correlation supports legacy records. This implements architecture Section 6.4.1.
3. Scoped tool operation keys and new name uniqueness keys to admissions. The existing SQL schema remains valid, historical rows remain unchanged, retries remain idempotent, and sibling branches can reuse names and tool-call IDs. This implements architecture Section 6.4.1 without a destructive migration.
4. Applied visibility to model-state injection, current fleet projection, named output inspection, pending outcomes, and completion callbacks. Explicit historical IDs retain inspection and cleanup access. Previously queued stale completion messages are filtered at context preparation, as required by architecture Section 6.4.1.
5. Implemented cancellation of proven-abandoned unfinished work and preservation of shared-ancestor work. Cancellation does not assert settlement prematurely. Advanced saved child conversations cannot be resumed as if rewound; historical inspection uses retained output and excludes the advanced descendant roster. These behaviors implement UX Section 5.2 and architecture Section 6.4.1.
6. Extended `tests/agents/rewind.test.ts`, service regressions, and ACC-SA-05-08 bindings. The ten-agent test observes twenty real child executions, fresh identities despite repeated provider call IDs, and unchanged original records. Additional tests cover shared ancestry, live cancellation, completion suppression, stale queued messages, resumption, old-branch return, reopened JSONL, compaction ancestry, and conservative legacy provenance.
7. Updated the adapter fixtures to persist structured generating assistant entries before invoking tools, matching the real SDK boundary. Updated requirements, UX, architecture, acceptance assertions, reviewed feature hash, and verification documentation. All generated output remains under ignored `test-results/`.

## Verification and rollout

- `npm run verify` passed TypeScript checking, all 650 tests, all 28 Mermaid blocks, and acceptance syntax validation for 11 feature files and 107 stable scenario identities.
- The [verification report](../docs/testing/subagent-verification.md) distinguishes deterministic SDK execution, session-manager checks, adapter bindings, and unexecuted hosted-provider or visual checks.
- Reload Secretary before manually repeating the reported workflow. Navigation does not undo files, usage, output artifacts, or completed execution, and unknown legacy provenance does not authorize automatic cancellation.
- Whole-process restart during rewind, hosted-model compaction, and GUI interaction are not claimed as executed verification. A parent turn already dispatched before navigation cannot be retracted by this repair.
