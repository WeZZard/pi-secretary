# Subagent state after session rewind

## Status and scope

- This troubleshooting report is dated 2026-09-20. The repair is implemented in the working tree based on `463b0cc`, which separately committed the preceding fleet-view changes.
- The reported workflow completes ten subagents, synthesizes a report, selects the original user message through tree navigation, and submits it again without a branch summary.
- The user selected cancellation of abandoned unfinished work. The maintained behavior is specified in [SA-05](../user-stories/subagents.md#sa-05-retain-and-recover-conversations), the [rewind interaction](../ux/subagents.md#52-rewind-the-parent-conversation), and [architecture Section 6.4.1](../arch/subagents.md#641-branch-visibility-and-rewind-cancellation).

## Executed reproducer

- `tests/agents/rewind.test.ts` uses real parent and child SDK sessions, Secretary's actual service and SQLite repository, and the public `navigateTree` API. Its provider is a deterministic local fixture and makes no network requests.
- The first request creates ten named child agents and records ten successful outcomes. The fixture provider synthesizes after observing outcomes.
- Before the repair, selecting the original user message removed later assistant and tool-result messages from pi's active history while retaining the session ID. The repeated request nevertheless received old run IDs and output paths in Secretary's injected agent-state message.
- The initial regression failed because an abandoned run occurred in the next provider request. The same workflow now executes twenty children across the original and repeated requests, preserves the first ten records unchanged, and excludes their outcomes from the repeated request.

## Confirmed causes and controlled experiment

- `extensions/secretary/agents/installation.ts` constructed `secretary:agents-state` from the session-wide `service.list()`. The `session_tree` handler cleared catalog receipts without changing roster visibility.
- The previous architecture explicitly retained session-wide agent visibility after navigation. It did not distinguish durable ownership from conversation visibility.
- A temporary diagnostic filter restricted the injected roster to agents referenced in the active branch. Changing only this variable removed the leaked IDs and made the provider attempt ten fresh launches.
- All ten launches then failed with `Agent name already exists`. Both service validation and the database uniqueness constraint reserved names across the entire session. Filtering context alone therefore could not fix the repeated-request workflow.
- That diagnostic filter was reverted. The repair records structured admission identities rather than matching arbitrary output text.

## Implemented repair

- Runs retain their admitting conversation entry. Visibility follows full selected ancestry, independently of durable ownership and compacted provider context.
- Operation keys combine the assistant entry and tool-call ID. New agent name keys include their admission scope, while public records retain their original display names. Existing SQL rows are not rewritten or deleted.
- Context, current fleet rows, named output inspection, pending outcomes, and completion delivery use branch visibility. Previously queued stale completion messages are filtered before provider delivery.
- Navigation requests cancellation of proven-abandoned unfinished runs without stopping shared-ancestor work. Completed statuses, output artifacts, usage, and filesystem effects remain intact.
- Returning to an earlier run does not rewind the saved child conversation. If a later resumption advanced it on another branch, the earlier output remains inspectable, but resumption is refused and advanced descendants are omitted from that historical view.
- Legacy recovery requires a unique structured admission. Missing or ambiguous provenance is excluded from current context and never authorizes automatic cancellation.

## Verification and limits

- Real SDK regressions cover fresh repeated launches with reused names and tool-call IDs, a queued stale completion, return to the original branch, cancellation of live abandoned work, retention of live ancestral work, and rejection of an advanced child conversation.
- Session-manager checks cover persisted admission ancestry after reopening JSONL, retained ancestry through a deterministic compaction entry, and unique, missing, and ambiguous legacy correlation. These are not a whole-process restart or a hosted-model compaction test.
- Service tests cover retained output inspection, suppression of an advanced descendant roster, exact historical-ID access, and refusal to cancel unknown legacy work. Updated ACC-SA-05-08 bindings cover both running and finished abandoned work.
- The [verification report](../testing/subagent-verification.md) records the complete development gate. No hosted-model behavior, GUI recording, human approval, or retraction of a parent turn already dispatched before navigation is claimed.
- Reproduce the focused SDK checks with `node --experimental-strip-types --test tests/agents/rewind.test.ts`. Generated logs remain under ignored `test-results/agent-rewind/`; no production agent records or user session files were modified.
