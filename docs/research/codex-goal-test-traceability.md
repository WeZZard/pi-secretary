# Test Case Inventory: Codex Goal System (translated for pi-secretary)

**Project:** pi-secretary — Codex goal replicate
**Document type:** Test Design Specification / Requirement Traceability Matrix
**Status:** Draft
**Date:** 2026-09-15
**Updated:** 2026-09-16
**Source:** OpenAI Codex `codex-rs/` goal test suite (Rust)
**Related:** `../arch/architecture.md` · `../../.plans/2026-09-15T13:17:45Z-codex-goal-replicate.md`

> **Scope.** This doc translates the **scenarios** of Codex's goal test suite
> into the naming and structure of the pi-secretary TypeScript replicate. It
> is a **verification reference**, not runnable code. Each case is mapped to
> the `.plans` phase and the module (`GoalService`, storage, tools, runtime,
> steering) that must satisfy it.
>
> **Why translation, not copy.** Codex's tests are Rust integration tests
> against `codex_state` and a `GoalExtensionHarness`. Our replicate is
> TypeScript. The original scenario inventory is retained below; it is not
> proof that every ported scenario is implemented. Section 9 records the
> current synchronization evidence. Section 10 records verification of
> the revised intent-ordering contract, which supersedes the host-admission prerequisite.

---

## 1. Inventory of Source Layers

| Source file | Layer | Native tests |
| --- | --- | --- |
| `codex-rs/ext/goal/tests/goal_extension_backend.rs` | Tool / backend integration | 27 |
| `codex-rs/ext/goal/tests/accounting.rs` | Accounting state | 7 |
| `codex-rs/ext/goal/tests/steering.rs` | Steering prompts | 2 |
| `codex-rs/state/src/runtime/goals.rs` | Storage / DB layer | 23 |
| `codex-rs/app-server/tests/suite/v2/thread_goal_empty_responses.rs` | App-server behavior | 1 |
| `codex-rs/tui/src/chatwidget/tests/{goal_menu,goal_validation}.rs` | TUI | 17 |
| **Total** | | **77** |

The storage layer (`goals.rs`) is the deepest and densest; the tool/backend
layer exercises the public surface. The TUI tests cover the pi-goal-x-style
presentation that our replicate ports.

---

## 2. Scenario-to-Module Mapping

| Scenario | Native test | pi-secretary module | Phase |
| --- | --- | --- | --- |
| Create goal + fill empty preview | `installed_goal_tools_create_goal_and_fill_empty_preview` | `tools/create_goal` | 3 |
| Apply max token budget | `installed_goal_tools_apply_maximum_token_budget` | `create_goal` | 3 |
| Ephemeral tools reject execution | `ephemeral_goal_tools_preserve_specs_but_reject_execution` | `tools` | 3 |
| Tools hidden for review subagents | `goal_tools_hidden_for_review_subagents` | `tools` | 3 |
| Only replace a complete goal | `installed_goal_tools_only_replace_complete_goal` | `create_goal` | 3 |
| Reset baseline before turn-stop accounting | `create_goal_resets_baseline_before_turn_stop_accounting` | `accounting` | 4 |
| Tool-finish accounts + emits event | `tool_finish_accounts_active_goal_progress_and_emits_event` | `accounting` | 4 |
| Parallel tool-finish accounts once | `parallel_tool_finish_accounts_active_goal_progress_once` | `accounting` | 4 |
| Spawned descendant usage exhausts budget once | `spawned_descendant_usage_exhausts_root_goal_budget_once` | `accounting` | 4 |
| Grandchild usage rolls up after parent unloads | `grandchild_usage_rolls_up_after_parent_runtime_unloads` | `accounting` | 4 |
| Subagent usage resets when root goal replaced | `subagent_usage_resets_when_root_goal_is_replaced` | `accounting` | 4 |
| Budget-limited keeps accruing until turn-stop | `budget_limited_goal_keeps_accruing_until_turn_stop` | `accounting` | 4 |
| Budget-limited keeps accounting after later tool-finish | `budget_limited_goal_keeps_accounting_after_later_tool_finish` | `accounting` | 4 |
| Turn-error usage-limit accounts + clears | `turn_error_usage_limit_accounts_progress_and_clears_accounting` | `runtime` | 4 |
| Turn-error blocks goal | `turn_error_blocks_goal` | `runtime` | 4 |
| Failed-execution turns block unless a tool succeeds | `failed_execution_turns_block_goal_unless_a_tool_succeeds` | `runtime` | 4 |
| Usage-limit budget-limited accounts remaining | `usage_limit_budget_limited_goal_accounts_remaining_progress` | `runtime` | 4 |
| Usage-limit plan-turn does not stop goal | `usage_limit_plan_turn_does_not_stop_goal` | `runtime` | 4 |
| Usage-limit stale turn does not stop current goal | `usage_limit_stale_turn_does_not_stop_current_goal` | `runtime` | 4 |
| `update_goal` stops and accounts final progress | `update_goal_can_stop_and_accounts_final_progress` | `tools/update_goal` | 3 |
| `update_goal` rejects resume/system-limit statuses | `update_goal_rejects_resume_and_system_limit_statuses` | `tools/update_goal` | 3 |
| External mutation start accounts active progress | `external_goal_mutation_start_accounts_active_goal_progress` | `runtime` | 4 |
| External set active preserves concurrent usage | `goal_service_external_set_active_preserves_concurrent_usage` | `runtime` | 4 |
| Thread stop unregisters runtime | `thread_stop_unregisters_goal_runtime_from_service` | `runtime` | 4 |
| Thread resume rehydrates active idle accounting | `thread_resume_rehydrates_active_goal_idle_accounting` | `runtime` | 4 |
| Service set/get/clear thread goal | `goal_service_sets_gets_and_clears_thread_goal` | `GoalService` | 2 |
| Service enforces max token budget | `goal_service_enforces_maximum_token_budget_on_creation_and_updates` | `GoalService` | 2 |

### Accounting scenarios (`accounting.rs`)

| Scenario | Native test |
| --- | --- |
| Per-turn start baseline gives exact deltas | `goal_accounting_uses_turn_start_baseline_for_exact_deltas` |
| Ignore plan-mode turns | `goal_accounting_ignores_plan_mode_turns` |
| Empty continuations need 3 turns without activity/change | `empty_continuations_require_three_turns_without_activity_or_goal_changes` |
| Execution failures do not transfer to replacement goal | `execution_failures_do_not_transfer_to_a_replacement_goal` |
| Script/pre-execution errors do not block goals | `script_errors_and_failures_before_execution_do_not_block_goals` |
| Successful tool resets failures before interrupted turn ends | `successful_tool_resets_failures_before_an_interrupted_turn_ends` |
| Concurrent descendant usage preserved across checkpoints | `goal_accounting_preserves_concurrent_descendant_usage_across_checkpoints` |

### Steering scenarios (`steering.rs`)

| Scenario | Native test |
| --- | --- |
| Enabled checklist preserves the original continuation prompt | `enabled_checklist_preserves_the_original_continuation_prompt` |
| Disabled checklist preserves goal text mentioning the tool | `disabled_checklist_preserves_goal_text_that_mentions_the_tool` |

---

## 3. Storage-Layer Scenarios (`goals.rs`)

These are the deepest invariants of the persistence layer. They map to
`storage/goal-db.ts` (Phase 1) and are the foundation for everything above.

| Scenario | Native test | Invariant |
| --- | --- | --- |
| Replace/update/get thread goal | `replace_update_and_get_thread_goal` | Basic CRUD round-trip; `replace` resets usage. |
| Replace applies budget-limit immediately | `replace_thread_goal_applies_budget_limit_immediately` | `token_budget=0` ⇒ `budget_limited`. |
| Insert does not replace existing | `insert_thread_goal_does_not_replace_existing_goal` | Single-goal-per-thread for active/replace. |
| Insert applies budget-limit immediately | `insert_thread_goal_applies_budget_limit_immediately` | Insert with budget 0 ⇒ `budget_limited`. |
| Update ignores replaced-goal version | `update_thread_goal_ignores_replaced_goal_version` | `expected_goal_id` CAS rejects stale writes. |
| Usage accounting ignores replaced version | `usage_accounting_ignores_replaced_goal_version` | Accounting never applies to a replaced goal. |
| Objective update preserves usage + created_at | `update_thread_goal_objective_preserves_usage_and_created_at` | Edit does not reset usage/timestamps. |
| Concurrent partial updates preserve independent fields | `concurrent_partial_updates_preserve_independent_fields` | Row-level field independence. |
| Pause active does not clobber terminal status | `pause_active_thread_goal_does_not_clobber_terminal_status` | `paused` cannot override `complete`. |
| Usage-limit updates active or budget-limited | `usage_limit_active_thread_goal_updates_active_or_budget_limited_goals` | System stop applies to active/budget-limited. |
| Usage accounting updates active, accounts budget-limited in-flight | `usage_accounting_updates_active_goals_and_accounts_budget_limited_in_flight_usage` | In-flight tokens still charged. |
| Active-only accounting does not update budget-limited | `active_status_only_usage_accounting_does_not_update_budget_limited_goals` | Mode-scoped accounting. |
| Stopped accounting promotes paused goal over budget | `stopped_usage_accounting_promotes_paused_goal_over_budget` | Stop wins over budget for a paused goal. |
| Budget update immediately stops active over-budget | `budget_updates_immediately_stop_active_goals_already_over_budget` | Lowering budget stops active goal now. |
| Activating over-budget goal keeps it budget-limited | `activating_goal_already_over_budget_keeps_it_budget_limited` | Cannot activate over budget. |
| Pausing budget-limited preserves terminal | `pausing_budget_limited_goal_preserves_terminal_status` | `paused` does not lift `budget_limited`. |
| Blocking budget-limited preserves terminal | `blocking_budget_limited_goal_preserves_terminal_status` | `blocked` does not lift `budget_limited`. |
| Usage accounting can finalize completed goal | `usage_accounting_can_finalize_completed_goal_for_completing_turn` | `complete` plus in-flight tokens. |
| Usage accounting can finalize stopped goal | `usage_accounting_can_finalize_stopped_goal_for_in_flight_turn` | `stopped` plus in-flight tokens. |
| Usage accounting adds concurrent token deltas | `usage_accounting_adds_concurrent_token_deltas` | No lost updates under concurrency. |
| Deleting thread deletes goal | `deleting_thread_deletes_goal` | Cascading delete. |

### App-server scenario

| Scenario | Native test | Invariant |
| --- | --- | --- |
| Empty goal continuations block after three without activity | `empty_goal_continuations_block_after_three_without_activity` | 3-turn empty-continuation rule (see also accounting). |

---

## 4. TUI Scenarios (pi-goal-x presentation)

These map to the widget / dashboard / command / validation UX (Phase 5). See
`docs/ux/ux-design.md`.

| Scenario | Native test |
| --- | --- |
| Goal menu renders summary | `goal_menu.rs` (13 tests) |
| Goal validation/status | `goal_validation.rs` (6 tests) |

Detailed sub-scenarios for the TUI are enumerated in `docs/ux/ux-design.md`
and the corresponding user stories (`US-B1..B3`).

---

## 5. Priority and Sequencing

### Phase 1 — storage (`storage/goal-db.ts`)
Must satisfy §3 invariants: single-goal-per-thread, budget-limit immediacy,
`expected_goal_id` version guard, field-preserving updates, concurrent
accounting deltas, cascade delete.

### Phase 2 — `GoalService`
Must satisfy §2 service scenarios: set/get/clear, max-budget enforcement,
terminate-only updates.

### Phase 3 — tools
Must satisfy §2 tool scenarios: create/get/update surface, single-goal
invariant, budget caps, ephemeral/subagent rejection, `update_goal`
status whitelist.

### Phase 4 — runtime + accounting
Must satisfy §2 accounting + runtime scenarios: baselines, plan-mode
exclusion, empty-continuation 3-turn rule, stop-on-error/usage, budget-limit
accrual, descendant usage roll-up, external-mutation effects.

### Phase 5 — TUI
Must satisfy §4 and `docs/ux/ux-design.md`.

---

## 6. Porting Notes

- **Test harness.** Our TypeScript harness will seed an in-memory SQLite DB
  and a fake `GoalService`/runtime, mirroring Codex's `GoalExtensionHarness`.
- **`expected_goal_id`.** Every multi-step scenario in §2 that involves a
  mutation must assert the CAS rejection path (stale token ⇒ no write).
- **Status precedence.** §3's "preserves terminal status" tests encode the
  ordering rule: `budget_limited`/`complete` cannot be overridden by
  `paused`/`blocked`; only the user/systems transition out of them.
- **Budget-limit vs accounting mode.** Distinguish `ActiveOnly` from
  `ActiveOrComplete`/`ActiveOrStopped` accounting modes (see architecture.md
  §7).

---

## 7. Acceptance

This reference is complete when:

1. Every scenario in §2–§4 is represented, with a module + phase owner.
2. The storage (§3) invariants are the same set as Codex's `goals.rs`.
3. No Codex goal scenario is dropped silently.
4. Each scenario maps to a user story or arch requirement.

---

## 8. Conjunction-point fixes (claims A–U)

After the initial port, a conjunction-point audit (Codex `extension.rs` host
registries vs. ours) surfaced seams that were implemented but not wired, or
mis-translated. The table below records the historical fixes claimed by that
port; the later notification audit found that component tests did not prove
several production wiring claims. Section 9 supersedes those claims for
synchronization, error recovery, fork inheritance, and host admission.

| Claim | Seam | Fix | Test |
| --- | --- | --- | --- |
| A | runtime teardown | `GoalEngine.dispose()` cancels runtimes + resets accounting on `session_shutdown` | `engine.test.ts` "dispose clears runtimes" |
| B | sustained idle continuation | re-admit continuation on `agent_settled` when goal still active | `runtime.test.ts` "attemptContinuationIfIdle" |
| C | plan-mode exclusion | (deferred: pi has no plan-mode step in this adapter) | — |
| D | blocked audits wired | `tool_execution_end`→`recordToolOutcome`, `exec` mapped from `bash`; non-consuming peeks + one-shot `stopActiveGoalForTurn` | `runtime.test.ts` audit rows |
| E | resume rehydration | `session_start`→`restoreAfterResume()` | — |
| F | fork snapshot | `session_start.reason==="fork"`→`copyGoalToThread` | `engine.test.ts` fork rows |
| G | per-turn accounting + steering | consume accounting result, dispatch budget-limit steering | `runtime.test.ts` "dispatchBudgetLimitSteering" |
| H | descendant usage | (surface not exposed for explicit child attribution) | — |
| I | error→blocked | `turn_end.stopReason==="error"`→`stopActiveGoalForTurn("turn_error")` | — |
| J | abort disposition | `stopReason==="aborted"`→account + `clear_active`, release continuation | `runtime.test.ts` "abort disposition" |
| L | budget max | `maxGoalTokenBudget` option; `validateGoalBudget(_, max)` rejects | `goal-db.test.ts` "budget max" |
| M | continuation tickets | runtime pending-continuation guard + `isIdle` check | `runtime.test.ts` "busy"/"once per runtime" |
| N | per-thread accounting | `runtimeFor` allocates its own `GoalAccountingState` | `engine.test.ts` "isolated accounting" |
| O | atomic CAS | insert/update embed predicates in SQL w/ `RETURNING` | storage rows |
| P | status transitions | objective-only edit preserves status; only `budget_limited` protected | `goal-service.test.ts` / `goal-db.test.ts` |
| Q | budget-limit steering dispatch | `dispatchBudgetLimitSteering` once-per-goal via `markBudgetLimitReportedIfNew` | `runtime.test.ts` |
| R | objective-update steering | (already wired via `injectSteering` `deliverAs:"steer"`) | — |
| S | idle admission | `tryContinueIfIdle` checks `isIdle` + pending guard | `runtime.test.ts` |
| T | session preview | `setThreadPreviewIfEmpty` on create-goal via `pi.setSessionName` | — |
| U | `/goal edit` | explicit edit branch + editor, not literal `"edit"` objective | `goal-command.test.ts` edit rows |

> **Residual / deferred.** Claim C (plan-mode exclusion) and claim H
> (descendant/subagent usage attribution) are not wired because this pi
> adapter has no clean plan-mode step and no explicit child-usage event
> surface; they are documented as known limitations.

---

## 9. Goal synchronization implementation evidence

- The implementation is tested against Pi 0.85.1 with isolated databases, session directories, in-memory credentials, and deterministic local providers. No live goal or paid API request is used by these tests.
- The authoritative technical contract is [Architecture §13](../arch/architecture.md#13-goal-state-synchronization-contract). User-visible outcomes are defined by US-D3 and US-D4; implementation mechanisms are not user-story criteria.
- Test names below identify runnable synchronization evidence. Section 10 records the additional ordering cases; required host-port and disabled-automation assumptions have been replaced with positive continuation tests.

| Requirement or regression | Runnable evidence | Scope of evidence |
| --- | --- | --- |
| Committed changes preserve thread identity, revisions, and control generations. | `tests/service/goal-service.test.ts` tests typed changes, semantic no-ops, observer failures, and clear checkpointing. | These tests exercise the actual service and in-memory storage. |
| Fork import preserves identity, budget, usage, and timestamps. | `tests/storage/goal-db.test.ts` import cases and `tests/integration/goal-synchronization.test.ts` “fork imports full snapshot”. | These tests verify storage and adapter initialization, not an interactive fork UI. |
| Tool creation displays the goal without a prior command. | `tests/integration/goal-synchronization.test.ts` “tool create initializes UI” and `tests/host/goal-host.test.ts` “real Pi host synchronizes”. | The latter uses actual SDK tool execution and provider context. |
| Pause and clear agree across interface and agent context. | `tests/integration/goal-synchronization.test.ts` “pause and clear agree” and the real-host synchronization case. | The tests preserve historical messages while removing obsolete extension context from outgoing requests. |
| Constrained command feedback describes the actual result. | `tests/integration/goal-synchronization.test.ts` “exhausted-budget resume and pause never claim success”. | Storage, confirmation, dashboard, and model snapshot are checked together. |
| Stopped states and unavailable state are not mistaken for active or absent. | `tests/integration/goal-synchronization.test.ts` restored-status, read-failure, and renderer-failure cases. | The tests include headless operation and isolated notification failures. |
| Model-visible quantities and untrusted objective framing remain bounded. | `tests/prompts/goal-snapshot.test.ts`. | The tests check promised tool fields, known/unknown stop cause, escaping, and legacy overlength objectives. |
| Terminal turns retain usage without charging a replacement or recreating a cleared goal. | `tests/integration/goal-synchronization.test.ts` terminal-tool and creation-baseline cases, plus storage stopped-accounting cases. | The originating turn is finalized through the actual adapter hooks. |
| Thread-local revisions and same-ID objective changes cannot retain stale intent. | `tests/integration/goal-synchronization.test.ts` “revision cursors” and “late failure audit”. | These regressions were found during implementation review and reproduced before correction. |
| Accounting observers cannot charge a delta twice through reentrancy. | `tests/integration/goal-synchronization.test.ts` “reentrant accounting listeners”. | The test reenters a runtime checkpoint during a committed accounting event. |
| Successful retry and compaction recovery do not persist an intermediate blocker. | `tests/host/goal-host.test.ts` real retry and context-overflow compaction cases. | These tests execute Pi's actual recovery loop with a deterministic provider. |
| Exhausted recovery blocks only after settlement; cancellation is not an impasse. | `tests/host/goal-host.test.ts` exhausted-retry and context-abort cases. | The abort case observes the captured signal even when Pi reports `stopReason: "error"`. |
| Lifecycle initialization produces the selected session's state. | `tests/host/goal-host.test.ts` startup restoration and `session_start` reload/new/resume/fork cases. | These test the real SDK initialization handlers, not a full interactive runtime replacement. |
| Local dispatch and originating intent prevent obsolete work from changing current goals. | `tests/integration/goal-admission.test.ts`. | These exercise the real installer and local scheduler without an injected host-admission port. |
| Stock Pi runs automatic continuation while preserving user input across newer decisions. | `tests/host/goal-host.test.ts` automatic startup/command, stale-action, and queued-question cases. | The mixed-user abort test remains evidence against blanket cancellation; no upstream change is required. |

- `npm test` includes the component, adapter, and host test files above. `npm run check` also checks their TypeScript types.
- Automatic goal continuation and automatic budget wrap-up now use existing Pi facilities. The [former handoff](../../.handoff/pi-host-automatic-goal-admission.md) is superseded; [Architecture §13.5](../arch/architecture.md#135-intent-ordering-and-continuation-dispatch) defines the implemented ordering contract.
- Broader native-parity claims, plan-mode exclusion, descendant usage attribution, expanded dashboard interactions, and full interactive session replacement are not established by this synchronization evidence.

## 10. Intent-ordering verification

- The following cases are implemented through [Phases R1–R4](../../.plans/2026-09-16-11-13-goal-state-synchronization.md#4-phase-r1--record-input-ui-publication-and-accepted-intent). They extend the baseline rather than relying on its passing count as proof of ordering.

| Scenario | Verified assertion | Runnable evidence |
| --- | --- | --- |
| A goal decision arrives after UI publication but before pending work is dispatched. | The decision retains its receipt order, and the old pending work is discarded. | `tests/integration/goal-admission.test.ts` covers pre-dispatch decisions and publication captured before the input-triggered repaint. |
| A decision arrives after work was dispatched. | Already-started work may finish, but no subsequent stale action or late control result overrides the new decision. | `tests/host/goal-host.test.ts` covers stale sentinel actions, late goal updates after tool preflight, and preservation of queued status questions. |
| An earlier message finishes processing after a newer accepted decision. | Processing completion does not give the earlier message newer authority. | `tests/service/goal-ordering.test.ts` rejects earlier receipts; the real-host delayed-input case rejects a late completion result after a newer pause. |
| Resume is a valid no-op because the goal is still active. | The new intent supersedes an older failure even without a new state revision. | Service, adapter, and real-host no-op resume cases preserve newer intent without a state revision; the adapter also covers late cancellation. |
| Input is a status question, unrelated message, cancelled dialog, or invalid goal change. | No goal intent or implicit resumption is created; pending work is reassessed only after the input's disposition is known. | `tests/integration/goal-admission.test.ts` covers status questions, cancelled/invalid dialogs, fresh submissions after a system outcome, and ambiguous-input recovery. |
| Timestamps tie or the wall clock moves backwards. | Sequence ordering and originating intent still determine precedence. | `tests/service/goal-ordering.test.ts` uses injected tied and backwards clocks; host races use deferred barriers. |
| UI publication fails or the session is headless. | The controller does not invent a displayed-state reference or human acknowledgment. | Headless and failed-publication adapter cases verify an absent publication reference without losing current goal state. |
| An already-submitted wake-up becomes obsolete. | Current state reaches the model, user input is preserved, and no obsolete goal action or wake-up loop follows. Zero provider calls is not required. | The real-host stale-wakeup case allows provider execution with current paused state; positive startup and command tests prove automatic dispatch. |
| Late usage arrives with a superseded completion or error judgment. | Eligible usage is accounted without restoring old intent, recreating a cleared goal, or charging a replacement. | Terminal accounting, delayed-user replacement, superseded automatic work, and reentrant accounting cases verify correct attribution. |
| A new epoch or a later budget exhaustion occurs. | Old requests are not replayed, and a legitimate new wrap-up is not lost or duplicated. | Adapter cases cover old-epoch rejection, budget deduplication across reload, a later exhaustion, and stale markers that do not consume a summary. |

- Successful-retry, compaction, signal-abort, UI/context, and accounting regressions remain in the suite alongside the new provenance checks.
- Review regressions additionally prevent historical same-text context from consuming a new receipt, prevent an unauthorized budget marker from counting as delivery, and prevent late cancellation from suppressing a newer activation.
- Tests characterize the controller and real SDK behavior on Pi 0.85.1. They do not claim full physical-terminal testing or unambiguous provenance for arbitrary external message transformations; ambiguous goal changes are refused rather than guessed.
